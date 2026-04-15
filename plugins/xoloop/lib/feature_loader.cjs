const fs = require('node:fs');
const path = require('node:path');

const { z } = require('zod');

const { readYamlFile } = require('./overnight_yaml.cjs');
const { AdapterError } = require('./errors.cjs');

// --------------------------------------------------------------------------
// Zod schema for feature.yaml (BUILD mode)
// --------------------------------------------------------------------------

const integrationSeamSchema = z.object({
  surface: z.string().min(1),
  path: z.string().min(1),
  reason: z.string().min(1),
  operation: z.string().min(1),
});

const dependencySchema = z.object({
  surface: z.string().min(1),
  reason: z.string().min(1),
  read_only: z.boolean(),
});

const newSurfaceSchema = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/, 'must be a valid identifier (lowercase, starts with letter, alphanumeric/dash/underscore)'),
  title: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  test_paths: z.array(z.string().min(1)).min(1),
  invariants: z.array(z.string().min(1)).min(1),
  risk: z.enum(['guarded', 'exploratory', 'critical']),
  required_test_kinds: z.array(z.string().min(1)).default(['regression']),
});

const featureSchema = z.object({
  feature: z.string().min(1),
  version: z.number().int().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  new_surface: newSurfaceSchema,
  integration_seams: z.array(integrationSeamSchema).default([]),
  dependencies: z.array(dependencySchema).default([]),
  exemplar: z.string().min(1).optional(),
  constraints: z.array(z.string().min(1)).default([]),
});

// --------------------------------------------------------------------------
// loadFeature — load, validate, and cross-check a feature.yaml
// --------------------------------------------------------------------------

