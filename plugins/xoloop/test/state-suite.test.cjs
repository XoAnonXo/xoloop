'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  runGoalVerify,
  scanStateRepo,
} = require('../lib/goal_verify_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-state-suite-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeScript(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
}

function seedState(cwd) {
  const initial = {
    users: [
      { id: 1, tenant_id: 'a', email: 'a@example.com' },
      { id: 2, tenant_id: 'b', email: 'b@example.com' },
    ],
    accounts: [
      { id: 1, tenant_id: 'a', balance: 5 },
      { id: 2, tenant_id: 'b', balance: 7 },
    ],
    audit: [],
  };
  writeJson(path.join(cwd, 'db.initial.json'), initial);
  writeJson(path.join(cwd, 'db.json'), initial);
  writeScript(path.join(cwd, 'snapshot.cjs'), "process.stdout.write(require('fs').readFileSync('db.json', 'utf8'));\n");
  writeScript(path.join(cwd, 'rollback.cjs'), "require('fs').copyFileSync('db.initial.json', 'db.json');\n");
  writeScript(path.join(cwd, 'migrate.cjs'), "const fs = require('fs'); JSON.parse(fs.readFileSync('db.json', 'utf8')); process.exit(0);\n");
}

function writeStateGoal(cwd, options = {}) {
  const goalId = options.goalId || 'state';
  const goalPath = path.join(cwd, '.xoloop', 'goals', goalId, 'goal.yaml');
  const casePayload = {
    id: options.caseId || 'state-case',
    command: options.command || 'node mutate.cjs',
    snapshot_command: 'node snapshot.cjs',
    rollback_command: Object.prototype.hasOwnProperty.call(options, 'rollbackCommand') ? options.rollbackCommand : 'node rollback.cjs',
    migrate_command: Object.prototype.hasOwnProperty.call(options, 'migrateCommand') ? options.migrateCommand : 'node migrate.cjs',
    allowed_writes: Object.prototype.hasOwnProperty.call(options, 'allowedWrites') ? options.allowedWrites : ['audit'],
    forbidden_writes: options.forbiddenWrites || [],
    invariants: Object.prototype.hasOwnProperty.call(options, 'invariants') ? options.invariants : [
      { id: 'users-unique-id', path: 'users', unique_by: 'id' },
      { id: 'accounts-non-negative', path: 'accounts.*.balance', gte: 0 },
    ],
    tenant_isolation: Object.prototype.hasOwnProperty.call(options, 'tenantIsolation') ? options.tenantIsolation : [
      { path: 'users', primary_key: 'id', tenant_field: 'tenant_id', allowed_tenants: ['a'] },
    ],
    ...(options.caseExtra || {}),
  };
  writeJson(path.join(cwd, '.xoloop', 'goals', goalId, 'cases', 'state-case.json'), casePayload);
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: goalId,
    objective: 'Verify database state.',
    interface: {
      type: 'state',
      command: 'state verification harness',
      stdin: 'none',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: ['db.json'],
    },
    verify: {
      kind: 'state-suite',
      cases: 'cases/*.json',
      properties: options.properties || [
        'case_present',
        'snapshot_before',
        'snapshot_after',
        'state_command_success',
        'migration_check',
        'data_invariants',
        'transaction_rollback',
        'tenant_isolation',
        'write_allowlist',
        'unexpected_writes',
      ],
      block_on_gaps: true,
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'state_command_ms', direction: 'minimize', threshold: 0 },
      ],
    },
  });
  return goalPath;
}

