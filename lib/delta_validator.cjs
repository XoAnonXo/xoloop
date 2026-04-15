/**
 * delta_validator.cjs — Red→Green Delta Validator for BUILD mode proposals.
 *
 * Validates that new tests added by a BUILD mode proposal genuinely exercise
 * the new implementation code:
 *
 *   1. Run NEW tests against BASE commit (no implementation) → must ALL FAIL
 *      (if any pass, they're vacuous — testing nothing)
 *   2. Run NEW tests against CANDIDATE commit (with implementation) → must ALL PASS
 *      (if any fail, the implementation is buggy)
 *   3. Run FULL test suite against CANDIDATE → must ALL PASS (no regressions)
 *
 * See ARCHITECTURE.md §6.6 "Red→Green Delta Validation".
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { AdapterError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse `node --test` spec output to count passes and failures.
 * Looks for the following patterns in combined stdout+stderr output:
 *   ℹ pass N  /  # pass N       → authoritative pass count
 *   ℹ fail N  /  # fail N       → authoritative fail count
 *   ✔ some test name (Nms)      → pass  (spec reporter fallback)
 *   ✗ some test name (Nms)      → fail  (spec reporter fallback)
 *   not ok N - test name        → fail  (TAP reporter fallback)
 *
 * We prefer the authoritative "ℹ pass / ℹ fail" summary lines when present,
 * falling back to counting ✔/✗/not-ok lines in the spec/TAP stream.
 */
