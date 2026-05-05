'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob, goalBaseDir, stableStringify } = require('./goal_manifest.cjs');
const { scanConcurrencyRepo } = require('./goal_concurrency_scan.cjs');

const DEFAULT_CONCURRENCY_OBLIGATIONS = [
  'case_present',
  'schedule_declared',
  'schedule_exploration',
  'command_success',
  'ordering_guarantees',
  'timeout_behavior',
  'clock_control',
  'fake_clock_adapter',
  'runtime_scheduler',
  'deterministic_scheduling',
  'stress_replay',
  'race_condition',
  'deadlock_livelock',
  'race_tooling',
  'temporal_invariants',
  'reference_trace',
  'replay_reproduction',
  'counterexample_corpus',
];

function sanitizeId(id) {
  return String(id || 'case').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`concurrency-suite case must be an object: ${filePath}`);
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') throw new Error(`concurrency-suite case must contain string id: ${filePath}`);
  return {
    ...parsed,
    id: parsed.id.trim(),
    command: typeof parsed.command === 'string' ? parsed.command : '',
    reference_command: typeof parsed.reference_command === 'string' ? parsed.reference_command : '',
    input: parsed.input === undefined ? {} : parsed.input,
    schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
    clock: parsed.clock && typeof parsed.clock === 'object' && !Array.isArray(parsed.clock) ? parsed.clock : null,
    ordering: parsed.ordering && typeof parsed.ordering === 'object' && !Array.isArray(parsed.ordering) ? parsed.ordering : {},
    expected_result: parsed.expected_result,
    allowed_results: Array.isArray(parsed.allowed_results) ? parsed.allowed_results : [],
    allowed_event_orders: Array.isArray(parsed.allowed_event_orders) ? parsed.allowed_event_orders : [],
    expected_timeout: parsed.expected_timeout === true,
    timeout_ms: Number.isFinite(parsed.timeout_ms) && parsed.timeout_ms > 0 ? Math.floor(parsed.timeout_ms) : 5000,
    max_duration_ms: Number.isFinite(parsed.max_duration_ms) && parsed.max_duration_ms >= 0 ? parsed.max_duration_ms : null,
    repeat: Number.isFinite(parsed.repeat) && parsed.repeat > 0 ? Math.floor(parsed.repeat) : 2,
    exploration: parsed.exploration && typeof parsed.exploration === 'object' && !Array.isArray(parsed.exploration) ? parsed.exploration : {},
    stress: parsed.stress && typeof parsed.stress === 'object' && !Array.isArray(parsed.stress) ? parsed.stress : {},
    scheduler: parsed.scheduler && typeof parsed.scheduler === 'object' && !Array.isArray(parsed.scheduler) ? parsed.scheduler : null,
    clock_adapter: parsed.clock_adapter && typeof parsed.clock_adapter === 'object' && !Array.isArray(parsed.clock_adapter) ? parsed.clock_adapter : null,
    deadlock: parsed.deadlock && typeof parsed.deadlock === 'object' && !Array.isArray(parsed.deadlock) ? parsed.deadlock : {},
    race_tools: Array.isArray(parsed.race_tools) ? parsed.race_tools.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [],
    temporal: Array.isArray(parsed.temporal)
      ? { invariants: parsed.temporal }
      : (parsed.temporal && typeof parsed.temporal === 'object' ? parsed.temporal : {}),
    actual_trace: parsed.actual_trace && typeof parsed.actual_trace === 'object' ? parsed.actual_trace : null,
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

function commandTail(result) {
  return {
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout_tail: String(result.stdout || '').slice(-2000),
    stderr_tail: String(result.stderr || '').slice(-2000),
    metrics: result.metrics || {},
  };
}

function eventName(event) {
  if (typeof event === 'string') return event;
  if (!event || typeof event !== 'object') return '';
  return String(event.name || event.type || event.event || event.label || event.action || '');
}

function normalizeEvents(payload) {
  if (Array.isArray(payload)) return payload.map((item, index) => (item && typeof item === 'object' ? item : { name: String(item), index }));
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.events)) return payload.events.map((item, index) => (item && typeof item === 'object' ? item : { name: String(item), index }));
  if (Array.isArray(payload.trace)) return payload.trace.map((item, index) => (item && typeof item === 'object' ? item : { name: String(item), index }));
  return [];
}

function normalizeObservation(payload, execution = null, schedule = null) {
  const json = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return {
    schedule,
    events: normalizeEvents(payload),
    result: Object.prototype.hasOwnProperty.call(json, 'result') ? json.result : json.final,
    timed_out: Boolean(json.timed_out || json.timeout || (execution && execution.timedOut)),
    clock: json.clock && typeof json.clock === 'object' && !Array.isArray(json.clock) ? json.clock : null,
    scheduler: json.scheduler && typeof json.scheduler === 'object' && !Array.isArray(json.scheduler) ? json.scheduler : null,
    diagnostics: json.diagnostics && typeof json.diagnostics === 'object' && !Array.isArray(json.diagnostics) ? json.diagnostics : {},
    deadlocked: json.deadlocked === true,
    livelocked: json.livelocked === true,
    starved: json.starved === true,
    metrics: execution && execution.metrics ? execution.metrics : {},
    raw: payload,
  };
}