test('state scan detects DB tools, migrations, schemas, and snapshot scripts', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      'db:migrate': 'prisma migrate deploy',
      'db:rollback': 'node rollback.cjs',
      'db:snapshot': 'node snapshot.cjs',
    },
    dependencies: {
      '@prisma/client': '^5.0.0',
      pg: '^8.0.0',
      mysql2: '^3.0.0',
      'better-sqlite3': '^11.0.0',
      ioredis: '^5.0.0',
    },
  });
  fs.writeFileSync(path.join(cwd, 'docker-compose.yml'), 'services:\n  postgres:\n    image: postgres\n  redis:\n    image: redis\n', 'utf8');
  fs.mkdirSync(path.join(cwd, 'prisma', 'migrations', '20260505000000_init'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'prisma', 'schema.prisma'), 'model User { id Int @id tenantId String }\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'prisma', 'migrations', '20260505000000_init', 'migration.sql'), 'CREATE TABLE users(id int);\n', 'utf8');
  fs.mkdirSync(path.join(cwd, 'src', 'models'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'models', 'user.ts'), 'export const tenant_id = "tenant_id";\n', 'utf8');

  const scan = scanStateRepo(cwd);

  assert.ok(scan.tools.some((tool) => tool.name === 'prisma'));
  assert.ok(scan.migration_files.some((file) => file.endsWith('migration.sql')));
  assert.ok(scan.schema_files.includes('prisma/schema.prisma'));
  assert.ok(scan.safe_commands.some((command) => command.kind === 'snapshot'));
  assert.ok(scan.safe_commands.some((command) => command.kind === 'rollback'));
  assert.ok(scan.adapters.some((adapter) => adapter.kind === 'postgres'));
  assert.ok(scan.adapters.some((adapter) => adapter.kind === 'mysql'));
  assert.ok(scan.adapters.some((adapter) => adapter.kind === 'sqlite'));
  assert.ok(scan.adapters.some((adapter) => adapter.kind === 'redis'));
  assert.deepEqual(scan.orchestration.services, ['postgres', 'redis']);
  assert.match(scan.orchestration.suggested_start_command, /docker compose -f docker-compose.yml up -d/);
  assert.match(scan.orchestration.suggested_ready_command, /docker compose -f docker-compose.yml ps/);
});

test('state-suite create writes harness assets and manifest', () => {
  const cwd = tmpDir();

  const created = createGoal({ cwd, kind: 'state-suite', goalId: 'state-suite', force: true });

  assert.equal(created.goal.verify.kind, 'state-suite');
  assert.equal(created.goal.interface.type, 'state');
  for (const dir of ['cases', 'snapshots/before', 'snapshots/after', 'snapshots/rollback', 'diffs', 'traces', 'migrations', 'invariants']) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'state-suite', dir)), true);
  }
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'state-suite', 'snapshot-state.cjs')), true);
});

