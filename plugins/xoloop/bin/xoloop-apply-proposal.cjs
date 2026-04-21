#!/usr/bin/env node
/**
 * xoloop-apply-proposal.cjs — subagent → engine bridge.
 *
 * The plugin's default operational mode is "skill-driven loop": the skill
 * spawns Agent() subagents that produce a changeSet proposal. This binary
 * is how the skill applies that proposal without going through the engine's
 * own model-calling loop (which requires an API key).
 *
 * Input contract:
 *   Proposal JSON is read from stdin OR from the file at --proposal-file.
 *   Format matches change_set_engine's applyChangeSet input:
 *     {
 *       "changeSet": [
 *         { "kind": "replace_once", "path": "rel/path.js",
 *           "match": "...", "replace": "..." },
 *         { "kind": "create_file", "path": "new.js", "content": "..." },
 *         { "kind": "delete_file", "path": "dead.js" }
 *       ],
 *       "rationale": "why this change is safe and useful"
 *     }
 *
 * Execution sequence:
 *   1. Parse + validate proposal shape
 *   2. Preflight every path through the allowlist (allowed-paths flag)
 *   3. Call change_set_engine.applyChangeSet (temp-file-stage + atomic
 *      rename with verification manifest TOCTOU gate)
 *   4. If --validate "<shell-command>" supplied, run the command; on
 *      non-zero exit, call rollbackAppliedChangeSet
 *   5. Emit a JSON report on stdout describing what happened
 *
 * Output contract (stdout, exactly one JSON line):
 *   {
 *     "applied": boolean,
 *     "validated": boolean,
 *     "rolledBack": boolean,
 *     "operationCount": number,
 *     "validationExitCode": number|null,
 *     "validationElapsedMs": number|null,
 *     "error": string|null,
 *     "errorCode": string|null,
 *     "rollbackErrors": [...] | null,
 *     "filesTouched": ["rel/path.js", ...]
 *   }
 *
 * Exit codes:
 *   0   proposal applied AND validation passed (or --no-validate)
 *   1   proposal rejected — schema invalid, path out of scope, or
 *       apply itself threw
 *   2   proposal applied then rolled back due to validation failure
 *   3   fatal error in the bridge itself (stderr has details)
 *
 * The skill reads stdout as JSON, then decides keep-iterate / stop-saturated
 * / stop-degradation based on the report.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  requireLib,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const {
  applyChangeSet,
  rollbackAppliedChangeSet,
  normalizeChangeSet,
} = requireLib('change_set_engine.cjs');

// Optional mode gates (loaded lazily — they're only required when
// --require-simplify or --require-docs is passed).
function loadSimplifyEngine() { return requireLib('xo_simplify_engine.cjs'); }
function loadDocsEngine() { return requireLib('xo_docs_engine.cjs'); }

function printReport(report) {
  process.stdout.write(JSON.stringify(report) + '\n');
}

function readProposalInput(argv) {
  const proposalFile = parseFlag(argv, '--proposal-file', null);
  if (proposalFile) {
    const absolutePath = path.resolve(proposalFile);
    return fs.readFileSync(absolutePath, 'utf8');
  }
  // Read from stdin until EOF.
  return fs.readFileSync(0, 'utf8');
}

function parseProposal(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error = new Error(`proposal JSON parse failed: ${err.message}`);
    error.code = 'XOLOOP_PROPOSAL_INVALID_JSON';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('proposal must be a JSON object with a changeSet array');
    error.code = 'XOLOOP_PROPOSAL_NOT_OBJECT';
    throw error;
  }
  if (!Array.isArray(parsed.changeSet)) {
    const error = new Error('proposal.changeSet must be an array');
    error.code = 'XOLOOP_PROPOSAL_MISSING_CHANGESET';
    throw error;
  }
  return parsed;
}

function parseAllowedPaths(argv, cwd) {
  const raw = parseFlag(argv, '--allowed-paths', null);
  if (!raw) return null; // means no allowlist enforcement
  return raw.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.isAbsolute(entry) ? entry : path.resolve(cwd, entry));
}

async function runValidation(command, cwd, timeoutMs) {
  const t0 = Date.now();
  const result = spawnSync('bash', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - t0;
  const exitCode = result.status === null ? 1 : result.status;
  return {
    passed: exitCode === 0,
    exitCode,
    elapsedMs,
    stdoutTail: String(result.stdout || '').slice(-2000),
    stderrTail: String(result.stderr || '').slice(-2000),
  };
}

// Parse METRIC lines from a benchmark script's stdout.
// Format (pi-autoresearch style): `METRIC name=value` per line.
// Additional formats tolerated: `METRIC name value`, `METRIC name: value`.
function parseMetricLines(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('METRIC')) continue;
    const rest = trimmed.slice('METRIC'.length).trim();
    // `name=value` or `name value` or `name: value`
    const eqMatch = rest.match(/^([A-Za-z0-9_\-.]+)\s*[=:]\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(\S*)$/);
    const spaceMatch = !eqMatch ? rest.match(/^([A-Za-z0-9_\-.]+)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(\S*)$/) : null;
    const m = eqMatch || spaceMatch;
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    out.push({ name: m[1], value, unit: m[3] || null });
  }
  return out;
}

async function runBenchmark(command, cwd, timeoutMs) {
  const t0 = Date.now();
  const result = spawnSync('bash', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - t0;
  const exitCode = result.status === null ? 1 : result.status;
  const metrics = parseMetricLines(result.stdout);
  return {
    passed: exitCode === 0,
    exitCode,
    elapsedMs,
    metrics,
    stdoutTail: String(result.stdout || '').slice(-2000),
    stderrTail: String(result.stderr || '').slice(-2000),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage: xoloop-apply-proposal [--proposal-file <path>]');
    console.log('                             [--allowed-paths <p1,p2,...>]');
    console.log('                             [--validate "<shell-command>"]');
    console.log('                             [--benchmark "<shell-command>"]');
    console.log('                             [--asi <json-string>]');
    console.log('                             [--validate-timeout-ms N]');
    console.log('                             [--benchmark-timeout-ms N]');
    console.log('                             [--no-validate]');
    console.log('');
    console.log('Reads a changeSet proposal on stdin (or from --proposal-file),');
    console.log('applies it atomically through change_set_engine, optionally');
    console.log('runs --benchmark (captures METRIC name=value lines from stdout),');
    console.log('runs --validate (correctness gate), and rolls back on failure.');
    console.log('Emits one JSON line to stdout describing the outcome.');
    console.log('');
    console.log('--asi accepts a JSON string with free-form agent-supplied');
    console.log('information (what I learned, why I tried this, what to try');
    console.log('next). Persisted in the bridge report for session ledger use.');
    process.exit(0);
  }

  const cwd = process.cwd();
  const allowedPaths = parseAllowedPaths(argv, cwd);
  const validateCommand = parseFlag(argv, '--validate', null);
  const benchmarkCommand = parseFlag(argv, '--benchmark', null);
  const asiRaw = parseFlag(argv, '--asi', null);
  const skipValidate = hasFlag(argv, '--no-validate');
  const validateTimeoutMs = Number(parseFlag(argv, '--validate-timeout-ms', 600000));
  const benchmarkTimeoutMs = Number(parseFlag(argv, '--benchmark-timeout-ms', 600000));
  const requireSimplify = hasFlag(argv, '--require-simplify');
  const requireDocs = hasFlag(argv, '--require-docs');

  // Parse agent-supplied information (ASI). Must be valid JSON; otherwise
  // we surface as a warning on the report instead of swallowing it.
  let asi = null;
  let asiWarning = null;
  if (asiRaw) {
    try {
      asi = JSON.parse(asiRaw);
    } catch (parseErr) {
      asiWarning = `ASI JSON parse failed: ${parseErr.message}. Pass a valid JSON string.`;
    }
  }

  let proposal;
  try {
    const raw = readProposalInput(argv);
    proposal = parseProposal(raw);
  } catch (err) {
    printReport({
      applied: false,
      validated: false,
      rolledBack: false,
      operationCount: 0,
      validationExitCode: null,
      validationElapsedMs: null,
      error: err.message,
      errorCode: err.code || 'XOLOOP_PROPOSAL_READ_FAILED',
      rollbackErrors: null,
      filesTouched: [],
    });
    process.exit(1);
  }

  // Normalize + extract file-touched list for the report.
  let normalized;
  try {
    normalized = normalizeChangeSet(proposal.changeSet);
  } catch (err) {
    printReport({
      applied: false,
      validated: false,
      rolledBack: false,
      operationCount: 0,
      validationExitCode: null,
      validationElapsedMs: null,
      error: err.message,
      errorCode: err.code || 'XOLOOP_CHANGESET_INVALID',
      rollbackErrors: null,
      filesTouched: [],
    });
    process.exit(1);
  }
  const filesTouched = Array.from(new Set(normalized.map((op) => op.path).filter(Boolean)));

  // Mode gate (pre-apply): simplify and docs proposals must clear their
  // language-specific rules before anything touches disk.
  let simplifyBaseline = null;
  if (requireSimplify) {
    const simplifyEngine = loadSimplifyEngine();
    const gate = simplifyEngine.validateSimplifyProposal(proposal, cwd);
    if (!gate.ok) {
      printReport({
        applied: false,
        validated: false,
        rolledBack: false,
        operationCount: normalized.length,
        validationExitCode: null,
        validationElapsedMs: null,
        error: gate.reason,
        errorCode: 'SIMPLIFY_GATE_FAIL',
        simplifyGate: gate,
        asi: null,
        asiWarning,
        rollbackErrors: null,
        filesTouched,
      });
      process.exit(1);
    }
    // Capture baseline metrics for the touched files.
    simplifyBaseline = { perFile: {}, total: { sloc: 0, cyclomatic: 0, exports: 0 } };
    for (const rel of filesTouched) {
      const abs = path.resolve(cwd, rel);
      const metric = simplifyEngine.measureComplexity(abs);
      simplifyBaseline.perFile[rel] = metric;
      simplifyBaseline.total.sloc += metric.sloc;
      simplifyBaseline.total.cyclomatic += metric.cyclomatic;
      simplifyBaseline.total.exports += metric.exports;
    }
  }
  if (requireDocs) {
    const docsEngine = loadDocsEngine();
    const gate = docsEngine.validateDocsProposal(proposal);
    if (!gate.ok) {
      printReport({
        applied: false,
        validated: false,
        rolledBack: false,
        operationCount: normalized.length,
        validationExitCode: null,
        validationElapsedMs: null,
        error: gate.reason,
        errorCode: 'DOCS_GATE_FAIL',
        docsGate: gate,
        asi: null,
        asiWarning,
        rollbackErrors: null,
        filesTouched,
      });
      process.exit(1);
    }
  }

  // Apply the changeSet.
  let handle;
  try {
    handle = applyChangeSet(proposal.changeSet, {
      cwd,
      allowedPaths: allowedPaths || undefined,
    });
  } catch (err) {
    printReport({
      applied: false,
      validated: false,
      rolledBack: false,
      operationCount: normalized.length,
      validationExitCode: null,
      validationElapsedMs: null,
      error: err.message,
      errorCode: err.code || 'XOLOOP_APPLY_FAILED',
      rollbackErrors: err.rollbackErrors || null,
      filesTouched,
    });
    process.exit(1);
  }

  // Run benchmark (optional). Metrics captured; exit code surfaces but
  // does NOT gate keep/discard on its own — the validate command (if
  // provided) is the correctness gate. Benchmark runs independently of
  // --no-validate (operators may want metric-only runs).
  let benchmark = null;
  if (benchmarkCommand) {
    benchmark = await runBenchmark(benchmarkCommand, cwd, benchmarkTimeoutMs);
  }

  // Optionally validate. --no-validate or no command → skip.
  let validation = null;
  if (validateCommand && !skipValidate) {
    validation = await runValidation(validateCommand, cwd, validateTimeoutMs);
  }

  if (validation && !validation.passed) {
    // Roll back and report.
    let rollbackErrors = null;
    try {
      const rollbackResult = rollbackAppliedChangeSet(handle);
      rollbackErrors = Array.isArray(rollbackResult) && rollbackResult.length > 0
        ? rollbackResult
        : null;
    } catch (rollbackErr) {
      rollbackErrors = [{
        path: null,
        action: 'rollback',
        error: rollbackErr.message || String(rollbackErr),
      }];
    }
    printReport({
      applied: true,
      validated: false,
      rolledBack: true,
      operationCount: normalized.length,
      validationExitCode: validation.exitCode,
      validationElapsedMs: validation.elapsedMs,
      benchmarkMetrics: benchmark ? benchmark.metrics : null,
      benchmarkExitCode: benchmark ? benchmark.exitCode : null,
      asi,
      asiWarning,
      error: `validation failed (exit ${validation.exitCode})`,
      errorCode: 'XOLOOP_VALIDATION_FAILED',
      validationStderrTail: validation.stderrTail,
      validationStdoutTail: validation.stdoutTail,
      rollbackErrors,
      filesTouched,
    });
    process.exit(2);
  }

  // Post-apply metric gate (simplify only). If the change didn't
  // actually reduce complexity, roll back even though tests passed —
  // that's the whole point of simplify.
  let simplifyVerdict = null;
  if (requireSimplify && simplifyBaseline) {
    const simplifyEngine = loadSimplifyEngine();
    const after = { perFile: {}, total: { sloc: 0, cyclomatic: 0, exports: 0 } };
    for (const rel of filesTouched) {
      const abs = path.resolve(cwd, rel);
      const metric = simplifyEngine.measureComplexity(abs);
      after.perFile[rel] = metric;
      after.total.sloc += metric.sloc;
      after.total.cyclomatic += metric.cyclomatic;
      after.total.exports += metric.exports;
    }
    simplifyVerdict = simplifyEngine.verifyMetricImprovement(
      simplifyBaseline.total,
      after.total
    );
    if (!simplifyVerdict.ok) {
      let rollbackErrors = null;
      try {
        const rollbackResult = rollbackAppliedChangeSet(handle);
        rollbackErrors = Array.isArray(rollbackResult) && rollbackResult.length > 0
          ? rollbackResult
          : null;
      } catch (rollbackErr) {
        rollbackErrors = [{
          path: null,
          action: 'rollback',
          error: rollbackErr.message || String(rollbackErr),
        }];
      }
      printReport({
        applied: true,
        validated: validation ? validation.passed : null,
        rolledBack: true,
        operationCount: normalized.length,
        validationExitCode: validation ? validation.exitCode : null,
        validationElapsedMs: validation ? validation.elapsedMs : null,
        simplifyVerdict,
        simplifyBaseline: simplifyBaseline.total,
        simplifyAfter: after.total,
        asi,
        asiWarning,
        error: simplifyVerdict.reason,
        errorCode: 'SIMPLIFY_METRIC_REGRESSED',
        rollbackErrors,
        filesTouched,
      });
      process.exit(2);
    }
  }

  printReport({
    applied: true,
    validated: validation ? validation.passed : null,
    rolledBack: false,
    operationCount: normalized.length,
    validationExitCode: validation ? validation.exitCode : null,
    validationElapsedMs: validation ? validation.elapsedMs : null,
    benchmarkMetrics: benchmark ? benchmark.metrics : null,
    benchmarkExitCode: benchmark ? benchmark.exitCode : null,
    benchmarkElapsedMs: benchmark ? benchmark.elapsedMs : null,
    simplifyVerdict,
    simplifyBaseline: simplifyBaseline ? simplifyBaseline.total : null,
    asi,
    asiWarning,
    error: null,
    errorCode: null,
    rollbackErrors: null,
    filesTouched,
  });
  process.exit(0);
}

main().catch((err) => {
  printReport({
    applied: false,
    validated: false,
    rolledBack: false,
    operationCount: 0,
    validationExitCode: null,
    validationElapsedMs: null,
    error: `bridge fatal: ${err.message || String(err)}`,
    errorCode: err.code || 'XOLOOP_BRIDGE_FATAL',
    rollbackErrors: null,
    filesTouched: [],
  });
  process.exit(3);
});
