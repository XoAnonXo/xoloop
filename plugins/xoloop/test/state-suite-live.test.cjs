'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runCliCommand } = require('../lib/goal_cli_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');
const { runGoalVerify } = require('../lib/goal_verify_runner.cjs');

const RUN_LIVE = process.env.XOLOOP_RUN_STATE_LIVE_E2E === '1';

function tmpDir(prefix = 'xoloop-state-live-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function hasCommand(name) {
  const result = require('node:child_process').spawnSync('bash', ['-lc', `command -v ${name}`], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function dockerAvailable() {
  const result = require('node:child_process').spawnSync('docker', ['info'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return result.status === 0;
}

function liveSkip(requirement) {
  if (!RUN_LIVE) return 'set XOLOOP_RUN_STATE_LIVE_E2E=1 to run live database integration tests';
  if (requirement === 'sqlite3' && !hasCommand('sqlite3')) return 'sqlite3 is not installed';
  if (requirement === 'docker' && (!hasCommand('docker') || !dockerAvailable())) return 'Docker is not available';
  return false;
}

async function runShell(command, cwd, timeoutMs = 120000) {
  const result = await runCliCommand(command, '', { cwd, timeoutMs });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error([
      `command failed: ${command}`,
      `exit=${result.exitCode} timed_out=${result.timedOut}`,
      String(result.stdout || '').slice(-1200),
      String(result.stderr || '').slice(-1200),
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(command, cwd, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await runCliCommand(command, '', { cwd, timeoutMs: 10000 });
    if (last.exitCode === 0 && !last.timedOut) return last;
    await sleep(1000);
  }
  throw new Error([
    `timed out waiting for: ${command}`,
    last ? String(last.stdout || '').slice(-1200) : '',
    last ? String(last.stderr || '').slice(-1200) : '',
  ].filter(Boolean).join('\n'));
}

function writeLiveGoal(cwd, goalId, cases, properties) {
  const goalDir = path.join(cwd, '.xoloop', 'goals', goalId);
  for (const item of cases) {
    writeJson(path.join(goalDir, 'cases', `${item.id}.json`), item);
  }
  const goalPath = path.join(goalDir, 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: goalId,
    objective: 'Verify a live database adapter end to end.',
    interface: {
      type: 'state',
      command: 'live state adapter harness',
      stdin: 'none',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: { paths: [] },
    verify: {
      kind: 'state-suite',
      cases: 'cases/*.json',
      properties,
      block_on_gaps: true,
      action_policy: 'block-destructive',
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'state_command_ms', direction: 'minimize', threshold: 0 },
        { name: 'state_snapshot_bytes', direction: 'minimize', threshold: 0 },
      ],
    },
  });
  return goalPath;
}

function coreAdapterProperties(extra = []) {
  return [
    'case_present',
    'native_adapters',
    'snapshot_before',
    'snapshot_after',
    'canonical_snapshot',
    'redaction_masks',
    'state_command_success',
    'action_safety',
    'query_log',
    'write_allowlist',
    'unexpected_writes',
    'performance_budget',
    'state_size_budget',
    ...extra,
  ];
}

test('state-suite live SQLite adapter snapshots a real database through sqlite3', {
  skip: liveSkip('sqlite3'),
  timeout: 90000,
}, async () => {
  const cwd = tmpDir();
  await runShell([
    'sqlite3 state.sqlite',
    '"CREATE TABLE users(id INTEGER PRIMARY KEY, tenant_id TEXT, email TEXT);',
    'INSERT INTO users VALUES (2, \'b\', \'b@example.com\');',
    'INSERT INTO users VALUES (1, \'a\', \'a@example.com\');"',
  ].join(' '), cwd);
  writeJson(path.join(cwd, 'queries.json'), []);
  const goalPath = writeLiveGoal(cwd, 'sqlite-live', [{
    id: 'sqlite-live',
    command: 'node -e "process.exit(0)"',
    adapter: {
      kind: 'sqlite',
      database: 'state.sqlite',
      tables: [{ name: 'users', primary_key: 'id' }],
    },
    snapshot: {
      schema: {
        users: { primary_key: 'id', redacted_columns: ['email'] },
      },
    },
    query_log_file: 'queries.json',
    query_log: { require_logged_writes: false },
    allowed_writes: [],
    expect_no_changes: true,
    budgets: {
      state_command_ms_lte: 5000,
      state_snapshot_bytes_lte: 4096,
    },
  }], coreAdapterProperties());

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.failed, 0);
  assert.deepEqual(card.missing_obligations, []);
  const before = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'sqlite-live', 'snapshots', 'before', 'sqlite-live.json'), 'utf8'));
  assert.deepEqual(before.users.map((row) => row.id), [1, 2]);
  assert.equal(before.users[0].email, '<redacted>');
});

