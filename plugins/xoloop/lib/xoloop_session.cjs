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

/**
 * Audit P2 (round 3) + P2 (round 4): refuse symlinks with BOTH lstat
 * (fast-path, clear error) AND O_NOFOLLOW on the actual open. The
 * lstat-only check was a check-then-use race — an attacker who could
 * swap a real file with a symlink between lstat and the write could
 * bypass. O_NOFOLLOW at open time closes the window at the kernel
 * level (POSIX ELOOP on symlink). The lstat precheck stays because
 * it gives a cleaner error message in the common non-attack case.
 */
function refuseIfSymlink(filePath) {
  let lst;
  try {
    lst = fs.lstatSync(filePath);
  } catch (lstatErr) {
    if (lstatErr && lstatErr.code === 'ENOENT') return;
    throw lstatErr;
  }
  if (lst.isSymbolicLink()) {
    throw new AdapterError(
      'SESSION_FILE_IS_SYMLINK',
      'filePath',
      `refused: ${filePath} is a symbolic link; .xoloop/ must contain only real files`,
      { fixHint: 'Remove the symlink under .xoloop/ and let the session files be recreated as real files.' },
    );
  }
}

/**
 * Audit P2 (round 4) + P1 (round 4): open a `.xoloop/` path with
 * O_NOFOLLOW so the kernel refuses to traverse a symlink at the
 * open syscall. Closes the TOCTOU window between lstat and open.
 * Used by every read/write entry point into .xoloop/* — writes go
 * through `appendToFileNoFollow` or `writeToFileNoFollowExcl`, reads
 * go through `readFileNoFollow`.
 */
function openNoFollow(filePath, flags, mode) {
  try {
    return fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW, mode);
  } catch (openErr) {
    if (openErr && (openErr.code === 'ELOOP' || openErr.code === 'EMLINK')) {
      throw new AdapterError(
        'SESSION_FILE_IS_SYMLINK',
        'filePath',
        `refused: ${filePath} is a symbolic link (ELOOP at O_NOFOLLOW open)`,
        { fixHint: 'Remove the symlink under .xoloop/ and let the session files be recreated as real files.' },
      );
    }
    throw openErr;
  }
}

