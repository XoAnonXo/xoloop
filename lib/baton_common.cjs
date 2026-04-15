const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  // Objects without a proper toString (e.g. Object.create(null)) would throw — return ''
  try { return String(value).trim(); } catch (_) { return ''; }
}

function safeJsonStringify(value, indent) {
  try {
    return indent !== undefined ? JSON.stringify(value, null, indent) : JSON.stringify(value);
  } catch {
    // Fallback for circular structures: use stableStringify which handles cycles.
    return stableStringify(value);
  }
}

function ensureDir(dirPath) {
  if (typeof dirPath !== 'string') {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('INVALID_PATH', 'dirPath', 'dirPath must be a string', { fixHint: 'Pass a string path to ensureDir.' });
  }
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function writeJsonAtomic(filePath, payload) {
  if (typeof filePath !== 'string') {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('INVALID_PATH', 'filePath', 'filePath must be a string', { fixHint: 'Pass a string path to writeJsonAtomic.' });
  }
  const targetPath = path.resolve(filePath);
  ensureDir(path.dirname(targetPath));
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${safeJsonStringify(payload, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, targetPath);
  return targetPath;
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

function appendNdjson(filePath, payload) {
  if (typeof filePath !== 'string') {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('INVALID_PATH', 'filePath', 'filePath must be a string', { fixHint: 'Pass a string path to appendNdjson.' });
  }
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${safeJsonStringify(payload)}\n`, 'utf8');
  return filePath;
}

function buildBatchId(prefix = 'baton') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}`;
}

function formatLaneId(index) {
  return `lane-${String(Number(index) || 0).padStart(2, '0')}`;
}

function buildAttemptId(index) {
  return `attempt-${String(Number(index) || 0).padStart(4, '0')}`;
}

function slugifyText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
}

function stableStringify(value, _seen) {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    const seen = (_seen instanceof Set) ? _seen : new Set();
    if (seen.has(value)) {
      return '"[Circular]"';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableStringify(entry, seen)).join(',')}]`;
    }
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function createFingerprint(value) {
  const serialized = stableStringify(value);
  return crypto.createHash('sha1').update(typeof serialized === 'string' ? serialized : 'null').digest('hex');
}

function defaultWorktreeRoot(repoRoot, batchId) {
  if (typeof repoRoot !== 'string') {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('INVALID_PATH', 'repoRoot', 'repoRoot must be a string', { fixHint: 'Pass a string repoRoot to defaultWorktreeRoot.' });
  }
  const repoName = path.basename(path.resolve(repoRoot));
  return path.resolve(repoRoot, '..', `${repoName}-baton-worktrees`, String(batchId ?? ''));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function formatDuration(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric)) {
    return 'n/a';
  }
  if (numeric < 1000) {
    return `${numeric.toFixed(1)} ms`;
  }
  return `${(numeric / 1000).toFixed(2)} s`;
}

function buildWorkerId(prefix = 'worker') {
  const entropy = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${process.pid}-${entropy}`;
}

function resolveRepoPath(repoRoot, relativePath) {
  if (typeof repoRoot !== 'string' || typeof relativePath !== 'string') {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('INVALID_PATH', 'repoRoot', 'repoRoot and relativePath must be strings', { fixHint: 'Pass string arguments to resolveRepoPath.' });
  }
  const absolutePath = path.resolve(repoRoot, relativePath);
  const normalizedRelative = path.relative(repoRoot, absolutePath);
  if (!normalizedRelative || normalizedRelative.startsWith('..') || path.isAbsolute(normalizedRelative)) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError(
      'REPO_PATH_ESCAPE',
      'relativePath',
      `Path escapes repo root: ${relativePath}`,
      { fixHint: 'Pass a relative path that stays inside the repo root; absolute paths and `..` segments that leave the root are rejected.' },
    );
  }
  return {
    absolutePath,
    relativePath: normalizedRelative.split(path.sep).join('/'),
  };
}

/**
 * Canonicalize an arbitrary input path (absolute or relative) into its
 * realpath form by walking up to the deepest existing ancestor and then
 * re-appending the missing tail lexically. This lets us canonicalize targets
 * that do not yet exist (create_file ops) while still resolving every
 * symlink on every existing segment.
 *
 * Mirrors the `canonicalizeAbsolute` helper in audit_runner.cjs.
 */
