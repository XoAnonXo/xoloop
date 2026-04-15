'use strict';

/**
 * audit_caller_opus.cjs — Anthropic Opus wrapper for the fix phase.
 *
 * Given a list of audit findings + the relevant code excerpts, asks Opus
 * to return a JSON changeSet of SEARCH/REPLACE patches that fixes all
 * findings without breaking validation.
 *
 * Tests inject options.callerOverride to bypass the real Anthropic API.
 */

const fs = require('node:fs');
const path = require('node:path');
const { AdapterError } = require('./errors.cjs');
const { extractJsonObjectFromText, resolveRepoPath } = require('./baton_common.cjs');

const DEFAULT_OPUS_MODEL = 'claude-opus-4-20250514';
const DEFAULT_TIMEOUT_MS = 240000;
const FILE_EXCERPT_MAX_LINES = 200;

/**
 * Round-11 P1: optional `repoRoot` enforces symlink-safe containment. When
 * provided, the function realpaths `absolutePath` and returns null if the
 * canonical target escapes `repoRoot` — so a malicious in-repo symlink like
 * `audit_runner.cjs -> ../../../../secret.txt` cannot leak the external
 * file's content through the excerpt. Omitting repoRoot preserves the
 * pre-round-11 behavior (direct callers that manage containment themselves).
 * buildFileExcerpts is the primary vuln path and always passes the root as
 * defense-in-depth on top of its own canonicalization.
 */
function readFileExcerpt(absolutePath, maxLines = FILE_EXCERPT_MAX_LINES, repoRoot) {
  let targetPath = absolutePath;
  if (typeof repoRoot === 'string' && repoRoot.length > 0) {
    let canonicalTarget;
    try {
      canonicalTarget = fs.realpathSync(absolutePath);
    } catch (_) {
      return null;
    }
    let canonicalRoot;
    try {
      canonicalRoot = fs.realpathSync(repoRoot);
    } catch (_) {
      canonicalRoot = repoRoot;
    }
    const rel = path.relative(canonicalRoot, canonicalTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return null;
    }
    targetPath = canonicalTarget;
  } else if (!fs.existsSync(absolutePath)) {
    return null;
  }
  const content = fs.readFileSync(targetPath, 'utf8');
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return content;
  }
  return [
    ...lines.slice(0, maxLines),
    `\n... [truncated ${lines.length - maxLines} lines]`,
  ].join('\n');
}

/**
 * Round-11 P2: canonicalize a repo-relative path string — collapse `./`,
 * `sub/../` segments, normalize backslashes to forward slashes, and drop any
 * leading `./`. Required because allowlist entries (typically `lib/foo.cjs`)
 * and finding.file values (codex may emit `./lib/foo.cjs` or `lib/../lib/foo.cjs`)
 * can reference the SAME file via different string shapes. Pure backslash
 * normalization (the pre-round-11 behavior) compared string-literal, so shape
 * mismatches dropped legitimate in-scope findings as "out-of-scope" and
 * stalled the loop.
 *
 * Returns a canonical repo-relative form OR null when the input is empty or
 * escapes the repo root (e.g. `../escape.cjs`). Callers treat null as
 * "not in allowlist".
 *
 * The `path.resolve(sentinel, normalized)` + `path.relative(sentinel, ...)`
 * roundtrip collapses `.`/`..` segments safely. We use a synthetic absolute
 * sentinel root so behavior is consistent across operating systems and does
 * not depend on process.cwd(). This is a PURE STRING operation — no filesystem
 * access, no symlink resolution. Symlink canonicalization is the runner's
 * job (round-11 P1); this helper is for shape-normalization only.
 */