test('state-suite runs native Postgres/MySQL/SQLite/Redis adapter snapshots through local CLIs', async () => {
  const cwd = tmpDir();
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cli = [
    '#!/usr/bin/env node',
    "const path = require('path');",
    'const name = path.basename(process.argv[1]);',
    'const args = process.argv.slice(2).join(" ");',
    "if (name === 'psql') process.stdout.write('[{\"id\":2,\"name\":\"B\"},{\"id\":1,\"name\":\"A\"}]\\n');",
    "else if (name === 'mysql') process.stdout.write('id\\tname\\n1\\tA\\n2\\tB\\n');",
    "else if (name === 'sqlite3') process.stdout.write('[{\"id\":1,\"name\":\"A\"},{\"id\":2,\"name\":\"B\"}]\\n');",
    "else if (name === 'redis-cli' && args.includes('--scan')) process.stdout.write('session:1\\n');",
    "else if (name === 'redis-cli' && args.includes(' TYPE ')) process.stdout.write('string\\n');",
    "else if (name === 'redis-cli' && args.includes(' GET ')) process.stdout.write('active\\n');",
    'else process.exit(2);',
    '',
  ].join('\n');
  for (const name of ['psql', 'mysql', 'sqlite3', 'redis-cli']) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, cli, 'utf8');
    fs.chmodSync(file, 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  const goalPath = path.join(cwd, '.xoloop', 'goals', 'adapters', 'goal.yaml');
  for (const item of [
    { id: 'pg', adapter: { kind: 'postgres', cli: path.join(bin, 'psql'), tables: [{ name: 'users', primary_key: 'id' }] } },
    { id: 'mysql', adapter: { kind: 'mysql', cli: path.join(bin, 'mysql'), tables: [{ name: 'users', primary_key: 'id' }] } },
    { id: 'sqlite', adapter: { kind: 'sqlite', cli: path.join(bin, 'sqlite3'), database: 'state.sqlite', tables: [{ name: 'users', primary_key: 'id' }] } },
    { id: 'redis', adapter: { kind: 'redis', cli: path.join(bin, 'redis-cli') } },
  ]) {
    writeJson(path.join(cwd, '.xoloop', 'goals', 'adapters', 'cases', `${item.id}.json`), {
      id: item.id,
      adapter: item.adapter,
      allowed_writes: [],
      expect_no_changes: true,
    });
  }
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'adapters',
    objective: 'Verify native DB adapters.',
    interface: { type: 'state', command: 'adapter harness', stdin: 'none', stdout: 'json', timeout_ms: 30000 },
    artifacts: { paths: [] },
    verify: {
      kind: 'state-suite',
      cases: 'cases/*.json',
      properties: ['case_present', 'native_adapters', 'snapshot_before', 'snapshot_after', 'canonical_snapshot', 'write_allowlist', 'unexpected_writes'],
    },
  });
  try {
    const { card } = await runGoalVerify(goalPath, { cwd });
    assert.equal(card.verdict, 'PASS_EVIDENCED');
    assert.equal(card.summary.failed, 0);
    assert.equal(card.summary.by_id.native_adapters.passed, 4);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('state-suite canonical snapshots apply schema redaction and size/performance budgets', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), [
    "const fs = require('fs');",
    "const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));",
    "db.users.reverse();",
    "db.users[0].email = 'new-secret@example.com';",
    "fs.writeFileSync('db.json', JSON.stringify(db));",
    '',
  ].join('\n'));
  const goalPath = writeStateGoal(cwd, {
    allowedWrites: [],
    rollbackCommand: '',
    migrateCommand: '',
    tenantIsolation: [],
    invariants: [],
    properties: [
      'case_present',
      'snapshot_before',
      'snapshot_after',
      'canonical_snapshot',
      'redaction_masks',
      'state_command_success',
      'action_safety',
      'write_allowlist',
      'unexpected_writes',
      'performance_budget',
      'state_size_budget',
    ],
    caseExtra: {
      snapshot: {
        schema: {
          users: { primary_key: 'id', redacted_columns: ['email'] },
        },
      },
      budgets: {
        state_command_ms_lte: 10000,
        state_snapshot_bytes_lte: 10000,
      },
    },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.by_id.redaction_masks.passed, 1);
  assert.equal(card.summary.by_id.performance_budget.passed, 1);
  assert.equal(card.summary.by_id.state_size_budget.passed, 1);
});

test('state-suite generated smoke harness runs as PASS_WITH_GAPS, not FAIL', async () => {
  const cwd = tmpDir();
  const created = createGoal({ cwd, kind: 'state-suite', goalId: 'state-suite', force: true });

  const { card } = await runGoalVerify(created.goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.equal(card.summary.failed, 0);
  assert.ok(card.missing_obligations.includes('migration_check'));
  assert.ok(card.missing_obligations.includes('tenant_isolation'));
  assert.ok(card.missing_obligations.includes('transaction_rollback'));
});

test('state-suite reaches PASS_EVIDENCED for allowed writes, invariants, migration, tenant isolation, and rollback', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), [
    "const fs = require('fs');",
    "const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));",
    "db.audit.push({ id: 1, tenant_id: 'a', action: 'read' });",
    "fs.writeFileSync('db.json', JSON.stringify(db));",
    '',
  ].join('\n'));
  const goalPath = writeStateGoal(cwd);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.deepEqual(card.missing_obligations, []);
  assert.equal(card.summary.failed, 0);
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'state', 'snapshots', 'before', 'state-case.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'state', 'snapshots', 'after', 'state-case.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'state', 'traces', 'state-case.json')));
});

test('state-suite fails when writes escape the allowlist', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), [
    "const fs = require('fs');",
    "const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));",
    "db.audit.push({ id: 1, tenant_id: 'a', action: 'write' });",
    "db.users[0].email = 'changed@example.com';",
    "fs.writeFileSync('db.json', JSON.stringify(db));",
    '',
  ].join('\n'));
  const goalPath = writeStateGoal(cwd, { allowedWrites: ['audit'] });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'unexpected_writes');
  assert.ok(card.counterexample.diff_path);
  assert.equal(fs.existsSync(card.counterexample.diff_path), true);
  assert.match(card.replay, /--case state-case/);
});

