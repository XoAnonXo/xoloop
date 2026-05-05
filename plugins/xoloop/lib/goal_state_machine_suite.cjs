'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob, goalBaseDir, stableStringify } = require('./goal_manifest.cjs');
const { scanStateMachineRepo } = require('./goal_state_machine_scan.cjs');

const DEFAULT_STATE_MACHINE_OBLIGATIONS = [
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

function stableText(value) {
  const text = stableStringify(stableCopy(value));
  return text === undefined ? 'undefined' : text;
}

function artifactPath(goalPath, dirName, testCase, suffix = '.json') {
  return path.join(goalBaseDir(goalPath), dirName, `${sanitizeId(testCase.id)}${suffix}`);
}

function loadCaseFile(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`state-machine-suite case must be an object: ${filePath}`);
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') throw new Error(`state-machine-suite case must contain string id: ${filePath}`);
  return {
    ...parsed,
    id: parsed.id.trim(),
    command: typeof parsed.command === 'string' ? parsed.command : '',
    reference_command: typeof parsed.reference_command === 'string' ? parsed.reference_command : '',
    model_file: typeof parsed.model_file === 'string' ? parsed.model_file : '',
    initial_state: Object.prototype.hasOwnProperty.call(parsed, 'initial_state') ? parsed.initial_state : (Object.prototype.hasOwnProperty.call(parsed, 'initial') ? parsed.initial : null),
    commands: Array.isArray(parsed.commands) ? parsed.commands : [],
    actual_trace: Array.isArray(parsed.actual_trace) ? parsed.actual_trace : null,
    expected_final_state: Object.prototype.hasOwnProperty.call(parsed, 'expected_final_state') ? parsed.expected_final_state : undefined,
    terminal_states: Array.isArray(parsed.terminal_states) ? parsed.terminal_states : [],
    impossible_states: Array.isArray(parsed.impossible_states) ? parsed.impossible_states : [],
    invariants: Array.isArray(parsed.invariants) ? parsed.invariants : [],
    timeout_ms: Number.isFinite(parsed.timeout_ms) && parsed.timeout_ms > 0 ? Math.floor(parsed.timeout_ms) : 30000,
    metadata: parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata) ? parsed.metadata : {},
  };
}

function addPass(state, id, testCase, extra = {}) {
  state.verifications.push({ id, status: 'pass', case_id: testCase.id, ...extra });
}

function addGap(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'gap', case_id: testCase.id, message, ...extra });
}

function addFailure(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'fail', case_id: testCase.id, message, ...extra });
  if (!state.counterexample) state.counterexample = { case_id: testCase.id, obligation: id, message, ...extra };
}

function commandName(command) {
  if (typeof command === 'string') return command;
  if (!command || typeof command !== 'object') return '';
  return String(command.type || command.event || command.action || command.command || command.name || '');
}

function stateName(state) {
  if (typeof state === 'string' || typeof state === 'number' || typeof state === 'boolean') return String(state);
  if (!state || typeof state !== 'object') return '';
  return String(state.state || state.status || state.phase || state.screen || state.mode || state.step || state.name || '');
}

function normalizeTrace(payload, initialState = null, commands = []) {
  if (Array.isArray(payload)) return payload.map((item, index) => (item && typeof item === 'object' ? item : { state: item, index }));
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.trace)) return payload.trace.map((item, index) => (item && typeof item === 'object' ? item : { state: item, index }));
  if (Array.isArray(payload.states)) return payload.states.map((item, index) => ({ state: item, command: index === 0 ? null : commandName(commands[index - 1]), index }));
  if (Object.prototype.hasOwnProperty.call(payload, 'final_state') || Object.prototype.hasOwnProperty.call(payload, 'state')) {
    const trace = [];
    if (initialState !== null && initialState !== undefined) trace.push({ state: initialState, command: null, index: 0 });
    trace.push({ state: Object.prototype.hasOwnProperty.call(payload, 'final_state') ? payload.final_state : payload.state, command: commands.length ? commandName(commands[commands.length - 1]) : null, index: trace.length });
    return trace;
  }
  return [];
}

