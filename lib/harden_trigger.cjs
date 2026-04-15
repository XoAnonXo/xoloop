'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');
const { ensureDir, nowIso, readJsonIfExists } = require('./baton_common.cjs');
const { loadOvernightAdapter } = require('./overnight_adapter.cjs');
const { writeYamlFile } = require('./overnight_yaml.cjs');
const { appendOvernightEvent, buildOvernightManifestPaths } = require('./overnight_manifest.cjs');

// ── Constants ───────────────────────────────────────────────────────

const FROZEN_DIR = 'reports/frozen';

// ── Helpers ─────────────────────────────────────────────────────────

function assertFeature(feature) {
  if (!feature || typeof feature !== 'object') {
    throw new AdapterError(
      'HARDEN_FEATURE_REQUIRED',
      'feature',
      'feature object is required for harden trigger',
      { fixHint: 'Pass a loaded feature object (from loadFeature) to the harden trigger function.' }
    );
  }
  if (!feature.newSurface || typeof feature.newSurface !== 'object') {
    throw new AdapterError(
      'HARDEN_FEATURE_SURFACE_REQUIRED',
      'feature.newSurface',
      'feature.newSurface object is required for harden trigger',
      { fixHint: 'Ensure the feature object has a newSurface property with at least an id field.' }
    );
  }
  if (!feature.newSurface.id || typeof feature.newSurface.id !== 'string') {
    throw new AdapterError(
      'HARDEN_FEATURE_SURFACE_ID_REQUIRED',
      'feature.newSurface.id',
      'feature.newSurface.id must be a non-empty string',
      { fixHint: 'Ensure the feature newSurface object has a non-empty string id field.' }
    );
  }
}

