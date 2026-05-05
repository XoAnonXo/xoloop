'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

let Ajv = null;
try {
  // Ajv gives api-suite real JSON Schema semantics when installed. The
  // fallback below keeps generated goals runnable in stripped plugin copies.
  // eslint-disable-next-line global-require
  Ajv = require('ajv');
} catch (_err) {
  Ajv = null;
}

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob, goalBaseDir } = require('./goal_manifest.cjs');
const { scanApiRepo } = require('./goal_api_scan.cjs');

const DEFAULT_API_OBLIGATIONS = [
  'case_present',
  'surface_coverage',
  'status_code',
  'request_schema',
  'response_schema',
  'error_shape',
  'auth_invariant',
  'auth_matrix',
  'auth_matrix_coverage',
  'graphql_introspection',
  'graphql_execution',
  'idempotency',
  'retry_behavior',
  'state_hooks',
  'db_side_effects',
  'third_party_replay',
  'vcr_replay',
  'generated_cases',
  'coverage_map',
  'latency_budget',
  'latency_confidence',
  'mutation_score',
];

function sanitizeId(id) {
  return String(id || 'case').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function stableCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableCopy);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableCopy(value[key]);
  return out;
}

function readJsonMaybe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function loadCaseFile(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`api-suite case must be an object: ${filePath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
    throw new Error(`api-suite case must contain string id: ${filePath}`);
  }
  return {
    ...parsed,
    id: parsed.id.trim(),
    method: typeof parsed.method === 'string' ? parsed.method.toUpperCase() : 'GET',
    path: typeof parsed.path === 'string' ? parsed.path : '/',
    headers: parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers) ? parsed.headers : {},
    body: parsed.body,
    expected_status: Number.isInteger(parsed.expected_status) ? parsed.expected_status : 200,
    expected_headers: parsed.expected_headers && typeof parsed.expected_headers === 'object' && !Array.isArray(parsed.expected_headers) ? parsed.expected_headers : {},
    expected_json: parsed.expected_json,
    request_schema: parsed.request_schema && typeof parsed.request_schema === 'object' && !Array.isArray(parsed.request_schema) ? parsed.request_schema : null,
    response_schema: parsed.response_schema && typeof parsed.response_schema === 'object' && !Array.isArray(parsed.response_schema) ? parsed.response_schema : null,
    error_shape: parsed.error_shape && typeof parsed.error_shape === 'object' && !Array.isArray(parsed.error_shape) ? parsed.error_shape : null,
    expected_request_schema_valid: parsed.expected_request_schema_valid !== false,
    auth: parsed.auth && typeof parsed.auth === 'object' && !Array.isArray(parsed.auth) ? parsed.auth : null,
    idempotent: parsed.idempotent === true,
    retry: parsed.retry && typeof parsed.retry === 'object' && !Array.isArray(parsed.retry) ? parsed.retry : null,
    auth_matrix: Array.isArray(parsed.auth_matrix) ? parsed.auth_matrix : [],
    setup_command: typeof parsed.setup_command === 'string' ? parsed.setup_command : '',
    teardown_command: typeof parsed.teardown_command === 'string' ? parsed.teardown_command : '',
    db_snapshot_command: typeof parsed.db_snapshot_command === 'string' ? parsed.db_snapshot_command : '',
    db_invariant: typeof parsed.db_invariant === 'string' ? parsed.db_invariant : '',
    third_party_replay: parsed.third_party_replay && typeof parsed.third_party_replay === 'object' && !Array.isArray(parsed.third_party_replay) ? parsed.third_party_replay : null,
    db_snapshot: parsed.db_snapshot && typeof parsed.db_snapshot === 'object' && !Array.isArray(parsed.db_snapshot) ? parsed.db_snapshot : null,
    operation_id: typeof parsed.operation_id === 'string' ? parsed.operation_id : '',
    status_class: typeof parsed.status_class === 'string' ? parsed.status_class : '',
    latency_budget_ms: Number.isFinite(parsed.latency_budget_ms) ? parsed.latency_budget_ms : null,
    repeat: Number.isFinite(parsed.repeat) && parsed.repeat > 0 ? Math.floor(parsed.repeat) : 1,
  };
}

function artifactPath(goalPath, dirName, testCase, suffix = '.json') {
  return path.join(goalBaseDir(goalPath), dirName, `${sanitizeId(testCase.id)}${suffix}`);
}

function requestOnce(baseUrl, testCase, override = {}) {
  return new Promise((resolve) => {
    const url = new URL(override.path || testCase.path, override.base_url || baseUrl);
    const body = Object.prototype.hasOwnProperty.call(override, 'body') ? override.body : testCase.body;
    const payload = body === undefined || body === null
      ? ''
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = override.replaceHeaders
      ? { ...(override.headers || {}) }
      : { ...(testCase.headers || {}), ...(override.headers || {}) };
    if (payload && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    const client = url.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const req = client.request(url, {
      method: override.method || testCase.method,
      headers,
      timeout: override.timeout_ms || testCase.timeout_ms || 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        let json_error = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (err) {
          json_error = err.message;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body_text: text,
          json,
          json_error,
          metrics: { latency_ms: Date.now() - startedAt },
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', (err) => {
      resolve({
        status: 0,
        headers: {},
        body_text: '',
        json: null,
        json_error: err.message,
        metrics: { latency_ms: Date.now() - startedAt },
        network_error: err.message,
      });
    });
    req.end(payload);
  });
}

async function runHook(command, cwd) {
  if (!command) return null;
  const result = await runCliCommand(command, '', { cwd, timeoutMs: 30000 });
  let json = null;
  try {
    json = result.stdout ? JSON.parse(result.stdout) : null;
  } catch (_err) {
    json = null;
  }
  return { result, json };
}

function fileSnapshot(filePath) {
  if (!fs.existsSync(filePath)) return { missing: true, path: filePath };
  const buffer = fs.readFileSync(filePath);
  return {
    path: filePath,
    bytes: buffer.length,
    sha256: require('node:crypto').createHash('sha256').update(buffer).digest('hex'),
  };
}

async function snapshotDatabase(goal, cwd, testCase, command) {
  if (command) return runHook(command, cwd);
  const spec = testCase.db_snapshot || goal.verify.db_snapshot;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const adapter = spec.adapter || spec.type;
  if (adapter === 'sqlite-file' || adapter === 'file-hash') {
    const rel = spec.path || spec.file;
    if (!rel) return { result: { exitCode: 1, stderr: 'db_snapshot.path is required' }, json: null };
    return { result: { exitCode: 0, stdout: '' }, json: fileSnapshot(path.resolve(cwd, rel)) };
  }
  if (adapter === 'json-file') {
    const rel = spec.path || spec.file;
    if (!rel) return { result: { exitCode: 1, stderr: 'db_snapshot.path is required' }, json: null };
    return { result: { exitCode: 0, stdout: '' }, json: readJsonMaybe(path.resolve(cwd, rel)) };
  }
  if (typeof spec.command === 'string' && spec.command.trim()) return runHook(spec.command.trim(), cwd);
  return { result: { exitCode: 1, stderr: `unsupported db_snapshot adapter: ${adapter || 'missing'}` }, json: null };
}

function dbAdapterGapMessage(goal) {
  const adapters = goal.verify.db_adapters || (goal.verify.scan && goal.verify.scan.database_adapters) || [];
  if (!Array.isArray(adapters) || adapters.length === 0) return 'no database snapshot command declared';
  const names = adapters.map((adapter) => adapter.name).filter(Boolean).join(', ');
  const hints = adapters.map((adapter) => adapter.snapshot_hint).filter(Boolean).join(' ');
  return `database adapter detected (${names}); declare db_snapshot, db_snapshot_command, or case db_snapshot. ${hints}`.trim();
}

function vcrInteractions(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.interactions)) return payload.interactions;
  if (payload && Array.isArray(payload.requests)) return payload.requests;
  return [];
}

function normalizeVcrInteraction(item) {
  if (!item || typeof item !== 'object') return item;
  return stableCopy({
    method: item.method,
    url: item.url || item.path,
    request_body: item.request_body || item.body,
    status: item.status || item.response_status,
    response_body: item.response_body,
  });
}

function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['example', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'xml', 'externalDocs'].includes(key)) continue;
    if (key === 'nullable') continue;
    if (['properties', 'patternProperties', 'definitions', '$defs'].includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = {};
      for (const [childKey, childValue] of Object.entries(value)) out[key][childKey] = normalizeJsonSchema(childValue);
    } else if (['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else'].includes(key)) {
      out[key] = normalizeJsonSchema(value);
    } else if (['oneOf', 'anyOf', 'allOf'].includes(key) && Array.isArray(value)) {
      out[key] = value.map(normalizeJsonSchema);
    } else {
      out[key] = value;
    }
  }
  if (schema.nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null'];
    else if (!out.anyOf) out.anyOf = [{ ...out }, { type: 'null' }];
  }
  return out;
}

const ajv = Ajv ? new Ajv({ allErrors: true, strict: false, allowUnionTypes: true }) : null;

function fallbackValidateSchema(value, schema, pathLabel = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { ok: true, errors };
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (types.length > 0) {
    const matches = types.some((type) => {
      if (type === 'array') return Array.isArray(value);
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'null') return value === null;
      return typeof value === type;
    });
    if (!matches) errors.push({ path: pathLabel, message: `expected type ${types.join('|')}` });
  }
  if (schema.const !== undefined && value !== schema.const) errors.push({ path: pathLabel, message: 'const mismatch' });
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push({ path: pathLabel, message: 'enum mismatch' });
  if (schema.required && Array.isArray(schema.required)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push({ path: pathLabel, message: 'required fields need object' });
    for (const key of schema.required) {
      if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) errors.push({ path: `${pathLabel}.${key}`, message: 'missing required property' });
    }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const childResult = fallbackValidateSchema(value[key], child, `${pathLabel}.${key}`);
        if (!childResult.ok) errors.push(...childResult.errors);
      }
    }
  }
  if (schema.additionalProperties === false && schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) errors.push({ path: `${pathLabel}.${key}`, message: 'additional property not allowed' });
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      const childResult = fallbackValidateSchema(item, schema.items, `${pathLabel}[${index}]`);
      if (!childResult.ok) errors.push(...childResult.errors);
    });
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) errors.push({ path: pathLabel, message: 'minLength failed' });
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) errors.push({ path: pathLabel, message: 'maxLength failed' });
  if (schema.pattern && typeof value === 'string' && !(new RegExp(schema.pattern).test(value))) errors.push({ path: pathLabel, message: 'pattern failed' });
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) errors.push({ path: pathLabel, message: 'minimum failed' });
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) errors.push({ path: pathLabel, message: 'maximum failed' });
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => fallbackValidateSchema(value, child, pathLabel).ok)) errors.push({ path: pathLabel, message: 'anyOf failed' });
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((child) => fallbackValidateSchema(value, child, pathLabel).ok).length !== 1) errors.push({ path: pathLabel, message: 'oneOf failed' });
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      const childResult = fallbackValidateSchema(value, child, pathLabel);
      if (!childResult.ok) errors.push(...childResult.errors);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateJsonSchema(value, schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { ok: true, errors: [] };
  const normalized = normalizeJsonSchema(schema);
  if (ajv) {
    try {
      const validate = ajv.compile(normalized);
      const ok = validate(value);
      return {
        ok,
        errors: ok ? [] : (validate.errors || []).map((error) => ({
          path: error.instancePath || '/',
          message: error.message,
          keyword: error.keyword,
        })),
      };
    } catch (err) {
      return { ok: false, errors: [{ path: '/', message: err.message, keyword: 'schema_compile' }] };
    }
  }
  return fallbackValidateSchema(value, normalized);
}

function schemaMatches(value, schema) {
  return validateJsonSchema(value, schema).ok;
}

function containsExpected(value, expected) {
  if (expected === undefined) return true;
  if (expected === null || typeof expected !== 'object') return value === expected;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(value) || value.length < expected.length) return false;
    return expected.every((item, index) => containsExpected(value[index], item));
  }
  return Object.entries(expected).every(([key, child]) => containsExpected(value[key], child));
}

function lowerHeaderMap(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = value;
  return out;
}

function addPass(state, id, testCase, extra = {}) {
  state.verifications.push({ id, status: 'pass', case_id: testCase.id, ...extra });
}

function addGap(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'gap', case_id: testCase.id, message, ...extra });
}

function addFailure(state, id, testCase, message, response, extra = {}) {
  state.verifications.push({ id, status: 'fail', case_id: testCase.id, message, ...extra });
  if (!state.counterexample) {
    state.counterexample = {
      case_id: testCase.id,
      obligation: id,
      message,
      method: testCase.method,
      path: testCase.path,
      status: response && response.status,
      body_tail: response ? String(response.body_text || '').slice(-2000) : '',
      ...extra,
    };
  }
}

function writeTrace(goalPath, testCase, response, extra = {}) {
  writeJson(artifactPath(goalPath, 'traces', testCase), {
    case: testCase,
    response,
    ...extra,
  });
}

function writeActual(goalPath, testCase, response) {
  writeJson(artifactPath(goalPath, 'actual', testCase), response);
}

function writeDiff(goalPath, testCase, obligation, payload) {
  const filePath = artifactPath(goalPath, 'diffs', testCase, `-${sanitizeId(obligation)}.json`);
  writeJson(filePath, payload);
  return filePath;
}

function writeCorpusCase(goalPath, testCase, counterexample) {
  const filePath = artifactPath(goalPath, 'corpus', testCase);
  writeJson(filePath, { case: testCase, counterexample });
  return filePath;
}

function canonicalResponse(response) {
  return {
    status: response.status,
    json: stableCopy(response.json),
    body_text: response.json === null ? response.body_text : undefined,
  };
}

const GRAPHQL_INTROSPECTION_QUERY = [
  'query XOLoopIntrospection {',
  '  __schema {',
  '    queryType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name } } } }',
  '    mutationType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name } } } }',
  '    subscriptionType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name } } } }',
  '  }',
  '}',
].join('\n');

function graphqlTypeName(type) {
  if (!type || typeof type !== 'object') return '';
  return type.name || graphqlTypeName(type.ofType);
}

function liveGraphqlOperationIds(schema) {
  const ids = new Set();
  const rootMap = [
    ['Query', schema && schema.queryType],
    ['Mutation', schema && schema.mutationType],
    ['Subscription', schema && schema.subscriptionType],
  ];
  for (const [typeName, root] of rootMap) {
    for (const field of (root && Array.isArray(root.fields) ? root.fields : [])) {
      if (field && field.name) ids.add(`${typeName}.${field.name}`);
    }
  }
  return ids;
}

async function verifyGraphqlIntrospection(goal, goalPath, testCase, baseUrl, state) {
  const graphqlPath = testCase.graphql_path || goal.verify.graphql_path || '/graphql';
  const introspectionCase = {
    ...testCase,
    id: `${testCase.id}-graphql-introspection`,
    method: 'POST',
    path: graphqlPath,
    body: { query: GRAPHQL_INTROSPECTION_QUERY },
  };
  const response = await requestOnce(baseUrl, introspectionCase);
  state.metrics.push(response.metrics);
  writeTrace(goalPath, introspectionCase, response, { graphql_introspection: true });
  const schema = response.json && response.json.data && response.json.data.__schema;
  if (response.status !== 200 || !schema) {
    const diff_path = writeDiff(goalPath, testCase, 'graphql_introspection', { status: response.status, actual_json: response.json });
    addFailure(state, 'graphql_introspection', testCase, 'GraphQL introspection did not return __schema', response, { diff_path });
    return null;
  }
  const liveIds = liveGraphqlOperationIds(schema);
  const expectedIds = ((goal.verify.scan && goal.verify.scan.graphql_operations) || []).map((operation) => operation.id);
  const missing = expectedIds.filter((id) => !liveIds.has(id));
  if (missing.length > 0) {
    const diff_path = writeDiff(goalPath, testCase, 'graphql_introspection', { missing, live: [...liveIds].sort() });
    addFailure(state, 'graphql_introspection', testCase, 'live GraphQL schema is missing scanned operations', response, { diff_path, missing });
  } else {
    addPass(state, 'graphql_introspection', testCase, { operations: liveIds.size });
  }
  return schema;
}

function verifyGraphqlExecution(goalPath, testCase, response, state) {
  if (!testCase.graphql) return;
  const errors = response.json && Array.isArray(response.json.errors) ? response.json.errors : [];
  const hasData = response.json && response.json.data && typeof response.json.data === 'object';
  if (response.status === 200 && hasData && errors.length === 0) addPass(state, 'graphql_execution', testCase);
  else {
    const diff_path = writeDiff(goalPath, testCase, 'graphql_execution', { status: response.status, errors, actual_json: response.json });
    addFailure(state, 'graphql_execution', testCase, 'GraphQL operation returned errors or no data', response, { diff_path });
  }
}

function expectedAuthMatrixCells(goal, testCase) {
  const matrix = testCase.auth_matrix_expected || goal.verify.auth_matrix || {};
  const roles = Array.isArray(matrix.roles) ? matrix.roles.map(String) : [];
  const tenants = Array.isArray(matrix.tenants) ? matrix.tenants.map(String) : [];
  if (roles.length === 0) return [];
  if (tenants.length === 0) return roles.map((role) => ({ role, tenant: '' }));
  return roles.flatMap((role) => tenants.map((tenant) => ({ role, tenant })));
}

function checkAuthMatrixCoverage(goal, testCase, state) {
  if (!(goal.verify.properties || []).includes('auth_matrix_coverage')) return;
  const expected = expectedAuthMatrixCells(goal, testCase);
  if (expected.length === 0) {
    addGap(state, 'auth_matrix_coverage', testCase, 'no auth_matrix roles/tenants declared for exhaustive coverage');
    return;
  }
  const rows = Array.isArray(testCase.auth_matrix) ? testCase.auth_matrix : [];
  const present = new Set(rows.map((row) => `${row.role || row.id || ''}:${row.tenant || row.tenant_id || ''}`));
  const missing = expected.filter((cell) => !present.has(`${cell.role}:${cell.tenant}`));
  if (missing.length === 0) addPass(state, 'auth_matrix_coverage', testCase, { cells: expected.length });
  else addGap(state, 'auth_matrix_coverage', testCase, 'role/tenant auth matrix is not exhaustive', { missing });
}

async function verifyOneCase(goal, goalPath, testCase, cwd = process.cwd()) {
  const state = { verifications: [], metrics: [], counterexample: null };
  const baseUrl = testCase.base_url || goal.verify.base_url || goal.interface.base_url || goal.interface.command;
  addPass(state, 'case_present', testCase);
  const setupCommand = testCase.setup_command || goal.verify.setup_command || '';
  const teardownCommand = testCase.teardown_command || goal.verify.teardown_command || '';
  const dbSnapshotCommand = testCase.db_snapshot_command || goal.verify.db_snapshot_command || '';
  const hasDbSnapshot = Boolean(dbSnapshotCommand || testCase.db_snapshot || goal.verify.db_snapshot);
  let dbBefore = null;
  if (setupCommand) {
    const setup = await runHook(setupCommand, cwd);
    if (setup.result.exitCode === 0) addPass(state, 'state_hooks', testCase, { setup: true });
    else addFailure(state, 'state_hooks', testCase, 'setup command failed', { status: setup.result.exitCode, body_text: setup.result.stderr });
  } else if ((goal.verify.properties || []).includes('state_hooks')) {
    addGap(state, 'state_hooks', testCase, 'no setup command declared');
  }
  if (hasDbSnapshot) {
    const snapshot = await snapshotDatabase(goal, cwd, testCase, dbSnapshotCommand);
    if (snapshot && snapshot.result && snapshot.result.exitCode !== 0) {
      addFailure(state, 'db_side_effects', testCase, 'database snapshot before request failed', { status: snapshot.result.exitCode, body_text: snapshot.result.stderr });
    }
    dbBefore = snapshot.json;
  }
  if (testCase.request_schema && testCase.body !== undefined) {
    const requestValidation = validateJsonSchema(testCase.body, testCase.request_schema);
    if (requestValidation.ok === testCase.expected_request_schema_valid) {
      addPass(state, 'request_schema', testCase, { expected_valid: testCase.expected_request_schema_valid });
    } else {
      const diff_path = writeDiff(goalPath, testCase, 'request_schema', {
        expected_valid: testCase.expected_request_schema_valid,
        actual_valid: requestValidation.ok,
        errors: requestValidation.errors,
        body: testCase.body,
      });
      addFailure(state, 'request_schema', testCase, 'request body did not match expected schema validity', { status: 0, body_text: '' }, { diff_path, schema_errors: requestValidation.errors });
    }
  } else if ((goal.verify.properties || []).includes('request_schema')) {
    addGap(state, 'request_schema', testCase, 'no request schema declared');
  }
  const responses = [];
  const repeat = Math.max(1, testCase.repeat || 1);
  for (let i = 0; i < repeat; i += 1) {
    const item = await requestOnce(baseUrl, testCase);
    responses.push(item);
    state.metrics.push(item.metrics);
  }
  const response = responses[0];
  writeActual(goalPath, testCase, response);
  writeTrace(goalPath, testCase, response, { repeat_responses: responses });
  if (testCase.graphql && (goal.verify.graphql_introspection !== false) && (goal.verify.properties || []).includes('graphql_introspection')) {
    await verifyGraphqlIntrospection(goal, goalPath, testCase, baseUrl, state);
  }
  if (testCase.graphql && (goal.verify.properties || []).includes('graphql_execution')) {
    verifyGraphqlExecution(goalPath, testCase, response, state);
  }

  if (response.status === testCase.expected_status) addPass(state, 'status_code', testCase, { http_status: response.status });
  else {
    const diff_path = writeDiff(goalPath, testCase, 'status_code', { expected_status: testCase.expected_status, actual_status: response.status });
    addFailure(state, 'status_code', testCase, `expected status ${testCase.expected_status}, got ${response.status}`, response, { diff_path });
  }

  const headers = lowerHeaderMap(response.headers);
  const expectedHeaders = lowerHeaderMap(testCase.expected_headers);
  const missingHeaders = Object.entries(expectedHeaders).filter(([key, value]) => String(headers[key]) !== String(value));
  if (missingHeaders.length > 0) {
    const diff_path = writeDiff(goalPath, testCase, 'header_contract', { expected_headers: expectedHeaders, actual_headers: headers });
    addFailure(state, 'header_contract', testCase, 'response headers did not match', response, { diff_path, missing_headers: missingHeaders });
  }

  if (testCase.response_schema) {
    const responseValidation = validateJsonSchema(response.json, testCase.response_schema);
    if (responseValidation.ok) addPass(state, 'response_schema', testCase);
    else {
      const diff_path = writeDiff(goalPath, testCase, 'response_schema', { schema: testCase.response_schema, actual_json: response.json, json_error: response.json_error, errors: responseValidation.errors });
      addFailure(state, 'response_schema', testCase, 'response JSON did not match schema', response, { diff_path, schema_errors: responseValidation.errors });
    }
  } else if (testCase.expected_json !== undefined) {
    if (containsExpected(response.json, testCase.expected_json)) addPass(state, 'response_schema', testCase);
    else {
      const diff_path = writeDiff(goalPath, testCase, 'response_schema', { expected_json: testCase.expected_json, actual_json: response.json, json_error: response.json_error });
      addFailure(state, 'response_schema', testCase, 'response JSON did not include expected shape', response, { diff_path });
    }
  } else {
    addGap(state, 'response_schema', testCase, 'no response schema or expected JSON declared');
  }

  if (response.status >= 400 || testCase.error_shape) {
    const shape = testCase.error_shape || { required: ['error'] };
    const errorValidation = validateJsonSchema(response.json, shape);
    if (errorValidation.ok) addPass(state, 'error_shape', testCase);
    else {
      const diff_path = writeDiff(goalPath, testCase, 'error_shape', { expected_shape: shape, actual_json: response.json, errors: errorValidation.errors });
      addFailure(state, 'error_shape', testCase, 'error response shape changed', response, { diff_path, schema_errors: errorValidation.errors });
    }
  } else {
    addPass(state, 'error_shape', testCase);
  }

  if (testCase.auth) {
    const denied = await requestOnce(baseUrl, testCase, { headers: testCase.auth.denied_headers || {}, replaceHeaders: true });
    state.metrics.push(denied.metrics);
    const allowedStatuses = Array.isArray(testCase.auth.denied_statuses) ? testCase.auth.denied_statuses : [401, 403];
    if (allowedStatuses.includes(denied.status)) addPass(state, 'auth_invariant', testCase, { denied_status: denied.status });
    else {
      const diff_path = writeDiff(goalPath, testCase, 'auth_invariant', { expected_denied_statuses: allowedStatuses, actual_status: denied.status, actual_json: denied.json });
      addFailure(state, 'auth_invariant', testCase, 'unauthorized variant did not deny access', denied, { diff_path });
    }
  } else {
    addGap(state, 'auth_invariant', testCase, 'no auth invariant declared');
  }

  if (testCase.auth_matrix.length > 0) {
    const failures = [];
    for (const row of testCase.auth_matrix) {
      const matrixResponse = await requestOnce(baseUrl, testCase, { headers: row.headers || {}, replaceHeaders: true });
      state.metrics.push(matrixResponse.metrics);
      const allowed = Array.isArray(row.allowed_statuses) ? row.allowed_statuses : (Array.isArray(row.denied_statuses) ? row.denied_statuses : [testCase.expected_status]);
      if (!allowed.includes(matrixResponse.status)) failures.push({ role: row.role || row.id || 'unknown', status: matrixResponse.status, allowed });
    }
    if (failures.length === 0) addPass(state, 'auth_matrix', testCase);
    else {
      const diff_path = writeDiff(goalPath, testCase, 'auth_matrix', { failures });
      addFailure(state, 'auth_matrix', testCase, 'role/tenant auth matrix failed', response, { diff_path, failures });
    }
  } else if ((goal.verify.properties || []).includes('auth_matrix')) {
    addGap(state, 'auth_matrix', testCase, 'no role/tenant auth matrix declared');
  }
  checkAuthMatrixCoverage(goal, testCase, state);

  if (testCase.idempotent) {
    const second = await requestOnce(baseUrl, testCase);
    state.metrics.push(second.metrics);
    if (JSON.stringify(canonicalResponse(second)) === JSON.stringify(canonicalResponse(response))) addPass(state, 'idempotency', testCase);
    else {
      const diff_path = writeDiff(goalPath, testCase, 'idempotency', { first: canonicalResponse(response), second: canonicalResponse(second) });
      addFailure(state, 'idempotency', testCase, 'repeated request changed observable response', second, { diff_path });
    }
  } else {
    addGap(state, 'idempotency', testCase, 'case is not declared idempotent');
  }

  if (testCase.retry) {
    const attempts = Math.max(1, Math.floor(testCase.retry.attempts || 2));
    const statuses = [];
    for (let i = 0; i < attempts; i += 1) {
      const retryResponse = await requestOnce(baseUrl, testCase, { headers: testCase.retry.headers || {} });
      statuses.push(retryResponse.status);
      state.metrics.push(retryResponse.metrics);
    }
    const acceptable = Array.isArray(testCase.retry.accept_statuses) ? testCase.retry.accept_statuses : [testCase.expected_status];
    if (statuses.every((status) => acceptable.includes(status))) addPass(state, 'retry_behavior', testCase, { statuses });
    else {
      const diff_path = writeDiff(goalPath, testCase, 'retry_behavior', { statuses, acceptable });
      addFailure(state, 'retry_behavior', testCase, 'retry attempts produced unacceptable statuses', response, { diff_path, statuses });
    }
  } else {
    addGap(state, 'retry_behavior', testCase, 'no retry behavior declared');
  }

  if (testCase.third_party_replay) {
    const headerName = (testCase.third_party_replay.header || 'x-xoloop-third-party').toLowerCase();
    let actual = [];
    const actualFile = testCase.third_party_replay.actual_file || testCase.third_party_replay.trace_file || '';
    if (actualFile) {
      const fromFile = readJsonMaybe(path.resolve(goalBaseDir(goalPath), actualFile));
      actual = vcrInteractions(fromFile);
    }
    try {
      if (!actualFile) actual = response.headers[headerName] ? JSON.parse(String(response.headers[headerName])) : [];
    } catch (_err) {
      actual = [];
    }
    const expectedFile = testCase.third_party_replay.expected_file || '';
    const expectedFromFile = expectedFile ? readJsonMaybe(path.resolve(goalBaseDir(goalPath), expectedFile)) : null;
    const expected = Array.isArray(testCase.third_party_replay.expected_requests)
      ? testCase.third_party_replay.expected_requests
      : vcrInteractions(expectedFromFile);
    if (JSON.stringify(stableCopy(actual)) === JSON.stringify(stableCopy(expected))) addPass(state, 'third_party_replay', testCase);
    else {
      const diff_path = writeDiff(goalPath, testCase, 'third_party_replay', { expected, actual });
      addFailure(state, 'third_party_replay', testCase, 'third-party replay trace changed', response, { diff_path });
    }
    const recordingFile = testCase.third_party_replay.recording_file || testCase.third_party_replay.vcr_file || '';
    if (recordingFile || testCase.third_party_replay.mode === 'vcr') {
      const recording = recordingFile ? readJsonMaybe(path.resolve(goalBaseDir(goalPath), recordingFile)) : expectedFromFile;
      const expectedInteractions = vcrInteractions(recording).map(normalizeVcrInteraction);
      const actualInteractions = vcrInteractions(actualFile ? readJsonMaybe(path.resolve(goalBaseDir(goalPath), actualFile)) : actual).map(normalizeVcrInteraction);
      if (JSON.stringify(stableCopy(expectedInteractions)) === JSON.stringify(stableCopy(actualInteractions))) addPass(state, 'vcr_replay', testCase, { interactions: expectedInteractions.length });
      else {
        const diff_path = writeDiff(goalPath, testCase, 'vcr_replay', { expected: expectedInteractions, actual: actualInteractions });
        addFailure(state, 'vcr_replay', testCase, 'VCR replay interactions changed', response, { diff_path });
      }
    } else if ((goal.verify.properties || []).includes('vcr_replay')) {
      addGap(state, 'vcr_replay', testCase, 'third_party_replay has no VCR recording_file/vcr_file');
    }
  } else if ((goal.verify.properties || []).includes('third_party_replay')) {
    addGap(state, 'third_party_replay', testCase, 'no third-party replay trace declared');
    if ((goal.verify.properties || []).includes('vcr_replay')) addGap(state, 'vcr_replay', testCase, 'no VCR third-party replay declared');
  }

  if (hasDbSnapshot) {
    const snapshot = await snapshotDatabase(goal, cwd, testCase, dbSnapshotCommand);
    if (snapshot && snapshot.result && snapshot.result.exitCode !== 0) {
      addFailure(state, 'db_side_effects', testCase, 'database snapshot after request failed', { status: snapshot.result.exitCode, body_text: snapshot.result.stderr });
    }
    const dbAfter = snapshot.json;
    if (testCase.db_invariant === 'unchanged' || goal.verify.db_invariant === 'unchanged') {
      if (JSON.stringify(stableCopy(dbBefore)) === JSON.stringify(stableCopy(dbAfter))) addPass(state, 'db_side_effects', testCase);
      else {
        const diff_path = writeDiff(goalPath, testCase, 'db_side_effects', { before: dbBefore, after: dbAfter });
        addFailure(state, 'db_side_effects', testCase, 'database snapshot changed', response, { diff_path });
      }
    } else {
      addPass(state, 'db_side_effects', testCase);
    }
  } else if ((goal.verify.properties || []).includes('db_side_effects')) {
    addGap(state, 'db_side_effects', testCase, dbAdapterGapMessage(goal));
  }

  const latencyBudget = testCase.latency_budget_ms || (testCase.performance_budgets && testCase.performance_budgets.latency_ms && testCase.performance_budgets.latency_ms.lte);
  if (Number.isFinite(latencyBudget)) {
    if (response.metrics.latency_ms <= latencyBudget) addPass(state, 'latency_budget', testCase, { latency_ms: response.metrics.latency_ms, lte: latencyBudget });
    else addFailure(state, 'latency_budget', testCase, 'latency budget exceeded', response, { latency_ms: response.metrics.latency_ms, lte: latencyBudget });
  } else {
    addGap(state, 'latency_budget', testCase, 'no latency budget declared');
  }
  if ((goal.verify.properties || []).includes('latency_confidence')) {
    const values = responses.map((item) => item.metrics.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
    const p99 = values[Math.min(values.length - 1, Math.floor(values.length * 0.99))];
    const minRuns = Number.isFinite(goal.verify.latency_confidence_runs) ? goal.verify.latency_confidence_runs : 3;
    const tolerance = Number.isFinite(goal.verify.latency_noise_tolerance) ? goal.verify.latency_noise_tolerance : 0.05;
    if (values.length < minRuns) addGap(state, 'latency_confidence', testCase, `latency confidence needs at least ${minRuns} runs`, { runs: values.length });
    else if (Number.isFinite(latencyBudget) && p95 <= latencyBudget * (1 + tolerance)) addPass(state, 'latency_confidence', testCase, { p50: values[Math.floor(values.length / 2)], p95, p99, runs: values.length });
    else addFailure(state, 'latency_confidence', testCase, 'p95 latency exceeded budget after noise tolerance', response, { p95, p99, lte: latencyBudget, tolerance });
  }

  if (teardownCommand) {
    const teardown = await runHook(teardownCommand, cwd);
    if (teardown.result.exitCode === 0) addPass(state, 'state_hooks', testCase, { teardown: true });
    else addFailure(state, 'state_hooks', testCase, 'teardown command failed', { status: teardown.result.exitCode, body_text: teardown.result.stderr });
  }

  return state;
}

function aggregateMetrics(samples) {
  const byName = {};
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value)) continue;
      if (!byName[key]) byName[key] = [];
      byName[key].push(value);
    }
  }
  const out = {};
  for (const [key, values] of Object.entries(byName)) {
    const sorted = values.sort((a, b) => a - b);
    out[key] = sorted[Math.floor(sorted.length / 2)];
    out[`${key}_p95`] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    out[`${key}_p99`] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  }
  return out;
}

function surfaceCoverage(goal, cases) {
  const routeFiles = ((goal.verify.scan && goal.verify.scan.route_files) || []).map((route) => ({ id: route, type: 'route_file' }));
  const operations = ((goal.verify.scan && goal.verify.scan.openapi_operations) || []).map((operation) => ({ id: operation.id, type: 'operation', statuses: operation.response_statuses || [] }));
  const graphqlOperations = ((goal.verify.scan && goal.verify.scan.graphql_operations) || []).map((operation) => ({ id: operation.id, type: 'graphql_operation', statuses: ['200'] }));
  const declared = [...routeFiles, ...operations, ...graphqlOperations];
  if (declared.length === 0) return { status: 'pass', message: 'no scanned API routes or operations declared', coverage: {} };
  const coveredRoutes = new Set(cases.map((testCase) => testCase.route_file).filter(Boolean));
  const coveredOps = new Set(cases.map((testCase) => testCase.operation_id).filter(Boolean));
  const coveredGraphqlOps = new Set(cases.map((testCase) => testCase.graphql_operation_id || (testCase.graphql ? testCase.operation_id : '')).filter(Boolean));
  const coveredStatuses = {};
  for (const testCase of cases) {
    if (!testCase.operation_id) continue;
    if (!coveredStatuses[testCase.operation_id]) coveredStatuses[testCase.operation_id] = new Set();
    coveredStatuses[testCase.operation_id].add(String(testCase.expected_status || '').slice(0, 1) + 'xx');
    coveredStatuses[testCase.operation_id].add(String(testCase.expected_status));
  }
  const missing = [];
  for (const item of declared) {
    if (item.type === 'route_file' && !coveredRoutes.has(item.id)) missing.push(item.id);
    if (item.type === 'operation' && !coveredOps.has(item.id)) missing.push(item.id);
    if (item.type === 'graphql_operation' && !coveredGraphqlOps.has(item.id)) missing.push(item.id);
    if (item.type === 'operation' && coveredOps.has(item.id)) {
      const expectedClasses = [...new Set((item.statuses || []).map((status) => String(status).slice(0, 1) + 'xx'))].filter((klass) => /^[2345]xx$/.test(klass));
      const actual = coveredStatuses[item.id] || new Set();
      for (const klass of expectedClasses) {
        if (!actual.has(klass)) missing.push(`${item.id}:${klass}`);
      }
    }
  }
  const coverage = { operations: operations.length, graphql_operations: graphqlOperations.length, route_files: routeFiles.length };
  if (missing.length === 0) return { status: 'pass', missing, coverage };
  return { status: 'gap', missing, coverage, message: 'not all scanned API operations/status classes have cases' };
}

function sampleFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'string') return 'xoloop';
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'array') return [sampleFromSchema(schema.items || { type: 'string' })];
  if (schema.type === 'object' || schema.properties) {
    const out = {};
    for (const [key, child] of Object.entries(schema.properties || {})) out[key] = sampleFromSchema(child);
    return out;
  }
  return null;
}

function fuzzedCases(goal, cases) {
  const fuzz = goal.verify.fuzz || {};
  const runs = Number.isFinite(fuzz.runs) && fuzz.runs > 0 ? Math.floor(fuzz.runs) : 0;
  if (runs <= 0) return [];
  const out = [];
  const candidates = cases.filter((testCase) => testCase.request_schema || testCase.body !== undefined);
  for (const testCase of candidates) {
    const body = testCase.body && typeof testCase.body === 'object' ? testCase.body : sampleFromSchema(testCase.request_schema);
    const required = testCase.request_schema && Array.isArray(testCase.request_schema.required) ? testCase.request_schema.required : [];
    if (required.length > 0) {
      const missing = stableCopy(testCase);
      missing.id = `${testCase.id}-missing-${required[0]}`;
      missing.generated_from = testCase.id;
      missing.body = stableCopy(body || {});
      delete missing.body[required[0]];
      missing.expected_status = (Array.isArray(fuzz.negative_statuses) && fuzz.negative_statuses[0]) || 400;
      missing.expected_request_schema_valid = false;
      missing.response_schema = null;
      missing.expected_json = undefined;
      missing.error_shape = fuzz.error_shape || { required: ['error'] };
      out.push(missing);
    }
    const props = testCase.request_schema && testCase.request_schema.properties ? Object.keys(testCase.request_schema.properties) : [];
    if (props.length > 0) {
      const wrong = stableCopy(testCase);
      wrong.id = `${testCase.id}-wrong-type-${props[0]}`;
      wrong.generated_from = testCase.id;
      wrong.body = stableCopy(body || {});
      wrong.body[props[0]] = { wrong: true };
      wrong.expected_status = (Array.isArray(fuzz.negative_statuses) && fuzz.negative_statuses[0]) || 400;
      wrong.expected_request_schema_valid = false;
      wrong.response_schema = null;
      wrong.expected_json = undefined;
      wrong.error_shape = fuzz.error_shape || { required: ['error'] };
      out.push(wrong);
    }
    if (out.length >= runs) break;
  }
  return out.slice(0, runs);
}

async function runMutationScore(goal, goalPath, cwd) {
  const mutation = goal.verify.mutation || {};
  const mutants = Array.isArray(mutation.mutants) ? mutation.mutants : [];
  if (mutants.length === 0) {
    return {
      verifications: [{ id: 'mutation_score', status: 'gap', message: 'no mutation commands declared' }],
      counterexample: null,
    };
  }
  let killed = 0;
  const results = [];
  for (const mutant of mutants) {
    if (!mutant || typeof mutant !== 'object' || typeof mutant.command !== 'string') continue;
    const result = await runCliCommand(mutant.command, '', { cwd, timeoutMs: mutant.timeout_ms || 30000 });
    const expectExit = Number.isInteger(mutant.expect_exit_code) ? mutant.expect_exit_code : null;
    const killedMutant = expectExit === null ? result.exitCode !== 0 : result.exitCode === expectExit;
    if (killedMutant) killed += 1;
    results.push({
      id: mutant.id || `mutant-${results.length + 1}`,
      command: mutant.command,
      exit_code: result.exitCode,
      killed: killedMutant,
      stdout_tail: String(result.stdout || '').slice(-1000),
      stderr_tail: String(result.stderr || '').slice(-1000),
    });
  }
  const score = results.length === 0 ? 0 : killed / results.length;
  const minScore = Number.isFinite(mutation.min_score) ? mutation.min_score : 1;
  const filePath = path.join(goalBaseDir(goalPath), 'traces', 'mutation-score.json');
  writeJson(filePath, { score, killed, total: results.length, results });
  if (score >= minScore) {
    return {
      verifications: [{ id: 'mutation_score', status: 'pass', score, killed, total: results.length, trace_path: filePath }],
      counterexample: null,
    };
  }
  return {
    verifications: [{ id: 'mutation_score', status: 'fail', score, killed, total: results.length, trace_path: filePath, message: 'mutation score below required threshold' }],
    counterexample: {
      case_id: 'mutation-score',
      obligation: 'mutation_score',
      message: 'mutation score below required threshold',
      score,
      killed,
      total: results.length,
      trace_path: filePath,
      survivors: results.filter((item) => !item.killed),
    },
  };
}

async function runApiSuiteVerification(goal, goalPath, options = {}) {
  const caseFiles = expandSimpleJsonGlob(goalPath, goal.verify.cases, options.cwd || process.cwd());
  const cases = caseFiles.map(loadCaseFile);
  const generated = options.caseId ? [] : fuzzedCases(goal, cases).map((testCase) => loadCaseFileFromObject(testCase));
  const allCases = [...cases, ...generated];
  const selectedCases = options.caseId ? allCases.filter((testCase) => testCase.id === options.caseId) : allCases;
  if (selectedCases.length === 0) {
    return {
      status: 'fail',
      verifications: [{ id: 'case_selection', status: 'fail', message: `No cases matched ${options.caseId || goal.verify.cases}` }],
      metrics: {},
      counterexample: { obligation: 'case_selection', message: `No cases matched ${options.caseId || goal.verify.cases}` },
    };
  }
  const verifications = [];
  const metrics = [];
  let counterexample = null;
  const coverage = surfaceCoverage(goal, cases);
  verifications.push({ id: 'surface_coverage', status: coverage.status, message: coverage.message, missing: coverage.missing || [], coverage: coverage.coverage || {} });
  verifications.push({ id: 'coverage_map', status: coverage.status, message: coverage.message, missing: coverage.missing || [], coverage: coverage.coverage || {} });
  if (generated.length > 0) verifications.push({ id: 'generated_cases', status: 'pass', generated: generated.length });
  else if ((goal.verify.properties || []).includes('generated_cases')) verifications.push({ id: 'generated_cases', status: 'gap', message: 'no generated API cases configured' });
  if ((goal.verify.properties || []).includes('graphql_introspection') && !allCases.some((testCase) => testCase.graphql)) {
    verifications.push({ id: 'graphql_introspection', status: 'gap', message: 'no GraphQL cases declared for live introspection' });
  }
  if ((goal.verify.properties || []).includes('graphql_execution') && !allCases.some((testCase) => testCase.graphql)) {
    verifications.push({ id: 'graphql_execution', status: 'gap', message: 'no GraphQL cases declared for execution checks' });
  }
  if ((goal.verify.properties || []).includes('mutation_score')) {
    const mutationResult = await runMutationScore(goal, goalPath, options.cwd || process.cwd());
    verifications.push(...mutationResult.verifications);
    if (mutationResult.counterexample && !counterexample) counterexample = mutationResult.counterexample;
  }
  for (const testCase of selectedCases) {
    const result = await verifyOneCase(goal, goalPath, testCase, options.cwd || process.cwd());
    verifications.push(...result.verifications);
    metrics.push(...result.metrics);
    if (result.counterexample && !counterexample) {
      counterexample = result.counterexample;
      if (testCase.generated_from) counterexample.corpus_path = writeCorpusCase(goalPath, testCase, counterexample);
    }
  }
  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: aggregateMetrics(metrics),
    counterexample,
  };
}

function loadCaseFileFromObject(parsed) {
  const tmp = {
    ...parsed,
    id: parsed.id || 'generated',
  };
  return {
    ...tmp,
    method: typeof tmp.method === 'string' ? tmp.method.toUpperCase() : 'GET',
    path: typeof tmp.path === 'string' ? tmp.path : '/',
    headers: tmp.headers && typeof tmp.headers === 'object' && !Array.isArray(tmp.headers) ? tmp.headers : {},
    body: tmp.body,
    expected_status: Number.isInteger(tmp.expected_status) ? tmp.expected_status : 200,
    expected_headers: tmp.expected_headers && typeof tmp.expected_headers === 'object' && !Array.isArray(tmp.expected_headers) ? tmp.expected_headers : {},
    expected_json: tmp.expected_json,
    request_schema: tmp.request_schema && typeof tmp.request_schema === 'object' && !Array.isArray(tmp.request_schema) ? tmp.request_schema : null,
    response_schema: tmp.response_schema && typeof tmp.response_schema === 'object' && !Array.isArray(tmp.response_schema) ? tmp.response_schema : null,
    error_shape: tmp.error_shape && typeof tmp.error_shape === 'object' && !Array.isArray(tmp.error_shape) ? tmp.error_shape : null,
    expected_request_schema_valid: tmp.expected_request_schema_valid !== false,
    auth: tmp.auth && typeof tmp.auth === 'object' && !Array.isArray(tmp.auth) ? tmp.auth : null,
    idempotent: tmp.idempotent === true,
    retry: tmp.retry && typeof tmp.retry === 'object' && !Array.isArray(tmp.retry) ? tmp.retry : null,
    auth_matrix: Array.isArray(tmp.auth_matrix) ? tmp.auth_matrix : [],
    setup_command: typeof tmp.setup_command === 'string' ? tmp.setup_command : '',
    teardown_command: typeof tmp.teardown_command === 'string' ? tmp.teardown_command : '',
    db_snapshot_command: typeof tmp.db_snapshot_command === 'string' ? tmp.db_snapshot_command : '',
    db_invariant: typeof tmp.db_invariant === 'string' ? tmp.db_invariant : '',
    third_party_replay: tmp.third_party_replay && typeof tmp.third_party_replay === 'object' && !Array.isArray(tmp.third_party_replay) ? tmp.third_party_replay : null,
    db_snapshot: tmp.db_snapshot && typeof tmp.db_snapshot === 'object' && !Array.isArray(tmp.db_snapshot) ? tmp.db_snapshot : null,
    operation_id: typeof tmp.operation_id === 'string' ? tmp.operation_id : '',
    status_class: typeof tmp.status_class === 'string' ? tmp.status_class : '',
    latency_budget_ms: Number.isFinite(tmp.latency_budget_ms) ? tmp.latency_budget_ms : null,
    repeat: Number.isFinite(tmp.repeat) && tmp.repeat > 0 ? Math.floor(tmp.repeat) : 1,
  };
}

function openApiCaseForOperation(operation, options = {}) {
  const successStatus = (operation.response_statuses || []).find((status) => /^2/.test(String(status))) || '200';
  const headers = {};
  const query = new URLSearchParams();
  let requestPath = operation.path.replace(/\{([^}]+)\}/g, (_match, name) => {
    const parameter = (operation.parameters || []).find((item) => item.in === 'path' && item.name === name);
    return encodeURIComponent(String(sampleFromSchema((parameter && parameter.schema) || { type: 'string' }) || options.pathParamValue || '1'));
  });
  for (const parameter of operation.parameters || []) {
    if (!parameter.required && parameter.in !== 'path') continue;
    const value = sampleFromSchema(parameter.schema || { type: 'string' });
    if (parameter.in === 'query') query.set(parameter.name, String(value));
    if (parameter.in === 'header') headers[parameter.name] = String(value);
  }
  const queryText = query.toString();
  if (queryText) requestPath += `${requestPath.includes('?') ? '&' : '?'}${queryText}`;
  return {
    id: operation.id,
    operation_id: operation.id,
    method: operation.method,
    path: requestPath,
    headers,
    expected_status: Number(successStatus) || 200,
    body: sampleFromSchema(operation.request_schema),
    request_schema: operation.request_schema,
    response_schema: operation.response_schemas && (operation.response_schemas[successStatus] || operation.response_schemas.default),
    idempotent: ['GET', 'HEAD', 'OPTIONS'].includes(operation.method),
    status_class: `${String(successStatus).slice(0, 1)}xx`,
    latency_budget_ms: 600,
  };
}

function graphqlBaseType(type) {
  return String(type || '').replace(/[!\[\]]/g, '').trim();
}

function sampleGraphqlValue(type) {
  const base = graphqlBaseType(type);
  if (base === 'Int' || base === 'Float') return 1;
  if (base === 'Boolean') return true;
  return 'xoloop';
}

function graphqlCaseForOperation(operation) {
  const opType = operation.operation_type === 'mutation' ? 'mutation' : (operation.operation_type === 'subscription' ? 'subscription' : 'query');
  const opName = sanitizeId(operation.id).replace(/[-.]/g, '_');
  const args = Array.isArray(operation.args) ? operation.args : [];
  const variables = {};
  for (const arg of args) variables[arg.name] = sampleGraphqlValue(arg.type);
  const variableDefs = args.length > 0 ? `(${args.map((arg) => `$${arg.name}: ${arg.type}`).join(', ')})` : '';
  const fieldArgs = args.length > 0 ? `(${args.map((arg) => `${arg.name}: $${arg.name}`).join(', ')})` : '';
  const baseReturn = graphqlBaseType(operation.return_type);
  const scalar = ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(baseReturn);
  const selection = scalar ? '' : ' { __typename }';
  return {
    id: operation.id,
    operation_id: operation.id,
    graphql_operation_id: operation.id,
    graphql: true,
    method: 'POST',
    path: '/graphql',
    headers: { 'content-type': 'application/json' },
    body: {
      query: `${opType} ${opName}${variableDefs} { ${operation.field}${fieldArgs}${selection} }`,
      variables,
    },
    request_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        variables: { type: 'object' },
      },
    },
    expected_status: 200,
    response_schema: {
      type: 'object',
      properties: {
        data: { type: 'object' },
        errors: { type: 'array' },
      },
    },
    idempotent: opType === 'query',
    status_class: '2xx',
    latency_budget_ms: 600,
  };
}

function vcrProxySource() {
  return `#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

const mode = process.env.XOLOOP_VCR_MODE || 'record';
const file = process.env.XOLOOP_VCR_FILE || 'vcr/recording.json';
const target = process.env.XOLOOP_VCR_TARGET;
const port = Number(process.env.XOLOOP_VCR_PORT || 0);
const recordings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { interactions: [] };

function save() {
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(recordings, null, 2) + '\\n');
}

