'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  runGoalVerify,
  scanApiRepo,
} = require('../lib/goal_verify_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-api-suite-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function writeApiGoal(cwd, baseUrl, options = {}) {
  const goalId = options.goalId || 'api';
  const goalPath = path.join(cwd, '.xoloop', 'goals', goalId, 'goal.yaml');
  writeJson(path.join(cwd, '.xoloop', 'goals', goalId, 'cases', options.caseName || 'user.json'), {
    id: options.caseId || 'user',
    route_file: 'src/routes/users.js',
    method: options.method || 'GET',
    path: options.path || '/users/1',
    headers: options.headers || { authorization: 'Bearer good' },
    expected_status: options.expectedStatus == null ? 200 : options.expectedStatus,
    ...(Object.prototype.hasOwnProperty.call(options, 'expectedJson') ? { expected_json: options.expectedJson } : { expected_json: { id: 1, name: 'Ada' } }),
    ...(Object.prototype.hasOwnProperty.call(options, 'responseSchema') ? (options.responseSchema ? { response_schema: options.responseSchema } : {}) : { response_schema: {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
      },
    } }),
    auth: Object.prototype.hasOwnProperty.call(options, 'auth') ? options.auth : {
      denied_headers: {},
      denied_statuses: [401],
    },
    idempotent: Object.prototype.hasOwnProperty.call(options, 'idempotent') ? options.idempotent : true,
    retry: Object.prototype.hasOwnProperty.call(options, 'retry') ? options.retry : {
      attempts: 2,
      accept_statuses: [200],
    },
    latency_budget_ms: Object.prototype.hasOwnProperty.call(options, 'latencyBudget') ? options.latencyBudget : 600,
    ...(options.caseExtra || {}),
  });
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: goalId,
    objective: 'Verify API contracts.',
    interface: {
      type: 'api',
      command: baseUrl,
      base_url: baseUrl,
      stdin: 'none',
      stdout: 'http',
      timeout_ms: 5000,
    },
    artifacts: {
      paths: options.artifacts || [],
    },
    verify: {
      kind: 'api-suite',
      base_url: baseUrl,
      cases: 'cases/*.json',
      properties: options.properties || [
        'case_present',
        'surface_coverage',
        'status_code',
        'response_schema',
        'error_shape',
        'auth_invariant',
        'idempotency',
        'retry_behavior',
        'latency_budget',
      ],
      scan: options.scan || { route_files: [] },
      block_on_gaps: true,
      ...(options.verifyExtra || {}),
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'latency_ms', direction: 'minimize', threshold: 0 },
      ],
    },
  });
  return goalPath;
}

test('API scan detects frameworks, route files, schemas, and serve commands', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: { start: 'node src/server.js', test: 'node --test' },
    dependencies: { express: '^5.0.0', graphql: '^16.0.0' },
  });
  fs.mkdirSync(path.join(cwd, 'src', 'routes'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'routes', 'users.js'), "router.get('/users/:id', handler);\n", 'utf8');
  fs.writeFileSync(path.join(cwd, 'openapi.yaml'), 'openapi: 3.0.0\n', 'utf8');

  const scan = scanApiRepo(cwd);

  assert.ok(scan.frameworks.some((framework) => framework.name === 'express'));
  assert.ok(scan.frameworks.some((framework) => framework.name === 'graphql'));
  assert.deepEqual(scan.route_files, ['src/routes/users.js']);
  assert.deepEqual(scan.schema_files, ['openapi.yaml']);
  assert.ok(scan.safe_commands.some((command) => command.kind === 'serve'));
});

test('api-suite create writes harness assets and manifest', () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'openapi.json'), '{"openapi":"3.0.0"}\n', 'utf8');

  const created = createGoal({ cwd, kind: 'api-suite', goalId: 'api-suite', baseUrl: 'http://127.0.0.1:1234', force: true });

  assert.equal(created.goal.verify.kind, 'api-suite');
  assert.equal(created.goal.verify.base_url, 'http://127.0.0.1:1234');
  for (const dir of ['cases', 'traces', 'actual', 'diffs', 'schemas']) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'api-suite', dir)), true);
  }
});

