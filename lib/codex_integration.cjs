'use strict';

/**
 * codex_integration.cjs — Wraps the `codex` CLI for use as a background scanner
 * in the XO pipeline.
 *
 * All public functions degrade gracefully when codex is not installed:
 *   - isCodexAvailable()       → false
 *   - runCodexReview(options)  → { available: false }
 *   - runCodexChallenge(opts)  → { available: false }
 *   - parseCodexOutput(output) → { findings: [], tokens: 0, hasCritical: false }
 *
 * Error codes (string constants on the module):
 *   CODEX_NOT_AVAILABLE — binary not found on PATH
 *   CODEX_TIMEOUT       — subprocess exceeded options.timeout
 *   CODEX_FAILED        — subprocess exited with non-zero status
 *
 * Testability: every public function that spawns a process accepts
 * options.execFn — a synchronous replacement for spawnSync with the same
 * signature: execFn(command, args, spawnOptions) → SpawnSyncReturns.
 * Inject a mock to test without a real codex binary.
 */

const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

const CODEX_NOT_AVAILABLE = 'CODEX_NOT_AVAILABLE';
const CODEX_TIMEOUT = 'CODEX_TIMEOUT';
const CODEX_FAILED = 'CODEX_FAILED';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run `which codex` (or the injected execFn) to determine whether the binary
 * is present on PATH.
 *
 * @param {function|undefined} execFn — injection point for tests
 * @returns {boolean}
 */
function _checkBinaryAvailable(execFn) {
  const spawn = typeof execFn === 'function' ? execFn : spawnSync;
  try {
    const result = spawn('which', ['codex'], { encoding: 'utf8', timeout: 5000 });
    return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim().length > 0;
  } catch (_err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// parseCodexOutput
// ---------------------------------------------------------------------------

/**
 * Extract structured findings from raw codex CLI output text.
 *
 * Detects:
 *   - lines starting with "FINDING:" or "- " as individual findings
 *   - "tokens used: N" or "tokens: N" to extract token count
 *   - the word "CRITICAL" anywhere (case-insensitive) for the hasCritical flag
 *
 * @param {string} output — raw stdout/stderr from a codex subprocess
 * @returns {{ findings: string[], tokens: number, hasCritical: boolean }}
 */
function parseCodexOutput(output) {
  if (typeof output !== 'string' || output.trim() === '') {
    return { findings: [], tokens: 0, hasCritical: false };
  }

  const lines = output.split('\n');
  const findings = [];
  let tokens = 0;
  let hasCritical = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Token count extraction: "tokens used: 1234" or "tokens: 1234"
    const tokenMatch = trimmed.match(/tokens(?:\s+used)?:\s*(\d+)/i);
    if (tokenMatch) {
      tokens = parseInt(tokenMatch[1], 10);
      continue;
    }

    // Finding lines: prefixed with "FINDING:" or "- "
    if (trimmed.startsWith('FINDING:')) {
      findings.push(trimmed.slice('FINDING:'.length).trim());
    } else if (trimmed.startsWith('- ') && trimmed.length > 2) {
      findings.push(trimmed.slice(2).trim());
    }

    // Critical detection (case-insensitive)
    if (/\bCRITICAL\b/i.test(trimmed)) {
      hasCritical = true;
    }
  }

  return { findings, tokens, hasCritical };
}

// ---------------------------------------------------------------------------
// isCodexAvailable
// ---------------------------------------------------------------------------

/**
 * Check whether the `codex` binary is available on PATH.
 *
 * @param {{ execFn?: function }|undefined} options
 * @returns {boolean}
 */
function isCodexAvailable(options) {
  const execFn = options && typeof options.execFn === 'function' ? options.execFn : undefined;
  return _checkBinaryAvailable(execFn);
}

// ---------------------------------------------------------------------------
// runCodexReview
// ---------------------------------------------------------------------------

/**
 * Run `codex review --base main` in a subprocess.
 *
 * @param {{
 *   cwd?: string,
 *   reasoning?: string,
 *   timeout?: number,
 *   execFn?: function,
 * }} options
 * @returns {{
 *   available: boolean,
 *   output?: string,
 *   tokens?: number,
 *   gate?: boolean,
 * }}
 */
function runCodexReview(options) {
  const opts = (options && typeof options === 'object') ? options : {};
  const execFn = typeof opts.execFn === 'function' ? opts.execFn : spawnSync;
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
  const reasoning = typeof opts.reasoning === 'string' ? opts.reasoning : 'medium';
  const timeout = typeof opts.timeout === 'number' && opts.timeout > 0
    ? opts.timeout
    : DEFAULT_TIMEOUT_MS;

  if (!_checkBinaryAvailable(execFn)) {
    return { available: false };
  }

  const args = ['review', '--base', 'main', '--reasoning', reasoning];
  let result;
  try {
    result = execFn('codex', args, {
      cwd,
      encoding: 'utf8',
      timeout,
    });
  } catch (err) {
    return { available: true, output: '', tokens: 0, gate: false, error: CODEX_FAILED };
  }

  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { available: true, output: '', tokens: 0, gate: false, error: CODEX_TIMEOUT };
  }

  if (result.status !== 0) {
    const stderr = (typeof result.stderr === 'string' ? result.stderr : '').trim();
    return {
      available: true,
      output: stderr || '',
      tokens: 0,
      gate: false,
      error: CODEX_FAILED,
    };
  }

  const rawOutput = (typeof result.stdout === 'string' ? result.stdout : '').trim();
  const parsed = parseCodexOutput(rawOutput);

  return {
    available: true,
    output: rawOutput,
    tokens: parsed.tokens,
    gate: !parsed.hasCritical,
  };
}

