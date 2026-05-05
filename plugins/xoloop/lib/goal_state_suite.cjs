'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob, goalBaseDir, stableStringify } = require('./goal_manifest.cjs');
const { scanStateRepo } = require('./goal_state_scan.cjs');

const DEFAULT_STATE_OBLIGATIONS = [
  'case_present',
  'native_adapters',
  'orchestration',
  'snapshot_before',
  'snapshot_after',
  'canonical_snapshot',
  'redaction_masks',
  'state_command_success',
  'action_safety',
  'fixture_strategy',
  'migration_check',
  'migration_checksum',
  'migration_drift',
  'data_invariants',
  'transaction_rollback',
  'tenant_isolation',
  'generated_tenant_matrix',
  'query_log',
  'write_allowlist',
  'unexpected_writes',
  'performance_budget',
  'state_size_budget',
];

function sanitizeId(id) {
  return String(id || 'case').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonMaybe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function stableCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableCopy);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableCopy(value[key]);
  return out;
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function loadCaseFile(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`state-suite case must be an object: ${filePath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
    throw new Error(`state-suite case must contain string id: ${filePath}`);
  }
  return {
    ...parsed,
    id: parsed.id.trim(),
    command: typeof parsed.command === 'string' ? parsed.command : '',
    setup_command: typeof parsed.setup_command === 'string' ? parsed.setup_command : '',
    teardown_command: typeof parsed.teardown_command === 'string' ? parsed.teardown_command : '',
    snapshot_command: typeof parsed.snapshot_command === 'string' ? parsed.snapshot_command : '',
    adapter: asObject(parsed.adapter, null),
    adapters: asArray(parsed.adapters).filter((item) => item && typeof item === 'object' && !Array.isArray(item)),
    snapshot: asObject(parsed.snapshot, {}),
    redactions: asArray(parsed.redactions).filter((item) => item && typeof item === 'object' && !Array.isArray(item)),
    masks: asArray(parsed.masks).filter((item) => item && typeof item === 'object' && !Array.isArray(item)),
    migrate_command: typeof parsed.migrate_command === 'string' ? parsed.migrate_command : '',
    migration_up_command: typeof parsed.migration_up_command === 'string' ? parsed.migration_up_command : '',
    migration_rollback_command: typeof parsed.migration_rollback_command === 'string' ? parsed.migration_rollback_command : '',
    migration_down_command: typeof parsed.migration_down_command === 'string' ? parsed.migration_down_command : '',
    migration_drift_command: typeof parsed.migration_drift_command === 'string' ? parsed.migration_drift_command : '',
    migration_checksum_file: typeof parsed.migration_checksum_file === 'string' ? parsed.migration_checksum_file : '',
    migration_files: Array.isArray(parsed.migration_files) ? parsed.migration_files.map(String) : [],
    transaction_command: typeof parsed.transaction_command === 'string' ? parsed.transaction_command : '',
    transaction: asObject(parsed.transaction, {}),
    rollback_command: typeof parsed.rollback_command === 'string' ? parsed.rollback_command : '',
    query_log: asObject(parsed.query_log, {}),
    query_log_file: typeof parsed.query_log_file === 'string' ? parsed.query_log_file : '',
    write_log_command: typeof parsed.write_log_command === 'string' ? parsed.write_log_command : '',
    allowed_writes: Array.isArray(parsed.allowed_writes) ? parsed.allowed_writes.map(String) : null,
    forbidden_writes: Array.isArray(parsed.forbidden_writes) ? parsed.forbidden_writes.map(String) : [],
    expected_changed_keys: Array.isArray(parsed.expected_changed_keys) ? parsed.expected_changed_keys.map(String) : null,
    expect_no_changes: parsed.expect_no_changes === true,
    expect_rollback_unchanged: parsed.expect_rollback_unchanged !== false,
    invariants: Array.isArray(parsed.invariants) ? parsed.invariants : [],
    invariants_file: typeof parsed.invariants_file === 'string' ? parsed.invariants_file : '',
    tenant_isolation: Array.isArray(parsed.tenant_isolation)
      ? parsed.tenant_isolation
      : (parsed.tenant_isolation && typeof parsed.tenant_isolation === 'object' ? [parsed.tenant_isolation] : []),
    tenant_matrix: asObject(parsed.tenant_matrix, {}),
    action: asObject(parsed.action, {}),
    allow_destructive: parsed.allow_destructive === true,
    mocked: parsed.mocked === true,
    fixture: asObject(parsed.fixture, {}),
    seed_command: typeof parsed.seed_command === 'string' ? parsed.seed_command : '',
    reset_command: typeof parsed.reset_command === 'string' ? parsed.reset_command : '',
    orchestration: asObject(parsed.orchestration, {}),
    performance_budget_ms: Number.isFinite(parsed.performance_budget_ms) ? parsed.performance_budget_ms : null,
    state_size_budget_bytes: Number.isFinite(parsed.state_size_budget_bytes) ? parsed.state_size_budget_bytes : null,
    budgets: asObject(parsed.budgets, {}),
    timeout_ms: Number.isFinite(parsed.timeout_ms) && parsed.timeout_ms > 0 ? Math.floor(parsed.timeout_ms) : 30000,
    metadata: asObject(parsed.metadata, {}),
  };
}

function artifactPath(goalPath, dirName, testCase, suffix = '.json') {
  return path.join(goalBaseDir(goalPath), dirName, `${sanitizeId(testCase.id)}${suffix}`);
}

function snapshotPath(goalPath, phase, testCase) {
  return path.join(goalBaseDir(goalPath), 'snapshots', phase, `${sanitizeId(testCase.id)}.json`);
}

function addPass(state, id, testCase, extra = {}) {
  state.verifications.push({ id, status: 'pass', case_id: testCase.id, ...extra });
}

function addGap(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'gap', case_id: testCase.id, message, ...extra });
}

function addFailure(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'fail', case_id: testCase.id, message, ...extra });
  if (!state.counterexample) {
    state.counterexample = {
      case_id: testCase.id,
      obligation: id,
      message,
      ...extra,
    };
  }
}

function commandTail(result) {
  if (!result) return {};
  return {
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout_tail: String(result.stdout || '').slice(-2000),
    stderr_tail: String(result.stderr || '').slice(-2000),
    metrics: result.metrics || {},
  };
}

async function runCommand(command, cwd, timeoutMs) {
  const result = await runCliCommand(command, '', { cwd, timeoutMs });
  let json = null;
  let jsonError = null;
  try {
    json = result.stdout ? JSON.parse(result.stdout) : null;
  } catch (err) {
    jsonError = err.message;
  }
  return { result, json, jsonError };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sqlIdentifier(value) {
  return String(value || '').replace(/"/g, '""');
}

function adapterList(goal, testCase) {
  return [
    ...(testCase.adapter ? [testCase.adapter] : []),
    ...testCase.adapters,
    ...asArray(goal.verify.adapters),
    ...asArray(goal.verify.db_adapters),
  ].filter((adapter) => adapter && typeof adapter === 'object' && !Array.isArray(adapter));
}

function adapterTables(adapter, snapshotOptions = {}) {
  const tables = adapter.tables || snapshotOptions.tables || snapshotOptions.include_tables || [];
  return asArray(tables).map((item) => (typeof item === 'string' ? { name: item } : asObject(item, null))).filter(Boolean);
}

function tableName(table) {
  return table.name || table.table || table.collection || '';
}

function tableOrderClause(table, snapshotOptions = {}) {
  const order = table.order_by || table.orderBy || (snapshotOptions.order_by && snapshotOptions.order_by[tableName(table)]) || table.primary_key || table.primaryKey || 'id';
  const fields = Array.isArray(order) ? order : [order];
  return fields.filter(Boolean).map((field) => `"${sqlIdentifier(field)}"`).join(', ');
}

async function runAdapterCommand(adapter, command, cwd, timeoutMs, state, phase) {
  const env = asObject(adapter.env, {});
  const result = await runCliCommand(command, '', { cwd, timeoutMs, env });
  state.trace.commands.push({ phase, command, adapter: adapter.kind || adapter.type, ...commandTail(result) });
  return result;
}

function parseTsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    const row = {};
    headers.forEach((header, index) => {
      const raw = values[index] === undefined ? '' : values[index];
      if (/^-?\d+(?:\.\d+)?$/.test(raw)) row[header] = Number(raw);
      else if (raw === 'NULL') row[header] = null;
      else row[header] = raw;
    });
    return row;
  });
}

function parseJsonOrLine(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    const line = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).reverse().find((item) => /^[\[{]/.test(item));
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch (__err) {
      return null;
    }
  }
}

async function snapshotPostgres(adapter, snapshotOptions, cwd, timeoutMs, state) {
  const out = {};
  for (const table of adapterTables(adapter, snapshotOptions)) {
    const name = tableName(table);
    const order = tableOrderClause(table, snapshotOptions);
    const sql = `select coalesce(json_agg(t${order ? ` order by ${order}` : ''}),'[]'::json) from (select * from "${sqlIdentifier(name)}") t;`;
    const url = adapter.url || adapter.connection || process.env.DATABASE_URL || '';
    const command = `${adapter.cli || 'psql'} ${url ? shellQuote(url) : ''} -At -c ${shellQuote(sql)}`.trim();
    const result = await runAdapterCommand(adapter, command, cwd, timeoutMs, state, `adapter_postgres_${name}`);
    if (result.exitCode !== 0) throw new Error(`postgres snapshot failed for ${name}: ${result.stderr || result.stdout}`);
    out[name] = parseJsonOrLine(result.stdout);
  }
  return out;
}

async function snapshotMysql(adapter, snapshotOptions, cwd, timeoutMs, state) {
  const out = {};
  for (const table of adapterTables(adapter, snapshotOptions)) {
    const name = tableName(table);
    const order = tableOrderClause(table, snapshotOptions).replace(/"/g, '`');
    const sql = `SELECT * FROM \`${String(name).replace(/`/g, '``')}\`${order ? ` ORDER BY ${order}` : ''};`;
    const url = adapter.url || adapter.connection || process.env.MYSQL_URL || '';
    const command = `${adapter.cli || 'mysql'} ${url ? shellQuote(url) : ''} --batch --raw -e ${shellQuote(sql)}`.trim();
    const result = await runAdapterCommand(adapter, command, cwd, timeoutMs, state, `adapter_mysql_${name}`);
    if (result.exitCode !== 0) throw new Error(`mysql snapshot failed for ${name}: ${result.stderr || result.stdout}`);
    out[name] = parseJsonOrLine(result.stdout) || parseTsv(result.stdout);
  }
  return out;
}

