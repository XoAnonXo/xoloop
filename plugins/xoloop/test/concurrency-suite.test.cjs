'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  runGoalVerify,
  scanConcurrencyRepo,
} = require('../lib/goal_verify_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-concurrency-suite-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeScript(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
}

function writeReplayScript(cwd, options = {}) {
  writeScript(path.join(cwd, options.name || 'async-replay.cjs'), [
    "const fs = require('fs');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');",
    "const order = Array.isArray(input.schedule && input.schedule.order) ? input.schedule.order : ['start', 'finish'];",
    `const result = ${JSON.stringify(Object.prototype.hasOwnProperty.call(options, 'result') ? options.result : { value: 2 })};`,
    'const events = order.map((name, index) => ({ name, at: (input.clock && input.clock.start_ms || 0) + index }));',
    "process.stdout.write(JSON.stringify({ events, result, clock: { mode: input.clock && input.clock.mode || 'fake', adapter: input.clock && input.clock.adapter || 'xoloop-virtual-clock', controlled: true }, scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true } }));",
    '',
  ].join('\n'));
}

function writeReferenceScript(cwd) {
  writeScript(path.join(cwd, 'async-reference.cjs'), [
    "const fs = require('fs');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');",
    "const order = Array.isArray(input.schedule && input.schedule.order) ? input.schedule.order : ['start', 'finish'];",
    "const events = order.map((name, index) => ({ name, at: (input.clock && input.clock.start_ms || 0) + index }));",
    "process.stdout.write(JSON.stringify({ events, result: { value: 2 }, clock: { mode: input.clock && input.clock.mode || 'fake', adapter: input.clock && input.clock.adapter || 'xoloop-virtual-clock', controlled: true }, scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true } }));",
    '',
  ].join('\n'));
}

function writeRaceTool(cwd, options = {}) {
  writeScript(path.join(cwd, options.name || 'race-tool.cjs'), [
    "const fs = require('fs');",
    "JSON.parse(fs.readFileSync(0, 'utf8') || '{}');",
    `process.stdout.write(JSON.stringify(${JSON.stringify(options.report || { status: 'pass' })}));`,
    '',
  ].join('\n'));
}

function writeConcurrencyGoal(cwd, options = {}) {
  const goalId = options.goalId || 'async-goal';
  const goalPath = path.join(cwd, '.xoloop', 'goals', goalId, 'goal.yaml');
  const caseId = options.caseId || 'async-critical-section';
  writeJson(path.join(cwd, '.xoloop', 'goals', goalId, 'cases', `${caseId}.json`), {
    id: caseId,
    command: Object.prototype.hasOwnProperty.call(options, 'command') ? options.command : 'node async-replay.cjs',
    reference_command: Object.prototype.hasOwnProperty.call(options, 'referenceCommand') ? options.referenceCommand : 'node async-reference.cjs',
    input: options.input || { amount: 1 },
    schedules: options.schedules || [
      { id: 'serial', order: ['start', 'critical', 'finish'] },
      { id: 'retry', order: ['start', 'retry', 'critical', 'finish'] },
    ],
    clock: options.clock || { mode: 'fake', adapter: 'xoloop-virtual-clock', start_ms: 1000 },
    scheduler: options.scheduler || { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true },
    exploration: options.exploration || {
      enabled: true,
      strategy: 'bounded-permutation',
      events: ['start', 'critical', 'finish'],
      must_happen_before: [['start', 'finish'], ['critical', 'finish']],
      max_schedules: 4,
    },
    stress: options.stress || {
      enabled: true,
      strategy: 'seeded-random',
      events: ['start', 'critical', 'finish'],
      must_happen_before: [['start', 'finish'], ['critical', 'finish']],
      seed: 202405,
      runs: 2,
    },
    ordering: options.ordering || {
      before: [['start', 'finish'], ['critical', 'finish']],
      sequence: ['start', 'finish'],
    },
    temporal: Object.prototype.hasOwnProperty.call(options, 'temporal') ? options.temporal : {
      invariants: [
        { id: 'eventually-finish', type: 'eventually', event: 'finish' },
        { id: 'no-error', type: 'never', event: 'error' },
        { id: 'start-before-finish', type: 'before', a: 'start', b: 'finish', unless: 'cancel' },
      ],
    },
    deadlock: options.deadlock || { terminal_events: ['finish'], max_idle_ms: 1000 },
    race_tools: Object.prototype.hasOwnProperty.call(options, 'raceTools') ? options.raceTools : [],
    expected_result: Object.prototype.hasOwnProperty.call(options, 'expectedResult') ? options.expectedResult : { value: 2 },
    allowed_event_orders: options.allowedEventOrders || [],
    expected_timeout: options.expectedTimeout === true,
    timeout_ms: options.timeoutMs || 5000,
    max_duration_ms: options.maxDurationMs || 5000,
    repeat: options.repeat || 2,
    ...(options.caseExtra || {}),
  });
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: goalId,
    objective: 'Verify async ordering and timing behavior.',
    interface: {
      type: 'async',
      command: 'node async-replay.cjs',
      stdin: 'json',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: ['async-replay.cjs', 'async-reference.cjs'],
    },
    verify: {
      kind: 'concurrency-suite',
      command: Object.prototype.hasOwnProperty.call(options, 'goalCommand') ? options.goalCommand : '',
      reference_command: options.goalReferenceCommand || '',
      cases: 'cases/*.json',
      properties: options.properties || [
        'case_present',
        'schedule_declared',
        'command_success',
        'ordering_guarantees',
        'timeout_behavior',
        'clock_control',
        'deterministic_scheduling',
        'race_condition',
        'reference_trace',
        'counterexample_corpus',
      ],
      block_on_gaps: true,
      ...(options.verifyExtra || {}),
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'async_replay_ms', direction: 'minimize', threshold: 0 },
      ],
    },
  });
  return goalPath;
}