function canonicalizeRepoRelative(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return null;
  }
  const slashNormalized = rawPath.replace(/\\/g, '/');
  // Use a synthetic absolute sentinel so path.resolve always treats
  // relative segments the same regardless of process.cwd().
  const sentinel = path.sep === '\\' ? 'C:\\__canonical_root__' : '/__canonical_root__';
  const resolved = path.resolve(sentinel, slashNormalized);
  const relative = path.relative(sentinel, resolved);
  if (!relative || relative.startsWith('..')) {
    return null;
  }
  if (path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

/**
 * Round-6 P2: normalize `allowedFiles` into a Set (or null when no allowlist
 * was supplied). Shared by buildFileExcerpts AND the round-6 findings filter
 * below, so both use IDENTICAL normalization.
 *
 * Round-11 P2: entries are canonicalized via canonicalizeRepoRelative so
 * `./lib/foo.cjs`, `lib/foo.cjs`, and `lib/../lib/foo.cjs` all collapse to
 * the same repo-relative key. Same canonicalization is applied to each
 * finding's `file` field below before membership check.
 *
 * empty/undefined input → null = no allowlist (pass-through; preserves
 * backward compat for audit-only callers).
 *
 * Round-12 P2 #2: optional `cwd` parameter. When provided, each allowlist
 * entry is also realpath'd against the canonical cwd — any entry whose
 * canonical form escapes the canonical cwd (a symlink escape) is DROPPED
 * from the returned set. Without this, the fixer-side allowlist diverged
 * from the runner-side: a symlinked `target.files` entry that the runner
 * would reject (because realpath escapes repo) was still treated as
 * in-scope here, so Opus would see a finding whose patch the runner later
 * rejects with `path-scope-violation` — stalling the loop under
 * misconfigured allowlists. The filesystem check mirrors
 * checkChangeSetPathScope in audit_runner.cjs.
 *
 * When `cwd` is undefined, the filesystem check is skipped (audit-only test
 * mode without filesystem context) — preserves pure-string backward compat.
 *
 * Round-13 P2 #1: the pre-round-13 filesystem check resolved against the RAW
 * entry string, not the canonicalized repo-relative form. Two failure modes:
 *   (a) On POSIX a backslash-containing entry (`lib\\foo.cjs`) went to
 *       `path.resolve(root, 'lib\\foo.cjs')` → a literal-backslash filename
 *       that does not exist → ENOENT → entry kept by the pre-round-13
 *       "new-file" fast-path even though the real file `lib/foo.cjs` was
 *       inside the repo all along (no realpath check ever ran).
 *   (b) The ENOENT branch trusted "doesn't exist" as "new file, allow" but
 *       never walked UP to verify the deepest EXISTING ancestor was in-repo.
 *       A new file whose intermediate directory is a symlink escaping the
 *       repo could pass the fixer gate yet be rejected by the runner,
 *       re-introducing the same allowlist/runner divergence round-12 tried
 *       to close.
 * Round-13 fix:
 *   (a) Resolve the canonical repo-relative form (forward slashes, `./`
 *       collapsed) under canonicalRoot — the same shape the runner sees.
 *   (b) On ENOENT walk UP the path until an existing ancestor is found,
 *       realpath THAT ancestor, and verify it still lives under canonicalRoot.
 *       Reject if the walk escapes.
 */
function buildAllowedFileSet(allowedFiles, cwd) {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    return null;
  }
  const set = new Set();
  let canonicalRoot = null;
  const haveCwd = typeof cwd === 'string' && cwd.length > 0;
  if (haveCwd) {
    try {
      canonicalRoot = fs.realpathSync(cwd);
    } catch (_) {
      // Caller supplied a cwd that doesn't exist. Skip the filesystem gate
      // and fall back to pure-string behavior — there is no symlink sink to
      // escape when the root itself has no filesystem presence.
      canonicalRoot = null;
    }
  }
  for (const entry of allowedFiles) {
    const canonical = canonicalizeRepoRelative(entry);
    if (canonical === null) {
      continue;
    }
    if (canonicalRoot !== null) {
      // Round-13 P2 #1 (a): resolve the CANONICAL repo-relative form (forward
      // slashes, `./` collapsed), not the raw entry string. Without this, a
      // POSIX backslash entry like `lib\\foo.cjs` was fed as a literal-
      // backslash filename to path.resolve → ENOENT → bypassed the realpath
      // check entirely. Using `canonical` keeps the fixer gate in shape-lock
      // with the runner-side canonical gate.
      const candidateAbsolute = path.resolve(canonicalRoot, canonical);
      let realTarget;
      try {
        realTarget = fs.realpathSync(candidateAbsolute);
      } catch (_) {
        // Entry does not exist on disk yet — could be a legitimate new-file
        // target (write_file kind). Round-13 P2 #1 (b): walk UP the path
        // until we find an existing ancestor, realpath THAT, and verify it
        // still lives under canonicalRoot. Without this walk, a new file
        // under a symlinked directory that escapes the repo would pass the
        // fixer gate but be rejected by the runner — the exact divergence
        // round-12 tried to close.
        let ancestor = path.dirname(candidateAbsolute);
        let ancestorReal = null;
        while (true) {
          try {
            ancestorReal = fs.realpathSync(ancestor);
            break;
          } catch (_inner) {
            const parent = path.dirname(ancestor);
            if (parent === ancestor) {
              // Reached filesystem root without finding any existing
              // ancestor — extremely unlikely since canonicalRoot itself
              // exists. Drop defensively.
              ancestorReal = null;
              break;
            }
            ancestor = parent;
          }
        }
        if (ancestorReal === null) {
          continue;
        }
        const ancestorRel = path.relative(canonicalRoot, ancestorReal);
        // ancestorRel === '' is fine: canonicalRoot itself is the deepest
        // existing ancestor (e.g. the whole `nonexistent/new_file.cjs`
        // branch doesn't exist yet), which is trivially in-repo.
        if (ancestorRel.startsWith('..') || path.isAbsolute(ancestorRel)) {
          continue;
        }
        set.add(canonical);
        continue;
      }
      const rel = path.relative(canonicalRoot, realTarget);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }
    }
    set.add(canonical);
  }
  return set;
}