async function snapshotSqlite(adapter, snapshotOptions, cwd, timeoutMs, state) {
  const out = {};
  const database = adapter.database || adapter.file || process.env.SQLITE_DATABASE || '';
  if (!database) throw new Error('sqlite adapter requires database/file or SQLITE_DATABASE');
  for (const table of adapterTables(adapter, snapshotOptions)) {
    const name = tableName(table);
    const order = tableOrderClause(table, snapshotOptions);
    const sql = `SELECT * FROM "${sqlIdentifier(name)}"${order ? ` ORDER BY ${order}` : ''};`;
    const command = `${adapter.cli || 'sqlite3'} -json ${shellQuote(database)} ${shellQuote(sql)}`;
    const result = await runAdapterCommand(adapter, command, cwd, timeoutMs, state, `adapter_sqlite_${name}`);
    if (result.exitCode !== 0) throw new Error(`sqlite snapshot failed for ${name}: ${result.stderr || result.stdout}`);
    out[name] = parseJsonOrLine(result.stdout) || [];
  }
  return out;
}

async function snapshotRedis(adapter, cwd, timeoutMs, state) {
  const cli = adapter.cli || 'redis-cli';
  const prefix = adapter.url || process.env.REDIS_URL ? `-u ${shellQuote(adapter.url || process.env.REDIS_URL)} ` : '';
  const keysResult = await runAdapterCommand(adapter, `${cli} ${prefix}--raw --scan`, cwd, timeoutMs, state, 'adapter_redis_scan');
  if (keysResult.exitCode !== 0) throw new Error(`redis scan failed: ${keysResult.stderr || keysResult.stdout}`);
  const keys = String(keysResult.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).sort();
  const out = {};
  for (const key of keys) {
    const typeResult = await runAdapterCommand(adapter, `${cli} ${prefix}--raw TYPE ${shellQuote(key)}`, cwd, timeoutMs, state, `adapter_redis_type_${key}`);
    const type = String(typeResult.stdout || '').trim();
    let command = `${cli} ${prefix}--raw GET ${shellQuote(key)}`;
    if (type === 'hash') command = `${cli} ${prefix}--raw HGETALL ${shellQuote(key)}`;
    if (type === 'list') command = `${cli} ${prefix}--raw LRANGE ${shellQuote(key)} 0 -1`;
    if (type === 'set') command = `${cli} ${prefix}--raw SMEMBERS ${shellQuote(key)}`;
    if (type === 'zset') command = `${cli} ${prefix}--raw ZRANGE ${shellQuote(key)} 0 -1`;
    const valueResult = await runAdapterCommand(adapter, command, cwd, timeoutMs, state, `adapter_redis_value_${key}`);
    const lines = String(valueResult.stdout || '').split(/\r?\n/).filter(Boolean);
    out[key] = type === 'hash'
      ? Object.fromEntries(lines.reduce((pairs, value, index, arr) => (index % 2 === 0 ? [...pairs, [value, arr[index + 1]]] : pairs), []))
      : (lines.length <= 1 ? (lines[0] || '') : lines.sort());
  }
  return { redis: out };
}

async function runAdapterSnapshot(goal, testCase, cwd, state) {
  const adapters = adapterList(goal, testCase);
  if (adapters.length === 0) return null;
  const adapter = adapters[0];
  if (adapter.snapshot_command) {
    const capture = await runCommand(adapter.snapshot_command, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: 'adapter_snapshot_command', command: adapter.snapshot_command, adapter: adapter.kind || adapter.type, ...commandTail(capture.result), json_error: capture.jsonError });
    if (capture.result.exitCode !== 0) throw new Error(`adapter snapshot command failed: ${capture.result.stderr || capture.result.stdout}`);
    if (capture.jsonError) throw new Error(`adapter snapshot command did not emit JSON: ${capture.jsonError}`);
    return capture.json;
  }
  const kind = String(adapter.kind || adapter.type || '').toLowerCase();
  const snapshotOptions = { ...asObject(goal.verify.snapshot, {}), ...testCase.snapshot };
  if (kind === 'postgres' || kind === 'postgresql') return snapshotPostgres(adapter, snapshotOptions, cwd, testCase.timeout_ms, state);
  if (kind === 'mysql' || kind === 'mariadb') return snapshotMysql(adapter, snapshotOptions, cwd, testCase.timeout_ms, state);
  if (kind === 'sqlite' || kind === 'sqlite3') return snapshotSqlite(adapter, snapshotOptions, cwd, testCase.timeout_ms, state);
  if (kind === 'redis') return snapshotRedis(adapter, cwd, testCase.timeout_ms, state);
  throw new Error(`unsupported state adapter: ${kind || '(missing kind)'}`);
}

function sortRowsBySchema(snapshot, snapshotOptions = {}) {
  const copy = stableCopy(snapshot);
  const tables = asObject(snapshotOptions.tables, {});
  const schemas = asObject(snapshotOptions.schema, {});
  for (const [name, rows] of Object.entries(copy && typeof copy === 'object' ? copy : {})) {
    if (!Array.isArray(rows)) continue;
    const tableSpec = asObject(tables[name], asObject(schemas[name], {}));
    const primary = tableSpec.primary_key || tableSpec.primaryKey || 'id';
    rows.sort((a, b) => String((a || {})[primary] ?? stableStringify(a)).localeCompare(String((b || {})[primary] ?? stableStringify(b))));
  }
  return copy;
}

