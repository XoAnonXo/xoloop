const fs = require('node:fs');
const path = require('node:path');

const {
  buildAttemptId,
  buildBatchId,
  defaultWorktreeRoot,
  ensureDir,
  normalizeText,
  nowIso,
  readJsonIfExists,
  resolveRepoPath,
  writeJsonAtomic,
} = require('./baton_common.cjs');
const {
  createWorktree,
  deleteBranch,
  getHeadCommit,
  gitStatus,
  removeWorktree,
  runGit,
} = require('./baton_worktree_manager.cjs');
const {
  findSurface,
  loadOvernightAdapter,
  resolvePatternMatches,
} = require('./overnight_adapter.cjs');
const { runAuditGate } = require('./overnight_audit_gate.cjs');
const {
  appendOvernightEvent,
  appendSurfaceHistory,
  buildOvernightManifestPaths,
  createOvernightManifest,
  loadOvernightManifest,
  updateOvernightManifest,
  writeSurfaceStatus,
} = require('./overnight_manifest.cjs');
const { loadOvernightObjective } = require('./overnight_objective.cjs');
const {
  applyPatchSet,
  preflightPatchSet,
  rollbackAppliedPatchSet,
} = require('./overnight_patch_engine.cjs');
// callModel — now used only by overnight_engine_repair.cjs
const {
  buildEditorPrompt,
  buildEditorRepairPrompt,
  buildPlannerPrompt,
  buildTargetWindows,
  isNonCodePath,
  listAnchorFailures,
  mineSurfaceCandidates,
  normalizeProposalMode,
  validateStagedEditorProposal,
} = require('./overnight_staged.cjs');
const { writeYamlFile } = require('./overnight_yaml.cjs');
const { AdapterError, extractStructuredError } = require('./errors.cjs');
const { verifyProposalReferences, summarizeHallucinated } = require('./reference_verifier.cjs');

// --- cooldown / novelty gating extracted to overnight_engine_cooldown.cjs ---
const {
  shouldCoolSurfaceDown,
  listNoRetryIdeas,
  listExploredTargets,
  loadSiblingLedgerEntries,
  mergedLedgerForNovelty,
  buildLedgerEntry,
  gateProposal,
  gatePlannerDecision,
  getPatchFingerprintOrReject,
  recheckProposalAfterRepair,
} = require('./overnight_engine_cooldown.cjs');

// --- repair helpers extracted to overnight_engine_repair.cjs ---
const {
  extractPatchPathFromError,
  buildRepairContext,
  buildRepairPrompt,
  callProposer,
  loadStructuredResponseWithRepair,
  loadProposalWithRepair,
  loadPlannerWithRepair,
} = require('./overnight_engine_repair.cjs');

// --- proposal helpers extracted to overnight_engine_proposal.cjs ---
const {
  buildLedgerProposalFallback,
  buildRejectionStructuredError,
  buildRejectionSummary,
  checkRepairCompatibility,
  classifySyntaxFailure,
  createPatchFamilyFingerprint,
  createPatchFingerprint,
  normalizeStringList,
  parseProposal,
  proposalHasNoChanges,
  proposalSummary,
  validateProposalOperationLimits,
} = require('./overnight_engine_proposal.cjs');

const OVERNIGHT_ENGINE_SCHEMA_VERSION = '1.0.0';
const DEFAULT_REPORT_DIR = 'proving-ground/reports/overnight';

function truncateOutput(text, maxLength = 800) {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const omitted = normalized.length - maxLength;
  return `${normalized.slice(0, maxLength)}... [omitted ${omitted} chars]`;
}

// Audit round-4 P1#1: shell-injection hardening for validation commands.
//
// Historical behaviour: every validation entry in overnight.yaml is a string
// executed via `bash -lc <string>`.  A poisoned adapter could therefore drop
// arbitrary shell into the worktree.  We keep that behaviour for backwards
// compatibility (the adapter contract has always been "any shell string"), but
// add a safer structured alternative: if the entry is an object with `argv`,
// we hand that argv to spawnSync directly WITHOUT a shell so metacharacters are
// taken as literal arguments.  The engine itself never interprets either form
// specially — it only executes what the caller hands it.  Adapter-level
// gating (disallowShellValidation) is the control plane that rejects the
// string form at load time for callers who opt in.
function runValidationCommand(command, cwd) {
  const startedAt = Date.now();
  // Structured form: { argv: [cmd, ...args] } — spawn directly, no shell.
  if (command && typeof command === 'object' && !Array.isArray(command) && Array.isArray(command.argv) && command.argv.length > 0) {
    const [cmd, ...args] = command.argv;
    const result = require('node:child_process').spawnSync(String(cmd), args.map((value) => String(value)), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
    });
    return {
      command: command.argv.join(' '),
      commandKind: 'argv',
      exitCode: result.status === null ? 1 : result.status,
      passed: result.status === 0,
      elapsedMs: Date.now() - startedAt,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
    };
  }
  // String form: legacy shell-style path.  Preserved for back-compat; callers
  // who want to forbid it should set adapter.disallowShellValidation=true at
  // load time, which rejects string entries before they ever reach the engine.
  const shellCommand = String(command || '');
  const result = require('node:child_process').spawnSync('bash', ['-lc', shellCommand], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command: shellCommand,
    commandKind: 'shell',
    exitCode: result.status === null ? 1 : result.status,
    passed: result.status === 0,
    elapsedMs: Date.now() - startedAt,
    stdout: truncateOutput(result.stdout),
    stderr: truncateOutput(result.stderr),
  };
}

function summarizeValidationResults(results) {
  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  const totalElapsedMs = results.reduce((sum, result) => sum + Number(result.elapsedMs || 0), 0);
  return {
    commandCount: results.length,
    passedCount,
    failedCount,
    passRate: results.length === 0 ? 1 : passedCount / results.length,
    totalElapsedMs,
    overallPass: failedCount === 0,
  };
}

// Audit round-4 P1#1: normalize a mixed list of string commands and argv-form
// objects.  Strings survive as strings (legacy shell path).  Objects with an
// argv array survive as-is so spawnSync can get the raw argv without a shell.
// Everything else (null, arrays, numbers) is dropped — same filter-Boolean
// semantics normalizeStringList already applies to string-only lists.
function normalizeValidationCommandList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) out.push(trimmed);
      continue;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.argv) && entry.argv.length > 0) {
      const argv = entry.argv.map((token) => (typeof token === 'string' ? token : String(token || '')).trim()).filter(Boolean);
      if (argv.length > 0) out.push({ argv });
    }
  }
  return out;
}

function runValidationPlan(commands, cwd) {
  const results = normalizeValidationCommandList(commands).map((command) => runValidationCommand(command, cwd));
  return {
    commands: results,
    summary: summarizeValidationResults(results),
  };
}

function getWorkingTreeState(cwd) {
  const result = require('node:child_process').spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entries = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ok: result.status === 0,
    isDirty: entries.length > 0,
    entries,
    error: normalizeText(result.stderr),
  };
}

function runGitCommand(cwd, args) {
  const result = require('node:child_process').spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status === null ? 1 : result.status,
    stdout: normalizeText(result.stdout),
    stderr: normalizeText(result.stderr),
  };
}

function commitAcceptedIteration(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const appliedChangeSet = options.appliedChangeSet;
  if (!appliedChangeSet || !Array.isArray(appliedChangeSet.files) || appliedChangeSet.files.length === 0) {
    throw new AdapterError(
      'GIT_COMMIT_PRECONDITION',
      'appliedChangeSet.files',
      'commitAcceptedIteration requires touched files',
      { fixHint: 'Provide an appliedChangeSet with a non-empty files array.' },
    );
  }
  const files = appliedChangeSet.files
    .map((entry) => normalizeText(entry && entry.path))
    .filter(Boolean);
  const addResult = runGitCommand(cwd, ['add', '--', ...files]);
  if (addResult.exitCode !== 0) {
    throw new AdapterError(
      'GIT_COMMAND_FAILED',
      'git-add',
      addResult.stderr || 'git add failed',
      { fixHint: 'Check that the worktree path exists and the files are valid.' },
    );
  }
  const diffResult = runGitCommand(cwd, ['diff', '--cached', '--quiet', '--', ...files]);
  if (diffResult.exitCode === 0) {
    return {
      skipped: true,
      reason: 'no-staged-diff',
      files,
    };
  }
  if (diffResult.exitCode !== 1) {
    throw new AdapterError(
      'GIT_COMMAND_FAILED',
      'git-diff',
      diffResult.stderr || 'git diff --cached --quiet failed',
      { fixHint: 'Unexpected exit code from git diff; the index may be corrupt.' },
    );
  }
  const message = `overnight: ${normalizeText(options.summary) || 'objective-driven change'}`;
  const commitResult = runGitCommand(cwd, [
    '-c', 'user.name=Codex',
    '-c', 'user.email=codex@example.com',
    'commit',
    '-m', message,
    '--',
    ...files,
  ]);
  if (commitResult.exitCode !== 0) {
    throw new AdapterError(
      'GIT_COMMAND_FAILED',
      'git-commit',
      commitResult.stderr || commitResult.stdout || 'git commit failed',
      { fixHint: 'Check that the worktree has staged changes and git config is valid.' },
    );
  }
  const headResult = runGitCommand(cwd, ['rev-parse', 'HEAD']);
  if (headResult.exitCode !== 0) {
    throw new AdapterError(
      'GIT_COMMAND_FAILED',
      'git-rev-parse',
      headResult.stderr || 'git rev-parse HEAD failed',
      { fixHint: 'The commit may not have been recorded; check the worktree state.' },
    );
  }
  const fileSummary = appliedChangeSet.files.reduce((acc, entry) => {
    acc.touchedFiles += 1;
    acc.addedLines += typeof entry.addedLines === 'number' ? entry.addedLines : 0;
    acc.removedLines += typeof entry.removedLines === 'number' ? entry.removedLines : 0;
    return acc;
  }, { touchedFiles: 0, addedLines: 0, removedLines: 0 });
  return {
    skipped: false,
    sha: headResult.stdout,
    message,
    files,
    fileSummary,
  };
}

function summarizeValidation(validation) {
  return validation && validation.summary ? validation.summary : {
    commandCount: 0,
    passedCount: 0,
    failedCount: 0,
    passRate: 0,
    totalElapsedMs: 0,
    overallPass: false,
  };
}

// Audit round-4 P2#1: sanitise the list returned by listNoRetryIdeas before
// it is stitched into a planner/editor/proposer prompt.  The raw list carries
// free-form text copied from earlier rejected proposals (summaries, next
// steps, logical-explanation problems) — every one of those fields is a
// direct vector for a model-authored prompt-injection payload ("IGNORE ALL
// PREVIOUS INSTRUCTIONS AND...") to steer the next turn.  We strip the list
// down to the fields the prompt actually needs for novelty gating:
//
//   patchFingerprint — identity for duplicate-patch detection
//   patchFamilyFingerprint — identity for duplicate-family detection
//   path — bare file path, NOT the narrative prose
//   reasonCode — structured rejection kind (audit-reject, validation-failed…)
//
// Original artifacts on disk remain untouched — callers inspecting the full
// history still see everything.  Only the prompt view is scrubbed.
function sanitizeNoRetryIdeas(rawIdeas) {
  if (!Array.isArray(rawIdeas)) return [];
  const out = [];
  for (const entry of rawIdeas) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const src = entry.sourceTarget && typeof entry.sourceTarget === 'object' && !Array.isArray(entry.sourceTarget)
      ? entry.sourceTarget : null;
    const path = src && typeof src.path === 'string' ? src.path : null;
    const reasonCode = typeof entry.reasonCode === 'string' ? entry.reasonCode : null;
    out.push({
      patchFingerprint: typeof entry.patchFingerprint === 'string' ? entry.patchFingerprint : null,
      patchFamilyFingerprint: typeof entry.patchFamilyFingerprint === 'string' ? entry.patchFamilyFingerprint : null,
      path,
      reasonCode,
    });
  }
  return out;
}