function assertBaseAdapter(baseAdapter) {
  if (!baseAdapter || typeof baseAdapter !== 'object' || Array.isArray(baseAdapter)) {
    throw new AdapterError(
      'HARDEN_ADAPTER_REQUIRED',
      'baseAdapter',
      'base adapter object is required for harden trigger',
      { fixHint: 'Pass a loaded adapter object (from loadOvernightAdapter) to the harden trigger function.' }
    );
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * buildHardenObjective — generate a polish-focused objective targeting
 * the new surface declared in a feature.
 */
function buildHardenObjective(feature) {
  assertFeature(feature);

  return {
    goal: `Polish the newly-created ${feature.newSurface.id} surface to production quality — harden error handling, add guards, lock regression tests, and remove dead code.`,
    allowedSurfaces: [feature.newSurface.id],
    success: [
      'every throw is AdapterError with code, field, fixHint',
      'every boundary function has a null/undefined guard',
      'every public function has at least one regression test',
      'no dead code, no unused exports',
    ],
    requiredTests: ['regression'],
    stopConditions: [
      'would require touching a surface not in the feature declaration',
      'would add a new feature beyond the approved scope',
    ],
    evidence: [
      `the ${feature.newSurface.id} surface passes all quick and full validation commands`,
    ],
    priority: 'high',
  };
}

/**
 * buildHardenAdapter — create a minimal adapter scoped to the new surface
 * plus integration seams from the feature declaration.
 */
function buildHardenAdapter(feature, baseAdapter) {
  assertFeature(feature);
  assertBaseAdapter(baseAdapter);

  const surfaces = [feature.newSurface];

  for (const seam of feature.integrationSeams || []) {
    if (!seam || typeof seam !== 'object') continue;
    if (!seam.path || typeof seam.path !== 'string') continue;
    const baseSurface = (baseAdapter.surfaces || []).find((s) => s.id === seam.surface);
    if (baseSurface) {
      surfaces.push({
        ...baseSurface,
        paths: [seam.path],
      });
    }
  }

  return { ...baseAdapter, surfaces };
}

/**
 * writeHardenConfig — write the temporary harden objective and adapter
 * YAML files to the repo root.
 */
function writeHardenConfig(feature, baseAdapter, options = {}) {
  assertFeature(feature);
  assertBaseAdapter(baseAdapter);

  const opts = options || {};
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const surfaceId = feature.newSurface.id;

  const objective = buildHardenObjective(feature);
  const adapter = buildHardenAdapter(feature, baseAdapter);

  const objectivePath = path.join(repoRoot, `objective.harden-${surfaceId}.yaml`);
  const adapterPath = path.join(repoRoot, `overnight.harden-${surfaceId}.yaml`);

  // Convert the adapter back to YAML-friendly format
  const adapterDocument = {
    schema_version: adapter.schemaVersion || '1.0.0',
    repo: adapter.repo ? {
      name: adapter.repo.name,
      setup: adapter.repo.setup,
      baseline_validation: adapter.repo.baselineValidation,
      final_validation: adapter.repo.finalValidation,
    } : undefined,
    surfaces: adapter.surfaces.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      paths: s.paths,
      test_paths: s.testPaths,
      invariants: s.invariants,
      risk: s.risk,
      required_test_kinds: s.requiredTestKinds,
      language_hints: s.languageHints,
      formatting_hints: s.formattingHints,
      context_patterns: s.contextPatterns,
      allowed_dependencies: s.allowedDependencies,
      forbidden_paths: s.forbiddenPaths,
      conflicts_with: s.conflictsWith,
      quick_validation: s.quickValidation,
      full_validation: s.fullValidation,
    })),
    manual_only_paths: adapter.manualOnlyPaths,
    shared_paths: adapter.sharedPaths,
    defaults: adapter.defaults ? {
      report_dir: adapter.defaults.reportDir,
      branch_prefix: adapter.defaults.branchPrefix,
      attempt_limit: adapter.defaults.attemptLimit,
      repair_turns: adapter.defaults.repairTurns,
    } : undefined,
  };

  const objectiveDocument = {
    goal: objective.goal,
    allowed_surfaces: objective.allowedSurfaces,
    success: objective.success,
    required_tests: objective.requiredTests,
    stop_conditions: objective.stopConditions,
    evidence: objective.evidence,
    priority: objective.priority,
  };

  try {
    writeYamlFile(objectivePath, objectiveDocument);
    writeYamlFile(adapterPath, adapterDocument);
  } catch (err) {
    throw new AdapterError(
      'HARDEN_CONFIG_WRITE_FAILED',
      'writeHardenConfig',
      `Failed to write harden config files: ${err.message}`,
      { fixHint: 'Check that the repo root is writable and the disk has free space.', cause: err }
    );
  }

  return { objectivePath, adapterPath };
}

/**
 * triggerHarden — main entry point called after feature approval.
 * Loads the base adapter, builds harden config, writes to disk,
 * and logs a harden-triggered event.
 * Does NOT start the engine itself.
 */
function triggerHarden(feature, options = {}) {
  assertFeature(feature);

  const opts = options || {};
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const baseAdapterPath = opts.adapterPath || 'overnight.yaml';

  const baseAdapter = loadOvernightAdapter(baseAdapterPath, { repoRoot, mergeGenerated: true });

  const config = writeHardenConfig(feature, baseAdapter, { repoRoot });

  const surfaceId = feature.newSurface.id;

  // Log event to manifest if a batch is active
  if (opts.batchDir) {
    const paths = buildOvernightManifestPaths(opts.batchDir);
    appendOvernightEvent(paths, {
      type: 'harden-triggered',
      surfaceId,
      objectivePath: config.objectivePath,
      adapterPath: config.adapterPath,
    });
  }

  return {
    objectivePath: config.objectivePath,
    adapterPath: config.adapterPath,
    surfaceId,
    hardenScope: {
      newSurface: feature.newSurface.id,
      integrationSeams: (feature.integrationSeams || [])
        .filter((s) => s && typeof s === 'object')
        .map((s) => s.surface),
    },
  };
}

