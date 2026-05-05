'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  runGoalVerify,
  scanStateMachineRepo,
} = require('../lib/goal_verify_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-state-machine-suite-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeScript(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
}

function workflowModel(overrides = {}) {
  return {
    states: ['cart', 'shipping', 'payment', 'confirmed'],
    initial_state: 'cart',
    terminal_states: ['confirmed'],
    impossible_states: ['cancelled', 'paid_without_shipping'],
    transitions: [
      { from: 'cart', command: 'add_shipping', to: 'shipping' },
      { from: 'shipping', command: 'add_payment', to: 'payment' },
      { from: 'payment', command: 'confirm', to: 'confirmed' },
    ],
    invariants: [
      { id: 'state-is-known', path: 'state', one_of: ['cart', 'shipping', 'payment', 'confirmed'] },
    ],
    ...overrides,
  };
}

function writeReplayScript(cwd, transitions = {}) {
  writeScript(path.join(cwd, 'replay.cjs'), [
    "const fs = require('fs');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "let state = input.initial_state && typeof input.initial_state === 'object' ? { ...input.initial_state } : { state: String(input.initial_state || 'cart') };",
    "const trace = [{ state }];",
    `const transitions = ${JSON.stringify(transitions || {})};`,
    "for (const command of input.commands || []) {",
    "  const type = typeof command === 'string' ? command : command.type;",
    "  const key = `${state.state}:${type}`;",
    "  state = { ...state, state: transitions[key] || state.state };",
    "  trace.push({ command: type, state });",
    "}",
    "process.stdout.write(JSON.stringify({ trace }));",
    '',
  ].join('\n'));
}

function writeReferenceScript(cwd, states) {
  writeScript(path.join(cwd, 'reference.cjs'), [
    `process.stdout.write(JSON.stringify({ states: ${JSON.stringify(states)} }));`,
    '',
  ].join('\n'));
}

function writeStateMachineGoal(cwd, options = {}) {
  const goalId = options.goalId || 'workflow';
  const goalPath = path.join(cwd, '.xoloop', 'goals', goalId, 'goal.yaml');
  const model = options.model || workflowModel();
  writeJson(path.join(cwd, '.xoloop', 'goals', goalId, 'models', 'workflow.json'), model);
  writeJson(path.join(cwd, '.xoloop', 'goals', goalId, 'cases', `${options.caseId || 'checkout'}.json`), {
    id: options.caseId || 'checkout',
    command: Object.prototype.hasOwnProperty.call(options, 'command') ? options.command : 'node replay.cjs',
    reference_command: options.referenceCommand || '',
    model_file: 'models/workflow.json',
    initial_state: options.initialState || { state: 'cart', total: 10 },
    commands: options.commands || [
      { type: 'add_shipping' },
      { type: 'add_payment' },
      { type: 'confirm' },
    ],
    expected_final_state: Object.prototype.hasOwnProperty.call(options, 'expectedFinalState') ? options.expectedFinalState : 'confirmed',
    terminal_states: options.terminalStates || ['confirmed'],
    impossible_states: options.impossibleStates || [],
    invariants: options.invariants || [],
    ...(options.caseExtra || {}),
  });
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: goalId,
    objective: 'Verify workflow transitions.',
    interface: {
      type: 'state-machine',
      command: 'node replay.cjs',
      stdin: 'json',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: ['replay.cjs'],
    },
    verify: {
      kind: 'state-machine-suite',
      command: Object.prototype.hasOwnProperty.call(options, 'goalCommand') ? options.goalCommand : '',
      cases: 'cases/*.json',
      properties: options.properties || [
        'case_present',
        'initial_state',
        'command_sequence_replay',
        'valid_transitions',
        'impossible_states',
        'terminal_state',
        'reference_model',
        'deterministic_replay',
        'invariant_checks',
        'transition_coverage',
        'counterexample_corpus',
      ],
      block_on_gaps: true,
      ...(options.verifyExtra || {}),
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'state_machine_replay_ms', direction: 'minimize', threshold: 0 },
      ],
    },
  });
  return goalPath;
}

test('state-machine scan detects workflow tools, files, models, and replay scripts', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: { 'workflow:replay': 'node replay.cjs', test: 'node --test' },
    dependencies: { xstate: '^5.0.0', bullmq: '^5.0.0', yjs: '^13.0.0' },
  });
  fs.mkdirSync(path.join(cwd, 'src', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'workflows', 'checkoutMachine.ts'), 'createMachine({});\n', 'utf8');
  fs.mkdirSync(path.join(cwd, 'models'), { recursive: true });
  writeJson(path.join(cwd, 'models', 'checkout-state-machine.json'), workflowModel());

  const scan = scanStateMachineRepo(cwd);

  assert.ok(scan.tools.some((tool) => tool.name === 'xstate'));
  assert.ok(scan.tools.some((tool) => tool.domain === 'queue'));
  assert.ok(scan.tools.some((tool) => tool.domain === 'crdt'));
  assert.ok(scan.domains.includes('checkout'));
  assert.ok(scan.workflow_files.some((file) => file.includes('checkoutMachine')));
  assert.ok(scan.model_files.some((file) => file.includes('checkout-state-machine')));
  assert.ok(scan.safe_commands.some((command) => command.kind === 'replay'));
});