function canonicalizeAbsolutePath(repoRoot, inputPath) {
  if (typeof inputPath !== 'string') {
    return null;
  }
  const slashNormalized = inputPath.replace(/\\/g, '/');
  const absolute = path.isAbsolute(slashNormalized)
    ? path.normalize(slashNormalized)
    : path.resolve(repoRoot, slashNormalized);
  try {
    return fs.realpathSync(absolute);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return absolute;
    }
  }
  let current = absolute;
  const segments = [];
  // Walk up until we find an existing ancestor we can realpath.
  // Eslint-disable: controlled loop with a terminating `parent === current` exit.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return absolute;
    }
    segments.unshift(path.basename(current));
    current = parent;
    try {
      const realParent = fs.realpathSync(current);
      return path.join(realParent, ...segments);
    } catch (err2) {
      if (!err2 || err2.code !== 'ENOENT') {
        return absolute;
      }
    }
  }
}

function _isInsideCanonicalRoot(candidateAbsolute, canonicalRoot) {
  if (typeof canonicalRoot !== 'string' || canonicalRoot.length === 0) {
    return false;
  }
  const rel = path.relative(canonicalRoot, candidateAbsolute);
  if (rel === '') {
    return true;
  }
  if (rel.startsWith('..')) {
    return false;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

/**
 * Shared helper for patch-engine Group A (path scope).
 *
 * Canonicalizes `repoRoot` and `rawPath`, verifies the resulting canonical
 * target is still inside the canonical repo root (defeats symlink-based
 * escape), and — when `allowedCanonicalSet` is a non-empty Set — verifies
 * the canonical target is a member. Back-compat: when `allowedCanonicalSet`
 * is null/undefined/empty, containment-only check is performed (legacy
 * behavior before the allowlist parameter was introduced).
 *
 * Returns { canonicalAbsolute, canonicalRepoRelative }. Throws AdapterError
 * with structured code/field/fixHint otherwise.
 */
function resolveAndValidateTargetPath(repoRoot, rawPath, allowedCanonicalSet, options = {}) {
  const { AdapterError } = require('./errors.cjs');
  const codeOutOfScope = (options && options.codeOutOfScope) || 'PATCH_PATH_OUT_OF_SCOPE';
  const codeEscape = (options && options.codeEscape) || 'PATCH_PATH_ESCAPES_REPO';
  const codeRequired = (options && options.codeRequired) || 'PATCH_PATH_REQUIRED';
  const fieldName = (options && options.fieldName) || 'path';
  // Engine-specific escape message prefix — preserved so error text stays
  // legible in each engine's domain (existing test suites match on it).
  let escapeMsgPrefix = 'Path escapes the repo';
  if (codeEscape === 'PATCH_PATH_ESCAPES_REPO') escapeMsgPrefix = 'Patch path escapes the repo';
  else if (codeEscape === 'CHANGE_SET_PATH_ESCAPES_REPO') escapeMsgPrefix = 'Change-set path escapes the repo';
  else if (codeEscape === 'OPERATION_PATH_ESCAPES_REPO') escapeMsgPrefix = 'Operation path escapes the repo';

  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new AdapterError(
      'INVALID_PATH',
      'repoRoot',
      'repoRoot must be a non-empty string',
      { fixHint: 'Pass a non-empty repo root path to resolveAndValidateTargetPath.' }
    );
  }
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new AdapterError(
      codeRequired,
      fieldName,
      'Target path is missing or empty',
      { fixHint: 'Pass a non-empty repo-relative (or absolute) path to the engine.' }
    );
  }

  // Canonicalize both the repo root and the target. The audit_runner pattern
  // is authoritative here; we duplicate it so the engines don't have a
  // cross-module dependency on audit_runner.
  const canonicalRoot = canonicalizeAbsolutePath(process.cwd(), repoRoot);
  const canonicalAbsolute = canonicalizeAbsolutePath(canonicalRoot || repoRoot, rawPath);

  // Fall back to lexical containment when realpath cannot give us a canonical
  // root (e.g., a synthetic `/tmp/repo` that does not exist on disk). The
  // engines are allowed to operate in pure-test mode where the cwd is a
  // mkdtemp directory that DOES exist — that path realpaths normally. A
  // missing cwd is a degenerate case we preserve for back-compat.
  if (canonicalRoot === null || canonicalAbsolute === null) {
    // Pure lexical fallback (old behavior).
    const absolutePath = path.resolve(repoRoot, rawPath);
    const relativePath = path.relative(repoRoot, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new AdapterError(
        codeEscape,
        fieldName,
        `${escapeMsgPrefix}: ${rawPath}`,
        { fixHint: 'Use a repo-relative path that stays inside the configured cwd; absolute paths and parent traversals (..) are rejected.' }
      );
    }
    return {
      canonicalAbsolute: absolutePath,
      canonicalRepoRelative: relativePath.split(path.sep).join('/'),
    };
  }

  if (!_isInsideCanonicalRoot(canonicalAbsolute, canonicalRoot)) {
    throw new AdapterError(
      codeEscape,
      fieldName,
      `${escapeMsgPrefix} (canonical target outside repo root): ${rawPath}`,
      { fixHint: 'Use a repo-relative path that stays inside the configured cwd; symlinks whose target leaves the repo are rejected.' }
    );
  }

  if (allowedCanonicalSet instanceof Set && allowedCanonicalSet.size > 0) {
    if (!allowedCanonicalSet.has(canonicalAbsolute)) {
      throw new AdapterError(
        codeOutOfScope,
        fieldName,
        `Path is not in the caller-supplied allowlist: ${rawPath}`,
        { fixHint: 'Add the target path to the allowedPaths array passed to the engine, or remove the operation touching it.' }
      );
    }
  }

  const canonicalRepoRelative = path
    .relative(canonicalRoot, canonicalAbsolute)
    .split(path.sep)
    .join('/');

  return { canonicalAbsolute, canonicalRepoRelative };
}