function key(item) {
  return JSON.stringify({ method: item.method, url: item.url, request_body: item.request_body || '' });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const requestBody = Buffer.concat(chunks).toString('utf8');
    const url = target ? new URL(req.url, target) : new URL(req.url);
    const lookup = { method: req.method, url: url.toString(), request_body: requestBody };
    if (mode === 'replay') {
      const found = recordings.interactions.find((item) => key(item) === key(lookup));
      if (!found) {
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'xoloop_vcr_miss', request: lookup }));
        return;
      }
      res.writeHead(found.status || 200, found.response_headers || {});
      res.end(found.response_body || '');
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const upstream = client.request(url, { method: req.method, headers: req.headers }, (upstreamRes) => {
      const responseChunks = [];
      upstreamRes.on('data', (chunk) => responseChunks.push(chunk));
      upstreamRes.on('end', () => {
        const responseBody = Buffer.concat(responseChunks).toString('utf8');
        recordings.interactions.push({ ...lookup, status: upstreamRes.statusCode, response_headers: upstreamRes.headers, response_body: responseBody });
        save();
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        res.end(responseBody);
      });
    });
    upstream.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    upstream.end(requestBody);
  });
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ proxy_url: 'http://127.0.0.1:' + address.port, mode, file }));
});
`;
}

function writeApiSuiteAssets(goalDir, options = {}) {
  for (const dir of ['cases', 'traces', 'actual', 'diffs', 'schemas', 'corpus', 'vcr', 'db']) fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  const operations = options.scan && Array.isArray(options.scan.openapi_operations) ? options.scan.openapi_operations : [];
  const graphqlOperations = options.scan && Array.isArray(options.scan.graphql_operations) ? options.scan.graphql_operations : [];
  if (operations.length > 0) {
    for (const operation of operations) writeJson(path.join(goalDir, 'cases', `${sanitizeId(operation.id)}.json`), openApiCaseForOperation(operation, options));
  }
  if (graphqlOperations.length > 0) {
    for (const operation of graphqlOperations) writeJson(path.join(goalDir, 'cases', `${sanitizeId(operation.id)}.json`), graphqlCaseForOperation(operation));
  }
  if (operations.length === 0 && graphqlOperations.length === 0) {
    writeJson(path.join(goalDir, 'cases', 'health.json'), {
      id: 'health',
      method: 'GET',
      path: options.path || '/health',
      expected_status: 200,
      response_schema: {
        type: 'object',
      },
      idempotent: true,
      latency_budget_ms: 600,
    });
  }
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# API verification goal',
    '',
    'Generated by `xoloop-verify create --kind api-suite`.',
    '',
    'Cases declare HTTP method/path/headers/body plus expected status,',
    'response schema, request schema, error shape, auth invariant,',
    'role/tenant matrix, setup/teardown hooks, database side-effect',
    'snapshots, third-party replay traces, retry behavior, idempotency,',
    'and latency budgets. Traces, actuals, diffs, schemas, and generated',
    'counterexample corpus files stay under this goal directory.',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(goalDir, 'vcr', 'proxy.cjs'), vcrProxySource(), 'utf8');
  fs.chmodSync(path.join(goalDir, 'vcr', 'proxy.cjs'), 0o755);
}

function buildApiSuiteGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'api-suite';
  const scan = options.scan || scanApiRepo(cwd);
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve API/backend request/response contracts, auth invariants, retries, idempotency, errors, schemas, and latency while optimizing.',
    interface: {
      type: 'api',
      command: options.baseUrl || options.url || 'http://127.0.0.1:3000',
      base_url: options.baseUrl || options.url || 'http://127.0.0.1:3000',
      stdin: 'none',
      stdout: 'http',
      timeout_ms: 10000,
    },
    artifacts: {
      paths: scan.artifact_paths || [],
    },
    verify: {
      kind: 'api-suite',
      base_url: options.baseUrl || options.url || 'http://127.0.0.1:3000',
      cases: 'cases/*.json',
      properties: DEFAULT_API_OBLIGATIONS,
      scan,
      db_adapters: scan.database_adapters || [],
      auth_matrix: {
        roles: (scan.auth_hints && scan.auth_hints.roles) || [],
        tenants: [],
      },
      graphql_path: '/graphql',
      graphql_introspection: true,
      block_on_gaps: true,
      fuzz: {
        generator: 'schema-negative',
        seed: 12345,
        runs: 0,
        negative_statuses: [400, 422],
      },
      mutation: {
        min_score: 1,
        mutants: [],
      },
      latency_confidence_runs: 3,
      latency_noise_tolerance: 0.05,
    },
    metrics: {
      repeat: 3,
      targets: [
        { name: 'latency_ms', direction: 'minimize', threshold: 0.03 },
        { name: 'complexity_score', direction: 'minimize', threshold: 0.05 },
      ],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0.02,
      accept_if_any_target_improves: true,
    },
  };
}

module.exports = {
  DEFAULT_API_OBLIGATIONS,
  buildApiSuiteGoal,
  runApiSuiteVerification,
  scanApiRepo,
  writeApiSuiteAssets,
};