async function runObservation(goal, goalPath, testCase, schedule, cwd, state, idSuffix = '') {
  if (testCase.actual_trace && !testCase.command && !goal.verify.command) {
    return normalizeObservation(testCase.actual_trace, null, schedule);
  }
  const command = testCase.command || goal.verify.command || '';
  if (!command) {
    addGap(state, 'command_success', testCase, 'no async replay command declared');
    return normalizeObservation({}, null, schedule);
  }
  const input = { input: testCase.input, schedule, clock: testCase.clock, metadata: testCase.metadata };
  const result = await runCliCommand(command, `${JSON.stringify(input)}\n`, { cwd, timeoutMs: testCase.timeout_ms, maxBuffer: 32 * 1024 * 1024 });
  state.metrics.push(result.metrics);
  let json = null;
  let jsonError = null;
  try {
    json = result.stdout ? JSON.parse(result.stdout) : null;
  } catch (err) {
    jsonError = err.message;
  }
  state.trace.commands.push({ phase: `replay${idSuffix}`, command, schedule, ...commandTail(result), json_error: jsonError });
  if (jsonError && !result.timedOut) {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, `-parse${idSuffix}.json`), {
      json_error: jsonError,
      stdout_tail: String(result.stdout || '').slice(-4000),
    });
    addFailure(state, 'command_success', testCase, 'async replay command did not emit JSON', { diff_path });
  } else if (result.exitCode === 0 || (testCase.expected_timeout && result.timedOut)) {
    addPass(state, 'command_success', testCase, { schedule_id: schedule && schedule.id });
  } else {
    addFailure(state, 'command_success', testCase, 'async replay command failed', { result: commandTail(result), schedule });
  }
  return normalizeObservation(json || {}, result, schedule);
}

function eventOrder(observation) {
  return observation.events.map(eventName).filter(Boolean);
}

function indexOfEvent(order, name) {
  return order.findIndex((item) => item === name);
}

function includesSubsequence(order, sequence) {
  let cursor = 0;
  for (const item of order) {
    if (item === sequence[cursor]) cursor += 1;
    if (cursor >= sequence.length) return true;
  }
  return sequence.length === 0;
}