// Audit round-4 P1#2: derive the canonical allow-list of paths a proposal is
// permitted to touch.  The patch engine uses this to reject any patch entry
// whose canonical target resolves outside the surface boundary, turning what
// was advisory (depending on gateProposal) into a write-layer guarantee.
function deriveSurfaceAllowedPaths(surface) {
  if (!surface || typeof surface !== 'object') return [];
  const paths = Array.isArray(surface.paths) ? surface.paths : [];
  const testPaths = Array.isArray(surface.testPaths) ? surface.testPaths : [];
  // De-dupe while preserving order so buildAllowedCanonicalSet produces a
  // stable key set across calls.
  const seen = new Set();
  const out = [];
  for (const entry of paths.concat(testPaths)) {
    const value = typeof entry === 'string' ? entry : '';
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// Audit round-4 P1#2/P1#3: single entry point every applyPatchSet call goes
// through.  It preflights the patch (getting a verificationManifest), then
// applies with both allowedPaths (surface boundary) and verificationManifest
// (concurrent-writer drift detection) wired in.  Any PATCH_VERIFICATION_DRIFT
// or PATCH_PATH_OUT_OF_SCOPE surfaces as an AdapterError the outer executor
// turns into a rejection with reasonCode='verification-drift' or the patch
// engine's own code for scope violations.
function applyPatchSetBounded(patchSet, surface, cwd) {
  const allowedPaths = deriveSurfaceAllowedPaths(surface);
  // preflightPatchSet returns { ok, failures, verificationManifest }.  We
  // propagate its manifest forward regardless of failures — the subsequent
  // applyPatchSet will throw the same structured error the preflight surfaced
  // (keeps a single code path for callers).  The one exception is the
  // verification-drift check: applyPatchSet re-reads each file at write time
  // and throws PATCH_VERIFICATION_DRIFT if bytes changed since preflight,
  // giving us the TOCTOU guarantee the bare apply path lacked.
  const preflight = preflightPatchSet(patchSet, { cwd, allowedPaths });
  return applyPatchSet(patchSet, {
    cwd,
    allowedPaths,
    verificationManifest: preflight.verificationManifest,
  });
}

function buildSurfacePaths(reportRoot, worktreeRoot, surfaceId) {
  const surfaceDir = path.join(reportRoot, 'surfaces', surfaceId);
  return {
    surfaceDir,
    statusPath: path.join(surfaceDir, 'status.json'),
    latestPath: path.join(surfaceDir, 'latest.json'),
    historyPath: path.join(surfaceDir, 'history.ndjson'),
    attemptsDir: path.join(surfaceDir, 'attempts'),
    worktreePath: path.join(worktreeRoot, surfaceId),
  };
}

function buildAttemptPaths(batchDir, surfaceId, attemptId) {
  const attemptDir = path.join(batchDir, 'surfaces', surfaceId, 'attempts', attemptId);
  return {
    attemptDir,
    reportPath: path.join(attemptDir, 'report.json'),
    proofPath: path.join(attemptDir, 'proof.json'),
    handoffPath: path.join(attemptDir, 'handoff.md'),
    auditPath: path.join(attemptDir, 'audit.json'),
    proposalPath: path.join(attemptDir, 'proposal.json'),
    planPath: path.join(attemptDir, 'plan.json'),
    windowPath: path.join(attemptDir, 'window.json'),
    editorProposalPath: path.join(attemptDir, 'editor-proposal.json'),
  };
}

function buildBatchBranchPrefix(adapter, batchId) {
  return `${adapter.defaults.branchPrefix}/${batchId}`;
}

function buildSurfaceBranchName(adapter, batchId, surfaceId, attemptId) {
  return `${buildBatchBranchPrefix(adapter, batchId)}/${surfaceId}/${attemptId}`;
}

function buildIntegrationBranchName(adapter, batchId) {
  return `${buildBatchBranchPrefix(adapter, batchId)}/integration`;
}

// isNonCodePath is imported from overnight_staged.cjs — single source of truth
// for the non-code suffix list shared by both the legacy and staged pipelines.
// classifySyntaxFailure, buildSurfaceBudget, collectProposalPaths,
// createPatchFingerprint, createPatchFamilyFingerprint, collectChangedSymbols,
// buildRejectionSummary, buildRejectionStructuredError — moved to overnight_engine_proposal.cjs

// listNoRetryIdeas, listExploredTargets, loadSiblingLedgerEntries, mergedLedgerForNovelty
// — moved to overnight_engine_cooldown.cjs

// ---------------------------------------------------------------------------
// In-flight target reservation (mkdir-based atomic locking).
//
// Problem: with N parallel workers, all N can pick the same "best" target
// between the time they start and the time any of them writes its manifest.
// burst3 saw 6× README::Quick Start dogpile because parallelism=6 — every
// worker raced on the same target before any had landed its plan in the
// sibling ledger. Cross-batch novelty only kicks in AFTER manifests exist.
//
// Fix: each worker atomically reserves a (surfaceId, path, symbol) slot by
// calling mkdirSync(lockDir).  mkdir is atomic on POSIX — it either succeeds
// (the caller owns the lock) or throws EEXIST (another caller won).  A
// metadata file is written INSIDE the lock directory after the atomic mkdir;
// it is informational only and does not participate in the locking protocol.
//
// Stale-lock recovery:
//   1. Check directory mtime against TTL.
//   2. If within TTL, read metadata and probe whether the owner pid is alive.
//   3. If stale, rmSync the directory then retry mkdirSync atomically.
//      Two concurrent stealers: one wins the second mkdir, the other gets
//      EEXIST and backs off with reason 'stale-steal-raced'.
// ---------------------------------------------------------------------------

const TARGET_LOCK_TTL_MS = 10 * 60 * 1000;

function targetLocksDir(manifest) {
  if (!manifest || !manifest.reportRoot) return null;
  return path.join(path.dirname(manifest.reportRoot), '.target-locks');
}

function targetLockFileName(surfaceId, sourceTarget) {
  const safe = (value) => String(value || '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80);
  const pathPart = safe(sourceTarget && sourceTarget.path);
  const symbolPart = safe(sourceTarget && (sourceTarget.symbol || sourceTarget.anchorText));
  return `${safe(surfaceId)}__${pathPart}__${symbolPart}.lock`;
}

// The lock dir itself is the atomic token (mkdir is atomic on POSIX).
// A metadata file named "meta.json" sits INSIDE the lock dir and carries
// pid, timestamp, surface, etc.  Reading meta.json is never load-bearing for
// the atomic guarantee — only the directory's existence is.
const TARGET_LOCK_META_FILE = 'meta.json';

function _readLockMeta(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, TARGET_LOCK_META_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function _isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    // signal 0 checks existence without sending a real signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLockStale(lockDir) {
  // Single statSync call: check existence, verify it is a directory, and read
  // mtime in one syscall.  A second statSync was previously called for mtime
  // but the first result already carries mtimeMs, so the second call was
  // redundant and introduced a narrow TOCTOU window (the directory could be
  // deleted between the two calls, throwing inside the second catch block).
  let stat;
  try {
    stat = fs.statSync(lockDir);
    if (!stat.isDirectory()) return true;
  } catch {
    return true;
  }
  // Fast path: directory is older than TTL — definitely stale.
  if ((Date.now() - stat.mtimeMs) > TARGET_LOCK_TTL_MS) return true;
  // Within TTL window: check whether the owning pid is still alive.
  const meta = _readLockMeta(lockDir);
  if (!meta) return true; // no metadata written yet or corrupted — stale
  if (_isPidAlive(meta.pid)) return false; // owner is alive — fresh
  return true; // owner pid is dead — stale
}

/**
 * Atomically reserve a target using mkdir-based locking.
 *
 * mkdir is atomic on POSIX (it either succeeds or throws EEXIST).
 * The lock "file" is actually a directory; a metadata file is written
 * INSIDE it after the atomic mkdir.  This eliminates the TOCTOU race
 * of the previous writeFileSync-based steal path.
 *
 * Returns { acquired: true, lockPath } on success.
 * Returns { acquired: false, reason } when another worker holds a fresh lock.
 */
function acquireTargetLock(manifest, surfaceId, sourceTarget) {
  const locksDir = targetLocksDir(manifest);
  if (!locksDir || !sourceTarget || !sourceTarget.path) {
    return { acquired: true, lockPath: null };
  }
  // Audit round-4 P2#2: fail CLOSED when the lock infrastructure is broken.
  // Previously we returned acquired:true on any filesystem error so the run
  // kept moving — but the docstring promises "atomic target reservation" and
  // two parallel workers falling open on the same broken lockdir was the
  // exact dogpile the lock was meant to prevent.  Callers must retry or abort
  // rather than bulldoze through.
  try {
    fs.mkdirSync(locksDir, { recursive: true });
  } catch (mkdirDirError) {
    return {
      acquired: false,
      lockPath: null,
      reason: 'lock-setup-failed',
      error: (mkdirDirError && mkdirDirError.message) || 'mkdir parent locks dir failed',
    };
  }

  // lockPath is now a DIRECTORY, not a file.
  const lockPath = path.join(locksDir, targetLockFileName(surfaceId, sourceTarget));
  const meta = {
    pid: process.pid,
    batchId: manifest.batchId || null,
    surfaceId,
    path: sourceTarget.path,
    symbol: sourceTarget.symbol || sourceTarget.anchorText || null,
    acquiredAt: new Date().toISOString(),
  };
  const metaPayload = JSON.stringify(meta);

  // --- Attempt 1: atomic mkdir ---
  try {
    fs.mkdirSync(lockPath);
    // We own the directory. Write metadata inside.
    fs.writeFileSync(path.join(lockPath, TARGET_LOCK_META_FILE), metaPayload);
    return { acquired: true, lockPath };
  } catch (mkdirError) {
    if (!mkdirError || mkdirError.code !== 'EEXIST') {
      // Audit round-4 P2#2: unexpected filesystem errors must fail CLOSED.
      // Letting the run continue without a lock means two workers can land
      // on the same target — the exact race the lock exists to prevent.
      return {
        acquired: false,
        lockPath: null,
        reason: 'lock-setup-failed',
        error: (mkdirError && mkdirError.code) || (mkdirError && mkdirError.message) || 'mkdir lock dir failed',
      };
    }
    // EEXIST: another worker (or a previous crashed run) owns the directory.
  }

  // --- Stale check and atomic steal ---
  if (!isLockStale(lockPath)) {
    return { acquired: false, reason: 'in-flight' };
  }

  // Lock is stale. Steal atomically:
  //   1. Remove the stale lock dir (with its metadata).
  //   2. Re-run mkdir — if another process raced us here, one will get EEXIST.
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    return { acquired: false, reason: 'stale-steal-failed' };
  }
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, TARGET_LOCK_META_FILE), metaPayload);
    return { acquired: true, lockPath, stolen: true };
  } catch (raceError) {
    if (raceError && raceError.code === 'EEXIST') {
      // Another worker won the race during the steal window.
      return { acquired: false, reason: 'stale-steal-raced' };
    }
    return { acquired: false, reason: 'stale-steal-failed' };
  }
}

function releaseTargetLock(lockPath) {
  if (!lockPath) return;
  try {
    // Remove metadata first, then the directory.
    fs.unlinkSync(path.join(lockPath, TARGET_LOCK_META_FILE));
  } catch {
    // ENOENT is fine — metadata may already be gone or was never written.
  }
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // ENOENT or ENOTEMPTY both acceptable — either already released or
    // something unexpected was left; fall through to avoid blocking the run.
  }
}

