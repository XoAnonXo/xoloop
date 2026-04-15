const fs = require('node:fs');
const path = require('node:path');

const {
  buildAllowedCanonicalSet,
  normalizeText,
  resolveAndValidateTargetPath,
} = require('./baton_common.cjs');
const {
  countOccurrencesStride1,
  readTextOrReject,
  rollbackFromSnapshot,
  sha256Hex,
  writeTempThenRename,
} = require('./patch_engine_common.cjs');
const { AdapterError } = require('./errors.cjs');

// ── Path validation ──────────────────────────────────────────────────

function normalizePath(repoRoot, filePath, allowedCanonicalSet) {
  const trimmed = normalizeText(filePath);
  if (!trimmed) {
    throw new AdapterError(
      'OPERATION_PATH_REQUIRED',
      'path',
      'Operation is missing path',
      { fixHint: 'Set each operation .path to a non-empty repo-relative file path before calling applyOperationSet.' }
    );
  }
  const resolved = resolveAndValidateTargetPath(
    repoRoot,
    trimmed,
    allowedCanonicalSet,
    {
      codeOutOfScope: 'PATCH_PATH_OUT_OF_SCOPE',
      codeEscape: 'OPERATION_PATH_ESCAPES_REPO',
      codeRequired: 'OPERATION_PATH_REQUIRED',
      fieldName: 'path',
    }
  );
  return {
    absolutePath: resolved.canonicalAbsolute,
    relativePath: resolved.canonicalRepoRelative,
  };
}

// ── Single-operation normalization ───────────────────────────────────

const VALID_OP_TYPES = new Set(['replace_exact', 'create_file', 'insert_after', 'insert_before']);

function normalizeOperation(op, index) {
  if (!Number.isFinite(index) || index < 0) index = 0;
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    throw new AdapterError(
      'OPERATION_INVALID',
      `operations[${index}]`,
      `Operation ${index} must be a plain object with an "op" field`,
      { fixHint: 'Each element of the operations array must be a plain object with at least an op and path field; received a non-object value.' }
    );
  }

  const opType = normalizeText(op.op);
  if (!opType) {
    throw new AdapterError(
      'OPERATION_INVALID',
      `operations[${index}].op`,
      `Operation ${index} is missing the "op" field`,
      { fixHint: 'Set the op field to one of: replace_exact, create_file, insert_after, insert_before.' }
    );
  }

  if (!VALID_OP_TYPES.has(opType)) {
    throw new AdapterError(
      'OPERATION_UNKNOWN_TYPE',
      `operations[${index}].op`,
      `Operation ${index} has unknown type "${opType}"`,
      { fixHint: `Supported op types are: ${[...VALID_OP_TYPES].join(', ')}. Received "${opType}".` }
    );
  }

  const pathStr = normalizeText(op.path);
  if (!pathStr) {
    throw new AdapterError(
      'OPERATION_PATH_REQUIRED',
      `operations[${index}].path`,
      `Operation ${index} is missing path`,
      { fixHint: 'Set each operation .path to a non-empty repo-relative file path.' }
    );
  }

  if (opType === 'replace_exact') {
    const search = String(op.search ?? '');
    if (!search) {
      throw new AdapterError(
        'OPERATION_SEARCH_REQUIRED',
        `operations[${index}].search`,
        `Operation ${index} (replace_exact) requires a non-empty search string`,
        { fixHint: 'Set the search field to the exact text to find (byte-exact, must appear exactly once in the target file).' }
      );
    }
    return { op: opType, path: pathStr, search, replace: String(op.replace ?? '') };
  }

  if (opType === 'create_file') {
    return { op: opType, path: pathStr, content: String(op.content ?? '') };
  }

  // insert_after / insert_before
  const anchor = normalizeText(op.anchor);
  if (!anchor) {
    throw new AdapterError(
      'OPERATION_ANCHOR_REQUIRED',
      `operations[${index}].anchor`,
      `Operation ${index} (${opType}) requires a non-empty anchor string`,
      { fixHint: 'Set the anchor field to the exact line text to locate (byte-exact, must appear exactly once in the target file).' }
    );
  }
  return { op: opType, path: pathStr, anchor, content: String(op.content ?? '') };
}