/**
 * Round-6 P2: the full `findings` array is passed to buildFixerUserPrompt as
 * metadata — issue text, fixHint, file path. Round 5 gated EXCERPTS on the
 * allowlist, but an out-of-scope finding (e.g. file: "lib/model_router.cjs"
 * when target.files = ['lib/audit_runner.cjs']) still reached Opus through
 * the prompt metadata. Opus may then emit a changeSet for the out-of-scope
 * path; the runner rejects it with path-scope-violation and NO in-scope fix
 * lands — a prompt-injection denial-of-service.
 *
 * Round-7 P2: the round-6 fix preserved file-less findings as "narrative-only,"
 * but the codex parser degrades any malformed [P1] block that does not match
 * <file>:<line> to { file: null, issue: <raw prose> }. That file-less finding
 * then passed the allowlist and the raw prose reached Opus — which could be
 * told in narrative form to edit an out-of-scope file. The runner then rejects
 * the resulting changeSet with path-scope-violation and the loop stalls
 * (prompt-injection DoS). Close the remaining gap: when the allowlist is
 * non-empty (apply mode), a finding MUST have a normalized `file` string that
 * is in the allowlist. File-less findings are dropped entirely.
 *
 * Backward-compat contract is unchanged: undefined/null/[] allowedFiles =
 * pass-through unchanged, so audit-only callers still see every finding
 * including file-less narrative entries.
 */
