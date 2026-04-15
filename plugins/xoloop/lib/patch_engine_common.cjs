/**
 * Shared helpers for the three patch engines (overnight_patch_engine,
 * change_set_engine, operation_ir). Centralized here to keep the fixes for
 * audit round-1 findings consistent across engines:
 *
 *   Group A — resolveAndValidateTargetPath wiring (realpath canonicalization
 *             + optional caller-supplied allowlist)
 *   Group B — atomic multi-file apply (temp-file staging + rename + snapshot-
 *             based rollback with per-file rollback-error capture)
 *   Group C — single-stride overlapping-match counter
 *            + BOM/binary detection at read time
 *   Group D — structured error.context for closest-match text (no leaking
 *             raw file excerpts into error.message so repair prompts can
 *             QUOTE/ENCODE as inert data)
 *            + verificationManifest (SHA256) bridge between preflight and apply
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { AdapterError } = require('./errors.cjs');

// ── BOM / binary detection ───────────────────────────────────────────
//
// Read file as Buffer, reject UTF-16 (any BOM) and any file containing a
// NUL byte (binary). Return a decoded utf8 string. This MUST run at the
// entry point of every engine before any indexOf/slice work happens.

function readTextOrReject(absolutePath, rawPath) {
  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch (readError) {
    // Callers decide how to surface ENOENT; rethrow so their wrapping
    // AdapterError stays specific.
    throw readError;
  }

  // UTF-16 LE: 0xFF 0xFE
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    throw new AdapterError(
      'PATCH_NON_UTF8_TARGET',
      'path',
      `Target file is UTF-16 LE; utf8 round-trip would corrupt it: ${rawPath}`,
      { fixHint: 'The patch engine only supports utf8 text files. Convert the target to utf8 before patching, or exclude it from the patch set.' }
    );
  }
  // UTF-16 BE: 0xFE 0xFF
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    throw new AdapterError(
      'PATCH_NON_UTF8_TARGET',
      'path',
      `Target file is UTF-16 BE; utf8 round-trip would corrupt it: ${rawPath}`,
      { fixHint: 'The patch engine only supports utf8 text files. Convert the target to utf8 before patching, or exclude it from the patch set.' }
    );
  }
  // Strip UTF-8 BOM (0xEF 0xBB 0xBF). We preserve it by remembering it
  // existed and emitting it back when we write. But for the in-memory
  // SEARCH/REPLACE work we strip it so the first-character offsets don't
  // include the BOM bytes.
  let hasUtf8Bom = false;
  let working = buffer;
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    hasUtf8Bom = true;
    working = buffer.slice(3);
  }

  // Any NUL byte in the remaining buffer is a binary signal. Even if it's
  // deep inside the file, utf8 round-trip will corrupt surrounding bytes.
  if (working.includes(0x00)) {
    throw new AdapterError(
      'PATCH_NON_UTF8_TARGET',
      'path',
      `Target file contains a null byte; refusing utf8 round-trip: ${rawPath}`,
      { fixHint: 'The patch engine only supports utf8 text files without embedded NULs. Use a binary-aware tool for this file.' }
    );
  }

  // Audit round-2 P1#1: Buffer.toString('utf8') silently replaces invalid UTF-8
  // bytes with U+FFFD, so a file with malformed UTF-8 (no BOM, no NUL) would
  // decode to garbage and get written back as different bytes. Use a fatal
  // TextDecoder so malformed input throws instead of being silently repaired.
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(working);
  } catch (decodeError) {
    throw new AdapterError(
      'PATCH_NON_UTF8_TARGET',
      'path',
      `Target file is not valid UTF-8; refusing utf8 round-trip: ${rawPath}`,
      {
        fixHint: 'The patch engine only supports utf8 text files. Convert the target to valid utf8 before patching, or exclude it from the patch set.',
        cause: decodeError,
      }
    );
  }
  // Audit round-3 P2: manifest must hash the RAW BYTES (pre-BOM-strip,
  // pre-decode) so a concurrent process that adds or removes the UTF-8 BOM
  // between preflight and apply shows up as drift. Previously the manifest
  // hashed the decoded text, which is identical across a BOM toggle — the
  // drift check let the write through and silently flipped BOM state.
  const rawBytesSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { text, hasUtf8Bom, rawBytesSha256 };
}

/**
 * Count the unique starting positions a `needle` substring could begin at
 * inside `haystack`. Advances by ONE character per scan step so overlapping
 * matches (e.g., "aaa" inside "aaaaa" starts at positions 0, 1, 2) are all
 * counted — required for ambiguity detection.
 *
 * This is NOT the function used to decide WHERE to apply a replacement —
 * that still uses indexOf which advances by needle.length. This is ONLY for
 * uniqueness-counting.
 */