/**
 * freezeSurface — freeze a surface after a harden failure.
 * Writes a freeze marker file to reports/frozen/<surfaceId>.json.
 */
function freezeSurface(surfaceId, reason, options = {}) {
  if (!surfaceId || typeof surfaceId !== 'string') {
    throw new AdapterError(
      'HARDEN_SURFACE_ID_REQUIRED',
      'surfaceId',
      'surfaceId is required for freezeSurface',
      { fixHint: 'Pass a non-empty string surfaceId to freezeSurface.' }
    );
  }

  const opts = options || {};
  const frozenDir = opts.reportDir
    ? path.resolve(opts.reportDir, '..', '..', FROZEN_DIR)
    : path.resolve(opts.repoRoot || process.cwd(), FROZEN_DIR);
  const markerPath = path.join(frozenDir, `${surfaceId}.json`);

  // Atomic check-and-create: use O_CREAT|O_EXCL (flag 'wx') so the kernel
  // rejects the write when the file already exists — no TOCTOU gap between
  // an existsSync check and a subsequent writeJsonAtomic.
  ensureDir(frozenDir);
  const payload = JSON.stringify({
    surfaceId,
    reason: reason || null,
    frozenAt: nowIso(),
  }, null, 2) + '\n';

  try {
    fs.writeFileSync(markerPath, payload, { flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new AdapterError(
        'HARDEN_SURFACE_ALREADY_FROZEN',
        'surfaceId',
        `surface "${surfaceId}" is already frozen`,
        { fixHint: `Run unfreezeSurface("${surfaceId}") before freezing again, or check the freeze marker at ${markerPath}.` }
      );
    }
    throw err;
  }

  return { frozen: true, surfaceId, reason: reason || null };
}

/**
 * unfreezeSurface — remove the freeze marker for a surface.
 */
function unfreezeSurface(surfaceId, options = {}) {
  if (!surfaceId || typeof surfaceId !== 'string') {
    throw new AdapterError(
      'HARDEN_SURFACE_ID_REQUIRED',
      'surfaceId',
      'surfaceId is required for unfreezeSurface',
      { fixHint: 'Pass a non-empty string surfaceId to unfreezeSurface.' }
    );
  }

  const opts = options || {};
  const frozenDir = opts.reportDir
    ? path.resolve(opts.reportDir, '..', '..', FROZEN_DIR)
    : path.resolve(opts.repoRoot || process.cwd(), FROZEN_DIR);
  const markerPath = path.join(frozenDir, `${surfaceId}.json`);

  if (!fs.existsSync(markerPath)) {
    throw new AdapterError(
      'HARDEN_SURFACE_NOT_FROZEN',
      'surfaceId',
      `surface "${surfaceId}" is not frozen`,
      { fixHint: `Surface "${surfaceId}" has no freeze marker at ${markerPath}. Nothing to unfreeze.` }
    );
  }

  fs.unlinkSync(markerPath);

  return { frozen: false, surfaceId };
}

/**
 * isSurfaceFrozen — check if a surface is currently frozen.
 */
function isSurfaceFrozen(surfaceId, options = {}) {
  if (!surfaceId || typeof surfaceId !== 'string') {
    return { frozen: false, reason: null, frozenAt: null };
  }

  const opts = options || {};
  const frozenDir = opts.reportDir
    ? path.resolve(opts.reportDir, '..', '..', FROZEN_DIR)
    : path.resolve(opts.repoRoot || process.cwd(), FROZEN_DIR);
  const markerPath = path.join(frozenDir, `${surfaceId}.json`);

  const marker = readJsonIfExists(markerPath);
  if (!marker) {
    return { frozen: false, reason: null, frozenAt: null };
  }

  return {
    frozen: true,
    reason: marker.reason || null,
    frozenAt: marker.frozenAt || null,
  };
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  buildHardenObjective,
  buildHardenAdapter,
  writeHardenConfig,
  triggerHarden,
  freezeSurface,
  unfreezeSurface,
  isSurfaceFrozen,
};
