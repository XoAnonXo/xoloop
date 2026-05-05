'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  buildVerifyCard,
  createGoal,
  runGoalVerify,
} = require('../lib/goal_verify_runner.cjs');
const { artifactHash, loadGoalManifest, writeGoalManifest } = require('../lib/goal_manifest.cjs');
const { runCliCommand } = require('../lib/goal_cli_runner.cjs');
const { runOptimiseLoop } = require('../lib/goal_optimise_runner.cjs');
const { countBranchTokens } = require('../lib/goal_complexity.cjs');

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

test('optimise records proposal-only tradeoffs without mutating files', async () => {
  const cwd = tmpDir();
  copyExampleTarget(cwd);
  const goalPath = createFastGoal(cwd);
  await runGoalVerify(goalPath, { cwd });
  const before = fs.readFileSync(path.join(cwd, 'src', 'canon.cjs'), 'utf8');
  const agentCommand = writeAgent(cwd, 'tradeoff-agent.cjs', [
    '#!/usr/bin/env node',
    'process.stdout.write(JSON.stringify({',
    "  summary: 'cost savings require dropping duplicate-key rejection',",
    '  operations: [],',
    '  tradeoffs: [{',
    "    id: 'drop-duplicate-key-detection',",
    "    description: 'Skip duplicate-key detection to reduce parser work',",
    "    estimated_savings: '5-10% CPU on pathological JSON payloads',",
    "    behavior_change: 'duplicate keys would no longer be rejected',",
    "    verification_impact: 'reject-duplicate-key baseline must be explicitly changed',",
    '    requires_user_approval: true',
    '  }],',
    "  notes: ['Kept as proposal only because it changes behavior.']",
    '}));',
    '',
  ].join('\n'));

  const summary = await runOptimiseLoop({ cwd, goalPath, agentCommand, rounds: 1 });
  const after = fs.readFileSync(path.join(cwd, 'src', 'canon.cjs'), 'utf8');

  assert.equal(summary.stop_reason, 'agent_tradeoff_only');
  assert.equal(summary.noops, 1);
  assert.equal(summary.tradeoffs[0].id, 'drop-duplicate-key-detection');
  assert.match(summary.notes[0].note, /proposal only/);
  assert.equal(after, before);
});

test('xoloop-verify tradeoff accepts recorded tradeoff proposals', async () => {
  const cwd = tmpDir();
  copyExampleTarget(cwd);
  const goalPath = createFastGoal(cwd);
  await runGoalVerify(goalPath, { cwd });
  const agentCommand = writeAgent(cwd, 'tradeoff-agent.cjs', [
    '#!/usr/bin/env node',
    'process.stdout.write(JSON.stringify({',
    "  summary: 'proposal only',",
    '  operations: [],',
    '  tradeoffs: [{',
    "    id: 'drop-duplicate-key-detection',",
    "    description: 'Skip duplicate-key detection',",
    "    estimated_savings: '5% CPU',",
    "    behavior_change: 'duplicate keys accepted',",
    "    verification_impact: 'baseline update required'",
    '  }]',
    '}));',
    '',
  ].join('\n'));
  await runOptimiseLoop({ cwd, goalPath, agentCommand, rounds: 1 });
  const cliPath = path.resolve(__dirname, '..', 'bin', 'xoloop-verify.cjs');

  const listed = spawnSync(process.execPath, [cliPath, 'tradeoff', goalPath, '--json'], { cwd, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).tradeoffs[0].id, 'drop-duplicate-key-detection');

  const accepted = spawnSync(process.execPath, [cliPath, 'tradeoff', goalPath, '--accept', 'drop-duplicate-key-detection', '--reason', 'approved experiment', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const payload = JSON.parse(accepted.stdout);
  assert.equal(payload.decision, 'accepted');
  assert.ok(payload.goal.acceptance.accepted_tradeoffs.includes('drop-duplicate-key-detection'));
  const ledger = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'json-canon-test', 'tradeoffs.json'), 'utf8'));
  assert.equal(ledger.decisions['drop-duplicate-key-detection'].decision, 'accepted');
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

test('runCliCommand keeps verifier Node first on PATH for generated commands', async () => {
  const result = await runCliCommand('node -p "process.execPath"', '', {
    cwd: tmpDir(),
    timeoutMs: 5000,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.execPath);
});

test('general-io goals verify black-box CLI cases and properties', async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'double.cjs'), [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const n = Number(input.trim());",
    "  process.stdout.write(JSON.stringify({ value: n * 2 }) + '\\n');",
    "});",
    '',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(cwd, '.xoloop', 'goals', 'general-io', 'cases'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.xoloop', 'goals', 'general-io', 'cases', 'two.json'), JSON.stringify({
    id: 'two',
    input: '2\n',
    expected_exit_code: 0,
    expected_stdout: '{"value":4}\n',
  }, null, 2), 'utf8');
  const goalPath = path.join(cwd, '.xoloop', 'goals', 'general-io', 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'general-io',
    objective: 'Verify a language-neutral input/output contract.',
    interface: {
      type: 'cli',
      command: 'node double.cjs',
      stdin: 'text',
      stdout: 'json',
    },
    artifacts: {
      paths: ['double.cjs'],
    },
    verify: {
      kind: 'general-io',
      cases: 'cases/*.json',
      properties: ['deterministic', 'stdout_json', 'no_stderr'],
    },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.deepEqual(card.missing_obligations, []);
  assert.equal(card.summary.failed, 0);
});

