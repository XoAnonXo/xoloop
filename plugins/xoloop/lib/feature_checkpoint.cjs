const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { AdapterError } = require('./errors.cjs');
const { readJsonIfExists, writeJsonAtomic } = require('./baton_common.cjs');
const { applyOperationSet, rollbackOperationSet } = require('./operation_ir.cjs');
const { registerGeneratedSurface, normalizeCommandList } = require('./overnight_adapter.cjs');

// ── Validation command execution ───────────────────────────────────
//
// Audit P2: feature_checkpoint used to unconditionally `execFileSync('sh',
// ['-c', cmd], ...)` for every baseline_validation entry. That stringified
// any {argv: [...]} objects from the normalized adapter schema to
// '[object Object]' (immediate failure), AND reintroduced the
// shell-injection surface the adapter layer closes when
// disallow_shell_validation is set. Replace with a normalized executor
// that honors both forms: plain trimmed strings run via bash -lc, {argv:
// [...]} entries run via execFileSync without a shell.
function runBaselineValidationCommands(commands, cwd) {
  const normalized = normalizeCommandList(commands, 'repo.baseline_validation');
  for (const entry of normalized) {
    if (typeof entry === 'string') {
      execFileSync('bash', ['-lc', entry], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      continue;
    }
    if (entry && Array.isArray(entry.argv) && entry.argv.length > 0) {
      const [command, ...args] = entry.argv;
      execFileSync(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      continue;
    }
    throw new AdapterError(
      'FEATURE_APPROVAL_VALIDATION_MALFORMED',
      'repo.baseline_validation',
      'Encountered validation entry that is neither a trimmed string nor {argv: [...]}',
      { fixHint: 'Ensure every repo.baseline_validation entry is a shell string or {argv: [...]} object.' },
    );
  }
}
// Retain the spawnSync import for potential future use; silences lint in
// environments that flag unused destructured imports.
void spawnSync;

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_REPORTS_DIR = 'reports/features';

// ── Helpers ─────────────────────────────────────────────────────────

function resolveReportsDir(reportsDir) {
  return path.resolve(reportsDir || DEFAULT_REPORTS_DIR);
}

function bundlePath(reportsDir, featureId) {
  return path.join(resolveReportsDir(reportsDir), featureId, 'review-bundle.json');
}

function loadBundle(reportsDir, featureId) {
  if (typeof featureId !== 'string' || featureId === '') {
    throw new AdapterError(
      'INVALID_FEATURE_ID',
      'featureId',
      `featureId must be a non-empty string, got ${featureId === null ? 'null' : featureId === '' ? 'empty string' : typeof featureId}`,
      { fixHint: 'Pass a valid string featureId to reviewFeature / approveFeature / rejectFeature / reviseFeature.' }
    );
  }
  const filePath = bundlePath(reportsDir, featureId);
  const bundle = readJsonIfExists(filePath);
  if (!bundle) {
    throw new AdapterError(
      'FEATURE_NOT_FOUND',
      'featureId',
      `No review bundle found for feature "${featureId}"`,
      { fixHint: `Ensure the build pipeline has written a review bundle to ${filePath} before attempting to review/approve/reject.` }
    );
  }
  return bundle;
}

function saveBundle(reportsDir, featureId, bundle) {
  const filePath = bundlePath(reportsDir, featureId);
  writeJsonAtomic(filePath, bundle);
}

function assertPending(bundle) {
  if (bundle.status !== 'awaiting_approval') {
    throw new AdapterError(
      'FEATURE_NOT_PENDING',
      'status',
      `Feature "${bundle.featureId}" has status "${bundle.status}", expected "awaiting_approval"`,
      { fixHint: 'Only features with status "awaiting_approval" can be approved, rejected, or revised.' }
    );
  }
}

// ── Public API ──────────────────────────────────────────────────────

function listPendingFeatures(reportsDir) {
  const dir = resolveReportsDir(reportsDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const pending = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const reviewPath = path.join(dir, entry.name, 'review-bundle.json');
    const bundle = readJsonIfExists(reviewPath);
    if (!bundle || bundle.status !== 'awaiting_approval' || !bundle.featureId || typeof bundle.featureId !== 'string') {
      continue;
    }
    pending.push({
      featureId: bundle.featureId,
      feature: bundle.feature,
      status: bundle.status,
      reviewBundlePath: reviewPath,
      createdAt: bundle.createdAt || null,
    });
  }

  return pending;
}

function reviewFeature(featureId, options = {}) {
  options = options || {};
  return loadBundle(options.reportsDir, featureId);
}

function approveFeature(featureId, options = {}) {
  options = options || {};
  const { reportsDir, repoRoot, adapterPath } = options;
  const bundle = loadBundle(reportsDir, featureId);
  assertPending(bundle);

  const resolvedRoot = path.resolve(repoRoot || process.cwd());

  // Apply all operations.
  //
  // Audit P2: build_pipeline.writeReviewBundle persists the generated edits
  // as `bundle.proposal.operations`, not `bundle.operations` — so
  // `bundle.operations || []` always evaluated to [] and approvals were
  // committing nothing while reporting success. Prefer the proposal-nested
  // path first; fall back to the flat field for back-compat with bundles
  // written by other producers or legacy callers.
  let rollbackHandle;
  const operations = (bundle.proposal && Array.isArray(bundle.proposal.operations)
    ? bundle.proposal.operations
    : Array.isArray(bundle.operations) ? bundle.operations : []);
  try {
    rollbackHandle = applyOperationSet(operations, { cwd: resolvedRoot });
  } catch (applyError) {
    throw new AdapterError(
      'FEATURE_APPROVAL_FAILED',
      'operations',
      `Failed to apply operations for feature "${featureId}": ${applyError.message}`,
      { fixHint: 'Check that the operations in the review bundle are valid against the current repo state.', cause: applyError }
    );
  }

  // Run quick validation (test suite) from the adapter, honoring both
  // shell-form strings and argv-form objects per the normalized schema.
  try {
    const adapterFile = path.resolve(resolvedRoot, adapterPath || 'overnight.yaml');
    const { readYamlFile } = require('./overnight_yaml.cjs');
    const loaded = readYamlFile(adapterFile);
    const commands = (loaded.document.repo && loaded.document.repo.baseline_validation) || [];
    runBaselineValidationCommands(commands, resolvedRoot);
  } catch (testError) {
    // Tests failed — rollback
    rollbackOperationSet(rollbackHandle);
    throw new AdapterError(
      'FEATURE_APPROVAL_FAILED',
      'validation',
      `Validation failed after applying feature "${featureId}": ${testError.message}`,
      { fixHint: 'The test suite failed after applying the operations. The changes have been rolled back.', cause: testError }
    );
  }

  // Commit with attribution
  let commitHash;
  try {
    const filePaths = (rollbackHandle || []).map((entry) => entry.path);
    if (filePaths.length > 0) {
      execFileSync('git', ['add', ...filePaths], { cwd: resolvedRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const featureName = (bundle.feature && bundle.feature.feature) || featureId;
    const commitMessage = `build[${featureId}]: ${featureName}\n\nApproved via feature checkpoint.`;
    execFileSync('git', ['commit', '-m', commitMessage], { cwd: resolvedRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolvedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (gitError) {
    // Git failed — rollback applied operations so disk state is clean
    rollbackOperationSet(rollbackHandle);
    throw new AdapterError(
      'FEATURE_APPROVAL_FAILED',
      'git',
      `Failed to commit feature "${featureId}": ${gitError.message}`,
      { fixHint: 'Git commit failed. Applied operations have been rolled back — the repo is clean.', cause: gitError }
    );
  }

  // Register surface in overnight.generated.yaml
  let surfaceRegistered = false;
  if (bundle.feature && bundle.feature.new_surface) {
    registerGeneratedSurface(bundle.feature.new_surface, { repoRoot: resolvedRoot });
    surfaceRegistered = true;
  }

  // Update bundle status
  bundle.status = 'approved';
  bundle.approvedAt = new Date().toISOString();
  saveBundle(reportsDir, featureId, bundle);

  return { ok: true, commitHash, surfaceRegistered };
}

function rejectFeature(featureId, reason, options = {}) {
  options = options || {};
  const bundle = loadBundle(options.reportsDir, featureId);
  assertPending(bundle);

  bundle.status = 'rejected';
  bundle.rejectedAt = new Date().toISOString();
  bundle.rejectionReason = reason || null;
  saveBundle(options.reportsDir, featureId, bundle);

  return { ok: true, status: 'rejected' };
}

function reviseFeature(featureId, feedback, options = {}) {
  options = options || {};
  const bundle = loadBundle(options.reportsDir, featureId);
  assertPending(bundle);

  bundle.status = 'revision_requested';
  bundle.revisionFeedback = feedback || null;
  saveBundle(options.reportsDir, featureId, bundle);

  return { ok: true, status: 'revision_requested', feedback: feedback || null };
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  listPendingFeatures,
  reviewFeature,
  approveFeature,
  rejectFeature,
  reviseFeature,
};