// ── Operation-set normalization ──────────────────────────────────────

function normalizeOperationSet(ops) {
  if (!Array.isArray(ops)) {
    throw new AdapterError(
      'OPERATION_SET_NOT_ARRAY',
      'operations',
      'Operation set must be an array',
      { fixHint: 'Pass an array of operation objects to normalizeOperationSet / applyOperationSet; received a non-array value.' }
    );
  }
  return ops.map((op, index) => normalizeOperation(op, index));
}

// ── Helpers ──────────────────────────────────────────────────────────

function findAllOccurrences(content, needle) {
  if (typeof content !== 'string') {
    throw new AdapterError(
      'OPERATION_CONTENT_INVALID',
      'content',
      'findAllOccurrences expected a string content argument',
      { fixHint: 'Internal error: file content must be a string before searching for occurrences. This usually indicates a corrupted file-read cache.' }
    );
  }
  if (!needle) return [];
  const indices = [];
  let index = content.indexOf(needle);
  while (index !== -1) {
    indices.push(index);
    index = content.indexOf(needle, index + needle.length);
  }
  return indices;
}

/**
 * Uniqueness verdict: count occurrences with STRIDE 1 so overlapping
 * starts are caught. See P2#9 — SEARCH="aaa" against content="aaaaa"
 * starts at positions 0, 1, 2; needle-length stride only catches 0 and 3.
 *
 * `findAllOccurrences` above (needle-length stride) is still used to pick
 * WHERE to apply the replacement — after choosing one position we don't
 * want the next candidate to land inside the same matched region.
 */
function ensureExactlyOnce(content, needle, operationIndex, fieldName, notFoundCode, ambiguousCode) {
  const nonOverlapping = findAllOccurrences(content, needle);
  if (nonOverlapping.length === 0) {
    throw new AdapterError(
      notFoundCode,
      `operations[${operationIndex}].${fieldName}`,
      `Operation ${operationIndex}: ${fieldName} text not found in file`,
      { fixHint: `The ${fieldName} text must appear exactly once in the target file. It was not found at all.` }
    );
  }
  // Stride-1 count catches overlapping self-matches.
  const stride1Count = countOccurrencesStride1(content, needle);
  if (stride1Count > 1) {
    throw new AdapterError(
      ambiguousCode,
      `operations[${operationIndex}].${fieldName}`,
      `Operation ${operationIndex}: ${fieldName} text appears ${stride1Count} times (must be unique; includes overlapping starts)`,
      { fixHint: `The ${fieldName} text must appear exactly once in the target file. It appeared ${stride1Count} times (including overlapping starting positions); use more surrounding context to disambiguate.` }
    );
  }
  return nonOverlapping[0];
}

// ── Apply a single operation against in-memory content ───────────────

function applyOneOperation(operation, content, operationIndex) {
  if (operation.op === 'replace_exact') {
    const matchIndex = ensureExactlyOnce(
      content, operation.search, operationIndex, 'search',
      'OPERATION_SEARCH_NOT_FOUND', 'OPERATION_SEARCH_AMBIGUOUS'
    );
    return (
      content.slice(0, matchIndex) +
      operation.replace +
      content.slice(matchIndex + operation.search.length)
    );
  }

  if (operation.op === 'insert_after') {
    const anchorIndex = ensureExactlyOnce(
      content, operation.anchor, operationIndex, 'anchor',
      'OPERATION_ANCHOR_NOT_FOUND', 'OPERATION_ANCHOR_AMBIGUOUS'
    );
    // Find end of the line containing the anchor
    const lineEnd = content.indexOf('\n', anchorIndex);
    const insertAt = lineEnd === -1 ? content.length : lineEnd + 1;
    return content.slice(0, insertAt) + operation.content + content.slice(insertAt);
  }

  if (operation.op === 'insert_before') {
    const anchorIndex = ensureExactlyOnce(
      content, operation.anchor, operationIndex, 'anchor',
      'OPERATION_ANCHOR_NOT_FOUND', 'OPERATION_ANCHOR_AMBIGUOUS'
    );
    // Find start of the line containing the anchor
    const lineStart = content.lastIndexOf('\n', anchorIndex - 1) + 1;
    return content.slice(0, lineStart) + operation.content + content.slice(lineStart);
  }

  // create_file is handled at the caller level, not here.
  throw new AdapterError(
    'OPERATION_UNKNOWN_TYPE',
    `operations[${operationIndex}].op`,
    `Operation ${operationIndex} has unsupported type "${operation.op}" in applyOneOperation`,
    { fixHint: 'This should not happen after normalization.' }
  );
}