// ---------------------------------------------------------------------------
// runCodexChallenge
// ---------------------------------------------------------------------------

/**
 * Run codex in adversarial/challenge mode to surface potential issues.
 *
 * Invokes: `codex challenge --focus <focus> --reasoning <reasoning>`
 *
 * @param {{
 *   cwd?: string,
 *   focus?: string,
 *   reasoning?: string,
 *   timeout?: number,
 *   execFn?: function,
 * }} options
 * @returns {{
 *   available: boolean,
 *   output?: string,
 *   tokens?: number,
 *   findings?: string[],
 * }}
 */
function runCodexChallenge(options) {
  const opts = (options && typeof options === 'object') ? options : {};
  const execFn = typeof opts.execFn === 'function' ? opts.execFn : spawnSync;
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
  const focus = typeof opts.focus === 'string' && opts.focus.trim() ? opts.focus.trim() : 'security';
  const reasoning = typeof opts.reasoning === 'string' ? opts.reasoning : 'medium';
  const timeout = typeof opts.timeout === 'number' && opts.timeout > 0
    ? opts.timeout
    : DEFAULT_TIMEOUT_MS;

  if (!_checkBinaryAvailable(execFn)) {
    return { available: false };
  }

  const args = ['challenge', '--focus', focus, '--reasoning', reasoning];
  let result;
  try {
    result = execFn('codex', args, {
      cwd,
      encoding: 'utf8',
      timeout,
    });
  } catch (err) {
    return { available: true, output: '', tokens: 0, findings: [], error: CODEX_FAILED };
  }

  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { available: true, output: '', tokens: 0, findings: [], error: CODEX_TIMEOUT };
  }

  if (result.status !== 0) {
    const stderr = (typeof result.stderr === 'string' ? result.stderr : '').trim();
    return {
      available: true,
      output: stderr || '',
      tokens: 0,
      findings: [],
      error: CODEX_FAILED,
    };
  }

  const rawOutput = (typeof result.stdout === 'string' ? result.stdout : '').trim();
  const parsed = parseCodexOutput(rawOutput);

  return {
    available: true,
    output: rawOutput,
    tokens: parsed.tokens,
    findings: parsed.findings,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  isCodexAvailable,
  runCodexReview,
  runCodexChallenge,
  parseCodexOutput,
  CODEX_NOT_AVAILABLE,
  CODEX_TIMEOUT,
  CODEX_FAILED,
};
