'use strict';

/**
 * audit_runner.cjs — Audit ↔ Fix loop orchestrator.
 *
 * Each round:
 *   1. callAuditor({ target, history }) → { findings, rawOutput, tokensUsed }
 *      Findings shape: [{ severity: 'P1'|'P2'|'P3'|'low', file, line?, issue, fixHint }]
 *   2. Filter to blocking findings (severity ≤ severityFloor)
 *   3. If none → converged
 *   4. Otherwise callFixer({ findings, target, history }) → { changeSet, rawOutput, tokensUsed }
 *   5. Apply changeSet, run validation
 *   6. Roll back on failure, otherwise loop
 *
 * Both callers are dependency-injected so tests run without LLM calls.
 *
 * Production callers live in:
 *   - audit_caller_codex.cjs (auditor)
 *   - audit_caller_opus.cjs  (fixer)
 */

const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');

const SEVERITY_RANK = Object.freeze({
  P1: 1,
  P2: 2,
  P3: 3,
  low: 4,
  info: 5,
});

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_SEVERITY_FLOOR = 'P2';

function severityRank(severity) {
  const key = String(severity || 'info').trim();
  if (Object.prototype.hasOwnProperty.call(SEVERITY_RANK, key)) {
    return SEVERITY_RANK[key];
  }
  return SEVERITY_RANK.info;
}

/**
 * Mirrors the shape of enforceProposalPathScope in autoresearch_loop.cjs:
 * normalize backslashes to forward slashes, build an allowed Set from the
 * target's files, and reject any changeSet entry whose path falls outside.
 *
 * Returns { allowed: true, violations: [] } when the change set is empty
 * OR the allowlist is empty (no scope to enforce). Otherwise returns
 * { allowed: false, violations: [<offending paths>] }.
 *
 * The audit-loop wiring is stricter than the autoresearch wiring: a
 * violation must NOT throw — the caller has to record it in history and
 * skip applyChangeSet, since a prompt-injected finding could otherwise
 * make Opus return a path that escapes the audit surface.
 */
/**
 * Runner-level manual rollback helper (round-9 P2): restore each snapshot
 * entry to its pre-apply state. For entries that existed before apply, write
 * the captured content back. For entries that did not exist before, delete
 * whatever was created during apply. Never throws — per-path errors are
 * concatenated into the returned message so the caller can surface them on
 * the history entry for operators to clean up manually.
 *
 * Called from three places:
 *   1. apply-throw branch when no rollback handle is available
 *   2. validation-failed branch when no rollback handle is available
 *   3. validation-threw branch when no rollback handle is available
 *
 * Returns:
 *   { used: false, error: null } when snapshot is empty (no work to do)
 *   { used: true, error: null }  when every entry was restored successfully
 *   { used: true, error: "<msg>" } when one or more entries failed
 */
