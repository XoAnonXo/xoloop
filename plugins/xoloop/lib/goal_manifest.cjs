'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');

const GOAL_SCHEMA_VERSION = 0.1;

function parseGoalText(text, absolutePath) {
  try {
    return JSON.parse(text);
  } catch (_jsonErr) {
    try {
      // Optional compatibility with hand-written YAML manifests when the
      // plugin environment provides the yaml package. Generated manifests are
      // JSON-compatible YAML so the kernel has no hard runtime dependency.
      // eslint-disable-next-line global-require
      return require('yaml').parse(text);
    } catch (yamlErr) {
      throw new AdapterError(
        'GOAL_MANIFEST_PARSE_FAILED',
        'goalPath',
        `Failed to parse goal manifest as JSON-compatible YAML: ${absolutePath}`,
        { fixHint: yamlErr.message },
      );
    }
  }
}

function readGoalFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  const document = parseGoalText(text, absolutePath);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new AdapterError('GOAL_MANIFEST_NOT_OBJECT', 'goalPath', `Goal manifest must be an object: ${absolutePath}`);
  }
  return { absolutePath, text, document };
}

function writeGoalFile(filePath, payload) {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return absolutePath;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalizeVersion(version) {
  if (version === GOAL_SCHEMA_VERSION || version === String(GOAL_SCHEMA_VERSION)) return GOAL_SCHEMA_VERSION;
  throw new AdapterError(
    'GOAL_SCHEMA_UNSUPPORTED',
    'version',
    `Unsupported goal manifest version: ${version}`,
    { fixHint: `Set version to ${GOAL_SCHEMA_VERSION}.` },
  );
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      fieldName,
      `${fieldName} must be a non-empty string`,
      { fixHint: `Set ${fieldName} to a non-empty string.` },
    );
  }
  return value.trim();
}

function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      fieldName,
      `${fieldName} must be an array`,
      { fixHint: `Set ${fieldName} to an array of strings.` },
    );
  }
  return value.map((item, index) => requireString(item, `${fieldName}[${index}]`));
}

function normalizeCommandExpectation(value, fieldName) {
  if (value === undefined) return [];
  return normalizeStringArray(value, fieldName);
}

function normalizeCommandSuite(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'verify.commands',
      'verify.commands must be a non-empty array for command-suite goals',
      { fixHint: 'Add commands like { id: "syntax", command: "node -c file.cjs" }.' },
    );
  }
  return commands.map((command, index) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new AdapterError('GOAL_SCHEMA_INVALID', `verify.commands[${index}]`, 'command check must be an object');
    }
    return {
      id: requireString(command.id, `verify.commands[${index}].id`),
      command: requireString(command.command, `verify.commands[${index}].command`),
      expect_exit_code: Number.isInteger(command.expect_exit_code) ? command.expect_exit_code : 0,
      expect_stdout_includes: normalizeCommandExpectation(command.expect_stdout_includes, `verify.commands[${index}].expect_stdout_includes`),
      expect_stderr_includes: normalizeCommandExpectation(command.expect_stderr_includes, `verify.commands[${index}].expect_stderr_includes`),
      timeout_ms: Number.isFinite(command.timeout_ms) && command.timeout_ms > 0 ? Math.floor(command.timeout_ms) : 10000,
    };
  });
}

function normalizeCasesManifest(verify, fieldPrefix) {
  const cases = verify.cases;
  if (typeof cases === 'string' && cases.trim()) return cases.trim();
  if (typeof verify.golden_cases === 'string' && verify.golden_cases.trim()) return verify.golden_cases.trim();
  throw new AdapterError(
    'GOAL_SCHEMA_INVALID',
    `${fieldPrefix}.cases`,
    `${fieldPrefix}.cases must be a non-empty glob or file path`,
    { fixHint: 'Add verify.cases: cases/*.json with JSON case objects.' },
  );
}

function normalizeViewport(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterError('GOAL_SCHEMA_INVALID', fieldName, 'viewport must be an object');
  }
  return {
    id: requireString(value.id, `${fieldName}.id`),
    width: Number.isFinite(value.width) && value.width > 0 ? Math.floor(value.width) : 1440,
    height: Number.isFinite(value.height) && value.height > 0 ? Math.floor(value.height) : 900,
  };
}

function normalizeThresholds(value) {
  const thresholds = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    max_pixel_diff_ratio: Number.isFinite(thresholds.max_pixel_diff_ratio) && thresholds.max_pixel_diff_ratio >= 0
      ? thresholds.max_pixel_diff_ratio
      : 0.002,
    min_ssim: Number.isFinite(thresholds.min_ssim) && thresholds.min_ssim >= 0
      ? thresholds.min_ssim
      : 0.995,
  };
}