/**
 * Build a Set of canonical absolute paths from a caller-supplied allowlist.
 * The engines use this when the caller passes `allowedPaths` so that every
 * operation's canonical target is validated against a consistent set.
 */
function buildAllowedCanonicalSet(repoRoot, allowedPaths) {
  if (!Array.isArray(allowedPaths)) {
    return null;
  }
  const canonicalRoot = canonicalizeAbsolutePath(process.cwd(), repoRoot);
  const set = new Set();
  for (const entry of allowedPaths) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const canonical = canonicalizeAbsolutePath(canonicalRoot || repoRoot, entry);
    if (!canonical) continue;
    if (canonicalRoot && !_isInsideCanonicalRoot(canonical, canonicalRoot)) continue;
    set.add(canonical);
  }
  return set;
}

function readTextIfExists(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function tryParseJsonCandidate(text) {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    return null;
  }
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

function extractJsonObjectFromText(text, errorLabel = 'Response') {
  const { AdapterError } = require('./errors.cjs');
  const trimmed = normalizeText(text);
  if (!trimmed) {
    throw new AdapterError(
      'RESPONSE_EMPTY',
      'text',
      `${errorLabel} was empty`,
      { fixHint: 'Ensure the model returns a non-empty response before calling extractJsonObjectFromText.' }
    );
  }
  const jsonFenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFenceMatch) {
    const candidate = tryParseJsonCandidate(jsonFenceMatch[1]);
    if (candidate) {
      return candidate;
    }
  }
  const directCandidate = tryParseJsonCandidate(trimmed);
  if (directCandidate) {
    return directCandidate;
  }
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== '{') {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        depth += 1;
        continue;
      }
      if (char !== '}') {
        continue;
      }
      depth -= 1;
      if (depth !== 0) {
        continue;
      }
      const candidate = tryParseJsonCandidate(trimmed.slice(start, index + 1));
      if (candidate) {
        return candidate;
      }
      break;
    }
  }
  throw new AdapterError(
    'RESPONSE_INVALID_JSON',
    'text',
    `${errorLabel} did not contain valid JSON`,
    { fixHint: 'Return a valid JSON object (optionally inside a ```json fence) from the model response.' }
  );
}

function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      return true;
    }
    return false;
  }
}

module.exports = {
  appendNdjson,
  buildAllowedCanonicalSet,
  buildAttemptId,
  buildBatchId,
  buildWorkerId,
  canonicalizeAbsolutePath,
  createFingerprint,
  defaultWorktreeRoot,
  ensureDir,
  formatDuration,
  formatLaneId,
  extractJsonObjectFromText,
  isProcessAlive,
  normalizeText,
  nowIso,
  readJsonIfExists,
  readTextIfExists,
  resolveAndValidateTargetPath,
  resolveRepoPath,
  sleep,
  slugifyText,
  stableStringify,
  writeJsonAtomic,
};