function runManualRollback(snapshot) {
  const entries = Array.isArray(snapshot) ? snapshot : [];
  if (entries.length === 0) {
    return { used: false, error: null };
  }
  let error = null;
  for (const snap of entries) {
    if (!snap || typeof snap.absolute !== 'string') {
      continue;
    }
    try {
      if (snap.existed) {
        fs.writeFileSync(snap.absolute, snap.before, 'utf8');
      } else {
        try {
          fs.unlinkSync(snap.absolute);
        } catch (_) {
          // File was never created (or already removed); nothing to undo.
        }
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const pathLabel = typeof snap.path === 'string' ? snap.path : snap.absolute;
      error = error
        ? `${error}; ${pathLabel}: ${message}`
        : `${pathLabel}: ${message}`;
    }
  }
  return { used: true, error };
}

/**
 * Round-11 P1: canonicalize a relative/absolute input path into its realpath
 * form, walking up to the deepest existing ancestor so newly-created files
 * (whose final path does not yet exist) still get a symlink-resolved parent.
 *
 * Returns a canonical ABSOLUTE path with symlinks resolved on every existing
 * segment. Pure lexical `path.resolve` is not enough: an entry like
 * `link.cjs` where link.cjs is a symlink to /etc/passwd would otherwise pass
 * the lexical containment check while the later snapshot/rollback I/O
 * follows the symlink and mutates the external file.
 *
 * `fs.realpathSync` throws ENOENT for paths that do not yet exist — normal
 * for changeSet entries that create a new file. In that case we realpath the
 * deepest existing ancestor (at minimum the cwd or root) and append the
 * remaining tail lexically. Attackers cannot swap that tail for a symlink
 * without the directory segment existing first, which would itself be
 * canonicalized.
 *
 * Falls back to pure lexical resolution when realpath throws for reasons
 * other than ENOENT (e.g., a bogus cwd used by pure-unit tests such as
 * `/tmp/repo`). The trade-off: attack scenarios require a real cwd with
 * real symlinks; a nonexistent cwd has nothing to canonicalize against and
 * the lexical form is the best we can do.
 */
function canonicalizeAbsolute(cwd, inputPath) {
  // Round-11 P1: normalize backslashes to forward slashes BEFORE the resolve
  // so Windows-style paths emitted by codex/opus compare equal to POSIX
  // allowlist entries on macOS/Linux. path.resolve on POSIX treats '\\' as a
  // literal character, so `path.resolve('/tmp/repo', 'lib\\foo.cjs')` yields
  // `/tmp/repo/lib\\foo.cjs` — which then never matches an allowlist entry
  // of `lib/foo.cjs`. Pre-round-11 the scope check did this normalization
  // explicitly via rawPath.replace(/\\/g, '/'); round-11 must preserve it.
  const slashNormalized = typeof inputPath === 'string'
    ? inputPath.replace(/\\/g, '/')
    : inputPath;
  const absolute = path.isAbsolute(slashNormalized)
    ? path.normalize(slashNormalized)
    : path.resolve(cwd, slashNormalized);
  try {
    return fs.realpathSync(absolute);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return absolute;
    }
  }
  // Walk up until we find an existing ancestor we can realpath.
  let current = absolute;
  const segments = [];
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
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return absolute;
      }
    }
  }
}

function canonicalizeRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return null;
  }
  // Use the same walk-up helper as canonicalizeAbsolute so the root and the
  // per-entry paths share one canonicalization discipline. A synthetic cwd
  // like '/tmp/repo' that doesn't yet exist becomes '/private/tmp/repo' on
  // macOS because /tmp is the deepest existing ancestor and resolves to
  // /private/tmp. Using the SAME transform on both sides keeps
  // isInsideRoot(canonicalAbsolute(root, 'lib/foo.cjs'), canonicalRoot)
  // correct for missing-cwd test scenarios that predate round-11.
  return canonicalizeAbsolute(process.cwd(), cwd);
}