function normalizeFrontendSuite(verify) {
  return {
    kind: 'frontend-suite',
    cases: normalizeCasesManifest(verify, 'verify'),
    masks: typeof verify.masks === 'string' && verify.masks.trim() ? verify.masks.trim() : 'masks/*.json',
    capture_command: typeof verify.capture_command === 'string' ? verify.capture_command.trim() : '',
    serve_command: typeof verify.serve_command === 'string' ? verify.serve_command.trim() : '',
    serve_ready_url: typeof verify.serve_ready_url === 'string' ? verify.serve_ready_url.trim() : '',
    serve_timeout_ms: Number.isFinite(verify.serve_timeout_ms) && verify.serve_timeout_ms > 0 ? Math.floor(verify.serve_timeout_ms) : 30000,
    baselines_dir: typeof verify.baselines_dir === 'string' && verify.baselines_dir.trim() ? verify.baselines_dir.trim() : 'baselines',
    actual_dir: typeof verify.actual_dir === 'string' && verify.actual_dir.trim() ? verify.actual_dir.trim() : 'actual',
    diffs_dir: typeof verify.diffs_dir === 'string' && verify.diffs_dir.trim() ? verify.diffs_dir.trim() : 'diffs',
    traces_dir: typeof verify.traces_dir === 'string' && verify.traces_dir.trim() ? verify.traces_dir.trim() : 'traces',
    browsers: Array.isArray(verify.browsers) ? normalizeStringArray(verify.browsers, 'verify.browsers') : ['chromium'],
    viewports: Array.isArray(verify.viewports) && verify.viewports.length > 0
      ? verify.viewports.map((viewport, index) => normalizeViewport(viewport, `verify.viewports[${index}]`))
      : [
          { id: 'mobile', width: 390, height: 844 },
          { id: 'tablet', width: 768, height: 1024 },
          { id: 'desktop', width: 1440, height: 900 },
        ],
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    thresholds: normalizeThresholds(verify.thresholds),
    safe_action_policy: typeof verify.safe_action_policy === 'string' ? verify.safe_action_policy.trim() : 'safe-only',
    mock_policy: typeof verify.mock_policy === 'string' ? verify.mock_policy.trim() : 'destructive-or-sensitive-only',
    block_on_gaps: verify.block_on_gaps !== false,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
  };
}

function normalizeCliSuite(verify) {
  return {
    kind: 'cli-suite',
    command: typeof verify.command === 'string' && verify.command.trim() ? verify.command.trim() : '',
    cases: normalizeCasesManifest(verify, 'verify'),
    reference_command: typeof verify.reference_command === 'string' ? verify.reference_command.trim() : '',
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    isolation: typeof verify.isolation === 'string' && verify.isolation.trim() ? verify.isolation.trim() : 'copy-artifacts',
    block_on_gaps: verify.block_on_gaps !== false,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
    fuzz: verify.fuzz && typeof verify.fuzz === 'object' && !Array.isArray(verify.fuzz)
      ? {
          generator: typeof verify.fuzz.generator === 'string' ? verify.fuzz.generator.trim() : '',
          seed: Number.isFinite(verify.fuzz.seed) ? Math.floor(verify.fuzz.seed) : 12345,
          runs: Number.isFinite(verify.fuzz.runs) && verify.fuzz.runs >= 0 ? Math.floor(verify.fuzz.runs) : 0,
          mutate: Array.isArray(verify.fuzz.mutate) ? normalizeStringArray(verify.fuzz.mutate, 'verify.fuzz.mutate') : [],
          arg_values: Array.isArray(verify.fuzz.arg_values) ? normalizeStringArray(verify.fuzz.arg_values, 'verify.fuzz.arg_values') : [],
          stdin_values: Array.isArray(verify.fuzz.stdin_values) ? normalizeStringArray(verify.fuzz.stdin_values, 'verify.fuzz.stdin_values') : [],
          env: verify.fuzz.env && typeof verify.fuzz.env === 'object' && !Array.isArray(verify.fuzz.env) ? verify.fuzz.env : {},
          property: typeof verify.fuzz.property === 'string' ? verify.fuzz.property.trim() : '',
        }
      : { generator: '', seed: 12345, runs: 0, mutate: [], arg_values: [], stdin_values: [], env: {}, property: '' },
  };
}