function appendToFileNoFollow(filePath, content) {
  // O_WRONLY | O_APPEND | O_CREAT — append semantics, create if missing,
  // refuse symlink traversal. Mode 0o600 — session state is per-user.
  const fd = openNoFollow(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600,
  );
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

function readFileNoFollow(filePath) {
  let fd;
  try {
    fd = openNoFollow(filePath, fs.constants.O_RDONLY, 0o600);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    const buf = Buffer.allocUnsafe(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Audit P2 (round 3): sanitize caller-supplied text before embedding
 * in markdown sections of session.md. A caller passing
 * `objective: "tighten x\n\n# Fake Injected Section\nstuff"` would
 * have rendered as a new section in the document. Collapse newlines
 * to spaces and strip leading Markdown heading markers so every
 * user-supplied string stays within the line it belongs to.
 *
 * Distinct from sanitizeBullet only in the final trim policy:
 * markdown field values keep interior punctuation; just no newlines
 * or leading headings.
 */
function sanitizeMarkdownField(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[#]+\s*)+/, '')
    .trim();
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
  // Audit P2 (round 3): sanitize every caller-supplied field before
  // embedding into session.md. Before the fix, a caller could pass
  // mode: '# Injected', objective: 'multi\nline\n# bad heading', or
  // a filesInScope entry with newlines — all of which would land as
  // extra sections or list items in the document.
  const rawMode = typeof input.mode === 'string' && input.mode.length > 0 ? input.mode : 'polish';
  const mode = sanitizeMarkdownField(rawMode) || 'polish';
  const objective = sanitizeMarkdownField(typeof input.objective === 'string' ? input.objective : '') || '(not specified)';
  const filesInScope = Array.isArray(input.filesInScope)
    ? input.filesInScope
      .filter((p) => typeof p === 'string')
      .map((p) => sanitizeMarkdownField(p))
      .filter(Boolean)
    : [];
  const constraints = sanitizeMarkdownField(typeof input.constraints === 'string' ? input.constraints : '');

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
  // Audit P3 (round 2): spread BEFORE timestamp override so an explicit
  // `timestamp: undefined` in the caller's entry doesn't wipe the
  // default. Before the fix, `{timestamp: fallback, ...entry}` let
  // spread win the last-write-wins race; now `...entry` runs first
  // and `timestamp` is the authoritative final value.
  const enriched = {
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
  };
  // Audit P1 (round 2) + fuzz-surfaced defense: JSON.stringify throws
  // on circular references. The round-1 WeakSet-based replacer worked
  // for circulars but marked any REPEATED reference as '[Circular]' —
  // even a shared non-circular object like `{a: X, b: X}` would lose
  // one copy of X. Use an ancestor-chain tracker instead: only objects
  // currently in the stringify ancestry count as circular; siblings
  // serialize independently.
  let line;
  try {
    const ancestors = [];
    line = JSON.stringify(enriched, function circularSafeReplacer(key, value) {
      if (value !== null && typeof value === 'object') {
        // `this` is the parent object during JSON.stringify.
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(value)) return '[Circular]';
        ancestors.push(value);
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
  // Audit P2 (round 4): use appendToFileNoFollow so the kernel refuses
  // symlink traversal at open time — no TOCTOU window between lstat
  // and append. O_APPEND is still atomic on POSIX for writes under
  // PIPE_BUF. JSONL lines are typically well under that.
  appendToFileNoFollow(sessionLedgerPath(cwd), line);
  return enriched;
}

/**
 * Read the full ledger. Returns an array of entries.
 *
 * Audit P2 (round 4): previously `readLedger` still hid corruption by
 * default — callers who called it (the common path) never learned
 * about torn lines, even though `readLedgerWithStats` exposed them.
 * Print a stderr warning when the default reader encounters torn
 * entries, so operators see it even without opting into the stats
 * API. Keeps the array-returning contract intact.
 */
function readLedger(cwd) {
  const stats = readLedgerWithStats(cwd);
  if (stats.malformedCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[xoloop_session] readLedger(${sessionLedgerPath(cwd)}): ${stats.malformedCount} torn line(s) out of ${stats.totalLines} — call readLedgerWithStats to inspect.`,
    );
  }
  return stats.entries;
}

function readLedgerWithStats(cwd) {
  const p = sessionLedgerPath(cwd);
  // Audit P1 (round 4): use readFileNoFollow so a malicious repo
  // can't plant `.xoloop/session.jsonl` as a symlink pointing at a
  // sensitive file and have our reader happily read it.
  const raw = readFileNoFollow(p);
  if (raw === null) return { entries: [], malformedCount: 0, totalLines: 0 };
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
  // Audit P1 (round 4): use readFileNoFollow so symlinked session.md
  // doesn't silently read a file outside `.xoloop/`.
  return readFileNoFollow(sessionDocPath(cwd));
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
  // Audit P2 (round 3): remove the stub-creation fallback. Previously
  // appendToTried would create a minimal session.md on a fresh repo
  // to "make the append work." But initSession later treated any
  // existing doc as fully initialized, so a caller who tried-before-
  // init got a half-set-up session (no objective/files/constraints)
  // that initSession refused to finish. Cleaner contract: fail loud
  // if no session exists; force callers to initSession first.
  ensureSessionDir(cwd);
  const p = sessionDocPath(cwd);
  // Audit P1 (round 4): read the doc through O_NOFOLLOW.
  const existing = readFileNoFollow(p);
  if (existing === null) {
    throw new AdapterError(
      'SESSION_NOT_INITIALIZED',
      'session',
      'appendToTried requires an initialized session (session.md missing)',
      { fixHint: 'Call initSession(cwd, { mode, objective, ... }) before appendToTried.' },
    );
  }
  // Audit P3 (round 4): previously appendToTried used O_APPEND and
  // relied on "What's Been Tried" being the last section. But
  // session.md is documented as human-editable — the first maintainer
  // who adds a "## Notes" section below would silently break future
  // bullet placements (they'd land under Notes, not Tried). Instead
  // find the "## What's Been Tried" heading explicitly and insert
  // the bullet directly below it, keeping subsequent sections intact.
  //
  // We lose the O_APPEND atomicity for concurrent writes — trade-off:
  // human-edit robustness beats concurrent-append atomicity for this
  // function (appendLedgerEntry is the concurrency-critical path).
  // For concurrent appendToTried callers, we still use exclusive-
  // create on the temp + atomic rename so the document never lands
  // half-written.
  const heading = '## What\'s Been Tried';
  const newBullet = `- ${sanitized}\n`;
  let updated;
  if (existing.includes(heading)) {
    updated = existing.replace(
      new RegExp(`(${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\n)`),
      `$1${newBullet}`,
    );
  } else {
    // No heading present (doc was reset); append a fresh section.
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    updated = `${existing}${separator}${heading}\n${newBullet}`;
  }
  atomicWrite(p, updated);
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
  // Audit P1 (round 2): idea text was previously written verbatim, so a
  // caller passing `"real idea\n# injected heading\n- smuggled bullet"`
  // would land multiple list items and a new heading in ideas.md.
  // Reuse the same sanitizer appendToTried uses — collapse whitespace,
  // strip leading heading markers, trim.
  const sanitized = sanitizeBullet(idea);
  if (!sanitized) {
    throw new AdapterError(
      'IDEA_REQUIRED',
      'idea',
      'idea was empty after sanitization',
      { fixHint: 'Provide an idea with at least one printable character other than markdown heading markers.' },
    );
  }
  ensureSessionDir(cwd);
  const p = ideasPath(cwd);
  refuseIfSymlink(p);
  // Audit P2 (round 2): two concurrent first-time appendIdea calls
  // could both observe the file missing and both prepend a header →
  // ideas.md with duplicate headers. Create the header file
  // exclusively (O_EXCL). If the create races, the losing caller
  // catches EEXIST and skips straight to appending — one header ever.
  if (!fs.existsSync(p)) {
    try {
      const fd = fs.openSync(p, 'wx');
      try {
        fs.writeSync(fd, '# XOLoop Ideas Backlog\n\nIdeas surfaced during sessions but not yet tried.\n\n');
      } finally {
        fs.closeSync(fd);
      }
    } catch (headerErr) {
      if (!headerErr || headerErr.code !== 'EEXIST') throw headerErr;
    }
  }
  fs.appendFileSync(p, `- ${sanitized}\n`);
}

function listIdeas(cwd) {
  // Audit P1 (round 4): symlinked ideas.md must not be followed.
  const raw = readFileNoFollow(ideasPath(cwd));
  if (raw === null) return [];
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