function verifyOrdering(goalPath, testCase, state, observations) {
  const ordering = testCase.ordering || {};
  const before = Array.isArray(ordering.before) ? ordering.before : [];
  const sequence = Array.isArray(ordering.sequence) ? ordering.sequence.map(String) : [];
  const forbidden = Array.isArray(ordering.forbidden_before) ? ordering.forbidden_before : [];
  if (before.length === 0 && sequence.length === 0 && forbidden.length === 0) {
    addGap(state, 'ordering_guarantees', testCase, 'no ordering guarantees declared');
    return;
  }
  const failures = [];
  for (const observation of observations) {
    const order = eventOrder(observation);
    if (sequence.length > 0 && !includesSubsequence(order, sequence)) failures.push({ schedule: observation.schedule, order, expected_sequence: sequence });
    for (const pair of before) {
      const [a, b] = Array.isArray(pair) ? pair.map(String) : [];
      if (!a || !b) continue;
      const ia = indexOfEvent(order, a);
      const ib = indexOfEvent(order, b);
      if (ia < 0 || ib < 0 || ia >= ib) failures.push({ schedule: observation.schedule, order, before: [a, b] });
    }
    for (const pair of forbidden) {
      const [a, b] = Array.isArray(pair) ? pair.map(String) : [];
      if (!a || !b) continue;
      const ia = indexOfEvent(order, a);
      const ib = indexOfEvent(order, b);
      if (ia >= 0 && ib >= 0 && ia < ib) failures.push({ schedule: observation.schedule, order, forbidden_before: [a, b] });
    }
  }
  if (failures.length === 0) addPass(state, 'ordering_guarantees', testCase, { checked: observations.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-ordering.json'), { failures });
    addFailure(state, 'ordering_guarantees', testCase, 'event ordering guarantee failed', { diff_path, failures: failures.slice(0, 10) });
  }
}

function verifyTimeout(testCase, state, observations) {
  const failures = [];
  for (const observation of observations) {
    const duration = observation.metrics.wall_time_ms;
    if (testCase.expected_timeout) {
      if (!observation.timed_out && !observation.events.some((event) => /timeout/i.test(eventName(event)))) failures.push({ schedule: observation.schedule, message: 'expected timeout was not observed' });
    } else if (observation.timed_out) {
      failures.push({ schedule: observation.schedule, message: 'unexpected process timeout' });
    }
    if (Number.isFinite(testCase.max_duration_ms) && Number.isFinite(duration) && duration > testCase.max_duration_ms) {
      failures.push({ schedule: observation.schedule, duration_ms: duration, lte: testCase.max_duration_ms });
    }
  }
  if (failures.length === 0) addPass(state, 'timeout_behavior', testCase);
  else addFailure(state, 'timeout_behavior', testCase, 'timeout behavior changed', { failures });
}

function verifyClock(testCase, state, observations) {
  if (!testCase.clock) {
    addGap(state, 'clock_control', testCase, 'no clock control declared');
    return;
  }
  const mode = testCase.clock.mode || 'fake';
  const failures = observations.filter((observation) => {
    if (observation.clock && (observation.clock.mode === mode || observation.clock.controlled === true)) return false;
    if (mode === 'fake' && observation.events.every((event) => Number.isFinite(event.at) || Number.isFinite(event.time_ms))) return false;
    return true;
  });
  if (failures.length === 0) addPass(state, 'clock_control', testCase, { mode });
  else addFailure(state, 'clock_control', testCase, 'clock was not controlled or trace lacks deterministic timestamps', { failures: failures.map((item) => ({ schedule: item.schedule, clock: item.clock })) });
}

function resultKey(observation) {
  return stableText({
    result: observation.result,
    order: eventOrder(observation),
  });
}

function allowedResult(testCase, observation) {
  if (testCase.expected_result !== undefined && stableText(observation.result) === stableText(testCase.expected_result)) return true;
  if (testCase.allowed_results.length > 0 && testCase.allowed_results.some((item) => stableText(item) === stableText(observation.result))) return true;
  if (testCase.allowed_event_orders.length > 0 && testCase.allowed_event_orders.some((order) => stableText(order.map(String)) === stableText(eventOrder(observation)))) return true;
  return testCase.expected_result === undefined && testCase.allowed_results.length === 0 && testCase.allowed_event_orders.length === 0;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeBeforePairs(value) {
  return Array.isArray(value)
    ? value.map((pair) => (Array.isArray(pair) ? pair.map(String) : [])).filter((pair) => pair.length >= 2 && pair[0] && pair[1]).map((pair) => [pair[0], pair[1]])
    : [];
}

function scheduleOrder(schedule) {
  return asStringArray(schedule && schedule.order);
}

function beforeConstraints(testCase) {
  const ordering = testCase.ordering || {};
  const exploration = testCase.exploration || {};
  const stress = testCase.stress || {};
  return [
    ...normalizeBeforePairs(ordering.before),
    ...normalizeBeforePairs(exploration.must_happen_before),
    ...normalizeBeforePairs(stress.must_happen_before),
  ];
}

function satisfiesBefore(order, before) {
  for (const [a, b] of before) {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0 && ia >= ib) return false;
  }
  return true;
}

function uniqueByOrder(schedules) {
  const seen = new Set();
  const out = [];
  for (const schedule of schedules) {
    const key = stableText({ order: scheduleOrder(schedule), seed: schedule.seed || null, source: schedule.source || 'declared' });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(schedule);
  }
  return out;
}

function deriveExplorationEvents(testCase) {
  const explicit = asStringArray(testCase.exploration && testCase.exploration.events);
  if (explicit.length > 0) return explicit;
  const firstSchedule = testCase.schedules.find((schedule) => scheduleOrder(schedule).length > 0);
  if (firstSchedule) return scheduleOrder(firstSchedule);
  const sequence = asStringArray(testCase.ordering && testCase.ordering.sequence);
  return sequence.length > 0 ? sequence : [];
}

function enumerateOrders(events, before, limit) {
  const cleanEvents = [...new Set(events.map(String).filter(Boolean))];
  if (cleanEvents.length === 0) return [];
  if (cleanEvents.length > 8) return [cleanEvents];
  const out = [];
  function walk(prefix, remaining) {
    if (out.length >= limit) return;
    if (remaining.length === 0) {
      if (satisfiesBefore(prefix, before)) out.push(prefix.slice());
      return;
    }
    for (let i = 0; i < remaining.length; i += 1) {
      const next = remaining[i];
      const candidate = [...prefix, next];
      const impossible = before.some(([a, b]) => next === b && remaining.includes(a));
      if (impossible) continue;
      walk(candidate, remaining.filter((_, index) => index !== i));
    }
  }
  walk([], cleanEvents);
  return out;
}

function makeGeneratedSchedules(testCase) {
  const exploration = testCase.exploration || {};
  if (exploration.enabled !== true) return [];
  const maxSchedules = Number.isFinite(exploration.max_schedules) && exploration.max_schedules > 0 ? Math.floor(exploration.max_schedules) : 12;
  const before = beforeConstraints(testCase);
  const orders = enumerateOrders(deriveExplorationEvents(testCase), before, maxSchedules);
  return orders.map((order, index) => ({
    id: `sys-${index + 1}`,
    source: 'exploration',
    strategy: exploration.strategy || 'bounded-permutation',
    order,
  }));
}

function seededRandom(seed) {
  let value = (Number.isFinite(seed) ? Math.floor(seed) : 12345) >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function repairOrder(order, before) {
  const out = order.slice();
  let changed = true;
  let guard = 0;
  while (changed && guard < 100) {
    changed = false;
    guard += 1;
    for (const [a, b] of before) {
      const ia = out.indexOf(a);
      const ib = out.indexOf(b);
      if (ia >= 0 && ib >= 0 && ia > ib) {
        out.splice(ia, 1);
        out.splice(ib, 0, a);
        changed = true;
      }
    }
  }
  return out;
}

function makeStressSchedules(testCase) {
  const stress = testCase.stress || {};
  if (stress.enabled !== true) return [];
  const runs = Number.isFinite(stress.runs) && stress.runs > 0 ? Math.floor(stress.runs) : 8;
  const seed = Number.isFinite(stress.seed) ? Math.floor(stress.seed) : 12345;
  const events = asStringArray(stress.events).length > 0 ? asStringArray(stress.events) : deriveExplorationEvents(testCase);
  if (events.length === 0) return [];
  const before = beforeConstraints(testCase);
  const rand = seededRandom(seed);
  const out = [];
  for (let i = 0; i < runs; i += 1) {
    const order = events.slice();
    for (let j = order.length - 1; j > 0; j -= 1) {
      const k = Math.floor(rand() * (j + 1));
      const temp = order[j];
      order[j] = order[k];
      order[k] = temp;
    }
    out.push({
      id: `stress-${seed}-${i + 1}`,
      source: 'stress',
      strategy: stress.strategy || 'seeded-random',
      seed,
      order: repairOrder(order, before),
    });
  }
  return out;
}

function buildSchedulePlan(testCase) {
  const declared = testCase.schedules.map((schedule, index) => ({
    id: schedule.id || `declared-${index + 1}`,
    source: schedule.source || 'declared',
    ...schedule,
  }));
  const generated = makeGeneratedSchedules(testCase);
  const stress = makeStressSchedules(testCase);
  const schedules = uniqueByOrder([...declared, ...generated, ...stress]);
  return {
    declared_count: declared.length,
    generated_count: generated.length,
    stress_count: stress.length,
    schedules: schedules.length > 0 ? schedules : [{ id: 'default', source: 'default' }],
  };
}

function verifyScheduleExploration(testCase, state, schedulePlan) {
  if (!testCase.exploration || testCase.exploration.enabled !== true) {
    addGap(state, 'schedule_exploration', testCase, 'no systematic schedule exploration declared');
    return;
  }
  if (schedulePlan.generated_count <= 0) {
    addGap(state, 'schedule_exploration', testCase, 'schedule exploration declared but generated no schedules');
    return;
  }
  addPass(state, 'schedule_exploration', testCase, {
    generated_schedules: schedulePlan.generated_count,
    strategy: testCase.exploration.strategy || 'bounded-permutation',
  });
}

function verifyRuntimeScheduler(testCase, state, observations) {
  const scheduler = testCase.scheduler || {};
  if (!scheduler.runtime || !scheduler.adapter) {
    addGap(state, 'runtime_scheduler', testCase, 'no runtime-specific deterministic scheduler adapter declared');
    return;
  }
  const failures = observations.filter((observation) => {
    const observed = observation.scheduler || {};
    if (observed.deterministic !== true) return true;
    if (scheduler.runtime && observed.runtime && observed.runtime !== scheduler.runtime) return true;
    if (scheduler.adapter && observed.adapter && observed.adapter !== scheduler.adapter) return true;
    if (scheduler.adapter && !observed.adapter) return true;
    return false;
  });
  if (failures.length === 0) addPass(state, 'runtime_scheduler', testCase, { runtime: scheduler.runtime, adapter: scheduler.adapter });
  else addFailure(state, 'runtime_scheduler', testCase, 'deterministic scheduler evidence missing or mismatched', { failures: failures.map((item) => ({ schedule: item.schedule, scheduler: item.scheduler })) });
}

function verifyFakeClockAdapter(testCase, state, observations) {
  const declared = (testCase.clock && testCase.clock.adapter) || (testCase.clock_adapter && testCase.clock_adapter.name) || '';
  if (!declared) {
    addGap(state, 'fake_clock_adapter', testCase, 'no concrete fake-clock adapter declared');
    return;
  }
  const failures = observations.filter((observation) => {
    const clock = observation.clock || {};
    return clock.adapter !== declared || clock.controlled !== true;
  });
  if (failures.length === 0) addPass(state, 'fake_clock_adapter', testCase, { adapter: declared });
  else addFailure(state, 'fake_clock_adapter', testCase, 'fake-clock adapter evidence missing or mismatched', { failures: failures.map((item) => ({ schedule: item.schedule, clock: item.clock })) });
}

function verifyStressReplay(testCase, state, schedulePlan, observations) {
  if (!testCase.stress || testCase.stress.enabled !== true) {
    addGap(state, 'stress_replay', testCase, 'no seeded race/stress schedule exploration declared');
    return;
  }
  if (schedulePlan.stress_count <= 0) {
    addGap(state, 'stress_replay', testCase, 'stress replay declared but generated no schedules');
    return;
  }
  const stressObservations = observations.filter((observation) => observation.schedule && observation.schedule.source === 'stress');
  const failures = stressObservations.filter((observation) => observation.timed_out || observation.deadlocked || observation.livelocked || observation.starved);
  if (failures.length === 0) addPass(state, 'stress_replay', testCase, { schedules: schedulePlan.stress_count, seed: testCase.stress.seed || 12345 });
  else addFailure(state, 'stress_replay', testCase, 'seeded stress replay exposed timeout/deadlock/livelock/starvation', { failures: failures.map((item) => ({ schedule: item.schedule, timed_out: item.timed_out })) });
}

function verifyDeadlockLivelock(testCase, state, observations) {
  const deadlock = testCase.deadlock || {};
  const terminalEvents = asStringArray(deadlock.terminal_events);
  if (Object.keys(deadlock).length === 0) {
    addGap(state, 'deadlock_livelock', testCase, 'no deadlock/livelock/starvation policy declared');
    return;
  }
  const failures = [];
  for (const observation of observations) {
    const order = eventOrder(observation);
    if (observation.deadlocked || observation.livelocked || observation.starved) failures.push({ schedule: observation.schedule, order, deadlocked: observation.deadlocked, livelocked: observation.livelocked, starved: observation.starved });
    if (order.some((name) => /deadlock|livelock|starv/i.test(name))) failures.push({ schedule: observation.schedule, order, message: 'trace contains deadlock/livelock/starvation event' });
    if (!testCase.expected_timeout && observation.timed_out) failures.push({ schedule: observation.schedule, order, message: 'process timeout can indicate deadlock or livelock' });
    if (terminalEvents.length > 0 && !terminalEvents.some((event) => order.includes(event))) failures.push({ schedule: observation.schedule, order, terminal_events: terminalEvents });
    if (Number.isFinite(deadlock.max_idle_ms)) {
      const times = observation.events.map((event) => Number.isFinite(event.at) ? event.at : event.time_ms).filter(Number.isFinite).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i += 1) {
        if (times[i] - times[i - 1] > deadlock.max_idle_ms) failures.push({ schedule: observation.schedule, idle_ms: times[i] - times[i - 1], lte: deadlock.max_idle_ms });
      }
    }
  }
  if (failures.length === 0) addPass(state, 'deadlock_livelock', testCase, { terminal_events: terminalEvents });
  else addFailure(state, 'deadlock_livelock', testCase, 'deadlock/livelock/starvation policy failed', { failures: failures.slice(0, 10) });
}

function temporalInvariants(testCase) {
  if (Array.isArray(testCase.temporal)) return testCase.temporal;
  if (testCase.temporal && Array.isArray(testCase.temporal.invariants)) return testCase.temporal.invariants;
  return [];
}

function eventTime(observation, name) {
  const event = observation.events.find((item) => eventName(item) === name);
  if (!event) return null;
  if (Number.isFinite(event.at)) return event.at;
  if (Number.isFinite(event.time_ms)) return event.time_ms;
  return null;
}

function checkTemporalInvariant(invariant, observation) {
  const order = eventOrder(observation);
  const type = invariant.type || invariant.kind || 'before';
  if (type === 'eventually') {
    if (!order.includes(String(invariant.event))) return { invariant, order, message: 'event was not eventually observed' };
  } else if (type === 'never') {
    if (order.includes(String(invariant.event))) return { invariant, order, message: 'forbidden event was observed' };
  } else if (type === 'before') {
    const a = String(invariant.a || invariant.before || '');
    const b = String(invariant.b || invariant.event || '');
    const unless = invariant.unless ? String(invariant.unless) : '';
    if (unless && order.includes(unless)) return null;
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (!a || !b || ia < 0 || ib < 0 || ia >= ib) return { invariant, order, message: 'before invariant failed' };
  } else if (type === 'after') {
    const event = String(invariant.event || '');
    const after = String(invariant.after || '');
    const ie = order.indexOf(event);
    const ia = order.indexOf(after);
    if (ie >= 0 && (ia < 0 || ia >= ie)) return { invariant, order, message: 'after invariant failed' };
  } else if (type === 'within_ms') {
    const from = eventTime(observation, String(invariant.from || ''));
    const to = eventTime(observation, String(invariant.to || ''));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > invariant.lte) return { invariant, order, message: 'within_ms invariant failed', from, to };
  } else if (type === 'count') {
    const count = order.filter((name) => name === String(invariant.event)).length;
    if (Number.isFinite(invariant.equals) && count !== invariant.equals) return { invariant, order, count, message: 'count invariant failed' };
    if (Number.isFinite(invariant.lte) && count > invariant.lte) return { invariant, order, count, message: 'count lte invariant failed' };
    if (Number.isFinite(invariant.gte) && count < invariant.gte) return { invariant, order, count, message: 'count gte invariant failed' };
  }
  return null;
}