function normalizeApiSuite(verify) {
  return {
    kind: 'api-suite',
    base_url: typeof verify.base_url === 'string' && verify.base_url.trim() ? verify.base_url.trim() : '',
    cases: normalizeCasesManifest(verify, 'verify'),
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    block_on_gaps: verify.block_on_gaps !== false,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
    setup_command: typeof verify.setup_command === 'string' ? verify.setup_command.trim() : '',
    teardown_command: typeof verify.teardown_command === 'string' ? verify.teardown_command.trim() : '',
    db_snapshot_command: typeof verify.db_snapshot_command === 'string' ? verify.db_snapshot_command.trim() : '',
    db_snapshot: verify.db_snapshot && typeof verify.db_snapshot === 'object' && !Array.isArray(verify.db_snapshot) ? verify.db_snapshot : null,
    db_adapters: Array.isArray(verify.db_adapters) ? verify.db_adapters.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [],
    db_invariant: typeof verify.db_invariant === 'string' ? verify.db_invariant.trim() : '',
    graphql_path: typeof verify.graphql_path === 'string' && verify.graphql_path.trim() ? verify.graphql_path.trim() : '/graphql',
    graphql_introspection: verify.graphql_introspection !== false,
    auth_matrix: verify.auth_matrix && typeof verify.auth_matrix === 'object' && !Array.isArray(verify.auth_matrix) ? verify.auth_matrix : {},
    mutation: verify.mutation && typeof verify.mutation === 'object' && !Array.isArray(verify.mutation)
      ? {
          min_score: Number.isFinite(verify.mutation.min_score) ? verify.mutation.min_score : 1,
          mutants: Array.isArray(verify.mutation.mutants) ? verify.mutation.mutants.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [],
        }
      : { min_score: 1, mutants: [] },
    latency_confidence_runs: Number.isFinite(verify.latency_confidence_runs) && verify.latency_confidence_runs > 0 ? Math.floor(verify.latency_confidence_runs) : 3,
    latency_noise_tolerance: Number.isFinite(verify.latency_noise_tolerance) && verify.latency_noise_tolerance >= 0 ? verify.latency_noise_tolerance : 0.05,
    fuzz: verify.fuzz && typeof verify.fuzz === 'object' && !Array.isArray(verify.fuzz)
      ? {
          generator: typeof verify.fuzz.generator === 'string' ? verify.fuzz.generator.trim() : '',
          seed: Number.isFinite(verify.fuzz.seed) ? Math.floor(verify.fuzz.seed) : 12345,
          runs: Number.isFinite(verify.fuzz.runs) && verify.fuzz.runs >= 0 ? Math.floor(verify.fuzz.runs) : 0,
          negative_statuses: Array.isArray(verify.fuzz.negative_statuses)
            ? verify.fuzz.negative_statuses.filter(Number.isInteger)
            : [400, 422],
          error_shape: verify.fuzz.error_shape && typeof verify.fuzz.error_shape === 'object' && !Array.isArray(verify.fuzz.error_shape)
            ? verify.fuzz.error_shape
            : { required: ['error'] },
        }
      : { generator: '', seed: 12345, runs: 0, negative_statuses: [400, 422], error_shape: { required: ['error'] } },
  };
}

function normalizeObjectArray(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      fieldName,
      `${fieldName} must be an array`,
      { fixHint: `Set ${fieldName} to an array of objects.` },
    );
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AdapterError('GOAL_SCHEMA_INVALID', `${fieldName}[${index}]`, `${fieldName}[${index}] must be an object`);
    }
    return item;
  });
}

function normalizeStateSuite(verify) {
  return {
    kind: 'state-suite',
    command: typeof verify.command === 'string' ? verify.command.trim() : '',
    cases: normalizeCasesManifest(verify, 'verify'),
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    block_on_gaps: verify.block_on_gaps !== false,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
    setup_command: typeof verify.setup_command === 'string' ? verify.setup_command.trim() : '',
    teardown_command: typeof verify.teardown_command === 'string' ? verify.teardown_command.trim() : '',
    snapshot_command: typeof verify.snapshot_command === 'string' ? verify.snapshot_command.trim() : '',
    adapters: normalizeObjectArray(verify.adapters || verify.db_adapters, 'verify.adapters'),
    db_adapters: normalizeObjectArray(verify.db_adapters, 'verify.db_adapters'),
    orchestration: verify.orchestration && typeof verify.orchestration === 'object' && !Array.isArray(verify.orchestration) ? verify.orchestration : {},
    snapshot: verify.snapshot && typeof verify.snapshot === 'object' && !Array.isArray(verify.snapshot) ? verify.snapshot : {},
    redactions: normalizeObjectArray(verify.redactions, 'verify.redactions'),
    masks: normalizeObjectArray(verify.masks, 'verify.masks'),
    migrate_command: typeof verify.migrate_command === 'string' ? verify.migrate_command.trim() : '',
    migration_up_command: typeof verify.migration_up_command === 'string' ? verify.migration_up_command.trim() : '',
    migration_down_command: typeof verify.migration_down_command === 'string' ? verify.migration_down_command.trim() : '',
    migration_drift_command: typeof verify.migration_drift_command === 'string' ? verify.migration_drift_command.trim() : '',
    migration_checksum_file: typeof verify.migration_checksum_file === 'string' ? verify.migration_checksum_file.trim() : '',
    migration_files: Array.isArray(verify.migration_files) ? normalizeStringArray(verify.migration_files, 'verify.migration_files') : [],
    rollback_command: typeof verify.rollback_command === 'string' ? verify.rollback_command.trim() : '',
    transaction: verify.transaction && typeof verify.transaction === 'object' && !Array.isArray(verify.transaction) ? verify.transaction : {},
    query_log: verify.query_log && typeof verify.query_log === 'object' && !Array.isArray(verify.query_log) ? verify.query_log : {},
    write_log_command: typeof verify.write_log_command === 'string' ? verify.write_log_command.trim() : '',
    tenant_matrix: verify.tenant_matrix && typeof verify.tenant_matrix === 'object' && !Array.isArray(verify.tenant_matrix) ? verify.tenant_matrix : {},
    action_policy: typeof verify.action_policy === 'string' && verify.action_policy.trim() ? verify.action_policy.trim() : 'block-destructive',
    fixture: verify.fixture && typeof verify.fixture === 'object' && !Array.isArray(verify.fixture) ? verify.fixture : {},
    budgets: verify.budgets && typeof verify.budgets === 'object' && !Array.isArray(verify.budgets) ? verify.budgets : {},
    invariants_file: typeof verify.invariants_file === 'string' ? verify.invariants_file.trim() : '',
    invariants: normalizeObjectArray(verify.invariants, 'verify.invariants'),
    tenant_isolation: normalizeObjectArray(verify.tenant_isolation, 'verify.tenant_isolation'),
    allowed_writes: Array.isArray(verify.allowed_writes) ? normalizeStringArray(verify.allowed_writes, 'verify.allowed_writes') : null,
    forbidden_writes: Array.isArray(verify.forbidden_writes) ? normalizeStringArray(verify.forbidden_writes, 'verify.forbidden_writes') : [],
    snapshots_dir: typeof verify.snapshots_dir === 'string' && verify.snapshots_dir.trim() ? verify.snapshots_dir.trim() : 'snapshots',
    diffs_dir: typeof verify.diffs_dir === 'string' && verify.diffs_dir.trim() ? verify.diffs_dir.trim() : 'diffs',
    traces_dir: typeof verify.traces_dir === 'string' && verify.traces_dir.trim() ? verify.traces_dir.trim() : 'traces',
  };
}

