'use strict';

/**
 * xoloop_session.cjs — persistent session state for subagent-driven loops.
 *
 * Heavily inspired by pi-autoresearch's `.md` + `.jsonl` + `.ideas.md`
 * pattern. Three files in `<cwd>/.xoloop/`:
 *
 *   session.md       — living document: objective, files in scope, what's
 *                      been tried, key wins, dead ends. Human-readable and
 *                      human-editable. A fresh subagent reads this to
 *                      resume a session after context reset.
 *   session.jsonl    — append-only log, one JSON line per iteration.
 *                      Each entry has round, mode, target, outcome, metric,
 *                      asi (agent-supplied information), proposal summary.
 *   ideas.md         — backlog of complex ideas that surfaced during a
 *                      session but weren't pursued. Subsequent runs can
 *                      harvest this.
 *
 * Design invariants:
 *   - All writes are atomic (temp + rename) so partial writes can't leave
 *     the ledger mid-state.
 *   - JSONL entries are single-line; `readLedger` is tolerant of blank
 *     lines and malformed entries (skipped, not fatal).
 *   - `computeConfidence` uses median-absolute-deviation (MAD) as a robust
 *     noise estimator — mirrors pi-autoresearch's confidence score.
 *   - All functions take an explicit `cwd` — no hidden process.cwd() use.
 */

const fs = require('node:fs');
const path = require('node:path');
const { AdapterError } = require('./errors.cjs');

// ─────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────

function sessionDir(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    throw new AdapterError(
      'SESSION_CWD_REQUIRED',
      'cwd',
      'session functions require an explicit cwd string',
      { fixHint: 'Pass options.cwd or process.cwd() from the caller.' },
    );
  }
  return path.join(cwd, '.xoloop');
}

function sessionDocPath(cwd) { return path.join(sessionDir(cwd), 'session.md'); }
function sessionLedgerPath(cwd) { return path.join(sessionDir(cwd), 'session.jsonl'); }
function ideasPath(cwd) { return path.join(sessionDir(cwd), 'ideas.md'); }

