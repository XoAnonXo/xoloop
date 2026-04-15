const fs = require('node:fs');
const path = require('node:path');
const { AdapterError } = require('./errors.cjs');
const {
  buildAllowedCanonicalSet,
  resolveAndValidateTargetPath,
} = require('./baton_common.cjs');
const {
  countOccurrencesStride1,
  readTextOrReject,
  rollbackFromSnapshot,
  sha256Hex,
  writeTempThenRename,
} = require('./patch_engine_common.cjs');

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizePath(repoRoot, filePath, allowedCanonicalSet) {
  const trimmed = normalizeText(filePath);
  if (!trimmed) {
    throw new AdapterError(
      'CHANGE_SET_PATH_REQUIRED',
      'path',
      'Change-set operation is missing path',
      { fixHint: 'Set the path field to a repo-relative file path, e.g. "src/lib/foo.cjs".' }
    );
  }
  const resolved = resolveAndValidateTargetPath(
    repoRoot,
    trimmed,
    allowedCanonicalSet,
    {
      codeOutOfScope: 'PATCH_PATH_OUT_OF_SCOPE',
      codeEscape: 'CHANGE_SET_PATH_ESCAPES_REPO',
      codeRequired: 'CHANGE_SET_PATH_REQUIRED',
      fieldName: 'path',
    }
  );
  return {
    absolutePath: resolved.canonicalAbsolute,
    relativePath: resolved.canonicalRepoRelative,
  };
}

function applyReplaceOnce(content, operation) {
  const match = String(operation.match ?? '');
  const replace = String(operation.replace ?? '');
  if (!match) {
    throw new AdapterError(
      'CHANGE_SET_MATCH_REQUIRED',
      'match',
      `replace_once for ${operation.path} requires match`,
      { fixHint: 'Set the match field to the exact text to find in the target file.' }
    );
  }
  const firstIndex = content.indexOf(match);
  if (firstIndex === -1) {
    throw new AdapterError(
      'CHANGE_SET_MATCH_NOT_FOUND',
      'match',
      `replace_once could not find match in ${operation.path}`,
      { fixHint: 'The match text does not appear in the file; verify spelling and whitespace.' }
    );
  }
  // Group C / P2#9: count with stride 1 so overlapping starts are caught.
  // The bare `indexOf(match, firstIndex + match.length)` pattern missed
  // cases like match="aaa" against content="aaaaa" where stride-1 finds
  // THREE distinct starting positions (0,1,2) but needle-length stride
  // reports only two distinct non-overlapping matches (0 and 3) — or
  // sometimes only one — so the ambiguity check under-reports.
  const stride1Count = countOccurrencesStride1(content, match);
  if (stride1Count > 1) {
    throw new AdapterError(
      'CHANGE_SET_MATCH_AMBIGUOUS',
      'match',
      `replace_once found multiple matches in ${operation.path}`,
      { fixHint: 'The match text appears more than once (including overlapping starts); use a longer, more specific match string.' }
    );
  }
  return content.slice(0, firstIndex) + replace + content.slice(firstIndex + match.length);
}

function applyInsertAfterOnce(content, operation) {
  const anchor = String(operation.anchor ?? '');
  const text = String(operation.text ?? '');
  if (!anchor) {
    throw new AdapterError(
      'CHANGE_SET_ANCHOR_REQUIRED',
      'anchor',
      `insert_after_once for ${operation.path} requires anchor`,
      { fixHint: 'Set the anchor field to the exact text to locate the insertion point.' }
    );
  }
  const firstIndex = content.indexOf(anchor);
  if (firstIndex === -1) {
    throw new AdapterError(
      'CHANGE_SET_ANCHOR_NOT_FOUND',
      'anchor',
      `insert_after_once could not find anchor in ${operation.path}`,
      { fixHint: 'The anchor text does not appear in the file; verify spelling and whitespace.' }
    );
  }
  const stride1Count = countOccurrencesStride1(content, anchor);
  if (stride1Count > 1) {
    throw new AdapterError(
      'CHANGE_SET_ANCHOR_AMBIGUOUS',
      'anchor',
      `insert_after_once found multiple anchors in ${operation.path}`,
      { fixHint: 'The anchor text appears more than once (including overlapping starts); use a longer, more specific anchor string.' }
    );
  }
  const insertAt = firstIndex + anchor.length;
  return content.slice(0, insertAt) + text + content.slice(insertAt);
}