function normalizeStateMachineSuite(verify) {
  return {
    kind: 'state-machine-suite',
    command: typeof verify.command === 'string' ? verify.command.trim() : '',
    reference_command: typeof verify.reference_command === 'string' ? verify.reference_command.trim() : '',
    cases: normalizeCasesManifest(verify, 'verify'),
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    block_on_gaps: verify.block_on_gaps !== false,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
    model_file: typeof verify.model_file === 'string' ? verify.model_file.trim() : '',
    model: verify.model && typeof verify.model === 'object' && !Array.isArray(verify.model) ? verify.model : null,
    valid_states: Array.isArray(verify.valid_states) ? normalizeStringArray(verify.valid_states, 'verify.valid_states') : [],
    terminal_states: Array.isArray(verify.terminal_states) ? normalizeStringArray(verify.terminal_states, 'verify.terminal_states') : [],
    impossible_states: Array.isArray(verify.impossible_states) ? verify.impossible_states : [],
    invariants: normalizeObjectArray(verify.invariants, 'verify.invariants'),
  };
}

function normalizeConcurrencySuite(verify) {
  return {
    kind: 'concurrency-suite',
    command: typeof verify.command === 'string' ? verify.command.trim() : '',
    reference_command: typeof verify.reference_command === 'string' ? verify.reference_command.trim() : '',
    cases: normalizeCasesManifest(verify, 'verify'),
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    block_on_gaps: verify.block_on_gaps !== false,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
    schedules_dir: typeof verify.schedules_dir === 'string' && verify.schedules_dir.trim() ? verify.schedules_dir.trim() : 'schedules',
    clock: verify.clock && typeof verify.clock === 'object' && !Array.isArray(verify.clock) ? verify.clock : null,
  };
}

