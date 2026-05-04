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
const { loadGoalManifest, writeGoalManifest } = require('../lib/goal_manifest.cjs');
const { runOptimiseLoop } = require('../lib/goal_optimise_runner.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const exampleCanon = path.resolve(__dirname, '..', 'examples', 'json-canonicalizer', 'src', 'canon.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-goal-'));
}

function copyExampleTarget(cwd) {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.copyFileSync(exampleCanon, path.join(cwd, 'src', 'canon.cjs'));
  fs.chmodSync(path.join(cwd, 'src', 'canon.cjs'), 0o755);
}

function writeBrokenTarget(cwd) {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'canon.cjs'), [
    '#!/usr/bin/env node',
    "'use strict';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => { process.stdout.write(input.trim() + '\\n'); });",
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(path.join(cwd, 'src', 'canon.cjs'), 0o755);
}

function createFastGoal(cwd) {
  const created = createGoal({
    cwd,
    target: 'src/canon.cjs',
    goalId: 'json-canon-test',
    kind: 'json-canonicalizer',
    force: true,
  });
  const loaded = loadGoalManifest(created.goalPath);
  for (const dirName of ['cases', 'bench']) {
    const dir = path.join(cwd, '.xoloop', 'goals', 'json-canon-test', dirName);
    for (const file of fs.readdirSync(dir)) {
      const keep = dirName === 'cases'
        ? ['key-order.json', 'reject-duplicate-key.json'].includes(file)
        : file === 'bench-small.json';
      if (!keep) fs.unlinkSync(path.join(dir, file));
    }
  }
  loaded.goal.verify.fuzz.runs = 0;
  loaded.goal.metrics.repeat = 1;
  loaded.goal.metrics.targets = [
    { name: 'complexity_score', direction: 'minimize', threshold: 0 },
  ];
  loaded.goal.acceptance.max_metric_regression = 1;
  writeGoalManifest(created.goalPath, loaded.goal);
  return created.goalPath;
}

function writeAgent(cwd, name, body) {
  const filePath = path.join(cwd, name);
  fs.writeFileSync(filePath, body, 'utf8');
  fs.chmodSync(filePath, 0o755);
  return `node ${JSON.stringify(filePath)}`;
}

test('verify creates a goal and reaches PASS_EVIDENCED for the JSON canonicalizer', async () => {
  const cwd = tmpDir();
  copyExampleTarget(cwd);
  const goalPath = createFastGoal(cwd);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.failed, 0);
  assert.ok(card.metrics.complexity_score > 0);
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'json-canon-test', 'evidence.jsonl')));
});

test('verify produces a concrete counterexample for a broken canonicalizer', async () => {
  const cwd = tmpDir();
  writeBrokenTarget(cwd);
  const goalPath = createFastGoal(cwd);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.ok(card.counterexample);
  assert.ok(card.counterexample.case_id);
  assert.match(card.replay, /xoloop-verify run/);

  const replay = await runGoalVerify(goalPath, { cwd, caseId: card.counterexample.case_id });
  assert.equal(replay.card.verdict, 'FAIL');
});

test('optimise rejects a simpler but behavior-breaking candidate and rolls back', async () => {
  const cwd = tmpDir();
  copyExampleTarget(cwd);
  const goalPath = createFastGoal(cwd);
  await runGoalVerify(goalPath, { cwd });
  const before = fs.readFileSync(path.join(cwd, 'src', 'canon.cjs'), 'utf8');
  const search = "  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;";
  const replace = "  return JSON.stringify(value);";
  const agentCommand = writeAgent(cwd, 'bad-agent.cjs', [
    '#!/usr/bin/env node',
    `process.stdout.write(JSON.stringify({ summary: 'remove key sorting', operations: [{ op: 'replace_exact', path: 'src/canon.cjs', search: ${JSON.stringify(search)}, replace: ${JSON.stringify(replace)} }] }));`,
    '',
  ].join('\n'));

  const summary = await runOptimiseLoop({ cwd, goalPath, agentCommand, rounds: 1 });
  const after = fs.readFileSync(path.join(cwd, 'src', 'canon.cjs'), 'utf8');

  assert.equal(summary.accepted, 0);
  assert.equal(summary.rejected, 1);
  assert.equal(after, before);
});