function filterFindingsByAllowlist(findings, allowedFiles, cwd) {
  const iter = Array.isArray(findings) ? findings : [];
  // Round-12 P2 #2: propagate cwd so the allowlist-side realpath check runs
  // and symlinked allowlist entries that escape the repo are dropped before
  // any finding is kept. callFixerWithOpus passes target.cwd so the fixer-
  // side allowlist matches the runner-side canonical gate.
  const allowedSet = buildAllowedFileSet(allowedFiles, cwd);
  if (allowedSet === null) {
    return iter.slice();
  }
  const kept = [];
  for (const finding of iter) {
    if (!finding || typeof finding !== 'object') {
      continue;
    }
    const file = finding.file;
    // Round-7 P2: reject file-less findings in apply mode. Narrative-only
    // findings with no `file` would otherwise pass the allowlist check and
    // let prompt-injected prose redirect Opus at an out-of-scope path.
    if (typeof file !== 'string' || file.length === 0) {
      continue;
    }
    // Round-11 P2: canonicalize the finding's file path before comparison so
    // legit findings like `./lib/foo.cjs` (codex frequently emits the `./`
    // prefix) match allowlist entries like `lib/foo.cjs`. Pre-round-11 the
    // comparator was pure backslash normalization, which dropped these as
    // out-of-scope and stalled the loop. `sub/../lib/foo.cjs` collapses to
    // `lib/foo.cjs` too.
    const canonical = canonicalizeRepoRelative(file);
    if (canonical !== null && allowedSet.has(canonical)) {
      kept.push(finding);
    }
  }
  return kept;
}

function buildFileExcerpts(findings, cwd, allowedFiles) {
  const seen = new Set();
  const excerpts = [];
  const iter = Array.isArray(findings) ? findings : [];
  const safeCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
  // Round-5 P1: layered defense. Even though resolveRepoPath blocks OUT-OF-repo
  // escapes, any IN-repo file a codex finding names will still be read and
  // embedded in the fixer prompt. A prompt-injected finding with
  // file: "lib/model_router.cjs" would leak that file's contents to Opus even
  // when the audit target was only ['audit_runner.cjs']. When the caller
  // supplies a non-empty allowlist, skip any finding whose normalized file is
  // not in it. undefined/null/[] = behave as before (resolveRepoPath is the
  // only gate — preserves backward compat for audit-only callers).
  //
  // Round-12 P2 #2: pass safeCwd so buildAllowedFileSet realpath-checks each
  // allowlist entry and drops any whose canonical form escapes the repo.
  // Keeps the fixer-side allowlist in lockstep with the runner-side gate.
  const allowedSet = buildAllowedFileSet(allowedFiles, safeCwd);
  // Round-11 P1: realpath the repo root up-front so the post-resolve escape
  // check below compares against the symlink-resolved root, not the lexical
  // one. safeCwd may be a symlink (e.g. on macOS where /tmp -> /private/tmp);
  // realpath once so every file check sees the canonical root.
  let canonicalRoot = null;
  try {
    canonicalRoot = fs.realpathSync(safeCwd);
  } catch (_) {
    // Root does not exist or is inaccessible; defense-in-depth check below
    // degrades to the lexical containment already enforced by resolveRepoPath.
  }
  for (const finding of iter) {
    const file = finding && finding.file;
    if (!file) {
      continue;
    }
    // Round-13 P2 #2: the SAME canonical form must drive the allowlist match,
    // the seen-Set dedup key, the resolveRepoPath call, and the file read.
    // Pre-round-13 the allowlist check canonicalized but resolveRepoPath got
    // the RAW string back — so finding.file='proving-ground\\lib\\foo.cjs'
    // on POSIX passed the allowlist (after normalization) but resolveRepoPath
    // received the raw-backslash form, failed to locate the file, and Opus
    // received a finding with an empty excerpt → blind patch. Canonicalize
    // ONCE and drive every downstream consumer from the canonical form.
    const canonical = canonicalizeRepoRelative(typeof file === 'string' ? file : '');
    if (canonical === null) {
      // Canonicalization rejected the path (empty or escapes via leading
      // `..`). Skip — nothing safe to embed.
      continue;
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    if (allowedSet !== null && !allowedSet.has(canonical)) {
      continue;
    }
    // Enforce repo containment: codex-supplied `file` may be "../../etc/passwd"
    // or absolute; resolveRepoPath rejects anything that escapes safeCwd. We
    // skip offenders rather than throw — the audit loop must keep running.
    // Round-13 P2 #2: pass the canonical repo-relative form so raw-backslash
    // variants resolve correctly on POSIX; otherwise the excerpt load fails
    // silently and Opus patches blind.
    let absolute;
    try {
      absolute = resolveRepoPath(safeCwd, canonical).absolutePath;
    } catch (_) {
      continue;
    }
    // Round-11 P1: resolveRepoPath is lexical — it blocks `../../etc/passwd`
    // style escapes but treats an in-repo symlink as a valid in-repo entry.
    // If `absolute` is itself a symlink to an external file (e.g.
    // audit_runner.cjs -> ../../../../secret.txt), fs.readFileSync on
    // `absolute` follows the symlink and embeds the external content in the
    // Opus prompt. Canonicalize via fs.realpathSync and verify the realpath
    // still lives under the canonical repo root. If it escapes, skip the
    // excerpt — defense-in-depth for the allowlist + resolveRepoPath gates.
    let canonicalAbsolute = null;
    try {
      canonicalAbsolute = fs.realpathSync(absolute);
    } catch (_) {
      // File does not exist (codex hallucinated a path or the repo was
      // edited between audit and fix). Skip — nothing to embed.
      continue;
    }
    if (canonicalRoot !== null) {
      const rel = path.relative(canonicalRoot, canonicalAbsolute);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }
    }
    // Round-11 P1: pass safeCwd as repoRoot for defense-in-depth — even if
    // canonicalAbsolute somehow slipped past the checks above, readFileExcerpt
    // will re-verify symlink containment and return null on escape.
    const excerpt = readFileExcerpt(canonicalAbsolute, FILE_EXCERPT_MAX_LINES, safeCwd);
    if (excerpt !== null) {
      excerpts.push({ file, excerpt });
    }
  }
  return excerpts;
}