async function runJsonCommand(command, cwd, input, timeoutMs) {
  const result = await runCliCommand(command, `${JSON.stringify(input)}\n`, { cwd, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  let json = null;
  let jsonError = null;
  try {
    json = result.stdout ? JSON.parse(result.stdout) : null;
  } catch (err) {
    jsonError = err.message;
  }
  return { result, json, jsonError };
}

function loadModel(goal, goalPath, testCase) {
  if (testCase.model && typeof testCase.model === 'object' && !Array.isArray(testCase.model)) return testCase.model;
  if (goal.verify.model && typeof goal.verify.model === 'object' && !Array.isArray(goal.verify.model)) return goal.verify.model;
  const file = testCase.model_file || goal.verify.model_file || '';
  if (!file) return {};
  const absolute = path.isAbsolute(file) ? file : path.resolve(goalBaseDir(goalPath), file);
  const parsed = readJsonMaybe(absolute);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function transitionCommand(transition) {
  return String(transition.command || transition.event || transition.action || transition.type || '');
}

function transitionFrom(transition) {
  return String(transition.from || transition.source || '*');
}

function transitionTo(transition) {
  return Object.prototype.hasOwnProperty.call(transition, 'to') ? transition.to : transition.target;
}

function declaredTransitions(model) {
  return Array.isArray(model.transitions)
    ? model.transitions.filter((transition) => transition && typeof transition === 'object' && !Array.isArray(transition))
    : [];
}

function findTransition(model, from, command) {
  const transitions = declaredTransitions(model);
  return transitions.find((transition) => {
    const fromMatch = transitionFrom(transition) === '*' || transitionFrom(transition) === from;
    const commandMatch = transitionCommand(transition) === '*' || transitionCommand(transition) === command;
    return fromMatch && commandMatch;
  });
}

function replayModel(initialState, commands, model) {
  const trace = [{ state: initialState, command: null, index: 0 }];
  let current = initialState;
  const invalid = [];
  for (let i = 0; i < commands.length; i += 1) {
    const command = commandName(commands[i]);
    const from = stateName(current);
    const transition = findTransition(model, from, command);
    if (!transition) {
      invalid.push({ index: i, from, command, message: 'no declared transition' });
      trace.push({ state: current, command, index: i + 1, invalid: true });
      continue;
    }
    current = transitionTo(transition);
    trace.push({ state: current, command, index: i + 1 });
  }
  return { trace, invalid };
}

function traceStates(trace) {
  return trace.map((step) => stateName(Object.prototype.hasOwnProperty.call(step, 'state') ? step.state : step));
}

function traceCommands(trace) {
  return trace.slice(1).map((step) => commandName(step.command || step.event || step.action || step));
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

function stateMatches(actual, expected) {
  if (expected === null || typeof expected !== 'object') return stateName(actual) === String(expected);
  if (expected.state || expected.status || expected.phase || expected.screen || expected.mode || expected.step) return stateName(actual) === stateName(expected);
  if (expected.where && typeof expected.where === 'object') {
    return Object.entries(expected.where).every(([pathExpr, value]) =>
      valuesAtPath(actual, pathExpr).some((actualValue) => stableText(actualValue) === stableText(value)));
  }
  return stableText(actual) === stableText(expected);
}

function checkInvariants(trace, invariants) {
  const failures = [];
  for (let index = 0; index < trace.length; index += 1) {
    const state = Object.prototype.hasOwnProperty.call(trace[index], 'state') ? trace[index].state : trace[index];
    for (const invariant of invariants) {
      if (!invariant || typeof invariant !== 'object' || Array.isArray(invariant)) continue;
      const id = invariant.id || invariant.path || `invariant-${failures.length + 1}`;
      const values = valuesAtPath(state, invariant.path || '');
      if (invariant.required === true && values.length === 0) failures.push({ index, id, message: 'required path missing' });
      if (invariant.not_null === true && (values.length === 0 || values.some((value) => value === null || value === undefined))) failures.push({ index, id, message: 'null value found' });
      if (invariant.type && (values.length === 0 || values.some((value) => !typeMatches(value, invariant.type)))) failures.push({ index, id, message: `expected type ${invariant.type}` });
      if (Object.prototype.hasOwnProperty.call(invariant, 'equals') && (values.length === 0 || values.some((value) => stableText(value) !== stableText(invariant.equals)))) failures.push({ index, id, message: 'value did not equal expected' });
      if (Array.isArray(invariant.one_of) && (values.length === 0 || values.some((value) => !invariant.one_of.some((candidate) => stableText(candidate) === stableText(value))))) failures.push({ index, id, message: 'value outside allowed set' });
      if (Number.isFinite(invariant.gte) && values.some((value) => !Number.isFinite(value) || value < invariant.gte)) failures.push({ index, id, message: `value below ${invariant.gte}` });
      if (Number.isFinite(invariant.lte) && values.some((value) => !Number.isFinite(value) || value > invariant.lte)) failures.push({ index, id, message: `value above ${invariant.lte}` });
    }
  }
  return failures;
}

function commandTail(result) {
  return {
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout_tail: String(result.stdout || '').slice(-2000),
    stderr_tail: String(result.stderr || '').slice(-2000),
    metrics: result.metrics || {},
  };
}

async function observeTrace(goal, goalPath, testCase, cwd, state) {
  const input = { initial_state: testCase.initial_state, commands: testCase.commands, metadata: testCase.metadata };
  const command = testCase.command || goal.verify.command || '';
  if (command) {
    const capture = await runJsonCommand(command, cwd, input, testCase.timeout_ms || goal.interface.timeout_ms);
    state.metrics.push(capture.result.metrics);
    state.trace.commands.push({ phase: 'replay', command, ...commandTail(capture.result), json_error: capture.jsonError });
    if (capture.result.exitCode !== 0) {
      addFailure(state, 'command_sequence_replay', testCase, 'workflow replay command failed', { result: commandTail(capture.result) });
      return [];
    }
    if (capture.jsonError) {
      const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-replay-parse.json'), {
        stdout_tail: String(capture.result.stdout || '').slice(-4000),
        json_error: capture.jsonError,
      });
      addFailure(state, 'command_sequence_replay', testCase, 'workflow replay command did not emit JSON', { diff_path });
      return [];
    }
    const trace = normalizeTrace(capture.json, testCase.initial_state, testCase.commands);
    if (trace.length > 0) addPass(state, 'command_sequence_replay', testCase, { steps: trace.length });
    else addFailure(state, 'command_sequence_replay', testCase, 'workflow replay emitted no trace');
    return trace;
  }
  if (testCase.actual_trace) {
    addPass(state, 'command_sequence_replay', testCase, { source: 'actual_trace', steps: testCase.actual_trace.length });
    return normalizeTrace(testCase.actual_trace, testCase.initial_state, testCase.commands);
  }
  addGap(state, 'command_sequence_replay', testCase, 'no replay command or actual trace declared');
  return [];
}

async function referenceTrace(goal, goalPath, testCase, model, cwd, state) {
  const command = testCase.reference_command || goal.verify.reference_command || '';
  const input = { initial_state: testCase.initial_state, commands: testCase.commands, metadata: testCase.metadata };
  if (command) {
    const capture = await runJsonCommand(command, cwd, input, testCase.timeout_ms || goal.interface.timeout_ms);
    state.metrics.push(capture.result.metrics);
    state.trace.commands.push({ phase: 'reference', command, ...commandTail(capture.result), json_error: capture.jsonError });
    if (capture.result.exitCode !== 0 || capture.jsonError) return { trace: [], error: capture.jsonError || `reference command exited ${capture.result.exitCode}` };
    return { trace: normalizeTrace(capture.json, testCase.initial_state, testCase.commands), error: null };
  }
  if (declaredTransitions(model).length > 0) return { ...replayModel(testCase.initial_state, testCase.commands, model), error: null };
  return { trace: [], invalid: [], error: 'no reference command or transition model declared' };
}

function verifyInitialState(testCase, state, actualTrace) {
  if (testCase.initial_state === null || testCase.initial_state === undefined) {
    addGap(state, 'initial_state', testCase, 'no initial state declared');
    return;
  }
  if (actualTrace.length === 0 || stateMatches(actualTrace[0].state, testCase.initial_state)) addPass(state, 'initial_state', testCase);
  else addFailure(state, 'initial_state', testCase, 'observed trace did not start at declared initial state', { expected: testCase.initial_state, actual: actualTrace[0] });
}

function verifyValidTransitions(goalPath, testCase, state, actualTrace, model) {
  const transitions = declaredTransitions(model);
  if (transitions.length === 0) {
    addGap(state, 'valid_transitions', testCase, 'no transition model declared');
    return [];
  }
  const failures = [];
  const observed = [];
  for (let i = 1; i < actualTrace.length; i += 1) {
    const from = stateName(actualTrace[i - 1].state);
    const command = commandName(actualTrace[i].command || testCase.commands[i - 1]);
    const to = stateName(actualTrace[i].state);
    observed.push(`${from}|${command}|${to}`);
    const transition = findTransition(model, from, command);
    if (!transition) failures.push({ index: i, from, command, to, message: 'transition not declared' });
    else if (stateName(transitionTo(transition)) !== to) failures.push({ index: i, from, command, expected: stateName(transitionTo(transition)), actual: to, message: 'transition target mismatch' });
  }
  if (failures.length === 0) addPass(state, 'valid_transitions', testCase, { transitions: Math.max(0, actualTrace.length - 1) });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-valid-transitions.json'), { failures, trace: actualTrace, model });
    addFailure(state, 'valid_transitions', testCase, 'observed trace violated transition model', { diff_path, failures: failures.slice(0, 10) });
  }
  return observed;
}

function verifyImpossibleStates(goal, goalPath, testCase, state, actualTrace, model) {
  const impossible = [
    ...(Array.isArray(goal.verify.impossible_states) ? goal.verify.impossible_states : []),
    ...(Array.isArray(model.impossible_states) ? model.impossible_states : []),
    ...testCase.impossible_states,
  ];
  const validStates = new Set([
    ...(Array.isArray(goal.verify.valid_states) ? goal.verify.valid_states.map(String) : []),
    ...(Array.isArray(model.states) ? model.states.map(String) : []),
  ]);
  const violations = [];
  for (let i = 0; i < actualTrace.length; i += 1) {
    const actual = actualTrace[i].state;
    if (impossible.some((candidate) => stateMatches(actual, candidate))) violations.push({ index: i, state: actual, message: 'entered impossible state' });
    if (validStates.size > 0 && !validStates.has(stateName(actual))) violations.push({ index: i, state: actual, message: 'state outside declared state set' });
  }
  if (violations.length > 0) {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-impossible-states.json'), { violations, trace: actualTrace });
    addFailure(state, 'impossible_states', testCase, 'trace entered an impossible or undeclared state', { diff_path, violations: violations.slice(0, 10) });
  } else if (impossible.length > 0 || validStates.size > 0) {
    addPass(state, 'impossible_states', testCase);
  } else {
    addGap(state, 'impossible_states', testCase, 'no impossible states or valid state set declared');
  }
}

function verifyTerminalState(goal, goalPath, testCase, state, actualTrace, model) {
  if (actualTrace.length === 0) return;
  const finalState = actualTrace[actualTrace.length - 1].state;
  const terminalStates = [
    ...testCase.terminal_states,
    ...(Array.isArray(goal.verify.terminal_states) ? goal.verify.terminal_states : []),
    ...(Array.isArray(model.terminal_states) ? model.terminal_states : []),
  ];
  if (testCase.expected_final_state !== undefined) terminalStates.push(testCase.expected_final_state);
  if (terminalStates.length === 0) {
    addGap(state, 'terminal_state', testCase, 'no expected or terminal state declared');
    return;
  }
  if (terminalStates.some((candidate) => stateMatches(finalState, candidate))) addPass(state, 'terminal_state', testCase, { final_state: stateName(finalState) });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-terminal-state.json'), { expected: terminalStates, actual: finalState, trace: actualTrace });
    addFailure(state, 'terminal_state', testCase, 'final state did not match expected terminal state', { diff_path });
  }
}