function countOccurrencesStride1(haystack, needle) {
  if (typeof haystack !== 'string') {
    throw new AdapterError(
      'PATCH_CONTENT_INVALID',
      'content',
      'countOccurrencesStride1 expected a string haystack',
      { fixHint: 'Internal error: file content must be a string before scanning.' }
    );
  }
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

// ── Snapshot + atomic apply infrastructure ───────────────────────────
//
// A "snapshot" captures the pre-write state of every canonicalAbsolute path
// touched by a patch set so apply() can roll back fully if any write fails.
// Structure: { path (repo-relative), canonicalAbsolute, beforeContent|null,
//              existedBefore: boolean }.

function buildTempPath(canonicalAbsolute) {
  const dir = path.dirname(canonicalAbsolute);
  const basename = path.basename(canonicalAbsolute);
  // Deterministic-enough temp suffix. process.hrtime.bigint() returns a
  // ns-resolution monotonic clock so concurrent engine instances inside the
  // same pid still get distinct names.
  const suffix = `${process.pid}.${process.hrtime.bigint()}`;
  return path.join(dir, `.${basename}.${suffix}.tmp`);
}

function writeTempThenRename(canonicalAbsolute, content, hasUtf8Bom) {
  const tempPath = buildTempPath(canonicalAbsolute);
  let payload;
  if (hasUtf8Bom) {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    payload = Buffer.concat([bom, Buffer.from(content, 'utf8')]);
  } else {
    payload = Buffer.from(content, 'utf8');
  }
  fs.writeFileSync(tempPath, payload);
  // Audit round-3 P1: fs.writeFileSync creates the temp file with default
  // (umask-controlled, typically 0o644) permissions. renameSync then
  // overwrites the target path with that mode, stripping +x on executable
  // git hooks, build scripts, CLI binaries — AND on rollback restores, so
  // a failure-then-rollback cycle would still lose the executable bit.
  // Fix: before renameSync, stat the target and chmod the temp file to the
  // target's pre-existing mode. If the target doesn't exist (create_file),
  // the default mode is fine.
  try {
    const st = fs.statSync(canonicalAbsolute);
    fs.chmodSync(tempPath, st.mode);
  } catch (_ignored) { /* file didn't exist; default mode is fine */ }
  try {
    fs.renameSync(tempPath, canonicalAbsolute);
  } catch (renameError) {
    // Clean up temp file if rename failed so we don't leave litter.
    try { fs.unlinkSync(tempPath); } catch (_ignoredUnlink) { /* best-effort */ }
    throw renameError;
  }
}

/**
 * Roll back a set of already-applied file changes. Walks `snapshot` in
 * reverse so the most recently written file is restored first. Captures
 * per-file rollback errors in `rollbackErrors` without stopping the walk —
 * callers get a best-effort recovery with an explicit list of what
 * couldn't be undone.
 */
function rollbackFromSnapshot(snapshot) {
  const rollbackErrors = [];
  const entries = Array.isArray(snapshot) ? snapshot : [];
  // Iterate in reverse — last write rolled back first.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || !entry.applied) continue;
    try {
      if (!entry.existedBefore) {
        // Created by this operation set: unlink.
        try {
          fs.unlinkSync(entry.canonicalAbsolute);
        } catch (unlinkError) {
          if (!unlinkError || unlinkError.code !== 'ENOENT') {
            rollbackErrors.push({
              path: entry.path || entry.canonicalAbsolute,
              action: 'unlink',
              error: unlinkError && unlinkError.message ? unlinkError.message : String(unlinkError),
            });
          }
        }
      } else if (typeof entry.beforeContent === 'string') {
        // Pre-existing: restore bytes via temp+rename so the restore itself
        // is atomic. If it fails we capture and continue.
        writeTempThenRename(entry.canonicalAbsolute, entry.beforeContent, !!entry.hasUtf8Bom);
      }
    } catch (restoreError) {
      rollbackErrors.push({
        path: entry.path || entry.canonicalAbsolute,
        action: entry.existedBefore ? 'restore' : 'unlink',
        error: restoreError && restoreError.message ? restoreError.message : String(restoreError),
      });
    }
  }
  return rollbackErrors;
}

/**
 * SHA256 helper (hex) over UTF-8 bytes of the supplied text. Kept as a small
 * utility for ad-hoc digests; it is NOT what the verificationManifest uses.
 * Preflight and apply-time drift detection read raw file bytes and hash them
 * via readTextOrReject()'s rawBytesSha256 so that BOM add/remove is detected.
 * See docs/KNOWN_LIMITATIONS.md for the residual TOCTOU window between the
 * re-hash and the renameSync.
 */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

module.exports = {
  buildTempPath,
  countOccurrencesStride1,
  readTextOrReject,
  rollbackFromSnapshot,
  sha256Hex,
  writeTempThenRename,
};