function buildPromptContext(adapter, objective, surface, contextRepoRoot = adapter.repoRoot) {
  const repoRoot = path.resolve(contextRepoRoot || adapter.repoRoot);
  const excerpts = [];
  const missingPatterns = [];
  const contextFiles = [];
  const addPatternMatches = (patterns) => {
    normalizeStringList(patterns).forEach((pattern) => {
      if (!pattern.includes('*')) {
        contextFiles.push(pattern);
        return;
      }
      const matches = resolvePatternMatches(adapter, [pattern]);
      if (matches.length === 0) {
        missingPatterns.push(pattern);
        return;
      }
      matches.forEach((entry) => contextFiles.push(entry));
    });
  };
  addPatternMatches(surface.paths);
  addPatternMatches(surface.testPaths);
  addPatternMatches(surface.contextPatterns);
  const seen = new Set();
  for (const relativePath of contextFiles.slice(0, 12)) {
    if (seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    const resolved = resolveRepoPath(repoRoot, relativePath);
    const content = fs.readFileSync(resolved.absolutePath, 'utf8');
    excerpts.push({
      path: relativePath,
      excerpt: content.length > 2200 ? `${content.slice(0, 2200)}\n...` : content,
    });
  }
  return {
    objective: {
      goal: objective.goal,
      success: objective.success,
      requiredTests: objective.requiredTests,
      stopConditions: objective.stopConditions,
      evidence: objective.evidence,
    },
    surface: {
      id: surface.id,
      title: surface.title,
      description: surface.description,
      risk: surface.risk,
      invariants: surface.invariants,
      paths: surface.paths,
      testPaths: surface.testPaths,
      requiredTestKinds: surface.requiredTestKinds,
      allowedDependencies: surface.allowedDependencies,
      conflictsWith: surface.conflictsWith || [],
      languageHints: surface.languageHints || [],
      formattingHints: surface.formattingHints || [],
      contextPatterns: normalizeStringList(surface.contextPatterns),
      guidance: [
        'Use SEARCH blocks copied from the current file text, not guessed text.',
        'Prefer stable anchors such as test names, function names, export names, or complete small blocks.',
        'Avoid brittle anchors such as version literals, timestamps, generated IDs, or repeated strings when a stronger anchor exists.',
        'If you cannot build a stable SEARCH block from the provided file excerpts, return no safe change.',
        'If you touch a source file such as .js, .cjs, .mjs, .ts, or .tsx, include matching test_changes even when the edit only improves wording or comments.',
      ],
      contextCoverage: {
        loadedFileCount: excerpts.length,
        missingPatterns,
      },
    },
    focusFiles: excerpts,
  };
}

function buildProposalPrompt(options) {
  return {
    systemPrompt: [
      'You are the objective-driven overnight code worker.',
      'Return JSON only.',
      'Make one bounded proposal that satisfies the objective without violating the surface invariants.',
      'Do not touch files outside the allowed surface paths and test paths.',
      'Do not retry ideas listed in no_retry_ideas.',
      'The only top-level keys allowed are logical_explanation, code_changes, and test_changes.',
      'Each patch block must use path, search, replace, context_before, and context_after.',
      'SEARCH blocks must be copied from the current file excerpts and anchored on stable surrounding text.',
      'If a stable SEARCH block is not available, return no safe change instead of guessing.',
      'When editing any source-code file, always include matching test_changes, even for clarity, comments, or guidance text.',
      'If no safe change exists, return empty code_changes and empty test_changes with a clear logical_explanation.',
    ].join(' '),
    userPrompt: JSON.stringify({
      objective: options.context.objective,
      surface: options.context.surface,
      focusFiles: options.context.focusFiles,
      no_retry_ideas: options.noRetryIdeas,
      return_shape: {
        logical_explanation: {
          problem: 'what is being solved',
          why_this_surface: 'why the chosen surface is correct',
          invariants_preserved: ['which invariants stay true'],
          why_this_is_bounded: 'why the change stays small',
          residual_risks: ['remaining risks or empty list'],
        },
        code_changes: [
          {
            path: 'relative/path',
            search: 'exact current text',
            replace: 'new text',
            context_before: 'optional exact text before search',
            context_after: 'optional exact text after search',
          },
        ],
        test_changes: [
          {
            path: 'relative/path',
            search: 'exact current text',
            replace: 'new text',
            context_before: 'optional exact text before search',
            context_after: 'optional exact text after search',
          },
        ],
      },
    }, null, 2),
  };
}

// extractPatchPathFromError, buildRepairContext, buildRepairPrompt
// — moved to overnight_engine_repair.cjs

// normalizePatchList, normalizeExplanation, parseProposal,
// validateProposalOperationLimits, proposalSummary, buildLedgerProposalFallback
// — moved to overnight_engine_proposal.cjs

// buildLedgerEntry, shouldCoolSurfaceDown
// — moved to overnight_engine_cooldown.cjs

// proposalHasNoChanges, buildCandidateRejection, checkRepairCompatibility
// — moved to overnight_engine_proposal.cjs

// gatePlannerDecision — moved to overnight_engine_cooldown.cjs

function buildAuditPacket(options) {
  return {
    goal: options.objective.goal,
    surface: {
      id: options.surface.id,
      title: options.surface.title,
      risk: options.surface.risk,
      invariants: options.surface.invariants,
    },
    proposal: {
      summary: proposalSummary(options.proposal),
      logical_explanation: options.proposal.logicalExplanation,
      code_changes: options.proposal.codeChanges,
      test_changes: options.proposal.testChanges,
    },
    validation: {
      baseline: summarizeValidation(options.baseline),
      quick: summarizeValidation(options.quickValidation),
      full: summarizeValidation(options.fullValidation),
    },
    diff: options.unifiedDiff,
  };
}

// callProposer, loadStructuredResponseWithRepair, loadProposalWithRepair, loadPlannerWithRepair
// — moved to overnight_engine_repair.cjs

function buildUnifiedDiff(cwd, changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return '';
  }
  const result = runGit(cwd, ['diff', '--', ...changedFiles]);
  if (result.exitCode !== 0) {
    return '';
  }
  return result.stdout || '';
}

function createAttemptReport(options) {
  return {
    schemaVersion: OVERNIGHT_ENGINE_SCHEMA_VERSION,
    batchId: options.batchId,
    objectiveHash: options.objectiveHash,
    surfaceId: options.surface.id,
    title: options.surface.title,
    risk: options.surface.risk,
    attemptId: options.attemptId,
    startedAt: options.startedAt,
    finishedAt: null,
    baseCommit: options.baseCommit,
    pipelineMode: options.pipelineMode || 'legacy',
    failureStage: null,
    failureKind: null,
    candidateFingerprint: null,
    windowFingerprint: null,
    sourceTarget: null,
    testTarget: null,
    failedPath: null,
    failedSearchExcerpt: '',
    plan: null,
    windows: null,
    editorProposal: null,
    proposal: null,
    repairTurnsUsed: 0,
    patchFamilyFingerprint: null,
    validation: {
      baseline: null,
      quick: null,
      full: null,
    },
    audit: null,
    diffSummary: {
      files: [],
      addedLines: 0,
      removedLines: 0,
      netLineDelta: 0,
      unifiedDiff: '',
    },
    commit: null,
    outcome: 'failed',
    reasonCode: 'not-finished',
    nextStep: 'Inspect the attempt report before retrying.',
    applyError: null,
    rollbackApplied: false,
  };
}

function buildProofPacket(report) {
  return {
    schemaVersion: OVERNIGHT_ENGINE_SCHEMA_VERSION,
    batchId: report.batchId,
    surfaceId: report.surfaceId,
    attemptId: report.attemptId,
    pipelineMode: report.pipelineMode,
    outcome: report.outcome,
    reasonCode: report.reasonCode,
    rejectionSummary: buildRejectionSummary(report, buildLedgerProposalFallback(report)),
    failureStage: report.failureStage,
    failureKind: report.failureKind,
    patchFamilyFingerprint: report.patchFamilyFingerprint || null,
    sourceTarget: report.sourceTarget,
    testTarget: report.testTarget,
    logicalExplanation: report.proposal ? report.proposal.logicalExplanation : null,
    validation: report.validation,
    audit: report.audit,
    diffSummary: report.diffSummary,
    commit: report.commit,
  };
}

function buildHandoffMarkdown(report) {
  const explanation = report.proposal ? report.proposal.logicalExplanation : null;
  return [
    '# Overnight Handoff',
    '',
    '## What I tried',
    `- ${explanation ? explanation.problem : 'No valid proposal was produced.'}`,
    '',
    '## Why this surface',
    `- ${explanation ? explanation.whyThisSurface : 'n/a'}`,
    '',
    '## Chosen targets',
    `- Source: ${report.sourceTarget ? `${report.sourceTarget.path} :: ${report.sourceTarget.symbol || report.sourceTarget.anchorText}` : 'n/a'}`,
    `- Test: ${report.testTarget ? `${report.testTarget.path} :: ${report.testTarget.anchorText}` : 'n/a'}`,
    '',
    '## What changed',
    ...report.diffSummary.files.map((filePath) => `- ${filePath}`),
    ...(report.diffSummary.files.length === 0 ? ['- No files were kept.'] : []),
    '',
    '## Validation',
    `- Quick validation passed: ${Boolean(summarizeValidation(report.validation.quick).overallPass)}`,
    `- Full validation passed: ${Boolean(summarizeValidation(report.validation.full).overallPass)}`,
    '',
    '## Audit gate',
    `- Verdict: ${report.audit ? report.audit.verdict : 'not-run'}`,
    ...(report.audit && Array.isArray(report.audit.blockers) && report.audit.blockers.length > 0 ? report.audit.blockers.map((entry) => `- Blocker: ${entry}`) : []),
    '',
    '## Failure stage',
    `- ${report.failureStage || 'n/a'}`,
    '',
    '## Next move',
    `- ${report.nextStep}`,
  ].join('\n');
}

function writeAttemptArtifacts(paths, report) {
  ensureDir(paths.attemptDir);
  writeJsonAtomic(paths.reportPath, report);
  writeJsonAtomic(paths.proofPath, buildProofPacket(report));
  writeJsonAtomic(paths.auditPath, report.audit || { verdict: 'not-run', blockers: [], evidence: [] });
  writeJsonAtomic(paths.proposalPath, report.proposal || null);
  writeJsonAtomic(paths.planPath, report.plan || null);
  writeJsonAtomic(paths.windowPath, report.windows || null);
  writeJsonAtomic(paths.editorProposalPath, report.editorProposal || null);
  fs.writeFileSync(paths.handoffPath, `${buildHandoffMarkdown(report)}\n`, 'utf8');
  return paths;
}

async function finalizeSurfaceAttempt(manifestPaths, report, surfacePaths, proofPath, handoffPath, ledgerEntry) {
  await updateOvernightManifest(manifestPaths, (manifest) => {
    const surfaceState = manifest.surfaces.find((entry) => entry.surfaceId === report.surfaceId);
    surfaceState.status = report.outcome;
    surfaceState.attemptCount += 1;
    surfaceState.latestAttemptId = report.attemptId;
    surfaceState.latestDecision = report.audit ? report.audit.verdict : null;
    surfaceState.latestReasonCode = report.reasonCode;
    surfaceState.latestProofPath = proofPath;
    surfaceState.latestHandoffPath = handoffPath;
    surfaceState.lastError = report.outcome === 'failed' ? (report.applyError && report.applyError.message) || report.reasonCode : null;
    surfaceState.cooled = report.reasonCode === 'surface-cooled-down';
    if (report.commit && report.commit.sha) {
      surfaceState.latestCommit = report.commit.sha;
      if (report.outcome === 'kept') {
        surfaceState.acceptedCommits.push({
          commit: report.commit.sha,
          summary: proposalSummary(report.proposal),
          attemptId: report.attemptId,
        });
        surfaceState.auditPending = false;
        surfaceState.frozen = true;
      } else if (report.outcome === 'pending-audit') {
        surfaceState.pendingAuditCommits.push({
          commit: report.commit.sha,
          summary: proposalSummary(report.proposal),
          attemptId: report.attemptId,
          proofPath,
          handoffPath,
        });
        surfaceState.auditPending = true;
        surfaceState.frozen = true;
      }
    }
    manifest.ledger.push(ledgerEntry);
  });
  const nextManifest = loadOvernightManifest(manifestPaths.manifestPath);
  const updatedSurfaceState = nextManifest.surfaces.find((entry) => entry.surfaceId === report.surfaceId);
  writeSurfaceStatus(updatedSurfaceState, {
    proofPath,
    handoffPath,
  });
  appendSurfaceHistory({
    surfaceId: report.surfaceId,
    historyPath: surfacePaths.historyPath,
  }, {
    type: 'attempt-finished',
    attemptId: report.attemptId,
    outcome: report.outcome,
    reasonCode: report.reasonCode,
  });
}