function verifyReference(goalPath, testCase, state, actualTrace, reference) {
  if (reference.error) {
    addGap(state, 'reference_model', testCase, reference.error);
    return;
  }
  if (reference.invalid && reference.invalid.length > 0) {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-reference-invalid.json'), { invalid: reference.invalid });
    addFailure(state, 'reference_model', testCase, 'reference model could not replay the command sequence', { diff_path, invalid: reference.invalid });
    return;
  }
  const actualStates = traceStates(actualTrace);
  const expectedStates = traceStates(reference.trace);
  if (expectedStates.length === 0) {
    addGap(state, 'reference_model', testCase, 'reference model produced no trace');
    return;
  }
  if (stableText(actualStates) === stableText(expectedStates)) addPass(state, 'reference_model', testCase, { states: actualStates.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-reference-model.json'), { expected_states: expectedStates, actual_states: actualStates, actual_trace: actualTrace, reference_trace: reference.trace });
    addFailure(state, 'reference_model', testCase, 'implementation trace differed from reference model', { diff_path });
  }
}

async function verifyDeterminism(goal, goalPath, testCase, cwd, state, firstTrace) {
  const command = testCase.command || goal.verify.command || '';
  if (!command) {
    addGap(state, 'deterministic_replay', testCase, 'no replay command declared for deterministic replay');
    return;
  }
  const second = await observeTrace(goal, goalPath, { ...testCase, id: `${testCase.id}-deterministic`, actual_trace: null }, cwd, { ...state, verifications: [], counterexample: null });
  if (stableText(traceStates(firstTrace)) === stableText(traceStates(second))) addPass(state, 'deterministic_replay', testCase);
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-deterministic-replay.json'), { first: firstTrace, second });
    addFailure(state, 'deterministic_replay', testCase, 'same command sequence produced a different trace', { diff_path });
  }
}