test('optimise accepts a verified simpler candidate', async () => {
  const cwd = tmpDir();
  copyExampleTarget(cwd);
  fs.appendFileSync(path.join(cwd, 'src', 'canon.cjs'), [
    '',
    'function unusedComplexitySink(x) {',
    '  if (x) { for (let i = 0; i < 1; i += 1) { while (false) { return i; } } }',
    '  return 0;',
    '}',
    '',
  ].join('\n'), 'utf8');
  const goalPath = createFastGoal(cwd);
  await runGoalVerify(goalPath, { cwd });
  const search = [
    '',
    'function unusedComplexitySink(x) {',
    '  if (x) { for (let i = 0; i < 1; i += 1) { while (false) { return i; } } }',
    '  return 0;',
    '}',
    '',
  ].join('\n');
  const agentCommand = writeAgent(cwd, 'good-agent.cjs', [
    '#!/usr/bin/env node',
    `process.stdout.write(JSON.stringify({ summary: 'remove unused complexity', operations: [{ op: 'replace_exact', path: 'src/canon.cjs', search: ${JSON.stringify(search)}, replace: '\\n' }] }));`,
    '',
  ].join('\n'));

  const summary = await runOptimiseLoop({ cwd, goalPath, agentCommand, rounds: 1 });
  const card = buildVerifyCard(goalPath, { cwd });

  assert.equal(summary.accepted, 1);
  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.doesNotMatch(fs.readFileSync(path.join(cwd, 'src', 'canon.cjs'), 'utf8'), /unusedComplexitySink/);
});

test('optimise rejects malformed agent stdout without mutating files', async () => {
  const cwd = tmpDir();
  copyExampleTarget(cwd);
  const goalPath = createFastGoal(cwd);
  await runGoalVerify(goalPath, { cwd });
  const before = fs.readFileSync(path.join(cwd, 'src', 'canon.cjs'), 'utf8');
  const agentCommand = writeAgent(cwd, 'malformed-agent.cjs', [
    '#!/usr/bin/env node',
    "process.stdout.write('not json');",
    '',
  ].join('\n'));

  const summary = await runOptimiseLoop({ cwd, goalPath, agentCommand, rounds: 1 });
  const after = fs.readFileSync(path.join(cwd, 'src', 'canon.cjs'), 'utf8');

  assert.equal(summary.stop_reason, 'agent_error');
  assert.equal(after, before);
});

test('optimise rejects operations outside allowed artifact paths', async () => {
  const cwd = tmpDir();
  copyExampleTarget(cwd);
  const goalPath = createFastGoal(cwd);
  await runGoalVerify(goalPath, { cwd });
  const agentCommand = writeAgent(cwd, 'escape-agent.cjs', [
    '#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ summary: 'write outside scope', operations: [{ op: 'create_file', path: 'outside.cjs', content: 'bad' }] }));",
    '',
  ].join('\n'));

  const summary = await runOptimiseLoop({ cwd, goalPath, agentCommand, rounds: 1 });

  assert.equal(summary.accepted, 0);
  assert.equal(summary.rejected, 1);
  assert.equal(fs.existsSync(path.join(cwd, 'outside.cjs')), false);
});

test('command-suite goals verify named CLI obligations', async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'ok.cjs'), "console.log('ready');\n", 'utf8');
  const goalPath = path.join(cwd, '.xoloop', 'goals', 'command-suite', 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'command-suite',
    objective: 'Verify command-suite obligations.',
    interface: {
      type: 'command-suite',
      command: 'command suite',
      stdin: 'none',
      stdout: 'text',
    },
    artifacts: {
      paths: ['ok.cjs'],
    },
    verify: {
      kind: 'command-suite',
      commands: [
        {
          id: 'node-runs',
          command: 'node ok.cjs',
          expect_stdout_includes: ['ready'],
        },
      ],
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'complexity_score', direction: 'minimize', threshold: 0 },
      ],
    },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.deepEqual(card.missing_obligations, []);
});