function ensureSessionDir(cwd) {
  const dir = sessionDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicWrite(filePath, content) {
  // Fuzz-surfaced defense: _atomicWrite used to be exported and accepted
  // non-string paths, which threw a bare TypeError from path.dirname.
  // Guard with an AdapterError so callers (and fuzz campaigns) see a
  // structured reason instead of a surprise crash. Also narrows the
  // implicit contract for internal callers.
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new AdapterError(
      'ATOMIC_WRITE_PATH_REQUIRED',
      'filePath',
      'atomicWrite requires a non-empty string path',
      { fixHint: 'Pass an absolute or repo-relative path as the first argument.' },
    );
  }
  // Same temp+rename pattern used by patch_engine_common.
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

// ─────────────────────────────────────────────────────────────────────
// Session lifecycle
// ─────────────────────────────────────────────────────────────────────

function hasActiveSession(cwd) {
  try { return fs.existsSync(sessionDocPath(cwd)); }
  catch (_err) { return false; }
}

/**
 * Initialize a session. If one already exists, returns it unchanged
 * (subagents resume instead of overwriting). To start fresh, callers
 * must explicitly delete `.xoloop/session.md` and `.xoloop/session.jsonl`.
 *
 * Audit P1 (round 1 on this module): previously this was a check-then-
 * write race — two concurrent initSession callers could both pass
 * hasActiveSession, then both write session.md. The later writer would
 * silently clobber the earlier one, potentially erasing state from a
 * concurrent subagent already mid-run.
 *
 * Close the race with `fs.openSync(path, 'wx')` — exclusive create.
 * The kernel refuses if the file exists, so exactly one caller wins;
 * everyone else sees EEXIST and resumes. Matches the same exclusive-
 * create pattern overnight_engine already uses for batch directories.
 */
function initSession(cwd, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AdapterError(
      'SESSION_INPUT_REQUIRED',
      'input',
      'initSession requires an input object',
      { fixHint: 'Pass { mode, objective, filesInScope, constraints } at minimum.' },
    );
  }
  const mode = typeof input.mode === 'string' && input.mode.length > 0 ? input.mode : 'polish';
  const objective = typeof input.objective === 'string' ? input.objective : '(not specified)';
  const filesInScope = Array.isArray(input.filesInScope) ? input.filesInScope.filter((p) => typeof p === 'string') : [];
  const constraints = typeof input.constraints === 'string' ? input.constraints : '';

  ensureSessionDir(cwd);

  const createdAt = new Date().toISOString();
  const doc = [
    `# XOLoop Session — ${mode}`,
    '',
    `**Created:** ${createdAt}`,
    `**Mode:** ${mode}`,
    '',
    '## Objective',
    objective,
    '',
    '## Files in Scope',
    filesInScope.length > 0 ? filesInScope.map((p) => `- \`${p}\``).join('\n') : '_(not specified)_',
    '',
    '## Constraints',
    constraints.length > 0 ? constraints : '_(none explicit)_',
    '',
    '## Key Wins',
    '_(promote kept proposals here)_',
    '',
    '## Dead Ends',
    '_(record discarded approaches so we don\'t re-try them)_',
    '',
    '## What\'s Been Tried',
    '',
  ].join('\n');

  // Exclusive create. If another caller already initialized this
  // session, EEXIST bubbles up → treat as resume.
  const docPath = sessionDocPath(cwd);
  let fd;
  try {
    fd = fs.openSync(docPath, 'wx');
  } catch (openErr) {
    if (openErr && openErr.code === 'EEXIST') {
      return { resumed: true, sessionDocPath: docPath };
    }
    throw openErr;
  }
  try {
    fs.writeSync(fd, doc);
  } finally {
    fs.closeSync(fd);
  }
  // Ledger: same exclusive-create idiom. If someone raced and already
  // created it, leave contents alone.
  const ledgerPath = sessionLedgerPath(cwd);
  try {
    const ledgerFd = fs.openSync(ledgerPath, 'wx');
    fs.closeSync(ledgerFd);
  } catch (ledgerErr) {
    if (!ledgerErr || ledgerErr.code !== 'EEXIST') throw ledgerErr;
  }

  return { resumed: false, sessionDocPath: docPath, createdAt };
}

/**
 * Append one iteration's outcome to `session.jsonl`.
 *
 * Entry shape (free-form but these fields are conventional):
 *   {
 *     round: number,
 *     mode: 'polish'|'audit'|'improve'|...,
 *     timestamp: ISO string,
 *     target: string,
 *     outcome: 'keep'|'discard'|'rollback'|'crash'|'proposal-only',
 *     metric: { name, value, unit, direction }? ,
 *     asi: { ... } — agent-supplied information,
 *     proposalSummary: string,
 *     operationCount: number,
 *     filesTouched: string[],
 *     error: string?,
 *     errorCode: string?,
 *   }
 */
function appendLedgerEntry(cwd, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new AdapterError(
      'SESSION_LEDGER_ENTRY_INVALID',
      'entry',
      'appendLedgerEntry requires an entry object',
      { fixHint: 'Pass { round, mode, outcome, ... } at minimum.' },
    );
  }
  ensureSessionDir(cwd);
  const enriched = {
    timestamp: entry.timestamp || new Date().toISOString(),
    ...entry,
  };
  // Fuzz-surfaced defense: JSON.stringify throws on circular references
  // (a subagent could accidentally pass an object with a self-reference
  // in its asi payload). Use a WeakSet-based replacer so circular keys
  // get flagged as '[Circular]' strings instead of crashing the run.
  const seen = new WeakSet();
  let line;
  try {
    line = JSON.stringify(enriched, (key, value) => {
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }) + '\n';
  } catch (stringifyErr) {
    throw new AdapterError(
      'SESSION_LEDGER_ENTRY_UNSERIALIZABLE',
      'entry',
      `ledger entry could not be serialized: ${stringifyErr.message}`,
      { fixHint: 'Avoid Symbols, BigInts, and exotic types in ledger entries; they must JSON-stringify cleanly.' },
    );
  }
  // Append is inherently non-atomic across processes on some filesystems,
  // but fs.appendFileSync uses O_APPEND which is atomic on POSIX for
  // writes under PIPE_BUF. JSONL lines are typically well under that.
  // For very concurrent callers, wrap in an exclusive lock.
  fs.appendFileSync(sessionLedgerPath(cwd), line);
  return enriched;
}

