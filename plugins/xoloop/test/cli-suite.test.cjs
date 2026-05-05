'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  runGoalVerify,
  scanCliRepo,
} = require('../lib/goal_verify_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-cli-suite-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeCli(cwd, name, body) {
  const filePath = path.join(cwd, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function writeCliGoal(cwd, options = {}) {
  const goalId = options.goalId || 'cli';
  const goalPath = path.join(cwd, '.xoloop', 'goals', goalId, 'goal.yaml');
  writeJson(path.join(cwd, '.xoloop', 'goals', goalId, 'cases', options.caseName || 'upper.json'), {
    id: options.caseId || 'upper',
    command_id: 'manual',
    command: options.command || 'node cli.cjs',
    args: options.args || ['--upper', 'input.txt'],
    files: options.files || [{ path: 'input.txt', content: 'hello\n' }],
    stdin: options.stdin || '',
    expected_exit_code: options.expectedExitCode == null ? 0 : options.expectedExitCode,
    expected_stdout: Object.prototype.hasOwnProperty.call(options, 'expectedStdout') ? options.expectedStdout : '{"value":"HELLO"}\n',
    expected_stderr: Object.prototype.hasOwnProperty.call(options, 'expectedStderr') ? options.expectedStderr : '',
    expected_files: options.expectedFiles || [{ path: 'out.txt', content: 'HELLO\n' }],
    allow_writes: options.allowWrites || ['out.txt'],
    performance_budgets: options.performanceBudgets || { wall_time_ms: { lte: 5000 } },
    repeat: 1,
    ...(options.caseExtra || {}),
  });
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: goalId,
    objective: 'Verify deep CLI behavior.',
    interface: {
      type: 'cli',
      command: options.command || 'node cli.cjs',
      stdin: 'text',
      stdout: 'text',
      timeout_ms: 10000,
    },
    artifacts: {
      paths: options.artifacts || ['cli.cjs'],
    },
    verify: {
      kind: 'cli-suite',
      command: options.command || 'node cli.cjs',
      cases: 'cases/*.json',
      reference_command: options.referenceCommand || '',
      properties: options.properties || [
        'case_present',
        'surface_coverage',
        'exit_code',
        'stdout_contract',
        'stderr_contract',
        'filesystem_effects',
        'deterministic',
        'performance_budget',
      ],
      scan: options.scan || { commands: [] },
      block_on_gaps: true,
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'wall_time_ms', direction: 'minimize', threshold: 0 },
      ],
    },
  });
  return goalPath;
}

test('CLI scan detects package bins, scripts, and Python argparse CLIs', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    bin: { demo: 'bin/demo.cjs' },
    scripts: {
      cli: 'node bin/demo.cjs',
      test: 'node --test',
    },
    dependencies: {
      commander: '^12.0.0',
    },
  });
  writeCli(cwd, 'bin/demo.cjs', '#!/usr/bin/env node\nconsole.log("demo");\n');
  writeCli(cwd, 'tools/report.py', 'import argparse\nargparse.ArgumentParser().parse_args()\n');

  const scan = scanCliRepo(cwd);

  assert.ok(scan.commands.some((command) => command.id === 'bin-demo'));
  assert.ok(scan.commands.some((command) => command.id === 'script-cli'));
  assert.ok(scan.commands.some((command) => command.language === 'python'));
  assert.ok(scan.artifact_paths.includes('package.json'));
  assert.ok(scan.artifact_paths.includes('bin/demo.cjs'));
});

test('cli-suite create writes conservative harness assets and manifest', () => {
  const cwd = tmpDir();
  writeCli(cwd, 'cli.cjs', '#!/usr/bin/env node\nconsole.log("ready");\n');
  writeJson(path.join(cwd, 'package.json'), { bin: { demo: 'cli.cjs' } });

  const created = createGoal({ cwd, kind: 'cli-suite', goalId: 'cli-suite', target: 'node cli.cjs', force: true });

  assert.equal(created.goal.verify.kind, 'cli-suite');
  for (const dir of ['cases', 'fixtures', 'expected', 'actual', 'diffs', 'traces', 'corpus']) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'cli-suite', dir)), true);
  }
  assert.equal(created.goal.interface.command, 'node cli.cjs');
});

test('cli-suite reaches PASS_EVIDENCED for stdout, stderr, files, determinism, and budget', async () => {
  const cwd = tmpDir();
  writeCli(cwd, 'cli.cjs', [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const input = fs.readFileSync(process.argv[3], 'utf8').trim();",
    "const value = process.argv[2] === '--upper' ? input.toUpperCase() : input;",
    "fs.writeFileSync('out.txt', `${value}\\n`);",
    "process.stdout.write(JSON.stringify({ value }) + '\\n');",
    '',
  ].join('\n'));
  const goalPath = writeCliGoal(cwd);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.deepEqual(card.missing_obligations, []);
  assert.equal(card.summary.failed, 0);
});