function buildFixerSystemPrompt() {
  return [
    'You are the Fixer on a code-audit pipeline.',
    'Codex flagged the listed findings. Your job is to produce a JSON changeSet of SEARCH/REPLACE patches that closes every finding.',
    'Constraints:',
    '  1. Each patch must be byte-exact: the search string must appear in the current file content as supplied.',
    '  2. Do not change unrelated code.',
    '  3. Add regression tests when the finding is testable; otherwise harden the runtime guard.',
    '  4. Return JSON only — no preamble, no compliments.',
    'JSON shape:',
    '{',
    '  "changeSet": [',
    '    { "kind": "replace_once", "path": "lib/foo.cjs", "match": "<exact current text>", "replace": "<new text>" }',
    '  ],',
    '  "rationale": "<one short paragraph mapping each patch back to a finding>"',
    '}',
  ].join('\n');
}

function safeJsonStringify(value, indent) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    if (typeof val === 'function') return '[Function]';
    return val;
  }, indent);
}

function buildFixerUserPrompt(findings, excerpts) {
  return safeJsonStringify({
    findings: Array.isArray(findings) ? findings : [],
    files: Array.isArray(excerpts) ? excerpts : [],
    instruction: 'Return JSON {changeSet, rationale} that fixes every finding without touching unrelated code.',
  }, 2);
}

function parseFixerResponse(text) {
  const json = JSON.parse(extractJsonObjectFromText(text, 'fixer response'));
  if (!Array.isArray(json.changeSet)) {
    throw new AdapterError(
      'OPUS_FIXER_BAD_SHAPE',
      'changeSet',
      'Fixer response must contain a changeSet array',
      { fixHint: 'Return JSON with changeSet as an array of {kind, path, match, replace} objects.' },
    );
  }
  return {
    changeSet: json.changeSet,
    rationale: typeof json.rationale === 'string' ? json.rationale : '',
  };
}