function isInsideRoot(candidateAbsolute, canonicalRoot) {
  if (typeof canonicalRoot !== 'string' || canonicalRoot.length === 0) {
    return true;
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

function buildCanonicalAllowlist(allowedFiles, cwd) {
  const canonicalRoot = canonicalizeRoot(cwd);
  const lexicalSet = new Set();
  const canonicalSet = new Set();
  for (const entry of (Array.isArray(allowedFiles) ? allowedFiles : [])) {
    if (typeof entry !== 'string' || entry.length === 0) {
      continue;
    }
    const lexical = entry.replace(/\\/g, '/');
    lexicalSet.add(lexical);
    if (canonicalRoot !== null) {
      const canonicalAbsolute = canonicalizeAbsolute(canonicalRoot, entry);
      // Reject allowlist entries that themselves escape the canonical root —
      // a symlinked allowlist entry is a foot-gun that must fail closed.
      if (!isInsideRoot(canonicalAbsolute, canonicalRoot)) {
        continue;
      }
      canonicalSet.add(canonicalAbsolute);
    }
  }
  return { lexicalSet, canonicalSet, canonicalRoot };
}

/**
 * Round-11 P1: accepts an optional `cwd` so the scope check can resolve
 * symlinks and reject entries whose realpath escapes `cwd`. When cwd is
 * absent or cannot be realpath'd (tests), falls back to pure lexical
 * containment — the pre-round-11 behavior — because an unreal cwd has
 * nothing to canonicalize against.
 */
function checkChangeSetPathScope(changeSet, allowedFiles, cwd) {
  const { lexicalSet, canonicalSet, canonicalRoot } = buildCanonicalAllowlist(allowedFiles, cwd);
  if (lexicalSet.size === 0) {
    return { allowed: true, violations: [], canonicalPaths: new Map(), canonicalRoot: null };
  }
  const entries = Array.isArray(changeSet) ? changeSet : [];
  const violations = [];
  const canonicalPaths = new Map();
  // When we have a canonical root, the canonical form is AUTHORITATIVE: it
  // defeats both symlink escapes and `./`/`sub/..` shape mismatches. Note that
  // canonicalSet may be empty even though lexicalSet is non-empty — that means
  // EVERY allowlist entry itself escaped (e.g. the caller's entire allowlist
  // was symlinks pointing outside the repo). That is a fail-closed condition:
  // every changeSet path must be rejected. We MUST NOT fall back to the
  // lexical set in that case, or an attacker who controls the allowlist via
  // prompt injection could bypass canonicalization entirely.
  const useCanonical = canonicalRoot !== null;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const rawPath = typeof entry.path === 'string' ? entry.path : '';
    if (!rawPath) {
      continue;
    }
    const normalized = rawPath.replace(/\\/g, '/');
    if (useCanonical) {
      const canonicalAbsolute = canonicalizeAbsolute(canonicalRoot, rawPath);
      if (!isInsideRoot(canonicalAbsolute, canonicalRoot)) {
        violations.push(normalized);
        continue;
      }
      if (!canonicalSet.has(canonicalAbsolute)) {
        violations.push(normalized);
        continue;
      }
      canonicalPaths.set(rawPath, canonicalAbsolute);
      continue;
    }
    if (!lexicalSet.has(normalized)) {
      violations.push(normalized);
    }
  }
  return { allowed: violations.length === 0, violations, canonicalPaths, canonicalRoot };
}

function isBlocking(finding, floor) {
  const findingRank = severityRank(finding && finding.severity);
  const floorRank = severityRank(floor);
  return findingRank <= floorRank;
}

function filterBlockingFindings(findings, floor) {
  if (!Array.isArray(findings)) {
    return [];
  }
  return findings.filter((f) => isBlocking(f, floor));
}

function summarizeBySeverity(findings) {
  const counts = { P1: 0, P2: 0, P3: 0, low: 0, info: 0, other: 0 };
  for (const f of (Array.isArray(findings) ? findings : [])) {
    const sev = String(f && f.severity || '').trim();
    if (Object.prototype.hasOwnProperty.call(counts, sev)) {
      counts[sev] += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

async function runAuditFixLoop(options = {}) {
  const target = options.target;
  if (!target || typeof target !== 'object') {
    throw new AdapterError(
      'AUDIT_TARGET_REQUIRED',
      'target',
      'runAuditFixLoop requires a target object describing what to audit',
      { fixHint: 'Pass options.target = { cwd, files: [...], description } at minimum.' },
    );
  }
  const callAuditor = options.callAuditor;
  const callFixer = options.callFixer;
  if (typeof callAuditor !== 'function') {
    throw new AdapterError(
      'AUDIT_CALLER_REQUIRED',
      'callAuditor',
      'runAuditFixLoop requires a callAuditor function',
      { fixHint: 'Inject async callAuditor({ target, history }) returning { findings, rawOutput }.' },
    );
  }
  if (typeof callFixer !== 'function') {
    throw new AdapterError(
      'AUDIT_FIXER_REQUIRED',
      'callFixer',
      'runAuditFixLoop requires a callFixer function',
      { fixHint: 'Inject async callFixer({ findings, target, history }) returning { changeSet, rawOutput }.' },
    );
  }
  const applyChangeSet = typeof options.applyChangeSet === 'function'
    ? options.applyChangeSet
    : null;
  const rollbackChangeSet = typeof options.rollbackChangeSet === 'function'
    ? options.rollbackChangeSet
    : null;
  // Round-6 P2: if a caller wires applyChangeSet but forgets rollbackChangeSet,
  // every partial-write error and validation failure leaves edited files on
  // disk with no recovery path — every other defense-in-depth we've added
  // (round-3 validation-throw rollback, round-4 apply-throw rollback, round-4
  // path-scope check, round-5 empty-allowlist fail-closed) becomes meaningless
  // because there is no way to undo what got written. Audit-only mode (no
  // applyChangeSet) is unaffected.
  if (applyChangeSet && !rollbackChangeSet) {
    throw new AdapterError(
      'AUDIT_ROLLBACK_REQUIRED_FOR_APPLY_MODE',
      'rollbackChangeSet',
      'runAuditFixLoop requires rollbackChangeSet when applyChangeSet is provided',
      { fixHint: 'Inject async rollbackChangeSet(handle) alongside applyChangeSet so the loop can undo partial or validation-failed writes.' },
    );
  }
  // Round-15 P1: when applyChangeSet is wired, target.cwd MUST be a non-empty
  // string that realpaths to an existing directory. Without it,
  // checkChangeSetPathScope degrades to pure lexical string matching and
  // blesses entries like `'../outside.cjs'` — the apply engine then defaults
  // cwd to process.cwd() and writes OUTSIDE the intended audit surface. Every
  // other path-scope defense (canonicalization, symlink realpath, allowlist
  // canonicalRoot binding) already assumed a concrete cwd; this guard makes
  // that assumption explicit at the top of the function where the other
  // mandatory-option throws live. Audit-only flows (no applyChangeSet) are
  // unaffected — they never touch disk so their cwd is optional.
  if (applyChangeSet) {
    if (typeof target.cwd !== 'string' || target.cwd.length === 0) {
      throw new AdapterError(
        'AUDIT_CWD_REQUIRED_FOR_APPLY_MODE',
        'target.cwd',
        'runAuditFixLoop requires target.cwd to be a non-empty string when applyChangeSet is provided',
        { fixHint: 'Pass target.cwd = "<absolute path to the repo root>" so the path-scope check can realpath-canonicalize every changeSet entry against a concrete filesystem root.' },
      );
    }
    try {
      fs.realpathSync(target.cwd);
    } catch (err) {
      throw new AdapterError(
        'AUDIT_CWD_REQUIRED_FOR_APPLY_MODE',
        'target.cwd',
        `runAuditFixLoop requires target.cwd to exist on disk when applyChangeSet is provided: ${err && err.message ? err.message : String(err)}`,
        { fixHint: 'Pass a target.cwd that exists — a nonexistent path cannot be realpath\'d, so the path-scope check would silently degrade to pure lexical matching and let `../outside.cjs` escape the audit surface.' },
      );
    }
  }
  // Round-10 P2: demand a non-empty target.files allowlist BEFORE the fixer
  // runs in apply mode. Previously this check lived inline after the fixer
  // call, so a caller that wired applyChangeSet but forgot target.files would
  // pay for a full Opus fixer invocation (reading excerpts of every finding's
  // file, sending them all to Opus, receiving a changeSet back) only to abort
  // at the allowlist gate. That wastes tokens and — more importantly — leaks
  // excerpts from files we never intended to put in front of the fixer. Fail
  // fast here where the other mandatory-option throws live. Audit-only flows
  // (no applyChangeSet) are unaffected — they still validate findings without
  // touching disk regardless of target.files.
  //
  // Round-14 P2: the original shallow check only blocked `!Array.isArray ||
  // length === 0`. That let through `target.files = [null]`, `[{}]`, `['']`,
  // or `[42]` — non-empty arrays whose entries ALL fail the downstream
  // `typeof entry === 'string' && entry.length > 0` filter inside
  // buildCanonicalAllowlist. The resulting lexicalSet was empty, so
  // checkChangeSetPathScope hit its `lexicalSet.size === 0` early-return and
  // declared every changeSet path `allowed: true`. Net effect: a buggy or
  // adversarial caller passing junk in target.files completely disabled
  // path-scope enforcement. Normalize the array HERE using the same predicate
  // the downstream allowlist uses and fail closed if nothing survives — so
  // the apply-mode gate matches the runtime allowlist exactly.
  if (applyChangeSet && (!Array.isArray(target.files) || target.files.length === 0)) {
    throw new AdapterError(
      'AUDIT_TARGET_FILES_REQUIRED_FOR_APPLY_MODE',
      'target.files',
      'runAuditFixLoop requires a non-empty target.files allowlist when applyChangeSet is provided',
      { fixHint: 'Pass target.files = ["relative/path/one.cjs", ...] so the path-scope check has a meaningful allowlist before any writes occur.' },
    );
  }
  if (applyChangeSet) {
    // Mirror the downstream filter in buildCanonicalAllowlist exactly: drop
    // non-string and empty-string entries, then lexically normalize backslashes
    // so `'lib\\foo.cjs'` collapses to the same shape the allowlist Set stores.
    // Counting SURVIVORS — not raw length — ensures `[null]`, `[{}]`, `['']`,
    // `[42]` all trip this guard. Backward compat: any caller already passing
    // at least one valid string (e.g. `['lib/foo.cjs']`) keeps working.
    const survivingTargetFiles = target.files.filter(
      (entry) => typeof entry === 'string' && entry.length > 0,
    );
    if (survivingTargetFiles.length === 0) {
      throw new AdapterError(
        'AUDIT_TARGET_FILES_REQUIRED_FOR_APPLY_MODE',
        'target.files',
        'runAuditFixLoop requires target.files to contain at least one valid entry after canonicalization when applyChangeSet is provided',
        { fixHint: 'target.files entries must be non-empty strings. Got a non-empty array whose entries all normalize to nothing (e.g. [null], [{}], [""]).' },
      );
    }
    // Round-15 P1: now that target.cwd is guaranteed to be a realpathable
    // directory, validate that every surviving target.files entry canonicalizes
    // INSIDE that cwd. This ensures the apply-mode gate matches what the
    // downstream allowlist enforces: an entry like `'../outside.cjs'` (which
    // buildCanonicalAllowlist would reject via isInsideRoot) is caught here
    // BEFORE any caller runs. If zero entries survive realpath containment,
    // refuse — the allowlist would be empty at runtime and path-scope
    // enforcement would silently degrade.
    const canonicalRoot = canonicalizeRoot(target.cwd);
    const survivingAfterContainment = survivingTargetFiles.filter((entry) => {
      const canonicalAbsolute = canonicalizeAbsolute(canonicalRoot || target.cwd, entry);
      return isInsideRoot(canonicalAbsolute, canonicalRoot);
    });
    if (survivingAfterContainment.length === 0) {
      throw new AdapterError(
        'AUDIT_TARGET_FILES_REQUIRED_FOR_APPLY_MODE',
        'target.files',
        'runAuditFixLoop requires at least one target.files entry to canonicalize inside target.cwd when applyChangeSet is provided',
        { fixHint: 'Every target.files entry canonicalized outside target.cwd (e.g. "../outside.cjs" or an absolute path elsewhere). Pass paths that realpath inside target.cwd so the path-scope check has a meaningful allowlist.' },
      );
    }
  }
  const runValidation = typeof options.runValidation === 'function'
    ? options.runValidation
    : null;

  const maxRounds = Math.max(1, Math.floor(Number(options.maxRounds) || DEFAULT_MAX_ROUNDS));
  const severityFloor = options.severityFloor || DEFAULT_SEVERITY_FLOOR;

  const history = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const audit = await callAuditor({
      target,
      history: history.slice(),
      round,
    });
    const findings = (audit && Array.isArray(audit.findings)) ? audit.findings : [];
    const blocking = filterBlockingFindings(findings, severityFloor);
    const summary = summarizeBySeverity(findings);

    if (blocking.length === 0) {
      history.push({
        round,
        audit,
        fix: null,
        status: 'converged',
        summary,
      });
      return {
        converged: true,
        rounds: round,
        history,
        finalAudit: audit,
        finalSummary: summary,
      };
    }

    const fix = await callFixer({
      findings: blocking,
      target,
      history: history.slice(),
      round,
    });
    const changeSet = (fix && Array.isArray(fix.changeSet)) ? fix.changeSet : [];

    if (changeSet.length === 0) {
      history.push({
        round,
        audit,
        fix,
        status: 'no-fix-proposed',
        summary,
        blockingCount: blocking.length,
      });
      return {
        converged: false,
        rounds: round,
        history,
        reason: 'no-fix-proposed',
        finalAudit: audit,
        finalSummary: summary,
      };
    }

    // Round-10 P2: the round-5 empty-target.files fail-closed lived here, but
    // it ran AFTER the fixer — so apply-mode callers that forgot target.files
    // still paid for a full Opus invocation (and leaked excerpts to it) before
    // the guard tripped. The guard now lives at the top of runAuditFixLoop
    // beside the other mandatory-option throws, so by the time execution
    // reaches this point target.files is guaranteed to be a non-empty array
    // whenever applyChangeSet is wired.

    // Round-11 P2: proposal-only short-circuit. When applyChangeSet is
    // absent AND the fixer returned a non-empty changeSet, we have a
    // proposal but no way to apply it — the caller is running in
    // audit/propose mode and expects to receive the first non-empty
    // changeSet. Prior to this short-circuit the loop would mark the round
    // as status='fixed' and re-audit the (unmutated) files next round,
    // yielding the same blocking findings and the same proposal, eventually
    // burning through maxRounds for no progress. Return immediately with
    // status='proposal-returned' so proposal-only callers get the fix
    // without the loop spinning.
    if (!applyChangeSet) {
      history.push({
        round,
        audit,
        fix,
        status: 'proposal-returned',
        summary,
        blockingCount: blocking.length,
      });
      return {
        converged: false,
        rounds: round,
        history,
        reason: 'proposal-only-mode',
        finalAudit: audit,
        finalSummary: summary,
        fix,
      };
    }

    // Path-scope enforcement (round-4 P1): a prompt-injected finding or
    // malicious code comment can make the fixer return a changeSet.path
    // pointing at .github/workflows/release.yml or auth/session.cjs. Reject
    // any path not in the allowlist derived from target.files BEFORE we
    // touch applyChangeSet — validation alone is not enough because the
    // attacker controls what "validation" gets to see.
    //
    // Round-11 P1: pass target.cwd so the scope check canonicalizes both
    // sides via fs.realpathSync. Without this, a malicious in-repo symlink
    // (entry.path='link.cjs' where link.cjs -> ~/.ssh/config) passes lexical
    // containment but the snapshot + rollback I/O later follows the symlink
    // and mutates the external file.
    const scope = checkChangeSetPathScope(changeSet, target.files, target.cwd);
    if (!scope.allowed) {
      history.push({
        round,
        audit,
        fix,
        status: 'apply-failed',
        summary,
        pathScopeError: `changeSet paths outside target.files allowlist: ${scope.violations.join(', ')}`,
      });
      return {
        converged: false,
        rounds: round,
        history,
        reason: 'path-scope-violation',
        finalAudit: audit,
        finalSummary: summary,
      };
    }

    // Round-8 P2: take a pre-apply snapshot so we can roll back manually when
    // applyChangeSet throws BEFORE it returns a handle AND without attaching
    // one to the error. The bundled change_set_engine writes files
    // sequentially with fs.writeFileSync — if file 3 of 5 fails with ENOSPC,
    // files 1 and 2 are already on disk and no handle exists anywhere. The
    // handle-based rollback path in the catch below would silently do
    // nothing, leaving the repo half-written. This snapshot is a runner-level
    // invariant independent of what applyChangeSet chooses to do.
    //
    // Round-11 P1: the absolute path used for the snapshot AND the manual
    // rollback I/O must be the canonical (symlink-resolved) form produced
    // by the scope check above. Using `path.resolve(cwd, entry.path)` here
    // would follow symlinks on write, so even though checkChangeSetPathScope
    // rejects a symlink escape, a bug that lets one through would still let
    // the snapshot read the external file's content and the rollback write
    // to it. Canonicalizing here is defense-in-depth.
    const preApplySnapshot = [];
    if (applyChangeSet) {
      const cwd = target.cwd || process.cwd();
      for (const entry of changeSet) {
        if (!entry || typeof entry.path !== 'string' || entry.path === '') {
          continue;
        }
        const canonicalAbsolute = scope.canonicalPaths.has(entry.path)
          ? scope.canonicalPaths.get(entry.path)
          : canonicalizeAbsolute(cwd, entry.path);
        let before = null;
        let existed = false;
        try {
          before = fs.readFileSync(canonicalAbsolute, 'utf8');
          existed = true;
        } catch (_) {
          // File didn't exist before apply; manual rollback will delete it.
        }
        preApplySnapshot.push({
          path: entry.path,
          absolute: canonicalAbsolute,
          before,
          existed,
        });
      }
    }

    // Round-12 P2 #1: bind the canonical approval to the actual write sink.
    // Even though checkChangeSetPathScope canonicalizes paths and
    // preApplySnapshot reads/writes the canonical form, applyChangeSet still
    // received the ORIGINAL raw `entry.path` strings. A malicious in-repo
    // symlink swap between scope check and write (or any shape mismatch
    // between the raw path and its canonical form) would let the engine read
    // and write the non-canonical sink, while rollback would target the
    // canonical sink — leaving the external file mutated and the in-repo
    // snapshot restored. Clone the changeSet here, replacing each entry's
    // path with the canonical repo-relative form (derived via
    // path.relative(canonicalRoot, canonicalAbsolute)). Also pass
    // cwd=canonicalRoot so the engine's own path.resolve aligns with the
    // snapshot/rollback canonicalization — one canonical sink across
    // approval, apply, snapshot, and rollback.
    //
    // Fallback: when canonicalRoot is null (scope check degraded to lexical
    // because cwd wasn't realpath'able — tests with synthetic /tmp/repo),
    // pass the changeSet unchanged. That path is only reachable when the
    // caller's cwd has no filesystem presence, so there is no symlink sink
    // for an attacker to swap.
    let appliedChangeSet = changeSet;
    let appliedCwd = target.cwd;
    if (applyChangeSet && scope.canonicalRoot !== null) {
      appliedCwd = scope.canonicalRoot;
      appliedChangeSet = changeSet.map((entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || entry.path === '') {
          return entry;
        }
        const canonicalAbsolute = scope.canonicalPaths.get(entry.path);
        if (typeof canonicalAbsolute !== 'string') {
          // Scope check passed this entry via lexical fallback (canonicalRoot
          // exists but some entries had no canonical sibling) — keep as-is.
          return entry;
        }
        const canonicalRelative = path.relative(scope.canonicalRoot, canonicalAbsolute);
        // path.relative returns '' when both args are identical (a write to
        // the repo root itself — nonsensical here but defensive). Fall back
        // to the raw path rather than corrupt the changeSet.
        if (canonicalRelative === '' || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
          return entry;
        }
        return Object.assign({}, entry, {
          path: canonicalRelative.split(path.sep).join('/'),
        });
      });
    }

    let appliedHandle = null;
    try {
      if (applyChangeSet) {
        appliedHandle = await applyChangeSet(appliedChangeSet, { cwd: appliedCwd, target });
      }
    } catch (applyError) {
      // applyChangeSet writes files sequentially. If the 3rd of 5 files fails
      // (ENOSPC/EACCES/etc.), the first two stay written. Some engines throw
      // with the partial state attached as `applyError.appliedHandle`; others
      // leave whatever was assigned to `appliedHandle` before the throw. Try
      // both so we always attempt rollback when there is something to roll.
      const handleForRollback = (applyError && applyError.appliedHandle)
        || appliedHandle
        || null;
      let applyRollbackError = null;
      let handleRollbackThrew = false;
      if (handleForRollback && rollbackChangeSet) {
        try {
          await rollbackChangeSet(handleForRollback);
        } catch (rollbackErr) {
          applyRollbackError = rollbackErr && rollbackErr.message
            ? rollbackErr.message
            : String(rollbackErr);
          handleRollbackThrew = true;
        }
      }
      // Round-8 P2: if neither the runner nor the error carried a handle,
      // the handle-based rollback above did nothing. Fall back to the
      // pre-apply snapshot and restore each file to its original content (or
      // delete it if it did not exist before).
      //
      // Round-10 P2 extension: ALSO run the manual rollback as a second stage
      // when the handle-based rollback THREW. A handle rollback that restores
      // file A then throws before file B leaves the repo half-reverted — a
      // strictly worse state than not rolling back at all. The snapshot-based
      // manual rollback is idempotent (writes the captured before-content or
      // unlinks files that did not exist) so running it over the top of a
      // partial handle rollback is safe and best-effort recovers the rest.
      let manualRollbackUsed = false;
      let manualRollbackError = null;
      if (!handleForRollback || handleRollbackThrew) {
        const manual = runManualRollback(preApplySnapshot);
        manualRollbackUsed = manual.used;
        manualRollbackError = manual.error;
      }
      history.push({
        round,
        audit,
        fix,
        status: 'apply-failed',
        summary,
        applyError: applyError && applyError.message ? applyError.message : String(applyError),
        applyRollbackError,
        handleRollbackError: handleRollbackThrew ? applyRollbackError : null,
        manualRollbackUsed,
        manualRollbackError,
      });
      return {
        converged: false,
        rounds: round,
        history,
        reason: 'apply-failed',
        finalAudit: audit,
        finalSummary: summary,
      };
    }

    if (runValidation) {
      let validation = null;
      let validationError = null;
      try {
        validation = await runValidation({ target, round });
      } catch (err) {
        // If runValidation THROWS, we still need to roll back the applied
        // changeSet and record the failure — otherwise the repo stays dirty
        // and the loop exits via exception with no history entry at all.
        validationError = err && err.message ? err.message : String(err);
      }
      if (validationError !== null || !validation || validation.passed !== true) {
        let rollbackError = null;
        let handleRollbackThrew = false;
        if (appliedHandle && rollbackChangeSet) {
          try {
            await rollbackChangeSet(appliedHandle);
          } catch (err) {
            // Rollback itself failed — the repo is in a half-applied state.
            // Surface it on the history entry instead of swallowing silently.
            rollbackError = err && err.message ? err.message : String(err);
            handleRollbackThrew = true;
          }
        }
        // Round-9 P2: when appliedHandle is falsy, the handle-based rollback
        // above did nothing. A custom apply engine that writes files and
        // returns null/undefined would leave the repo dirty even though
        // validation said no. Fall back to the pre-apply snapshot here too —
        // mirrors the apply-throw branch's manual-rollback defense.
        //
        // Round-10 P2 extension: ALSO run the manual rollback as a second
        // stage when the handle-based rollback THREW mid-restoration (e.g.,
        // restored file A then threw before file B). The snapshot fallback is
        // idempotent and best-effort recovers the rest; leaving a partially
        // reverted repo is strictly worse than trying to finish the revert.
        let manualRollbackUsed = false;
        let manualRollbackError = null;
        if (!appliedHandle || handleRollbackThrew) {
          const manual = runManualRollback(preApplySnapshot);
          manualRollbackUsed = manual.used;
          manualRollbackError = manual.error;
        }
        history.push({
          round,
          audit,
          fix,
          status: 'validation-failed',
          summary,
          validation,
          rollbackError,
          handleRollbackError: handleRollbackThrew ? rollbackError : null,
          validationError,
          manualRollbackUsed,
          manualRollbackError,
        });
        return {
          converged: false,
          rounds: round,
          history,
          reason: validationError !== null ? 'validation-threw' : 'validation-failed',
          finalAudit: audit,
          finalSummary: summary,
        };
      }
    }

    history.push({
      round,
      audit,
      fix,
      status: 'fixed',
      summary,
      blockingCount: blocking.length,
    });
  }

  const lastEntry = history[history.length - 1];
  return {
    converged: false,
    rounds: maxRounds,
    history,
    reason: 'max-rounds-exhausted',
    finalAudit: lastEntry && lastEntry.audit,
    finalSummary: lastEntry && lastEntry.summary,
  };
}

module.exports = {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_SEVERITY_FLOOR,
  SEVERITY_RANK,
  checkChangeSetPathScope,
  filterBlockingFindings,
  isBlocking,
  runAuditFixLoop,
  severityRank,
  summarizeBySeverity,
};