function verifyInvariants(goal, goalPath, testCase, state, actualTrace, model) {
  const invariants = [
    ...(Array.isArray(goal.verify.invariants) ? goal.verify.invariants : []),
    ...(Array.isArray(model.invariants) ? model.invariants : []),
    ...testCase.invariants,
  ];
  if (invariants.length === 0) {
    addGap(state, 'invariant_checks', testCase, 'no state invariants declared');
    return;
  }
  const failures = checkInvariants(actualTrace, invariants);
  if (failures.length === 0) addPass(state, 'invariant_checks', testCase, { invariant_count: invariants.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-invariant-checks.json'), { failures, trace: actualTrace });
    addFailure(state, 'invariant_checks', testCase, 'state invariants failed during replay', { diff_path, failures: failures.slice(0, 10) });
  }
}

async function verifyOneCase(goal, goalPath, testCase, cwd = process.cwd()) {
  const state = { verifications: [], metrics: [], counterexample: null, trace: { case: testCase, commands: [] }, observedTransitions: [] };
  addPass(state, 'case_present', testCase);
  addPass(state, 'counterexample_corpus', testCase, { corpus_dir: path.join(goalBaseDir(goalPath), 'corpus') });
  const model = loadModel(goal, goalPath, testCase);
  const actualTrace = await observeTrace(goal, goalPath, testCase, cwd, state);
  writeJson(artifactPath(goalPath, 'traces', testCase), { ...state.trace, actual_trace: actualTrace });

  verifyInitialState(testCase, state, actualTrace);
  state.observedTransitions = verifyValidTransitions(goalPath, testCase, state, actualTrace, model);
  verifyImpossibleStates(goal, goalPath, testCase, state, actualTrace, model);
  verifyTerminalState(goal, goalPath, testCase, state, actualTrace, model);
  const reference = await referenceTrace(goal, goalPath, testCase, model, cwd, state);
  verifyReference(goalPath, testCase, state, actualTrace, reference);
  await verifyDeterminism(goal, goalPath, testCase, cwd, state, actualTrace);
  verifyInvariants(goal, goalPath, testCase, state, actualTrace, model);
  return state;
}

function aggregateMetrics(samples) {
  const byName = {};
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value)) continue;
      const metricName = key === 'wall_time_ms' ? 'state_machine_replay_ms' : key;
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