test('api-suite reaches PASS_EVIDENCED for response, auth, retry, idempotency, and latency', async () => {
  const cwd = tmpDir();
  const server = await startServer((req, res) => {
    if (req.url === '/users/1' && req.headers.authorization !== 'Bearer good') return sendJson(res, 401, { error: 'unauthorized' });
    if (req.url === '/users/1') return sendJson(res, 200, { id: 1, name: 'Ada' });
    return sendJson(res, 404, { error: 'not_found' });
  });
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl);

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'PASS_EVIDENCED');
    assert.deepEqual(card.missing_obligations, []);
    assert.equal(card.summary.failed, 0);
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'api', 'actual', 'user.json')), true);
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'api', 'traces', 'user.json')), true);
  } finally {
    await server.close();
  }
});

test('api-suite fails on schema drift and writes diff artifacts', async () => {
  const cwd = tmpDir();
  const server = await startServer((_req, res) => sendJson(res, 200, { id: '1', display: 'Ada' }));
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, { auth: null, retry: null });

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'FAIL');
    assert.equal(card.counterexample.obligation, 'response_schema');
    assert.ok(card.counterexample.diff_path);
    assert.equal(fs.existsSync(card.counterexample.diff_path), true);
    assert.match(card.replay, /--case user/);
  } finally {
    await server.close();
  }
});

test('api-suite fails when auth invariant does not deny access', async () => {
  const cwd = tmpDir();
  const server = await startServer((_req, res) => sendJson(res, 200, { id: 1, name: 'Ada' }));
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, { retry: null });

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'FAIL');
    assert.equal(card.counterexample.obligation, 'auth_invariant');
  } finally {
    await server.close();
  }
});

test('api-suite reports PASS_WITH_GAPS when optional invariants are undeclared', async () => {
  const cwd = tmpDir();
  const server = await startServer((_req, res) => sendJson(res, 200, { ok: true }));
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, {
      expectedJson: undefined,
      responseSchema: null,
      auth: null,
      idempotent: false,
      retry: null,
      latencyBudget: null,
      properties: [
        'case_present',
        'surface_coverage',
        'status_code',
        'response_schema',
        'error_shape',
        'auth_invariant',
        'idempotency',
        'retry_behavior',
        'latency_budget',
      ],
    });
    const manifest = JSON.parse(fs.readFileSync(goalPath, 'utf8'));
    delete manifest.verify.scan.route_files;
    writeGoalManifest(goalPath, manifest);

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'PASS_WITH_GAPS');
    assert.ok(card.missing_obligations.includes('response_schema'));
    assert.ok(card.missing_obligations.includes('auth_invariant'));
    assert.ok(card.missing_obligations.includes('idempotency'));
    assert.ok(card.missing_obligations.includes('retry_behavior'));
    assert.ok(card.missing_obligations.includes('latency_budget'));
  } finally {
    await server.close();
  }
});

test('API scan parses OpenAPI and GraphQL operations, and create generates OpenAPI cases', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), { scripts: { start: 'node server.js' }, dependencies: { express: '^5.0.0' } });
  writeJson(path.join(cwd, 'openapi.json'), {
    openapi: '3.0.0',
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            { name: 'includeProfile', in: 'query', required: true, schema: { type: 'boolean' } },
            { name: 'x-client', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'number' } },
                  },
                },
              },
            },
            404: { description: 'missing' },
          },
        },
      },
      '/users': {
        post: {
          operationId: 'createUser',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string' } },
                },
              },
            },
          },
          responses: { 201: { description: 'created' }, 400: { description: 'bad' } },
        },
      },
    },
  });
  fs.writeFileSync(path.join(cwd, 'schema.graphql'), 'type Query { user(id: ID!): User }\\ntype Mutation { createUser(name: String!): User }\\n', 'utf8');

  const scan = scanApiRepo(cwd);
  const created = createGoal({ cwd, kind: 'api-suite', goalId: 'api-openapi', baseUrl: 'http://127.0.0.1:9', force: true });

  assert.ok(scan.openapi_operations.some((operation) => operation.id === 'getUser'));
  assert.ok(scan.openapi_operations.some((operation) => operation.id === 'createUser' && operation.request_schema.required.includes('name')));
  const graphqlQuery = scan.graphql_operations.find((operation) => operation.id === 'Query.user');
  assert.ok(graphqlQuery);
  assert.deepEqual(graphqlQuery.args, [{ name: 'id', type: 'ID!', required: true }]);
  assert.equal(graphqlQuery.return_type, 'User');
  assert.ok(scan.graphql_operations.some((operation) => operation.id === 'Mutation.createUser'));
  const generatedOpenApiCase = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'api-openapi', 'cases', 'getUser.json'), 'utf8'));
  assert.equal(generatedOpenApiCase.path, '/users/1?includeProfile=true');
  assert.equal(generatedOpenApiCase.headers['x-client'], 'xoloop');
  assert.equal(generatedOpenApiCase.status_class, '2xx');
  const generatedGraphqlCase = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'api-openapi', 'cases', 'Query.user.json'), 'utf8'));
  assert.equal(generatedGraphqlCase.graphql_operation_id, 'Query.user');
  assert.match(generatedGraphqlCase.body.query, /query Query_user\(\$id: ID!\)/);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'api-openapi', 'cases', 'getUser.json')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'api-openapi', 'cases', 'Query.user.json')), true);
  assert.equal(created.goal.verify.scan.openapi_operations.length, 2);
});