function applyInsertBeforeOnce(content, operation) {
  const anchor = String(operation.anchor ?? '');
  const text = String(operation.text ?? '');
  if (!anchor) {
    throw new AdapterError(
      'CHANGE_SET_ANCHOR_REQUIRED',
      'anchor',
      `insert_before_once for ${operation.path} requires anchor`,
      { fixHint: 'Set the anchor field to the exact text to locate the insertion point.' }
    );
  }
  const firstIndex = content.indexOf(anchor);
  if (firstIndex === -1) {
    throw new AdapterError(
      'CHANGE_SET_ANCHOR_NOT_FOUND',
      'anchor',
      `insert_before_once could not find anchor in ${operation.path}`,
      { fixHint: 'The anchor text does not appear in the file; verify spelling and whitespace.' }
    );
  }
  const stride1Count = countOccurrencesStride1(content, anchor);
  if (stride1Count > 1) {
    throw new AdapterError(
      'CHANGE_SET_ANCHOR_AMBIGUOUS',
      'anchor',
      `insert_before_once found multiple anchors in ${operation.path}`,
      { fixHint: 'The anchor text appears more than once (including overlapping starts); use a longer, more specific anchor string.' }
    );
  }
  return content.slice(0, firstIndex) + text + content.slice(firstIndex);
}

function normalizeOperation(operation, index) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new AdapterError(
      'CHANGE_SET_OPERATION_NOT_OBJECT',
      `changeSet[${index}]`,
      `Change-set operation ${index} must be an object`,
      { fixHint: 'Each element of the changeSet array must be a plain object with kind and path fields; received a non-object value.' }
    );
  }
  const kind = normalizeText(operation.kind);
  if (!kind) {
    throw new AdapterError(
      'CHANGE_SET_MISSING_KIND',
      `changeSet[${index}].kind`,
      `Change-set operation ${index} is missing kind`,
      { fixHint: 'Set the kind field to one of: replace_once, insert_after_once, insert_before_once.' }
    );
  }
  const normalized = {
    kind,
    path: normalizeText(operation.path),
  };
  if (!normalized.path) {
    throw new AdapterError(
      'CHANGE_SET_MISSING_PATH',
      `changeSet[${index}].path`,
      `Change-set operation ${index} is missing path`,
      { fixHint: 'Set the path field to a repo-relative file path, e.g. "src/lib/foo.cjs".' }
    );
  }
  if (kind === 'replace_once') {
    normalized.match = String(operation.match ?? '');
    normalized.replace = String(operation.replace ?? '');
    return normalized;
  }
  if (kind === 'insert_after_once' || kind === 'insert_before_once') {
    normalized.anchor = String(operation.anchor ?? '');
    normalized.text = String(operation.text ?? '');
    return normalized;
  }
  throw new AdapterError(
    'CHANGE_SET_UNSUPPORTED_KIND',
    `changeSet[${index}].kind`,
    `Unsupported change-set operation kind: ${kind}`,
    { fixHint: 'Allowed kind values are: replace_once, insert_after_once, insert_before_once.' }
  );
}

function normalizeChangeSet(changeSet) {
  if (!Array.isArray(changeSet)) {
    throw new AdapterError(
      'CHANGE_SET_NOT_ARRAY',
      'changeSet',
      'Change-set must be an array',
      { fixHint: 'Pass a JSON array of operation objects to normalizeChangeSet; received a non-array value.' }
    );
  }
  return changeSet.map((operation, index) => normalizeOperation(operation, index));
}