test('concurrency scan detects async tools, files, schedules, and replay scripts', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: { 'async:replay': 'node async-replay.cjs', test: 'node --test' },
    dependencies: {
      '@sinonjs/fake-timers': '^11.0.0',
      'p-queue': '^8.0.0',
      'async-mutex': '^0.5.0',
    },
  });
  fs.mkdirSync(path.join(cwd, 'src', 'queues'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'queues', 'worker.ts'), 'await Promise.race([job.run(), timeout]);\n', 'utf8');
  fs.mkdirSync(path.join(cwd, 'schedules'), { recursive: true });
  writeJson(path.join(cwd, 'schedules', 'interleaving.json'), { order: ['start', 'finish'] });

  const scan = scanConcurrencyRepo(cwd);

  assert.ok(scan.tools.some((tool) => tool.name === 'fake-timers'));
  assert.ok(scan.tools.some((tool) => tool.domain === 'scheduler'));
  assert.ok(scan.tools.some((tool) => tool.domain === 'race-control'));
  assert.ok(scan.runtimes.some((runtime) => runtime.runtime === 'node'));
  assert.ok(scan.clock_adapters.some((adapter) => adapter.name === 'sinon-fake-timers'));
  assert.ok(scan.deterministic_schedulers.some((scheduler) => scheduler.runtime === 'node'));
  assert.ok(scan.race_tooling.some((tool) => tool.kind === 'repo-script'));
  assert.ok(scan.async_files.some((file) => file.includes('worker.ts')));
  assert.ok(scan.schedule_files.some((file) => file.includes('interleaving.json')));
  assert.ok(scan.safe_commands.some((command) => command.kind === 'async-check'));
});

test('concurrency-suite create writes harness assets and manifest', () => {
  const cwd = tmpDir();

  const created = createGoal({ cwd, kind: 'concurrency-suite', goalId: 'concurrency-suite', force: true });

  assert.equal(created.goal.verify.kind, 'concurrency-suite');
  assert.equal(created.goal.interface.type, 'async');
  for (const dir of ['cases', 'schedules', 'traces', 'diffs', 'corpus']) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'concurrency-suite', dir)), true);
  }
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'concurrency-suite', 'async-harness.cjs')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'concurrency-suite', 'replay-counterexample.cjs')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'concurrency-suite', 'adapters', 'node-fake-clock.cjs')), true);
});

test('concurrency-suite generated smoke harness reaches PASS_WITH_GAPS only for missing reference trace', async () => {
  const cwd = tmpDir();
  const created = createGoal({ cwd, kind: 'concurrency-suite', goalId: 'concurrency-suite', force: true });

  const { card } = await runGoalVerify(created.goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.equal(card.summary.failed, 0);
  assert.ok(card.missing_obligations.includes('reference_trace'));
});

test('concurrency-suite reaches PASS_EVIDENCED for deterministic async replay', async () => {
  const cwd = tmpDir();
  writeReplayScript(cwd);
  writeReferenceScript(cwd);
  writeRaceTool(cwd);
  const goalPath = writeConcurrencyGoal(cwd, {
    raceTools: [{ id: 'race-tool', command: 'node race-tool.cjs' }],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.deepEqual(card.missing_obligations, []);
  assert.ok(card.summary.by_id.ordering_guarantees.passed > 0);
  assert.ok(card.summary.by_id.clock_control.passed > 0);
  assert.ok(card.summary.by_id.fake_clock_adapter.passed > 0);
  assert.ok(card.summary.by_id.runtime_scheduler.passed > 0);
  assert.ok(card.summary.by_id.schedule_exploration.passed > 0);
  assert.ok(card.summary.by_id.stress_replay.passed > 0);
  assert.ok(card.summary.by_id.deadlock_livelock.passed > 0);
  assert.ok(card.summary.by_id.race_tooling.passed > 0);
  assert.ok(card.summary.by_id.temporal_invariants.passed > 0);
  assert.ok(card.summary.by_id.replay_reproduction.passed > 0);
  assert.ok(card.summary.by_id.deterministic_scheduling.passed > 0);
  assert.ok(card.summary.by_id.reference_trace.passed > 0);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'async-goal', 'traces', 'async-critical-section.json')), true);
});