function applyRedactionPath(value, parts, replacement) {
  if (parts.length === 0) return replacement;
  if (value === null || value === undefined) return value;
  const [part, ...rest] = parts;
  if (part === '*') {
    if (Array.isArray(value)) return value.map((item) => applyRedactionPath(item, rest, replacement));
    if (typeof value === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = applyRedactionPath(child, rest, replacement);
      return out;
    }
    return value;
  }
  if (typeof value !== 'object') return value;
  const out = Array.isArray(value) ? value.slice() : { ...value };
  if (Object.prototype.hasOwnProperty.call(out, part)) out[part] = applyRedactionPath(out[part], rest, replacement);
  return out;
}

function redactByKeys(value, keyPatterns, replacement) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactByKeys(item, keyPatterns, replacement));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const matched = keyPatterns.some((pattern) => {
      if (pattern instanceof RegExp) return pattern.test(key);
      return String(key).toLowerCase() === String(pattern).toLowerCase();
    });
    out[key] = matched ? replacement : redactByKeys(child, keyPatterns, replacement);
  }
  return out;
}

function normalizeRedactions(goal, testCase) {
  const snapshot = { ...asObject(goal.verify.snapshot, {}), ...testCase.snapshot };
  const redactions = [
    ...asArray(snapshot.redactions),
    ...asArray(snapshot.masks),
    ...asArray(goal.verify.redactions),
    ...asArray(goal.verify.masks),
    ...testCase.redactions,
    ...testCase.masks,
  ].filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  const schema = asObject(snapshot.schema, {});
  for (const [table, spec] of Object.entries(schema)) {
    for (const column of asArray(spec.redacted_columns || spec.redactedColumns)) {
      redactions.push({ path: `${table}.*.${column}`, replacement: '<redacted>' });
    }
  }
  return redactions;
}

function canonicalizeSnapshot(snapshot, goal, testCase) {
  const snapshotOptions = { ...asObject(goal.verify.snapshot, {}), ...testCase.snapshot };
  let out = sortRowsBySchema(snapshot, snapshotOptions);
  const redactions = normalizeRedactions(goal, testCase);
  for (const redaction of redactions) {
    const replacement = Object.prototype.hasOwnProperty.call(redaction, 'replacement') ? redaction.replacement : '<redacted>';
    if (redaction.path) out = applyRedactionPath(out, String(redaction.path).split('.').filter(Boolean), replacement);
    if (redaction.key || redaction.keys) out = redactByKeys(out, asArray(redaction.keys || [redaction.key]), replacement);
    if (redaction.match_key) out = redactByKeys(out, [new RegExp(redaction.match_key, 'i')], replacement);
  }
  return stableCopy(out);
}

function snapshotMetrics(snapshot) {
  const text = JSON.stringify(stableCopy(snapshot));
  let rows = 0;
  if (snapshot && typeof snapshot === 'object') {
    for (const value of Object.values(snapshot)) {
      if (Array.isArray(value)) rows += value.length;
      else if (value && typeof value === 'object') rows += Object.keys(value).length;
    }
  }
  return { state_snapshot_bytes: Buffer.byteLength(text || '', 'utf8'), state_row_count: rows };
}

async function runSnapshot(goal, goalPath, testCase, phase, state, cwd) {
  const command = testCase.snapshot_command || goal.verify.snapshot_command || '';
  let snapshot = null;
  if (!command) {
    try {
      snapshot = await runAdapterSnapshot(goal, testCase, cwd, state);
    } catch (err) {
      const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, `-adapter-snapshot-${phase}.json`), {
        error: err.message,
        adapters: adapterList(goal, testCase),
      });
      addFailure(state, phase === 'before' ? 'snapshot_before' : 'snapshot_after', testCase, `adapter snapshot ${phase} failed`, { diff_path });
      return null;
    }
  }
  if (!command && snapshot === null) {
    addGap(state, phase === 'before' ? 'snapshot_before' : 'snapshot_after', testCase, 'no snapshot command declared');
    return null;
  }
  if (command) {
    const capture = await runCommand(command, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: `snapshot_${phase}`, command, ...commandTail(capture.result), json_error: capture.jsonError });
    if (capture.result.exitCode !== 0) {
      const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, `-snapshot-${phase}.json`), {
        command,
        result: commandTail(capture.result),
      });
      addFailure(state, phase === 'before' ? 'snapshot_before' : 'snapshot_after', testCase, `snapshot ${phase} command failed`, { diff_path });
      return null;
    }
    if (capture.jsonError) {
      const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, `-snapshot-${phase}-parse.json`), {
        command,
        json_error: capture.jsonError,
        stdout_tail: String(capture.result.stdout || '').slice(-2000),
      });
      addFailure(state, phase === 'before' ? 'snapshot_before' : 'snapshot_after', testCase, `snapshot ${phase} did not emit JSON`, { diff_path });
      return null;
    }
    snapshot = capture.json;
  }
  const canonical = canonicalizeSnapshot(snapshot, goal, testCase);
  const metrics = snapshotMetrics(canonical);
  state.metrics.push(metrics);
  writeJson(snapshotPath(goalPath, phase, testCase), canonical);
  addPass(state, phase === 'before' ? 'snapshot_before' : 'snapshot_after', testCase, {
    snapshot_path: snapshotPath(goalPath, phase, testCase),
    ...metrics,
  });
  if (phase === 'before') {
    if (adapterList(goal, testCase).length > 0) addPass(state, 'native_adapters', testCase, { adapter: adapterList(goal, testCase)[0].kind || adapterList(goal, testCase)[0].type });
    else addGap(state, 'native_adapters', testCase, 'no native database adapter declared');
    addPass(state, 'canonical_snapshot', testCase);
    if (normalizeRedactions(goal, testCase).length > 0) addPass(state, 'redaction_masks', testCase, { redactions: normalizeRedactions(goal, testCase).length });
    else addGap(state, 'redaction_masks', testCase, 'no snapshot redaction/mask rules declared');
  }
  return canonical;
}

function valuesAtPath(value, rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return [value];
  const parts = text.split('.').filter(Boolean);
  let cursors = [value];
  for (const part of parts) {
    const next = [];
    for (const cursor of cursors) {
      if (cursor === null || cursor === undefined) continue;
      if (part === '*') {
        if (Array.isArray(cursor)) next.push(...cursor);
        else if (typeof cursor === 'object') next.push(...Object.values(cursor));
      } else if (Array.isArray(cursor) && /^\d+$/.test(part)) {
        if (Number(part) < cursor.length) next.push(cursor[Number(part)]);
      } else if (typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, part)) {
        next.push(cursor[part]);
      }
    }
    cursors = next;
  }
  return cursors;
}

function typeMatches(value, expected) {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'null') return value === null;
  if (expected === 'object') return value && typeof value === 'object' && !Array.isArray(value);
  return typeof value === expected;
}

function invariantId(invariant, index) {
  return String(invariant.id || invariant.path || invariant.collection || invariant.table || `invariant-${index + 1}`);
}