function transitionCoverage(goal, goalPath, cases, results) {
  const declared = new Set();
  for (const testCase of cases) {
    const model = loadModel(goal, goalPath, testCase);
    for (const transition of declaredTransitions(model)) declared.add(`${transitionFrom(transition)}|${transitionCommand(transition)}|${stateName(transitionTo(transition))}`);
  }
  if (goal.verify.model) {
    for (const transition of declaredTransitions(goal.verify.model)) declared.add(`${transitionFrom(transition)}|${transitionCommand(transition)}|${stateName(transitionTo(transition))}`);
  }
  if (declared.size === 0) return { status: 'gap', message: 'no declared transitions for coverage map', missing: [] };
  const observed = new Set(results.flatMap((result) => result.observedTransitions || []));
  const missing = [...declared].filter((key) => !observed.has(key)).sort();
  if (missing.length === 0) return { status: 'pass', declared: declared.size, observed: observed.size, missing };
  return { status: 'gap', declared: declared.size, observed: observed.size, missing, message: 'not all declared transitions were replayed' };
}

function writeCorpusCase(goalPath, testCase, counterexample) {
  return writeJson(artifactPath(goalPath, 'corpus', testCase), { case: testCase, counterexample });
}

async function runStateMachineSuiteVerification(goal, goalPath, options = {}) {
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
  const results = [];
  let counterexample = null;
  for (const testCase of selectedCases) {
    const result = await verifyOneCase(goal, goalPath, testCase, options.cwd || process.cwd());
    results.push(result);
    verifications.push(...result.verifications);
    metrics.push(...result.metrics);
    if (result.counterexample && !counterexample) {
      counterexample = result.counterexample;
      counterexample.corpus_path = writeCorpusCase(goalPath, testCase, counterexample);
    }
  }
  const coverage = transitionCoverage(goal, goalPath, selectedCases, results);
  verifications.push({ id: 'transition_coverage', status: coverage.status, message: coverage.message, declared: coverage.declared || 0, observed: coverage.observed || 0, missing: coverage.missing || [] });
  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: aggregateMetrics(metrics),
    counterexample,
  };
}