/**
 * Read the full ledger. Returns an array of entries.
 *
 * Audit P2 (round 1 on this module): previously malformed lines were
 * silently skipped — ENOSPC, short writes, or crashes during append
 * produced torn JSON that readers couldn't see. Callers had no way
 * to know data was lost.
 *
 * Fix: still skip the malformed lines (we can't parse them), but
 * ALSO expose the count via `readLedgerWithStats`. `readLedger`
 * stays compatible with the old array-returning contract; new code
 * that cares about torn entries uses `readLedgerWithStats`.
 */
function readLedger(cwd) {
  return readLedgerWithStats(cwd).entries;
}

function readLedgerWithStats(cwd) {
  const p = sessionLedgerPath(cwd);
  if (!fs.existsSync(p)) return { entries: [], malformedCount: 0, totalLines: 0 };
  const raw = fs.readFileSync(p, 'utf8');
  const entries = [];
  let malformedCount = 0;
  let totalLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines += 1;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_parseErr) {
      malformedCount += 1;
    }
  }
  return { entries, malformedCount, totalLines };
}

/**
 * Read the living session document. Returns the full markdown string, or
 * null if no active session.
 */
function readSessionDoc(cwd) {
  const p = sessionDocPath(cwd);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/**
 * Append a bullet under the "What's Been Tried" section.
 *
 * Audit P1 (round 1 on this module): previously this did a read-
 * modify-write over session.md — two concurrent appendToTried
 * callers would each read the same base, each compute a new doc
 * with their own bullet, and the later writer would silently drop
 * the earlier bullet. initSession's restructure places "What's Been
 * Tried" as the LAST section, so appending works via fs.appendFileSync
 * with O_APPEND (POSIX-atomic for writes under PIPE_BUF; our bullets
 * are far below that bound).
 *
 * Audit P3 (round 1 on this module): bullet text is now sanitized
 * before writing — newlines collapsed to spaces, leading Markdown
 * heading markers stripped. A caller passing "multi\nline\n# injected
 * heading" would have broken the document structure; now it gets
 * reduced to a single-line bullet.
 */
function appendToTried(cwd, bullet) {
  if (!bullet || typeof bullet !== 'string') {
    throw new AdapterError(
      'SESSION_BULLET_REQUIRED',
      'bullet',
      'appendToTried requires a non-empty string bullet',
      { fixHint: 'Pass a short description of what was tried this round.' },
    );
  }
  const sanitized = sanitizeBullet(bullet);
  if (!sanitized) {
    throw new AdapterError(
      'SESSION_BULLET_REQUIRED',
      'bullet',
      'appendToTried bullet was empty after sanitization',
      { fixHint: 'Provide a bullet with at least one printable character other than markdown heading markers.' },
    );
  }
  const p = sessionDocPath(cwd);
  if (!fs.existsSync(p)) {
    // No session yet — create a minimal doc with the heading so
    // subsequent appends have something to attach to. Exclusive-
    // create preserves initSession's race guarantee.
    try {
      const fd = fs.openSync(p, 'wx');
      try {
        fs.writeSync(fd, `# XOLoop Session\n\n## What's Been Tried\n`);
      } finally {
        fs.closeSync(fd);
      }
    } catch (openErr) {
      if (!openErr || openErr.code !== 'EEXIST') throw openErr;
    }
  }
  // O_APPEND is atomic for writes <= PIPE_BUF on POSIX (4096 bytes on
  // macOS/Linux). Two concurrent appendToTried callers interleave
  // cleanly — both bullets land, no data lost.
  fs.appendFileSync(p, `- ${sanitized}\n`);
}

/**
 * Sanitize user/agent-supplied bullet text so it can't inject new
 * headings or list boundaries into the session document. Exported so
 * callers can pre-validate before writing.
 */
function sanitizeBullet(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    // Collapse all whitespace (newlines, tabs) to single spaces
    .replace(/\s+/g, ' ')
    // Then trim so leading/trailing spaces don't hide heading markers
    .trim()
    // Strip leading Markdown heading markers and list bullets so
    // nothing re-opens a new section downstream
    .replace(/^(?:[#\->*+]+\s*)+/, '')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────
// Ideas backlog
// ─────────────────────────────────────────────────────────────────────

function appendIdea(cwd, idea) {
  if (!idea || typeof idea !== 'string') {
    throw new AdapterError(
      'IDEA_REQUIRED',
      'idea',
      'appendIdea requires a non-empty string',
      { fixHint: 'Pass a one-line description of the idea.' },
    );
  }
  ensureSessionDir(cwd);
  const p = ideasPath(cwd);
  const header = fs.existsSync(p) ? '' : '# XOLoop Ideas Backlog\n\nIdeas surfaced during sessions but not yet tried.\n\n';
  fs.appendFileSync(p, `${header}- ${idea.trim()}\n`);
}

function listIdeas(cwd) {
  const p = ideasPath(cwd);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  return raw.split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// Confidence score — MAD-based noise floor
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute Median Absolute Deviation of an array of numbers. Returns 0
 * when fewer than 2 non-numeric values are present. MAD is a robust
 * noise estimator (resistant to outliers) — median(|x - median(x)|).
 */
function computeMAD(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
    .filter((v) => v !== null);
  if (nums.length < 2) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  const deviations = nums.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const madValue = deviations.length % 2 === 0
    ? (deviations[deviations.length / 2 - 1] + deviations[deviations.length / 2]) / 2
    : deviations[Math.floor(deviations.length / 2)];
  return madValue;
}

/**
 * Compute confidence score for a sequence of metric observations.
 *
 * Returns { confidence, color, bestImprovement, mad, sampleSize, direction }.
 *
 * confidence = |best_improvement| / MAD. A score of 2.0 means the best
 * improvement is twice the session's noise floor.
 *
 * color:
 *   'green'  — confidence >= 2.0 (likely real)
 *   'yellow' — 1.0 <= confidence < 2.0 (above noise but marginal)
 *   'red'    — confidence < 1.0 (within noise)
 *
 * Returns confidence=null with reason='insufficient-samples' when
 * fewer than 3 values are present (pi-autoresearch's minimum).
 */
function computeConfidence(values, options = {}) {
  const direction = options.direction === 'higher' ? 'higher' : 'lower';
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
    .filter((v) => v !== null);
  if (nums.length < 3) {
    return {
      confidence: null,
      color: 'gray',
      bestImprovement: null,
      mad: 0,
      sampleSize: nums.length,
      direction,
      reason: 'insufficient-samples',
    };
  }
  const baseline = nums[0];
  const best = direction === 'lower'
    ? Math.min(...nums)
    : Math.max(...nums);
  const bestImprovement = direction === 'lower'
    ? (baseline - best)
    : (best - baseline);
  const mad = computeMAD(nums);
  if (mad === 0) {
    return {
      confidence: bestImprovement !== 0 ? Infinity : 0,
      color: bestImprovement !== 0 ? 'green' : 'gray',
      bestImprovement,
      mad: 0,
      sampleSize: nums.length,
      direction,
      reason: bestImprovement !== 0 ? 'zero-noise-floor' : 'no-change',
    };
  }
  const confidence = Math.abs(bestImprovement) / mad;
  let color = 'red';
  if (confidence >= 2.0) color = 'green';
  else if (confidence >= 1.0) color = 'yellow';
  return {
    confidence,
    color,
    bestImprovement,
    mad,
    sampleSize: nums.length,
    direction,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────

module.exports = {
  // Paths
  sessionDir,
  sessionDocPath,
  sessionLedgerPath,
  ideasPath,

  // Lifecycle
  hasActiveSession,
  initSession,

  // Ledger
  appendLedgerEntry,
  readLedger,
  readLedgerWithStats,

  // Doc
  readSessionDoc,
  appendToTried,

  // Ideas backlog
  appendIdea,
  listIdeas,

  // Confidence
  computeMAD,
  computeConfidence,
};