function checkInvariant(snapshot, invariant, index) {
  const id = invariantId(invariant, index);
  const pathExpr = invariant.path || invariant.collection || invariant.table || '';
  const values = valuesAtPath(snapshot, pathExpr);
  const failures = [];
  if (invariant.required === true && values.length === 0) failures.push(`${id}: required path missing`);
  if (invariant.not_null === true && (values.length === 0 || values.some((value) => value === null || value === undefined))) failures.push(`${id}: null value found`);
  if (invariant.type) {
    const bad = values.filter((value) => !typeMatches(value, invariant.type));
    if (bad.length > 0 || values.length === 0) failures.push(`${id}: expected type ${invariant.type}`);
  }
  if (Object.prototype.hasOwnProperty.call(invariant, 'equals')) {
    const expected = stableStringify(stableCopy(invariant.equals));
    const bad = values.filter((value) => stableStringify(stableCopy(value)) !== expected);
    if (bad.length > 0 || values.length === 0) failures.push(`${id}: value did not equal expected`);
  }
  if (Number.isFinite(invariant.gte)) {
    const bad = values.filter((value) => !Number.isFinite(value) || value < invariant.gte);
    if (bad.length > 0 || values.length === 0) failures.push(`${id}: value below ${invariant.gte}`);
  }
  if (Number.isFinite(invariant.lte)) {
    const bad = values.filter((value) => !Number.isFinite(value) || value > invariant.lte);
    if (bad.length > 0 || values.length === 0) failures.push(`${id}: value above ${invariant.lte}`);
  }
  if (Number.isFinite(invariant.min_count) || Number.isFinite(invariant.max_count)) {
    for (const value of values) {
      const count = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 0);
      if (Number.isFinite(invariant.min_count) && count < invariant.min_count) failures.push(`${id}: count ${count} below ${invariant.min_count}`);
      if (Number.isFinite(invariant.max_count) && count > invariant.max_count) failures.push(`${id}: count ${count} above ${invariant.max_count}`);
    }
    if (values.length === 0) failures.push(`${id}: count path missing`);
  }
  if (invariant.unique_by) {
    for (const value of values) {
      if (!Array.isArray(value)) {
        failures.push(`${id}: unique_by target is not an array`);
        continue;
      }
      const seen = new Set();
      for (const row of value) {
        const key = row && typeof row === 'object' ? row[invariant.unique_by] : undefined;
        if (key === undefined || key === null || seen.has(String(key))) {
          failures.push(`${id}: duplicate or missing ${invariant.unique_by}`);
          break;
        }
        seen.add(String(key));
      }
    }
    if (values.length === 0) failures.push(`${id}: unique_by path missing`);
  }
  return failures;
}

