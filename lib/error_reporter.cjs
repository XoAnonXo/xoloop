'use strict';

/**
 * error_reporter — silent error reporter SDK.
 *
 * After opt-in, captures AdapterErrors and creates structured reports
 * suitable for filing GitHub issues. Privacy-first: captures only error
 * codes, stack file paths, input shapes, timing, and versions. NEVER
 * captures source code, file contents, API keys, environment variables,
 * or input values.
 *
 * Levels:
 *   0 — disabled (no-op)
 *   1 — codes + sanitized stacks
 *   2 — + input shapes
 *   3 — + anonymized samples (reserved for future use)
 */

const os = require('node:os');
const path = require('node:path');
const { AdapterError } = require('./errors.cjs');

// ── Helpers ─────────────────────────────────────────────────────────

function getXoanonxoloopVersion(cwd) {
  try {
    const pkgPath = path.join(cwd || process.cwd(), 'package.json');
    const pkg = require(pkgPath);
    return pkg.version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

// ── sanitizeStack ───────────────────────────────────────────────────

/**
 * Strip absolute paths to relative, remove home directory references,
 * remove line content — keep only file:line:col.
 */
function sanitizeStack(stack) {
  if (typeof stack !== 'string') return '';
  const homeDir = os.homedir();
  const lines = stack.split('\n');
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Keep the first line (error message line) but strip any path info
    if (!trimmed.startsWith('at ')) {
      // Error message line — keep code/message but strip paths
      result.push(trimmed);
      continue;
    }
    // Stack frame line: extract file:line:col
    const match = trimmed.match(/\(([^)]+)\)/) || trimmed.match(/at\s+(\S+)$/);
    if (!match) {
      result.push('    at <unknown>');
      continue;
    }
    let location = match[1];
    // Strip home directory
    if (homeDir) {
      location = location.split(homeDir).join('~');
    }
    // Convert absolute paths to relative
    location = location.replace(/^\/[^:]*\/([^/]+\/[^/]+:[0-9]+:[0-9]+)/, '$1');
    // Remove everything before the last path component(s) keeping file:line:col
    // e.g. /Users/user/project/src/foo.cjs:10:5 -> src/foo.cjs:10:5
    location = location.replace(/^~\/[^:]*\/([^/]+\/[^/]+:[0-9]+:[0-9]+)/, '$1');
    // Single-component path after tilde
    location = location.replace(/^~\/[^:]*\/([^/]+:[0-9]+:[0-9]+)/, '$1');
    result.push('    at ' + location);
  }
  return result.join('\n');
}

// ── sanitizeInputShape ──────────────────────────────────────────────

/**
 * Return a shape descriptor without values.
 *   string(42), array(3), object{keys:5}, number, boolean, null, undefined
 */