function writeStateMachineSuiteAssets(goalDir, options = {}) {
  for (const dir of ['cases', 'models', 'traces', 'diffs', 'corpus']) fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  const model = {
    states: ['start', 'done'],
    initial_state: 'start',
    terminal_states: ['done'],
    transitions: [
      { from: 'start', command: 'finish', to: 'done' },
    ],
    impossible_states: ['impossible'],
    invariants: [
      { id: 'state-name-present', path: 'state', type: 'string' },
    ],
  };
  writeJson(path.join(goalDir, 'models', 'workflow-model.json'), model);
  writeJson(path.join(goalDir, 'cases', 'workflow-smoke.json'), {
    id: 'workflow-smoke',
    initial_state: { state: 'start' },
    commands: [{ type: 'finish' }],
    actual_trace: [{ state: { state: 'start' } }, { command: 'finish', state: { state: 'done' } }],
    model_file: 'models/workflow-model.json',
    expected_final_state: 'done',
    metadata: {
      note: 'Replace actual_trace or add command with a real workflow replay executable before optimizing state-machine code.',
    },
  });
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# State machine/workflow verification goal',
    '',
    'Generated by `xoloop-verify create --kind state-machine-suite`.',
    '',
    'Cases declare initial state, command/event sequences, a replay command',
    'or observed trace, model transitions, impossible states, invariants,',
    'terminal states, and optional reference commands. Verify records traces,',
    'diffs, transition coverage, and counterexample corpus files here.',
    '',
  ].join('\n'), 'utf8');
}

function buildStateMachineSuiteGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'state-machine-suite';
  const scan = options.scan || scanStateMachineRepo(cwd);
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve state-machine and workflow semantics: valid transitions, impossible states, replayed command sequences, terminal states, invariants, and reference-model equivalence while optimizing.',
    interface: {
      type: 'state-machine',
      command: options.command || 'xoloop state-machine verification harness',
      stdin: 'json',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: scan.artifact_paths || [],
    },
    verify: {
      kind: 'state-machine-suite',
      command: options.command || '',
      cases: 'cases/*.json',
      properties: DEFAULT_STATE_MACHINE_OBLIGATIONS,
      model_file: 'models/workflow-model.json',
      scan,
      block_on_gaps: true,
    },
    metrics: {
      repeat: 3,
      targets: [
        { name: 'state_machine_replay_ms', direction: 'minimize', threshold: 0.03 },
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
  DEFAULT_STATE_MACHINE_OBLIGATIONS,
  buildStateMachineSuiteGoal,
  runStateMachineSuiteVerification,
  scanStateMachineRepo,
  writeStateMachineSuiteAssets,
};