function normalizePerformanceSuite(verify) {
  return {
    kind: 'performance-suite',
    command: typeof verify.command === 'string' ? verify.command.trim() : '',
    baseline_command: typeof verify.baseline_command === 'string' ? verify.baseline_command.trim() : '',
    cases: normalizeCasesManifest(verify, 'verify'),
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    block_on_gaps: verify.block_on_gaps !== false,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
    setup_command: typeof verify.setup_command === 'string' ? verify.setup_command.trim() : '',
    teardown_command: typeof verify.teardown_command === 'string' ? verify.teardown_command.trim() : '',
    serve_command: typeof verify.serve_command === 'string' ? verify.serve_command.trim() : '',
    serve_ready_url: typeof verify.serve_ready_url === 'string' ? verify.serve_ready_url.trim() : '',
    serve_timeout_ms: Number.isFinite(verify.serve_timeout_ms) && verify.serve_timeout_ms > 0 ? Math.floor(verify.serve_timeout_ms) : 30000,
    url: typeof verify.url === 'string' ? verify.url.trim() : '',
    browser: typeof verify.browser === 'string' && verify.browser.trim() ? verify.browser.trim() : 'chromium',
    viewport: verify.viewport && typeof verify.viewport === 'object' && !Array.isArray(verify.viewport) ? verify.viewport : {},
    warmup: Number.isFinite(verify.warmup) && verify.warmup >= 0 ? Math.floor(verify.warmup) : 1,
    repeat: Number.isFinite(verify.repeat) && verify.repeat > 0 ? Math.floor(verify.repeat) : 9,
    cooldown_ms: Number.isFinite(verify.cooldown_ms) && verify.cooldown_ms >= 0 ? Math.floor(verify.cooldown_ms) : 0,
    noise: verify.noise && typeof verify.noise === 'object' && !Array.isArray(verify.noise) ? verify.noise : {},
    environment: verify.environment && typeof verify.environment === 'object' && !Array.isArray(verify.environment) ? verify.environment : {},
    budgets: verify.budgets && typeof verify.budgets === 'object' && !Array.isArray(verify.budgets) ? verify.budgets : {},
    baseline: verify.baseline && typeof verify.baseline === 'object' && !Array.isArray(verify.baseline)
      ? verify.baseline
      : (verify.baselines && typeof verify.baselines === 'object' && !Array.isArray(verify.baselines) ? verify.baselines : {}),
    baselines: verify.baselines && typeof verify.baselines === 'object' && !Array.isArray(verify.baselines) ? verify.baselines : {},
    improvement_targets: Array.isArray(verify.improvement_targets)
      ? verify.improvement_targets.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      : (verify.improvement_targets && typeof verify.improvement_targets === 'object' && !Array.isArray(verify.improvement_targets) ? verify.improvement_targets : []),
    paired: verify.paired === true || (verify.paired && typeof verify.paired === 'object' && !Array.isArray(verify.paired)) ? verify.paired : false,
    bundle_files: Array.isArray(verify.bundle_files) ? normalizeStringArray(verify.bundle_files, 'verify.bundle_files') : [],
    actual_dir: typeof verify.actual_dir === 'string' && verify.actual_dir.trim() ? verify.actual_dir.trim() : 'actual',
    diffs_dir: typeof verify.diffs_dir === 'string' && verify.diffs_dir.trim() ? verify.diffs_dir.trim() : 'diffs',
    traces_dir: typeof verify.traces_dir === 'string' && verify.traces_dir.trim() ? verify.traces_dir.trim() : 'traces',
    profiles_dir: typeof verify.profiles_dir === 'string' && verify.profiles_dir.trim() ? verify.profiles_dir.trim() : 'profiles',
  };
}

function normalizeFormalSuite(verify) {
  return {
    kind: 'formal-suite',
    cases: normalizeCasesManifest(verify, 'verify'),
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    block_on_gaps: verify.block_on_gaps !== false,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
    required_categories: Array.isArray(verify.required_categories) ? normalizeStringArray(verify.required_categories, 'verify.required_categories') : [],
    language_presets: Array.isArray(verify.language_presets)
      ? verify.language_presets.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      : (verify.language_presets && typeof verify.language_presets === 'object' && !Array.isArray(verify.language_presets) ? verify.language_presets : []),
    supported_language_presets: verify.supported_language_presets && typeof verify.supported_language_presets === 'object' && !Array.isArray(verify.supported_language_presets) ? verify.supported_language_presets : {},
    tool_install_guidance: Array.isArray(verify.tool_install_guidance)
      ? verify.tool_install_guidance.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      : [],
    security_severity_threshold: typeof verify.security_severity_threshold === 'string' && verify.security_severity_threshold.trim() ? verify.security_severity_threshold.trim() : 'high',
    severity_threshold: typeof verify.severity_threshold === 'string' ? verify.severity_threshold.trim() : '',
    coverage: verify.coverage && typeof verify.coverage === 'object' && !Array.isArray(verify.coverage) ? verify.coverage : {},
    timeout_ms: Number.isFinite(verify.timeout_ms) && verify.timeout_ms > 0 ? Math.floor(verify.timeout_ms) : 120000,
  };
}

function normalizeDiscoverySuite(verify) {
  return {
    kind: 'discovery-suite',
    properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
    block_on_gaps: verify.block_on_gaps !== false,
    accepted_gaps: Array.isArray(verify.accepted_gaps) ? normalizeStringArray(verify.accepted_gaps, 'verify.accepted_gaps') : [],
    accepted_gap_file: typeof verify.accepted_gap_file === 'string' ? verify.accepted_gap_file.trim() : '',
    discovery_file: typeof verify.discovery_file === 'string' ? verify.discovery_file.trim() : '',
    require_discovery: verify.require_discovery === true,
    scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
  };
}

function normalizeSuiteObligations(verify) {
  if (!Array.isArray(verify.obligations) || verify.obligations.length === 0) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'verify.obligations',
      'suite goals require a non-empty verify.obligations array',
      { fixHint: 'Add obligations like { id: "frontend", kind: "frontend-suite", cases: "cases/*.json" }.' },
    );
  }
  return verify.obligations.map((obligation, index) => {
    if (!obligation || typeof obligation !== 'object' || Array.isArray(obligation)) {
      throw new AdapterError('GOAL_SCHEMA_INVALID', `verify.obligations[${index}]`, 'suite obligation must be an object');
    }
    const kind = requireString(obligation.kind, `verify.obligations[${index}].kind`);
    return {
      id: typeof obligation.id === 'string' && obligation.id.trim() ? obligation.id.trim() : `${kind}-${index + 1}`,
      ...obligation,
      kind,
    };
  });
}

function normalizeGoalDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'document',
      'Goal manifest must be a YAML mapping',
      { fixHint: 'Rewrite the goal manifest so its top level is a key/value mapping.' },
    );
  }

  const goalId = requireString(document.goal_id, 'goal_id');
  const iface = document.interface;
  if (!iface || typeof iface !== 'object' || Array.isArray(iface)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'interface',
      'interface must be an object',
      { fixHint: 'Add interface: { type: cli, command: "...", stdin: json, stdout: text }.' },
    );
  }
  const verify = document.verify;
  if (!verify || typeof verify !== 'object' || Array.isArray(verify)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'verify',
      'verify must be an object',
      { fixHint: 'Add verify.golden_cases and verification properties.' },
    );
  }
  const metrics = document.metrics && typeof document.metrics === 'object' && !Array.isArray(document.metrics)
    ? document.metrics
    : {};
  const acceptance = document.acceptance && typeof document.acceptance === 'object' && !Array.isArray(document.acceptance)
    ? document.acceptance
    : {};
  const goalMaker = document.goal_maker && typeof document.goal_maker === 'object' && !Array.isArray(document.goal_maker)
    ? document.goal_maker
    : null;
  const artifacts = document.artifacts && typeof document.artifacts === 'object' && !Array.isArray(document.artifacts)
    ? document.artifacts
    : {};

  const verifyKind = typeof verify.kind === 'string' ? verify.kind.trim() : 'json-canonicalizer';
  const normalizedVerify = verifyKind === 'command-suite'
    ? {
        kind: verifyKind,
        commands: normalizeCommandSuite(verify.commands),
      }
    : verifyKind === 'general-io'
      ? {
          kind: verifyKind,
          cases: normalizeCasesManifest(verify, 'verify'),
          reference_command: typeof verify.reference_command === 'string' ? verify.reference_command.trim() : '',
          fuzz: verify.fuzz && typeof verify.fuzz === 'object' && !Array.isArray(verify.fuzz)
            ? {
                generator: typeof verify.fuzz.generator === 'string' ? verify.fuzz.generator.trim() : '',
                seed: Number.isFinite(verify.fuzz.seed) ? Math.floor(verify.fuzz.seed) : 12345,
                runs: Number.isFinite(verify.fuzz.runs) && verify.fuzz.runs >= 0 ? Math.floor(verify.fuzz.runs) : 0,
              }
            : { generator: '', seed: 12345, runs: 0 },
          properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
        }
    : verifyKind === 'frontend-suite'
      ? normalizeFrontendSuite(verify)
    : verifyKind === 'cli-suite'
      ? normalizeCliSuite(verify)
    : verifyKind === 'api-suite'
      ? normalizeApiSuite(verify)
    : verifyKind === 'state-suite'
      ? normalizeStateSuite(verify)
    : verifyKind === 'state-machine-suite'
      ? normalizeStateMachineSuite(verify)
    : verifyKind === 'concurrency-suite'
      ? normalizeConcurrencySuite(verify)
    : verifyKind === 'performance-suite'
      ? normalizePerformanceSuite(verify)
    : verifyKind === 'formal-suite'
      ? normalizeFormalSuite(verify)
    : verifyKind === 'discovery-suite'
      ? normalizeDiscoverySuite(verify)
    : verifyKind === 'suite'
      ? {
          kind: 'suite',
          block_on_gaps: verify.block_on_gaps !== false,
          surfaces: Array.isArray(verify.surfaces) ? normalizeStringArray(verify.surfaces, 'verify.surfaces') : [],
          scan: verify.scan && typeof verify.scan === 'object' && !Array.isArray(verify.scan) ? verify.scan : {},
          obligations: normalizeSuiteObligations(verify),
        }
    : {
        kind: verifyKind,
        golden_cases: requireString(verify.golden_cases, 'verify.golden_cases'),
        benchmark_cases: typeof verify.benchmark_cases === 'string' ? verify.benchmark_cases.trim() : '',
        fuzz: verify.fuzz && typeof verify.fuzz === 'object' && !Array.isArray(verify.fuzz)
          ? {
              generator: typeof verify.fuzz.generator === 'string' ? verify.fuzz.generator.trim() : 'json-subset',
              seed: Number.isFinite(verify.fuzz.seed) ? Math.floor(verify.fuzz.seed) : 12345,
              runs: Number.isFinite(verify.fuzz.runs) && verify.fuzz.runs >= 0 ? Math.floor(verify.fuzz.runs) : 0,
            }
          : { generator: 'json-subset', seed: 12345, runs: 0 },
        properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
      };

  const normalized = {
    version: normalizeVersion(document.version),
    goal_id: goalId,
    objective: typeof document.objective === 'string' ? document.objective.trim() : '',
    interface: {
      type: requireString(iface.type, 'interface.type'),
      command: requireString(iface.command, 'interface.command'),
      stdin: typeof iface.stdin === 'string' ? iface.stdin.trim() : 'text',
      stdout: typeof iface.stdout === 'string' ? iface.stdout.trim() : 'text',
      timeout_ms: Number.isFinite(iface.timeout_ms) && iface.timeout_ms > 0 ? Math.floor(iface.timeout_ms) : 10000,
      ...(typeof iface.base_url === 'string' && iface.base_url.trim() ? { base_url: iface.base_url.trim() } : {}),
    },
    artifacts: {
      paths: Array.isArray(artifacts.paths) ? normalizeStringArray(artifacts.paths, 'artifacts.paths') : [],
    },
    ...(goalMaker ? { goal_maker: goalMaker } : {}),
    verify: {
      ...normalizedVerify,
    },
    metrics: {
      repeat: Number.isFinite(metrics.repeat) && metrics.repeat > 0 ? Math.floor(metrics.repeat) : 1,
      targets: Array.isArray(metrics.targets) ? metrics.targets.map((target, index) => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
          throw new AdapterError('GOAL_SCHEMA_INVALID', `metrics.targets[${index}]`, 'metric target must be an object');
        }
        return {
          name: requireString(target.name, `metrics.targets[${index}].name`),
          direction: target.direction === 'maximize' ? 'maximize' : 'minimize',
          threshold: Number.isFinite(target.threshold) && target.threshold >= 0 ? target.threshold : 0,
        };
      }) : [],
    },
    acceptance: {
      require_all_verifications: acceptance.require_all_verifications !== false,
      max_metric_regression: Number.isFinite(acceptance.max_metric_regression) && acceptance.max_metric_regression >= 0
        ? acceptance.max_metric_regression
        : 0,
      accept_if_any_target_improves: acceptance.accept_if_any_target_improves !== false,
      require_discovery: acceptance.require_discovery === true,
      discovery_file: typeof acceptance.discovery_file === 'string' ? acceptance.discovery_file.trim() : '',
      accepted_discovery_gaps: Array.isArray(acceptance.accepted_discovery_gaps)
        ? normalizeStringArray(acceptance.accepted_discovery_gaps, 'acceptance.accepted_discovery_gaps')
        : [],
      accepted_tradeoffs: Array.isArray(acceptance.accepted_tradeoffs)
        ? normalizeStringArray(acceptance.accepted_tradeoffs, 'acceptance.accepted_tradeoffs')
        : [],
      rejected_tradeoffs: Array.isArray(acceptance.rejected_tradeoffs)
        ? normalizeStringArray(acceptance.rejected_tradeoffs, 'acceptance.rejected_tradeoffs')
        : [],
      ...(typeof acceptance.tradeoff_policy === 'string' && acceptance.tradeoff_policy.trim()
        ? { tradeoff_policy: acceptance.tradeoff_policy.trim() }
        : {}),
    },
  };

  if (!['cli', 'command-suite', 'frontend', 'api', 'state', 'state-machine', 'async', 'performance', 'formal', 'discovery', 'suite'].includes(normalized.interface.type)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'interface.type',
      `Unsupported interface type: ${normalized.interface.type}`,
      { fixHint: 'v0 supports interface.type: cli, command-suite, frontend, api, state, state-machine, async, performance, formal, discovery, or suite.' },
    );
  }
  if (!['json-canonicalizer', 'command-suite', 'general-io', 'frontend-suite', 'cli-suite', 'api-suite', 'state-suite', 'state-machine-suite', 'concurrency-suite', 'performance-suite', 'formal-suite', 'discovery-suite', 'suite'].includes(normalized.verify.kind)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'verify.kind',
      `Unsupported verify kind: ${normalized.verify.kind}`,
      { fixHint: 'v0 supports verify.kind: json-canonicalizer, general-io, cli-suite, api-suite, state-suite, state-machine-suite, concurrency-suite, performance-suite, formal-suite, discovery-suite, frontend-suite, suite, or command-suite.' },
    );
  }

  return normalized;
}