test('general-io goals produce differential counterexamples', async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'impl.cjs'), "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('bad\\n'));\n", 'utf8');
  fs.writeFileSync(path.join(cwd, 'ref.cjs'), "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('good\\n'));\n", 'utf8');
  fs.mkdirSync(path.join(cwd, '.xoloop', 'goals', 'diff', 'cases'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.xoloop', 'goals', 'diff', 'cases', 'one.json'), JSON.stringify({
    id: 'one',
    input: 'x',
  }, null, 2), 'utf8');
  const goalPath = path.join(cwd, '.xoloop', 'goals', 'diff', 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'diff',
    objective: 'Detect divergence from a reference command.',
    interface: {
      type: 'cli',
      command: 'node impl.cjs',
    },
    artifacts: {
      paths: ['impl.cjs'],
    },
    verify: {
      kind: 'general-io',
      cases: 'cases/*.json',
      reference_command: 'node ref.cjs',
      properties: ['differential_reference'],
    },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'differential_reference');
  assert.match(card.replay, /--case one/);
});

test('artifact hash covers verifier-owned inputs that affect verdicts', () => {
  const cwd = tmpDir();
  const goalDir = path.join(cwd, '.xoloop', 'goals', 'freshness');
  fs.mkdirSync(path.join(goalDir, 'cases'), { recursive: true });
  fs.mkdirSync(path.join(goalDir, 'bench'), { recursive: true });
  fs.mkdirSync(path.join(goalDir, 'masks'), { recursive: true });
  fs.mkdirSync(path.join(goalDir, 'baselines', 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(goalDir, 'schedules'), { recursive: true });
  fs.writeFileSync(path.join(goalDir, 'cases', 'case.json'), '{"id":"case","expected_stdout":"ok"}\n', 'utf8');
  fs.writeFileSync(path.join(goalDir, 'bench', 'bench.json'), '{"id":"bench","input":"x"}\n', 'utf8');
  fs.writeFileSync(path.join(goalDir, 'masks', 'mask.json'), '{"regions":[]}\n', 'utf8');
  fs.writeFileSync(path.join(goalDir, 'baselines', 'desktop', 'home.png'), 'baseline-v1', 'utf8');
  fs.writeFileSync(path.join(goalDir, 'schedules', 'race.json'), '{"steps":["a","b"]}\n', 'utf8');
  fs.writeFileSync(path.join(goalDir, 'accepted-gaps.json'), '[]\n', 'utf8');
  fs.writeFileSync(path.join(goalDir, 'discovery.json'), '{"blocking_gaps":[]}\n', 'utf8');
  fs.writeFileSync(path.join(goalDir, 'invariants.json'), '[{"id":"total"}]\n', 'utf8');
  const goalPath = path.join(goalDir, 'goal.yaml');
  const goal = {
    version: 0.1,
    goal_id: 'freshness',
    objective: 'Protect verifier-owned evidence inputs.',
    interface: {
      type: 'cli',
      command: 'node noop.cjs',
      stdin: 'none',
      stdout: 'json',
      timeout_ms: 10000,
    },
    artifacts: {
      paths: [],
    },
    verify: {
      kind: 'frontend-suite',
      cases: 'cases/*.json',
      benchmark_cases: 'bench/*.json',
      masks: 'masks/*.json',
      baselines_dir: 'baselines',
      schedules_dir: 'schedules',
      accepted_gap_file: 'accepted-gaps.json',
      discovery_file: 'discovery.json',
      invariants_file: 'invariants.json',
    },
  };
  writeGoalManifest(goalPath, goal);

  const assertHashChanges = (relativePath, nextText) => {
    const before = artifactHash(goal, cwd, goalPath);
    fs.writeFileSync(path.join(goalDir, relativePath), nextText, 'utf8');
    const after = artifactHash(goal, cwd, goalPath);
    assert.notEqual(after, before, `${relativePath} must affect artifact hash`);
  };

  assertHashChanges('cases/case.json', '{"id":"case","expected_stdout":"changed"}\n');
  assertHashChanges('bench/bench.json', '{"id":"bench","input":"changed"}\n');
  assertHashChanges('masks/mask.json', '{"regions":[{"x":1}]}\n');
  assertHashChanges('baselines/desktop/home.png', 'baseline-v2');
  assertHashChanges('schedules/race.json', '{"steps":["b","a"]}\n');
  assertHashChanges('accepted-gaps.json', '["frontend:baseline-missing"]\n');
  assertHashChanges('discovery.json', '{"blocking_gaps":[{"id":"api:missing"}]}\n');
  assertHashChanges('invariants.json', '[{"id":"total","rule":"changed"}]\n');
});

test('complexity branch counting is linear for large generated template strings', () => {
  const template = `const text = \`${'if (x) { return y; } '.repeat(20000)}\`;`;
  const source = `${template}\nif (ready && enabled) { for (const item of items) console.log(item); }\n`;
  const started = Date.now();
  const branches = countBranchTokens(source);
  const elapsed = Date.now() - started;

  assert.equal(branches, 3);
  assert.ok(elapsed < 500, `branch counting should stay fast, got ${elapsed}ms`);
});