function parseTestOutput(text) {
  const lines = String(text || '').split('\n');

  // Try authoritative summary lines first (both stdout and stderr carry them)
  let authPass = null;
  let authFail = null;

  for (const line of lines) {
    const trimmed = line.trim();
    // "ℹ pass 7" or "# pass 7" (TAP reporter)
    const passMatch = trimmed.match(/^[ℹ#]\s+pass\s+(\d+)$/);
    if (passMatch) {
      authPass = parseInt(passMatch[1], 10);
    }
    const failMatch = trimmed.match(/^[ℹ#]\s+fail\s+(\d+)$/);
    if (failMatch) {
      authFail = parseInt(failMatch[1], 10);
    }
  }

  if (authPass !== null && authFail !== null) {
    const total = authPass + authFail;
    return { total, passed: authPass, failed: authFail };
  }

  // Fallback: count ✔ and ✗ symbols in spec output
  let passed = 0;
  let failed = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('✔')) {
      passed += 1;
    } else if (
      trimmed.startsWith('✗') ||
      trimmed.startsWith('not ok')
    ) {
      failed += 1;
    }
  }

  return { total: passed + failed, passed, failed };
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Run `node --test <testPaths>` in `cwd`.
 *
 * Returns `{ total, passed, failed, output }`.
 *
 * Note: `node --test` exits with code 1 when any test fails, so we cannot use
 * the exit code alone to determine pass/fail counts — we must parse the output.
 */
function runTestsInDir(testPaths, cwd) {
  if (!testPaths || !Array.isArray(testPaths) || testPaths.length === 0) {
    return { total: 0, passed: 0, failed: 0, output: '' };
  }

  if (!cwd || typeof cwd !== 'string') {
    throw new AdapterError(
      'DELTA_CWD_REQUIRED',
      'cwd',
      'cwd must be a non-empty string directory path',
      { fixHint: 'Pass the absolute path to the working directory for test execution.' },
    );
  }

  // Strip NODE_TEST_CONTEXT and NODE_CHANNEL_FD from the environment.
  // Node ≥22 sets NODE_TEST_CONTEXT='child' inside a test run and uses it as
  // a recursion guard — any nested `node --test` invocation with that variable
  // set will silently skip all files. We are intentionally running a separate
  // test process, not a recursive sub-suite, so we must clear it.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_CHANNEL_FD;

  const result = spawnSync(process.execPath, ['--test', ...testPaths], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    env: childEnv,
  });

  // node:test writes the human-readable spec lines to stdout; the "ℹ pass N"
  // summary lines also appear in stdout (spec reporter) or stderr (tap).
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  const counts = parseTestOutput(combined);

  return {
    total: counts.total,
    passed: counts.passed,
    failed: counts.failed,
    output: combined.trim(),
  };
}

/**
 * Run an array of shell command strings sequentially in `cwd` via `bash -lc`.
 * Stops at the first failure.
 *
 * Returns `{ ok, commandCount, firstFailure }`.
 *   - `ok`: true iff all commands exited 0
 *   - `commandCount`: number of commands provided
 *   - `firstFailure`: command string of the first failed command (or null)
 */
function runValidationInDir(commands, cwd) {
  if (!cwd || typeof cwd !== 'string') {
    throw new AdapterError(
      'DELTA_VALIDATION_CWD_REQUIRED',
      'cwd',
      'cwd must be a non-empty string directory path',
      { fixHint: 'Pass the absolute path to the working directory for validation commands.' },
    );
  }

  const normalised = Array.isArray(commands)
    ? commands.map((c) => String(c || '').trim()).filter(Boolean)
    : [];

  let firstFailure = null;

  for (const command of normalised) {
    const result = spawnSync('bash', ['-lc', command], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    const exitCode = result.status === null ? 1 : result.status;
    if (exitCode !== 0) {
      firstFailure = command;
      break;
    }
  }

  return {
    ok: firstFailure === null,
    commandCount: normalised.length,
    firstFailure,
  };
}

/**
 * Validate the red→green delta for a BUILD mode proposal.
 *
 * @param {object} opts
 * @param {string}   opts.baseDir        - Path to worktree at base commit (no implementation)
 * @param {string}   opts.candidateDir   - Path to worktree at candidate commit (with implementation)
 * @param {string[]} opts.testPaths      - Relative (to each worktree root) test file paths
 * @param {string[]} opts.fullValidation - Shell commands to run the full test suite in candidateDir
 *
 * @returns {{
 *   ok: boolean,
 *   red:   { total: number, failed: number, passed: number },
 *   green: { total: number, failed: number, passed: number },
 *   full:  { ok: boolean, commandCount: number },
 *   reason: string|null,
 * }}
 *
 * @throws {AdapterError} for missing required arguments (never for test failures)
 */
function validateRedGreenDelta(opts = {}) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new AdapterError(
      'DELTA_OPTIONS_REQUIRED',
      'opts',
      'validateRedGreenDelta requires a plain options object',
      { fixHint: 'Pass an options object: { baseDir, candidateDir, testPaths, fullValidation }.' },
    );
  }
  const { baseDir, candidateDir, testPaths, fullValidation } = opts;
  if (!baseDir || typeof baseDir !== 'string') {
    throw new AdapterError(
      'DELTA_BASE_DIR_REQUIRED',
      'baseDir',
      'baseDir is required',
      { fixHint: 'Pass the path to the worktree at the base commit.' },
    );
  }
  if (!candidateDir || typeof candidateDir !== 'string') {
    throw new AdapterError(
      'DELTA_CANDIDATE_DIR_REQUIRED',
      'candidateDir',
      'candidateDir is required',
      { fixHint: 'Pass the path to the worktree at the candidate commit.' },
    );
  }
  if (!testPaths || !Array.isArray(testPaths) || testPaths.length === 0) {
    throw new AdapterError(
      'DELTA_TEST_PATHS_REQUIRED',
      'testPaths',
      'testPaths must be a non-empty array of test file paths',
      { fixHint: 'Pass at least one test file path.' },
    );
  }

  const normalisedFullValidation = Array.isArray(fullValidation) ? fullValidation : [];

  // ------------------------------------------------------------------
  // Phase 1 — RED: new tests must ALL FAIL on base (no implementation)
  // ------------------------------------------------------------------
  const redResult = runTestsInDir(testPaths, baseDir);

  if (redResult.passed > 0) {
    return {
      ok: false,
      red: { total: redResult.total, failed: redResult.failed, passed: redResult.passed },
      green: { total: 0, failed: 0, passed: 0 },
      full: { ok: false, commandCount: normalisedFullValidation.length },
      reason: `DELTA_RED_PHASE_UNEXPECTED_PASS: ${redResult.passed} test(s) passed without implementation — tests are vacuous`,
    };
  }

  // ------------------------------------------------------------------
  // Phase 2 — GREEN: new tests must ALL PASS on candidate (with implementation)
  // ------------------------------------------------------------------
  const greenResult = runTestsInDir(testPaths, candidateDir);

  if (greenResult.failed > 0) {
    return {
      ok: false,
      red: { total: redResult.total, failed: redResult.failed, passed: redResult.passed },
      green: { total: greenResult.total, failed: greenResult.failed, passed: greenResult.passed },
      full: { ok: false, commandCount: normalisedFullValidation.length },
      reason: `DELTA_GREEN_PHASE_FAILURE: ${greenResult.failed} test(s) failed with implementation`,
    };
  }

  // ------------------------------------------------------------------
  // Phase 3 — FULL: run the full test suite on candidate (no regressions)
  // ------------------------------------------------------------------
  const fullResult = runValidationInDir(normalisedFullValidation, candidateDir);

  if (!fullResult.ok) {
    return {
      ok: false,
      red: { total: redResult.total, failed: redResult.failed, passed: redResult.passed },
      green: { total: greenResult.total, failed: greenResult.failed, passed: greenResult.passed },
      full: { ok: false, commandCount: fullResult.commandCount },
      reason: `Full validation failed — existing tests broken by new code (first failure: ${fullResult.firstFailure})`,
    };
  }

  return {
    ok: true,
    red: { total: redResult.total, failed: redResult.failed, passed: redResult.passed },
    green: { total: greenResult.total, failed: greenResult.failed, passed: greenResult.passed },
    full: { ok: true, commandCount: fullResult.commandCount },
    reason: null,
  };
}

module.exports = {
  validateRedGreenDelta,
  runTestsInDir,
  runValidationInDir,
};
