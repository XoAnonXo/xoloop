'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildVerifyCard,
  createGoal,
  runGoalVerify,
} = require('../lib/goal_verify_runner.cjs');
const { artifactHash, loadGoalManifest, writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-suite-orchestration-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text, executable = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
  if (executable) fs.chmodSync(filePath, 0o755);
}

function writeSuiteGoal(cwd, options = {}) {
  const goalDir = path.join(cwd, '.xoloop', 'goals', 'all');
  const cliDir = path.join(goalDir, 'suites', 'cli');
  const formalDir = path.join(goalDir, 'suites', 'formal');
  writeJson(path.join(cliDir, 'cases', 'upper.json'), {
    id: 'upper',
    command_id: 'manual',
    command: 'node cli.cjs',
    args: ['--upper', 'input.txt'],
    files: [{ path: 'input.txt', content: 'hello\n' }],
    stdin: '',
    expected_exit_code: 0,
    expected_stdout: '{"value":"HELLO"}\n',
    expected_stderr: '',
    expected_files: [{ path: 'out.txt', content: 'HELLO\n' }],
    allow_writes: ['out.txt'],
    performance_budgets: { wall_time_ms: { lte: 5000 } },
    repeat: 1,
  });
  writeJson(path.join(formalDir, 'cases', 'typecheck.json'), {
    id: 'typecheck',
    category: 'type_check',
    tool: 'tsc',
    command: options.formalCommand || 'node typecheck.cjs',
    expected_exit_code: options.formalExitCode == null ? 0 : options.formalExitCode,
  });
  const goalPath = path.join(goalDir, 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'all',
    objective: 'Verify the whole repo through a composed suite.',
    interface: {
      type: 'suite',
      command: 'xoloop verify suite',
      stdin: 'none',
      stdout: 'json',
      timeout_ms: 120000,
    },
    artifacts: {
      paths: ['cli.cjs', 'typecheck.cjs'],
    },
    verify: {
      kind: 'suite',
      obligations: [
        {
          id: 'cli',
          kind: 'cli-suite',
          goal_path: 'suites/cli/goal.yaml',
          interface: { type: 'cli', command: 'node cli.cjs', stdin: 'text', stdout: 'text', timeout_ms: 10000 },
          artifacts: { paths: ['cli.cjs'] },
          metrics: { repeat: 1, targets: [{ name: 'wall_time_ms', direction: 'minimize', threshold: 0 }] },
          cases: 'cases/*.json',
          command: 'node cli.cjs',
          reference_command: '',
          properties: ['case_present', 'surface_coverage', 'exit_code', 'stdout_contract', 'stderr_contract', 'filesystem_effects', 'deterministic', 'performance_budget'],
          scan: { commands: [] },
          block_on_gaps: true,
        },
        {
          id: 'formal',
          kind: 'formal-suite',
          goal_path: 'suites/formal/goal.yaml',
          interface: { type: 'formal', command: 'formal/static verification harness', stdin: 'none', stdout: 'text', timeout_ms: 120000 },
          artifacts: { paths: ['typecheck.cjs'] },
          metrics: { repeat: 1, targets: [{ name: 'wall_time_ms', direction: 'minimize', threshold: 0 }] },
          cases: 'cases/*.json',
          properties: ['case_present', 'tool_coverage', 'analyzer_success', 'counterexample_capture', 'type_check'],
          required_categories: ['type_check'],
          block_on_gaps: true,
        },
      ],
      block_on_gaps: true,
    },
    metrics: {
      repeat: 1,
      targets: [{ name: 'complexity_score', direction: 'minimize', threshold: 0.05 }],
    },
  });
  return goalPath;
}