// gateProposal, getPatchFingerprintOrReject, recheckProposalAfterRepair
// — moved to overnight_engine_cooldown.cjs

function resolveSurfaceValidation(surface, adapter) {
  return {
    baseline: adapter.repo.baselineValidation,
    quick: surface.quickValidation.length > 0 ? surface.quickValidation : adapter.repo.baselineValidation,
    full: surface.fullValidation.length > 0 ? surface.fullValidation : adapter.repo.finalValidation,
  };
}

function buildSurfaceManifestRecord(reportRoot, worktreeRoot, adapter, surface, batchId) {
  const paths = buildSurfacePaths(reportRoot, worktreeRoot, surface.id);
  return {
    surfaceId: surface.id,
    title: surface.title,
    risk: surface.risk,
    worktreePath: paths.worktreePath,
    branchFamily: `${buildBatchBranchPrefix(adapter, batchId)}/${surface.id}`,
    statusPath: paths.statusPath,
    latestPath: paths.latestPath,
    historyPath: paths.historyPath,
    attemptsDir: paths.attemptsDir,
  };
}

function discardAttempt(report, details = {}) {
  report.outcome = 'discarded';
  report.reasonCode = details.reasonCode || 'discarded';
  report.nextStep = details.nextStep || 'Inspect the attempt report before retrying.';
  report.failureStage = details.failureStage || report.failureStage || 'discarded';
  report.failureKind = details.failureKind || report.failureKind || report.reasonCode;
  report.failedPath = details.failedPath || report.failedPath || null;
  report.failedSearchExcerpt = normalizeText(details.failedSearchExcerpt || report.failedSearchExcerpt);
  if (details.applyError) {
    report.applyError = {
      message: normalizeText(details.applyError && details.applyError.message ? details.applyError.message : details.applyError),
    };
  }
  return report;
}

function failAttempt(report, error, details = {}) {
  report.outcome = 'failed';
  report.reasonCode = details.reasonCode || 'worker-failed';
  report.nextStep = details.nextStep || 'Inspect the attempt failure before reopening this surface.';
  report.failureStage = details.failureStage || report.failureStage || 'worker';
  report.failureKind = details.failureKind || report.failureKind || report.reasonCode;
  report.failedPath = details.failedPath || report.failedPath || extractPatchPathFromError(error && error.message ? error.message : error) || null;
  report.failedSearchExcerpt = normalizeText(details.failedSearchExcerpt || report.failedSearchExcerpt);
  report.applyError = {
    message: normalizeText(error && error.message ? error.message : error),
  };
  return report;
}

async function executeLegacySurfaceAttempt(options) {
  const {
    adapter,
    objective,
    manifest,
    surface,
    surfaceState,
    surfacePaths,
    proposalLoader,
    reviewLoader,
    fetchFn,
    report,
    validationCommands,
    syntheticAuditDecision,
  } = options;
  let appliedPatchSet = null;
  let patchFingerprint = null;
  let patchFamilyFingerprint = null;
  let repairedForApply = false;
  try {
    const promptContext = buildPromptContext(adapter, objective, surface, surfacePaths.worktreePath);
    if (promptContext.focusFiles.length === 0) {
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'no-safe-change',
          nextStep: 'The context pack was empty for this surface. Tighten the adapter paths before retrying.',
          failureStage: 'proposal',
          failureKind: 'missing-context',
        }),
      };
    }
    const noRetryIdeas = sanitizeNoRetryIdeas(
      listNoRetryIdeas(mergedLedgerForNovelty(manifest), objective.objectiveHash, surface.id)
    );
    const prompt = buildProposalPrompt({
      context: promptContext,
      noRetryIdeas,
    });
    report.failureStage = 'proposal';
    const loaded = await loadProposalWithRepair(prompt, adapter.defaults.proposer, adapter.defaults.repairTurns, {
      proposalLoader,
      surface,
      objective,
      cwd: surfacePaths.worktreePath,
    });
    report.proposal = loaded.proposal;
    report.editorProposal = loaded.proposal;
    report.repairTurnsUsed = loaded.repairTurnsUsed;

    if (proposalHasNoChanges(report.proposal)) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'no-safe-change',
          nextStep: 'No bounded safe change was identified for this surface.',
          failureStage: 'proposal',
          failureKind: 'no-safe-change',
        }),
      };
    }

    const gate = gateProposal(adapter, objective, surface, report.proposal, manifest, surfaceState);
    if (!gate.ok) {
      patchFingerprint = createPatchFingerprint(objective.objectiveHash, surface.id, report.proposal);
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: gate.reasonCode,
          nextStep: gate.nextStep,
          failureStage: 'proposal',
          failureKind: gate.reasonCode,
        }),
      };
    }

    const novelty = getPatchFingerprintOrReject(manifest, objective.objectiveHash, surface.id, report.proposal);
    patchFingerprint = novelty.patchFingerprint;
    patchFamilyFingerprint = novelty.patchFamilyFingerprint;
    report.patchFamilyFingerprint = patchFamilyFingerprint;
    if (!novelty.ok) {
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report: discardAttempt(report, {
          reasonCode: novelty.duplicateKind === 'family' ? 'duplicate-family' : 'duplicate',
          nextStep: novelty.duplicateKind === 'family'
            ? 'Start from a materially different change family or a different anchor.'
            : 'Start from a materially different idea or wait for new evidence.',
          failureStage: 'proposal',
          failureKind: novelty.duplicateKind === 'family' ? 'duplicate-family' : 'duplicate',
        }),
      };
    }

    report.failureStage = 'apply';
    const combinedPatchSet = report.proposal.codeChanges.concat(report.proposal.testChanges);
    try {
      appliedPatchSet = applyPatchSetBounded(combinedPatchSet, surface, surfacePaths.worktreePath);
    } catch (error) {
      if (adapter.defaults.repairTurns <= report.repairTurnsUsed) {
        throw error;
      }
      const repairPrompt = buildRepairPrompt(prompt, JSON.stringify({
        logical_explanation: report.proposal.logicalExplanation,
        code_changes: report.proposal.codeChanges,
        test_changes: report.proposal.testChanges,
      }, null, 2), error.message, {
        cwd: surfacePaths.worktreePath,
        structuredError: extractStructuredError(error),
      });
      const repaired = await loadProposalWithRepair(repairPrompt, adapter.defaults.proposer, 0, {
        proposalLoader,
        surface,
        objective,
        cwd: surfacePaths.worktreePath,
      });
      const originalProposal = report.proposal;
      report.proposal = repaired.proposal;
      report.editorProposal = repaired.proposal;
      report.repairTurnsUsed += 1;
      if (proposalHasNoChanges(report.proposal)) {
        return {
          patchFingerprint,
          report: discardAttempt(report, {
            reasonCode: 'no-safe-change',
            nextStep: 'Repair collapsed into no safe change.',
            failureStage: 'apply',
            failureKind: 'no-safe-change',
          }),
        };
      }
      const repairedCheck = recheckProposalAfterRepair({
        adapter,
        objective,
        surface,
        manifest,
        surfaceState,
        originalProposal,
        proposal: report.proposal,
      });
      patchFingerprint = repairedCheck.patchFingerprint;
      patchFamilyFingerprint = repairedCheck.patchFamilyFingerprint;
      report.patchFamilyFingerprint = patchFamilyFingerprint;
      if (!repairedCheck.ok) {
        return {
          patchFingerprint,
          patchFamilyFingerprint,
          report: discardAttempt(report, {
            reasonCode: repairedCheck.reasonCode,
            nextStep: repairedCheck.nextStep,
            failureStage: 'apply',
            failureKind: repairedCheck.reasonCode,
          }),
        };
      }
      appliedPatchSet = applyPatchSetBounded(
        report.proposal.codeChanges.concat(report.proposal.testChanges),
        surface,
        surfacePaths.worktreePath,
      );
      repairedForApply = true;
    }

    report.diffSummary.files = appliedPatchSet.files.map((entry) => entry.path);
    report.diffSummary.addedLines = appliedPatchSet.summary.addedLines;
    report.diffSummary.removedLines = appliedPatchSet.summary.removedLines;
    report.diffSummary.netLineDelta = appliedPatchSet.summary.netLineDelta;

    report.failureStage = 'validation';
    let quickValidation = runValidationPlan(validationCommands.quick, surfacePaths.worktreePath);
    if (!summarizeValidation(quickValidation).overallPass && classifySyntaxFailure(quickValidation) && report.repairTurnsUsed < adapter.defaults.repairTurns) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      const repairPrompt = buildRepairPrompt(prompt, JSON.stringify({
        logical_explanation: report.proposal.logicalExplanation,
        code_changes: report.proposal.codeChanges,
        test_changes: report.proposal.testChanges,
      }, null, 2), 'Quick validation failed with a syntax-oriented error.', {
        cwd: surfacePaths.worktreePath,
      });
      const repaired = await loadProposalWithRepair(repairPrompt, adapter.defaults.proposer, 0, {
        proposalLoader,
        surface,
        objective,
        cwd: surfacePaths.worktreePath,
      });
      const originalProposal = report.proposal;
      report.proposal = repaired.proposal;
      report.editorProposal = repaired.proposal;
      report.repairTurnsUsed += 1;
      if (proposalHasNoChanges(report.proposal)) {
        return {
          patchFingerprint,
          report: discardAttempt(report, {
            reasonCode: 'no-safe-change',
            nextStep: 'Validation repair collapsed into no safe change.',
            failureStage: 'validation',
            failureKind: 'no-safe-change',
          }),
        };
      }
      const repairedCheck = recheckProposalAfterRepair({
        adapter,
        objective,
        surface,
        manifest,
        surfaceState,
        originalProposal,
        proposal: report.proposal,
      });
      patchFingerprint = repairedCheck.patchFingerprint;
      patchFamilyFingerprint = repairedCheck.patchFamilyFingerprint;
      report.patchFamilyFingerprint = patchFamilyFingerprint;
      if (!repairedCheck.ok) {
        return {
          patchFingerprint,
          patchFamilyFingerprint,
          report: discardAttempt(report, {
            reasonCode: repairedCheck.reasonCode,
            nextStep: repairedCheck.nextStep,
            failureStage: 'validation',
            failureKind: repairedCheck.reasonCode,
          }),
        };
      }
      appliedPatchSet = applyPatchSetBounded(
        report.proposal.codeChanges.concat(report.proposal.testChanges),
        surface,
        surfacePaths.worktreePath,
      );
      quickValidation = runValidationPlan(validationCommands.quick, surfacePaths.worktreePath);
    }
    report.validation.quick = quickValidation;
    if (!summarizeValidation(quickValidation).overallPass) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'validation-failed',
          nextStep: repairedForApply
            ? 'The repaired proposal still failed validation; try a smaller change.'
            : 'Tighten the change and add stronger tests before retrying.',
          failureStage: 'validation',
          failureKind: 'validation-failed',
        }),
      };
    }

    const fullValidation = runValidationPlan(validationCommands.full, surfacePaths.worktreePath);
    report.validation.full = fullValidation;
    if (!summarizeValidation(fullValidation).overallPass) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'full-validation-failed',
          nextStep: 'Keep the proof local and retry with a smaller change.',
          failureStage: 'validation',
          failureKind: 'full-validation-failed',
        }),
      };
    }

    report.diffSummary.unifiedDiff = buildUnifiedDiff(surfacePaths.worktreePath, report.diffSummary.files);
    report.failureStage = 'audit';
    report.audit = await runAuditGate({
      packet: buildAuditPacket({
        objective,
        surface,
        proposal: report.proposal,
        baseline: report.validation.baseline,
        quickValidation,
        fullValidation,
        unifiedDiff: report.diffSummary.unifiedDiff,
      }),
      config: adapter.defaults.audit,
      reviewLoader,
      fetchFn,
      syntheticDecision: syntheticAuditDecision || null,
    });
    if (!report.audit) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'audit-reject',
          nextStep: 'Use the audit blockers as the next design brief.',
          failureStage: 'audit',
          failureKind: 'audit-reject',
        }),
      };
    }
    if (report.audit.verdict === 'deferred') {
      report.failureStage = 'audit';
      const commit = commitAcceptedIteration({
        cwd: surfacePaths.worktreePath,
        summary: proposalSummary(report.proposal),
        appliedChangeSet: {
          files: appliedPatchSet.files,
        },
      });
      if (commit.skipped) {
        return {
          patchFingerprint,
          report: discardAttempt(report, {
            reasonCode: 'no-staged-diff',
            nextStep: 'No persistent diff remained after validation.',
            failureStage: 'commit',
            failureKind: 'no-staged-diff',
          }),
        };
      }
      report.commit = commit;
      report.outcome = 'pending-audit';
      report.reasonCode = 'awaiting-codex-audit';
      report.nextStep = 'Run the deferred Codex audit before morning promotion.';
      report.failureKind = 'awaiting-codex-audit';
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report,
      };
    }
    if (report.audit.verdict !== 'accept') {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'audit-reject',
          nextStep: 'Use the audit blockers as the next design brief.',
          failureStage: 'audit',
          failureKind: 'audit-reject',
        }),
      };
    }

    report.failureStage = 'commit';
    const commit = commitAcceptedIteration({
      cwd: surfacePaths.worktreePath,
      summary: proposalSummary(report.proposal),
      appliedChangeSet: {
        files: appliedPatchSet.files,
      },
    });
    if (commit.skipped) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'no-staged-diff',
          nextStep: 'No persistent diff remained after validation.',
          failureStage: 'commit',
          failureKind: 'no-staged-diff',
        }),
      };
    }
    report.commit = commit;
    report.outcome = 'kept';
    report.reasonCode = 'accepted';
    report.nextStep = 'This surface is ready for manual morning promotion.';
    report.failureStage = 'accepted';
    report.failureKind = null;
    return {
      patchFingerprint,
      patchFamilyFingerprint,
      report,
    };
  } catch (error) {
    if (appliedPatchSet) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
    }
    return {
      patchFingerprint,
      patchFamilyFingerprint,
      report: failAttempt(report, error),
    };
  }
}