function loadInvariants(goal, goalPath, testCase) {
  const out = [];
  if (Array.isArray(goal.verify.invariants)) out.push(...goal.verify.invariants);
  if (Array.isArray(testCase.invariants)) out.push(...testCase.invariants);
  const files = [];
  if (goal.verify.invariants_file) files.push(goal.verify.invariants_file);
  if (testCase.invariants_file) files.push(testCase.invariants_file);
  for (const file of files) {
    const absolute = path.isAbsolute(file) ? file : path.resolve(goalBaseDir(goalPath), file);
    const parsed = readJsonMaybe(absolute);
    if (Array.isArray(parsed)) out.push(...parsed);
    else if (parsed && Array.isArray(parsed.invariants)) out.push(...parsed.invariants);
  }
  return out.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function verifyDataInvariants(goal, goalPath, testCase, state, snapshots) {
  const invariants = loadInvariants(goal, goalPath, testCase);
  if (invariants.length === 0) {
    addGap(state, 'data_invariants', testCase, 'no data invariants declared');
    return;
  }
  const failures = [];
  for (const [phase, snapshot] of Object.entries(snapshots)) {
    if (snapshot === null || snapshot === undefined) continue;
    for (let i = 0; i < invariants.length; i += 1) {
      for (const message of checkInvariant(snapshot, invariants[i], i)) failures.push({ phase, message, invariant: invariants[i] });
    }
  }
  if (failures.length === 0) addPass(state, 'data_invariants', testCase, { invariant_count: invariants.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-data-invariants.json'), { failures });
    addFailure(state, 'data_invariants', testCase, 'data invariants failed', { diff_path, failures: failures.slice(0, 10) });
  }
}

function changedTopLevelKeys(before, after) {
  if (!before || typeof before !== 'object' || Array.isArray(before) || !after || typeof after !== 'object' || Array.isArray(after)) {
    return stableStringify(stableCopy(before)) === stableStringify(stableCopy(after)) ? [] : ['__root__'];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => stableStringify(stableCopy(before[key])) !== stableStringify(stableCopy(after[key]))).sort();
}

function writeSnapshotDiff(goalPath, testCase, before, after, obligation = 'snapshot-diff') {
  const changed_keys = changedTopLevelKeys(before, after);
  return writeJson(artifactPath(goalPath, 'diffs', testCase, `-${sanitizeId(obligation)}.json`), {
    changed_keys,
    before: stableCopy(before),
    after: stableCopy(after),
  });
}

function verifyWriteAllowlist(goal, goalPath, testCase, state, before, after) {
  if (before === null || before === undefined || after === null || after === undefined) return;
  const changed = changedTopLevelKeys(before, after);
  const allowed = testCase.allowed_writes || (Array.isArray(goal.verify.allowed_writes) ? goal.verify.allowed_writes.map(String) : null);
  const forbidden = [...testCase.forbidden_writes, ...(Array.isArray(goal.verify.forbidden_writes) ? goal.verify.forbidden_writes.map(String) : [])];
  const forbiddenChanged = changed.filter((key) => forbidden.includes(key));
  if (forbiddenChanged.length > 0) {
    const diff_path = writeSnapshotDiff(goalPath, testCase, before, after, 'forbidden-writes');
    addFailure(state, 'unexpected_writes', testCase, 'forbidden state keys changed', { diff_path, changed_keys: changed, forbidden_changed: forbiddenChanged });
    return;
  }
  if (testCase.expect_no_changes && changed.length > 0) {
    const diff_path = writeSnapshotDiff(goalPath, testCase, before, after, 'unexpected-writes');
    addFailure(state, 'unexpected_writes', testCase, 'state changed even though case expected no changes', { diff_path, changed_keys: changed });
    return;
  }
  if (allowed) {
    const unexpected = changed.filter((key) => !allowed.includes(key));
    const missingExpected = Array.isArray(testCase.expected_changed_keys)
      ? testCase.expected_changed_keys.filter((key) => !changed.includes(key))
      : [];
    if (unexpected.length === 0 && missingExpected.length === 0) {
      addPass(state, 'write_allowlist', testCase, { allowed_writes: allowed, changed_keys: changed });
      addPass(state, 'unexpected_writes', testCase, { changed_keys: changed });
    } else {
      const diff_path = writeSnapshotDiff(goalPath, testCase, before, after, 'write-allowlist');
      addFailure(state, unexpected.length > 0 ? 'unexpected_writes' : 'write_allowlist', testCase, 'state writes did not match allowlist', {
        diff_path,
        allowed_writes: allowed,
        changed_keys: changed,
        unexpected,
        missing_expected: missingExpected,
      });
    }
    return;
  }
  if (changed.length === 0) {
    addGap(state, 'write_allowlist', testCase, 'no write allowlist declared');
    addPass(state, 'unexpected_writes', testCase, { changed_keys: [] });
  } else {
    const diff_path = writeSnapshotDiff(goalPath, testCase, before, after, 'unexpected-writes');
    addFailure(state, 'unexpected_writes', testCase, 'state changed without an allowlist', { diff_path, changed_keys: changed });
  }
}

function rowsAt(snapshot, rule) {
  const pathExpr = rule.path || rule.collection || rule.table || '';
  return valuesAtPath(snapshot, pathExpr)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function rowKey(row, primaryKey) {
  if (!row || typeof row !== 'object') return '';
  const raw = row[primaryKey] === undefined ? row.id : row[primaryKey];
  return raw === undefined || raw === null ? stableStringify(stableCopy(row)) : String(raw);
}

function verifyTenantIsolation(goal, goalPath, testCase, state, before, after) {
  if (before === null || before === undefined || after === null || after === undefined) return;
  const rules = [
    ...(Array.isArray(goal.verify.tenant_isolation) ? goal.verify.tenant_isolation : []),
    ...testCase.tenant_isolation,
  ].filter((rule) => rule && typeof rule === 'object' && !Array.isArray(rule));
  if (rules.length === 0) {
    addGap(state, 'tenant_isolation', testCase, 'no tenant isolation rule declared');
    return;
  }
  const violations = [];
  for (const rule of rules) {
    const primaryKey = rule.primary_key || rule.primaryKey || 'id';
    const tenantField = rule.tenant_field || rule.tenantField || 'tenant_id';
    const allowed = new Set([
      ...(Array.isArray(rule.allowed_tenants) ? rule.allowed_tenants.map(String) : []),
      ...(Array.isArray(rule.allowed_tenant_ids) ? rule.allowed_tenant_ids.map(String) : []),
      ...(rule.tenant_id !== undefined ? [String(rule.tenant_id)] : []),
      ...(rule.tenant !== undefined ? [String(rule.tenant)] : []),
    ]);
    const forbidden = new Set([
      ...(Array.isArray(rule.forbidden_tenants) ? rule.forbidden_tenants.map(String) : []),
      ...(Array.isArray(rule.forbidden_tenant_ids) ? rule.forbidden_tenant_ids.map(String) : []),
    ]);
    if (allowed.size === 0 && forbidden.size === 0) {
      violations.push({ rule, message: 'tenant rule has no allowed or forbidden tenants' });
      continue;
    }
    const beforeRows = new Map(rowsAt(before, rule).map((row) => [rowKey(row, primaryKey), row]));
    const afterRows = new Map(rowsAt(after, rule).map((row) => [rowKey(row, primaryKey), row]));
    const keys = new Set([...beforeRows.keys(), ...afterRows.keys()]);
    for (const key of keys) {
      const b = beforeRows.get(key);
      const a = afterRows.get(key);
      if (stableStringify(stableCopy(b)) === stableStringify(stableCopy(a))) continue;
      const tenant = String((a && (a[tenantField] ?? a.tenant ?? a.tenantId)) ?? (b && (b[tenantField] ?? b.tenant ?? b.tenantId)) ?? '');
      const blocked = forbidden.has(tenant) || (allowed.size > 0 && !allowed.has(tenant));
      if (blocked) violations.push({ key, tenant, before: b, after: a, rule });
    }
  }
  if (violations.length === 0) addPass(state, 'tenant_isolation', testCase, { rule_count: rules.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-tenant-isolation.json'), { violations });
    addFailure(state, 'tenant_isolation', testCase, 'state mutation crossed tenant boundary', { diff_path, violations: violations.slice(0, 10) });
  }
}

function generateTenantRules(goal, testCase, snapshot) {
  const config = { ...asObject(goal.verify.tenant_matrix, {}), ...testCase.tenant_matrix };
  if (config.generate !== true || !snapshot || typeof snapshot !== 'object') return [];
  const allowed = new Set([
    ...asArray(config.allowed_tenants).map(String),
    ...asArray(config.allowed_tenant_ids).map(String),
    ...(config.tenant_id !== undefined ? [String(config.tenant_id)] : []),
    ...(config.tenant !== undefined ? [String(config.tenant)] : []),
  ]);
  const tenantFields = asArray(config.tenant_fields).length > 0
    ? asArray(config.tenant_fields)
    : ['tenant_id', 'tenantId', 'tenant'];
  const rules = [];
  for (const [table, rows] of Object.entries(snapshot)) {
    if (!Array.isArray(rows)) continue;
    const sample = rows.find((row) => row && typeof row === 'object');
    if (!sample) continue;
    const tenantField = tenantFields.find((field) => Object.prototype.hasOwnProperty.call(sample, field));
    if (!tenantField) continue;
    const tenants = [...new Set(rows.map((row) => row && row[tenantField]).filter((value) => value !== undefined && value !== null).map(String))].sort();
    const allowedTenants = allowed.size > 0 ? [...allowed] : tenants.slice(0, 1);
    rules.push({
      path: table,
      primary_key: config.primary_key || config.primaryKey || 'id',
      tenant_field: tenantField,
      allowed_tenants: allowedTenants,
      generated: true,
    });
  }
  return rules;
}

function verifyGeneratedTenantMatrix(goal, goalPath, testCase, state, before, after) {
  const rules = generateTenantRules(goal, testCase, before);
  if (rules.length === 0) {
    addGap(state, 'generated_tenant_matrix', testCase, 'no tenant matrix generation configured or no tenant-shaped data found');
    return;
  }
  const synthetic = { ...testCase, tenant_isolation: rules };
  const beforeFailures = state.verifications.length;
  verifyTenantIsolation({ ...goal, verify: { ...goal.verify, tenant_isolation: [] } }, goalPath, synthetic, state, before, after);
  const added = state.verifications.slice(beforeFailures);
  if (added.some((entry) => entry.id === 'tenant_isolation' && entry.status === 'fail')) {
    const latest = added.find((entry) => entry.id === 'tenant_isolation' && entry.status === 'fail');
    if (!state.counterexample || state.counterexample.obligation !== 'tenant_isolation') {
      addFailure(state, 'generated_tenant_matrix', testCase, 'generated tenant matrix failed', { diff_path: latest && latest.diff_path });
    }
  } else {
    addPass(state, 'generated_tenant_matrix', testCase, { generated_rules: rules.length });
  }
}

function classifyStateAction(goal, testCase) {
  const policy = String(testCase.action.policy || goal.verify.action_policy || 'block-destructive').toLowerCase();
  const text = [
    testCase.action.kind,
    testCase.action.name,
    testCase.command,
    testCase.transaction_command,
    testCase.migrate_command,
  ].filter(Boolean).join(' ').toLowerCase();
  const destructive = /\b(drop|truncate|delete|destroy|purge|wipe|reset|flushall|flushdb|charge|pay|refund|email|sms|send|prod|production)\b/.test(text);
  const sensitive = /\b(secret|token|password|credential|pii|ssn|card|billing)\b/.test(text);
  const blocked = policy !== 'allow-destructive' && (destructive || sensitive) && !testCase.allow_destructive && !testCase.mocked;
  return { policy, destructive, sensitive, blocked };
}

function verifyActionSafety(goal, testCase, state) {
  const action = classifyStateAction(goal, testCase);
  if (action.blocked) {
    addFailure(state, 'action_safety', testCase, 'destructive or sensitive state action is blocked unless explicitly allowed or mocked', action);
    return false;
  }
  addPass(state, 'action_safety', testCase, action);
  return true;
}

async function runOrchestration(goal, testCase, state, cwd) {
  const config = { ...asObject(goal.verify.orchestration, {}), ...testCase.orchestration };
  if (!config.start_command && !config.ready_command && !config.stop_command) {
    addGap(state, 'orchestration', testCase, 'no local DB/dev-container orchestration declared');
    return async () => {};
  }
  if (config.auto_start === false && !testCase.orchestration.auto_start) {
    addGap(state, 'orchestration', testCase, 'orchestration declared but auto_start is disabled');
    return async () => {};
  }
  if (config.start_command) {
    const start = await runCommand(config.start_command, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: 'orchestration_start', command: config.start_command, ...commandTail(start.result) });
    if (start.result.exitCode !== 0) addFailure(state, 'orchestration', testCase, 'orchestration start command failed', { result: commandTail(start.result) });
  }
  if (config.ready_command) {
    const ready = await runCommand(config.ready_command, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: 'orchestration_ready', command: config.ready_command, ...commandTail(ready.result) });
    if (ready.result.exitCode !== 0) addFailure(state, 'orchestration', testCase, 'orchestration ready command failed', { result: commandTail(ready.result) });
  }
  if (!state.verifications.some((entry) => entry.id === 'orchestration' && entry.status === 'fail')) addPass(state, 'orchestration', testCase);
  return async () => {
    if (!config.stop_command) return;
    const stop = await runCommand(config.stop_command, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: 'orchestration_stop', command: config.stop_command, ...commandTail(stop.result) });
  };
}

async function runFixtureStrategy(goal, testCase, state, cwd) {
  const config = { ...asObject(goal.verify.fixture, {}), ...testCase.fixture };
  const seedCommand = testCase.seed_command || config.seed_command || config.seed || '';
  const resetCommand = testCase.reset_command || config.reset_command || config.reset || '';
  if (!seedCommand && !resetCommand) {
    addGap(state, 'fixture_strategy', testCase, 'no fixture seed/reset strategy declared');
    return async () => {};
  }
  if (resetCommand && (config.reset_before !== false)) {
    const reset = await runCommand(resetCommand, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: 'fixture_reset_before', command: resetCommand, ...commandTail(reset.result) });
    if (reset.result.exitCode !== 0) addFailure(state, 'fixture_strategy', testCase, 'fixture reset command failed', { result: commandTail(reset.result) });
  }
  if (seedCommand) {
    const seed = await runCommand(seedCommand, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: 'fixture_seed', command: seedCommand, ...commandTail(seed.result) });
    if (seed.result.exitCode !== 0) addFailure(state, 'fixture_strategy', testCase, 'fixture seed command failed', { result: commandTail(seed.result) });
  }
  if (!state.verifications.some((entry) => entry.id === 'fixture_strategy' && entry.status === 'fail')) addPass(state, 'fixture_strategy', testCase);
  return async () => {
    if (!resetCommand || config.reset_after === false) return;
    const reset = await runCommand(resetCommand, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: 'fixture_reset_after', command: resetCommand, ...commandTail(reset.result) });
  };
}