// ── Apply full operation set ─────────────────────────────────────────

/**
 * Apply a normalized operation set to the filesystem atomically.
 *
 * P1#6: create_file used to fs.writeFileSync before the full set was
 * validated — meaning a later validation error left the created file on
 * disk. The fix stages EVERY write (including create_file) to temp paths
 * during the validate phase, then commits via rename in a final pass.
 *
 * Options:
 *   cwd                  repo root (defaults to process.cwd())
 *   allowedPaths         optional list; every canonical target must be
 *                        in the canonical form of this list when supplied
 *   verificationManifest { path, canonicalAbsolute, contentSha256 }[] from
 *                        a previous preflight. When supplied, each target's
 *                        current on-disk bytes are re-hashed just before
 *                        the rename and must match. Mismatch throws
 *                        AdapterError(PATCH_VERIFICATION_DRIFT).
 */
function applyOperationSet(ops, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    const received = options === null ? 'null' : Array.isArray(options) ? 'array' : typeof options;
    throw new AdapterError(
      'OPERATION_SET_OPTIONS_INVALID',
      'options',
      `applyOperationSet options must be a plain object, received ${received}`,
      { fixHint: 'Call applyOperationSet(ops) with no second argument or a plain object like { cwd: "/path" }.' }
    );
  }
  if (options.cwd !== undefined && typeof options.cwd !== 'string') {
    throw new AdapterError(
      'OPERATION_SET_OPTIONS_INVALID',
      'options.cwd',
      `applyOperationSet options.cwd must be a string, received ${typeof options.cwd}`,
      { fixHint: 'Pass a string absolute path as options.cwd, or omit it to use process.cwd().' }
    );
  }
  const repoRoot = path.resolve(options.cwd || process.cwd());
  const allowedCanonicalSet = options.allowedPaths
    ? buildAllowedCanonicalSet(repoRoot, options.allowedPaths)
    : null;
  const verificationManifest = Array.isArray(options.verificationManifest)
    ? options.verificationManifest
    : null;
  const operations = normalizeOperationSet(ops);

  // Stage every mutation in memory first — no disk writes until the whole
  // set validates. fileState maps canonicalAbsolute -> entry for
  // modify-in-place ops (replace_exact / insert_after / insert_before).
  // creates is a separate ordered list for create_file ops.
  const fileState = new Map();
  const creates = [];             // { canonicalAbsolute, relativePath, content }
  const createdPaths = new Set(); // canonicalAbsolute values for fast lookup

  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i];
    const target = normalizePath(repoRoot, operation.path, allowedCanonicalSet);

    if (operation.op === 'create_file') {
      // Guard: no double-creates and no collisions with existing on-disk files
      if (createdPaths.has(target.absolutePath)) {
        throw new AdapterError(
          'OPERATION_FILE_EXISTS',
          `operations[${i}].path`,
          `Operation ${i} (create_file): file was already created earlier in this set at ${operation.path}`,
          { fixHint: 'An earlier operation in the same set already created this file. Only one create_file per target path per apply call.' }
        );
      }
      if (fs.existsSync(target.absolutePath)) {
        throw new AdapterError(
          'OPERATION_FILE_EXISTS',
          `operations[${i}].path`,
          `Operation ${i} (create_file): file already exists at ${operation.path}`,
          { fixHint: 'create_file requires the target path to not exist yet. Use replace_exact to modify an existing file.' }
        );
      }
      creates.push({
        canonicalAbsolute: target.absolutePath,
        relativePath: target.relativePath,
        content: operation.content,
      });
      createdPaths.add(target.absolutePath);
      continue;
    }

    // For replace_exact, insert_after, insert_before: read the file if not yet cached
    if (!fileState.has(target.absolutePath)) {
      let text;
      let hasUtf8Bom;
      try {
        const read = readTextOrReject(target.absolutePath, operation.path);
        text = read.text;
        hasUtf8Bom = read.hasUtf8Bom;
      } catch (readError) {
        if (readError instanceof AdapterError && readError.code === 'PATCH_NON_UTF8_TARGET') {
          throw readError;
        }
        throw new AdapterError(
          'OPERATION_FILE_NOT_FOUND',
          `operations[${i}].path`,
          `Operation ${i}: cannot read file ${operation.path}`,
          { fixHint: 'The target file must exist for replace_exact, insert_after, and insert_before operations.', cause: readError }
        );
      }
      fileState.set(target.absolutePath, {
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
        original: text,
        current: text,
        hasUtf8Bom,
      });
    }

    const entry = fileState.get(target.absolutePath);
    // applyOneOperation may throw AdapterError — propagate without
    // touching disk (nothing has been written yet).
    entry.current = applyOneOperation(operation, entry.current, i);
  }

  // All operations validated + applied in memory. Build the snapshot NOW
  // so writes are atomic and rollback-capable.
  const snapshot = [];
  for (const entry of fileState.values()) {
    snapshot.push({
      path: entry.relativePath,
      canonicalAbsolute: entry.absolutePath,
      existedBefore: true,
      beforeContent: entry.original,
      hasUtf8Bom: entry.hasUtf8Bom,
      applied: false,
    });
  }
  for (const entry of creates) {
    snapshot.push({
      path: entry.relativePath,
      canonicalAbsolute: entry.canonicalAbsolute,
      existedBefore: false,
      beforeContent: null,
      hasUtf8Bom: false,
      applied: false,
    });
  }

  // Audit round-2 P2#4: verificationManifest comparison moves INTO the
  // commit loop so the hash is checked against LIVE on-disk bytes
  // immediately before writeTempThenRename — that's the actual
  // read-to-write TOCTOU window. Previously we hashed entry.original
  // (the cached content from apply()'s initial read pass), which only
  // catches drift that happened BEFORE apply() started.
  const manifestByCanonical = new Map();
  if (verificationManifest) {
    for (const entry of verificationManifest) {
      if (entry && typeof entry.canonicalAbsolute === 'string' && typeof entry.contentSha256 === 'string') {
        manifestByCanonical.set(entry.canonicalAbsolute, entry);
      }
    }
  }

  // Commit phase: every write is temp-file-staged then renamed. If any
  // step fails, walk the snapshot in reverse and restore every applied
  // entry (best-effort; per-file rollback errors are captured on
  // writeError.rollbackErrors).
  try {
    // modify-in-place files first, then create_file. Deterministic order
    // so rollback can undo in reverse.
    for (const entry of fileState.values()) {
      const snapEntry = snapshot.find((s) => s.canonicalAbsolute === entry.absolutePath);
      // Just-before-write drift check against live disk bytes.
      const expected = manifestByCanonical.get(entry.absolutePath);
      if (expected) {
        // Audit round-3 P2: compare the RAW-BYTES hash (pre-BOM-strip,
        // pre-decode) so a concurrent process that flips the UTF-8 BOM
        // between preflight and apply is detected. Hashing decoded text
        // missed the BOM toggle because readTextOrReject strips the BOM
        // before returning `text`.
        let liveRawBytesSha256;
        try {
          const re = readTextOrReject(entry.absolutePath, entry.relativePath);
          liveRawBytesSha256 = re.rawBytesSha256;
        } catch (reReadError) {
          throw new AdapterError(
            'PATCH_VERIFICATION_DRIFT',
            'path',
            `File could not be re-read just before write: ${entry.relativePath}`,
            {
              fixHint: 'The target file could not be re-read immediately before write. Another process likely changed it. Re-run preflight and apply.',
              cause: reReadError,
            }
          );
        }
        if (liveRawBytesSha256 !== expected.contentSha256) {
          throw new AdapterError(
            'PATCH_VERIFICATION_DRIFT',
            'path',
            `File content drifted between preflight and apply: ${entry.relativePath} (expected ${expected.contentSha256}, live ${liveRawBytesSha256})`,
            { fixHint: 'Re-run preflight to pick up the latest content, then apply with the fresh verificationManifest. Another writer modified the file between the read and write phases of apply.' }
          );
        }
      }
      writeTempThenRename(entry.absolutePath, entry.current, entry.hasUtf8Bom);
      if (snapEntry) snapEntry.applied = true;
    }
    for (const entry of creates) {
      const snapEntry = snapshot.find((s) => s.canonicalAbsolute === entry.canonicalAbsolute);
      // Ensure the parent directory exists before the temp-file dance
      // (temp file is written in the same directory as the target).
      const dirPath = path.dirname(entry.canonicalAbsolute);
      fs.mkdirSync(dirPath, { recursive: true });
      // Audit round-2 P1#2: close the TOCTOU window between the planning-
      // time existsSync check and the apply-time renameSync. A concurrent
      // creator could land between those two steps and have their file
      // silently overwritten. Re-check existence immediately before the
      // rename and reject if the path was taken. Also set the existedBefore
      // marker on the snapshot to false so rollback (unlink) is correct.
      if (fs.existsSync(entry.canonicalAbsolute)) {
        throw new AdapterError(
          'PATCH_CREATE_FILE_RACE_DETECTED',
          'path',
          `create_file detected a concurrent creator: ${entry.relativePath} appeared between planning and apply`,
          { fixHint: 'Another process created this file after preflight said it did not exist. Re-run preflight and apply so the new state is respected.' }
        );
      }
      writeTempThenRename(entry.canonicalAbsolute, entry.content, false);
      if (snapEntry) snapEntry.applied = true;
    }
  } catch (writeError) {
    const rollbackErrors = rollbackFromSnapshot(snapshot);
    if (writeError instanceof Error) {
      writeError.snapshot = snapshot;
      writeError.rollbackErrors = rollbackErrors;
      writeError.appliedHandle = buildHandleFromSnapshot(snapshot);
    }
    throw writeError;
  }

  // Build the legacy rollback handle (array of { path, originalContent|created }).
  // Preserves the historical API while the new _snapshot is also attached so
  // callers that want the richer per-file metadata can reach for it.
  const rollbackHandle = [];
  for (const entry of fileState.values()) {
    rollbackHandle.push({ path: entry.absolutePath, originalContent: entry.original });
  }
  for (const entry of creates) {
    rollbackHandle.push({ path: entry.canonicalAbsolute, created: true });
  }
  // Hidden non-enumerable snapshot for the newer atomic-rollback path.
  try {
    Object.defineProperty(rollbackHandle, '_snapshot', { value: snapshot, enumerable: false });
  } catch (_ignored) { /* array in strict mode — non-fatal */ }

  return rollbackHandle;
}