/**
 * Planner-only execution: call the planner, capture the plan, short-circuit.
 *
 * No editor call, no window building, no SEARCH/REPLACE application, no validation,
 * no commit. The attempt is recorded as `plan-only` with the plan object preserved
 * in report.plan so human reviewers can read it in the morning. This mode exists
 * because 46% of staged-mode attempts die at the editor stage — a planner-only
 * loop captures the model's diagnostic value (which is the bulk of the signal)
 * at a fraction of the per-attempt cost (~15s vs ~60s).
 *
 * A kept-but-unvalidated plan is NOT a patch and is NOT promotable. It's a
 * structured reconnaissance artifact.
 */
async function executePlannerOnlySurfaceAttempt(options) {
  const {
    adapter,
    objective,
    manifest,
    surface,
    surfaceState,
    surfacePaths,
    proposalLoader,
    report,
  } = options;
  const repairBudget = Math.min(1, Math.max(0, Number(adapter.defaults.repairTurns) || 0));
  let targetLockPath = null;
  try {
    const promptContext = buildPromptContext(adapter, objective, surface, surfacePaths.worktreePath);
    if (promptContext.focusFiles.length === 0) {
      return {
        patchFingerprint: null,
        patchFamilyFingerprint: null,
        report: discardAttempt(report, {
          reasonCode: 'no-safe-change',
          nextStep: 'Empty context pack for this surface. Tighten the adapter paths before retrying.',
          failureStage: 'planning',
          failureKind: 'missing-context',
        }),
      };
    }
    const mergedLedger = mergedLedgerForNovelty(manifest);
    const noRetryIdeas = sanitizeNoRetryIdeas(
      listNoRetryIdeas(mergedLedger, objective.objectiveHash, surface.id)
    );
    const plannerAnchorFailures = listAnchorFailures(mergedLedger, objective.objectiveHash, surface.id);
    const exploredTargets = listExploredTargets(mergedLedger, objective.objectiveHash, surface.id);
    const candidates = mineSurfaceCandidates(adapter, surface, surfacePaths.worktreePath);
    const plannerPrompt = buildPlannerPrompt({
      context: promptContext,
      candidates,
      noRetryIdeas,
      anchorFailures: plannerAnchorFailures,
      exploredTargets,
    });

    report.failureStage = 'planning';
    let loadedPlan;
    try {
      loadedPlan = await loadPlannerWithRepair(
        plannerPrompt,
        adapter.defaults.proposer,
        Math.max(0, repairBudget - report.repairTurnsUsed),
        {
          proposalLoader,
          surface,
          objective,
          requestKind: 'planner',
          repairRequestKind: 'planner-repair',
        },
      );
    } catch (error) {
      // Debug note (subagent-mode discovery): previously every planner
      // failure — including auth/env/network issues where the model
      // never even got called — was mislabeled as `planner-schema-
      // failed`, hiding the real cause (MISSING_API_KEY,
      // MODEL_EXTERNAL_COMMAND_TIMEOUT, etc.) under a schema-shaped
      // reason code. Operators debugging 100+ discarded attempts had
      // no hint that their credentials weren't configured. Classify
      // first: model-call / auth / network / spawn failures get
      // `planner-call-failed`; only real parser/schema errors stay
      // as `planner-schema-failed`.
      const CALL_LEVEL_CODES = new Set([
        'MISSING_API_KEY',
        'MODEL_AUTH_401',
        'MODEL_CALL_TIMEOUT',
        'MODEL_CALL_FAILED',
        'MODEL_EXTERNAL_COMMAND_REQUIRED',
        'MODEL_EXTERNAL_COMMAND_TIMEOUT',
        'MODEL_EXTERNAL_COMMAND_SPAWN_FAILED',
        'MODEL_EXTERNAL_COMMAND_FAILED',
        'MODEL_EXTERNAL_COMMAND_INVALID_JSON',
        'MODEL_RESPONSE_TOO_LARGE',
        'MODEL_RESPONSE_TRUNCATED',
        'MODEL_SCHEMA_MISMATCH',
      ]);
      const errorCode = error && error.code ? error.code : null;
      const isCallLevel = errorCode && CALL_LEVEL_CODES.has(errorCode);
      return {
        patchFingerprint: null,
        report: discardAttempt(report, {
          reasonCode: isCallLevel ? 'planner-call-failed' : 'planner-schema-failed',
          nextStep: isCallLevel
            ? `Fix the model call (${errorCode}) before the planner can run.`
            : 'Repair the planner JSON or return no_safe_change.',
          failureStage: 'planning',
          failureKind: isCallLevel ? 'planner-call-failed' : 'planner-schema-failed',
          applyError: error,
          plannerErrorCode: errorCode,
        }),
      };
    }
    report.plan = loadedPlan.plan;
    report.repairTurnsUsed += loadedPlan.repairTurnsUsed;

    if (report.plan && report.plan.decision === 'no_safe_change') {
      return {
        patchFingerprint: null,
        report: discardAttempt(report, {
          reasonCode: 'no-safe-change',
          nextStep: 'Planner returned no_safe_change for this surface.',
          failureStage: 'planning',
          failureKind: 'no-safe-change',
        }),
      };
    }

    // Run the same planner gate the staged path uses. This enforces scope,
    // manual-only, forbidden-path, dup-candidate, dup-target, and cool-down
    // checks for planner-only attempts — without it, planner-only bypasses
    // every novelty guarantee the staged path relies on (burst1-3 bug).
    // Pass manifest (not pre-merged ledger) so the gate can distinguish
    // novelty (cross-batch) from cool-down (per-batch) internally.
    const plannerGate = gatePlannerDecision(adapter, objective, surface, report.plan, manifest, surfaceState);
    if (plannerGate.noSafeChange) {
      return {
        patchFingerprint: null,
        report: discardAttempt(report, {
          reasonCode: 'no-safe-change',
          nextStep: 'Planner did not identify a safe bounded target pair.',
          failureStage: 'planning',
          failureKind: 'no-safe-change',
        }),
      };
    }
    if (!plannerGate.ok) {
      return {
        patchFingerprint: null,
        report: discardAttempt(report, {
          reasonCode: plannerGate.reasonCode,
          nextStep: plannerGate.nextStep,
          failureStage: 'planning',
          failureKind: plannerGate.reasonCode,
        }),
      };
    }
    report.candidateFingerprint = plannerGate.candidateFingerprint;

    // In-flight target reservation. Parallel workers pick the same "best"
    // target before any has written its manifest; the atomic lock closes
    // that race. Stale locks (>10 min) are stolen so crashed workers don't
    // block slots forever.
    const reservation = acquireTargetLock(manifest, surface.id, report.plan.sourceTarget);
    if (!reservation.acquired) {
      return {
        patchFingerprint: null,
        report: discardAttempt(report, {
          reasonCode: 'duplicate-target-inflight',
          nextStep: `Another parallel worker is already planning ${report.plan.sourceTarget && report.plan.sourceTarget.path}::${(report.plan.sourceTarget && (report.plan.sourceTarget.symbol || report.plan.sourceTarget.anchorText)) || ''}. Pick a different target on the next attempt.`,
          failureStage: 'planning',
          failureKind: 'duplicate-target-inflight',
        }),
      };
    }
    targetLockPath = reservation.lockPath;

    // Capture the plan as the terminal result. No editor, no validation, no commit.
    report.sourceTarget = report.plan.sourceTarget || null;
    report.testTarget = report.plan.testTarget || null;
    report.outcome = 'plan-only';
    report.reasonCode = 'plan-captured';
    report.nextStep = 'Review the plan. If the idea is useful, land the patch by hand or re-run under staged mode with this plan pinned.';
    report.failureStage = 'plan-captured';
    report.failureKind = null;
    return {
      patchFingerprint: null,
      patchFamilyFingerprint: null,
      report,
    };
  } catch (error) {
    return {
      patchFingerprint: null,
      patchFamilyFingerprint: null,
      report: failAttempt(report, error, { failureStage: 'planning' }),
    };
  } finally {
    // Release the lock on every exit path — success, rejection, or crash.
    // Plan-only attempts don't need a long-held lock because the work is
    // instantaneous once the plan is captured.
    releaseTargetLock(targetLockPath);
  }
}