test('api-suite supports hooks, DB side-effect checks, third-party replay, auth matrix, and latency confidence', async () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'db.json'), { users: [{ id: 1 }] });
  fs.writeFileSync(path.join(cwd, 'setup.cjs'), "process.exit(0);\n", 'utf8');
  fs.writeFileSync(path.join(cwd, 'teardown.cjs'), "process.exit(0);\n", 'utf8');
  fs.writeFileSync(path.join(cwd, 'snapshot.cjs'), "process.stdout.write(require('fs').readFileSync('db.json', 'utf8'));\n", 'utf8');
  const thirdParty = [{ method: 'POST', url: 'https://billing.example/usage', status: 200, response_body: '{"ok":true}' }];
  const server = await startServer((req, res) => {
    if (req.url === '/tenant/1/users/1' && req.headers.authorization === 'Bearer admin' && req.headers['x-tenant'] === '1') {
      return sendJson(res, 200, { id: 1, tenant: '1' }, { 'x-xoloop-third-party': JSON.stringify(thirdParty) });
    }
    if (req.url === '/tenant/1/users/1') return sendJson(res, 403, { error: 'forbidden' });
    return sendJson(res, 404, { error: 'not_found' });
  });
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, {
      goalId: 'deep',
      path: '/tenant/1/users/1',
      headers: { authorization: 'Bearer admin', 'x-tenant': '1' },
      expectedJson: { id: 1, tenant: '1' },
      responseSchema: {
        type: 'object',
        required: ['id', 'tenant'],
        properties: {
          id: { type: 'number' },
          tenant: { type: 'string' },
        },
      },
      auth: { denied_headers: {}, denied_statuses: [403] },
      retry: { attempts: 2, accept_statuses: [200] },
      caseExtra: {
        setup_command: 'node setup.cjs',
        teardown_command: 'node teardown.cjs',
        db_snapshot_command: 'node snapshot.cjs',
        db_invariant: 'unchanged',
        third_party_replay: {
          expected_file: 'third-party/expected.json',
          actual_file: 'third-party/actual.json',
          recording_file: 'third-party/expected.json',
          mode: 'vcr',
        },
        auth_matrix: [
          { role: 'admin', tenant: '1', headers: { authorization: 'Bearer admin', 'x-tenant': '1' }, allowed_statuses: [200] },
          { role: 'admin', tenant: '2', headers: { authorization: 'Bearer admin', 'x-tenant': '2' }, allowed_statuses: [403] },
          { role: 'viewer', tenant: '1', headers: { authorization: 'Bearer viewer', 'x-tenant': '1' }, allowed_statuses: [403] },
          { role: 'viewer', tenant: '2', headers: { authorization: 'Bearer viewer', 'x-tenant': '2' }, allowed_statuses: [403] },
        ],
        repeat: 3,
      },
      properties: [
        'case_present',
        'surface_coverage',
        'status_code',
        'response_schema',
        'error_shape',
        'auth_invariant',
        'auth_matrix',
        'auth_matrix_coverage',
        'idempotency',
        'retry_behavior',
        'state_hooks',
        'db_side_effects',
        'third_party_replay',
        'vcr_replay',
        'latency_budget',
        'latency_confidence',
        'mutation_score',
      ],
      verifyExtra: {
        auth_matrix: { roles: ['admin', 'viewer'], tenants: ['1', '2'] },
        mutation: {
          min_score: 1,
          mutants: [{ id: 'api-contract-break', command: 'node -e "process.exit(1)"' }],
        },
      },
    });
    writeJson(path.join(path.dirname(goalPath), 'third-party', 'expected.json'), { interactions: thirdParty });
    writeJson(path.join(path.dirname(goalPath), 'third-party', 'actual.json'), { interactions: thirdParty });

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'PASS_EVIDENCED');
    assert.deepEqual(card.missing_obligations, []);
    assert.ok(card.summary.by_id.auth_matrix.passed > 0);
    assert.ok(card.summary.by_id.auth_matrix_coverage.passed > 0);
    assert.ok(card.summary.by_id.db_side_effects.passed > 0);
    assert.ok(card.summary.by_id.third_party_replay.passed > 0);
    assert.ok(card.summary.by_id.vcr_replay.passed > 0);
    assert.ok(card.summary.by_id.latency_confidence.passed > 0);
    assert.ok(card.summary.by_id.mutation_score.passed > 0);
  } finally {
    await server.close();
  }
});

