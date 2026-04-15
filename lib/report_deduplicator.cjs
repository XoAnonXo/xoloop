'use strict';

/**
 * report_deduplicator.cjs
 *
 * Handles deduplication of error reports before creating GitHub issues.
 * Uses `gh` CLI (via spawnSync) for all GitHub API calls.
 * fetchFn injection is supported for ALL gh calls so tests never hit real GitHub.
 */

const { spawnSync } = require('node:child_process');
const { AdapterError } = require('./errors.cjs');

// ── Severity → priority label mapping ────────────────────────────────

const SEVERITY_LABEL_MAP = {
  critical: 'priority/P0',
  high:     'priority/P1',
  medium:   'priority/P2',
  low:      'priority/P3',
};

const TYPE_LABEL_MAP = {
  bug:      'type/bug',
  feature:  'type/feature',
  question: 'type/question',
  other:    'type/other',
};

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Execute a gh API call via spawnSync and return the parsed JSON response.
 * Throws AdapterError on spawn errors, non-zero exit, or JSON parse failure.
 */
function ghApi(args, { cwd } = {}) {
  const result = spawnSync('gh', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new AdapterError(
        'DEDUP_GH_NOT_FOUND', 'gh',
        'gh command not found — install GitHub CLI',
        { fixHint: 'Install the GitHub CLI: https://cli.github.com/', cause: result.error },
      );
    }
    throw new AdapterError(
      'DEDUP_GH_SPAWN_ERROR', 'gh',
      `gh spawn error: ${result.error.message}`,
      { fixHint: 'Check that gh is installed and authenticated.', cause: result.error },
    );
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new AdapterError(
      'DEDUP_GH_API_FAILED', 'gh',
      `gh exited ${result.status}: ${stderr}`,
      { fixHint: 'Run `gh auth status` to verify authentication.' },
    );
  }

  const stdout = (result.stdout || '').trim();
  if (!stdout) return null;

  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new AdapterError(
      'DEDUP_GH_PARSE_FAILED', 'gh',
      `Failed to parse gh output as JSON: ${e.message}`,
      { fixHint: 'Unexpected response from gh api — check your query.', cause: e },
    );
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * createRateLimiter — returns a rate limiter object { check(), reset() }.
 * Tracks calls within a rolling 1-hour window.
 */
function createRateLimiter(maxPerHour) {
  const max = (typeof maxPerHour === 'number' && maxPerHour > 0) ? maxPerHour : 10;
  const windowMs = 60 * 60 * 1000; // 1 hour
  let timestamps = [];

  return {
    check() {
      const now = Date.now();
      // Prune timestamps older than 1 hour
      timestamps = timestamps.filter((t) => now - t < windowMs);
      if (timestamps.length >= max) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
    reset() {
      timestamps = [];
    },
  };
}

/**
 * shouldReport — checks rate limit before reporting.
 * Returns true if the report should proceed, false if rate-limited.
 * Throws DEDUP_RATE_LIMITED AdapterError when limit exceeded.
 */
function shouldReport(report, rateLimiter) {
  if (!report || typeof report !== 'object') {
    throw new AdapterError(
      'DEDUP_REPORT_REQUIRED', 'report',
      'report is required and must be an object',
      { fixHint: 'Pass a valid report object to shouldReport.' },
    );
  }
  if (!rateLimiter || typeof rateLimiter.check !== 'function') {
    throw new AdapterError(
      'DEDUP_RATE_LIMITER_REQUIRED', 'rateLimiter',
      'rateLimiter must have a check() method',
      { fixHint: 'Pass a rateLimiter created by createRateLimiter().' },
    );
  }

  const allowed = rateLimiter.check();
  if (!allowed) {
    throw new AdapterError(
      'DEDUP_RATE_LIMITED', 'rateLimiter',
      'exceeded maxReportsPerHour rate limit',
      { fixHint: 'Wait before submitting more reports, or increase maxReportsPerHour.' },
    );
  }
  return true;
}

/**
 * buildIssueLabels — returns array of labels for a report.
 * Always includes 'auto-report', plus severity and type labels.
 */
function buildIssueLabels(report) {
  if (!report || typeof report !== 'object') {
    throw new AdapterError(
      'DEDUP_REPORT_REQUIRED', 'report',
      'report is required and must be an object',
      { fixHint: 'Pass a valid report object to buildIssueLabels.' },
    );
  }

  const severity = (report.severity || '').toLowerCase();
  const type = (report.type || '').toLowerCase();

  const severityLabel = SEVERITY_LABEL_MAP[severity] || 'priority/P3';
  const typeLabel = TYPE_LABEL_MAP[type] || 'type/other';

  return ['auto-report', severityLabel, typeLabel];
}

/**
 * searchExistingIssue — search GitHub issues for a report with the same error code.
 * Options: { repo, errorCode, fetchFn }
 * Returns { found: boolean, issueNumber: number|null, issueUrl: string|null }
 */
function searchExistingIssue(options = {}) {
  const { repo, errorCode, fetchFn } = options || {};

  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    throw new AdapterError(
      'DEDUP_REPO_REQUIRED', 'repo',
      'repo is required (e.g. "owner/repo")',
      { fixHint: 'Pass options.repo as "owner/repo".' },
    );
  }
  if (!errorCode || typeof errorCode !== 'string' || !errorCode.trim()) {
    throw new AdapterError(
      'DEDUP_REPORT_REQUIRED', 'errorCode',
      'errorCode is required to search for duplicates',
      { fixHint: 'Pass options.errorCode as a non-empty string.' },
    );
  }

  // Dependency-injection path (tests)
  if (typeof fetchFn === 'function') {
    const issues = fetchFn({ repo, errorCode, action: 'search' });
    // Expect array; pick first match
    if (Array.isArray(issues) && issues.length > 0) {
      const issue = issues[0];
      return {
        found: true,
        issueNumber: issue.number || null,
        issueUrl: issue.html_url || issue.url || null,
      };
    }
    return { found: false, issueNumber: null, issueUrl: null };
  }

  // Real path: search via gh api
  const query = `${errorCode} in:title repo:${repo} is:issue is:open`;
  const parsed = ghApi([
    'api', 'search/issues',
    '-f', `q=${query}`,
    '-f', 'per_page=1',
  ]);

  const items = (parsed && Array.isArray(parsed.items)) ? parsed.items : [];
  if (items.length === 0) {
    return { found: false, issueNumber: null, issueUrl: null };
  }

  const issue = items[0];
  return {
    found: true,
    issueNumber: issue.number || null,
    issueUrl: issue.html_url || issue.url || null,
  };
}