function computeLineMetrics(before, after) {
  const beforeLines = String(before).split('\n').length;
  const afterLines = String(after).split('\n').length;
  const lineDelta = afterLines - beforeLines;
  return {
    beforeLines,
    afterLines,
    lineDelta,
    addedLines: lineDelta > 0 ? lineDelta : 0,
    removedLines: lineDelta < 0 ? Math.abs(lineDelta) : 0,
  };
}

function applyChangeSet(changeSet, options = {}) {
  const repoRoot = path.resolve(options.cwd || process.cwd());
  const allowedCanonicalSet = options.allowedPaths
    ? buildAllowedCanonicalSet(repoRoot, options.allowedPaths)
    : null;
  const verificationManifest = Array.isArray(options.verificationManifest)
    ? options.verificationManifest
    : null;
  const operations = normalizeChangeSet(changeSet);
  const fileState = new Map();

  for (const operation of operations) {
    const target = normalizePath(repoRoot, operation.path, allowedCanonicalSet);
    if (!fileState.has(target.absolutePath)) {
      const { text, hasUtf8Bom } = readTextOrReject(target.absolutePath, operation.path);
      fileState.set(target.absolutePath, {
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
        original: text,
        current: text,
        hasUtf8Bom,
      });
    }
    const entry = fileState.get(target.absolutePath);
    if (operation.kind === 'replace_once') {
      entry.current = applyReplaceOnce(entry.current, operation);
    } else if (operation.kind === 'insert_after_once') {
      entry.current = applyInsertAfterOnce(entry.current, operation);
    } else if (operation.kind === 'insert_before_once') {
      entry.current = applyInsertBeforeOnce(entry.current, operation);
    }
  }

  // Atomic write: snapshot every target before any disk write, then temp-
  // file-stage + rename each target. If any step throws, roll the snapshot
  // back and annotate the error with appliedHandle so callers can recover.
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

  // Audit round-2 P2#4: verificationManifest comparison moves INTO the
  // commit loop so the hash is checked against LIVE on-disk bytes
  // immediately before writeTempThenRename — that's the actual
  // read-to-write TOCTOU window we care about. Previously we hashed
  // entry.original, which only catches drift that happened before apply()
  // started reading.
  const manifestByCanonical = new Map();
  if (verificationManifest) {
    for (const entry of verificationManifest) {
      if (entry && typeof entry.canonicalAbsolute === 'string' && typeof entry.contentSha256 === 'string') {
        manifestByCanonical.set(entry.canonicalAbsolute, entry);
      }
    }
  }

  const files = [];
  try {
    for (const entry of fileState.values()) {
      const snapEntry = snapshot.find((s) => s.canonicalAbsolute === entry.absolutePath);
      const expected = manifestByCanonical.get(entry.absolutePath);
      if (expected) {
        // Audit round-3 P2: compare RAW-BYTES hash so BOM toggles are
        // caught as drift. Hashing decoded text missed BOM flips because
        // readTextOrReject strips the BOM before returning `text`.
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
      files.push({
        path: entry.relativePath,
        ...computeLineMetrics(entry.original, entry.current),
      });
    }
  } catch (writeError) {
    const rollbackErrors = rollbackFromSnapshot(snapshot);
    if (writeError instanceof Error) {
      writeError.snapshot = snapshot;
      writeError.rollbackErrors = rollbackErrors;
      writeError.appliedHandle = {
        repoRoot,
        _fileState: fileState,
        _snapshot: snapshot,
      };
    }
    throw writeError;
  }

  const summary = files.reduce((accumulator, file) => {
    accumulator.touchedFiles += 1;
    accumulator.addedLines += file.addedLines;
    accumulator.removedLines += file.removedLines;
    accumulator.netLineDelta += file.lineDelta;
    return accumulator;
  }, {
    touchedFiles: 0,
    addedLines: 0,
    removedLines: 0,
    netLineDelta: 0,
  });

  return {
    repoRoot,
    operations,
    files,
    summary,
    _fileState: fileState,
    _snapshot: snapshot,
  };
}

function rollbackAppliedChangeSet(appliedChangeSet) {
  if (!appliedChangeSet || !(appliedChangeSet._fileState instanceof Map)) {
    throw new AdapterError(
      'CHANGE_SET_ROLLBACK_INVALID',
      '_fileState',
      'rollbackAppliedChangeSet requires an applied change-set result',
      { fixHint: 'Pass the object returned by applyChangeSet; it must contain a _fileState Map.' }
    );
  }
  if (Array.isArray(appliedChangeSet._snapshot)) {
    // Audit round-3 P2: respect the per-entry `applied` flag. On the
    // SUCCESS path the apply loop already set applied=true for every
    // entry; on the FAILURE path (err.appliedHandle) only entries that
    // were actually written have applied=true and the rest must stay
    // untouched on rollback.
    rollbackFromSnapshot(appliedChangeSet._snapshot);
    return;
  }
  for (const entry of appliedChangeSet._fileState.values()) {
    writeTempThenRename(entry.absolutePath, entry.original, entry.hasUtf8Bom === true);
  }
}

/**
 * Preflight: validate a change set without writing, returning a
 * verificationManifest the apply call can use to detect between-preflight
 * and apply drift.
 */
function preflightChangeSet(changeSet, options = {}) {
  const repoRoot = path.resolve(options.cwd || process.cwd());
  const allowedCanonicalSet = options.allowedPaths
    ? buildAllowedCanonicalSet(repoRoot, options.allowedPaths)
    : null;
  let operations;
  try {
    operations = normalizeChangeSet(changeSet);
  } catch (normError) {
    return {
      ok: false,
      failures: [{ index: -1, code: normError.code || 'CHANGE_SET_NORMALIZE_ERROR', message: normError.message }],
      verificationManifest: [],
    };
  }
  const failures = [];
  const contentCache = new Map();
  const targetByPath = new Map();
  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i];
    let target;
    try {
      target = normalizePath(repoRoot, operation.path, allowedCanonicalSet);
    } catch (pathError) {
      failures.push({ index: i, code: pathError.code || 'PATCH_PATH_ERROR', message: pathError.message });
      continue;
    }
    targetByPath.set(operation.path, target);
    let content;
    if (contentCache.has(target.absolutePath)) {
      content = contentCache.get(target.absolutePath);
    } else {
      try {
        const { text } = readTextOrReject(target.absolutePath, operation.path);
        content = text;
      } catch (readError) {
        failures.push({
          index: i,
          code: readError.code || 'PATCH_READ_ERROR',
          message: readError.message,
        });
        continue;
      }
      contentCache.set(target.absolutePath, content);
    }
    try {
      let updated;
      if (operation.kind === 'replace_once') {
        updated = applyReplaceOnce(content, operation);
      } else if (operation.kind === 'insert_after_once') {
        updated = applyInsertAfterOnce(content, operation);
      } else {
        updated = applyInsertBeforeOnce(content, operation);
      }
      contentCache.set(target.absolutePath, updated);
    } catch (applyError) {
      failures.push({
        index: i,
        code: applyError.code || 'PATCH_APPLY_ERROR',
        message: applyError.message,
      });
    }
  }
  // Audit round-3 P2: manifest stores raw-bytes SHA256, not decoded-text
  // SHA256. This catches BOM toggles between preflight and apply.
  const verificationManifest = [];
  const seen = new Set();
  for (const [relPath, target] of targetByPath) {
    if (seen.has(target.absolutePath)) continue;
    seen.add(target.absolutePath);
    try {
      const { rawBytesSha256 } = readTextOrReject(target.absolutePath, relPath);
      verificationManifest.push({
        path: target.relativePath,
        canonicalAbsolute: target.absolutePath,
        contentSha256: rawBytesSha256,
      });
    } catch (_ignored) {
      /* already captured */
    }
  }
  return { ok: failures.length === 0, failures, verificationManifest };
}

module.exports = {
  applyChangeSet,
  normalizeChangeSet,
  preflightChangeSet,
  rollbackAppliedChangeSet,
  // Exported for unit testing only — callers outside the test suite should use applyChangeSet.
  _normalizePath: normalizePath,
};