async function executeStagedSurfaceAttempt(options) {
  const {
    adapter,
    objective,
    manifest,
    surface,
    surfaceState,
    surfacePaths,
    proposalLoader,
    reviewLoader,
    fetchFn,
    report,
    validationCommands,
    syntheticAuditDecision,
    pinnedPlan,
  } = options;
  const stagedRepairBudget = Math.min(1, Math.max(0, Number(adapter.defaults.repairTurns) || 0));
  let appliedPatchSet = null;
  let patchFingerprint = null;
  let patchFamilyFingerprint = null;
  try {
    const promptContext = buildPromptContext(adapter, objective, surface, surfacePaths.worktreePath);
    if (promptContext.focusFiles.length === 0) {
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'no-safe-change',
          nextStep: 'The context pack was empty for this surface. Tighten the adapter paths before retrying.',
          failureStage: 'planning',
          failureKind: 'missing-context',
        }),
      };
    }
    const mergedLedger = mergedLedgerForNovelty(manifest);
    const noRetryIdeas = sanitizeNoRetryIdeas(
      listNoRetryIdeas(mergedLedger, objective.objectiveHash, surface.id)
    );
    const plannerAnchorFailures = listAnchorFailures(mergedLedger, objective.objectiveHash, surface.id);
    const exploredTargets = listExploredTargets(mergedLedger, objective.objectiveHash, surface.id);
    const candidates = mineSurfaceCandidates(adapter, surface, surfacePaths.worktreePath);

    // Hybrid mode: if a pinned plan was supplied (e.g. harvested from a
    // prior planner-only burst), skip the planner call entirely and use the
    // pre-captured plan as the terminal plan. The editor, gate, windows,
    // validation, and commit stages still run exactly as they would for a
    // fresh planner output — the only thing we bypass is the model call.
    // This turns ~500 captured plans into ~500 actual staged attempts
    // without paying the planner latency a second time.
    let loadedPlan;
    if (pinnedPlan && pinnedPlan.sourceTarget && pinnedPlan.sourceTarget.path) {
      report.failureStage = 'planning';
      loadedPlan = { plan: pinnedPlan, repairTurnsUsed: 0 };
    } else {
      const plannerPrompt = buildPlannerPrompt({
        context: promptContext,
        candidates,
        noRetryIdeas,
        anchorFailures: plannerAnchorFailures,
        exploredTargets,
      });
      report.failureStage = 'planning';
      try {
        loadedPlan = await loadPlannerWithRepair(
          plannerPrompt,
          adapter.defaults.proposer,
          Math.max(0, stagedRepairBudget - report.repairTurnsUsed),
          {
            proposalLoader,
            surface,
            objective,
            requestKind: 'planner',
            repairRequestKind: 'planner-repair',
          },
        );
      } catch (error) {
        return {
          patchFingerprint,
          report: discardAttempt(report, (() => {
            // Mirror the round-1 classification: call-level errors
            // should not masquerade as schema errors.
            const CALL_LEVEL_CODES = new Set([
              'MISSING_API_KEY',
              'MODEL_AUTH_401',
              'MODEL_CALL_TIMEOUT',
              'MODEL_CALL_FAILED',
              'MODEL_EXTERNAL_COMMAND_REQUIRED',
              'MODEL_EXTERNAL_COMMAND_TIMEOUT',
              'MODEL_EXTERNAL_COMMAND_SPAWN_FAILED',
              'MODEL_EXTERNAL_COMMAND_FAILED',
              'MODEL_EXTERNAL_COMMAND_INVALID_JSON',
              'MODEL_RESPONSE_TOO_LARGE',
              'MODEL_RESPONSE_TRUNCATED',
              'MODEL_SCHEMA_MISMATCH',
            ]);
            const errorCode = error && error.code ? error.code : null;
            const isCallLevel = errorCode && CALL_LEVEL_CODES.has(errorCode);
            return {
              reasonCode: isCallLevel ? 'planner-call-failed' : 'planner-schema-failed',
              nextStep: isCallLevel
                ? `Fix the model call (${errorCode}) before the planner can run.`
                : 'Repair the planner JSON or return no_safe_change.',
              failureStage: 'planning',
              failureKind: isCallLevel ? 'planner-call-failed' : 'planner-schema-failed',
              applyError: error,
              plannerErrorCode: errorCode,
            };
          })()),
        };
      }
    }
    report.plan = loadedPlan.plan;
    report.repairTurnsUsed += loadedPlan.repairTurnsUsed || 0;

    const plannerGate = gatePlannerDecision(adapter, objective, surface, report.plan, manifest, surfaceState);
    if (plannerGate.noSafeChange) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'no-safe-change',
          nextStep: 'Planner did not identify a safe bounded target pair.',
          failureStage: 'planning',
          failureKind: 'no-safe-change',
        }),
      };
    }
    if (!plannerGate.ok) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: plannerGate.reasonCode,
          nextStep: plannerGate.nextStep,
          failureStage: 'planning',
          failureKind: plannerGate.reasonCode,
        }),
      };
    }
    report.candidateFingerprint = plannerGate.candidateFingerprint;
    report.sourceTarget = report.plan.sourceTarget;
    report.testTarget = report.plan.testTarget;

    // In-flight target reservation for parallel workers. Staged mode holds
    // the lock through window-build, editor, validation, and commit so no
    // other worker steals the target mid-run. Released in the outer
    // runSurfaceAttempt finally via options.targetLockRef.
    const stagedReservation = acquireTargetLock(manifest, surface.id, report.plan.sourceTarget);
    if (!stagedReservation.acquired) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'duplicate-target-inflight',
          nextStep: `Another parallel worker is already working on ${report.plan.sourceTarget && report.plan.sourceTarget.path}. Pick a different target on the next attempt.`,
          failureStage: 'planning',
          failureKind: 'duplicate-target-inflight',
        }),
      };
    }
    if (options.targetLockRef) {
      options.targetLockRef.lockPath = stagedReservation.lockPath;
    }

    try {
      const windows = buildTargetWindows({
        repoRoot: surfacePaths.worktreePath,
        plan: report.plan,
        lineCap: adapter.defaults.staged.windowLineCap,
      });
      report.windows = windows;
      report.windowFingerprint = windows.windowFingerprint;
    } catch (error) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'invalid-target-window',
          nextStep: 'Pick a source/test pair with a stable named anchor.',
          failureStage: 'windowing',
          failureKind: 'invalid-target-window',
          failedPath: extractPatchPathFromError(error && error.message ? error.message : error) || report.sourceTarget.path,
          applyError: error,
        }),
      };
    }

    report.failureStage = 'editing';
    const editorAnchorFailures = listAnchorFailures(mergedLedgerForNovelty(manifest), objective.objectiveHash, surface.id, report.sourceTarget);
    const editorPrompt = buildEditorPrompt({
      context: promptContext,
      plan: report.plan,
      windows: report.windows,
      noRetryIdeas,
      anchorFailures: editorAnchorFailures,
    });
    let loadedEditor;
    try {
      loadedEditor = await loadStructuredResponseWithRepair(
        editorPrompt,
        adapter.defaults.proposer,
        Math.max(0, stagedRepairBudget - report.repairTurnsUsed),
        parseProposal,
        (currentPrompt, originalText, errorMessage) => buildEditorRepairPrompt({
          prompt: currentPrompt,
          originalText,
          errorMessage,
          plan: report.plan,
          windows: report.windows,
        }),
        {
          proposalLoader,
          surface,
          objective,
          requestKind: 'editor',
          repairRequestKind: 'editor-repair',
        },
      );
    } catch (error) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'editor-schema-failed',
          nextStep: 'Repair the editor JSON so it matches the staged contract.',
          failureStage: 'editing',
          failureKind: 'editor-schema-failed',
          applyError: error,
        }),
      };
    }
    report.repairTurnsUsed += loadedEditor.repairTurnsUsed;
    report.proposal = loadedEditor.parsed;
    report.editorProposal = loadedEditor.parsed;

    let stagedCheck = validateStagedEditorProposal({
      proposal: report.proposal,
      plan: report.plan,
      windows: report.windows,
      staged: adapter.defaults.staged,
    });
    if (!stagedCheck.ok && stagedCheck.reasonCode === 'anchor-preflight-failed' && report.repairTurnsUsed < stagedRepairBudget) {
      const repairPrompt = buildEditorRepairPrompt({
        prompt: editorPrompt,
        originalText: loadedEditor.response.text,
        errorMessage: stagedCheck.errorMessage || stagedCheck.nextStep,
        plan: report.plan,
        windows: report.windows,
      });
      const repairResponse = await callProposer(repairPrompt, adapter.defaults.proposer, {
        proposalLoader,
        surface,
        objective,
        requestKind: 'editor-repair',
        errorMessage: stagedCheck.errorMessage || stagedCheck.nextStep,
        priorText: loadedEditor.response.text,
      });
      const originalProposal = report.proposal;
      report.repairTurnsUsed += 1;
      try {
        report.proposal = parseProposal(repairResponse.text);
        report.editorProposal = report.proposal;
      } catch (error) {
        return {
          patchFingerprint,
          report: discardAttempt(report, {
            reasonCode: 'editor-schema-failed',
            nextStep: 'The staged repair still failed to return valid JSON.',
            failureStage: 'editing',
            failureKind: 'editor-schema-failed',
            applyError: error,
          }),
        };
      }
      const compatibility = checkRepairCompatibility(originalProposal, report.proposal);
      if (!compatibility.ok) {
        patchFingerprint = createPatchFingerprint(objective.objectiveHash, surface.id, report.proposal);
        patchFamilyFingerprint = createPatchFamilyFingerprint(objective.objectiveHash, surface.id, report.proposal, {
          sourceTarget: report.sourceTarget,
          testTarget: report.testTarget,
        });
        report.patchFamilyFingerprint = patchFamilyFingerprint;
        return {
          patchFingerprint,
          patchFamilyFingerprint,
          report: discardAttempt(report, {
            reasonCode: compatibility.reasonCode,
            nextStep: compatibility.nextStep,
            failureStage: 'editing',
            failureKind: compatibility.reasonCode,
          }),
        };
      }
      stagedCheck = validateStagedEditorProposal({
        proposal: report.proposal,
        plan: report.plan,
        windows: report.windows,
        staged: adapter.defaults.staged,
      });
    }

    if (!stagedCheck.ok) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: stagedCheck.reasonCode,
          nextStep: stagedCheck.nextStep,
          failureStage: stagedCheck.failureStage,
          failureKind: stagedCheck.failureKind,
          failedPath: stagedCheck.failedPath,
          failedSearchExcerpt: stagedCheck.failedSearchExcerpt,
          applyError: stagedCheck.errorMessage ? { message: stagedCheck.errorMessage } : null,
        }),
      };
    }

    const gate = gateProposal(adapter, objective, surface, report.proposal, manifest, surfaceState);
    if (!gate.ok) {
      patchFingerprint = createPatchFingerprint(objective.objectiveHash, surface.id, report.proposal);
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: gate.reasonCode,
          nextStep: gate.nextStep,
          failureStage: 'editing',
          failureKind: gate.reasonCode,
        }),
      };
    }

    const novelty = getPatchFingerprintOrReject(manifest, objective.objectiveHash, surface.id, report.proposal);
    patchFingerprint = novelty.patchFingerprint;
    patchFamilyFingerprint = novelty.patchFamilyFingerprint;
    report.patchFamilyFingerprint = patchFamilyFingerprint;
    if (!novelty.ok) {
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report: discardAttempt(report, {
          reasonCode: novelty.duplicateKind === 'family' ? 'duplicate-family' : 'duplicate',
          nextStep: novelty.duplicateKind === 'family'
            ? 'Start from a materially different change family or a different anchor.'
            : 'Start from a materially different idea or wait for new evidence.',
          failureStage: 'editing',
          failureKind: novelty.duplicateKind === 'family' ? 'duplicate-family' : 'duplicate',
        }),
      };
    }

    // Hallucinated-reference gate: fact-check the proposal's replace blocks
    // against the real filesystem. Catches burst7's most common failure mode
    // (referencing npm scripts / file paths that the model invented). Runs
    // BEFORE applyPatchSet so a hallucinated reference doesn't even reach the
    // commit stage, saving the ~50s of test-suite wall time per doomed attempt.
    const referenceCheck = verifyProposalReferences(report.proposal, {
      repoRoot: surfacePaths.worktreePath,
    });
    if (!referenceCheck.ok) {
      const summary = summarizeHallucinated(referenceCheck.hallucinated);
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'hallucinated-reference',
          nextStep: `Remove or fix these invented references before retrying: ${summary}`,
          failureStage: 'reference-check',
          failureKind: 'hallucinated-reference',
          failedPath: referenceCheck.hallucinated[0] && referenceCheck.hallucinated[0].path,
          applyError: { message: `Hallucinated references: ${summary}` },
        }),
      };
    }

    report.failureStage = 'apply';
    try {
      appliedPatchSet = applyPatchSetBounded(
        report.proposal.codeChanges.concat(report.proposal.testChanges),
        surface,
        surfacePaths.worktreePath,
      );
    } catch (error) {
      // Audit round-4 P1#3: PATCH_VERIFICATION_DRIFT means another writer
      // modified a target file between preflight and apply.  Record it as a
      // distinct rejection reason so the ledger surfaces the race explicitly
      // instead of miscategorising it as anchor-preflight-failed.
      const code = error && error.code ? String(error.code) : '';
      if (code === 'PATCH_VERIFICATION_DRIFT') {
        return {
          patchFingerprint,
          report: discardAttempt(report, {
            reasonCode: 'verification-drift',
            nextStep: 'A concurrent writer modified the target file between preflight and apply. Retry on a quieter worktree or smaller window.',
            failureStage: 'apply',
            failureKind: 'verification-drift',
            failedPath: extractPatchPathFromError(error && error.message ? error.message : error) || report.sourceTarget.path,
            applyError: error,
          }),
        };
      }
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'anchor-preflight-failed',
          nextStep: 'The staged patch still did not land cleanly inside the chosen windows.',
          failureStage: 'apply',
          failureKind: 'anchor-preflight-failed',
          failedPath: extractPatchPathFromError(error && error.message ? error.message : error) || report.sourceTarget.path,
          failedSearchExcerpt: report.proposal.codeChanges[0] ? report.proposal.codeChanges[0].search : '',
          applyError: error,
        }),
      };
    }

    report.diffSummary.files = appliedPatchSet.files.map((entry) => entry.path);
    report.diffSummary.addedLines = appliedPatchSet.summary.addedLines;
    report.diffSummary.removedLines = appliedPatchSet.summary.removedLines;
    report.diffSummary.netLineDelta = appliedPatchSet.summary.netLineDelta;

    report.failureStage = 'validation';
    const quickValidation = runValidationPlan(validationCommands.quick, surfacePaths.worktreePath);
    report.validation.quick = quickValidation;
    if (!summarizeValidation(quickValidation).overallPass) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'validation-failed',
          nextStep: 'Keep the staged change smaller or strengthen the paired test proof.',
          failureStage: 'validation',
          failureKind: 'validation-failed',
        }),
      };
    }

    const fullValidation = runValidationPlan(validationCommands.full, surfacePaths.worktreePath);
    report.validation.full = fullValidation;
    if (!summarizeValidation(fullValidation).overallPass) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'full-validation-failed',
          nextStep: 'Keep the proof local and retry with a smaller staged change.',
          failureStage: 'validation',
          failureKind: 'full-validation-failed',
        }),
      };
    }

    report.diffSummary.unifiedDiff = buildUnifiedDiff(surfacePaths.worktreePath, report.diffSummary.files);
    report.failureStage = 'audit';
    report.audit = await runAuditGate({
      packet: buildAuditPacket({
        objective,
        surface,
        proposal: report.proposal,
        baseline: report.validation.baseline,
        quickValidation,
        fullValidation,
        unifiedDiff: report.diffSummary.unifiedDiff,
      }),
      config: adapter.defaults.audit,
      reviewLoader,
      fetchFn,
      syntheticDecision: syntheticAuditDecision || null,
    });
    if (!report.audit) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'audit-reject',
          nextStep: 'Use the audit blockers as the next design brief.',
          failureStage: 'audit',
          failureKind: 'audit-reject',
        }),
      };
    }
    if (report.audit.verdict === 'deferred') {
      report.failureStage = 'audit';
      const commit = commitAcceptedIteration({
        cwd: surfacePaths.worktreePath,
        summary: proposalSummary(report.proposal),
        appliedChangeSet: {
          files: appliedPatchSet.files,
        },
      });
      if (commit.skipped) {
        return {
          patchFingerprint,
          report: discardAttempt(report, {
            reasonCode: 'no-staged-diff',
            nextStep: 'No persistent diff remained after validation.',
            failureStage: 'commit',
            failureKind: 'no-staged-diff',
          }),
        };
      }
      report.commit = commit;
      report.outcome = 'pending-audit';
      report.reasonCode = 'awaiting-codex-audit';
      report.nextStep = 'Run the deferred Codex audit before morning promotion.';
      report.failureKind = 'awaiting-codex-audit';
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report,
      };
    }
    if (report.audit.verdict !== 'accept') {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
      return {
        patchFingerprint,
        patchFamilyFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'audit-reject',
          nextStep: 'Use the audit blockers as the next design brief.',
          failureStage: 'audit',
          failureKind: 'audit-reject',
        }),
      };
    }

    report.failureStage = 'commit';
    const commit = commitAcceptedIteration({
      cwd: surfacePaths.worktreePath,
      summary: proposalSummary(report.proposal),
      appliedChangeSet: {
        files: appliedPatchSet.files,
      },
    });
    if (commit.skipped) {
      return {
        patchFingerprint,
        report: discardAttempt(report, {
          reasonCode: 'no-staged-diff',
          nextStep: 'No persistent diff remained after validation.',
          failureStage: 'commit',
          failureKind: 'no-staged-diff',
        }),
      };
    }
    report.commit = commit;
    report.outcome = 'kept';
    report.reasonCode = 'accepted';
    report.nextStep = 'This surface is ready for manual morning promotion.';
    report.failureStage = 'accepted';
    report.failureKind = null;
    return {
      patchFingerprint,
      patchFamilyFingerprint,
      report,
    };
  } catch (error) {
    if (appliedPatchSet) {
      rollbackAppliedPatchSet(appliedPatchSet);
      report.rollbackApplied = true;
    }
    return {
      patchFingerprint,
      patchFamilyFingerprint,
      report: failAttempt(report, error),
    };
  }
}