test('api-suite fuzzes request schemas and stores generated counterexamples', async () => {
  const cwd = tmpDir();
  const server = await startServer((_req, res) => sendJson(res, 200, { ok: true }));
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, {
      goalId: 'fuzz-api',
      method: 'POST',
      path: '/users',
      headers: {},
      expectedJson: { ok: true },
      responseSchema: { type: 'object', required: ['ok'] },
      auth: null,
      idempotent: false,
      retry: null,
      caseExtra: {
        body: { name: 'Ada' },
        request_schema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
      properties: [
        'case_present',
        'surface_coverage',
        'status_code',
        'response_schema',
        'error_shape',
        'generated_cases',
        'latency_budget',
      ],
    });
    const manifest = JSON.parse(fs.readFileSync(goalPath, 'utf8'));
    manifest.verify.fuzz = {
      generator: 'schema-negative',
      runs: 1,
      negative_statuses: [400],
      error_shape: { required: ['error'] },
    };
    writeGoalManifest(goalPath, manifest);

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'FAIL');
    assert.ok(card.summary.by_id.generated_cases.passed > 0);
    assert.ok(card.counterexample.corpus_path);
    assert.equal(fs.existsSync(card.counterexample.corpus_path), true);
  } finally {
    await server.close();
  }
});

test('api-suite uses deep JSON Schema semantics for request and response contracts', async () => {
  const cwd = tmpDir();
  const server = await startServer((_req, res) => sendJson(res, 200, { id: 1, status: 'inactive', extra: true }));
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, {
      goalId: 'deep-schema',
      method: 'POST',
      path: '/users',
      headers: {},
      expectedJson: undefined,
      auth: null,
      retry: null,
      caseExtra: {
        body: { name: 'Ada' },
        request_schema: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1 } },
        },
      },
      responseSchema: {
        type: 'object',
        required: ['id', 'status'],
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          status: { enum: ['active'] },
        },
      },
      properties: [
        'case_present',
        'status_code',
        'request_schema',
        'response_schema',
        'error_shape',
        'latency_budget',
      ],
    });

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'FAIL');
    assert.equal(card.counterexample.obligation, 'response_schema');
    assert.ok(card.counterexample.schema_errors.length > 0);
    assert.ok(card.summary.by_id.request_schema.passed > 0);
  } finally {
    await server.close();
  }
});