test('state-suite fails when data invariants are violated', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), [
    "const fs = require('fs');",
    "const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));",
    "db.accounts[0].balance = -1;",
    "fs.writeFileSync('db.json', JSON.stringify(db));",
    '',
  ].join('\n'));
  const goalPath = writeStateGoal(cwd, { allowedWrites: ['accounts'] });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'data_invariants');
  assert.ok(card.counterexample.diff_path);
});

test('state-suite fails when rollback does not restore the before snapshot', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), [
    "const fs = require('fs');",
    "const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));",
    "db.audit.push({ id: 1, tenant_id: 'a', action: 'write' });",
    "fs.writeFileSync('db.json', JSON.stringify(db));",
    '',
  ].join('\n'));
  writeScript(path.join(cwd, 'bad-rollback.cjs'), 'process.exit(0);\n');
  const goalPath = writeStateGoal(cwd, { rollbackCommand: 'node bad-rollback.cjs' });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'transaction_rollback');
  assert.ok(card.counterexample.diff_path);
});

test('state-suite fails when a command mutates another tenant', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), [
    "const fs = require('fs');",
    "const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));",
    "db.users[1].email = 'cross-tenant@example.com';",
    "fs.writeFileSync('db.json', JSON.stringify(db));",
    '',
  ].join('\n'));
  const goalPath = writeStateGoal(cwd, { allowedWrites: ['users'] });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'tenant_isolation');
  assert.ok(card.counterexample.diff_path);
});

test('state-suite generated tenant matrix catches cross-tenant mutation without declared rules', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), [
    "const fs = require('fs');",
    "const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));",
    "db.users[1].email = 'generated-matrix@example.com';",
    "fs.writeFileSync('db.json', JSON.stringify(db));",
    '',
  ].join('\n'));
  const goalPath = writeStateGoal(cwd, {
    allowedWrites: ['users'],
    rollbackCommand: '',
    migrateCommand: '',
    tenantIsolation: [],
    properties: [
      'case_present',
      'snapshot_before',
      'snapshot_after',
      'state_command_success',
      'action_safety',
      'generated_tenant_matrix',
      'write_allowlist',
      'unexpected_writes',
    ],
    caseExtra: {
      tenant_matrix: { generate: true, allowed_tenants: ['a'] },
    },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.ok(['tenant_isolation', 'generated_tenant_matrix'].includes(card.counterexample.obligation));
});

test('state-suite action safety blocks destructive or sensitive commands before execution', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'delete-user.cjs'), "require('fs').writeFileSync('executed.txt', 'bad');\n");
  const goalPath = writeStateGoal(cwd, {
    command: 'node delete-user.cjs',
    rollbackCommand: '',
    migrateCommand: '',
    allowedWrites: [],
    tenantIsolation: [],
    invariants: [],
    properties: [
      'case_present',
      'snapshot_before',
      'snapshot_after',
      'action_safety',
    ],
    caseExtra: {
      action: { kind: 'delete-user' },
    },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'action_safety');
  assert.equal(fs.existsSync(path.join(cwd, 'executed.txt')), false);
});

test('state-suite verifies query-log writes and fails on unlogged state changes', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), [
    "const fs = require('fs');",
    "const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));",
    "db.users[0].email = 'logged@example.com';",
    "fs.writeFileSync('db.json', JSON.stringify(db));",
    '',
  ].join('\n'));
  writeJson(path.join(cwd, 'queries.json'), []);
  const goalPath = writeStateGoal(cwd, {
    allowedWrites: ['users'],
    rollbackCommand: '',
    migrateCommand: '',
    tenantIsolation: [],
    invariants: [],
    properties: [
      'case_present',
      'snapshot_before',
      'snapshot_after',
      'state_command_success',
      'query_log',
      'write_allowlist',
      'unexpected_writes',
    ],
    caseExtra: {
      query_log_file: 'queries.json',
      query_log: { require_logged_writes: true },
    },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'query_log');
  assert.ok(card.counterexample.diff_path);
});