test('state-machine-suite create writes harness assets and manifest', () => {
  const cwd = tmpDir();

  const created = createGoal({ cwd, kind: 'state-machine-suite', goalId: 'state-machine-suite', force: true });

  assert.equal(created.goal.verify.kind, 'state-machine-suite');
  assert.equal(created.goal.interface.type, 'state-machine');
  for (const dir of ['cases', 'models', 'traces', 'diffs', 'corpus']) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'state-machine-suite', dir)), true);
  }
});

test('state-machine-suite generated smoke harness reaches PASS_WITH_GAPS only for command determinism', async () => {
  const cwd = tmpDir();
  const created = createGoal({ cwd, kind: 'state-machine-suite', goalId: 'state-machine-suite', force: true });

  const { card } = await runGoalVerify(created.goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.equal(card.summary.failed, 0);
  assert.ok(card.missing_obligations.includes('deterministic_replay'));
});

test('state-machine-suite reaches PASS_EVIDENCED for checkout workflow replay', async () => {
  const cwd = tmpDir();
  writeReplayScript(cwd, {
    'cart:add_shipping': 'shipping',
    'shipping:add_payment': 'payment',
    'payment:confirm': 'confirmed',
  });
  const goalPath = writeStateMachineGoal(cwd);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.deepEqual(card.missing_obligations, []);
  assert.ok(card.summary.by_id.valid_transitions.passed > 0);
  assert.ok(card.summary.by_id.reference_model.passed > 0);
  assert.ok(card.summary.by_id.transition_coverage.passed > 0);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'workflow', 'traces', 'checkout.json')), true);
});

test('state-machine-suite fails when trace enters an impossible state', async () => {
  const cwd = tmpDir();
  writeReplayScript(cwd, {
    'cart:add_shipping': 'shipping',
    'shipping:cancel': 'cancelled',
  });
  const goalPath = writeStateMachineGoal(cwd, {
    model: workflowModel({
      states: ['cart', 'shipping', 'cancelled'],
      terminal_states: ['cancelled'],
      transitions: [
        { from: 'cart', command: 'add_shipping', to: 'shipping' },
        { from: 'shipping', command: 'cancel', to: 'cancelled' },
      ],
      impossible_states: ['cancelled'],
      invariants: [],
    }),
    commands: [{ type: 'add_shipping' }, { type: 'cancel' }],
    expectedFinalState: 'cancelled',
    terminalStates: ['cancelled'],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'impossible_states');
  assert.ok(card.counterexample.corpus_path);
  assert.equal(fs.existsSync(card.counterexample.corpus_path), true);
});

test('state-machine-suite fails when implementation differs from reference command', async () => {
  const cwd = tmpDir();
  writeReplayScript(cwd, {
    'cart:add_shipping': 'shipping',
    'shipping:add_payment': 'shipping',
  });
  writeReferenceScript(cwd, ['cart', 'shipping', 'payment']);
  const goalPath = writeStateMachineGoal(cwd, {
    model: { states: ['cart', 'shipping', 'payment'], impossible_states: [] },
    commands: [{ type: 'add_shipping' }, { type: 'add_payment' }],
    expectedFinalState: 'shipping',
    terminalStates: ['shipping'],
    referenceCommand: 'node reference.cjs',
    properties: [
      'case_present',
      'initial_state',
      'command_sequence_replay',
      'impossible_states',
      'terminal_state',
      'reference_model',
      'deterministic_replay',
      'counterexample_corpus',
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'reference_model');
  assert.ok(card.counterexample.diff_path);
});

test('state-machine-suite reports transition coverage gaps for uncovered model edges', async () => {
  const cwd = tmpDir();
  writeReplayScript(cwd, {
    'cart:add_shipping': 'shipping',
  });
  const goalPath = writeStateMachineGoal(cwd, {
    commands: [{ type: 'add_shipping' }],
    expectedFinalState: 'shipping',
    terminalStates: ['shipping'],
    properties: [
      'case_present',
      'initial_state',
      'command_sequence_replay',
      'valid_transitions',
      'impossible_states',
      'terminal_state',
      'reference_model',
      'deterministic_replay',
      'invariant_checks',
      'transition_coverage',
      'counterexample_corpus',
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.ok(card.summary.by_id.transition_coverage.gaps > 0);
  assert.ok(card.missing_obligations.includes('transition_coverage'));
});