function sha256File(filePath) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function migrationFiles(goal, testCase, cwd) {
  const files = [
    ...asArray(goal.verify.migration_files),
    ...testCase.migration_files,
    ...asArray(goal.verify.scan && goal.verify.scan.migration_files),
  ].filter(Boolean);
  return [...new Set(files)].map((file) => path.isAbsolute(file) ? file : path.resolve(cwd, file)).filter((file) => fs.existsSync(file)).sort();
}

function verifyMigrationChecksums(goal, goalPath, testCase, state, cwd) {
  const files = migrationFiles(goal, testCase, cwd);
  if (files.length === 0) {
    addGap(state, 'migration_checksum', testCase, 'no migration files available for checksum verification');
    return;
  }
  const current = {};
  for (const file of files) current[path.relative(cwd, file).replace(/\\/g, '/')] = sha256File(file);
  const artifact = writeJson(artifactPath(goalPath, 'migrations', testCase, '-checksums.json'), current);
  const checksumFile = testCase.migration_checksum_file || goal.verify.migration_checksum_file || '';
  if (!checksumFile) {
    addGap(state, 'migration_checksum', testCase, 'no migration checksum baseline declared', { checksum_path: artifact });
    return;
  }
  const expectedPath = path.isAbsolute(checksumFile) ? checksumFile : path.resolve(goalBaseDir(goalPath), checksumFile);
  const expected = readJsonMaybe(expectedPath);
  if (!expected) {
    addGap(state, 'migration_checksum', testCase, 'migration checksum baseline file is missing or invalid', { checksum_path: artifact, baseline_path: expectedPath });
    return;
  }
  if (stableStringify(stableCopy(expected)) === stableStringify(stableCopy(current))) addPass(state, 'migration_checksum', testCase, { checksum_path: artifact });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-migration-checksum.json'), { expected, current });
    addFailure(state, 'migration_checksum', testCase, 'migration checksum drift detected', { diff_path });
  }
}

async function verifyMigrationDrift(goal, testCase, state, cwd) {
  const command = testCase.migration_drift_command || goal.verify.migration_drift_command || '';
  if (!command) {
    addGap(state, 'migration_drift', testCase, 'no migration drift command declared');
    return;
  }
  const drift = await runCommand(command, cwd, testCase.timeout_ms);
  state.trace.commands.push({ phase: 'migration_drift', command, ...commandTail(drift.result) });
  if (drift.result.exitCode === 0) addPass(state, 'migration_drift', testCase);
  else addFailure(state, 'migration_drift', testCase, 'migration drift command failed', { result: commandTail(drift.result) });
}

function readQueryLog(goal, testCase, cwd) {
  const config = { ...asObject(goal.verify.query_log, {}), ...testCase.query_log };
  const file = testCase.query_log_file || config.file || '';
  if (!file) return { entries: null, config };
  const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const text = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
  if (!text.trim()) return { entries: [], config, file: absolute };
  const parsed = readJsonMaybe(absolute);
  if (Array.isArray(parsed)) return { entries: parsed, config, file: absolute };
  if (parsed && Array.isArray(parsed.queries)) return { entries: parsed.queries, config, file: absolute };
  return {
    entries: text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((sql) => ({ sql })),
    config,
    file: absolute,
  };
}