function loadFeature(featurePath, adapter, options = {}) {
  if (!options || typeof options !== 'object') options = {};
  if (!featurePath || typeof featurePath !== 'string') {
    throw new AdapterError(
      'FEATURE_INVALID_PATH',
      'featurePath',
      'featurePath must be a non-empty string',
      { fixHint: 'Pass the relative or absolute path to the feature.yaml file as the first argument to loadFeature.' },
    );
  }
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new AdapterError(
      'FEATURE_INVALID_ADAPTER',
      'adapter',
      'adapter must be a non-null object',
      { fixHint: 'Pass the result of loadOvernightAdapter(...) as the adapter argument to loadFeature.' },
    );
  }
  const repoRoot = path.resolve(options.repoRoot || adapter.repoRoot || process.cwd());
  const resolvedPath = path.resolve(repoRoot, featurePath);

  // 1. Read YAML file
  let loaded;
  try {
    loaded = readYamlFile(resolvedPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new AdapterError(
        'FEATURE_FILE_NOT_FOUND',
        'featurePath',
        `feature file not found: ${resolvedPath}`,
        { fixHint: `Create ${resolvedPath} or correct the path passed to loadFeature.`, cause: err },
      );
    }
    throw new AdapterError(
      'FEATURE_FILE_UNREADABLE',
      'featurePath',
      `unable to read or parse feature file: ${resolvedPath}`,
      { fixHint: `Check that ${resolvedPath} contains valid YAML.`, cause: err },
    );
  }

  // 2. Validate against Zod schema
  const parsed = featureSchema.safeParse(loaded.document);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const zodPath = firstIssue.path.join('.');
    throw new AdapterError(
      'FEATURE_SCHEMA_INVALID',
      zodPath || 'feature.yaml',
      firstIssue.message,
      { fixHint: `Fix field "${zodPath || '(root)'}" in ${resolvedPath}: ${firstIssue.message}` },
    );
  }

  const feature = parsed.data;

  // 3. Validate new_surface.id doesn't conflict with existing adapter surface IDs
  const adapterSurfaces = Array.isArray(adapter && adapter.surfaces) ? adapter.surfaces : [];
  const existingIds = new Set(adapterSurfaces.map((s) => s.id));
  if (existingIds.has(feature.new_surface.id)) {
    throw new AdapterError(
      'FEATURE_SURFACE_CONFLICT',
      'new_surface.id',
      `surface id "${feature.new_surface.id}" already exists in the adapter`,
      { fixHint: `Choose a unique id for new_surface.id in ${resolvedPath}. Existing ids: ${Array.from(existingIds).join(', ')}` },
    );
  }

  // 4. Validate integration_seams reference real surfaces in the adapter
  for (const seam of feature.integration_seams) {
    if (!existingIds.has(seam.surface)) {
      throw new AdapterError(
        'FEATURE_SEAM_UNKNOWN_SURFACE',
        'integration_seams',
        `integration seam references unknown surface: ${seam.surface}`,
        { fixHint: `Surface "${seam.surface}" is not declared in overnight.yaml. Available surfaces: ${Array.from(existingIds).join(', ')}` },
      );
    }
  }

  // 5. Validate dependencies reference real surfaces in the adapter
  for (const dep of feature.dependencies) {
    if (!existingIds.has(dep.surface)) {
      throw new AdapterError(
        'FEATURE_DEPENDENCY_UNKNOWN_SURFACE',
        'dependencies',
        `dependency references unknown surface: ${dep.surface}`,
        { fixHint: `Surface "${dep.surface}" is not declared in overnight.yaml. Available surfaces: ${Array.from(existingIds).join(', ')}` },
      );
    }
  }

  // 6. Validate exemplar file exists on disk
  if (feature.exemplar) {
    const exemplarAbsolute = path.resolve(repoRoot, feature.exemplar);
    if (!fs.existsSync(exemplarAbsolute)) {
      throw new AdapterError(
        'FEATURE_EXEMPLAR_NOT_FOUND',
        'exemplar',
        `exemplar file not found: ${feature.exemplar}`,
        { fixHint: `Create ${exemplarAbsolute} or update the exemplar field in ${resolvedPath}.` },
      );
    }
  }

  // 7. Return normalized feature object
  return {
    feature: feature.feature,
    version: feature.version,
    acceptance: feature.acceptance,
    newSurface: {
      id: feature.new_surface.id,
      title: feature.new_surface.title,
      paths: feature.new_surface.paths,
      testPaths: feature.new_surface.test_paths,
      invariants: feature.new_surface.invariants,
      risk: feature.new_surface.risk,
      requiredTestKinds: feature.new_surface.required_test_kinds,
    },
    integrationSeams: feature.integration_seams.map((seam) => ({
      surface: seam.surface,
      path: seam.path,
      reason: seam.reason,
      operation: seam.operation,
    })),
    dependencies: feature.dependencies.map((dep) => ({
      surface: dep.surface,
      reason: dep.reason,
      readOnly: dep.read_only,
    })),
    exemplar: feature.exemplar || null,
    constraints: feature.constraints,
    sourcePath: resolvedPath,
  };
}

// --------------------------------------------------------------------------
// validateFeatureAcceptance — validates inputs and returns acceptance coverage summary
// --------------------------------------------------------------------------

function validateFeatureAcceptance(feature, testResults) {
  if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
    throw new AdapterError(
      'FEATURE_ACCEPTANCE_INVALID_INPUT',
      'feature',
      'feature must be a non-null object',
      { fixHint: 'Pass a valid feature object (with an acceptance array) to validateFeatureAcceptance.' },
    );
  }
  if (!Array.isArray(testResults)) {
    throw new AdapterError(
      'FEATURE_ACCEPTANCE_INVALID_RESULTS',
      'testResults',
      'testResults must be an array',
      { fixHint: 'Pass an array (e.g. []) to validateFeatureAcceptance as the testResults argument.' },
    );
  }
  if (!Array.isArray(feature.acceptance)) {
    throw new AdapterError(
      'FEATURE_ACCEPTANCE_INVALID_ACCEPTANCE',
      'feature.acceptance',
      'feature.acceptance must be an array',
      { fixHint: 'Pass a feature object whose acceptance property is an array of strings.' },
    );
  }
  const total = feature.acceptance.length;
  return {
    met: 0,
    total,
    details: [],
  };
}

module.exports = {
  featureSchema,
  loadFeature,
  validateFeatureAcceptance,
};