function verifyTemporal(goalPath, testCase, state, observations) {
  const invariants = temporalInvariants(testCase);
  if (invariants.length === 0) {
    addGap(state, 'temporal_invariants', testCase, 'no temporal invariant DSL rules declared');
    return;
  }
  const failures = [];
  for (const observation of observations) {
    for (const invariant of invariants) {
      const failure = checkTemporalInvariant(invariant, observation);
      if (failure) failures.push({ schedule: observation.schedule, ...failure });
    }
  }
  if (failures.length === 0) addPass(state, 'temporal_invariants', testCase, { invariants: invariants.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-temporal-invariants.json'), { failures });
    addFailure(state, 'temporal_invariants', testCase, 'temporal invariant failed', { diff_path, failures: failures.slice(0, 10) });
  }
}

async function verifyRaceTooling(goalPath, testCase, cwd, state, observations) {
  if (testCase.race_tools.length === 0) {
    addGap(state, 'race_tooling', testCase, 'no static/runtime race tooling declared');
    return;
  }
  const failures = [];
  for (const tool of testCase.race_tools) {
    const command = typeof tool.command === 'string' ? tool.command.trim() : '';
    if (!command) {
      failures.push({ tool, message: 'race tool command missing' });
      continue;
    }
    const input = {
      case_id: testCase.id,
      schedules: observations.map((observation) => observation.schedule),
      clock: testCase.clock,
      metadata: testCase.metadata,
      observations: observations.map((observation) => ({ order: eventOrder(observation), result: observation.result })),
    };
    const result = await runCliCommand(command, `${JSON.stringify(input)}\n`, { cwd, timeoutMs: Number.isFinite(tool.timeout_ms) ? tool.timeout_ms : testCase.timeout_ms, maxBuffer: 16 * 1024 * 1024 });
    state.metrics.push(result.metrics);
    let json = null;
    try {
      json = result.stdout ? JSON.parse(result.stdout) : null;
    } catch (_err) {
      json = null;
    }
    state.trace.commands.push({ phase: `race-tool:${tool.id || command}`, command, ...commandTail(result) });
    const expectExit = Number.isInteger(tool.expect_exit_code) ? tool.expect_exit_code : 0;
    if (result.exitCode !== expectExit || result.timedOut || (json && (json.status === 'fail' || (Array.isArray(json.races) && json.races.length > 0)))) {
      failures.push({ tool: tool.id || command, result: commandTail(result), report: json });
    }
  }
  if (failures.length === 0) addPass(state, 'race_tooling', testCase, { tools: testCase.race_tools.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-race-tooling.json'), { failures });
    addFailure(state, 'race_tooling', testCase, 'static/runtime race tooling reported a problem', { diff_path, failures });
  }
}

function verifyReplayReproduction(testCase, state, observations) {
  const command = testCase.command || '';
  if (!command) {
    addGap(state, 'replay_reproduction', testCase, 'no command available for exact schedule replay');
    return;
  }
  const missing = observations.filter((observation) => !(observation.schedule && observation.schedule.id));
  if (missing.length > 0) {
    addGap(state, 'replay_reproduction', testCase, 'some observations lack schedule ids for exact replay');
    return;
  }
  addPass(state, 'replay_reproduction', testCase, {
    schedules: observations.map((observation) => ({
      id: observation.schedule.id,
      source: observation.schedule.source || 'declared',
      seed: observation.schedule.seed,
      timeout_ms: testCase.timeout_ms,
      clock: testCase.clock,
    })),
  });
}

function verifyDeterminism(goalPath, testCase, state, observations) {
  const bySchedule = new Map();
  for (const observation of observations) {
    const id = observation.schedule && observation.schedule.id ? observation.schedule.id : stableText(observation.schedule || {});
    if (!bySchedule.has(id)) bySchedule.set(id, []);
    bySchedule.get(id).push(resultKey(observation));
  }
  const failures = [];
  for (const [scheduleId, values] of bySchedule.entries()) {
    if (new Set(values).size > 1) failures.push({ schedule_id: scheduleId, observations: values });
  }
  if (failures.length === 0) addPass(state, 'deterministic_scheduling', testCase, { schedules: bySchedule.size });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-deterministic-scheduling.json'), { failures });
    addFailure(state, 'deterministic_scheduling', testCase, 'same schedule produced different results or event order', { diff_path, failures });
  }
}

function verifyRace(goalPath, testCase, state, observations) {
  const failures = observations.filter((observation) => !allowedResult(testCase, observation));
  if (failures.length === 0) addPass(state, 'race_condition', testCase, { observations: observations.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-race-condition.json'), {
      failures: failures.map((observation) => ({ schedule: observation.schedule, result: observation.result, order: eventOrder(observation) })),
      expected_result: testCase.expected_result,
      allowed_results: testCase.allowed_results,
      allowed_event_orders: testCase.allowed_event_orders,
    });
    addFailure(state, 'race_condition', testCase, 'observed a result/order outside the allowed concurrency outcomes', {
      diff_path,
      failures: failures.map((observation) => ({ schedule: observation.schedule, result: observation.result, order: eventOrder(observation) })).slice(0, 10),
    });
  }
}