test('state-suite live Postgres adapter snapshots a Docker-backed database through psql', {
  skip: liveSkip('docker'),
  timeout: 240000,
}, async () => {
  const cwd = tmpDir();
  const name = `xoloop-pg-${process.pid}-${Date.now()}`;
  await runShell(`docker run -d --rm --name ${name} -e POSTGRES_PASSWORD=xoloop -e POSTGRES_DB=xoloop postgres:16-alpine`, cwd, 180000);
  try {
    await waitFor(`docker exec ${name} pg_isready -U postgres -d xoloop`, cwd, 120000);
    await runShell(`docker exec ${name} psql -U postgres -d xoloop -c "CREATE TABLE users(id int primary key, tenant_id text, email text); INSERT INTO users VALUES (2, 'b', 'b@example.com'), (1, 'a', 'a@example.com');"`, cwd);
    writeJson(path.join(cwd, 'queries.json'), []);
    const goalPath = writeLiveGoal(cwd, 'postgres-live', [{
      id: 'postgres-live',
      command: `docker exec ${name} psql -U postgres -d xoloop -c "SELECT 1"`,
      adapter: {
        kind: 'postgres',
        cli: `docker exec ${name} psql -U postgres -d xoloop`,
        tables: [{ name: 'users', primary_key: 'id' }],
      },
      snapshot: {
        schema: {
          users: { primary_key: 'id', redacted_columns: ['email'] },
        },
      },
      query_log_file: 'queries.json',
      query_log: { require_logged_writes: false },
      allowed_writes: [],
      expect_no_changes: true,
      budgets: {
        state_command_ms_lte: 10000,
        state_snapshot_bytes_lte: 4096,
      },
    }], coreAdapterProperties());

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'PASS_EVIDENCED');
    assert.equal(card.summary.failed, 0);
    assert.deepEqual(card.missing_obligations, []);
  } finally {
    await runCliCommand(`docker rm -f ${name}`, '', { cwd, timeoutMs: 30000 });
  }
});

test('state-suite live MySQL adapter snapshots a Docker-backed database through mysql', {
  skip: liveSkip('docker'),
  timeout: 300000,
}, async () => {
  const cwd = tmpDir();
  const name = `xoloop-mysql-${process.pid}-${Date.now()}`;
  await runShell(`docker run -d --rm --name ${name} -e MYSQL_ROOT_PASSWORD=xoloop -e MYSQL_DATABASE=xoloop mysql:8`, cwd, 240000);
  try {
    await waitFor(`docker exec ${name} mysqladmin ping -uroot -pxoloop --silent`, cwd, 180000);
    await runShell(`docker exec ${name} mysql -uroot -pxoloop xoloop -e "CREATE TABLE users(id int primary key, tenant_id varchar(16), email varchar(255)); INSERT INTO users VALUES (2, 'b', 'b@example.com'), (1, 'a', 'a@example.com');"`, cwd);
    writeJson(path.join(cwd, 'queries.json'), []);
    const goalPath = writeLiveGoal(cwd, 'mysql-live', [{
      id: 'mysql-live',
      command: `docker exec ${name} mysql -uroot -pxoloop xoloop -e "SELECT 1"`,
      adapter: {
        kind: 'mysql',
        cli: `docker exec ${name} mysql -uroot -pxoloop xoloop`,
        tables: [{ name: 'users', primary_key: 'id' }],
      },
      snapshot: {
        schema: {
          users: { primary_key: 'id', redacted_columns: ['email'] },
        },
      },
      query_log_file: 'queries.json',
      query_log: { require_logged_writes: false },
      allowed_writes: [],
      expect_no_changes: true,
      budgets: {
        state_command_ms_lte: 10000,
        state_snapshot_bytes_lte: 4096,
      },
    }], coreAdapterProperties());

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'PASS_EVIDENCED');
    assert.equal(card.summary.failed, 0);
    assert.deepEqual(card.missing_obligations, []);
  } finally {
    await runCliCommand(`docker rm -f ${name}`, '', { cwd, timeoutMs: 30000 });
  }
});

test('state-suite live Redis adapter snapshots a Docker-backed cache through redis-cli', {
  skip: liveSkip('docker'),
  timeout: 180000,
}, async () => {
  const cwd = tmpDir();
  const name = `xoloop-redis-${process.pid}-${Date.now()}`;
  await runShell(`docker run -d --rm --name ${name} redis:7-alpine`, cwd, 120000);
  try {
    await waitFor(`docker exec ${name} redis-cli ping`, cwd, 90000);
    await runShell(`docker exec ${name} redis-cli SET session:1 active`, cwd);
    writeJson(path.join(cwd, 'queries.json'), []);
    const goalPath = writeLiveGoal(cwd, 'redis-live', [{
      id: 'redis-live',
      command: `docker exec ${name} redis-cli PING`,
      adapter: {
        kind: 'redis',
        cli: `docker exec ${name} redis-cli`,
      },
      redactions: [
        { path: 'redis.session:1', replacement: '<session>' },
      ],
      query_log_file: 'queries.json',
      query_log: { require_logged_writes: false },
      allowed_writes: [],
      expect_no_changes: true,
      budgets: {
        state_command_ms_lte: 10000,
        state_snapshot_bytes_lte: 4096,
      },
    }], coreAdapterProperties());

    const { card } = await runGoalVerify(goalPath, { cwd });

    assert.equal(card.verdict, 'PASS_EVIDENCED');
    assert.equal(card.summary.failed, 0);
    assert.deepEqual(card.missing_obligations, []);
  } finally {
    await runCliCommand(`docker rm -f ${name}`, '', { cwd, timeoutMs: 30000 });
  }
});