function buildHandleFromSnapshot(snapshot) {
  const arr = [];
  for (const entry of snapshot) {
    if (entry.existedBefore) {
      arr.push({ path: entry.canonicalAbsolute, originalContent: entry.beforeContent });
    } else {
      arr.push({ path: entry.canonicalAbsolute, created: true });
    }
  }
  try {
    Object.defineProperty(arr, '_snapshot', { value: snapshot, enumerable: false });
  } catch (_ignored) { /* non-fatal */ }
  return arr;
}

// ── Rollback helpers ─────────────────────────────────────────────────

/**
 * Public rollback: restore from a rollback handle returned by applyOperationSet.
 *
 * Audit round-2 P1#3: prefer the richer `_snapshot` metadata when the handle
 * carries it, so the UTF-8 BOM (captured at read time) gets re-prepended on
 * restore. The legacy path (when no _snapshot is present) now also builds a
 * per-path hasUtf8Bom lookup from any snapshot entries that DO exist so the
 * common case (handle returned by applyOperationSet) still restores bytes
 * exactly.
 */
function rollbackOperationSet(rollbackHandle) {
  if (!Array.isArray(rollbackHandle)) {
    throw new AdapterError(
      'ROLLBACK_INPUT_INVALID',
      'rollbackHandle',
      'rollbackOperationSet requires an array returned by applyOperationSet',
      { fixHint: 'Pass the array returned by applyOperationSet(); each element describes how to undo one file mutation.' }
    );
  }

  // Prefer the atomic snapshot-based rollback when the handle carries one.
  // rollbackFromSnapshot knows about hasUtf8Bom and will re-prepend the BOM
  // when writing back, so byte-exact restore is preserved.
  const snapshot = rollbackHandle._snapshot;
  if (Array.isArray(snapshot)) {
    // Validate each handle entry for the legacy shape check before delegating.
    for (const entry of rollbackHandle) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
        throw new AdapterError(
          'ROLLBACK_INPUT_INVALID',
          'rollbackHandle',
          'Each rollback-handle entry must have a path string',
          { fixHint: 'Do not modify the array returned by applyOperationSet before passing it to rollbackOperationSet.' }
        );
      }
    }
    // Audit round-3 P2: respect the per-entry `applied` flag instead of
    // force-marking every entry as applied=true. The apply loop sets
    // entry.applied=true AFTER each successful writeTempThenRename. On the
    // SUCCESS path every entry is already true. On the FAILURE path (handle
    // carried by err.appliedHandle), only files that were actually written
    // have applied=true; files past the failure point have applied=false.
    // Force-marking applied=true on the failure handle would restore those
    // un-touched paths to their snapshot content, clobbering whatever the
    // failure handler or a concurrent writer placed there.
    rollbackFromSnapshot(snapshot);
    return;
  }

  // Legacy fallback: no _snapshot on the handle. Restore bytes using the
  // originalContent string from the handle entry. There is no BOM metadata
  // here (callers supplying a hand-built handle don't have it), so this
  // path writes without a BOM — same as before the audit round-2 fix. The
  // normal applyOperationSet path above always has _snapshot.
  for (const entry of rollbackHandle) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw new AdapterError(
        'ROLLBACK_INPUT_INVALID',
        'rollbackHandle',
        'Each rollback-handle entry must have a path string',
        { fixHint: 'Do not modify the array returned by applyOperationSet before passing it to rollbackOperationSet.' }
      );
    }
    if (entry.created) {
      try { fs.unlinkSync(entry.path); } catch (_ignored) { /* already deleted */ }
    } else if (typeof entry.originalContent === 'string') {
      // Use the same atomic temp+rename path as writes so restore is
      // itself resilient to a process crash in the middle of the restore.
      writeTempThenRename(entry.path, entry.originalContent, !!entry.hasUtf8Bom);
    }
  }
}