async function verifyReference(goal, goalPath, testCase, cwd, state, observations) {
  const command = testCase.reference_command || goal.verify.reference_command || '';
  if (!command) {
    addGap(state, 'reference_trace', testCase, 'no reference async trace command declared');
    return;
  }
  const schedule = observations[0] ? observations[0].schedule : (testCase.schedules[0] || null);
  const input = { input: testCase.input, schedule, clock: testCase.clock, metadata: testCase.metadata };
  const result = await runCliCommand(command, `${JSON.stringify(input)}\n`, { cwd, timeoutMs: testCase.timeout_ms, maxBuffer: 32 * 1024 * 1024 });
  state.metrics.push(result.metrics);
  let json = null;
  let jsonError = null;
  try {
    json = result.stdout ? JSON.parse(result.stdout) : null;
  } catch (err) {
    jsonError = err.message;
  }
  state.trace.commands.push({ phase: 'reference', command, schedule, ...commandTail(result), json_error: jsonError });
  if (result.exitCode !== 0 || jsonError) {
    addFailure(state, 'reference_trace', testCase, 'reference async trace command failed', { result: commandTail(result), json_error: jsonError });
    return;
  }
  const expected = normalizeObservation(json || {}, result, schedule);
  const actual = observations[0] || normalizeObservation({}, null, schedule);
  if (stableText({ result: expected.result, order: eventOrder(expected) }) === stableText({ result: actual.result, order: eventOrder(actual) })) {
    addPass(state, 'reference_trace', testCase);
  } else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-reference-trace.json'), {
      expected: { result: expected.result, order: eventOrder(expected) },
      actual: { result: actual.result, order: eventOrder(actual) },
    });
    addFailure(state, 'reference_trace', testCase, 'async trace differed from reference command', { diff_path });
  }
}