test('api-suite verifies live GraphQL introspection and execution', async () => {
  const cwd = tmpDir();
  const server = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (String(body.query || '').includes('__schema')) {
        return sendJson(res, 200, {
          data: {
            __schema: {
              queryType: { fields: [{ name: 'user', args: [], type: { kind: 'OBJECT', name: 'User' } }] },
              mutationType: { fields: [] },
              subscriptionType: { fields: [] },
            },
          },
        });
      }
      return sendJson(res, 200, { data: { user: { __typename: 'User' } } });
    });
  });
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, {
      goalId: 'graphql-live',
      method: 'POST',
      path: '/graphql',
      headers: { 'content-type': 'application/json' },
      expectedJson: { data: { user: { __typename: 'User' } } },
      responseSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
      auth: null,
      retry: null,
      caseExtra: {
        graphql: true,
        graphql_operation_id: 'Query.user',
        operation_id: 'Query.user',
        body: { query: 'query Query_user { user { __typename } }' },
        request_schema: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
      },
      scan: {
        route_files: [],
        graphql_operations: [{ id: 'Query.user', operation_type: 'query', field: 'user' }],
      },
      properties: [
        'case_present',
        'surface_coverage',
        'coverage_map',
        'status_code',
        'request_schema',
        'response_schema',
        'error_shape',
        'graphql_introspection',
        'graphql_execution',
        'idempotency',
        'latency_budget',
      ],
    });

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'PASS_EVIDENCED');
    assert.ok(card.summary.by_id.graphql_introspection.passed > 0);
    assert.ok(card.summary.by_id.graphql_execution.passed > 0);
  } finally {
    await server.close();
  }
});

test('api-suite detects DB/auth hints and supports adapter-aware file snapshots', async () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), { dependencies: { 'better-sqlite3': '^12.0.0' } });
  fs.mkdirSync(path.join(cwd, 'src', 'routes'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'routes', 'tenant.js'), "if (role === 'admin') req.headers['x-tenant-id'];\n", 'utf8');
  fs.writeFileSync(path.join(cwd, 'test.sqlite'), 'stable db bytes', 'utf8');
  const scan = scanApiRepo(cwd);
  const server = await startServer((_req, res) => sendJson(res, 200, { ok: true }));
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, {
      goalId: 'db-adapter',
      expectedJson: { ok: true },
      responseSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      auth: null,
      retry: null,
      scan,
      caseExtra: {
        db_snapshot: { adapter: 'sqlite-file', path: 'test.sqlite' },
        db_invariant: 'unchanged',
      },
      properties: [
        'case_present',
        'status_code',
        'response_schema',
        'error_shape',
        'db_side_effects',
        'latency_budget',
      ],
    });

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.ok(scan.database_adapters.some((adapter) => adapter.name === 'sqlite'));
    assert.ok(scan.auth_hints.roles.includes('admin'));
    assert.ok(scan.auth_hints.tenant_headers.includes('x-tenant-id'));
    assert.equal(card.verdict, 'PASS_EVIDENCED');
    assert.ok(card.summary.by_id.db_side_effects.passed > 0);
  } finally {
    await server.close();
  }
});

test('api-suite fails when mutation score has surviving mutants', async () => {
  const cwd = tmpDir();
  const server = await startServer((_req, res) => sendJson(res, 200, { ok: true }));
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, {
      goalId: 'mutation-survivor',
      expectedJson: { ok: true },
      responseSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      auth: null,
      retry: null,
      properties: [
        'case_present',
        'status_code',
        'response_schema',
        'error_shape',
        'latency_budget',
        'mutation_score',
      ],
      verifyExtra: {
        mutation: {
          min_score: 1,
          mutants: [{ id: 'survivor', command: 'node -e "process.exit(0)"' }],
        },
      },
    });

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'FAIL');
    assert.equal(card.counterexample.obligation, 'mutation_score');
    assert.equal(card.summary.by_id.mutation_score.failed, 1);
  } finally {
    await server.close();
  }
});

test('api-suite contract coverage map reports uncovered operations and status classes', async () => {
  const cwd = tmpDir();
  const server = await startServer((_req, res) => sendJson(res, 200, { id: 1, name: 'Ada' }));
  try {
    const goalPath = writeApiGoal(cwd, server.baseUrl, {
      goalId: 'coverage',
      caseExtra: { operation_id: 'getUser' },
      scan: {
        route_files: [],
        openapi_operations: [
          { id: 'getUser', method: 'GET', path: '/users/{id}', response_statuses: ['200', '404'] },
          { id: 'createUser', method: 'POST', path: '/users', response_statuses: ['201', '400'] },
        ],
      },
      auth: null,
      retry: null,
      properties: [
        'case_present',
        'surface_coverage',
        'coverage_map',
        'status_code',
        'response_schema',
        'error_shape',
        'idempotency',
        'latency_budget',
      ],
    });

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'PASS_WITH_GAPS');
    assert.ok(card.summary.by_id.coverage_map.gaps > 0);
    assert.ok(card.missing_obligations.includes('coverage_map'));
  } finally {
    await server.close();
  }
});