function queryWrites(entries) {
  const writes = [];
  for (const entry of entries || []) {
    const sql = String(entry.sql || entry.query || entry.statement || entry).replace(/\s+/g, ' ').trim();
    const match = sql.match(/\b(insert\s+into|update|delete\s+from|alter\s+table|drop\s+table|truncate(?:\s+table)?)\s+["`]?([A-Za-z0-9_.-]+)/i);
    if (match) writes.push({ operation: match[1].toUpperCase(), table: match[2].replace(/["`]/g, ''), sql });
  }
  return writes;
}

async function verifyQueryLog(goal, goalPath, testCase, state, cwd, before, after) {
  let entries = null;
  let config = {};
  if (testCase.write_log_command || goal.verify.write_log_command) {
    const command = testCase.write_log_command || goal.verify.write_log_command;
    const capture = await runCommand(command, cwd, testCase.timeout_ms);
    state.trace.commands.push({ phase: 'write_log', command, ...commandTail(capture.result), json_error: capture.jsonError });
    if (capture.result.exitCode !== 0 || capture.jsonError) {
      addFailure(state, 'query_log', testCase, 'write log command failed or did not emit JSON', { result: commandTail(capture.result), json_error: capture.jsonError });
      return;
    }
    entries = Array.isArray(capture.json) ? capture.json : asArray(capture.json && capture.json.queries);
  } else {
    const read = readQueryLog(goal, testCase, cwd);
    entries = read.entries;
    config = read.config;
  }
  if (!entries) {
    addGap(state, 'query_log', testCase, 'no query log/WAL/write-log source declared');
    return;
  }
  const writes = queryWrites(entries);
  const allowed = testCase.allowed_writes || asArray(goal.verify.allowed_writes);
  const changed = before && after ? changedTopLevelKeys(before, after) : [];
  const unexpected = writes.filter((write) => allowed.length > 0 && !allowed.includes(write.table));
  const unloggedChanges = changed.filter((key) => !writes.some((write) => write.table === key));
  if (unexpected.length === 0 && (config.require_logged_writes === false || unloggedChanges.length === 0)) {
    addPass(state, 'query_log', testCase, { writes: writes.length });
  } else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-query-log.json'), { writes, allowed, changed_keys: changed, unexpected, unlogged_changes: unloggedChanges });
    addFailure(state, 'query_log', testCase, 'query log/WAL writes did not match allowed state changes', { diff_path });
  }
}

function verifyBudgets(goal, testCase, state) {
  const budget = { ...asObject(goal.verify.budgets, {}), ...testCase.budgets };
  const commandBudget = testCase.performance_budget_ms || budget.performance_ms_lte || budget.state_command_ms_lte || null;
  const sizeBudget = testCase.state_size_budget_bytes || budget.snapshot_bytes_lte || budget.state_snapshot_bytes_lte || null;
  const commandValues = state.metrics.map((item) => item && item.state_command_ms).filter(Number.isFinite);
  const snapshotValues = state.metrics.map((item) => item && item.state_snapshot_bytes).filter(Number.isFinite);
  const commandMs = commandValues.length ? Math.max(...commandValues) : null;
  const snapshotBytes = snapshotValues.length ? Math.max(...snapshotValues) : null;
  if (Number.isFinite(commandBudget)) {
    if (Number.isFinite(commandMs) && commandMs <= commandBudget) addPass(state, 'performance_budget', testCase, { state_command_ms: commandMs, lte: commandBudget });
    else addFailure(state, 'performance_budget', testCase, 'state performance budget exceeded', { state_command_ms: commandMs, lte: commandBudget });
  } else addGap(state, 'performance_budget', testCase, 'no state performance budget declared');
  if (Number.isFinite(sizeBudget)) {
    if (Number.isFinite(snapshotBytes) && snapshotBytes <= sizeBudget) addPass(state, 'state_size_budget', testCase, { state_snapshot_bytes: snapshotBytes, lte: sizeBudget });
    else addFailure(state, 'state_size_budget', testCase, 'state snapshot size budget exceeded', { state_snapshot_bytes: snapshotBytes, lte: sizeBudget });
  } else addGap(state, 'state_size_budget', testCase, 'no state snapshot size budget declared');
}

async function runHookIfPresent(command, phase, state, cwd, timeoutMs) {
  if (!command) return null;
  const capture = await runCommand(command, cwd, timeoutMs);
  state.trace.commands.push({ phase, command, ...commandTail(capture.result) });
  return capture;
}

async function verifyOneCase(goal, goalPath, testCase, cwd = process.cwd()) {
  const state = {
    verifications: [],
    metrics: [],
    counterexample: null,
    trace: { case: testCase, commands: [] },
  };
  addPass(state, 'case_present', testCase);

  const stopOrchestration = await runOrchestration(goal, testCase, state, cwd);
  const resetFixtures = await runFixtureStrategy(goal, testCase, state, cwd);
  try {
    const setup = await runHookIfPresent(testCase.setup_command || goal.verify.setup_command || '', 'setup', state, cwd, testCase.timeout_ms);
    if (setup && setup.result.exitCode !== 0) addFailure(state, 'state_command_success', testCase, 'setup command failed', { phase: 'setup', result: commandTail(setup.result) });

    const before = await runSnapshot(goal, goalPath, testCase, 'before', state, cwd);
    verifyMigrationChecksums(goal, goalPath, testCase, state, cwd);
    await verifyMigrationDrift(goal, testCase, state, cwd);

    let afterMigration = null;
    const migrateCommand = testCase.migration_up_command || testCase.migrate_command || goal.verify.migration_up_command || goal.verify.migrate_command || '';
    if (migrateCommand) {
      const migration = await runCommand(migrateCommand, cwd, testCase.timeout_ms);
      state.metrics.push(migration.result.metrics);
      state.trace.commands.push({ phase: 'migration', command: migrateCommand, ...commandTail(migration.result) });
      writeJson(artifactPath(goalPath, 'migrations', testCase), { command: migrateCommand, result: commandTail(migration.result) });
      afterMigration = await runSnapshot(goal, goalPath, testCase, 'migration-after', state, cwd);
      if (migration.result.exitCode === 0) addPass(state, 'migration_check', testCase);
      else addFailure(state, 'migration_check', testCase, 'migration command failed', { result: commandTail(migration.result) });
      const migrationRollbackCommand = testCase.migration_down_command || testCase.migration_rollback_command || goal.verify.migration_down_command || '';
      if (migrationRollbackCommand && before !== null && before !== undefined) {
        const rollback = await runCommand(migrationRollbackCommand, cwd, testCase.timeout_ms);
        state.metrics.push(rollback.result.metrics);
        state.trace.commands.push({ phase: 'migration_rollback', command: migrationRollbackCommand, ...commandTail(rollback.result) });
        const rollbackSnapshot = await runSnapshot(goal, goalPath, testCase, 'migration-rollback', state, cwd);
        if (rollback.result.exitCode !== 0) addFailure(state, 'migration_check', testCase, 'migration rollback command failed', { result: commandTail(rollback.result) });
        else if (stableStringify(stableCopy(before)) !== stableStringify(stableCopy(rollbackSnapshot))) {
          const diff_path = writeSnapshotDiff(goalPath, testCase, before, rollbackSnapshot, 'migration-rollback');
          addFailure(state, 'migration_check', testCase, 'migration rollback did not restore the original snapshot', { diff_path });
        }
      }
    } else {
      addGap(state, 'migration_check', testCase, 'no migration command declared');
    }

    const command = testCase.transaction_command || testCase.command || goal.verify.command || '';
    const safeToRun = verifyActionSafety(goal, testCase, state);
    if (safeToRun && command) {
      const tx = { ...asObject(goal.verify.transaction, {}), ...testCase.transaction };
      if (tx.begin_command) {
        const begin = await runCommand(tx.begin_command, cwd, testCase.timeout_ms);
        state.trace.commands.push({ phase: 'transaction_begin', command: tx.begin_command, ...commandTail(begin.result) });
        if (begin.result.exitCode !== 0) addFailure(state, 'transaction_rollback', testCase, 'transaction begin command failed', { result: commandTail(begin.result) });
      }
      if (tx.savepoint_command) {
        const savepoint = await runCommand(tx.savepoint_command, cwd, testCase.timeout_ms);
        state.trace.commands.push({ phase: 'transaction_savepoint', command: tx.savepoint_command, ...commandTail(savepoint.result) });
        if (savepoint.result.exitCode !== 0) addFailure(state, 'transaction_rollback', testCase, 'savepoint command failed', { result: commandTail(savepoint.result) });
      }
      const run = await runCommand(command, cwd, testCase.timeout_ms);
      state.metrics.push(run.result.metrics);
      state.metrics.push({ state_command_ms: run.result.metrics && run.result.metrics.wall_time_ms });
      state.trace.commands.push({ phase: testCase.transaction_command ? 'transaction' : 'command', command, ...commandTail(run.result) });
      if (run.result.exitCode === 0) addPass(state, 'state_command_success', testCase);
      else addFailure(state, 'state_command_success', testCase, 'state command failed', { result: commandTail(run.result) });
      if (tx.rollback_to_savepoint_command) {
        const rollbackTo = await runCommand(tx.rollback_to_savepoint_command, cwd, testCase.timeout_ms);
        state.trace.commands.push({ phase: 'transaction_rollback_to_savepoint', command: tx.rollback_to_savepoint_command, ...commandTail(rollbackTo.result) });
        if (rollbackTo.result.exitCode !== 0) addFailure(state, 'transaction_rollback', testCase, 'rollback-to-savepoint command failed', { result: commandTail(rollbackTo.result) });
      }
    } else if (!command && safeToRun) {
      addGap(state, 'state_command_success', testCase, 'no state command declared');
    }

    const after = await runSnapshot(goal, goalPath, testCase, 'after', state, cwd);
    verifyWriteAllowlist(goal, goalPath, testCase, state, before, after);
    verifyTenantIsolation(goal, goalPath, testCase, state, before, after);
    verifyGeneratedTenantMatrix(goal, goalPath, testCase, state, before, after);
    verifyDataInvariants(goal, goalPath, testCase, state, { before, migration: afterMigration, after });
    await verifyQueryLog(goal, goalPath, testCase, state, cwd, before, after);

    const rollbackCommand = testCase.rollback_command || goal.verify.rollback_command || '';
    if (rollbackCommand && before !== null && before !== undefined) {
      const rollback = await runCommand(rollbackCommand, cwd, testCase.timeout_ms);
      state.metrics.push(rollback.result.metrics);
      state.trace.commands.push({ phase: 'rollback', command: rollbackCommand, ...commandTail(rollback.result) });
      const rollbackSnapshot = await runSnapshot(goal, goalPath, testCase, 'rollback', state, cwd);
      if (rollback.result.exitCode !== 0) addFailure(state, 'transaction_rollback', testCase, 'rollback command failed', { result: commandTail(rollback.result) });
      else if (testCase.expect_rollback_unchanged && stableStringify(stableCopy(before)) === stableStringify(stableCopy(rollbackSnapshot))) {
        addPass(state, 'transaction_rollback', testCase, { rollback_snapshot_path: snapshotPath(goalPath, 'rollback', testCase) });
      } else if (testCase.expect_rollback_unchanged) {
        const diff_path = writeSnapshotDiff(goalPath, testCase, before, rollbackSnapshot, 'transaction-rollback');
        addFailure(state, 'transaction_rollback', testCase, 'rollback did not restore the original snapshot', { diff_path });
      } else {
        addPass(state, 'transaction_rollback', testCase);
      }
    } else {
      addGap(state, 'transaction_rollback', testCase, 'no rollback command declared');
    }

    verifyBudgets(goal, testCase, state);

    const teardown = await runHookIfPresent(testCase.teardown_command || goal.verify.teardown_command || '', 'teardown', state, cwd, testCase.timeout_ms);
    if (teardown && teardown.result.exitCode !== 0) addFailure(state, 'state_command_success', testCase, 'teardown command failed', { phase: 'teardown', result: commandTail(teardown.result) });
  } finally {
    await resetFixtures();
    await stopOrchestration();
  }

  writeJson(artifactPath(goalPath, 'traces', testCase), state.trace);
  return state;
}

function aggregateMetrics(samples) {
  const byName = {};
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value)) continue;
      const metricName = key === 'wall_time_ms' ? 'state_command_ms' : key;
      if (!byName[metricName]) byName[metricName] = [];
      byName[metricName].push(value);
    }
  }
  const out = {};
  for (const [key, values] of Object.entries(byName)) {
    const sorted = values.sort((a, b) => a - b);
    out[key] = sorted[Math.floor(sorted.length / 2)];
    out[`${key}_p95`] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
  return out;
}

async function runStateSuiteVerification(goal, goalPath, options = {}) {
  const caseFiles = expandSimpleJsonGlob(goalPath, goal.verify.cases, options.cwd || process.cwd());
  const cases = caseFiles.map(loadCaseFile);
  const selectedCases = options.caseId ? cases.filter((testCase) => testCase.id === options.caseId) : cases;
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
  for (const testCase of selectedCases) {
    const result = await verifyOneCase(goal, goalPath, testCase, options.cwd || process.cwd());
    verifications.push(...result.verifications);
    metrics.push(...result.metrics);
    if (result.counterexample && !counterexample) counterexample = result.counterexample;
  }
  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: aggregateMetrics(metrics),
    counterexample,
  };
}

function writeSnapshotHelper(goalDir) {
  fs.writeFileSync(path.join(goalDir, 'snapshot-state.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const candidates = [",
    "  process.env.XOLOOP_STATE_SNAPSHOT_FILE,",
    "  path.resolve(process.cwd(), 'state.json'),",
    "  path.resolve(process.cwd(), 'db.json'),",
    "].filter(Boolean);",
    "for (const file of candidates) {",
    "  if (fs.existsSync(file)) {",
    "    process.stdout.write(fs.readFileSync(file, 'utf8'));",
    "    process.exit(0);",
    "  }",
    "}",
    "process.stdout.write('{}\\n');",
    '',
  ].join('\n'), 'utf8');
}

function writeDbAdapterHelper(goalDir) {
  fs.mkdirSync(path.join(goalDir, 'adapters'), { recursive: true });
  fs.writeFileSync(path.join(goalDir, 'adapters', 'README.md'), [
    '# Native DB adapters',
    '',
    'State-suite can snapshot real databases through native CLIs when a case',
    'declares `adapter.kind` as `postgres`, `mysql`, `sqlite`, or `redis`.',
    '',
    'Adapters intentionally use local tools (`psql`, `mysql`, `sqlite3`,',
    '`redis-cli`) instead of bundled drivers so Verify remains language-neutral.',
    '',
    'Example:',
    '',
    '```json',
    '{',
    '  "adapter": {',
    '    "kind": "postgres",',
    '    "url": "$DATABASE_URL",',
    '    "tables": [{ "name": "users", "primary_key": "id" }]',
    '  }',
    '}',
    '```',
    '',
  ].join('\n'), 'utf8');
}

function writeStateSuiteAssets(goalDir, options = {}) {
  for (const dir of ['cases', 'snapshots/before', 'snapshots/after', 'snapshots/rollback', 'snapshots/migration-after', 'snapshots/migration-rollback', 'diffs', 'traces', 'migrations', 'invariants', 'adapters', 'fixtures', 'logs', 'orchestration']) {
    fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  }
  writeSnapshotHelper(goalDir);
  writeDbAdapterHelper(goalDir);
  writeJson(path.join(goalDir, 'invariants', 'default.json'), {
    invariants: [
      { id: 'state-root-object', path: '', type: 'object' },
    ],
  });
  writeJson(path.join(goalDir, 'cases', 'state-smoke.json'), {
    id: 'state-smoke',
    command: 'node -e "process.exit(0)"',
    snapshot_command: `node ${JSON.stringify(path.join('.xoloop', 'goals', options.goalId || 'state-suite', 'snapshot-state.cjs'))}`,
    invariants_file: 'invariants/default.json',
    allowed_writes: [],
    expect_no_changes: true,
    tenant_isolation: [],
    metadata: {
      note: 'Replace this smoke case with DB-backed commands before optimizing stateful code.',
    },
  });
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# Database/state verification goal',
    '',
    'Generated by `xoloop-verify create --kind state-suite`.',
    '',
    'Cases declare native DB adapters or snapshot commands,',
    'orchestration commands, fixture seed/reset strategies,',
    'migration up/down/checksum/drift checks, data invariants,',
    'allowed writes, query logs, redaction masks, performance budgets,',
    'and tenant isolation rules. Verify stores before/after/rollback',
    'snapshots, diffs, migration records, and command traces here.',
    '',
  ].join('\n'), 'utf8');
}

function buildStateSuiteGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'state-suite';
  const scan = options.scan || scanStateRepo(cwd);
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve database/state semantics, migration safety, invariants, rollback behavior, tenant isolation, and write boundaries while optimizing.',
    interface: {
      type: 'state',
      command: options.command || 'xoloop state verification harness',
      stdin: 'none',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: scan.artifact_paths || [],
    },
    verify: {
      kind: 'state-suite',
      cases: 'cases/*.json',
      properties: DEFAULT_STATE_OBLIGATIONS,
      snapshot_command: `node ${JSON.stringify(path.join('.xoloop', 'goals', goalId, 'snapshot-state.cjs'))}`,
      adapters: scan.adapters || [],
      orchestration: {
        ...(scan.orchestration || {}),
        start_command: (scan.orchestration || {}).suggested_start_command || '',
        ready_command: (scan.orchestration || {}).suggested_ready_command || '',
        stop_command: (scan.orchestration || {}).suggested_stop_command || '',
        auto_start: Boolean((scan.orchestration || {}).suggested_start_command),
      },
      snapshot: {
        redactions: [
          { match_key: 'password|secret|token|credential|email|phone|ssn|card', replacement: '<redacted>' },
        ],
      },
      scan,
      block_on_gaps: true,
      action_policy: 'block-destructive',
      fixture: {
        seed_command: ((scan.safe_commands || []).find((command) => command.kind === 'seed') || {}).command || '',
        reset_command: ((scan.safe_commands || []).find((command) => command.kind === 'reset') || {}).command || '',
        reset_after: true,
      },
      query_log: {},
      tenant_matrix: {
        generate: true,
      },
      budgets: {
        state_command_ms_lte: 10000,
        state_snapshot_bytes_lte: 50 * 1024 * 1024,
      },
      allowed_writes: [],
      forbidden_writes: [],
      tenant_isolation: [],
      invariants_file: 'invariants/default.json',
    },
    metrics: {
      repeat: 3,
      targets: [
        { name: 'state_command_ms', direction: 'minimize', threshold: 0.03 },
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
  DEFAULT_STATE_OBLIGATIONS,
  buildStateSuiteGoal,
  runStateSuiteVerification,
  scanStateRepo,
  writeStateSuiteAssets,
};