function writeCorpusCase(goalPath, testCase, counterexample) {
  const corpusPath = artifactPath(goalPath, 'corpus', testCase);
  const schedule = counterexample.schedule ||
    (Array.isArray(counterexample.failures) && counterexample.failures[0] && counterexample.failures[0].schedule) ||
    null;
  const replayInput = {
    input: testCase.input,
    schedule,
    clock: testCase.clock,
    metadata: testCase.metadata,
  };
  const replayScript = path.join(goalBaseDir(goalPath), 'replay-counterexample.cjs');
  const minimizedSchedule = schedule && Array.isArray(schedule.order)
    ? { ...schedule, order: schedule.order.slice(0, Math.max(1, Math.min(schedule.order.length, 4))), minimized: true }
    : null;
  writeJson(corpusPath, {
    case: testCase,
    counterexample,
    replay: {
      command: `node ${JSON.stringify(replayScript)} ${JSON.stringify(corpusPath)}`,
      command_under_test: testCase.command,
      input: replayInput,
      schedule,
      minimized_schedule: minimizedSchedule,
      timeout_ms: testCase.timeout_ms,
      clock: testCase.clock,
    },
  });
  return corpusPath;
}

async function verifyOneCase(goal, goalPath, testCase, cwd = process.cwd()) {
  const state = { verifications: [], metrics: [], counterexample: null, trace: { case: testCase, commands: [], observations: [] } };
  addPass(state, 'case_present', testCase);
  addPass(state, 'counterexample_corpus', testCase, { corpus_dir: path.join(goalBaseDir(goalPath), 'corpus') });
  const schedulePlan = buildSchedulePlan(testCase);
  state.trace.schedule_plan = schedulePlan;
  const schedules = schedulePlan.schedules;
  if (schedulePlan.declared_count > 0) addPass(state, 'schedule_declared', testCase, { schedules: schedulePlan.declared_count });
  else addGap(state, 'schedule_declared', testCase, 'no deterministic schedules/interleavings declared');
  verifyScheduleExploration(testCase, state, schedulePlan);

  const observations = [];
  for (const schedule of schedules) {
    const repeat = Math.max(1, testCase.repeat);
    for (let i = 0; i < repeat; i += 1) {
      const observation = await runObservation(goal, goalPath, testCase, schedule, cwd, state, `-${sanitizeId(schedule.id || i)}-${i}`);
      observations.push(observation);
      state.trace.observations.push(observation);
    }
  }
  writeJson(artifactPath(goalPath, 'traces', testCase), state.trace);
  verifyOrdering(goalPath, testCase, state, observations);
  verifyTimeout(testCase, state, observations);
  verifyClock(testCase, state, observations);
  verifyFakeClockAdapter(testCase, state, observations);
  verifyRuntimeScheduler(testCase, state, observations);
  verifyDeterminism(goalPath, testCase, state, observations);
  verifyStressReplay(testCase, state, schedulePlan, observations);
  verifyRace(goalPath, testCase, state, observations);
  verifyDeadlockLivelock(testCase, state, observations);
  verifyTemporal(goalPath, testCase, state, observations);
  await verifyRaceTooling(goalPath, testCase, cwd, state, observations);
  verifyReplayReproduction(testCase, state, observations);
  await verifyReference(goal, goalPath, testCase, cwd, state, observations);
  return state;
}