test('concurrency-suite fails when ordering guarantees drift', async () => {
  const cwd = tmpDir();
  writeReplayScript(cwd);
  writeReferenceScript(cwd);
  const goalPath = writeConcurrencyGoal(cwd, {
    schedules: [{ id: 'bad-order', order: ['finish', 'start'] }],
    ordering: { before: [['start', 'finish']], sequence: ['start', 'finish'] },
    allowedEventOrders: [['finish', 'start']],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'ordering_guarantees');
  assert.ok(card.counterexample.diff_path);
  assert.equal(fs.existsSync(card.counterexample.diff_path), true);
  assert.equal(fs.existsSync(card.counterexample.corpus_path), true);
});

test('concurrency-suite fails when race result is outside allowed outcomes', async () => {
  const cwd = tmpDir();
  writeReplayScript(cwd, { result: { value: 3 } });
  writeReferenceScript(cwd);
  const goalPath = writeConcurrencyGoal(cwd, {
    expectedResult: { value: 2 },
    properties: [
      'case_present',
      'schedule_declared',
      'command_success',
      'ordering_guarantees',
      'timeout_behavior',
      'clock_control',
      'deterministic_scheduling',
      'race_condition',
      'counterexample_corpus',
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'race_condition');
  assert.ok(card.counterexample.diff_path);
  assert.equal(fs.existsSync(card.counterexample.corpus_path), true);
});

test('concurrency-suite verifies explicit timeout events', async () => {
  const cwd = tmpDir();
  writeScript(path.join(cwd, 'async-timeout.cjs'), [
    "process.stdout.write(JSON.stringify({ events: [{ name: 'start', at: 0 }, { name: 'timeout', at: 50 }], timed_out: true, result: { status: 'timeout' }, clock: { mode: 'fake', adapter: 'xoloop-virtual-clock', controlled: true }, scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true } }));",
    '',
  ].join('\n'));
  const goalPath = writeConcurrencyGoal(cwd, {
    command: 'node async-timeout.cjs',
    referenceCommand: '',
    schedules: [{ id: 'timeout-path', order: ['start', 'timeout'] }],
    exploration: { enabled: false },
    stress: { enabled: false },
    ordering: { before: [['start', 'timeout']] },
    temporal: { invariants: [{ id: 'eventually-timeout', type: 'eventually', event: 'timeout' }] },
    deadlock: { terminal_events: ['timeout'], max_idle_ms: 1000 },
    expectedResult: { status: 'timeout' },
    expectedTimeout: true,
    properties: [
      'case_present',
      'schedule_declared',
      'command_success',
      'timeout_behavior',
      'clock_control',
      'race_condition',
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.ok(card.summary.by_id.timeout_behavior.passed > 0);
});

test('concurrency-suite fails when same schedule is not deterministic', async () => {
  const cwd = tmpDir();
  writeScript(path.join(cwd, 'async-flaky.cjs'), [
    "const fs = require('fs');",
    "const statePath = 'counter.txt';",
    "let count = 0;",
    "try { count = Number(fs.readFileSync(statePath, 'utf8')) || 0; } catch (_err) {}",
    "fs.writeFileSync(statePath, String(count + 1));",
    "const order = count % 2 === 0 ? ['start', 'finish'] : ['finish', 'start'];",
    "const events = order.map((name, index) => ({ name, at: index }));",
    "process.stdout.write(JSON.stringify({ events, result: { value: count % 2 }, clock: { mode: 'fake', adapter: 'xoloop-virtual-clock', controlled: true }, scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true } }));",
    '',
  ].join('\n'));
  const goalPath = writeConcurrencyGoal(cwd, {
    command: 'node async-flaky.cjs',
    referenceCommand: '',
    schedules: [{ id: 'same-interleaving', order: ['start', 'finish'] }],
    ordering: { sequence: [] },
    expectedResult: undefined,
    properties: [
      'case_present',
      'schedule_declared',
      'command_success',
      'clock_control',
      'deterministic_scheduling',
      'counterexample_corpus',
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'deterministic_scheduling');
  assert.ok(card.counterexample.diff_path);
  assert.equal(fs.existsSync(card.counterexample.corpus_path), true);
});

test('concurrency-suite systematically explores schedules beyond declared cases', async () => {
  const cwd = tmpDir();
  writeScript(path.join(cwd, 'async-order-bug.cjs'), [
    "const fs = require('fs');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');",
    "const order = Array.isArray(input.schedule && input.schedule.order) ? input.schedule.order : ['start', 'critical', 'finish'];",
    "const result = order.indexOf('critical') < order.indexOf('start') ? { value: 99 } : { value: 2 };",
    "const events = order.map((name, index) => ({ name, at: index }));",
    "process.stdout.write(JSON.stringify({ events, result, clock: { mode: 'fake', adapter: 'xoloop-virtual-clock', controlled: true }, scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true } }));",
    '',
  ].join('\n'));
  const goalPath = writeConcurrencyGoal(cwd, {
    command: 'node async-order-bug.cjs',
    referenceCommand: '',
    schedules: [{ id: 'declared-safe', order: ['start', 'critical', 'finish'] }],
    exploration: {
      enabled: true,
      strategy: 'bounded-permutation',
      events: ['start', 'critical', 'finish'],
      must_happen_before: [['critical', 'finish']],
      max_schedules: 6,
    },
    stress: { enabled: false },
    ordering: { sequence: [] },
    expectedResult: { value: 2 },
    temporal: { invariants: [] },
    deadlock: {},
  });

  const { card } = await runGoalVerify(goalPath, { cwd });
  const corpus = JSON.parse(fs.readFileSync(card.counterexample.corpus_path, 'utf8'));

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'race_condition');
  assert.equal(card.counterexample.diff_path && fs.existsSync(card.counterexample.diff_path), true);
  assert.equal(corpus.replay.schedule.source, 'exploration');
  assert.match(corpus.replay.command, /replay-counterexample\.cjs/);
});

test('concurrency-suite catches temporal invariant violations', async () => {
  const cwd = tmpDir();
  writeScript(path.join(cwd, 'async-temporal-bug.cjs'), [
    "process.stdout.write(JSON.stringify({ events: [{ name: 'finish', at: 0 }, { name: 'start', at: 1 }], result: { ok: true }, clock: { mode: 'fake', adapter: 'xoloop-virtual-clock', controlled: true }, scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true } }));",
    '',
  ].join('\n'));
  const goalPath = writeConcurrencyGoal(cwd, {
    command: 'node async-temporal-bug.cjs',
    referenceCommand: '',
    schedules: [{ id: 'temporal', order: ['finish', 'start'] }],
    exploration: { enabled: false },
    stress: { enabled: false },
    ordering: { sequence: [] },
    expectedResult: { ok: true },
    temporal: { invariants: [{ id: 'start-before-finish', type: 'before', a: 'start', b: 'finish' }] },
    deadlock: {},
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'temporal_invariants');
  assert.ok(card.counterexample.diff_path);
});

test('concurrency-suite catches deadlock and missing terminal evidence', async () => {
  const cwd = tmpDir();
  writeScript(path.join(cwd, 'async-deadlock.cjs'), [
    "process.stdout.write(JSON.stringify({ events: [{ name: 'start', at: 0 }, { name: 'deadlock', at: 10 }], deadlocked: true, result: { ok: false }, clock: { mode: 'fake', adapter: 'xoloop-virtual-clock', controlled: true }, scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true } }));",
    '',
  ].join('\n'));
  const goalPath = writeConcurrencyGoal(cwd, {
    command: 'node async-deadlock.cjs',
    referenceCommand: '',
    schedules: [{ id: 'deadlock', order: ['start', 'deadlock'] }],
    exploration: { enabled: false },
    stress: { enabled: false },
    ordering: { sequence: [] },
    expectedResult: { ok: false },
    temporal: { invariants: [] },
    deadlock: { terminal_events: ['finish'], max_idle_ms: 1000 },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'deadlock_livelock');
});

test('concurrency-suite runs static/runtime race tooling and fails on tool reports', async () => {
  const cwd = tmpDir();
  writeReplayScript(cwd);
  writeRaceTool(cwd, { report: { status: 'fail', races: [{ resource: 'counter', writers: ['a', 'b'] }] } });
  const goalPath = writeConcurrencyGoal(cwd, {
    referenceCommand: '',
    raceTools: [{ id: 'race-tool', command: 'node race-tool.cjs' }],
    temporal: { invariants: [] },
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'race_tooling');
  assert.ok(card.counterexample.diff_path);
});