test('state-suite verifies migration checksums and drift commands', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  fs.mkdirSync(path.join(cwd, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'migrations', '001.sql'), 'CREATE TABLE users(id int);\n', 'utf8');
  writeScript(path.join(cwd, 'mutate.cjs'), 'process.exit(0);\n');
  writeScript(path.join(cwd, 'drift.cjs'), 'process.exit(0);\n');
  const goalPath = writeStateGoal(cwd, {
    rollbackCommand: '',
    migrateCommand: '',
    allowedWrites: [],
    tenantIsolation: [],
    invariants: [],
    properties: [
      'case_present',
      'snapshot_before',
      'snapshot_after',
      'state_command_success',
      'migration_checksum',
      'migration_drift',
    ],
    caseExtra: {
      migration_files: ['migrations/001.sql'],
      migration_checksum_file: 'migrations/expected-checksums.json',
      migration_drift_command: 'node drift.cjs',
    },
  });
  writeJson(path.join(path.dirname(goalPath), 'migrations', 'expected-checksums.json'), {
    'migrations/001.sql': 'wrong',
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'migration_checksum');
  assert.ok(card.summary.by_id.migration_drift.passed > 0);
});

test('state-suite runs orchestration and fixture seed/reset strategies', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'start.cjs'), "require('fs').writeFileSync('started.txt', '1');\n");
  writeScript(path.join(cwd, 'ready.cjs'), "process.exit(require('fs').existsSync('started.txt') ? 0 : 1);\n");
  writeScript(path.join(cwd, 'stop.cjs'), "require('fs').writeFileSync('stopped.txt', '1');\n");
  writeScript(path.join(cwd, 'seed.cjs'), "require('fs').writeFileSync('seeded.txt', '1');\n");
  writeScript(path.join(cwd, 'reset.cjs'), "require('fs').writeFileSync('reset.txt', (require('fs').existsSync('reset.txt') ? require('fs').readFileSync('reset.txt', 'utf8') : '') + 'r');\n");
  writeScript(path.join(cwd, 'mutate.cjs'), 'process.exit(0);\n');
  const goalPath = writeStateGoal(cwd, {
    rollbackCommand: '',
    migrateCommand: '',
    allowedWrites: [],
    tenantIsolation: [],
    invariants: [],
    properties: [
      'case_present',
      'snapshot_before',
      'snapshot_after',
      'state_command_success',
      'orchestration',
      'fixture_strategy',
    ],
    caseExtra: {
      orchestration: {
        auto_start: true,
        start_command: 'node start.cjs',
        ready_command: 'node ready.cjs',
        stop_command: 'node stop.cjs',
      },
      fixture: {
        seed_command: 'node seed.cjs',
        reset_command: 'node reset.cjs',
        reset_after: true,
      },
    },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(fs.existsSync(path.join(cwd, 'started.txt')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'stopped.txt')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'seeded.txt')), true);
  assert.match(fs.readFileSync(path.join(cwd, 'reset.txt'), 'utf8'), /rr/);
});

test('state-suite reports PASS_WITH_GAPS when conservative state surfaces are undeclared', async () => {
  const cwd = tmpDir();
  seedState(cwd);
  writeScript(path.join(cwd, 'mutate.cjs'), 'process.exit(0);\n');
  const goalPath = writeStateGoal(cwd, {
    migrateCommand: '',
    rollbackCommand: '',
    allowedWrites: undefined,
    invariants: [],
    tenantIsolation: [],
    properties: [
      'case_present',
      'snapshot_before',
      'snapshot_after',
      'state_command_success',
      'migration_check',
      'data_invariants',
      'transaction_rollback',
      'tenant_isolation',
      'write_allowlist',
      'unexpected_writes',
    ],
  });
  const manifest = JSON.parse(fs.readFileSync(goalPath, 'utf8'));
  delete manifest.verify.allowed_writes;
  writeGoalManifest(goalPath, manifest);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.ok(card.missing_obligations.includes('migration_check'));
  assert.ok(card.missing_obligations.includes('data_invariants'));
  assert.ok(card.missing_obligations.includes('transaction_rollback'));
  assert.ok(card.missing_obligations.includes('tenant_isolation'));
  assert.ok(card.missing_obligations.includes('write_allowlist'));
});
