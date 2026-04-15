'use strict';

/**
 * inbox_reporter.cjs — Morning review module.
 *
 * Summarizes overnight triage results for the developer: pending directives,
 * approved fixes ready to merge, recently completed fixes, and GitHub
 * auto-report issues filed in the given time window.
 *
 * Exports:
 *   buildInboxSummary(options)   — structured summary object
 *   formatInboxSummary(summary)  — human-readable terminal string
 *   parseInboxCommand(argv)      — parse CLI args: --hours, --repo, --base-dir
 *
 * Error codes (AdapterError):
 *   INBOX_INVALID_OPTIONS   — null/non-object options
 *   INBOX_BASE_DIR_REQUIRED — missing baseDir
 */

const path = require('node:path');

const { AdapterError } = require('./errors.cjs');
const {
  listPendingDirectives,
  listApprovedDirectives,
} = require('./directive_approval.cjs');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a sortable priority level from a directive object.
 * Returns 'high' | 'medium' | 'low'.
 */
function extractPriority(directive) {
  if (!directive || typeof directive !== 'object') return 'low';
  return directive.priority || directive._priority || 'low';
}

/**
 * Extract an error code from a directive object.
 */
function extractErrorCode(directive) {
  if (!directive || typeof directive !== 'object') return null;
  return directive.errorCode || directive.error_code || directive.code || null;
}

/**
 * Extract the action description from a directive object.
 */
function extractAction(directive) {
  if (!directive || typeof directive !== 'object') return null;
  return directive.action || directive.type || null;
}

/**
 * Extract the reason from a directive object.
 */
function extractReason(directive) {
  if (!directive || typeof directive !== 'object') return null;
  return directive.reason || directive.description || directive.commonTheme || null;
}

/**
 * Determine whether a directive in approved/ has a linked PR (i.e. is a
 * "fix ready to merge").
 */
function extractPrInfo(directive) {
  if (!directive || typeof directive !== 'object') return null;
  const prNumber = directive.prNumber || directive.pr_number || directive.pullRequest || null;
  if (!prNumber) return null;
  return {
    prNumber,
    status: directive.prStatus || directive.pr_status || 'open',
  };
}

/**
 * Build a recommendation sentence from the summary data.
 */