/**
 * createOrUpdateIssue — create a new issue or add a comment to an existing one.
 * Options: { repo, labels, fetchFn }
 * Returns { action: 'created'|'updated', issueNumber, issueUrl }
 */
function createOrUpdateIssue(report, options = {}) {
  const { repo, labels, fetchFn } = options || {};

  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    throw new AdapterError(
      'DEDUP_REPO_REQUIRED', 'repo',
      'repo is required (e.g. "owner/repo")',
      { fixHint: 'Pass options.repo as "owner/repo".' },
    );
  }
  if (!report || typeof report !== 'object') {
    throw new AdapterError(
      'DEDUP_REPORT_REQUIRED', 'report',
      'report is required and must be an object',
      { fixHint: 'Pass a valid report object as the first argument.' },
    );
  }

  const errorCode = (report.errorCode || report.code || '').toString().trim();
  if (!errorCode) {
    throw new AdapterError(
      'DEDUP_REPORT_REQUIRED', 'report.errorCode',
      'report.errorCode is required',
      { fixHint: 'Ensure the report object has an errorCode or code field.' },
    );
  }

  // Check for existing issue
  const existing = searchExistingIssue({ repo, errorCode, fetchFn });

  // Resolve labels
  const issueLabels = Array.isArray(labels) ? labels : buildIssueLabels(report);

  if (existing.found && existing.issueNumber != null) {
    // Add comment to existing issue
    const occurrences = (typeof report.occurrences === 'number') ? report.occurrences : 1;
    const version = report.version || 'unknown';
    const commentBody = `**New occurrence** — version: \`${version}\`, count: ${occurrences}\n\n${report.message || ''}`.trim();

    if (typeof fetchFn === 'function') {
      fetchFn({
        repo,
        issueNumber: existing.issueNumber,
        commentBody,
        action: 'comment',
      });
    } else {
      ghApi([
        'api', `repos/${repo}/issues/${existing.issueNumber}/comments`,
        '--method', 'POST',
        '-f', `body=${commentBody}`,
      ]);
    }

    return {
      action: 'updated',
      issueNumber: existing.issueNumber,
      issueUrl: existing.issueUrl,
    };
  }

  // Create new issue
  const title = report.title || `[auto-report] ${errorCode}`;
  const body = report.body || report.message || `Automated error report for \`${errorCode}\`.`;
  const version = report.version || 'unknown';
  const fullBody = `${body}\n\n---\n_Version: ${version}_`;

  let createdIssue;

  if (typeof fetchFn === 'function') {
    createdIssue = fetchFn({
      repo,
      title,
      body: fullBody,
      labels: issueLabels,
      action: 'create',
    });
  } else {
    const args = [
      'api', `repos/${repo}/issues`,
      '--method', 'POST',
      '-f', `title=${title}`,
      '-f', `body=${fullBody}`,
    ];
    for (const label of issueLabels) {
      args.push('-f', `labels[]=${label}`);
    }
    createdIssue = ghApi(args);
  }

  const issueNumber = (createdIssue && createdIssue.number) ? createdIssue.number : null;
  const issueUrl = (createdIssue && (createdIssue.html_url || createdIssue.url)) || null;

  return {
    action: 'created',
    issueNumber,
    issueUrl,
  };
}

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
  searchExistingIssue,
  createOrUpdateIssue,
  buildIssueLabels,
  shouldReport,
  createRateLimiter,
};
