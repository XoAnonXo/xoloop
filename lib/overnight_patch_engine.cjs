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

function normalizePath(repoRoot, filePath, allowedCanonicalSet) {
  const trimmed = normalizeText(filePath);
  if (!trimmed) {
    throw new AdapterError(
      'PATCH_PATH_REQUIRED',
      'path',
      'Patch operation is missing path',
      { fixHint: 'Set each patch block .path to a non-empty repo-relative file path before calling applyPatchSet.' }
    );
  }
  const resolved = resolveAndValidateTargetPath(
    repoRoot,
    trimmed,
    allowedCanonicalSet,
    {
      codeOutOfScope: 'PATCH_PATH_OUT_OF_SCOPE',
      codeEscape: 'PATCH_PATH_ESCAPES_REPO',
      codeRequired: 'PATCH_PATH_REQUIRED',
      fieldName: 'path',
    }
  );
  return {
    absolutePath: resolved.canonicalAbsolute,
    relativePath: resolved.canonicalRepoRelative,
  };
}

function normalizePatchBlock(block, index) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new AdapterError(
      'PATCH_BLOCK_NOT_OBJECT',
      `patchSet[${index}]`,
      `Patch block ${index} must be an object`,
      { fixHint: 'Each element of the patchSet array must be a plain object with path, search, and replace fields; received a non-object value.' }
    );
  }
  const normalized = {
    path: normalizeText(block.path),
    search: String(block.search ?? ''),
    replace: String(block.replace ?? ''),
    contextBefore: String(block.context_before ?? block.contextBefore ?? ''),
    contextAfter: String(block.context_after ?? block.contextAfter ?? ''),
  };
  if (!normalized.path) {
    throw new AdapterError(
      'PATCH_BLOCK_PATH_REQUIRED',
      `patchSet[${index}].path`,
      `Patch block ${index} is missing path`,
      { fixHint: `Set patchSet[${index}].path to a non-empty repo-relative file path; every patch block must specify which file to edit.` }
    );
  }
  if (!normalized.search) {
    throw new AdapterError(
      'PATCH_BLOCK_SEARCH_REQUIRED',
      `patchSet[${index}].search`,
      `Patch block ${index} is missing search`,
      { fixHint: `Set patchSet[${index}].search to a non-empty string containing the exact text to find in the file; every patch block must have a SEARCH anchor.` }
    );
  }
  return normalized;
}

function normalizePatchSet(patchSet) {
  if (!Array.isArray(patchSet)) {
    throw new AdapterError(
      'PATCH_SET_NOT_ARRAY',
      'patchSet',
      'Patch set must be an array',
      { fixHint: 'Pass an array of patch-block objects to normalizePatchSet / applyPatchSet; received a non-array value.' }
    );
  }
  return patchSet.map((block, index) => normalizePatchBlock(block, index));
}

/**
 * Return the set of starting positions in `content` where `needle` appears
 * as a non-overlapping substring. indexOf(..., index + needle.length) is
 * the right stride for WHERE to apply a replacement: after picking one
 * location we don't want to land inside the same match again.
 */