function buildRecommendation(summary) {
  const parts = [];

  const fixCount = summary.directives.fixesReady.length;
  if (fixCount > 0) {
    parts.push(`${fixCount} fix${fixCount === 1 ? '' : 'es'} ready to merge`);
  }

  const pendingCount = summary.directives.pending.length;
  if (pendingCount > 0) {
    parts.push(`${pendingCount} pending directive${pendingCount === 1 ? '' : 's'} to review`);
  }

  if (parts.length === 0) {
    return 'no action needed';
  }

  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// buildInboxSummary
// ---------------------------------------------------------------------------

/**
 * Build a structured inbox summary.
 *
 * @param {object} options
 * @param {string} options.baseDir  — base directives directory (required)
 * @param {string} [options.repo]   — GitHub repo slug (owner/repo) for issue fetch
 * @param {number} [options.hours]  — look-back window in hours (default 12)
 * @param {Function} [options.fetchFn] — injectable GitHub fetch function
 * @returns {object} structured summary
 */
function buildInboxSummary(options) {
  if (options === null || options === undefined || typeof options !== 'object') {
    throw new AdapterError(
      'INBOX_INVALID_OPTIONS',
      'options',
      'options must be a non-null object',
      { fixHint: 'Pass a plain object: buildInboxSummary({ baseDir: ".xoanon/directives" }).' },
    );
  }

  const baseDir = options.baseDir;
  if (!baseDir || typeof baseDir !== 'string' || !baseDir.trim()) {
    throw new AdapterError(
      'INBOX_BASE_DIR_REQUIRED',
      'baseDir',
      'baseDir string is required',
      { fixHint: 'Pass options.baseDir (e.g. ".xoanon/directives").' },
    );
  }

  const hours = typeof options.hours === 'number' && options.hours > 0 ? options.hours : 12;
  const repo = options.repo || null;
  const fetchFn = typeof options.fetchFn === 'function' ? options.fetchFn : null;

  const now = new Date();
  const from = new Date(now.getTime() - hours * 3600000);

  // ── Gather directives ──────────────────────────────────────────────
  const pendingRaw = listPendingDirectives(baseDir);
  const approvedRaw = listApprovedDirectives(baseDir);

  // Map pending directives
  const pending = pendingRaw.map((entry) => ({
    path: entry.path,
    priority: extractPriority(entry.directive),
    errorCode: extractErrorCode(entry.directive),
    action: extractAction(entry.directive),
    reason: extractReason(entry.directive),
  }));

  // Approved directives split into fixes-ready (has PR) vs. other
  const fixesReady = [];
  for (const entry of approvedRaw) {
    const prInfo = extractPrInfo(entry.directive);
    if (prInfo) {
      fixesReady.push({
        path: entry.path,
        prNumber: prInfo.prNumber,
        status: prInfo.status,
      });
    }
  }

  // ── GitHub auto-report issues ──────────────────────────────────────
  let reports = { total: 0, fromInstallations: 0, newPatterns: 0 };

  if (repo && fetchFn) {
    try {
      const issues = fetchFn({
        action: 'search',
        repo,
        labels: 'auto-report',
        since: from.toISOString(),
      });

      const issueList = Array.isArray(issues) ? issues : [];
      reports.total = issueList.length;

      // Count issues from installations (have "installation" label or source)
      reports.fromInstallations = issueList.filter((iss) => {
        const labels = Array.isArray(iss.labels) ? iss.labels : [];
        const hasLabel = labels.some((l) =>
          (typeof l === 'string' ? l : (l && l.name) || '')
            .toLowerCase()
            .includes('installation'),
        );
        return hasLabel || (iss.source === 'installation');
      }).length;

      // New patterns: issues whose error code we haven't seen before in this window
      const seenCodes = new Set();
      for (const iss of issueList) {
        const code = iss.errorCode || iss.error_code || iss.code || null;
        if (code && !seenCodes.has(code)) {
          seenCodes.add(code);
        }
      }
      reports.newPatterns = seenCodes.size;
    } catch (_err) {
      // GitHub fetch failures are non-fatal for the summary
    }
  }

  // ── Recently fixed (from history in approved with _result) ─────────
  const recentlyFixed = [];
  for (const entry of approvedRaw) {
    const d = entry.directive;
    if (!d || typeof d !== 'object') continue;
    if (d._completedAt || d._result) {
      recentlyFixed.push({
        errorCode: extractErrorCode(d),
        fixedAt: d._completedAt || null,
        deltaPercent: d._result && typeof d._result.deltaPercent === 'number'
          ? d._result.deltaPercent
          : null,
      });
    }
  }

  // ── Assemble summary ───────────────────────────────────────────────
  const summary = {
    period: {
      hours,
      from: from.toISOString(),
      to: now.toISOString(),
    },
    reports,
    directives: {
      pending,
      fixesReady,
    },
    recentlyFixed,
    recommendation: '', // filled below
  };

  summary.recommendation = buildRecommendation(summary);

  return summary;
}

// ---------------------------------------------------------------------------
// formatInboxSummary
// ---------------------------------------------------------------------------

/**
 * Render a summary as a human-readable terminal string with icons and colors.
 *
 * @param {object} summary — object returned by buildInboxSummary
 * @returns {string}
 */
function formatInboxSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return '';
  }

  const lines = [];

  // Header
  lines.push('\x1b[1m\x1b[36m=== Inbox Summary ===\x1b[0m');

  // Period
  const period = summary.period || {};
  lines.push(`\x1b[90mPeriod: last ${period.hours || '?'}h (${(period.from || '?').slice(0, 16)} .. ${(period.to || '?').slice(0, 16)})\x1b[0m`);
  lines.push('');

  // Reports
  const rpt = summary.reports || {};
  lines.push('\x1b[1mReports:\x1b[0m');
  lines.push(`  \u{1F4E8} Total: ${rpt.total || 0}`);
  lines.push(`  \u{1F3E0} From installations: ${rpt.fromInstallations || 0}`);
  lines.push(`  \u{2728} New patterns: ${rpt.newPatterns || 0}`);
  lines.push('');

  // Pending directives
  const directives = summary.directives || {};
  const pending = directives.pending || [];
  lines.push(`\x1b[1mPending directives: ${pending.length}\x1b[0m`);
  for (const d of pending) {
    const pri = d.priority === 'high' || d.priority === 'critical'
      ? `\x1b[31m[${d.priority}]\x1b[0m`
      : `\x1b[33m[${d.priority}]\x1b[0m`;
    lines.push(`  \u{1F4CB} ${pri} ${d.errorCode || 'unknown'} \u{2192} ${d.action || 'n/a'}`);
    if (d.reason) {
      lines.push(`       ${d.reason}`);
    }
  }
  lines.push('');

  // Fixes ready
  const fixes = directives.fixesReady || [];
  lines.push(`\x1b[1mFixes ready: ${fixes.length}\x1b[0m`);
  for (const f of fixes) {
    lines.push(`  \x1b[32m\u{2705}\x1b[0m PR #${f.prNumber} (${f.status}) \u{2190} ${path.basename(f.path || '')}`);
  }
  lines.push('');

  // Recently fixed
  const recent = summary.recentlyFixed || [];
  if (recent.length > 0) {
    lines.push(`\x1b[1mRecently fixed: ${recent.length}\x1b[0m`);
    for (const r of recent) {
      const delta = r.deltaPercent != null ? ` (${r.deltaPercent > 0 ? '+' : ''}${r.deltaPercent}%)` : '';
      lines.push(`  \x1b[32m\u{2714}\x1b[0m ${r.errorCode || 'unknown'}${delta}`);
    }
    lines.push('');
  }

  // Recommendation
  if (summary.recommendation) {
    lines.push(`\x1b[1m\x1b[33mRecommendation:\x1b[0m ${summary.recommendation}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// parseInboxCommand
// ---------------------------------------------------------------------------

/**
 * Parse CLI argument array for inbox command flags.
 *
 * Recognised flags:
 *   --hours <n>     look-back window (default 12)
 *   --repo <slug>   GitHub repo (owner/repo)
 *   --base-dir <p>  base directives directory
 *
 * @param {string[]} argv
 * @returns {{ hours: number, repo: string|null, baseDir: string|null }}
 */
function parseInboxCommand(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const result = { hours: 12, repo: null, baseDir: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--hours' && i + 1 < args.length) {
      const n = Number(args[i + 1]);
      if (!Number.isNaN(n) && n > 0) {
        result.hours = n;
      }
      i += 1;
    } else if (arg === '--repo' && i + 1 < args.length) {
      result.repo = args[i + 1];
      i += 1;
    } else if (arg === '--base-dir' && i + 1 < args.length) {
      result.baseDir = args[i + 1];
      i += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildInboxSummary,
  formatInboxSummary,
  parseInboxCommand,
};
