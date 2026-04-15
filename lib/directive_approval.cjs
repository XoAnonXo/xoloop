'use strict';

/**
 * directive_approval.cjs — Manage lifecycle of directive YAML files through
 * pending → approved → history (or pending → skipped) directories.
 *
 * Directory layout under baseDir:
 *   pending/   — directives awaiting review
 *   approved/  — approved and queued for execution
 *   skipped/   — directives that were rejected/deferred
 *   history/   — completed directives with result metadata
 *
 * Exports:
 *   listPendingDirectives(baseDir)
 *   approveDirective(directivePath, baseDir)
 *   skipDirective(directivePath, baseDir)
 *   listApprovedDirectives(baseDir)
 *   completeDirective(directivePath, result, baseDir)
 *
 * Error codes (all AdapterError):
 *   DIRECTIVE_BASE_DIR_REQUIRED  — baseDir is not a non-empty string
 *   DIRECTIVE_NOT_FOUND          — file doesn't exist at the expected path
 *   DIRECTIVE_ALREADY_APPROVED   — file already exists in approved/
 *   DIRECTIVE_MOVE_FAILED        — fs error during rename/copy
 */

const fs = require('node:fs');
const path = require('node:path');

const YAML = require('yaml');

const { AdapterError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_DIR = path.join('.xoanon', 'directives');

const SUBDIR_PENDING = 'pending';
const SUBDIR_APPROVED = 'approved';
const SUBDIR_SKIPPED = 'skipped';
const SUBDIR_HISTORY = 'history';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and validate baseDir. Returns the absolute path.
 * @param {string|undefined} baseDir
 * @returns {string}
 */
function resolveBaseDir(baseDir) {
  const resolved = baseDir && typeof baseDir === 'string' && baseDir.trim().length > 0
    ? path.resolve(baseDir)
    : path.resolve(DEFAULT_BASE_DIR);
  return resolved;
}

/**
 * Ensure a directory exists, creating it (and all parents) if needed.
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Read all *.yaml files from a directory and return parsed objects.
 * Returns [] if the directory doesn't exist.
 * @param {string} dirPath
 * @returns {Array<{ path: string, directive: object }>}
 */
function readYamlsFromDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];

  const entries = fs.readdirSync(dirPath).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const results = [];

  for (const entry of entries) {
    const filePath = path.join(dirPath, entry);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const directive = YAML.parse(text);
      results.push({ path: filePath, directive: directive || {} });
    } catch (_err) {
      // Skip unreadable / unparseable files silently — caller can decide
      results.push({ path: filePath, directive: null });
    }
  }

  return results;
}

/**
 * Move a file from src to destDir, preserving the filename.
 * Ensures destDir exists.
 * @param {string} src - absolute source path
 * @param {string} destDir - absolute destination directory
 * @returns {string} - absolute destination path
 * @throws {AdapterError} DIRECTIVE_MOVE_FAILED on fs error
 */
function moveFile(src, destDir) {
  ensureDir(destDir);
  const dest = path.join(destDir, path.basename(src));
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // Cross-device move: copy + unlink fallback
    if (err && err.code === 'EXDEV') {
      try {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      } catch (copyErr) {
        throw new AdapterError(
          'DIRECTIVE_MOVE_FAILED',
          'directivePath',
          `failed to move directive (cross-device copy): ${copyErr && copyErr.message ? copyErr.message : String(copyErr)}`,
          { fixHint: 'Ensure both source and destination are accessible and writable.', cause: copyErr },
        );
      }
    } else {
      throw new AdapterError(
        'DIRECTIVE_MOVE_FAILED',
        'directivePath',
        `failed to move directive: ${err && err.message ? err.message : String(err)}`,
        { fixHint: 'Ensure the source file exists and the destination directory is writable.', cause: err },
      );
    }
  }
  return dest;
}

/**
 * Assert that a file exists; throw DIRECTIVE_NOT_FOUND if it doesn't.
 * @param {string} filePath
 */
function assertFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new AdapterError(
      'DIRECTIVE_NOT_FOUND',
      'directivePath',
      `directive file not found: ${filePath}`,
      { fixHint: `Verify the path exists: ${filePath}` },
    );
  }
}

// ---------------------------------------------------------------------------
// listPendingDirectives
// ---------------------------------------------------------------------------

/**
 * List all directive YAML files in the pending/ subdirectory.
 *
 * @param {string} [baseDir] — base directives directory; defaults to .xoanon/directives
 * @returns {Array<{ path: string, directive: object }>}
 */
function listPendingDirectives(baseDir) {
  const base = resolveBaseDir(baseDir);
  const pendingDir = path.join(base, SUBDIR_PENDING);
  return readYamlsFromDir(pendingDir);
}

// ---------------------------------------------------------------------------
// approveDirective
// ---------------------------------------------------------------------------

/**
 * Move a directive from pending/ to approved/.
 *
 * @param {string} directivePath — absolute or relative path to the directive file
 * @param {string} [baseDir]
 * @returns {string} — absolute path of the file in approved/
 * @throws {AdapterError} DIRECTIVE_NOT_FOUND if the file doesn't exist
 * @throws {AdapterError} DIRECTIVE_ALREADY_APPROVED if already in approved/
 * @throws {AdapterError} DIRECTIVE_MOVE_FAILED on fs error
 */