async function runSurfaceAttempt(options) {
  const {
    adapter,
    objective,
    manifestPaths,
    manifest,
    surface,
    proposalLoader,
    reviewLoader,
    fetchFn,
  } = options;
  const proposalMode = normalizeProposalMode(options.proposalMode || adapter.defaults.proposalMode || 'legacy');
  const surfaceState = manifest.surfaces.find((entry) => entry.surfaceId === surface.id);
  const attemptId = buildAttemptId(surfaceState.attemptCount + 1);
  const surfacePaths = buildSurfacePaths(manifest.reportRoot, manifest.worktreeRoot, surface.id);
  const attemptPaths = buildAttemptPaths(manifestPaths.rootDir, surface.id, attemptId);
  const branchName = buildSurfaceBranchName(adapter, manifest.batchId, surface.id, attemptId);
  // Audit round-4 P2#4: wrap the whole createWorktree → removeWorktree span
  // in an outer try/finally so a throw at ANY point (worktree creation,
  // status write, validation, artifact write, finalize) still runs the
  // cleanup.  Previously only applyPatchSet was guarded; a throw during
  // writeAttemptArtifacts or finalizeSurfaceAttempt would leak the worktree
  // and its branch.  The inner cleanup swallows its own errors so a failed
  // removeWorktree never masks the original exception.
  let worktreeCreated = false;
  try {
    createWorktree(adapter.repoRoot, {
      worktreePath: surfacePaths.worktreePath,
      branchName,
      startPoint: manifest.baseCommit,
    });
    worktreeCreated = true;
    writeSurfaceStatus({
      ...surfaceState,
      status: 'running',
      latestAttemptId: attemptId,
    }, {
      branchName,
    });
    appendOvernightEvent(manifestPaths, {
      type: 'surface-started',
      surfaceId: surface.id,
      attemptId,
      proposalMode,
    });

    const report = createAttemptReport({
      batchId: manifest.batchId,
      objectiveHash: objective.objectiveHash,
      surface,
      attemptId,
      startedAt: nowIso(),
      baseCommit: manifest.baseCommit,
      pipelineMode: proposalMode,
    });
    const validationCommands = resolveSurfaceValidation(surface, adapter);
    const baseline = runValidationPlan(validationCommands.baseline, surfacePaths.worktreePath);
    report.validation.baseline = baseline;
    let patchFingerprint = null;
    let patchFamilyFingerprint = null;
    // targetLockRef is populated by the staged executor when it reserves a
    // target. Scoped outside the try so the outer finally can always release
    // it, even on exceptions mid-run.
    const targetLockRef = { lockPath: null };
    try {
      if (gitStatus(surfacePaths.worktreePath).length > 0) {
        throw new AdapterError(
          'WORKTREE_DIRTY',
          'worktreePath',
          'Surface worktree must start clean.',
          { fixHint: 'Stash or commit any pending changes in the worktree before running the engine.' }
        );
      }
      let execution;
      if (proposalMode === 'planner-only') {
        execution = await executePlannerOnlySurfaceAttempt({
          adapter,
          objective,
          manifest,
          surface,
          surfaceState,
          surfacePaths,
          proposalLoader,
          report,
        });
      } else if (proposalMode === 'staged') {
        execution = await executeStagedSurfaceAttempt({
          adapter,
          objective,
          manifest,
          surface,
          surfaceState,
          surfacePaths,
          proposalLoader,
          reviewLoader,
          fetchFn,
          report,
          validationCommands,
          syntheticAuditDecision: options.syntheticAuditDecision,
          targetLockRef,
          pinnedPlan: options.pinnedPlan || null,
        });
      } else {
        execution = await executeLegacySurfaceAttempt({
          adapter,
          objective,
          manifest,
          surface,
          surfaceState,
          surfacePaths,
          proposalLoader,
          reviewLoader,
          fetchFn,
          report,
          validationCommands,
          syntheticAuditDecision: options.syntheticAuditDecision,
        });
      }
      patchFingerprint = execution && execution.patchFingerprint ? execution.patchFingerprint : patchFingerprint;
      patchFamilyFingerprint = execution && execution.patchFamilyFingerprint ? execution.patchFamilyFingerprint : patchFamilyFingerprint;
    } catch (error) {
      failAttempt(report, error, {
        failureStage: report.failureStage || 'worker',
      });
    } finally {
      // Release any lock held by the staged executor on every exit path
      // (success, rejection, or thrown error). Planner-only releases its own
      // shorter-lived lock inside its own finally.
      releaseTargetLock(targetLockRef.lockPath);
      targetLockRef.lockPath = null;
      report.finishedAt = nowIso();
      const artifacts = writeAttemptArtifacts(attemptPaths, report);
      const fallbackProposal = buildLedgerProposalFallback(report);
      const fallbackFingerprint = createPatchFingerprint(objective.objectiveHash, surface.id, fallbackProposal);
      report.patchFamilyFingerprint = report.patchFamilyFingerprint
        || patchFamilyFingerprint
        || createPatchFamilyFingerprint(objective.objectiveHash, surface.id, fallbackProposal, {
          sourceTarget: report.sourceTarget,
          testTarget: report.testTarget,
        });
      const ledgerEntry = buildLedgerEntry(report, objective.objectiveHash, surface, patchFingerprint || fallbackFingerprint);
      await finalizeSurfaceAttempt(manifestPaths, report, surfacePaths, artifacts.proofPath, artifacts.handoffPath, ledgerEntry);
    }
    return report;
  } finally {
    // Audit round-4 P2#4: cleanup path — runs whether the inner block
    // succeeded, returned early, or threw.  The try/catch around
    // removeWorktree guarantees a cleanup failure cannot mask the original
    // exception that triggered unwinding.
    if (worktreeCreated) {
      try {
        removeWorktree(adapter.repoRoot, surfacePaths.worktreePath, { force: true });
      } catch {
        // Swallow — leaking a worktree is recoverable by the operator;
        // masking the real error that triggered this cleanup is not.
      }
    }
  }
}

// --- init / validate extracted to overnight_engine_init.cjs ---
const {
  initOvernightEngine,
  validateOvernightAdapter,
} = require('./overnight_engine_init.cjs');