test('suite create writes child goals for CLI, frontend, API, DB/state, state machine, concurrency, performance, and formal', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      cli: 'node cli.cjs',
      dev: 'vite --host 127.0.0.1',
      start: 'node src/server.js',
      bench: 'node bench.js',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@prisma/client': '^5.0.0',
      express: '^4.18.0',
      react: '^18.0.0',
      vite: '^5.0.0',
      xstate: '^5.0.0',
      typescript: '^5.0.0',
    },
  });
  writeText(path.join(cwd, 'cli.cjs'), 'console.log("cli");\n');
  writeText(path.join(cwd, 'src', 'pages', 'index.jsx'), 'export default function Home(){ return <button>Save</button>; }\n');
  writeText(path.join(cwd, 'src', 'server.js'), "require('express')().get('/api/health', (_req, res) => res.json({ ok: true }));\n");
  writeJson(path.join(cwd, 'openapi.json'), { openapi: '3.0.0', paths: { '/api/health': { get: { responses: { 200: { description: 'ok' } } } } } });
  writeText(path.join(cwd, 'prisma', 'schema.prisma'), 'model User { id Int @id tenant_id String }\n');
  writeText(path.join(cwd, 'prisma', 'migrations', '001_init', 'migration.sql'), 'CREATE TABLE users (id int primary key);\n');
  writeText(path.join(cwd, 'src', 'machines', 'checkout.machine.ts'), 'export const machine = { states: { cart: {}, paid: {} } };\n');
  writeText(path.join(cwd, 'src', 'jobs', 'queue.js'), 'export async function enqueue(job) { await Promise.resolve(job); }\n');
  writeText(path.join(cwd, 'bench.js'), 'console.log(JSON.stringify({ wall_time_ms: 1 }));\n');
  writeText(path.join(cwd, 'tsconfig.json'), '{}\n');

  const created = createGoal({ cwd, kind: 'suite', goalId: 'all', surfaces: 'all', force: true });

  assert.equal(created.goal.verify.kind, 'suite');
  assert.equal(created.goal.interface.type, 'suite');
  const ids = created.goal.verify.obligations.map((obligation) => obligation.id).sort();
  assert.deepEqual(ids, ['api', 'cli', 'concurrency', 'formal', 'frontend', 'performance', 'state', 'state-machine']);
  for (const id of ids) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'all', 'suites', id, 'goal.yaml')), true);
  }
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'all', 'suite.json')), true);
});

test('suite run combines child obligations with prefixed evidence', async () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'cli.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    "const input = fs.readFileSync(process.argv[3], 'utf8').trim();",
    "const value = process.argv[2] === '--upper' ? input.toUpperCase() : input;",
    "fs.writeFileSync('out.txt', `${value}\\n`);",
    "process.stdout.write(JSON.stringify({ value }) + '\\n');",
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'typecheck.cjs'), 'console.log("ok");\n');
  const goalPath = writeSuiteGoal(cwd);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.deepEqual(card.missing_obligations, []);
  assert.equal(card.summary.by_id['cli:exit_code'].passed, 1);
  assert.equal(card.summary.by_id['formal:type_check'].passed, 1);
  assert.equal(Number.isFinite(card.metrics['cli:wall_time_ms']), true);
  assert.equal(Number.isFinite(card.metrics['formal:wall_time_ms']), true);
});

test('suite failures preserve child obligation id and replay selection', async () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'cli.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    "const input = fs.readFileSync(process.argv[3], 'utf8').trim();",
    "const value = process.argv[2] === '--upper' ? input.toUpperCase() : input;",
    "fs.writeFileSync('out.txt', `${value}\\n`);",
    "process.stdout.write(JSON.stringify({ value }) + '\\n');",
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'typecheck.cjs'), 'console.error("Type error"); process.exit(2);\n');
  const goalPath = writeSuiteGoal(cwd);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.suite_id, 'formal');
  assert.equal(card.counterexample.obligation, 'formal:type_check');
  assert.match(card.replay, /--suite formal --case typecheck/);
});

test('suite evidence becomes stale when child harness cases change', async () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'cli.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    "const input = fs.readFileSync(process.argv[3], 'utf8').trim();",
    "const value = process.argv[2] === '--upper' ? input.toUpperCase() : input;",
    "fs.writeFileSync('out.txt', `${value}\\n`);",
    "process.stdout.write(JSON.stringify({ value }) + '\\n');",
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'typecheck.cjs'), 'console.log("ok");\n');
  const goalPath = writeSuiteGoal(cwd);

  const first = await runGoalVerify(goalPath, { cwd });
  assert.equal(first.card.verdict, 'PASS_EVIDENCED');
  const beforeHash = artifactHash(loadGoalManifest(goalPath).goal, cwd, goalPath);

  const casePath = path.join(cwd, '.xoloop', 'goals', 'all', 'suites', 'cli', 'cases', 'upper.json');
  const testCase = JSON.parse(fs.readFileSync(casePath, 'utf8'));
  testCase.expected_stdout = '{"value":"HELLO!"}\n';
  writeJson(casePath, testCase);
  const afterHash = artifactHash(loadGoalManifest(goalPath).goal, cwd, goalPath);
  assert.notEqual(afterHash, beforeHash);

  const card = buildVerifyCard(goalPath, { cwd });
  assert.equal(card.verdict, 'STALE');
  assert.equal(card.current_evidence_count, 0);
  assert.equal(card.stale_evidence_count, 1);
});