async function callFixerWithOpus(input = {}) {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  if (findings.length === 0) {
    return { changeSet: [], rationale: 'no findings supplied; nothing to fix', rawOutput: '' };
  }
  const target = input.target;
  if (!target || typeof target !== 'object') {
    throw new AdapterError(
      'OPUS_FIXER_TARGET_REQUIRED',
      'target',
      'callFixerWithOpus requires a target object',
      { fixHint: 'Pass input.target = { cwd } so file excerpts can be loaded.' },
    );
  }
  // Round-15 P2: scope-filter BEFORE the callerOverride branch so test
  // harnesses see the same findings the real Opus call would see — and more
  // importantly, so the allFiltered short-circuit applies regardless of
  // whether we route to real Opus or a test override. Without filtering
  // here, a test using callerOverride would bypass the "all out-of-scope"
  // semantic and get whatever the override chose to return, masking
  // prompt-injection behavior in production code paths. When allowlist is
  // undefined/empty, filterFindingsByAllowlist is a pass-through — so this
  // is semantics-preserving for backward-compat callers that never supply
  // target.files.
  //
  // Round-6 P2 context: strips prompt-injected out-of-scope findings BEFORE
  // they reach Opus. Round-5 filtered excerpts; round-6 extends the same
  // allowlist to the findings metadata itself (issue text, fixHint, file).
  // Without this, Opus sees an out-of-scope `file: "lib/model_router.cjs"`
  // finding, emits a changeSet for that path, and the runner rejects the
  // whole set with path-scope-violation — blocking any in-scope fix.
  //
  // Round-12 P2 #2: pass cwd so the allowlist realpath-check matches the
  // runner-side canonical gate in checkChangeSetPathScope. Without cwd, a
  // symlinked target.files entry that the runner would later reject would
  // still be treated as in-scope here, letting a doomed finding reach Opus.
  const cwd = target.cwd || process.cwd();
  const scopedFindings = filterFindingsByAllowlist(findings, target.files, cwd);
  // Round-15 P2: if the caller supplied findings but allowlist filtering
  // dropped every one of them (all out-of-scope), we have nothing legitimate
  // to fix. Without this short-circuit, callModel (or the override) still got
  // called with an empty scopedFindings array — and Opus could hallucinate a
  // changeSet (which the runner might then accept if the path scope check
  // passes for whatever Opus picked), OR return an empty no-op that the
  // runner misreads as "no-fix-proposed." Neither is correct — the actual
  // semantic is "every finding was out-of-scope; do nothing." Return an
  // explicit allFiltered signal so the caller can distinguish "nothing to
  // fix in scope" from "fixer failed to produce a patch." The empty-input
  // case (findings.length === 0) is handled by the early return at the top
  // of this function and keeps its existing rationale.
  if (scopedFindings.length === 0 && findings.length > 0) {
    return {
      changeSet: [],
      rationale: 'all findings out-of-scope after allowlist filter; no-op',
      rawOutput: '',
      allFiltered: true,
    };
  }
  if (typeof input.callerOverride === 'function') {
    const result = await input.callerOverride({ findings: scopedFindings, target });
    return {
      changeSet: Array.isArray(result.changeSet) ? result.changeSet : [],
      rationale: result.rationale || '',
      rawOutput: result.rawOutput || '',
    };
  }
  // Round-5 P1: pass target.files as the allowlist so a prompt-injected
  // finding whose `file` names an in-repo path outside the audit surface
  // cannot leak that file's contents through the fixer prompt.
  const excerpts = buildFileExcerpts(scopedFindings, cwd, target.files);
  const systemPrompt = buildFixerSystemPrompt();
  const userPrompt = buildFixerUserPrompt(scopedFindings, excerpts);

  // Lazy require to avoid forcing model_router into the module graph at load time.
  const { callModel } = require('./model_router.cjs');
  const response = await callModel({
    provider: 'anthropic',
    model: input.model || DEFAULT_OPUS_MODEL,
    systemPrompt,
    userPrompt,
    timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS,
    temperature: 0,
    schema: { type: 'json_object' },
    mode: 'proposal',
  });
  const parsed = parseFixerResponse(response.text);
  return {
    changeSet: parsed.changeSet,
    rationale: parsed.rationale,
    rawOutput: response.text,
  };
}

module.exports = {
  DEFAULT_OPUS_MODEL,
  buildFileExcerpts,
  buildFixerSystemPrompt,
  buildFixerUserPrompt,
  callFixerWithOpus,
  filterFindingsByAllowlist,
  parseFixerResponse,
  readFileExcerpt,
};