// ── Preflight (dry run) ─────────────────────────────────────────────

function preflightOperationSet(ops, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    const received = options === null ? 'null' : Array.isArray(options) ? 'array' : typeof options;
    throw new AdapterError(
      'OPERATION_SET_OPTIONS_INVALID',
      'options',
      `preflightOperationSet options must be a plain object, received ${received}`,
      { fixHint: 'Call preflightOperationSet(ops) with no second argument or a plain object like { cwd: "/path" }.' }
    );
  }
  if (options.cwd !== undefined && typeof options.cwd !== 'string') {
    throw new AdapterError(
      'OPERATION_SET_OPTIONS_INVALID',
      'options.cwd',
      `preflightOperationSet options.cwd must be a string, received ${typeof options.cwd}`,
      { fixHint: 'Pass a string absolute path as options.cwd, or omit it to use process.cwd().' }
    );
  }
  const repoRoot = path.resolve(options.cwd || process.cwd());
  const allowedCanonicalSet = options.allowedPaths
    ? buildAllowedCanonicalSet(repoRoot, options.allowedPaths)
    : null;
  let operations;
  try {
    operations = normalizeOperationSet(ops);
  } catch (normError) {
    return {
      ok: false,
      failures: [{ index: -1, code: normError.code, message: normError.message }],
      verificationManifest: [],
    };
  }

  const failures = [];
  // Track in-memory content for sequential preflight (earlier ops affect later ones)
  const contentCache = new Map();
  const targetByAbsolutePath = new Map();
  const pendingCreates = new Set();

  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i];
    let target;
    try {
      target = normalizePath(repoRoot, operation.path, allowedCanonicalSet);
    } catch (pathError) {
      failures.push({ index: i, code: pathError.code || 'PATH_ERROR', message: pathError.message });
      continue;
    }
    targetByAbsolutePath.set(target.absolutePath, target);

    if (operation.op === 'create_file') {
      if (pendingCreates.has(target.absolutePath)) {
        failures.push({
          index: i,
          code: 'OPERATION_FILE_EXISTS',
          message: `Operation ${i} (create_file): duplicate create for ${operation.path} earlier in set`,
        });
      } else if (fs.existsSync(target.absolutePath)) {
        failures.push({
          index: i,
          code: 'OPERATION_FILE_EXISTS',
          message: `Operation ${i} (create_file): file already exists at ${operation.path}`,
        });
      } else {
        pendingCreates.add(target.absolutePath);
      }
      continue;
    }

    // For replace_exact, insert_after, insert_before: read file content
    let content;
    if (contentCache.has(target.absolutePath)) {
      content = contentCache.get(target.absolutePath);
    } else {
      try {
        const { text } = readTextOrReject(target.absolutePath, operation.path);
        content = text;
      } catch (readError) {
        if (readError && readError.code === 'PATCH_NON_UTF8_TARGET') {
          failures.push({
            index: i,
            code: 'PATCH_NON_UTF8_TARGET',
            message: readError.message,
          });
        } else {
          failures.push({
            index: i,
            code: 'OPERATION_FILE_NOT_FOUND',
            message: `Operation ${i}: cannot read file ${operation.path}`,
          });
        }
        continue;
      }
      contentCache.set(target.absolutePath, content);
    }

    if (operation.op === 'replace_exact') {
      const nonOverlapping = findAllOccurrences(content, operation.search);
      const stride1Count = countOccurrencesStride1(content, operation.search);
      if (nonOverlapping.length === 0) {
        failures.push({ index: i, code: 'OPERATION_SEARCH_NOT_FOUND', message: `Operation ${i}: search text not found in ${operation.path}` });
      } else if (stride1Count > 1) {
        failures.push({ index: i, code: 'OPERATION_SEARCH_AMBIGUOUS', message: `Operation ${i}: search text appears ${stride1Count} times in ${operation.path} (includes overlapping starts)` });
      } else {
        // Simulate the replacement in the cache so later ops see the updated content
        const matchIndex = nonOverlapping[0];
        const updated = content.slice(0, matchIndex) + operation.replace + content.slice(matchIndex + operation.search.length);
        contentCache.set(target.absolutePath, updated);
      }
    } else {
      // insert_after / insert_before
      const nonOverlapping = findAllOccurrences(content, operation.anchor);
      const stride1Count = countOccurrencesStride1(content, operation.anchor);
      if (nonOverlapping.length === 0) {
        failures.push({ index: i, code: 'OPERATION_ANCHOR_NOT_FOUND', message: `Operation ${i}: anchor text not found in ${operation.path}` });
      } else if (stride1Count > 1) {
        failures.push({ index: i, code: 'OPERATION_ANCHOR_AMBIGUOUS', message: `Operation ${i}: anchor text appears ${stride1Count} times in ${operation.path} (includes overlapping starts)` });
      } else {
        // Simulate the insertion in the cache
        const updated = applyOneOperation(operation, content, i);
        contentCache.set(target.absolutePath, updated);
      }
    }
  }

  // Build verificationManifest. We hash the ORIGINAL on-disk content for
  // every target we successfully read — NOT the post-simulation cache. The
  // manifest represents the view of disk at preflight time; apply will
  // compare against the same baseline.
  //
  // Audit round-3 P2: the manifest stores the RAW BYTES hash (pre-BOM-strip,
  // pre-decode). Hashing decoded text was blind to BOM toggles — a
  // concurrent process that added or removed the UTF-8 BOM changed the
  // actual file bytes but left the decoded text identical, so the drift
  // check would silently pass and the write would flip the BOM state.
  const verificationManifest = [];
  for (const [absolutePath, target] of targetByAbsolutePath) {
    if (pendingCreates.has(absolutePath)) continue;
    try {
      const { rawBytesSha256 } = readTextOrReject(absolutePath, target.relativePath);
      verificationManifest.push({
        path: target.relativePath,
        canonicalAbsolute: absolutePath,
        contentSha256: rawBytesSha256,
      });
    } catch (_ignored) {
      // Already recorded in failures.
    }
  }

  return { ok: failures.length === 0, failures, verificationManifest };
}

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
  normalizeOperation,
  normalizeOperationSet,
  applyOperationSet,
  rollbackOperationSet,
  preflightOperationSet,
};