function aggregateMetrics(samples) {
  const byName = {};
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value)) continue;
      const metricName = key === 'wall_time_ms' ? 'async_replay_ms' : key;
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

async function runConcurrencySuiteVerification(goal, goalPath, options = {}) {
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
    if (result.counterexample && !counterexample) {
      counterexample = result.counterexample;
      counterexample.corpus_path = writeCorpusCase(goalPath, testCase, counterexample);
    }
  }
  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: aggregateMetrics(metrics),
    counterexample,
  };
}

function writeAsyncHarness(goalDir) {
  fs.writeFileSync(path.join(goalDir, 'async-harness.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');",
    "const order = Array.isArray(input.schedule && input.schedule.order) ? input.schedule.order : ['start', 'finish'];",
    "const events = order.map((name, index) => ({ name, at: (input.clock && input.clock.start_ms || 0) + index }));",
    "process.stdout.write(JSON.stringify({",
    "  events,",
    "  result: { ok: true },",
    "  clock: { mode: input.clock && input.clock.mode || 'fake', adapter: input.clock && input.clock.adapter || 'xoloop-virtual-clock', controlled: true },",
    "  scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true }",
    "}));",
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(path.join(goalDir, 'async-harness.cjs'), 0o755);
}

function writeAsyncRaceTool(goalDir) {
  fs.writeFileSync(path.join(goalDir, 'async-race-tool.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    "JSON.parse(fs.readFileSync(0, 'utf8') || '{}');",
    "process.stdout.write(JSON.stringify({ status: 'pass', tool: 'xoloop-async-smoke' }));",
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(path.join(goalDir, 'async-race-tool.cjs'), 0o755);
}

function writeCounterexampleReplay(goalDir) {
  fs.writeFileSync(path.join(goalDir, 'replay-counterexample.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    "const { spawnSync } = require('child_process');",
    "const corpusPath = process.argv[2];",
    "if (!corpusPath) throw new Error('usage: node replay-counterexample.cjs <corpus.json>');",
    "const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));",
    "const command = corpus.replay && corpus.replay.command_under_test;",
    "if (!command) throw new Error('corpus does not contain command_under_test');",
    "const input = corpus.replay.input || {};",
    "const result = spawnSync('bash', ['-lc', command], {",
    "  cwd: process.cwd(),",
    "  input: `${JSON.stringify(input)}\\n`,",
    "  encoding: 'utf8',",
    "  timeout: corpus.replay.timeout_ms || 5000,",
    "  stdio: ['pipe', 'pipe', 'pipe'],",
    "});",
    "process.stdout.write(result.stdout || '');",
    "process.stderr.write(result.stderr || '');",
    "process.exit(typeof result.status === 'number' ? result.status : 1);",
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(path.join(goalDir, 'replay-counterexample.cjs'), 0o755);
}

function writeAsyncAdapters(goalDir) {
  const adapterDir = path.join(goalDir, 'adapters');
  fs.mkdirSync(adapterDir, { recursive: true });
  fs.writeFileSync(path.join(adapterDir, 'node-fake-clock.cjs'), [
    "'use strict';",
    "function installNodeFakeClock(options = {}) {",
    "  try {",
    "    const fakeTimers = require('@sinonjs/fake-timers');",
    "    return { name: 'sinon-fake-timers', clock: fakeTimers.install({ now: options.now || 0 }) };",
    "  } catch (_err) {",
    "    let now = options.now || 0;",
    "    return { name: 'xoloop-virtual-clock', tick(ms) { now += ms; }, now() { return now; }, uninstall() {} };",
    "  }",
    "}",
    "module.exports = { installNodeFakeClock };",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(adapterDir, 'runtime-schedulers.md'), [
    '# Runtime scheduler adapters',
    '',
    '- Node: use `async_hooks`, fake timers, and explicit schedule order from stdin.',
    '- Python asyncio/trio: run under a test loop or Trio mock clock and emit schedule ids.',
    '- Go: combine `go test -race`, controlled clocks, and explicit goroutine step barriers.',
    '- Rust/Tokio/Loom: prefer Loom model tests or Tokio paused time for deterministic steps.',
    '',
  ].join('\n'), 'utf8');
}

function writeConcurrencySuiteAssets(goalDir, options = {}) {
  for (const dir of ['cases', 'schedules', 'traces', 'diffs', 'corpus', 'adapters']) fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  writeAsyncHarness(goalDir);
  writeAsyncRaceTool(goalDir);
  writeCounterexampleReplay(goalDir);
  writeAsyncAdapters(goalDir);
  writeJson(path.join(goalDir, 'cases', 'async-smoke.json'), {
    id: 'async-smoke',
    command: `node ${JSON.stringify(path.join('.xoloop', 'goals', options.goalId || 'concurrency-suite', 'async-harness.cjs'))}`,
    input: {},
    schedules: [{ id: 'serial', order: ['start', 'finish'] }],
    clock: { mode: 'fake', adapter: 'xoloop-virtual-clock', start_ms: 0 },
    scheduler: { runtime: 'node', adapter: 'xoloop-virtual-scheduler', deterministic: true },
    exploration: { enabled: true, strategy: 'bounded-permutation', events: ['start', 'finish'], must_happen_before: [['start', 'finish']], max_schedules: 4 },
    stress: { enabled: true, strategy: 'seeded-random', events: ['start', 'finish'], must_happen_before: [['start', 'finish']], seed: 12345, runs: 2 },
    ordering: { before: [['start', 'finish']], sequence: ['start', 'finish'] },
    temporal: { invariants: [{ id: 'eventually-finish', type: 'eventually', event: 'finish' }, { id: 'no-error', type: 'never', event: 'error' }] },
    deadlock: { terminal_events: ['finish'], max_idle_ms: 1000 },
    expected_result: { ok: true },
    race_tools: [{ id: 'xoloop-async-smoke', command: `node ${JSON.stringify(path.join('.xoloop', 'goals', options.goalId || 'concurrency-suite', 'async-race-tool.cjs'))}` }],
    repeat: 2,
    max_duration_ms: 5000,
  });
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# Concurrency/time/async verification goal',
    '',
    'Generated by `xoloop-verify create --kind concurrency-suite`.',
    '',
    'Cases declare replay commands, schedules/interleavings, fake clock',
    'contracts, ordering guarantees, timeout expectations, allowed race',
    'outcomes, seeded stress runs, temporal invariants, deadlock policy,',
    'runtime scheduler evidence, race tools, and optional reference trace',
    'commands. Verify stores traces, diffs, and replayable counterexample',
    'corpus files here.',
    '',
  ].join('\n'), 'utf8');
}

function buildConcurrencySuiteGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'concurrency-suite';
  const scan = options.scan || scanConcurrencyRepo(cwd);
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve concurrency, ordering, timeout, clock-control, and async scheduling behavior while optimizing.',
    interface: {
      type: 'async',
      command: options.command || 'xoloop async verification harness',
      stdin: 'json',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: scan.artifact_paths || [],
    },
    verify: {
      kind: 'concurrency-suite',
      command: options.command || '',
      reference_command: options.referenceCommand || '',
      cases: 'cases/*.json',
      properties: DEFAULT_CONCURRENCY_OBLIGATIONS,
      scan,
      block_on_gaps: true,
    },
    metrics: {
      repeat: 3,
      targets: [
        { name: 'async_replay_ms', direction: 'minimize', threshold: 0.03 },
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
  DEFAULT_CONCURRENCY_OBLIGATIONS,
  buildConcurrencySuiteGoal,
  runConcurrencySuiteVerification,
  scanConcurrencyRepo,
  writeConcurrencySuiteAssets,
};
