const path = require('node:path');

const { z } = require('zod');

const { readYamlFile } = require('./overnight_yaml.cjs');
const { AdapterError } = require('./errors.cjs');

// --------------------------------------------------------------------------
// Zod schema for directive YAML files
// --------------------------------------------------------------------------

const directiveTypeEnum = z.enum(['bug', 'performance', 'feature']);
const actionEnum = z.enum(['polish', 'improve', 'build']);
const priorityEnum = z.enum(['P0', 'P1', 'P2', 'P3']);

const bugEvidenceSchema = z.object({
  error_message: z.string().min(1),
  stack_trace: z.string().optional(),
  repro_steps: z.array(z.string().min(1)).min(1),
  affected_versions: z.array(z.string().min(1)).optional().default([]),
});

const performanceEvidenceSchema = z.object({
  metric: z.string().min(1),
  current_value: z.number(),
  target_value: z.number(),
  unit: z.string().min(1),
  measurement_tool: z.string().optional(),
});

const featureEvidenceSchema = z.object({
  user_request: z.string().min(1),
  use_case: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
});

const evidenceByType = {
  bug: bugEvidenceSchema,
  performance: performanceEvidenceSchema,
  feature: featureEvidenceSchema,
};

const directiveSchema = z.object({
  directive: directiveTypeEnum,
  version: z.number().int().min(1),
  source: z.string().min(1),
  generated: z.string().min(1),
  expires: z.string().nullable().optional().default(null),
  evidence: z.record(z.string(), z.any()),
  action: actionEnum,
  target_surface: z.string().min(1),
  priority: priorityEnum,
  reason: z.string().min(1),
  // performance-only optional fields
  benchmark_path: z.string().nullable().optional().default(null),
  target_improvement: z.number().nullable().optional().default(null),
  // feature-only optional fields
  feature_description: z.string().nullable().optional().default(null),
  requires_approval: z.boolean().optional().default(false),
});

// --------------------------------------------------------------------------
// validateDirective — validate an already-parsed document
// --------------------------------------------------------------------------

function validateDirective(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new AdapterError(
      'DIRECTIVE_SCHEMA_INVALID',
      'document',
      'directive document must be a non-null object',
      { fixHint: 'Pass a valid object (parsed from YAML) to validateDirective.' },
    );
  }

  // Check directive type first to produce DIRECTIVE_UNKNOWN_TYPE for bad types
  const typeValue = document.directive;
  if (typeValue !== undefined && typeValue !== null && typeof typeValue === 'string') {
    const typeResult = directiveTypeEnum.safeParse(typeValue);
    if (!typeResult.success) {
      throw new AdapterError(
        'DIRECTIVE_UNKNOWN_TYPE',
        'directive',
        `unknown directive type: ${typeValue}`,
        { fixHint: `Change directive type to one of: bug, performance, feature. Got: "${typeValue}"` },
      );
    }
  }

  // Validate envelope schema
  const parsed = directiveSchema.safeParse(document);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const zodPath = firstIssue.path.join('.');
    throw new AdapterError(
      'DIRECTIVE_SCHEMA_INVALID',
      zodPath || 'directive',
      firstIssue.message,
      { fixHint: `Fix field "${zodPath || '(root)'}" in the directive: ${firstIssue.message}` },
    );
  }

  const data = parsed.data;

  // Validate type-specific evidence block
  const evidenceSchema = evidenceByType[data.directive];
  const evidenceParsed = evidenceSchema.safeParse(data.evidence);
  if (!evidenceParsed.success) {
    const firstIssue = evidenceParsed.error.issues[0];
    const zodPath = 'evidence.' + firstIssue.path.join('.');
    throw new AdapterError(
      'DIRECTIVE_SCHEMA_INVALID',
      zodPath,
      firstIssue.message,
      { fixHint: `Fix field "${zodPath}" in the directive evidence block: ${firstIssue.message}` },
    );
  }

  return normalizeDirective(data, evidenceParsed.data, null);
}

// --------------------------------------------------------------------------
// loadDirective — load + validate YAML, return normalized object
// --------------------------------------------------------------------------

function loadDirective(directivePath, options) {
  if (!options || typeof options !== 'object') options = {};
  if (!directivePath || typeof directivePath !== 'string') {
    throw new AdapterError(
      'DIRECTIVE_INVALID_PATH',
      'directivePath',
      'directivePath must be a non-empty string',
      { fixHint: 'Pass the relative or absolute path to the directive YAML file as the first argument to loadDirective.' },
    );
  }

  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const resolvedPath = path.resolve(repoRoot, directivePath);

  // 1. Read YAML file
  let loaded;
  try {
    loaded = readYamlFile(resolvedPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new AdapterError(
        'DIRECTIVE_FILE_NOT_FOUND',
        'directivePath',
        `directive file not found: ${resolvedPath}`,
        { fixHint: `Create ${resolvedPath} or correct the path passed to loadDirective.`, cause: err },
      );
    }
    throw err;
  }

  // 2. Validate the parsed document (reuses validateDirective to avoid duplication)
  const result = validateDirective(loaded.document);
  result.sourcePath = resolvedPath;
  return result;
}

// --------------------------------------------------------------------------
// normalizeDirective — map snake_case YAML to camelCase return shape
// --------------------------------------------------------------------------

function normalizeDirective(data, evidence, resolvedPath) {
  return {
    directive: data.directive,
    version: data.version,
    source: data.source,
    generated: data.generated,
    expires: data.expires || null,
    evidence,
    action: data.action,
    targetSurface: data.target_surface,
    priority: data.priority,
    reason: data.reason,
    sourcePath: resolvedPath,
    // performance-only
    benchmarkPath: data.benchmark_path || null,
    targetImprovement: data.target_improvement !== undefined ? data.target_improvement : null,
    // feature-only
    featureDescription: data.feature_description || null,
    requiresApproval: data.requires_approval || false,
  };
}

module.exports = {
  directiveSchema,
  loadDirective,
  validateDirective,
};