test('cli-suite fails when filesystem side effects escape allowed writes', async () => {
  const cwd = tmpDir();
  writeCli(cwd, 'cli.cjs', [
    '#!/usr/bin/env node',
    "require('fs').writeFileSync('surprise.txt', 'nope');",
    "process.stdout.write('ok\\n');",
    '',
  ].join('\n'));
  const goalPath = writeCliGoal(cwd, {
    goalId: 'escape',
    args: [],
    expectedStdout: 'ok\n',
    expectedFiles: [],
    allowWrites: [],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'filesystem_effects');
  assert.match(card.replay, /--case upper/);
});

test('cli-suite reports PASS_WITH_GAPS when output and performance oracles are missing', async () => {
  const cwd = tmpDir();
  writeCli(cwd, 'cli.cjs', "process.stdout.write('ok\\n');\n");
  const goalPath = writeCliGoal(cwd, {
    goalId: 'gappy',
    args: [],
    expectedStdout: null,
    expectedStderr: null,
    expectedFiles: [],
    allowWrites: [],
    performanceBudgets: {},
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.ok(card.missing_obligations.includes('stdout_contract'));
  assert.ok(card.missing_obligations.includes('stderr_contract'));
  assert.ok(card.missing_obligations.includes('performance_budget'));
});

test('cli-suite produces differential reference counterexamples', async () => {
  const cwd = tmpDir();
  writeCli(cwd, 'impl.cjs', "process.stdout.write('new\\n');\n");
  writeCli(cwd, 'ref.cjs', "process.stdout.write('old\\n');\n");
  const goalPath = writeCliGoal(cwd, {
    goalId: 'diff',
    command: 'node impl.cjs',
    args: [],
    artifacts: ['impl.cjs', 'ref.cjs'],
    expectedStdout: 'new\n',
    expectedFiles: [],
    allowWrites: [],
    referenceCommand: 'node ref.cjs',
    properties: [
      'case_present',
      'surface_coverage',
      'exit_code',
      'stdout_contract',
      'stderr_contract',
      'filesystem_effects',
      'deterministic',
      'differential_reference',
      'performance_budget',
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'differential_reference');
});

test('cli-suite generates fuzz cases and stores counterexamples in corpus', async () => {
  const cwd = tmpDir();
  writeCli(cwd, 'cli.cjs', [
    '#!/usr/bin/env node',
    "'use strict';",
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  if (input.includes('!')) { process.stderr.write('bang'); process.exit(2); }",
    "  process.stdout.write('ok\\n');",
    "});",
    '',
  ].join('\n'));
  const goalPath = writeCliGoal(cwd, {
    goalId: 'fuzz',
    args: [],
    stdin: 'seed',
    expectedStdout: 'ok\n',
    expectedStderr: '',
    expectedFiles: [],
    allowWrites: [],
    properties: [
      'case_present',
      'surface_coverage',
      'exit_code',
      'stdout_contract',
      'stderr_contract',
      'filesystem_effects',
      'deterministic',
      'generated_cases',
      'performance_budget',
    ],
  });
  const manifest = JSON.parse(fs.readFileSync(goalPath, 'utf8'));
  manifest.verify.fuzz = {
    generator: 'stdin-text',
    seed: 2,
    runs: 12,
    mutate: ['stdin'],
    stdin_values: ['boom!'],
    property: 'no_crash',
  };
  writeGoalManifest(goalPath, manifest);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.ok(card.summary.by_id.generated_cases.passed > 0);
  assert.equal(card.counterexample.obligation, 'exit_code');
  assert.ok(card.counterexample.corpus_path);
  assert.equal(fs.existsSync(card.counterexample.corpus_path), true);
});

test('cli-suite writes actual, trace, and diff artifacts for replay', async () => {
  const cwd = tmpDir();
  writeCli(cwd, 'cli.cjs', "process.stdout.write('wrong\\n');\n");
  const goalPath = writeCliGoal(cwd, {
    goalId: 'artifacts',
    args: [],
    expectedStdout: 'right\n',
    expectedStderr: '',
    expectedFiles: [],
    allowWrites: [],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'stdout_contract');
  assert.ok(card.counterexample.diff_path);
  assert.equal(fs.existsSync(card.counterexample.diff_path), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'artifacts', 'actual', 'upper.json')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'artifacts', 'traces', 'upper.json')), true);
});