function manifestHash(goal) {
  return `sha256:${sha256Hex(stableStringify(goal))}`;
}

function expandHashInputPath(repoRoot, baseDir, rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return [];
  const absolute = path.isAbsolute(text) ? text : path.resolve(baseDir || repoRoot, text);
  if (text.endsWith('*.json')) {
    const dir = absolute.slice(0, -'*.json'.length);
    if (!fs.existsSync(dir)) return [absolute];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
  }
  if (fs.existsSync(absolute)) {
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      const files = [];
      const stack = [absolute];
      while (stack.length > 0) {
        const dir = stack.pop();
        for (const name of fs.readdirSync(dir).sort()) {
          const child = path.join(dir, name);
          const childStat = fs.statSync(child);
          if (childStat.isDirectory()) stack.push(child);
          else if (childStat.isFile()) files.push(child);
        }
      }
      return files.sort();
    }
  }
  return [absolute];
}

function verificationHashInputPaths(goal, repoRoot, baseDir) {
  const verify = goal && goal.verify && typeof goal.verify === 'object' ? goal.verify : {};
  const inputs = [
    verify.cases,
    verify.golden_cases,
    verify.benchmark_cases,
    verify.masks,
    verify.baselines_dir,
    verify.baseline_dir,
    verify.baselines,
    verify.schedules_dir,
    verify.discovery_file,
    verify.accepted_gap_file,
    verify.invariants_file,
  ].filter((item) => typeof item === 'string' && item.trim());
  const paths = [];
  for (const input of inputs) paths.push(...expandHashInputPath(repoRoot, baseDir, input));
  if (verify.kind === 'suite') {
    for (const obligation of Array.isArray(verify.obligations) ? verify.obligations : []) {
      const childBaseDir = typeof obligation.goal_path === 'string' && obligation.goal_path.trim()
        ? path.dirname(path.isAbsolute(obligation.goal_path) ? obligation.goal_path : path.resolve(baseDir, obligation.goal_path))
        : baseDir;
      paths.push(...verificationHashInputPaths({ verify: obligation }, repoRoot, childBaseDir));
      if (typeof obligation.goal_path === 'string' && obligation.goal_path.trim()) {
        const childGoalPath = path.isAbsolute(obligation.goal_path)
          ? obligation.goal_path
          : path.resolve(baseDir, obligation.goal_path);
        paths.push(childGoalPath);
        try {
          const child = readGoalFile(childGoalPath).document;
          paths.push(...verificationHashInputPaths(child, repoRoot, path.dirname(childGoalPath)));
        } catch (_err) {
          paths.push(`${childGoalPath}.missing`);
        }
      }
    }
  }
  return paths;
}

