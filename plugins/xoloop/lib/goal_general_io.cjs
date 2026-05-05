'use strict';

const fs = require('node:fs');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob } = require('./goal_manifest.cjs');

function loadCaseFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`general-io case must be an object: ${filePath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
    throw new Error(`general-io case must contain string id: ${filePath}`);
  }
  return {
    id: parsed.id.trim(),
    input: parsed.input == null ? '' : String(parsed.input),
    expected_exit_code: Number.isInteger(parsed.expected_exit_code) ? parsed.expected_exit_code : 0,
    expected_stdout: typeof parsed.expected_stdout === 'string' ? parsed.expected_stdout : null,
    expected_stderr: typeof parsed.expected_stderr === 'string' ? parsed.expected_stderr : null,
    expect_stdout_includes: Array.isArray(parsed.expect_stdout_includes) ? parsed.expect_stdout_includes.map(String) : [],
    expect_stderr_includes: Array.isArray(parsed.expect_stderr_includes) ? parsed.expect_stderr_includes.map(String) : [],
  };
}

function tail(text) {
  return String(text || '').slice(-2000);
}

function includesAll(text, needles) {
  return needles.every((needle) => String(text).includes(needle));
}

function jsonParses(text) {
  try {
    JSON.parse(String(text || ''));
    return true;
  } catch (_err) {
    return false;
  }
}

function addFailure(state, testCase, obligation, message, result, extra = {}) {
  state.verifications.push({
    id: obligation,
    status: 'fail',
    case_id: testCase.id,
    message,
  });
  if (!state.counterexample) {
    state.counterexample = {
      case_id: testCase.id,
      obligation,
      input: testCase.input,
      message,
      exit_code: result.exitCode,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
      ...extra,
    };
  }
}

function addPass(state, testCase, obligation, extra = {}) {
  state.verifications.push({
    id: obligation,
    status: 'pass',
    case_id: testCase.id,
    ...extra,
  });
}

async function verifyOneCase(goal, cwd, testCase) {
  const properties = new Set(goal.verify.properties || []);
  const state = {
    verifications: [],
    metrics: [],
    counterexample: null,
  };
  const result = await runCliCommand(goal.interface.command, testCase.input, {
    cwd,
    timeoutMs: goal.interface.timeout_ms,
  });
  state.metrics.push(result.metrics);

  if (result.exitCode !== testCase.expected_exit_code) {
    addFailure(
      state,
      testCase,
      'exit_code',
      `expected exit ${testCase.expected_exit_code}, got ${result.exitCode}`,
      result,
    );
  } else {
    addPass(state, testCase, 'exit_code', { exit_code: result.exitCode });
  }

  if (testCase.expected_stdout !== null) {
    if (String(result.stdout) !== testCase.expected_stdout) {
      addFailure(state, testCase, 'stdout_exact', 'stdout did not match expected_stdout exactly', result, {
        expected_stdout: testCase.expected_stdout,
      });
    } else {
      addPass(state, testCase, 'stdout_exact');
    }
  }

  if (testCase.expected_stderr !== null) {
    if (String(result.stderr) !== testCase.expected_stderr) {
      addFailure(state, testCase, 'stderr_exact', 'stderr did not match expected_stderr exactly', result, {
        expected_stderr: testCase.expected_stderr,
      });
    } else {
      addPass(state, testCase, 'stderr_exact');
    }
  }

  if (testCase.expect_stdout_includes.length > 0) {
    if (!includesAll(result.stdout, testCase.expect_stdout_includes)) {
      addFailure(state, testCase, 'stdout_includes', 'stdout did not include all expected strings', result);
    } else {
      addPass(state, testCase, 'stdout_includes');
    }
  }

  if (testCase.expect_stderr_includes.length > 0) {
    if (!includesAll(result.stderr, testCase.expect_stderr_includes)) {
      addFailure(state, testCase, 'stderr_includes', 'stderr did not include all expected strings', result);
    } else {
      addPass(state, testCase, 'stderr_includes');
    }
  }

  if (properties.has('no_stderr')) {
    if (String(result.stderr || '') !== '') addFailure(state, testCase, 'no_stderr', 'stderr was not empty', result);
    else addPass(state, testCase, 'no_stderr');
  }

  if (properties.has('stdout_json')) {
    if (!jsonParses(result.stdout)) addFailure(state, testCase, 'stdout_json', 'stdout was not valid JSON', result);
    else addPass(state, testCase, 'stdout_json');
  }

  if (properties.has('deterministic')) {
    const second = await runCliCommand(goal.interface.command, testCase.input, {
      cwd,
      timeoutMs: goal.interface.timeout_ms,
    });
    state.metrics.push(second.metrics);
    if (
      second.exitCode !== result.exitCode ||
      String(second.stdout) !== String(result.stdout) ||
      String(second.stderr) !== String(result.stderr)
    ) {
      addFailure(state, testCase, 'deterministic', 'same input produced different observable output', second, {
        first_exit_code: result.exitCode,
        first_stdout_tail: tail(result.stdout),
        first_stderr_tail: tail(result.stderr),
      });
    } else {
      addPass(state, testCase, 'deterministic');
    }
  }

  if (properties.has('differential_reference')) {
    if (!goal.verify.reference_command) {
      addFailure(state, testCase, 'differential_reference', 'verify.reference_command is required', result);
    } else {
      const reference = await runCliCommand(goal.verify.reference_command, testCase.input, {
        cwd,
        timeoutMs: goal.interface.timeout_ms,
      });
      state.metrics.push(reference.metrics);
      if (
        reference.exitCode !== result.exitCode ||
        String(reference.stdout) !== String(result.stdout) ||
        String(reference.stderr) !== String(result.stderr)
      ) {
        addFailure(state, testCase, 'differential_reference', 'implementation differed from reference command', result, {
          reference_exit_code: reference.exitCode,
          reference_stdout_tail: tail(reference.stdout),
          reference_stderr_tail: tail(reference.stderr),
        });
      } else {
        addPass(state, testCase, 'differential_reference');
      }
    }
  }

  return state;
}

function aggregateMetrics(samples) {
  const valid = samples.filter(Boolean);
  if (valid.length === 0) return {};
  const out = {};
  for (const key of ['wall_time_ms', 'peak_memory_mb']) {
    const values = valid.map((sample) => sample[key]).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (values.length > 0) out[key] = values[Math.floor(values.length / 2)];
  }
  return out;
}

async function runGeneralIoVerification(goal, goalPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const caseFiles = expandSimpleJsonGlob(goalPath, goal.verify.cases, cwd);
  const cases = caseFiles.map(loadCaseFile);
  const selectedCases = options.caseId ? cases.filter((c) => c.id === options.caseId) : cases;

  if (selectedCases.length === 0) {
    return {
      status: 'fail',
      verifications: [{ id: 'case_selection', status: 'fail', message: `No cases matched ${options.caseId || goal.verify.cases}` }],
      metrics: {},
      counterexample: { obligation: 'case_selection', message: `No cases matched ${options.caseId || goal.verify.cases}` },
    };
  }

  const verifications = [];
  const metricSamples = [];
  let counterexample = null;
  for (const testCase of selectedCases) {
    const result = await verifyOneCase(goal, cwd, testCase);
    verifications.push(...result.verifications);
    metricSamples.push(...result.metrics);
    if (result.counterexample && !counterexample) counterexample = result.counterexample;
  }

  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: aggregateMetrics(metricSamples),
    counterexample,
  };
}

module.exports = {
  runGeneralIoVerification,
};