function approveDirective(directivePath, baseDir) {
  if (!directivePath || typeof directivePath !== 'string' || directivePath.trim().length === 0) {
    throw new AdapterError(
      'DIRECTIVE_NOT_FOUND',
      'directivePath',
      'directivePath must be a non-empty string',
      { fixHint: 'Pass the path to the directive YAML file as the first argument.' },
    );
  }

  const base = resolveBaseDir(baseDir);
  const resolvedPath = path.resolve(directivePath);

  assertFileExists(resolvedPath);

  const approvedDir = path.join(base, SUBDIR_APPROVED);
  const approvedDest = path.join(approvedDir, path.basename(resolvedPath));

  if (fs.existsSync(approvedDest)) {
    throw new AdapterError(
      'DIRECTIVE_ALREADY_APPROVED',
      'directivePath',
      `directive is already in approved/: ${approvedDest}`,
      { fixHint: 'The directive has already been approved. No action needed.' },
    );
  }

  return moveFile(resolvedPath, approvedDir);
}

// ---------------------------------------------------------------------------
// skipDirective
// ---------------------------------------------------------------------------

/**
 * Move a directive from pending/ to skipped/.
 *
 * @param {string} directivePath — absolute or relative path to the directive file
 * @param {string} [baseDir]
 * @returns {string} — absolute path of the file in skipped/
 * @throws {AdapterError} DIRECTIVE_NOT_FOUND if the file doesn't exist
 * @throws {AdapterError} DIRECTIVE_MOVE_FAILED on fs error
 */
function skipDirective(directivePath, baseDir) {
  if (!directivePath || typeof directivePath !== 'string' || directivePath.trim().length === 0) {
    throw new AdapterError(
      'DIRECTIVE_NOT_FOUND',
      'directivePath',
      'directivePath must be a non-empty string',
      { fixHint: 'Pass the path to the directive YAML file as the first argument.' },
    );
  }

  const base = resolveBaseDir(baseDir);
  const resolvedPath = path.resolve(directivePath);

  assertFileExists(resolvedPath);

  const skippedDir = path.join(base, SUBDIR_SKIPPED);
  return moveFile(resolvedPath, skippedDir);
}

// ---------------------------------------------------------------------------
// listApprovedDirectives
// ---------------------------------------------------------------------------

/**
 * List all directive YAML files in the approved/ subdirectory.
 *
 * @param {string} [baseDir]
 * @returns {Array<{ path: string, directive: object }>}
 */
function listApprovedDirectives(baseDir) {
  const base = resolveBaseDir(baseDir);
  const approvedDir = path.join(base, SUBDIR_APPROVED);
  return readYamlsFromDir(approvedDir);
}

// ---------------------------------------------------------------------------
// completeDirective
// ---------------------------------------------------------------------------

/**
 * Move a directive from approved/ to history/, appending result metadata.
 *
 * The file is read, the result object is merged under a `_result` key, then
 * written to history/ with the original filename (plus a timestamp suffix to
 * avoid collisions).
 *
 * @param {string} directivePath — absolute or relative path to the directive file
 * @param {object} result — execution result to embed
 * @param {string} [baseDir]
 * @returns {string} — absolute path of the file in history/
 * @throws {AdapterError} DIRECTIVE_NOT_FOUND if the file doesn't exist
 * @throws {AdapterError} DIRECTIVE_MOVE_FAILED on fs error
 */
function completeDirective(directivePath, result, baseDir) {
  if (!directivePath || typeof directivePath !== 'string' || directivePath.trim().length === 0) {
    throw new AdapterError(
      'DIRECTIVE_NOT_FOUND',
      'directivePath',
      'directivePath must be a non-empty string',
      { fixHint: 'Pass the path to the directive YAML file as the first argument.' },
    );
  }

  const base = resolveBaseDir(baseDir);
  const resolvedPath = path.resolve(directivePath);

  assertFileExists(resolvedPath);

  // Read the existing directive YAML
  let existingDoc;
  try {
    const text = fs.readFileSync(resolvedPath, 'utf8');
    existingDoc = YAML.parse(text) || {};
  } catch (err) {
    throw new AdapterError(
      'DIRECTIVE_MOVE_FAILED',
      'directivePath',
      `failed to read directive for completion: ${err && err.message ? err.message : String(err)}`,
      { fixHint: 'Ensure the directive YAML is readable and valid.', cause: err },
    );
  }

  // Merge result metadata
  const completedAt = new Date().toISOString();
  const enriched = {
    ...existingDoc,
    _result: result || {},
    _completedAt: completedAt,
  };

  const historyDir = path.join(base, SUBDIR_HISTORY);
  ensureDir(historyDir);

  // Use timestamp suffix to avoid filename collisions in history/
  const baseName = path.basename(resolvedPath, path.extname(resolvedPath));
  const ext = path.extname(resolvedPath) || '.yaml';
  const ts = completedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const destName = `${baseName}.${ts}${ext}`;
  const destPath = path.join(historyDir, destName);

  try {
    const yamlText = YAML.stringify(enriched, { lineWidth: 0, minContentWidth: 0 });
    fs.writeFileSync(destPath, yamlText, 'utf8');
    fs.unlinkSync(resolvedPath);
  } catch (err) {
    throw new AdapterError(
      'DIRECTIVE_MOVE_FAILED',
      'directivePath',
      `failed to write directive to history: ${err && err.message ? err.message : String(err)}`,
      { fixHint: 'Ensure history/ is writable and the source file is accessible.', cause: err },
    );
  }

  return destPath;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  listPendingDirectives,
  approveDirective,
  skipDirective,
  listApprovedDirectives,
  completeDirective,
};