function artifactHash(goal, cwd, goalPath = null) {
  const repoRoot = path.resolve(cwd || process.cwd());
  const baseDir = goalPath ? goalBaseDir(goalPath) : repoRoot;
  const paths = [
    ...(Array.isArray(goal.artifacts && goal.artifacts.paths) ? goal.artifacts.paths : []).map((rel) => path.resolve(repoRoot, rel)),
    ...verificationHashInputPaths(goal, repoRoot, baseDir),
  ].sort();
  const entries = [];
  const seen = new Set();
  for (const absolute of paths) {
    const rel = path.relative(repoRoot, absolute).replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch (_err) {
      entries.push({ path: rel, missing: true });
      continue;
    }
    if (!stat.isFile()) {
      entries.push({ path: rel, non_file: true });
      continue;
    }
    const buffer = fs.readFileSync(absolute);
    entries.push({
      path: rel,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
    });
  }
  return `sha256:${sha256Hex(stableStringify(entries))}`;
}

function goalBaseDir(goalPath) {
  return path.dirname(path.resolve(goalPath));
}

function evidencePathForGoal(goalPath) {
  return path.join(goalBaseDir(goalPath), 'evidence.jsonl');
}

function expandSimpleJsonGlob(goalPath, pattern, cwd) {
  const rawPattern = requireString(pattern, 'glob');
  const baseDir = goalBaseDir(goalPath);
  const repoRoot = path.resolve(cwd || process.cwd());
  let absolutePattern = path.isAbsolute(rawPattern) ? rawPattern : path.resolve(baseDir, rawPattern);
  if (!fs.existsSync(absolutePattern.replace(/\*\.json$/, '')) && !path.isAbsolute(rawPattern)) {
    absolutePattern = path.resolve(repoRoot, rawPattern);
  }
  if (!absolutePattern.endsWith('*.json')) {
    const filePath = absolutePattern;
    return fs.existsSync(filePath) ? [filePath] : [];
  }
  const dir = absolutePattern.slice(0, -'*.json'.length);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

function loadGoalManifest(goalPath) {
  const read = readGoalFile(goalPath);
  const goal = normalizeGoalDocument(read.document);
  return {
    goalPath: read.absolutePath,
    goal,
    manifest_hash: manifestHash(goal),
  };
}

function writeGoalManifest(goalPath, goal) {
  const normalized = normalizeGoalDocument(goal);
  fs.mkdirSync(path.dirname(path.resolve(goalPath)), { recursive: true });
  writeGoalFile(goalPath, normalized);
  return {
    goalPath: path.resolve(goalPath),
    goal: normalized,
    manifest_hash: manifestHash(normalized),
  };
}

module.exports = {
  GOAL_SCHEMA_VERSION,
  artifactHash,
  evidencePathForGoal,
  expandSimpleJsonGlob,
  goalBaseDir,
  loadGoalManifest,
  manifestHash,
  normalizeGoalDocument,
  stableStringify,
  writeGoalManifest,
};