function findAllOccurrences(content, needle) {
  if (typeof content !== 'string') {
    throw new AdapterError(
      'PATCH_CONTENT_INVALID',
      'content',
      'findAllOccurrences expected a string content argument',
      { fixHint: 'Internal error: file content must be a string before searching for occurrences. This usually indicates a corrupted file-read or an unexpected caller state.' }
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

function matchesContext(content, index, operation) {
  if (operation.contextBefore) {
    const beforeSlice = content.slice(Math.max(0, index - operation.contextBefore.length), index);
    if (beforeSlice !== operation.contextBefore) {
      return false;
    }
  }
  if (operation.contextAfter) {
    const afterStart = index + operation.search.length;
    const afterSlice = content.slice(afterStart, afterStart + operation.contextAfter.length);
    if (afterSlice !== operation.contextAfter) {
      return false;
    }
  }
  return true;
}

/**
 * Build a short excerpt of the actual file content around the SEARCH text's
 * approximate location (using the first line of SEARCH as a heuristic anchor).
 * Attached to AdapterError.context (NOT error.message) so repair-prompt
 * builders can QUOTE/ENCODE it as inert data instead of splicing it into
 * prose where a malicious file region could inject instructions.
 */
function buildNotFoundExcerpt(content, searchText) {
  const firstSearchLine = String(searchText || '').split('\n')[0].trim();
  if (!firstSearchLine) return '';
  const lines = String(content || '').split('\n');
  const needle = firstSearchLine.replace(/\s+/g, ' ').slice(0, 40);
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const haystack = lines[i].replace(/\s+/g, ' ').slice(0, 80);
    let score = 0;
    for (let j = 0; j < needle.length && j < haystack.length; j += 1) {
      if (needle[j] === haystack[j]) score += 1;
      else break;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex === -1 || bestScore < 8) return '';
  const start = Math.max(0, bestIndex - 2);
  const end = Math.min(lines.length, bestIndex + 5);
  return lines.slice(start, end).map((line, idx) => `${start + idx + 1}: ${line}`).join('\n');
}

function resolveReplacementIndex(content, operation) {
  const matches = findAllOccurrences(content, operation.search);
  if (matches.length === 0) {
    // Round-N P2: closest-match data lives on error.context, NOT in the
    // human-readable message. Repair-prompt builders that want to diff
    // against it must read error.context.closestMatch and QUOTE/ENCODE it
    // as inert data. Message stays generic so a malicious file region
    // quoted by the closest-match heuristic cannot inject instructions
    // into the next LLM prompt.
    const excerpt = buildNotFoundExcerpt(content, operation.search);
    const err = new AdapterError(
      'PATCH_SEARCH_NOT_FOUND',
      'search',
      `SEARCH block could not find text in ${operation.path}; see error.context for diagnostic data.`,
      { fixHint: 'Update the search field to exactly match a unique substring of the current file content. The diagnostic excerpt is available in error.context.closestMatch for structured consumers (repair-prompt builder should QUOTE it, not splice it into prose).' }
    );
    err.context = {
      file: operation.path,
      closestMatch: excerpt || null,
      searchFirstLine: String(operation.search || '').split('\n')[0] || '',
    };
    throw err;
  }
  if (matches.length === 1) {
    if (!matchesContext(content, matches[0], operation)) {
      // Same treatment as not-found: move the actual surrounding bytes
      // into error.context rather than splicing them into message.
      const idx = matches[0];
      const actualBefore = operation.contextBefore
        ? content.slice(Math.max(0, idx - operation.contextBefore.length), idx)
        : '';
      const actualAfter = operation.contextAfter
        ? content.slice(idx + operation.search.length, idx + operation.search.length + operation.contextAfter.length)
        : '';
      const err = new AdapterError(
        'PATCH_CONTEXT_MISMATCH',
        'contextBefore',
        `SEARCH block context did not match in ${operation.path}; see error.context for the actual surrounding bytes.`,
        { fixHint: 'Update context_before and context_after to match the actual surrounding bytes. The actual bytes are available in error.context.actualContextBefore and error.context.actualContextAfter for structured consumers (repair-prompt builder should QUOTE them, not splice them into prose).' }
      );
      err.context = {
        file: operation.path,
        actualContextBefore: actualBefore || null,
        actualContextAfter: actualAfter || null,
      };
      throw err;
    }
    // Ambiguity guard (Group C / P2#9): the non-overlapping match list says
    // the search appears once, but the stride-1 scan may still reveal that
    // the search overlaps with itself in the same region (e.g. "aaa"
    // inside "aaaaa"). Reject such overlapping cases as ambiguous.
    const stride1 = countOccurrencesStride1(content, operation.search);
    if (stride1 > 1) {
      throw new AdapterError(
        'PATCH_SEARCH_AMBIGUOUS',
        'search',
        `SEARCH block is ambiguous in ${operation.path}: it can start at ${stride1} overlapping positions.`,
        { fixHint: 'Add context_before and/or context_after that uniquely identify the intended occurrence; the search text overlaps with itself so a stride-1 scan finds more than one starting position.' }
      );
    }
    return matches[0];
  }
  const filtered = matches.filter((index) => matchesContext(content, index, operation));
  if (filtered.length === 1) {
    return filtered[0];
  }
  if (filtered.length === 0) {
    throw new AdapterError(
      'PATCH_CONTEXT_NO_MATCH',
      'contextBefore',
      `SEARCH block matched ${matches.length} locations in ${operation.path} but context_before/context_after did not match any of them; fix the context to match the intended occurrence`,
      { fixHint: 'Set context_before and context_after to the exact text immediately surrounding the specific occurrence you intend to replace; the context must uniquely identify one of the matched locations.' }
    );
  }
  throw new AdapterError(
    'PATCH_SEARCH_AMBIGUOUS',
    'search',
    `SEARCH block matched multiple locations in ${operation.path}`,
    { fixHint: 'Add context_before and/or context_after that uniquely identify the intended occurrence; the search text alone matches more than one location in the file.' }
  );
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

/**
 * Apply a normalized patch set to the filesystem atomically.
 *
 * Options:
 *   cwd                 — repo root (defaults to process.cwd())
 *   allowedPaths        — optional array; when supplied every canonical
 *                         target must be in the canonical form of this list
 *   verificationManifest — optional { path, canonicalAbsolute, contentSha256 }[]
 *                         from a previous preflight. When supplied, each
 *                         target's disk bytes are re-hashed just before the
 *                         write and must match; mismatch throws
 *                         AdapterError(PATCH_VERIFICATION_DRIFT).
 */
function applyPatchSet(patchSet, options = {}) {
  const repoRoot = path.resolve(options.cwd || process.cwd());
  const allowedCanonicalSet = options.allowedPaths
    ? buildAllowedCanonicalSet(repoRoot, options.allowedPaths)
    : null;
  const verificationManifest = Array.isArray(options.verificationManifest)
    ? options.verificationManifest
    : null;
  const operations = normalizePatchSet(patchSet);
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
    const matchIndex = resolveReplacementIndex(entry.current, operation);
    entry.current = [
      entry.current.slice(0, matchIndex),
      operation.replace,
      entry.current.slice(matchIndex + operation.search.length),
    ].join('');
  }

  // ── Build snapshot BEFORE any disk write, then temp-file-stage + rename
  // ── every target. If anything throws, roll back via the snapshot.
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

  // Audit round-2 P2#4: verificationManifest must be compared at WRITE
  // time, not READ time. Previously we hashed entry.original (the cached
  // content from when apply() began reading) — that only catches drift
  // that happened BEFORE apply() started, not the real TOCTOU window
  // between our read and our renameSync. Build the manifest lookup here;
  // the hash comparison itself moves into the commit loop below so each
  // file is checked against its LIVE on-disk bytes immediately before
  // writeTempThenRename.
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
      // Audit round-2 P2#4: re-read the LIVE file bytes from disk and hash
      // them NOW — immediately before writeTempThenRename — so a concurrent
      // writer who landed between our initial read (entry.original) and this
      // point is detected and rejected rather than silently overwritten.
      //
      // Audit round-3 P2: hash the RAW bytes (pre-BOM-strip, pre-decode).
      // Previously we hashed the decoded text, which is identical before
      // and after a BOM toggle — a concurrent writer adding OR removing the
      // UTF-8 BOM would change the file's actual bytes but produce the same
      // decoded text, letting the drift check pass and silently flipping
      // the BOM state on write.
      const expected = manifestByCanonical.get(entry.absolutePath);
      if (expected) {
        let liveRawBytesSha256;
        try {
          const re = readTextOrReject(entry.absolutePath, entry.relativePath);
          liveRawBytesSha256 = re.rawBytesSha256;
        } catch (reReadError) {
          throw new AdapterError(
            'PATCH_VERIFICATION_DRIFT',
            'path',
            `File disappeared between preflight and apply: ${entry.relativePath}`,
            {
              fixHint: 'The target file could not be re-read immediately before write. Another process likely deleted or renamed it. Re-run preflight and apply.',
              cause: reReadError,
            }
          );
        }
        if (liveRawBytesSha256 !== expected.contentSha256) {
          throw new AdapterError(
            'PATCH_VERIFICATION_DRIFT',
            'path',
            `File content drifted between preflight and apply: ${entry.relativePath} (expected ${expected.contentSha256}, live ${liveRawBytesSha256})`,
            {
              fixHint: 'Re-run preflight to pick up the latest content, then apply with the fresh verificationManifest. Another writer modified the file between the read and write phases of apply.',
            }
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

function rollbackAppliedPatchSet(appliedPatchSet) {
  if (!appliedPatchSet || !(appliedPatchSet._fileState instanceof Map)) {
    throw new AdapterError(
      'ROLLBACK_INPUT_INVALID',
      'appliedPatchSet',
      'rollbackAppliedPatchSet requires an applied patch-set result',
      { fixHint: 'Pass the object returned by applyPatchSet(); it must carry a _fileState Map of original file contents so rollback can restore every touched file byte-for-byte.' }
    );
  }
  // Prefer the atomic snapshot path when available; fall back to the old
  // direct-write path for back-compat (tests may synthesize a fileState).
  if (Array.isArray(appliedPatchSet._snapshot)) {
    // Audit round-3 P2: respect the per-entry `applied` flag. On the
    // SUCCESS path the apply loop already set applied=true for every
    // entry; on the FAILURE path (err.appliedHandle) only entries that
    // were actually written have applied=true and the rest must stay
    // untouched on rollback.
    rollbackFromSnapshot(appliedPatchSet._snapshot);
    return;
  }
  for (const entry of appliedPatchSet._fileState.values()) {
    writeTempThenRename(entry.absolutePath, entry.original, entry.hasUtf8Bom === true);
  }
}

function validatePatchSetAgainstContent(patchSet, contentByPath) {
  const operations = normalizePatchSet(patchSet);
  return operations.map((operation) => {
    const content = contentByPath && Object.prototype.hasOwnProperty.call(contentByPath, operation.path)
      ? contentByPath[operation.path]
      : null;
    if (typeof content !== 'string') {
      throw new AdapterError(
        'PATCH_VALIDATION_CONTENT_MISSING',
        `contentByPath[${operation.path}]`,
        `Patch validation content is missing for ${operation.path}`,
        { fixHint: 'Populate contentByPath with a string entry for every operation.path before calling validatePatchSetAgainstContent; the key must match operation.path exactly and the value must be the full window content the SEARCH block is validated against.' }
      );
    }
    const matchIndex = resolveReplacementIndex(content, operation);
    return {
      path: operation.path,
      matchIndex,
    };
  });
}

/**
 * Preflight: validate without writing, and build a verificationManifest
 * that applyPatchSet can later use to detect between-preflight-and-apply
 * drift. Returns { ok, failures, verificationManifest }.
 */
function preflightPatchSet(patchSet, options = {}) {
  const repoRoot = path.resolve(options.cwd || process.cwd());
  const allowedCanonicalSet = options.allowedPaths
    ? buildAllowedCanonicalSet(repoRoot, options.allowedPaths)
    : null;
  let operations;
  try {
    operations = normalizePatchSet(patchSet);
  } catch (normError) {
    return {
      ok: false,
      failures: [{ index: -1, code: normError.code || 'PATCH_NORMALIZE_ERROR', message: normError.message }],
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
      const matchIndex = resolveReplacementIndex(content, operation);
      const updated = content.slice(0, matchIndex) + operation.replace + content.slice(matchIndex + operation.search.length);
      contentCache.set(target.absolutePath, updated);
    } catch (resolveError) {
      failures.push({
        index: i,
        code: resolveError.code || 'PATCH_APPLY_ERROR',
        message: resolveError.message,
      });
    }
  }
  // Manifest: hash the ORIGINAL on-disk RAW BYTES (pre-apply) per target.
  // Audit round-3 P2: manifest stores raw-bytes SHA256, not decoded-text
  // SHA256, so BOM toggles by a concurrent writer are caught as drift.
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
      // The read error was already recorded in failures.
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    verificationManifest,
  };
}

module.exports = {
  applyPatchSet,
  normalizePatchSet,
  preflightPatchSet,
  resolveReplacementIndex,
  rollbackAppliedPatchSet,
  validatePatchSetAgainstContent,
};