async function runOvernightBatch(options = {}) {
  const repoRoot = path.resolve(options.cwd || process.cwd());
  const adapter = loadOvernightAdapter(options.adapterPath, { repoRoot });
  const objective = loadOvernightObjective(options.objectivePath, adapter, { repoRoot });
  const workingTree = getWorkingTreeState(repoRoot);
  if (!options.allowDirty && workingTree.isDirty) {
    throw new AdapterError(
      'REPO_DIRTY',
      'repoRoot',
      'Overnight engine requires a clean repo working tree unless --allow-dirty is set.',
      { fixHint: 'Stash or commit all pending changes, or pass allowDirty: true to skip this check.' }
    );
  }
  const rawAttempt = Number(options.attemptLimit);
  const attemptLimit = Math.max(1, (Number.isFinite(rawAttempt) ? rawAttempt : null) ?? adapter.defaults.attemptLimit ?? 1);
  const proposalMode = normalizeProposalMode(options.proposalMode || adapter.defaults.proposalMode || 'legacy');
  const maxTotalAttempts = Number.isFinite(Number(options.maxTotalAttempts)) && Number(options.maxTotalAttempts) > 0
    ? Math.max(1, Math.floor(Number(options.maxTotalAttempts)))
    : null;

  const batchId = normalizeText(options.batchId) || buildBatchId('overnight');
  const reportRoot = path.resolve(repoRoot, adapter.defaults.reportDir || DEFAULT_REPORT_DIR, batchId);
  const worktreeRoot = defaultWorktreeRoot(repoRoot, batchId);
  const manifestPaths = buildOvernightManifestPaths(reportRoot);
  // Audit round-4 P2#3: exclusive batch-dir creation.  Two orchestrators that
  // happened to pick the same batchId would previously share the same
  // reports/<batchId>/manifest.json and events.ndjson, mixing attempts.
  // mkdirSync with recursive:false throws EEXIST atomically if the directory
  // already exists — we trap that and raise BATCH_ID_IN_USE so the caller
  // must choose a fresh id.  Parent directories that don't yet exist are
  // created separately (they're harmless to share).
  ensureDir(path.dirname(reportRoot));
  try {
    fs.mkdirSync(reportRoot, { recursive: false });
  } catch (batchDirError) {
    if (batchDirError && batchDirError.code === 'EEXIST') {
      throw new AdapterError(
        'BATCH_ID_IN_USE',
        'batchId',
        `Overnight batch directory already exists: ${reportRoot}`,
        { fixHint: 'Pick a fresh batchId (the default builder includes a timestamp so collisions are usually retries). The existing directory has in-flight or historical attempts and must not be co-mingled with a new orchestrator run.' }
      );
    }
    throw batchDirError;
  }
  ensureDir(worktreeRoot);
  const baseCommit = getHeadCommit(repoRoot);
  const promotion = {
    branchName: buildIntegrationBranchName(adapter, batchId),
    worktreePath: path.join(worktreeRoot, 'integration'),
  };
  const manifest = createOvernightManifest({
    batchId,
    repoRoot,
    adapterPath: adapter.sourcePath,
    objectivePath: objective.sourcePath,
    objectiveHash: objective.objectiveHash,
    baseCommit,
    reportRoot,
    worktreeRoot,
    branchPrefix: adapter.defaults.branchPrefix,
    proposalMode,
    attemptLimit,
    maxTotalAttempts,
    promotion,
    surfaces: objective.allowedSurfaces.map((surfaceId) => {
      const surface = findSurface(adapter, surfaceId);
      return buildSurfaceManifestRecord(reportRoot, worktreeRoot, adapter, surface, batchId);
    }),
  });
  writeJsonAtomic(manifestPaths.manifestPath, manifest);
  appendOvernightEvent(manifestPaths, {
    type: 'batch-started',
    batchId,
    objectiveHash: objective.objectiveHash,
    attemptLimit,
    proposalMode,
    maxTotalAttempts,
  });
  let totalAttemptsStarted = 0;
  let wave = 0;
  while (true) {
    const liveManifest = loadOvernightManifest(manifestPaths.manifestPath);
    const runnableSurfaceIds = objective.allowedSurfaces.filter((surfaceId) => {
      const surfaceState = liveManifest.surfaces.find((entry) => entry.surfaceId === surfaceId);
      if (!surfaceState) {
        return false;
      }
      if (surfaceState.attemptCount >= attemptLimit) {
        return false;
      }
      if (surfaceState.frozen || surfaceState.cooled) {
        return false;
      }
      return true;
    });
    if (runnableSurfaceIds.length === 0) {
      break;
    }
    wave += 1;
    appendOvernightEvent(manifestPaths, {
      type: 'wave-started',
      batchId,
      wave,
      runnableSurfaceIds,
    });
    let attemptsThisWave = 0;
    for (const surfaceId of runnableSurfaceIds) {
      if (maxTotalAttempts && totalAttemptsStarted >= maxTotalAttempts) {
        break;
      }
      const currentManifest = loadOvernightManifest(manifestPaths.manifestPath);
      const surfaceState = currentManifest.surfaces.find((entry) => entry.surfaceId === surfaceId);
      if (!surfaceState || surfaceState.attemptCount >= attemptLimit || surfaceState.frozen || surfaceState.cooled) {
        continue;
      }
      const surface = findSurface(adapter, surfaceId);
      await runSurfaceAttempt({
        adapter,
        objective,
        manifestPaths,
        manifest: currentManifest,
        surface,
        proposalLoader: options.proposalLoader,
        reviewLoader: options.reviewLoader,
        fetchFn: options.fetchFn,
        syntheticAuditDecision: options.syntheticAuditDecision,
        proposalMode,
        pinnedPlan: options.pinnedPlan || null,
      });
      totalAttemptsStarted += 1;
      attemptsThisWave += 1;
    }
    appendOvernightEvent(manifestPaths, {
      type: 'wave-finished',
      batchId,
      wave,
      attemptsThisWave,
      totalAttemptsStarted,
    });
    if (attemptsThisWave === 0) {
      break;
    }
    if (maxTotalAttempts && totalAttemptsStarted >= maxTotalAttempts) {
      break;
    }
  }

  await updateOvernightManifest(manifestPaths, (next) => {
    next.status = 'awaiting-promotion';
  });
  appendOvernightEvent(manifestPaths, {
    type: 'batch-finished',
    batchId,
    totalAttemptsStarted,
    waveCount: wave,
  });
  return inspectOvernightBatch({
    batchDir: reportRoot,
  });
}

function inspectOvernightBatch(options = {}) {
  const batchDir = path.resolve(options.batchDir);
  const manifestPaths = buildOvernightManifestPaths(batchDir);
  const manifest = loadOvernightManifest(manifestPaths.manifestPath);
  const stageCounts = {};
  const reasonCounts = {};
  const outcomeCounts = {};
  const targetWindowFailures = {};
  for (const entry of Array.isArray(manifest.ledger) ? manifest.ledger : []) {
    const stageKey = normalizeText(entry.stage) || 'unknown';
    const reasonKey = normalizeText(entry.reasonCode) || 'unknown';
    const outcomeKey = normalizeText(entry.outcome) || 'unknown';
    stageCounts[stageKey] = (stageCounts[stageKey] || 0) + 1;
    reasonCounts[reasonKey] = (reasonCounts[reasonKey] || 0) + 1;
    outcomeCounts[outcomeKey] = (outcomeCounts[outcomeKey] || 0) + 1;
    if (['invalid-target-window', 'anchor-preflight-failed'].includes(entry.failureKind)) {
      const sourceTarget = entry.sourceTarget || {};
      const targetKey = `${normalizeText(sourceTarget.path)}::${normalizeText(sourceTarget.symbol || sourceTarget.anchorText) || 'unknown'}`;
      if (!targetWindowFailures[targetKey]) {
        targetWindowFailures[targetKey] = {
          count: 0,
          failureKinds: {},
          paths: new Set(),
        };
      }
      targetWindowFailures[targetKey].count += 1;
      targetWindowFailures[targetKey].failureKinds[entry.failureKind] = (targetWindowFailures[targetKey].failureKinds[entry.failureKind] || 0) + 1;
      if (entry.failedPath) {
        targetWindowFailures[targetKey].paths.add(entry.failedPath);
      }
    }
  }
  const normalizedTargetWindowFailures = Object.fromEntries(
    Object.entries(targetWindowFailures).map(([key, value]) => [key, {
      count: value.count,
      failureKinds: value.failureKinds,
      paths: Array.from(value.paths),
    }]),
  );
  return {
    ...manifest,
    summary: {
      pipelineMode: manifest.proposalMode || 'legacy',
      outcomes: outcomeCounts,
      reasonCodes: reasonCounts,
      stages: stageCounts,
      targetWindowFailures: normalizedTargetWindowFailures,
      pendingAuditSurfaces: manifest.surfaces
        .filter((surface) => Boolean(surface.auditPending) || (Array.isArray(surface.pendingAuditCommits) && surface.pendingAuditCommits.length > 0))
        .map((surface) => ({
          surfaceId: surface.surfaceId,
          pendingAuditCount: Array.isArray(surface.pendingAuditCommits) ? surface.pendingAuditCommits.length : 0,
          latestCommit: surface.latestCommit,
          latestProofPath: surface.latestProofPath,
        })),
    },
  };
}

// --- resolveDeferredAudit extracted to overnight_engine_deferred.cjs ---
const { resolveDeferredAudit } = require('./overnight_engine_deferred.cjs');

async function promoteOvernightBatch(options = {}) {
  const batchDir = path.resolve(options.batchDir);
  const manifestPaths = buildOvernightManifestPaths(batchDir);
  const manifest = loadOvernightManifest(manifestPaths.manifestPath);
  const adapter = loadOvernightAdapter(manifest.adapterPath, { repoRoot: manifest.repoRoot });
  const integration = manifest.promotion;
  if (fs.existsSync(integration.worktreePath)) {
    removeWorktree(manifest.repoRoot, integration.worktreePath, { force: true });
  }
  deleteBranch(manifest.repoRoot, integration.branchName, { force: true });
  createWorktree(manifest.repoRoot, {
    worktreePath: integration.worktreePath,
    branchName: integration.branchName,
    startPoint: manifest.baseCommit,
  });
  const pickedCommits = [];
  const conflicts = [];
  try {
    for (const surface of manifest.surfaces) {
      for (const accepted of surface.acceptedCommits) {
        const result = runGit(integration.worktreePath, ['cherry-pick', accepted.commit]);
        if (result.exitCode !== 0) {
          conflicts.push({
            surfaceId: surface.surfaceId,
            commit: accepted.commit,
            message: result.stderr || result.stdout,
          });
          runGit(integration.worktreePath, ['cherry-pick', '--abort']);
          break;
        }
        pickedCommits.push({
          surfaceId: surface.surfaceId,
          commit: accepted.commit,
        });
      }
      if (conflicts.length > 0) {
        break;
      }
    }
    const validation = conflicts.length === 0
      ? runValidationPlan(adapter.repo.finalValidation, integration.worktreePath)
      : null;
    await updateOvernightManifest(manifestPaths, (next) => {
      next.promotion.status = conflicts.length > 0
        ? 'blocked'
        : (summarizeValidation(validation).overallPass ? 'ready' : 'validated');
      next.promotion.latestCommit = conflicts.length === 0 ? getHeadCommit(integration.worktreePath) : null;
      next.promotion.validation = validation;
      next.promotion.conflicts = conflicts;
      next.promotion.promotedAt = nowIso();
    });
    return {
      pickedCommits,
      conflicts,
      validation,
      ready: conflicts.length === 0 && summarizeValidation(validation).overallPass,
    };
  } finally {
    appendOvernightEvent(manifestPaths, {
      type: 'batch-promoted',
      pickedCommits: pickedCommits.length,
      conflicts: conflicts.length,
    });
  }
}

async function cleanupOvernightBatch(options = {}) {
  const batchDir = path.resolve(options.batchDir);
  const manifestPaths = buildOvernightManifestPaths(batchDir);
  const manifest = loadOvernightManifest(manifestPaths.manifestPath);
  const cleaned = [];
  for (const surface of manifest.surfaces) {
    if (fs.existsSync(surface.worktreePath)) {
      removeWorktree(manifest.repoRoot, surface.worktreePath, { force: true });
      cleaned.push(surface.surfaceId);
    }
  }
  if (fs.existsSync(manifest.promotion.worktreePath)) {
    removeWorktree(manifest.repoRoot, manifest.promotion.worktreePath, { force: true });
  }
  appendOvernightEvent(manifestPaths, {
    type: 'batch-cleaned',
    cleaned,
  });
  return {
    cleaned,
  };
}

module.exports = {
  buildProposalPrompt,
  buildPromptContext,
  buildRejectionStructuredError,
  buildRejectionSummary,
  buildRepairPrompt,
  cleanupOvernightBatch,
  initOvernightEngine,
  inspectOvernightBatch,
  loadProposalWithRepair,
  parseProposal,
  promoteOvernightBatch,
  resolveDeferredAudit,
  runOvernightBatch,
  runSurfaceAttempt,
  truncateOutput,
  validateOvernightAdapter,
  validateProposalOperationLimits,
  // Internal exports consumed by overnight_engine_deferred.cjs via lazy require.
  // Prefixed with _ to signal they are not part of the public API.
  _buildAttemptPaths: buildAttemptPaths,
  _writeAttemptArtifacts: writeAttemptArtifacts,
  // Exported for testing only — not part of the public API.
  _targetLocking: {
    acquireTargetLock,
    releaseTargetLock,
    isLockStale,
    targetLocksDir,
    targetLockFileName,
    TARGET_LOCK_TTL_MS,
    TARGET_LOCK_META_FILE,
  },
};
