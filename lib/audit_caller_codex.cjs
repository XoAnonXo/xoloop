'use strict';

/**
 * audit_caller_codex.cjs — Codex CLI wrapper for the audit phase.
 *
 * Spawns codex exec with a structured audit prompt, parses [P1]/[P2]/[P3]/[low]
 * markers in its output into Finding objects.
 *
 * Tests inject options.execFn to bypass the real codex binary.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AdapterError } = require('./errors.cjs');

// Anchor to line-start (multiline flag) so quoted inner [P1]/[P2]/... mentions
// in the body of a finding don't split it. Only tags at the beginning of a
// line start a new finding. Allow optional leading whitespace because the
// documented output format in buildAuditPrompt shows findings indented with
// two spaces, and models that mirror that format write indented tags.
//
// Round-15 P2: the original `\n*$` lookahead was a bug under the /m flag —
// `$` matches at any line-break position, so the non-greedy body `[\s\S]+?`
// would stop at the FIRST newline and truncate multi-line findings. Wrapped
// attack-scenario prose and trailing `Fix: ...` text on subsequent lines got
// silently dropped. Replace the tail lookahead with a true-end-of-input
// assertion `$(?![\s\S])` — `$` matches end-of-line, but the negative
// lookahead `(?![\s\S])` rejects unless there is no further character, so the
// body only terminates at the ACTUAL end of the document OR at the next
// severity tag on a line-start. Multi-line findings now survive intact.
const SEVERITY_PATTERN = /^[ \t]*\[(P1|P2|P3|low)\]\s*([\s\S]+?)(?=\n^[ \t]*\[(?:P1|P2|P3|low)\]|$(?![\s\S]))/gm;

function buildAuditPrompt(target) {
  const safe = (target && typeof target === 'object' && !Array.isArray(target)) ? target : {};
  const description = safe.description || 'Audit the listed files for security and correctness gaps.';
  const files = Array.isArray(safe.files) ? safe.files : [];
  return [
    description,
    '',
    'Files in scope:',
    ...files.map((f) => `  - ${f}`),
    '',
    'Output format — one finding per block, no preamble, no compliments:',
    '  [P1] <file>:<line> — <issue> — <attack scenario or root cause> — Fix: <one sentence>',
    '  [P2] <file>:<line> — <issue> — <…>',
    '  [P3] <file>:<line> — <issue> — <…>',
    '  [low] <file>:<line> — <issue> — <…>',
    '',
    'Severity meanings:',
    '  P1 = exploitable now or will silently corrupt data',
    '  P2 = requires unusual conditions OR breaks under maintenance',
    '  P3 = code smell that will cause a bug eventually',
    '  low = nit, style, or doc issue',
    '',
    'If the surface is clean, output exactly: NO_FINDINGS',
  ].join('\n');
}

function parseSeverityFinding(rawBlock, severity) {
  const trimmed = String(rawBlock || '').trim();
  if (!trimmed) {
    return null;
  }
  const fileMatch = trimmed.match(/^([^\s:]+\.[a-zA-Z0-9]+)(?::(\d+))?\s*[—\-]\s*(.+)$/s);
  if (fileMatch) {
    return {
      severity,
      file: fileMatch[1],
      line: fileMatch[2] ? Number(fileMatch[2]) : null,
      issue: fileMatch[3].trim(),
    };
  }
  return {
    severity,
    file: null,
    line: null,
    issue: trimmed,
  };
}

function parseAuditOutput(rawText) {
  const text = String(rawText || '');
  const trimmed = text.trim();
  // Only accept NO_FINDINGS when it is the ENTIRE trimmed body. A substring
  // match would silently discard a real finding whose prose mentions the
  // sentinel, and would also misfire if the model echoed the prompt (which
  // literally contains the word NO_FINDINGS).
  if (trimmed === 'NO_FINDINGS') {
    return { findings: [], raw: text, isClean: true };
  }
  // Round-9 P2: empty stdout used to fall through to matchAll (0 matches),
  // then skip the no_markers_in_nonempty_output branch (which gates on
  // trimmed.length > 0), and silently return isClean:true. A codex exit 0
  // with empty stdout must fail CLOSED — it is indistinguishable from a
  // muted process, a truncated pipe, or an auditor that decided to say
  // nothing. Only the exact NO_FINDINGS sentinel may converge the loop.
  if (trimmed.length === 0) {
    return {
      findings: [],
      raw: text,
      isClean: false,
      protocolError: 'empty_auditor_output',
    };
  }
  const findings = [];
  const matches = text.matchAll(SEVERITY_PATTERN);
  for (const match of matches) {
    const severity = match[1] === 'P1' ? 'P1'
      : match[1] === 'P2' ? 'P2'
      : match[1] === 'P3' ? 'P3'
      : 'low';
    const finding = parseSeverityFinding(match[2], severity);
    if (finding) {
      findings.push(finding);
    }
  }
  // Round-4 P2: when the trimmed output is non-empty AND zero markers were
  // parsed AND it is not the exact NO_FINDINGS sentinel, the model returned
  // a refusal ("I can't audit this"), a truncation message, or some other
  // format drift. The previous code treated this as isClean:true, which let
  // the loop silently converge while real findings were lost. Surface the
  // protocol error so callAuditorWithCodex can fail CLOSED.
  if (findings.length === 0 && trimmed.length > 0) {
    return {
      findings: [],
      raw: text,
      isClean: false,
      protocolError: 'no_markers_in_nonempty_output',
    };
  }
  return { findings, raw: text, isClean: findings.length === 0 };
}

function spawnCodexAudit(prompt, options = {}) {
  const execFn = typeof options.execFn === 'function' ? options.execFn : spawnSync;
  const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
  const reasoning = options.reasoning || 'high';
  const timeoutMs = Math.max(60000, Number(options.timeoutMs) || 300000);
  const args = [
    'exec',
    prompt,
    '-s', 'read-only',
    '-c', `model_reasoning_effort="${reasoning}"`,
    '--enable', 'web_search_cached',
  ];
  const result = execFn('codex', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    exitCode: result.status === null ? -1 : result.status,
    signal: result && result.signal ? String(result.signal) : null,
    spawnError: result && result.error
      ? (result.error.message ? String(result.error.message) : String(result.error))
      : null,
  };
}

async function callAuditorWithCodex(input = {}) {
  const target = input.target;
  if (!target || typeof target !== 'object') {
    throw new AdapterError(
      'CODEX_AUDIT_TARGET_REQUIRED',
      'target',
      'callAuditorWithCodex requires a target object',
      { fixHint: 'Pass input.target = { cwd, files, description }.' },
    );
  }
  const prompt = buildAuditPrompt(target);
  const spawnResult = spawnCodexAudit(prompt, {
    execFn: input.execFn,
    cwd: target.cwd,
    reasoning: input.reasoning,
    timeoutMs: input.timeoutMs,
  });
  // Fail CLOSED on timeout / signal / spawn error. Previously a null status
  // was mapped to -1 and skipped the error branch, so a timed-out codex run
  // was silently treated as "audit succeeded" with whatever partial stdout
  // happened to be on the buffer.
  if (spawnResult.spawnError) {
    throw new AdapterError(
      'CODEX_AUDIT_SPAWN_ERROR',
      'codex',
      `Codex audit spawn failed: ${spawnResult.spawnError}`,
      { fixHint: 'Check that the codex binary is installed and on PATH.' },
    );
  }
  if (spawnResult.signal) {
    throw new AdapterError(
      'CODEX_AUDIT_SIGNALED',
      'codex',
      `Codex audit terminated by signal ${spawnResult.signal}: ${spawnResult.stderr.slice(0, 200)}`,
      { fixHint: 'A signaled codex run is almost always a timeout — retry with a higher timeoutMs.' },
    );
  }
  if (spawnResult.exitCode === -1) {
    throw new AdapterError(
      'CODEX_AUDIT_TIMEOUT',
      'codex',
      `Codex audit timed out (status=null): ${spawnResult.stderr.slice(0, 200)}`,
      { fixHint: 'Increase timeoutMs or reduce the size of the audit target.' },
    );
  }
  if (spawnResult.exitCode !== 0) {
    throw new AdapterError(
      'CODEX_AUDIT_NONZERO_EXIT',
      'codex',
      `Codex audit exited with status ${spawnResult.exitCode}: ${spawnResult.stderr.slice(0, 200)}`,
      { fixHint: 'Inspect the codex stderr for an actionable error message.' },
    );
  }
  const parsed = parseAuditOutput(spawnResult.stdout);
  // Round-4 P2: when parseAuditOutput surfaces a protocolError (codex exited
  // 0 but returned a refusal, truncation, or other format drift with zero
  // markers and a non-empty body), throw so the loop fails CLOSED rather
  // than silently converging on a parse with no findings.
  if (parsed.protocolError) {
    throw new AdapterError(
      'CODEX_AUDIT_PROTOCOL_ERROR',
      'codex',
      `Codex audit returned no [P1]/[P2]/[P3]/[low] markers and was not NO_FINDINGS: ${spawnResult.stdout.slice(0, 200)}`,
      { fixHint: 'Re-run the audit; if this persists, inspect the codex output for refusals or truncation messages.' },
    );
  }
  return {
    findings: parsed.findings,
    rawOutput: spawnResult.stdout,
    isClean: parsed.isClean,
    target,
    prompt,
  };
}

module.exports = {
  buildAuditPrompt,
  callAuditorWithCodex,
  parseAuditOutput,
  parseSeverityFinding,
  spawnCodexAudit,
};