function sanitizeInputShape(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return `string(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') {
    const keyCount = Object.keys(value).length;
    return `object{keys:${keyCount}}`;
  }
  return typeof value;
}

// ── createReport ────────────────────────────────────────────────────

/**
 * Create a structured report from an AdapterError.
 * Captures: code, field, fixHint, sanitized stack, nodeVersion, os,
 * xoanonxoloopVersion, inputShape, timestamp.
 */
function createReport(error, context) {
  const ctx = context || {};
  const level = typeof ctx.level === 'number' ? ctx.level : 2;
  const report = {
    code: (error && error.code) || 'UNKNOWN',
    field: (error && error.field) || null,
    fixHint: (error && error.fixHint) || null,
    stack: sanitizeStack((error && error.stack) || ''),
    nodeVersion: process.version,
    os: `${os.platform()} ${os.arch()}`,
    xoanonxoloopVersion: ctx.xoanonxoloopVersion || getXoanonxoloopVersion(ctx.cwd),
    timestamp: new Date().toISOString(),
  };
  if (level >= 2 && ctx.input !== undefined) {
    report.inputShape = sanitizeInputShape(ctx.input);
  }
  return report;
}

// ── batchReports ────────────────────────────────────────────────────

/**
 * Deduplicate reports by error code within a batch.
 * Same code = 1 report with count: N.
 */
function batchReports(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return [];
  const map = new Map();
  for (const r of reports) {
    if (!r || typeof r.code !== 'string') continue;
    if (map.has(r.code)) {
      const existing = map.get(r.code);
      existing.count += 1;
    } else {
      map.set(r.code, { ...r, count: 1 });
    }
  }
  return Array.from(map.values());
}

// ── formatIssueTitle ────────────────────────────────────────────────

/**
 * Format as: [auto-report] ERROR_CODE (vX.Y.Z)
 */
function formatIssueTitle(batchedReport) {
  const code = (batchedReport && batchedReport.code) || 'UNKNOWN';
  const version = (batchedReport && batchedReport.xoanonxoloopVersion) || 'unknown';
  return `[auto-report] ${code} (v${version})`;
}

// ── formatIssueBody ─────────────────────────────────────────────────

/**
 * Format as structured YAML for GitHub issue body.
 */
function formatIssueBody(batchedReport) {
  const r = batchedReport || {};
  const lines = [
    '```yaml',
    `code: ${r.code || 'UNKNOWN'}`,
    `field: ${r.field || 'null'}`,
    `fixHint: ${r.fixHint || 'null'}`,
    `count: ${r.count || 1}`,
    `nodeVersion: ${r.nodeVersion || 'unknown'}`,
    `os: ${r.os || 'unknown'}`,
    `xoanonxoloopVersion: ${r.xoanonxoloopVersion || 'unknown'}`,
    `timestamp: ${r.timestamp || 'unknown'}`,
  ];
  if (r.inputShape) {
    lines.push(`inputShape: ${r.inputShape}`);
  }
  if (r.stack) {
    lines.push(`stack: |`);
    const stackLines = r.stack.split('\n');
    for (const sl of stackLines) {
      lines.push(`  ${sl}`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

// ── install ─────────────────────────────────────────────────────────

/**
 * Set up the reporter.
 *
 * Options: { repo, consent, level, batchIntervalMs, maxReportsPerHour, cwd }
 * Returns a reporter instance. If consent is false/missing, returns a no-op reporter.
 *
 * Throws AdapterError for invalid arguments.
 */
function install(options) {
  // Validate options
  if (options === null || (options !== undefined && typeof options !== 'object')) {
    throw new AdapterError(
      'REPORTER_INVALID_OPTIONS',
      'options',
      'options must be a non-null object',
      { fixHint: 'Pass a plain object: install({ repo: "owner/repo", consent: true }).' }
    );
  }
  const opts = options || {};

  // Check consent first
  if (opts.consent !== true) {
    // No-op reporter
    return {
      consent: false,
      report: function () { return null; },
      flush: function () { return []; },
      destroy: function () {},
    };
  }

  // Consent is true; repo is required
  if (!opts.repo || typeof opts.repo !== 'string') {
    throw new AdapterError(
      'REPORTER_REPO_REQUIRED',
      'repo',
      'repo string is required when consent is true',
      { fixHint: 'Pass repo as "owner/repo" string: install({ repo: "owner/repo", consent: true }).' }
    );
  }

  const level = typeof opts.level === 'number' ? opts.level : 2;
  const maxReportsPerHour = typeof opts.maxReportsPerHour === 'number' ? opts.maxReportsPerHour : 60;
  const cwd = opts.cwd || process.cwd();
  const version = getXoanonxoloopVersion(cwd);

  const pending = [];
  let reportCount = 0;
  let hourStart = Date.now();

  function report(error, context) {
    // Rate limiting
    const now = Date.now();
    if (now - hourStart > 3600000) {
      reportCount = 0;
      hourStart = now;
    }
    if (reportCount >= maxReportsPerHour) return null;
    reportCount += 1;

    const ctx = { ...(context || {}), level, cwd, xoanonxoloopVersion: version };
    const r = createReport(error, ctx);
    pending.push(r);
    return r;
  }

  function flush() {
    const batch = batchReports(pending.splice(0));
    return batch;
  }

  function destroy() {
    pending.length = 0;
  }

  return {
    consent: true,
    repo: opts.repo,
    level,
    report,
    flush,
    destroy,
  };
}

module.exports = {
  install,
  createReport,
  sanitizeStack,
  sanitizeInputShape,
  batchReports,
  formatIssueBody,
  formatIssueTitle,
};
