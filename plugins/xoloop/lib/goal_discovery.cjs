'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { scanApiRepo } = require('./goal_api_scan.cjs');
const { scanCliRepo } = require('./goal_cli_scan.cjs');
const { scanConcurrencyRepo } = require('./goal_concurrency_scan.cjs');
const { scanFormalRepo } = require('./goal_formal_scan.cjs');
const { scanFrontendRepo } = require('./goal_frontend_scan.cjs');
const { scanPerformanceRepo } = require('./goal_performance_scan.cjs');
const { scanStateMachineRepo } = require('./goal_state_machine_scan.cjs');
const { scanStateRepo } = require('./goal_state_scan.cjs');
const {
  artifactHash,
  evidencePathForGoal,
  goalBaseDir,
  loadGoalManifest,
  manifestHash,
} = require('./goal_manifest.cjs');
const {
  currentVerificationRecords,
  latestRecord,
  readEvidence,
} = require('./goal_evidence.cjs');

const DEFAULT_DISCOVERY_OBLIGATIONS = [
  'surface_inventory',
  'observable_surfaces',
  'automatic_verification',
  'risk_gaps',
  'suggested_harnesses',
  'repo_topology',
  'dataflow_analysis',
  'safety_classification',
  'remediation_plan',
  'optimization_block',
  'gap_acceptance',
];

const SURFACE_ORDER = [
  'frontend',
  'api',
  'state',
  'state-machine',
  'concurrency',
  'performance',
  'formal',
  'cli',
];

const SURFACE_HARNESSES = {
  frontend: {
    kind: 'frontend-suite',
    goal_id: 'frontend-suite',
    label: 'Frontend perception and interaction suite',
    covers: [
      'visual screenshots',
      'DOM/a11y semantics',
      'hover/focus/keyboard/click flows',
      'console, network, events, and web perf traces',
    ],
  },
  api: {
    kind: 'api-suite',
    goal_id: 'api-suite',
    label: 'API contract and side-effect suite',
    covers: [
      'routes and schema conformance',
      'auth/tenant matrices',
      'latency budgets',
      'database side-effect snapshots',
    ],
  },
  state: {
    kind: 'state-suite',
    goal_id: 'state-suite',
    label: 'Database/state verification suite',
    covers: [
      'schema-aware snapshots',
      'migration drift and checksum checks',
      'rollback behavior',
      'tenant isolation and unexpected writes',
    ],
  },
  'state-machine': {
    kind: 'state-machine-suite',
    goal_id: 'state-machine-suite',
    label: 'Workflow/state-machine verification suite',
    covers: [
      'command replay',
      'state invariants',
      'impossible states',
      'reference model coverage',
    ],
  },
  concurrency: {
    kind: 'concurrency-suite',
    goal_id: 'concurrency-suite',
    label: 'Concurrency/time verification suite',
    covers: [
      'deterministic schedules',
      'fake clocks',
      'race tooling',
      'async replay traces',
    ],
  },
  performance: {
    kind: 'performance-suite',
    goal_id: 'performance-suite',
    label: 'Stable performance verification suite',
    covers: [
      'p50/p95/p99 distributions',
      'paired champion/challenger benchmarking',
      'CPU/RSS and frontend web vitals',
      'bundle and dependency attribution',
    ],
  },
  formal: {
    kind: 'formal-suite',
    goal_id: 'formal-suite',
    label: 'Formal/static verification suite',
    covers: [
      'type checks and lint',
      'property/fuzz harnesses',
      'security analyzers',
      'model checking and proof templates',
    ],
  },
  cli: {
    kind: 'cli-suite',
    goal_id: 'cli-suite',
    label: 'CLI input/output suite',
    covers: [
      'stdout/stderr/exit-code contracts',
      'argument and stdin fuzzing',
      'safe/destructive command classification',
      'golden replay cases',
    ],
  },
};

const DEFAULT_OBLIGATIONS_BY_KIND = {
  'frontend-suite': [
    'baseline_present',
    'visual_perception',
    'semantic_dom',
    'accessibility',
    'interaction_behavior',
    'network_contract',
    'event_contract',
    'console_clean',
    'performance_budget',
  ],
  'api-suite': [
    'case_present',
    'surface_coverage',
    'status_code',
    'request_schema',
    'response_schema',
    'error_shape',
    'auth_invariant',
    'auth_matrix',
    'auth_matrix_coverage',
    'graphql_introspection',
    'graphql_execution',
    'idempotency',
    'retry_behavior',
    'state_hooks',
    'db_side_effects',
    'third_party_replay',
    'vcr_replay',
    'generated_cases',
    'coverage_map',
    'latency_budget',
    'latency_confidence',
    'mutation_score',
  ],
  'state-suite': [
    'case_present',
    'native_adapters',
    'orchestration',
    'snapshot_before',
    'snapshot_after',
    'canonical_snapshot',
    'redaction_masks',
    'state_command_success',
    'action_safety',
    'fixture_strategy',
    'migration_check',
    'migration_checksum',
    'migration_drift',
    'data_invariants',
    'transaction_rollback',
    'tenant_isolation',
    'generated_tenant_matrix',
    'query_log',
    'write_allowlist',
    'unexpected_writes',
    'performance_budget',
    'state_size_budget',
  ],
  'state-machine-suite': [
    'case_present',
    'initial_state',
    'command_sequence_replay',
    'valid_transitions',
    'impossible_states',
    'terminal_state',
    'reference_model',
    'deterministic_replay',
    'invariant_checks',
    'transition_coverage',
    'counterexample_corpus',
  ],
  'concurrency-suite': [
    'case_present',
    'schedule_declared',
    'schedule_exploration',
    'command_success',
    'ordering_guarantees',
    'timeout_behavior',
    'clock_control',
    'fake_clock_adapter',
    'runtime_scheduler',
    'deterministic_scheduling',
    'stress_replay',
    'race_condition',
    'deadlock_livelock',
    'race_tooling',
    'temporal_invariants',
    'reference_trace',
    'replay_reproduction',
    'counterexample_corpus',
  ],
  'performance-suite': [
    'case_present',
    'environment_preflight',
    'sample_size',
    'stable_benchmark',
    'paired_benchmark',
    'metric_capture',
    'latency_percentiles',
    'cpu_metrics',
    'memory_metrics',
    'bundle_size',
    'bundle_attribution',
    'cold_start',
    'render_time',
    'request_formation_time',
    'performance_budget',
    'baseline_update',
    'regression_guard',
    'noise_adjusted_confidence',
  ],
  'formal-suite': [
    'case_present',
    'tool_coverage',
    'language_presets',
    'generated_harness_templates',
    'tool_specific_parser',
    'live_tool_fixtures',
    'dependency_install_guidance',
    'analyzer_success',
    'normalized_reports',
    'severity_gate',
    'artifact_hashes',
    'formal_coverage_map',
    'function_module_coverage',
    'counterexample_extraction',
    'counterexample_replay',
    'counterexample_capture',
    'ci_report_publishing',
    'type_check',
    'lint',
    'model_check',
    'symbolic_execution',
    'theorem_proof',
    'property_fuzz',
    'security_analysis',
  ],
  'cli-suite': [
    'case_present',
    'surface_coverage',
    'exit_code',
    'stdout_contract',
    'stderr_contract',
    'filesystem_effects',
    'deterministic',
    'generated_cases',
    'performance_budget',
  ],
};

const SEMANTIC_GAP_RULES = [
  {
    type: 'frontend-browser-capture',
    surfaces: ['frontend'],
    match: /playwright|browser capture|real browser/i,
    severity: 'high',
    risk: 'Frontend behavior can drift visually or semantically without a real browser oracle.',
    coverage: [{ kind: 'frontend-suite', obligations: ['visual_perception', 'semantic_dom', 'accessibility', 'interaction_behavior', 'network_contract', 'event_contract', 'console_clean'] }],
    remediation: [
      'Create a frontend-suite goal and install Playwright if missing.',
      'Capture baselines across mobile, tablet, desktop, hover, focus, and keyboard states.',
      'Run the goal until the mapped frontend obligations pass for current artifacts.',
    ],
  },
  {
    type: 'frontend-entrypoint-coverage',
    surfaces: ['frontend'],
    match: /route|page|storybook|entry/i,
    severity: 'high',
    risk: 'A frontend route or state can be optimized without a rendered baseline.',
    coverage: [{ kind: 'frontend-suite', obligations: ['baseline_present', 'visual_perception', 'semantic_dom', 'interaction_behavior'] }],
    remediation: [
      'Add explicit cases for discovered routes, Storybook stories, and critical UI states.',
      'Freeze baselines for each viewport and interaction state.',
      'Keep missing route/state coverage as a named optimization blocker.',
    ],
  },
  {
    type: 'local-serve-runtime',
    surfaces: ['frontend', 'api'],
    match: /serve command|local .*serve|local api serve/i,
    severity: 'high',
    risk: 'Runtime behavior cannot be reproduced automatically without a local launch path.',
    coverage: [
      { kind: 'frontend-suite', obligations: ['visual_perception', 'network_contract'] },
      { kind: 'api-suite', obligations: ['status_code', 'surface_coverage'] },
    ],
    remediation: [
      'Declare a safe local serve command and ready URL in the generated suite.',
      'Prefer the real dev backend; mock only destructive or third-party side effects.',
      'Record launch traces so replay commands are copy-free and deterministic.',
    ],
  },
  {
    type: 'api-schema-contract',
    surfaces: ['api'],
    match: /schema|openapi|graphql|operation coverage|request\/response/i,
    severity: 'high',
    risk: 'API request or response shapes can drift without a schema-backed contract.',
    coverage: [{ kind: 'api-suite', obligations: ['request_schema', 'response_schema', 'error_shape', 'coverage_map', 'generated_cases'] }],
    remediation: [
      'Generate api-suite cases from OpenAPI, GraphQL, or observed route fixtures.',
      'Add request, response, and error-shape schemas for every public operation.',
      'Fail optimization on uncovered methods, statuses, and generated negative cases.',
    ],
  },
  {
    type: 'api-auth-tenant',
    surfaces: ['api'],
    match: /auth|tenant|role|permission/i,
    severity: 'blocker',
    risk: 'Authorization or tenant behavior is high impact and must not be inferred from happy-path tests.',
    coverage: [{ kind: 'api-suite', obligations: ['auth_invariant', 'auth_matrix', 'auth_matrix_coverage'] }],
    remediation: [
      'Generate a role and tenant matrix from schemas, headers, and route hints.',
      'Add denial cases for unauthorized cross-role and cross-tenant access.',
      'Require every optimized candidate to preserve the auth matrix evidence.',
    ],
  },
  {
    type: 'api-state-side-effects',
    surfaces: ['api', 'state'],
    match: /database adapter detected|side-effect|db_side_effect|state hook/i,
    severity: 'blocker',
    risk: 'An API can keep the same response while mutating state incorrectly.',
    coverage: [
      { kind: 'api-suite', obligations: ['state_hooks', 'db_side_effects'] },
      { kind: 'state-suite', obligations: ['snapshot_before', 'snapshot_after', 'unexpected_writes', 'write_allowlist'] },
    ],
    remediation: [
      'Attach before/after DB snapshots to mutating API cases.',
      'Classify allowed writes and forbid unexpected tables, tenants, and side effects.',
      'Use native DB adapters when possible instead of ad hoc JSON dumps.',
    ],
  },
  {
    type: 'state-native-snapshot',
    surfaces: ['state'],
    match: /native .*adapter|postgres|mysql|sqlite|redis|adapter/i,
    severity: 'blocker',
    risk: 'State cannot be canonically compared without a database-aware snapshot path.',
    coverage: [{ kind: 'state-suite', obligations: ['native_adapters', 'snapshot_before', 'snapshot_after', 'canonical_snapshot', 'redaction_masks'] }],
    remediation: [
      'Declare Postgres, MySQL, SQLite, or Redis adapters for isolated test state.',
      'Canonicalize snapshots with schema-aware ordering and redaction masks.',
      'Store before, after, rollback, diff, and trace artifacts under the goal directory.',
    ],
  },
  {
    type: 'state-orchestration-fixtures',
    surfaces: ['state'],
    match: /orchestration|docker compose|devcontainer|seed|fixture|reset/i,
    severity: 'high',
    risk: 'State tests can be flaky or non-replayable without start, ready, seed, and reset hooks.',
    coverage: [{ kind: 'state-suite', obligations: ['orchestration', 'fixture_strategy'] }],
    remediation: [
      'Wire docker compose, devcontainer, or local DB start/ready/stop commands.',
      'Add seed and reset hooks per framework so every case starts from known state.',
      'Record orchestration traces and fail noisy or non-resettable setups.',
    ],
  },
  {
    type: 'state-migration-rollback',
    surfaces: ['state'],
    match: /migration|rollback|drift|checksum|transaction|savepoint/i,
    severity: 'blocker',
    risk: 'Schema or rollback behavior can corrupt production data even when tests pass.',
    coverage: [{ kind: 'state-suite', obligations: ['migration_check', 'migration_checksum', 'migration_drift', 'transaction_rollback'] }],
    remediation: [
      'Add migration up/down/checksum/drift commands.',
      'Verify transaction or savepoint rollback restores the before snapshot.',
      'Keep destructive migration paths blocked unless the user accepts the named risk.',
    ],
  },
  {
    type: 'state-unexpected-writes',
    surfaces: ['state'],
    match: /query-log|wal|unexpected write|write allowlist/i,
    severity: 'blocker',
    risk: 'Optimized state code may perform hidden writes that snapshots miss.',
    coverage: [{ kind: 'state-suite', obligations: ['query_log', 'write_allowlist', 'unexpected_writes'] }],
    remediation: [
      'Capture query-log or WAL-style write evidence for each state case.',
      'Declare write allowlists and forbidden write patterns.',
      'Fail when command traces and final snapshots disagree.',
    ],
  },
  {
    type: 'workflow-model-coverage',
    surfaces: ['state-machine'],
    match: /model|workflow|state machine|replay|transition/i,
    severity: 'high',
    risk: 'Workflow rewrites can preserve final output while breaking intermediate states.',
    coverage: [{ kind: 'state-machine-suite', obligations: ['command_sequence_replay', 'valid_transitions', 'reference_model', 'transition_coverage', 'invariant_checks'] }],
    remediation: [
      'Generate command/event replay cases from critical workflows.',
      'Add reference model states, transitions, impossible states, and invariants.',
      'Require transition coverage before optimizing reducers, queues, or workflows.',
    ],
  },
  {
    type: 'concurrency-schedule-control',
    surfaces: ['concurrency'],
    match: /schedule|interleaving|clock|scheduler|race|async|concurrency/i,
    severity: 'high',
    risk: 'Async rewrites can pass under one timing schedule and fail under another.',
    coverage: [{ kind: 'concurrency-suite', obligations: ['schedule_declared', 'schedule_exploration', 'clock_control', 'runtime_scheduler', 'deterministic_scheduling', 'race_tooling'] }],
    remediation: [
      'Generate deterministic schedules and fake-clock adapters for async code.',
      'Run bounded schedule exploration and seeded stress replay.',
      'Attach race tooling output and minimized replay commands to counterexamples.',
    ],
  },
  {
    type: 'performance-distribution',
    surfaces: ['performance'],
    match: /benchmark|baseline|performance|bundle|sample|tool/i,
    severity: 'high',
    risk: 'Optimization claims are not trustworthy without stable distributions and baselines.',
    coverage: [{ kind: 'performance-suite', obligations: ['sample_size', 'stable_benchmark', 'metric_capture', 'latency_percentiles', 'baseline_update', 'noise_adjusted_confidence'] }],
    remediation: [
      'Create performance-suite cases with warmup, repeat, and environment preflight.',
      'Freeze baselines, then compare p50/p95/p99 with bootstrap confidence intervals.',
      'Add bundle and source-map attribution for frontend or package-size goals.',
    ],
  },
  {
    type: 'formal-static-tooling',
    surfaces: ['formal'],
    match: /type|lint|formal|static|security|analyzer|runnable|model check|symbolic|proof|fuzz/i,
    severity: 'medium',
    risk: 'Static and formal blind spots leave classes of bugs to runtime tests only.',
    coverage: [{ kind: 'formal-suite', obligations: ['tool_coverage', 'language_presets', 'generated_harness_templates', 'analyzer_success', 'formal_coverage_map'] }],
    remediation: [
      'Generate formal-suite cases for detected type, lint, property, and security tools.',
      'Add templates for missing language-level property or model-check harnesses.',
      'Normalize analyzer reports so findings become replayable counterexamples.',
    ],
  },
  {
    type: 'cli-safety-output',
    surfaces: ['cli'],
    match: /safe\/destructive|destructive|output|performance|command/i,
    severity: 'high',
    risk: 'CLI rewrites can change output or filesystem effects while still exiting zero.',
    coverage: [{ kind: 'cli-suite', obligations: ['surface_coverage', 'exit_code', 'stdout_contract', 'stderr_contract', 'filesystem_effects', 'deterministic'] }],
    remediation: [
      'Generate cli-suite cases for every safe command, argument shape, stdin path, and env variant.',
      'Declare filesystem side-effect allowlists and block destructive commands by default.',
      'Add performance budgets only after output contracts are evidenced.',
    ],
  },
  {
    type: 'ci-runtime-parity',
    surfaces: ['ci'],
    match: /ci|github actions|gitlab|circleci|buildkite|jenkins/i,
    severity: 'medium',
    risk: 'Local Verify can diverge from CI if workflows run different commands or environments.',
    coverage: [
      { kind: 'cli-suite', obligations: ['exit_code', 'stdout_contract'] },
      { kind: 'formal-suite', obligations: ['ci_report_publishing', 'analyzer_success'] },
    ],
    remediation: [
      'Parse CI workflows and mirror their test, lint, build, and analyzer commands as Verify obligations.',
      'Publish Verify reports as CI artifacts.',
      'Block optimization when CI-only commands are not represented locally.',
    ],
  },
  {
    type: 'deployment-iac',
    surfaces: ['deployment'],
    match: /deployment|iac|docker|kubernetes|terraform|helm|serverless|cloudformation/i,
    severity: 'high',
    risk: 'Runtime infrastructure can hide ports, services, env vars, and side effects not visible in source tests.',
    coverage: [
      { kind: 'formal-suite', obligations: ['security_analysis', 'normalized_reports'] },
      { kind: 'api-suite', obligations: ['surface_coverage', 'latency_budget'] },
    ],
    remediation: [
      'Inventory containers, ports, env vars, and service dependencies from IaC files.',
      'Add config lint/security checks and local smoke commands for deployable services.',
      'Tie exposed ports and services back to API, state, and performance suites.',
    ],
  },
  {
    type: 'runtime-queue-service',
    surfaces: ['runtime'],
    match: /queue|redis|kafka|rabbit|worker|cron|schedule|service bus/i,
    severity: 'blocker',
    risk: 'Queued or service-backed behavior can be eventually consistent and invisible to direct response checks.',
    coverage: [
      { kind: 'concurrency-suite', obligations: ['schedule_declared', 'stress_replay', 'race_tooling'] },
      { kind: 'state-suite', obligations: ['snapshot_after', 'query_log', 'unexpected_writes'] },
    ],
    remediation: [
      'Discover workers, queues, topics, cron schedules, and service dependencies.',
      'Add deterministic job replay plus before/after state snapshots.',
      'Record queue/event traces and block hidden asynchronous writes.',
    ],
  },
  {
    type: 'mobile-native-surface',
    surfaces: ['mobile-native'],
    match: /mobile|native|ios|android|react native|expo|flutter|capacitor|tauri|electron/i,
    severity: 'high',
    risk: 'Native shells have device, build, bridge, and permission behavior that browser tests do not cover.',
    coverage: [
      { kind: 'cli-suite', obligations: ['exit_code', 'generated_cases'] },
      { kind: 'frontend-suite', obligations: ['visual_perception', 'interaction_behavior', 'accessibility'] },
      { kind: 'formal-suite', obligations: ['type_check', 'lint'] },
    ],
    remediation: [
      'Add native build/test commands through cli-suite or repo-native test adapters.',
      'Capture device or simulator visual and accessibility baselines where possible.',
      'Track bridge, permission, storage, and deep-link behavior as explicit cases.',
    ],
  },
  {
    type: 'monorepo-package-graph',
    surfaces: ['monorepo'],
    match: /monorepo|workspace|package graph|internal dependency/i,
    severity: 'high',
    risk: 'Optimizing one package can silently break internal dependents.',
    coverage: [
      { kind: 'cli-suite', obligations: ['surface_coverage', 'exit_code'] },
      { kind: 'formal-suite', obligations: ['function_module_coverage', 'type_check'] },
    ],
    remediation: [
      'Build a workspace package graph and identify internal dependents of touched artifacts.',
      'Generate per-package Verify goals or suite obligations for affected packages.',
      'Block optimization unless dependent package tests and public API contracts are evidenced.',
    ],
  },
  {
    type: 'dataflow-cross-surface',
    surfaces: ['dataflow'],
    match: /dataflow|reaches|path .*api|path .*state|side effect path/i,
    severity: 'blocker',
    risk: 'A cross-surface path can preserve one layer while breaking another layer downstream.',
    coverage: [
      { kind: 'frontend-suite', obligations: ['network_contract', 'event_contract'] },
      { kind: 'api-suite', obligations: ['request_schema', 'response_schema', 'db_side_effects'] },
      { kind: 'state-suite', obligations: ['snapshot_after', 'unexpected_writes'] },
    ],
    remediation: [
      'Trace source files from UI/CLI entrypoints through API, queues, and state calls.',
      'Generate a composed harness that checks each layer on the path.',
      'Require every cross-surface path to have current evidence before optimization.',
    ],
  },
  {
    type: 'safety-classification',
    surfaces: ['safety'],
    match: /safety|destructive|sensitive|third-party|mock|real system|side effect|ambiguous action/i,
    severity: 'blocker',
    risk: 'Unsafe actions, sensitive data, or third-party side effects must be classified before Verify can run real systems confidently.',
    coverage: [
      { kind: 'frontend-suite', obligations: ['interaction_behavior', 'network_contract', 'event_contract', 'console_clean'] },
      { kind: 'api-suite', obligations: ['request_schema', 'response_schema', 'state_hooks', 'db_side_effects', 'third_party_replay', 'vcr_replay'] },
      { kind: 'state-suite', obligations: ['action_safety', 'redaction_masks', 'transaction_rollback', 'unexpected_writes'] },
      { kind: 'cli-suite', obligations: ['surface_coverage', 'filesystem_effects', 'deterministic'] },
      { kind: 'formal-suite', obligations: ['security_analysis', 'normalized_reports'] },
    ],
    remediation: [
      'Classify every discovered action as safe, review, mock, or block with evidence.',
      'Use real local/dev systems for safe read-only and rollback-backed actions.',
      'Mock, sandbox, or VCR-record third-party side effects and sensitive/destructive operations.',
      'Block optimization until unsafe classifications are covered by the mapped harness obligations or explicitly accepted.',
    ],
  },
];

function sanitizeId(value) {
  return String(value || 'gap')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'gap';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function count(value) {
  return asArray(value).length;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readJsonMaybe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function readYamlMaybe(filePath) {
  try {
    // eslint-disable-next-line global-require
    const yaml = require('yaml');
    return yaml.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function readTextMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function listFiles(cwd, rel, predicate, limit = 240) {
  const root = path.resolve(cwd, rel);
  const out = [];
  if (!fs.existsSync(root)) return out;
  function walk(dir) {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (['.git', 'node_modules', '.xoloop', 'dist', 'build', 'target', '__pycache__'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (!predicate || predicate(relPath, absolute)) out.push(relPath);
    }
  }
  walk(root);
  return out.sort();
}

function packageDeps(pkg) {
  const deps = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const value = pkg && pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const name of Object.keys(value)) deps.add(name);
  }
  return deps;
}

function fileExists(cwd, rel) {
  return fs.existsSync(path.join(cwd, rel));
}

function collectScans(cwd) {
  return {
    cli: scanCliRepo(cwd),
    api: scanApiRepo(cwd),
    frontend: scanFrontendRepo(cwd),
    state: scanStateRepo(cwd),
    state_machine: scanStateMachineRepo(cwd),
    concurrency: scanConcurrencyRepo(cwd),
    performance: scanPerformanceRepo(cwd),
    formal: scanFormalRepo(cwd),
  };
}

function workspacePatterns(pkg) {
  const raw = pkg && pkg.workspaces
    ? (Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages)
    : [];
  return asArray(raw).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
}

function packageDirsForPattern(pattern) {
  const clean = pattern.replace(/\\/g, '/').replace(/\/\*+$/, '');
  if (!clean || /[*{}]/.test(clean)) return [];
  return [clean];
}

function detectPackages(cwd, rootPkg) {
  const patterns = workspacePatterns(rootPkg);
  const candidateRoots = unique([
    ...patterns.flatMap(packageDirsForPattern),
    fileExists(cwd, 'packages') ? 'packages' : '',
    fileExists(cwd, 'apps') ? 'apps' : '',
    fileExists(cwd, 'services') ? 'services' : '',
  ]);
  const packages = [];
  for (const relRoot of candidateRoots) {
    const absRoot = path.join(cwd, relRoot);
    if (!fs.existsSync(absRoot)) continue;
    const files = listFiles(cwd, relRoot, (rel) => /package\.json$/.test(rel), 120);
    for (const rel of files) {
      const pkg = readJsonMaybe(path.join(cwd, rel));
      if (!pkg) continue;
      packages.push({
        name: typeof pkg.name === 'string' ? pkg.name : rel.replace(/\/package\.json$/, ''),
        dir: path.dirname(rel).replace(/\\/g, '/'),
        package_json: rel,
        private: pkg.private === true,
        scripts: pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts).sort() : [],
        dependencies: [...packageDeps(pkg)].sort(),
      });
    }
  }
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const edges = [];
  for (const pkg of packages) {
    for (const dep of pkg.dependencies) {
      if (byName.has(dep)) edges.push({ from: pkg.name, to: dep, kind: 'workspace-dependency' });
    }
  }
  return { patterns, packages, edges };
}

function detectCi(cwd) {
  const files = [
    ...listFiles(cwd, '.github/workflows', (rel) => /\.(ya?ml)$/i.test(rel), 80),
    ...['.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'buildkite/pipeline.yml']
      .filter((rel) => fileExists(cwd, rel)),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const commands = [];
  for (const rel of files) {
    const text = readTextMaybe(path.join(cwd, rel));
    for (const match of text.matchAll(/(?:run|script|command):\s*['"]?([^'"\n#]+)/gi)) {
      const command = match[1].trim();
      if (command) commands.push({ file: rel, command });
    }
  }
  return {
    files,
    commands: commands.slice(0, 80),
  };
}

function detectDeployment(cwd) {
  const files = [
    ...['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'serverless.yml', 'serverless.yaml', 'vercel.json', 'netlify.toml', 'render.yaml', 'railway.toml', 'fly.toml']
      .filter((rel) => fileExists(cwd, rel)),
    ...listFiles(cwd, '.', (rel) => /(^|\/)(k8s|kubernetes|helm|charts|terraform|infra|deploy|deployment)\//i.test(rel) && /\.(ya?ml|json|tf|toml)$/i.test(rel), 160),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const services = new Set();
  const ports = new Set();
  const env = new Set();
  for (const rel of files) {
    const text = readTextMaybe(path.join(cwd, rel));
    for (const match of text.matchAll(/^\s{2,}([A-Za-z0-9_.-]+):\s*$/gm)) {
      if (!['environment', 'ports', 'volumes', 'depends_on', 'build', 'image'].includes(match[1])) services.add(match[1]);
    }
    for (const match of text.matchAll(/['"]?(\d{2,5}):(\d{2,5})['"]?/g)) ports.add(`${match[1]}:${match[2]}`);
    for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      if (/(URL|HOST|PORT|TOKEN|SECRET|DATABASE|REDIS|KAFKA|RABBIT|QUEUE|API)/.test(match[1])) env.add(match[1]);
    }
  }
  return {
    files,
    services: [...services].sort().slice(0, 60),
    ports: [...ports].sort().slice(0, 60),
    env: [...env].sort().slice(0, 80),
  };
}

function detectRuntime(cwd, rootPkg, deployment) {
  const deps = packageDeps(rootPkg);
  const files = listFiles(cwd, '.', (rel, abs) => {
    if (!/\.(js|cjs|mjs|ts|tsx|py|rb|go|rs|java|kt|yml|yaml)$/i.test(rel)) return false;
    const text = readTextMaybe(abs);
    return /(bullmq?|bee-queue|agenda|kafka|amqplib|rabbitmq|sqs|sns|pubsub|redis|ioredis|cron|worker|queue|topic|schedule|webhook)/i.test(text);
  }, 160);
  const services = new Set();
  const add = (name, reason) => services.add(`${name}:${reason}`);
  for (const dep of deps) {
    if (/^(bull|bullmq|bee-queue|agenda|kafkajs|amqplib|redis|ioredis|node-cron|cron|@aws-sdk\/client-sqs)$/.test(dep)) add(dep, 'dependency');
  }
  for (const service of deployment.services || []) {
    if (/redis|kafka|rabbit|queue|worker|cron|nats|sqs/i.test(service)) add(service, 'deployment');
  }
  return {
    services: [...services].sort().map((value) => {
      const [name, reason] = value.split(':');
      return { name, reason };
    }),
    files,
  };
}

function detectMobileNative(cwd, rootPkg) {
  const deps = packageDeps(rootPkg);
  const files = [
    ...['android/build.gradle', 'android/app/build.gradle', 'ios/Podfile', 'ios/Runner.xcodeproj/project.pbxproj', 'pubspec.yaml', 'capacitor.config.ts', 'capacitor.config.json', 'app.json', 'app.config.js', 'tauri.conf.json', 'src-tauri/tauri.conf.json', 'electron-builder.json']
      .filter((rel) => fileExists(cwd, rel)),
    ...listFiles(cwd, '.', (rel) => /(^|\/)(android|ios|src-tauri|electron|mobile)\//i.test(rel) && /\.(gradle|kt|java|swift|m|mm|dart|json|toml)$/i.test(rel), 120),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const frameworks = [];
  if (deps.has('react-native')) frameworks.push('react-native');
  if (deps.has('expo')) frameworks.push('expo');
  if (deps.has('@capacitor/core')) frameworks.push('capacitor');
  if (deps.has('cordova')) frameworks.push('cordova');
  if (deps.has('electron')) frameworks.push('electron');
  if (fileExists(cwd, 'pubspec.yaml')) frameworks.push('flutter');
  if (fileExists(cwd, 'src-tauri/tauri.conf.json') || fileExists(cwd, 'tauri.conf.json')) frameworks.push('tauri');
  if (fileExists(cwd, 'android') || files.some((file) => file.startsWith('android/'))) frameworks.push('android');
  if (fileExists(cwd, 'ios') || files.some((file) => file.startsWith('ios/'))) frameworks.push('ios');
  return {
    frameworks: unique(frameworks),
    files,
  };
}

function scanRepoTopology(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const rootPkg = readJsonMaybe(path.join(root, 'package.json')) || {};
  const monorepo = detectPackages(root, rootPkg);
  const ci = detectCi(root);
  const deployment = detectDeployment(root);
  const runtime = detectRuntime(root, rootPkg, deployment);
  const mobileNative = detectMobileNative(root, rootPkg);
  const artifactPaths = unique([
    rootPkg && Object.keys(rootPkg).length > 0 ? 'package.json' : '',
    ...monorepo.packages.map((pkg) => pkg.package_json),
    ...ci.files,
    ...deployment.files,
    ...runtime.files.slice(0, 80),
    ...mobileNative.files.slice(0, 80),
    ...['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json', 'rush.json']
      .filter((rel) => fileExists(root, rel)),
  ]);
  return {
    schema: 'xoloop.repo_topology.v0.1',
    cwd: root,
    monorepo: {
      patterns: monorepo.patterns,
      packages: monorepo.packages,
      edges: monorepo.edges,
      files: ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json', 'rush.json']
        .filter((rel) => fileExists(root, rel)),
    },
    ci,
    deployment,
    runtime,
    mobile_native: mobileNative,
    artifact_paths: artifactPaths,
  };
}

function expectedObligationsForGoal(goal) {
  const verify = goal.verify || {};
  if (asArray(verify.properties).length > 0) return asArray(verify.properties);
  if (verify.kind === 'command-suite') return asArray(verify.commands).map((command) => command.id).filter(Boolean);
  return DEFAULT_OBLIGATIONS_BY_KIND[verify.kind] || [];
}

function harnessEvidenceFromGoal(goalPath, goal, cwd) {
  const evidencePath = evidencePathForGoal(goalPath);
  const records = readEvidence(evidencePath);
  const current = currentVerificationRecords(records, goal.goal_id, manifestHash(goal), artifactHash(goal, cwd, goalPath));
  const latest = latestRecord(current);
  if (!latest) {
    return {
      verdict: 'NO_EVIDENCE',
      passed_obligations: [],
      failed_obligations: [],
      gap_obligations: expectedObligationsForGoal(goal),
      current_evidence: false,
    };
  }
  const verifications = asArray(latest.verifications);
  const passed = unique(verifications.filter((verification) => verification.status === 'pass').map((verification) => verification.id));
  const failed = unique(verifications.filter((verification) => verification.status === 'fail').map((verification) => verification.id));
  const gaps = unique(verifications.filter((verification) => verification.status === 'gap').map((verification) => verification.id));
  if (latest.status === 'fail' || latest.counterexample) {
    return {
      verdict: 'FAIL',
      passed_obligations: passed,
      failed_obligations: failed,
      gap_obligations: gaps,
      current_evidence: true,
    };
  }
  if (verifications.length === 0) {
    return {
      verdict: 'PASS_WITH_GAPS',
      passed_obligations: [],
      failed_obligations: [],
      gap_obligations: expectedObligationsForGoal(goal),
      current_evidence: true,
    };
  }
  let verdict = 'PASS_EVIDENCED';
  if (verifications.some((verification) => verification.status !== 'pass')) verdict = 'PASS_WITH_GAPS';
  const passedSet = new Set(passed);
  const required = expectedObligationsForGoal(goal);
  const missing = required.filter((id) => !passedSet.has(id));
  if (missing.length > 0) verdict = 'PASS_WITH_GAPS';
  return {
    verdict,
    passed_obligations: passed,
    failed_obligations: failed,
    gap_obligations: unique([...gaps, ...missing]),
    current_evidence: true,
  };
}

function discoverExistingHarnesses(cwd) {
  const goalsRoot = path.join(path.resolve(cwd), '.xoloop', 'goals');
  const out = [];
  if (!fs.existsSync(goalsRoot)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(goalsRoot, { withFileTypes: true });
  } catch (_err) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const goalPath = path.join(goalsRoot, entry.name, 'goal.yaml');
    if (!fs.existsSync(goalPath)) continue;
    try {
      const loaded = loadGoalManifest(goalPath);
      const evidence = harnessEvidenceFromGoal(goalPath, loaded.goal, cwd);
      out.push({
        goal_id: loaded.goal.goal_id,
        goal_path: goalPath,
        kind: loaded.goal.verify.kind,
        ...evidence,
      });
    } catch (_err) {
      out.push({
        goal_id: entry.name,
        goal_path: goalPath,
        kind: 'unknown',
        verdict: 'INVALID',
      });
    }
  }
  return out.sort((a, b) => `${a.kind}:${a.goal_id}`.localeCompare(`${b.kind}:${b.goal_id}`));
}

function detectedSurface(id, scan) {
  if (id === 'frontend') return count(scan.frameworks) + count(scan.routes) + count(scan.components) + count(scan.storybook) > 0;
  if (id === 'api') return count(scan.frameworks) + count(scan.route_files) + count(scan.openapi_operations) + count(scan.graphql_operations) > 0;
  if (id === 'state') return count(scan.tools) + count(scan.adapters) + count(scan.migration_files) + count(scan.schema_files) + count(scan.state_files) > 0;
  if (id === 'state-machine') return count(scan.domains) + count(scan.tools) + count(scan.workflow_files) + count(scan.model_files) > 0;
  if (id === 'concurrency') return count(scan.tools) + count(scan.async_files) + count(scan.schedule_files) + count(scan.race_tooling) > 0;
  if (id === 'performance') return count(scan.tools) + count(scan.commands) + count(scan.benchmark_files) + count(scan.bundle_files) > 0;
  if (id === 'formal') return count(scan.categories) + count(scan.checks) + count(scan.formal_files) + count(scan.language_presets) > 0;
  if (id === 'cli') return count(scan.commands) > 0;
  return false;
}

function sampleList(items, mapper, limit = 12) {
  return asArray(items).slice(0, limit).map(mapper).filter(Boolean);
}

function observableSurfacesFor(id, scan) {
  if (id === 'frontend') {
    return [
      ...sampleList(scan.frameworks, (item) => `frontend framework: ${item.name}`),
      ...sampleList(scan.routes, (file) => `route/page: ${file}`),
      ...sampleList(scan.components, (file) => `component: ${file}`),
      ...sampleList(scan.storybook, (file) => `storybook surface: ${file}`),
      ...sampleList(scan.safe_commands, (command) => `${command.kind} command: ${command.command}`),
    ];
  }
  if (id === 'api') {
    return [
      ...sampleList(scan.frameworks, (item) => `api framework: ${item.name}`),
      ...sampleList(scan.route_files, (file) => `route/controller: ${file}`),
      ...sampleList(scan.openapi_operations, (op) => `OpenAPI ${op.method} ${op.path} (${op.id})`),
      ...sampleList(scan.graphql_operations, (op) => `GraphQL ${op.operation_type}: ${op.field}`),
      ...sampleList(scan.safe_commands, (command) => `${command.kind} command: ${command.command}`),
    ];
  }
  if (id === 'state') {
    return [
      ...sampleList(scan.tools, (tool) => `state tool: ${tool.name}`),
      ...sampleList(scan.adapters, (adapter) => `${adapter.kind} adapter via ${adapter.cli || 'native command'}`),
      ...sampleList(scan.schema_files, (file) => `schema: ${file}`),
      ...sampleList(scan.migration_files, (file) => `migration: ${file}`),
      ...sampleList(scan.state_files, (file) => `stateful code: ${file}`),
      ...sampleList(scan.safe_commands, (command) => `${command.kind} command: ${command.command}`),
    ];
  }
  if (id === 'state-machine') {
    return [
      ...sampleList(scan.domains, (domain) => `workflow domain: ${domain}`),
      ...sampleList(scan.tools, (tool) => `${tool.domain} tool: ${tool.name}`),
      ...sampleList(scan.model_files, (file) => `reference model: ${file}`),
      ...sampleList(scan.workflow_files, (file) => `workflow code: ${file}`),
      ...sampleList(scan.safe_commands, (command) => `${command.kind} command: ${command.command}`),
    ];
  }
  if (id === 'concurrency') {
    return [
      ...sampleList(scan.runtimes, (runtime) => `runtime: ${runtime.runtime}`),
      ...sampleList(scan.tools, (tool) => `${tool.domain} tool: ${tool.name}`),
      ...sampleList(scan.clock_adapters, (adapter) => `clock adapter: ${adapter.name}`),
      ...sampleList(scan.deterministic_schedulers, (scheduler) => `scheduler: ${scheduler.name}`),
      ...sampleList(scan.race_tooling, (tool) => `race tool: ${tool.command}`),
      ...sampleList(scan.async_files, (file) => `async code: ${file}`),
    ];
  }
  if (id === 'performance') {
    return [
      ...sampleList(scan.tools, (tool) => `perf/build tool: ${tool.name}`),
      ...sampleList(scan.commands, (command) => `${command.kind} command: ${command.command}`),
      ...sampleList(scan.benchmark_files, (file) => `benchmark source: ${file}`),
      ...sampleList(scan.bundle_files, (file) => `bundle artifact: ${file}`),
    ];
  }
  if (id === 'formal') {
    return [
      ...sampleList(scan.categories, (category) => `formal category: ${category}`),
      ...sampleList(scan.checks, (check) => `${check.category} check: ${check.command}`),
      ...sampleList(scan.formal_files, (file) => `formal/static file: ${file}`),
      ...sampleList(scan.language_presets, (preset) => `language preset: ${preset.language}`),
    ];
  }
  if (id === 'cli') {
    return sampleList(scan.commands, (command) => `CLI command ${command.id}: ${command.command}`);
  }
  return [];
}

function autoVerificationFor(id, scan) {
  const harness = SURFACE_HARNESSES[id];
  if (!harness) return [];
  const out = [...harness.covers];
  if (id === 'frontend' && asArray(scan.routes).length > 0) out.push('route/page discovery can be converted into visual cases');
  if (id === 'api' && (asArray(scan.openapi_operations).length > 0 || asArray(scan.graphql_operations).length > 0)) out.push('schema operations can be converted into request/response cases');
  if (id === 'state' && asArray(scan.adapters).length > 0) out.push('native DB adapters can produce canonical before/after snapshots');
  if (id === 'performance' && asArray(scan.commands).some((command) => command.kind === 'benchmark')) out.push('benchmark scripts can seed stable distribution baselines');
  if (id === 'formal' && asArray(scan.checks).length > 0) out.push('detected analyzers can run as formal-suite cases');
  if (id === 'cli' && asArray(scan.commands).length > 0) out.push('detected commands can seed golden CLI cases');
  return unique(out);
}

function semanticRuleForGap(surfaceId, message) {
  const text = String(message || '');
  return SEMANTIC_GAP_RULES.find((rule) =>
    asArray(rule.surfaces).includes(surfaceId) && rule.match.test(text),
  ) || {
    type: `${surfaceId}-coverage-gap`,
    severity: ['frontend', 'api', 'state', 'performance', 'runtime', 'deployment', 'mobile-native', 'monorepo', 'dataflow'].includes(surfaceId) ? 'high' : 'medium',
    risk: 'An observable surface is detected but not fully covered by a verification harness.',
    coverage: SURFACE_HARNESSES[surfaceId]
      ? [{ kind: SURFACE_HARNESSES[surfaceId].kind, obligations: DEFAULT_OBLIGATIONS_BY_KIND[SURFACE_HARNESSES[surfaceId].kind] || [] }]
      : [],
    remediation: [
      'Create or update the suggested Verify suite for this surface.',
      'Run the suite until the mapped obligations pass for current artifacts.',
      'Accept the gap only when the user explicitly accepts the named residual risk.',
    ],
  };
}

function severityForGap(surfaceId, message) {
  const rule = semanticRuleForGap(surfaceId, message);
  if (rule && rule.severity) return rule.severity;
  const text = String(message || '').toLowerCase();
  if (/destructive|sensitive|unexpected write|side-effect|auth|tenant|migration|rollback|adapter|snapshot|database|db_|query-log|wal/.test(text)) return 'blocker';
  if (/playwright|browser|serve command|schema|route|coverage|baseline|benchmark|performance|race|scheduler|clock|security|analyzer|formal|runnable|safe\/destructive/.test(text)) return 'high';
  if (surfaceId === 'frontend' || surfaceId === 'api' || surfaceId === 'state' || surfaceId === 'performance') return 'high';
  return 'medium';
}

function makeGap(surfaceId, message, acceptedSet, index) {
  const id = `${surfaceId}:${sanitizeId(message)}${index ? `-${index}` : ''}`;
  const semantic = semanticRuleForGap(surfaceId, message);
  const severity = severityForGap(surfaceId, message);
  const accepted = acceptedSet.has(id);
  return {
    id,
    surface: surfaceId,
    type: semantic.type,
    severity,
    risk: semantic.risk,
    message,
    accepted,
    blocks_optimization: !accepted && severity !== 'low',
    coverage_requirements: asArray(semantic.coverage).map((requirement) => ({
      kind: requirement.kind,
      obligations: asArray(requirement.obligations),
    })),
    remediation_plan: asArray(semantic.remediation).map((step, stepIndex) => ({
      step: stepIndex + 1,
      action: step,
    })),
    suggested_harness: (semantic.coverage && semantic.coverage[0] && semantic.coverage[0].kind)
      || (SURFACE_HARNESSES[surfaceId] ? SURFACE_HARNESSES[surfaceId].kind : ''),
    cover_command: (semantic.coverage && semantic.coverage[0] && semantic.coverage[0].kind)
      ? `xoloop-verify create --kind ${semantic.coverage[0].kind} --goal-id ${semantic.coverage[0].kind} --force`
      : (SURFACE_HARNESSES[surfaceId]
          ? `xoloop-verify create --kind ${SURFACE_HARNESSES[surfaceId].kind} --goal-id ${SURFACE_HARNESSES[surfaceId].goal_id} --force`
          : ''),
    accept_command: `xoloop-verify discover --write --accept-gaps ${id}`,
  };
}

function harnessCoversRequirement(harness, requirement) {
  if (!harness || harness.kind !== requirement.kind) return false;
  const passed = new Set(asArray(harness.passed_obligations));
  const failed = new Set([...asArray(harness.failed_obligations), ...asArray(harness.gap_obligations)]);
  const obligations = asArray(requirement.obligations);
  if (obligations.length === 0) return harness.verdict === 'PASS_EVIDENCED';
  return obligations.every((obligation) => passed.has(obligation) && !failed.has(obligation));
}

function coverageForGap(gap, harnesses) {
  for (const requirement of asArray(gap.coverage_requirements)) {
    const harness = asArray(harnesses).find((candidate) => harnessCoversRequirement(candidate, requirement));
    if (!harness) continue;
    return {
      goal_id: harness.goal_id,
      goal_path: harness.goal_path,
      kind: harness.kind,
      verdict: harness.verdict,
      obligations: requirement.obligations,
      coverage_status: harness.verdict === 'PASS_EVIDENCED' ? 'suite_pass_evidenced' : 'mapped_obligations_passed',
    };
  }
  return null;
}

function coveredGap(gap, coverage) {
  if (!coverage) return gap;
  return {
    ...gap,
    covered: true,
    covered_by: coverage,
    blocks_optimization: false,
  };
}

function gapsForSurface(surfaceId, scan, acceptedSet, coveringHarnesses = []) {
  const seen = new Map();
  const out = [];
  for (const message of asArray(scan.gaps)) {
    const base = `${surfaceId}:${sanitizeId(message)}`;
    const nextIndex = (seen.get(base) || 0) + 1;
    seen.set(base, nextIndex);
    out.push(makeGap(surfaceId, message, acceptedSet, nextIndex > 1 ? nextIndex : 0));
  }
  if (surfaceId === 'frontend' && detectedSurface(surfaceId, scan)) {
    if (!asArray(scan.tools).some((tool) => tool.name === 'playwright')) {
      out.push(makeGap(surfaceId, 'real browser capture is not proven; add Playwright-backed frontend-suite capture', acceptedSet, 0));
    }
    if (asArray(scan.routes).length === 0 && asArray(scan.storybook).length === 0) {
      out.push(makeGap(surfaceId, 'no route or Storybook entry was discovered for automatic frontend cases', acceptedSet, 0));
    }
  }
  if (surfaceId === 'api' && detectedSurface(surfaceId, scan)) {
    if (asArray(scan.openapi_operations).length === 0 && asArray(scan.graphql_operations).length === 0) {
      out.push(makeGap(surfaceId, 'API behavior lacks schema operation coverage for generated request/response cases', acceptedSet, 0));
    }
  }
  if (surfaceId === 'state' && detectedSurface(surfaceId, scan)) {
    if (asArray(scan.adapters).length === 0) {
      out.push(makeGap(surfaceId, 'state surface lacks a native Postgres/MySQL/SQLite/Redis adapter for canonical snapshots', acceptedSet, 0));
    }
    if (!scan.orchestration || asArray(scan.orchestration.files).length === 0) {
      out.push(makeGap(surfaceId, 'state surface lacks local DB or dev-container orchestration for repeatable verification', acceptedSet, 0));
    }
  }
  if (surfaceId === 'concurrency' && detectedSurface(surfaceId, scan)) {
    if (asArray(scan.race_tooling).length === 0) {
      out.push(makeGap(surfaceId, 'concurrency surface lacks race tooling or deterministic stress replay', acceptedSet, 0));
    }
  }
  if (surfaceId === 'performance' && detectedSurface(surfaceId, scan)) {
    if (!asArray(scan.commands).some((command) => command.kind === 'benchmark')) {
      out.push(makeGap(surfaceId, 'performance surface lacks a stable benchmark command for p50/p95/p99 distributions', acceptedSet, 0));
    }
  }
  if (surfaceId === 'formal' && detectedSurface(surfaceId, scan)) {
    if (asArray(scan.checks).length === 0) {
      out.push(makeGap(surfaceId, 'formal surface lacks runnable type/lint/property/security analyzer commands', acceptedSet, 0));
    }
  }

  const deduped = [];
  const seenIds = new Set();
  for (const gap of out) {
    if (seenIds.has(gap.id)) continue;
    seenIds.add(gap.id);
    deduped.push(gap);
  }
  return deduped
    .map((gap) => coveredGap(gap, coverageForGap(gap, coveringHarnesses)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildHarnessSuggestion(surfaceId, surface) {
  const harness = SURFACE_HARNESSES[surfaceId];
  if (!harness) return null;
  const activeGaps = surface.gaps.filter((gap) => !gap.covered);
  return {
    id: `${surfaceId}:${harness.kind}`,
    surface: surfaceId,
    kind: harness.kind,
    goal_id: harness.goal_id,
    label: harness.label,
    command: `xoloop-verify create --kind ${harness.kind} --goal-id ${harness.goal_id} --force`,
    covers: harness.covers,
    addresses_gap_ids: activeGaps.map((gap) => gap.id),
    obligation_map: activeGaps.map((gap) => ({
      gap_id: gap.id,
      type: gap.type,
      requirements: gap.coverage_requirements,
    })),
    remediation_plan: activeGaps.map((gap) => ({
      gap_id: gap.id,
      steps: gap.remediation_plan,
    })),
  };
}

function buildGapHarnessSuggestions(gaps) {
  const byKind = new Map();
  for (const gap of gaps.filter((item) => !item.covered)) {
    for (const requirement of asArray(gap.coverage_requirements)) {
      if (!requirement.kind) continue;
      if (!byKind.has(requirement.kind)) {
        byKind.set(requirement.kind, {
          id: `semantic:${requirement.kind}`,
          surface: 'semantic-gap',
          kind: requirement.kind,
          goal_id: requirement.kind,
          label: `Semantic gap harness: ${requirement.kind}`,
          command: `xoloop-verify create --kind ${requirement.kind} --goal-id ${requirement.kind} --force`,
          covers: [],
          addresses_gap_ids: [],
          obligation_map: [],
          remediation_plan: [],
        });
      }
      const suggestion = byKind.get(requirement.kind);
      suggestion.addresses_gap_ids.push(gap.id);
      suggestion.obligation_map.push({
        gap_id: gap.id,
        type: gap.type,
        requirements: [requirement],
      });
      suggestion.remediation_plan.push({
        gap_id: gap.id,
        steps: gap.remediation_plan,
      });
      for (const obligation of asArray(requirement.obligations)) suggestion.covers.push(obligation);
    }
  }
  return [...byKind.values()].map((suggestion) => ({
    ...suggestion,
    covers: unique(suggestion.covers),
    addresses_gap_ids: unique(suggestion.addresses_gap_ids),
  })).sort((a, b) => a.kind.localeCompare(b.kind));
}

function buildSurface(id, rawScan, acceptedSet, existingHarnesses) {
  const scan = rawScan || {};
  const detected = detectedSurface(id, scan);
  const observable = observableSurfacesFor(id, scan);
  const harnessKind = SURFACE_HARNESSES[id] ? SURFACE_HARNESSES[id].kind : '';
  const existing = asArray(existingHarnesses).filter((harness) => harness.kind === harnessKind);
  const evidencedHarness = existing.find((harness) => harness.verdict === 'PASS_EVIDENCED') || null;
  const gaps = detected ? gapsForSurface(id, scan, acceptedSet, existingHarnesses) : [];
  const automaticVerification = detected ? autoVerificationFor(id, scan) : [];
  if (evidencedHarness) {
    automaticVerification.push(`covered by PASS_EVIDENCED ${harnessKind} goal ${evidencedHarness.goal_id}`);
  } else if (existing.length > 0) {
    automaticVerification.push(`existing ${harnessKind} goal needs more evidence: ${existing.map((harness) => `${harness.goal_id}=${harness.verdict}`).join(', ')}`);
  }
  const activeGaps = gaps.filter((gap) => gap.blocks_optimization);
  const risk = activeGaps.some((gap) => gap.severity === 'blocker')
    ? 'blocker'
    : activeGaps.some((gap) => gap.severity === 'high')
      ? 'high'
      : activeGaps.length > 0
        ? 'medium'
        : (detected && gaps.length > 0 ? 'covered' : (detected ? 'covered-or-ready' : 'not-detected'));
  const surface = {
    id,
    label: SURFACE_HARNESSES[id] ? SURFACE_HARNESSES[id].label : id,
    detected,
    risk,
    observable_surfaces: observable,
    observable_count: observable.length,
    automatic_verification: automaticVerification,
    automatically_verifiable: detected && automaticVerification.length > 0,
    uncovered_risky_areas: gaps.map((gap) => ({
      id: gap.id,
      severity: gap.severity,
      message: gap.message,
      accepted: gap.accepted,
      covered: gap.covered === true,
      covered_by: gap.covered_by || null,
      blocks_optimization: gap.blocks_optimization,
    })),
    gaps,
    existing_harnesses: existing,
    artifact_paths: asArray(scan.artifact_paths),
    scan,
  };
  const suggestion = detected && !evidencedHarness ? buildHarnessSuggestion(id, surface) : null;
  surface.suggested_harnesses = suggestion ? [suggestion] : [];
  return surface;
}

function normalizeAcceptedGaps(options = {}) {
  const values = [
    ...asArray(options.acceptedGaps),
    ...asArray(options.accepted_gaps),
  ];
  if (typeof options.acceptedGaps === 'string') values.push(...options.acceptedGaps.split(','));
  if (typeof options.accepted_gaps === 'string') values.push(...options.accepted_gaps.split(','));
  return unique(values.map((value) => String(value || '').trim()).filter(Boolean));
}

function topologyObservableSurfaces(topology) {
  const out = [];
  for (const file of asArray(topology.ci && topology.ci.files)) out.push({ surface: 'ci', description: `CI workflow: ${file}` });
  for (const command of asArray(topology.ci && topology.ci.commands).slice(0, 20)) out.push({ surface: 'ci', description: `CI command in ${command.file}: ${command.command}` });
  for (const file of asArray(topology.deployment && topology.deployment.files)) out.push({ surface: 'deployment', description: `deployment/IaC file: ${file}` });
  for (const service of asArray(topology.deployment && topology.deployment.services).slice(0, 20)) out.push({ surface: 'deployment', description: `deployment service: ${service}` });
  for (const port of asArray(topology.deployment && topology.deployment.ports).slice(0, 20)) out.push({ surface: 'deployment', description: `exposed port: ${port}` });
  for (const service of asArray(topology.runtime && topology.runtime.services)) out.push({ surface: 'runtime', description: `runtime service: ${service.name} (${service.reason})` });
  for (const file of asArray(topology.runtime && topology.runtime.files).slice(0, 30)) out.push({ surface: 'runtime', description: `runtime queue/service code: ${file}` });
  for (const framework of asArray(topology.mobile_native && topology.mobile_native.frameworks)) out.push({ surface: 'mobile-native', description: `mobile/native framework: ${framework}` });
  for (const file of asArray(topology.mobile_native && topology.mobile_native.files).slice(0, 30)) out.push({ surface: 'mobile-native', description: `mobile/native file: ${file}` });
  for (const pkg of asArray(topology.monorepo && topology.monorepo.packages)) out.push({ surface: 'monorepo', description: `workspace package: ${pkg.name} (${pkg.dir})` });
  for (const edge of asArray(topology.monorepo && topology.monorepo.edges)) out.push({ surface: 'monorepo', description: `workspace dependency: ${edge.from} -> ${edge.to}` });
  return out;
}

function topologyGaps(topology, acceptedSet, existingHarnesses) {
  const gaps = [];
  if (asArray(topology.ci && topology.ci.files).length > 0) {
    gaps.push(makeGap('ci', 'CI workflows detected; mirror CI commands as Verify obligations and publish reports', acceptedSet, 0));
  }
  if (asArray(topology.deployment && topology.deployment.files).length > 0) {
    gaps.push(makeGap('deployment', 'deployment/IaC surface detected; verify config, services, ports, env, and deploy smoke behavior', acceptedSet, 0));
  }
  if (asArray(topology.runtime && topology.runtime.services).length > 0 || asArray(topology.runtime && topology.runtime.files).length > 0) {
    gaps.push(makeGap('runtime', 'runtime queue/service surface detected; verify asynchronous jobs, queues, schedules, and side effects', acceptedSet, 0));
  }
  if (asArray(topology.mobile_native && topology.mobile_native.frameworks).length > 0 || asArray(topology.mobile_native && topology.mobile_native.files).length > 0) {
    gaps.push(makeGap('mobile-native', 'mobile/native surface detected; add native build, simulator/device, bridge, and permission verification', acceptedSet, 0));
  }
  if (asArray(topology.monorepo && topology.monorepo.packages).length > 1 || asArray(topology.monorepo && topology.monorepo.edges).length > 0) {
    gaps.push(makeGap('monorepo', 'monorepo package graph detected; verify affected packages and internal dependents before optimization', acceptedSet, 0));
  }
  return gaps
    .map((gap) => coveredGap(gap, coverageForGap(gap, existingHarnesses)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readSurfaceFiles(cwd, files, limit = 80) {
  return unique(asArray(files)).slice(0, limit).map((rel) => ({
    rel,
    text: readTextMaybe(path.join(cwd, rel)),
  })).filter((file) => file.text);
}

function textHasApiCall(text) {
  return /\b(fetch|axios|XMLHttpRequest|graphql|urql|apollo|trpc)\b|['"`]\/api\//i.test(text);
}

function textHasStateCall(text) {
  return /(prisma\.|new PrismaClient|pg\.|postgres\(|mysql|sqlite|redis\.|ioredis|knex\(|sequelize|typeorm|INSERT INTO|UPDATE\s+\w+|DELETE FROM|SELECT\s+.*FROM)/i.test(text);
}

function textHasQueueCall(text) {
  return /(bullmq?|bee-queue|agenda|kafka|amqplib|rabbitmq|sqs|sns|pubsub|queue\.add|process\(|worker|cron)/i.test(text);
}

function analyzeDataflow(cwd, scans, topology) {
  const frontendFiles = readSurfaceFiles(cwd, [
    ...asArray(scans.frontend && scans.frontend.routes),
    ...asArray(scans.frontend && scans.frontend.components),
  ]);
  const apiFiles = readSurfaceFiles(cwd, asArray(scans.api && scans.api.route_files));
  const cliFiles = readSurfaceFiles(cwd, asArray(scans.cli && scans.cli.artifact_paths));
  const stateFiles = readSurfaceFiles(cwd, asArray(scans.state && scans.state.state_files));
  const runtimeFiles = readSurfaceFiles(cwd, asArray(topology.runtime && topology.runtime.files));
  const edges = [];
  for (const file of frontendFiles) {
    if (textHasApiCall(file.text)) edges.push({ from: 'frontend', to: 'api', kind: 'network-call', source: file.rel, evidence: 'fetch/axios/graphql/api path' });
    if (textHasQueueCall(file.text)) edges.push({ from: 'frontend', to: 'runtime', kind: 'async-side-effect', source: file.rel, evidence: 'queue/worker/cron reference' });
  }
  for (const file of apiFiles) {
    if (textHasStateCall(file.text) || asArray(scans.api && scans.api.database_adapters).length > 0) edges.push({ from: 'api', to: 'state', kind: 'state-write-or-read', source: file.rel, evidence: 'database adapter or SQL/ORM call' });
    if (textHasQueueCall(file.text)) edges.push({ from: 'api', to: 'runtime', kind: 'queued-side-effect', source: file.rel, evidence: 'queue/worker/cron reference' });
  }
  for (const file of cliFiles) {
    if (textHasStateCall(file.text)) edges.push({ from: 'cli', to: 'state', kind: 'stateful-command', source: file.rel, evidence: 'SQL/ORM/cache call' });
    if (textHasApiCall(file.text)) edges.push({ from: 'cli', to: 'api', kind: 'api-command', source: file.rel, evidence: 'HTTP/API call' });
  }
  for (const file of stateFiles) {
    if (textHasQueueCall(file.text)) edges.push({ from: 'state', to: 'runtime', kind: 'state-triggered-async', source: file.rel, evidence: 'queue/worker/cron reference' });
  }
  for (const file of runtimeFiles) {
    if (textHasStateCall(file.text)) edges.push({ from: 'runtime', to: 'state', kind: 'async-state-side-effect', source: file.rel, evidence: 'SQL/ORM/cache call in async runtime file' });
  }
  const riskyPaths = [];
  if (edges.some((edge) => edge.from === 'frontend' && edge.to === 'api') && edges.some((edge) => edge.from === 'api' && edge.to === 'state')) {
    riskyPaths.push({
      id: 'frontend-api-state',
      surfaces: ['frontend', 'api', 'state'],
      message: 'dataflow path reaches from frontend to API to mutable state',
      required_obligations: [
        { kind: 'frontend-suite', obligations: ['network_contract', 'event_contract'] },
        { kind: 'api-suite', obligations: ['request_schema', 'response_schema', 'db_side_effects'] },
        { kind: 'state-suite', obligations: ['snapshot_after', 'unexpected_writes'] },
      ],
    });
  }
  if (edges.some((edge) => edge.to === 'runtime') || edges.some((edge) => edge.from === 'runtime')) {
    riskyPaths.push({
      id: 'runtime-async-state',
      surfaces: unique(edges.filter((edge) => edge.to === 'runtime' || edge.from === 'runtime').flatMap((edge) => [edge.from, edge.to])),
      message: 'dataflow path reaches asynchronous runtime or queue side effects',
      required_obligations: [
        { kind: 'concurrency-suite', obligations: ['schedule_declared', 'stress_replay', 'race_tooling'] },
        { kind: 'state-suite', obligations: ['snapshot_after', 'query_log', 'unexpected_writes'] },
      ],
    });
  }
  if (edges.some((edge) => edge.from === 'cli' && (edge.to === 'api' || edge.to === 'state'))) {
    riskyPaths.push({
      id: 'cli-api-state',
      surfaces: unique(edges.filter((edge) => edge.from === 'cli').flatMap((edge) => [edge.from, edge.to])),
      message: 'dataflow path reaches from CLI entrypoint to API or mutable state',
      required_obligations: [
        { kind: 'cli-suite', obligations: ['stdout_contract', 'filesystem_effects', 'deterministic'] },
        { kind: 'api-suite', obligations: ['status_code', 'request_schema', 'response_schema'] },
        { kind: 'state-suite', obligations: ['snapshot_after', 'unexpected_writes'] },
      ],
    });
  }
  return {
    schema: 'xoloop.discovery_dataflow.v0.1',
    edges,
    risky_paths: riskyPaths,
  };
}

function dataflowGaps(dataflow, acceptedSet, existingHarnesses) {
  return asArray(dataflow.risky_paths).map((flow) => {
    const gap = makeGap('dataflow', `dataflow path ${flow.id} reaches ${flow.surfaces.join(' -> ')}; verify cross-surface side effects`, acceptedSet, 0);
    gap.dataflow_path = flow;
    gap.coverage_requirements = flow.required_obligations;
    return coveredGap(gap, coverageForGap(gap, existingHarnesses));
  }).sort((a, b) => a.id.localeCompare(b.id));
}

const SAFE_ACTION_RE = /\b(view|open|preview|inspect|read|list|search|filter|sort|expand|collapse|focus|hover|tab|next|previous|back|refresh|validate|dry[- ]?run|health|status|ping|check|download|copy)\b/i;
const DESTRUCTIVE_ACTION_RE = /\b(delete|remove|destroy|purge|wipe|truncate|drop|reset|flush|cancel|unsubscribe|deactivate|disable|revoke|refund|charge|pay|purchase|buy|checkout|transfer|withdraw|send|email|sms|invite|publish|deploy|release|migrate|rollback|production|prod)\b/i;
const MUTATION_ACTION_RE = /\b(create|update|edit|save|submit|post|put|patch|write|insert|upsert|replace|import|upload|sync|commit|approve|reject)\b/i;
const SENSITIVE_DATA_RE = /\b(password|passwd|secret|token|api[_-]?key|credential|auth|session|cookie|jwt|oauth|ssn|social security|card|cvv|billing|payment|pii|email|phone|address|dob|birth|passport|private|webhook|stripe[_-]?secret|twilio[_-]?token)\b/i;
const THIRD_PARTY_RE = /\b(stripe|paypal|braintree|adyen|checkout\.com|sendgrid|twilio|mailgun|postmark|slack|discord|github api|api\.github|aws|amazonaws|s3|sns|sqs|ses|gcp|googleapis|azure|openai|anthropic|datadog|sentry|segment|intercom|hubspot)\b/i;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|.*\.local)$/i;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PII_FIELD_RE = /\b(email|e-mail|phone|mobile|address|street|city|postal|zip|dob|birth|name|first_name|last_name|full_name|ssn|social|passport|card|cvv|iban|routing|account_number|password|secret|token|credential|session|cookie|auth|jwt|api[_-]?key)\b/i;
const SECRET_ENV_RE = /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_KEY|AUTH|SESSION|COOKIE|JWT|STRIPE|TWILIO|SENDGRID)[A-Z0-9_]*\b/;
const STATE_SINK_RE = /(prisma\.\w+\.(create|update|upsert|delete|deleteMany)|\.insert\s*\(|\.update\s*\(|\.delete\s*\(|INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|redis\.(set|del|hset|incr)|save\(|destroy\(|remove\()/i;
const THIRD_PARTY_SINK_RE = /(fetch\(|axios\.|stripe\.|twilio\.|sgMail\.|sendgrid|mailgun|postmark|paypal|braintree|sqs\.send|sns\.publish|openai\.|anthropic\.)/i;
const REQUEST_SOURCE_RE = /\b(req\.(body|query|params|headers|cookies)|request\.(body|query|params|headers|cookies)|ctx\.req|context\.req|localStorage|sessionStorage|FormData|new URLSearchParams|process\.env)\b/i;
const THIRD_PARTY_PROVIDER_PATTERNS = [
  ['stripe', /\b(stripe|api\.stripe\.com)\b/i],
  ['paypal', /\b(paypal|api\.paypal\.com)\b/i],
  ['braintree', /\bbraintree\b/i],
  ['sendgrid', /\bsendgrid\b/i],
  ['twilio', /\b(twilio|api\.twilio\.com)\b/i],
  ['mailgun', /\bmailgun\b/i],
  ['postmark', /\bpostmark\b/i],
  ['slack', /\b(slack|hooks\.slack\.com)\b/i],
  ['github-api', /\b(api\.github|github api)\b/i],
  ['aws', /\b(aws|amazonaws|s3|sns|sqs|ses)\b/i],
  ['googleapis', /\b(googleapis|gcp)\b/i],
  ['azure', /\bazure\b/i],
  ['openai', /\b(openai|api\.openai\.com)\b/i],
  ['anthropic', /\b(anthropic|api\.anthropic\.com)\b/i],
  ['sentry', /\bsentry\b/i],
  ['datadog', /\bdatadog\b/i],
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function textMatches(text, pattern) {
  return pattern.test(String(text || ''));
}

function urlHost(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    return new URL(raw).hostname;
  } catch (_err) {
    return '';
  }
}

function isExternalUrl(value) {
  const host = urlHost(value);
  return Boolean(host && !LOCAL_HOST_RE.test(host));
}

function externalUrlsFromText(text, limit = 20) {
  return externalUrlEvidenceFromText(text, limit).map((item) => item.url);
}

function snippetAround(text, index, span = 180) {
  const value = String(text || '');
  const start = Math.max(0, Number(index || 0) - span);
  const end = Math.min(value.length, Number(index || 0) + span);
  return normalizeText(value.slice(start, end));
}

function externalUrlEvidenceFromText(text, limit = 20) {
  const out = [];
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s"'<>),]+/gi)) {
    const url = match[0].replace(/[.;]+$/, '');
    if (isExternalUrl(url) && !out.some((item) => item.url === url)) {
      out.push({ url, snippet: snippetAround(text, match.index) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

function attrValue(attrs, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\})`, 'i');
  const match = String(attrs || '').match(pattern);
  return match ? normalizeText(match[1] || match[2] || match[3] || '') : '';
}

function attrBoolean(attrs, name) {
  const text = String(attrs || '');
  return new RegExp(`${name}\\s*=\\s*(?:"true"|'true'|\\{true\\})`, 'i').test(text);
}

function stripJsxText(value) {
  return normalizeText(String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/&nbsp;/g, ' '));
}

function providerNames(text) {
  const providers = [];
  for (const [name, pattern] of THIRD_PARTY_PROVIDER_PATTERNS) {
    if (pattern.test(String(text || ''))) providers.push(name);
  }
  return unique(providers);
}

function providerEvidenceFromText(text, limit = 20) {
  const out = [];
  for (const [name, pattern] of THIRD_PARTY_PROVIDER_PATTERNS) {
    const match = String(text || '').match(pattern);
    if (!match) continue;
    out.push({ provider: name, snippet: snippetAround(text, match.index) });
    if (out.length >= limit) break;
  }
  return out;
}

function loadSafetyPolicy(cwd, options = {}) {
  const explicit = options.safetyPolicy || options.safety_policy || '';
  const candidates = [
    explicit,
    '.xoloop/safety-policy.json',
    '.xoloop/safety.policy.json',
    '.xoloop/safety-policy.yaml',
    '.xoloop/safety-policy.yml',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate);
    if (!fs.existsSync(absolute)) continue;
    const parsed = /\.ya?ml$/i.test(absolute) ? readYamlMaybe(absolute) : readJsonMaybe(absolute);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    return {
      schema: 'xoloop.safety_policy.v0.1',
      path: absolute,
      allow_real_patterns: asArray(parsed.allow_real_patterns || parsed.allow_patterns).map(String),
      mock_patterns: asArray(parsed.mock_patterns).map(String),
      block_patterns: asArray(parsed.block_patterns || parsed.deny_patterns).map(String),
      review_patterns: asArray(parsed.review_patterns).map(String),
      allow_real_domains: asArray(parsed.allow_real_domains || parsed.real_domains).map(String),
      mock_domains: asArray(parsed.mock_domains || parsed.vcr_domains).map(String),
      block_domains: asArray(parsed.block_domains || parsed.deny_domains).map(String),
      sensitive_keys: asArray(parsed.sensitive_keys || parsed.pii_keys).map(String),
      redact_keys: asArray(parsed.redact_keys || parsed.redactions).map(String),
      action_overrides: asArray(parsed.action_overrides).filter((item) => item && typeof item === 'object' && !Array.isArray(item)),
      raw: parsed,
    };
  }
  return {
    schema: 'xoloop.safety_policy.v0.1',
    path: '',
    allow_real_patterns: [],
    mock_patterns: [],
    block_patterns: [],
    review_patterns: [],
    allow_real_domains: [],
    mock_domains: [],
    block_domains: [],
    sensitive_keys: [],
    redact_keys: [],
    action_overrides: [],
    raw: {},
  };
}

function regexMatches(pattern, text) {
  try {
    return new RegExp(String(pattern), 'i').test(String(text || ''));
  } catch (_err) {
    return String(text || '').toLowerCase().includes(String(pattern || '').toLowerCase());
  }
}

function hostMatchesPolicy(host, domains) {
  const value = String(host || '').toLowerCase();
  if (!value) return false;
  return asArray(domains).some((domain) => {
    const clean = String(domain || '').toLowerCase().replace(/^\*\./, '');
    return value === clean || value.endsWith(`.${clean}`);
  });
}

function policyDecision(policy, haystack, context) {
  const url = context.url || context.href || context.path || '';
  const host = urlHost(url);
  for (const override of asArray(policy.action_overrides)) {
    const match = override.match || override.pattern || override.id || '';
    if (match && !regexMatches(match, `${haystack} ${context.id || ''}`)) continue;
    const decision = String(override.decision || override.level || '').toLowerCase();
    if (['safe', 'real', 'review', 'mock', 'block'].includes(decision)) {
      return {
        level: decision === 'real' ? 'safe' : decision,
        reason: override.reason || `safety policy override matched ${match}`,
      };
    }
  }
  if (hostMatchesPolicy(host, policy.block_domains)) return { level: 'block', reason: `safety policy blocks domain ${host}` };
  if (hostMatchesPolicy(host, policy.mock_domains)) return { level: 'mock', reason: `safety policy mocks domain ${host}` };
  if (hostMatchesPolicy(host, policy.allow_real_domains)) return { level: 'safe', reason: `safety policy allows real domain ${host}` };
  for (const pattern of asArray(policy.block_patterns)) {
    if (regexMatches(pattern, haystack)) return { level: 'block', reason: `safety policy block pattern matched ${pattern}` };
  }
  for (const pattern of asArray(policy.mock_patterns)) {
    if (regexMatches(pattern, haystack)) return { level: 'mock', reason: `safety policy mock pattern matched ${pattern}` };
  }
  for (const pattern of asArray(policy.review_patterns)) {
    if (regexMatches(pattern, haystack)) return { level: 'review', reason: `safety policy review pattern matched ${pattern}` };
  }
  for (const pattern of asArray(policy.allow_real_patterns)) {
    if (regexMatches(pattern, haystack)) return { level: 'safe', reason: `safety policy allow-real pattern matched ${pattern}` };
  }
  return null;
}

function classifySafetyText(text, context = {}) {
  const method = String(context.method || '').toUpperCase();
  const commandRisk = String(context.risk || context.commandRisk || '').toLowerCase();
  const haystack = normalizeText([
    text,
    context.label,
    context.name,
    context.command,
    context.url,
    context.href,
    context.path,
    context.source,
    method,
  ].join(' '));
  const categories = [];
  const reasons = [];
  const readOnly = READ_METHODS.has(method);
  const mutating = MUTATION_METHODS.has(method) || textMatches(haystack, MUTATION_ACTION_RE);
  const destructive = commandRisk === 'destructive' || method === 'DELETE' || textMatches(haystack, DESTRUCTIVE_ACTION_RE);
  const sensitive = textMatches(haystack, SENSITIVE_DATA_RE);
  const external = isExternalUrl(context.url) || isExternalUrl(context.href) || externalUrlsFromText(haystack, 1).length > 0;
  const providers = providerNames(haystack);
  const thirdParty = external || providers.length > 0 || textMatches(haystack, THIRD_PARTY_RE);
  const safeHint = context.safe === true || commandRisk === 'safe' || textMatches(haystack, SAFE_ACTION_RE) || readOnly;
  const explicitlyMocked = context.mocked === true || context.mock === true || /\b(mock|sandbox|vcr|recording)\b/i.test(haystack);
  const allowed = context.allow_destructive === true || context.allow === true;
  const policy = asObject(context.policy, {});
  const policySensitive = asArray(policy.sensitive_keys).some((pattern) => regexMatches(pattern, haystack));
  const policyOverride = policyDecision(policy, haystack, context);

  if (readOnly) categories.push('read_only');
  if (mutating) categories.push('mutating');
  if (safeHint) categories.push('safe_hint');
  if (destructive) categories.push('destructive');
  if (sensitive) categories.push('sensitive_data');
  if (policySensitive) categories.push('policy_sensitive_data');
  if (thirdParty) categories.push('third_party');
  for (const provider of providers) categories.push(`provider:${provider}`);

  if (readOnly) reasons.push(`HTTP ${method} is read-only`);
  if (mutating) reasons.push('candidate can mutate application or external state');
  if (destructive) reasons.push('destructive or irreversible action words were detected');
  if (sensitive) reasons.push('sensitive data or credential words were detected');
  if (policySensitive) reasons.push('user safety policy marked this action or data as sensitive');
  if (thirdParty) reasons.push('third-party or external-network side effect was detected');
  if (explicitlyMocked) reasons.push('mock, sandbox, or VCR wording was detected');
  if (safeHint && !destructive && !sensitive && !thirdParty) reasons.push('safe/read-only action wording was detected');

  let level = 'review';
  if ((thirdParty && (mutating || destructive || sensitive || textMatches(haystack, DESTRUCTIVE_ACTION_RE))) || ((destructive || sensitive) && explicitlyMocked)) {
    level = 'mock';
  } else if ((destructive || sensitive) && !allowed) {
    level = 'block';
  } else if (mutating && !safeHint) {
    level = 'review';
  } else if (safeHint || readOnly) {
    level = 'safe';
  }
  if (policyOverride) {
    level = policyOverride.level;
    categories.push('policy_override');
    reasons.push(policyOverride.reason);
  }

  if (categories.length === 0) categories.push('unknown');
  if (reasons.length === 0) reasons.push('no high-confidence safety signal was detected');
  const decision = level === 'safe' ? 'real' : level;
  const confidence = level === 'block' || level === 'mock'
    ? 0.9
    : (level === 'safe' ? 0.78 : 0.58);

  return {
    level,
    decision,
    categories: unique(categories),
    reasons: unique(reasons),
    confidence,
    real_policy: level === 'safe'
      ? 'Use real local/dev systems; prefer isolated data and repeatable traces.'
      : 'Use real systems only after an explicit harness proves idempotency, rollback, or approved side effects.',
    mock_policy: level === 'safe'
      ? 'Mocks are optional; real local/dev execution is preferred.'
      : (level === 'review'
          ? 'Require explicit safe/destructive classification before choosing real execution.'
          : (level === 'mock'
              ? 'Mock, sandbox, or VCR-record this effect; do not hit live third-party or destructive systems.'
              : 'Block execution until mocked, rollback-protected, or explicitly accepted by the user.')),
  };
}

function classifyActionCandidate(candidate, policy = {}) {
  const classification = classifySafetyText([
    candidate.label,
    candidate.name,
    candidate.command,
    candidate.url,
    candidate.href,
    candidate.path,
    candidate.method,
    candidate.summary,
    candidate.text,
  ].join(' '), { ...candidate, policy });
  return {
    id: candidate.id || sanitizeId([
      candidate.surface || 'safety',
      candidate.kind || 'action',
      candidate.source || '',
      candidate.method || '',
      candidate.label || candidate.name || candidate.command || candidate.url || candidate.href || candidate.path || 'candidate',
    ].join(':')),
    surface: candidate.surface || 'safety',
    kind: candidate.kind || 'action',
    source: candidate.source || '',
    file: candidate.file || '',
    label: normalizeText(candidate.label || candidate.name || candidate.command || candidate.url || candidate.href || candidate.path || ''),
    method: candidate.method ? String(candidate.method).toUpperCase() : '',
    url: candidate.url || candidate.href || candidate.path || '',
    command: candidate.command || '',
    ...classification,
  };
}

function collectFrontendSafetyCandidates(cwd, scan) {
  const candidates = [];
  const files = readSurfaceFiles(cwd, [
    ...asArray(scan && scan.routes),
    ...asArray(scan && scan.components),
    ...asArray(scan && scan.storybook),
  ], 120);
  for (const file of files) {
    for (const match of file.text.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const attrs = match[1] || '';
      const label = attrValue(attrs, 'aria-label') || attrValue(attrs, 'title') || stripJsxText(match[2]);
      candidates.push({
        surface: 'frontend',
        kind: 'click',
        source: file.rel,
        file: file.rel,
        label: label || 'button',
        safe: attrBoolean(attrs, 'data-xoloop-safe'),
        mocked: attrBoolean(attrs, 'data-xoloop-mock'),
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/<([A-Z][A-Za-z0-9_.]*?(?:Button|Link|MenuItem|Tab|Action|Submit|CTA))\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const attrs = match[2] || '';
      const label = attrValue(attrs, 'aria-label') || attrValue(attrs, 'title') || attrValue(attrs, 'label') || stripJsxText(match[3]);
      candidates.push({
        surface: 'frontend',
        kind: /link/i.test(match[1]) ? 'link' : 'component-action',
        source: file.rel,
        file: file.rel,
        label: label || match[1],
        href: attrValue(attrs, 'href') || attrValue(attrs, 'to') || attrValue(attrs, 'routerLink'),
        safe: attrBoolean(attrs, 'data-xoloop-safe'),
        mocked: attrBoolean(attrs, 'data-xoloop-mock'),
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/<Link\b([^>]*)>([\s\S]*?)<\/Link>/g)) {
      const attrs = match[1] || '';
      const href = attrValue(attrs, 'href') || attrValue(attrs, 'to');
      candidates.push({
        surface: 'frontend',
        kind: 'router-link',
        source: file.rel,
        file: file.rel,
        label: attrValue(attrs, 'aria-label') || stripJsxText(match[2]) || href,
        href,
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const attrs = match[1] || '';
      const href = attrValue(attrs, 'href');
      const label = attrValue(attrs, 'aria-label') || stripJsxText(match[2]) || href;
      candidates.push({
        surface: 'frontend',
        kind: 'link',
        source: file.rel,
        file: file.rel,
        label,
        href: href || attrValue(attrs, 'routerLink') || attrValue(attrs, 'to'),
        safe: attrBoolean(attrs, 'data-xoloop-safe'),
        mocked: attrBoolean(attrs, 'data-xoloop-mock'),
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/<form\b([^>]*)>/gi)) {
      const attrs = match[1] || '';
      candidates.push({
        surface: 'frontend',
        kind: 'form-submit',
        source: file.rel,
        file: file.rel,
        label: attrValue(attrs, 'aria-label') || attrValue(attrs, 'name') || attrValue(attrs, 'id') || 'form',
        method: attrValue(attrs, 'method') || 'GET',
        url: attrValue(attrs, 'action'),
        safe: attrBoolean(attrs, 'data-xoloop-safe'),
        mocked: attrBoolean(attrs, 'data-xoloop-mock'),
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/<input\b([^>]*type\s*=\s*(?:"submit"|'submit'|\{['"]submit['"]\})[^>]*)>/gi)) {
      const attrs = match[1] || '';
      candidates.push({
        surface: 'frontend',
        kind: 'submit-control',
        source: file.rel,
        file: file.rel,
        label: attrValue(attrs, 'value') || attrValue(attrs, 'aria-label') || 'submit',
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/\bfetch\s*\(\s*(['"`])([^'"`]+)\1([\s\S]{0,260})/gi)) {
      const tail = match[3] || '';
      const methodMatch = tail.match(/\bmethod\s*:\s*['"`]([A-Z]+)['"`]/i);
      candidates.push({
        surface: 'frontend',
        kind: 'network-request',
        source: file.rel,
        file: file.rel,
        label: `fetch ${match[2]}`,
        method: methodMatch ? methodMatch[1].toUpperCase() : 'GET',
        url: match[2],
        text: `${match[0]} ${tail}`,
      });
    }
    for (const match of file.text.matchAll(/\baxios\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2([\s\S]{0,220})/gi)) {
      candidates.push({
        surface: 'frontend',
        kind: 'network-request',
        source: file.rel,
        file: file.rel,
        label: `axios ${match[3]}`,
        method: match[1].toUpperCase(),
        url: match[3],
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/\b(?:router|navigate|history)\.(?:push|replace)\s*\(\s*(['"`])([^'"`]+)\1/gi)) {
      candidates.push({
        surface: 'frontend',
        kind: 'route-navigation',
        source: file.rel,
        file: file.rel,
        label: `navigate ${match[2]}`,
        href: match[2],
        text: match[0],
      });
    }
  }
  return candidates;
}

function apiRoutePathFromFile(rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  let value = clean
    .replace(/^src\/app\/api\//, '/api/')
    .replace(/^app\/api\//, '/api/')
    .replace(/^src\/pages\/api\//, '/api/')
    .replace(/^pages\/api\//, '/api/')
    .replace(/^src\/routes\//, '/')
    .replace(/^routes\//, '/')
    .replace(/\/route\.(js|cjs|mjs|ts|tsx)$/, '')
    .replace(/\.(js|cjs|mjs|ts|tsx|py|go|rb)$/, '');
  value = value.replace(/\[([^\]]+)\]/g, ':$1').replace(/\/index$/, '');
  return value.startsWith('/') ? value : `/${value}`;
}

function collectApiSafetyCandidates(cwd, scan) {
  const candidates = [];
  for (const op of asArray(scan && scan.openapi_operations)) {
    candidates.push({
      surface: 'api',
      kind: 'openapi-operation',
      source: op.source,
      file: op.source,
      label: op.summary || op.id,
      method: op.method,
      path: op.path,
      text: JSON.stringify({
        id: op.id,
        summary: op.summary,
        tags: op.tags,
        parameters: op.parameters,
        request_schema: op.request_schema,
        security: op.security,
      }),
    });
  }
  for (const op of asArray(scan && scan.graphql_operations)) {
    candidates.push({
      surface: 'api',
      kind: 'graphql-operation',
      source: op.source,
      file: op.source,
      label: `${op.operation_type} ${op.field}`,
      method: op.operation_type === 'query' ? 'GET' : 'POST',
      path: op.field,
      text: JSON.stringify(op),
    });
  }
  const routeFiles = readSurfaceFiles(cwd, asArray(scan && scan.route_files), 120);
  for (const file of routeFiles) {
    for (const match of file.text.matchAll(/(?:app|router|server|fastify|hono)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi)) {
      candidates.push({
        surface: 'api',
        kind: 'route-handler',
        source: file.rel,
        file: file.rel,
        label: `${match[1].toUpperCase()} ${match[2]}`,
        method: match[1].toUpperCase(),
        path: match[2],
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/(?:method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`][\s\S]{0,160}?(?:url|path)\s*:\s*['"`]([^'"`]+)['"`]|(?:url|path)\s*:\s*['"`]([^'"`]+)['"`][\s\S]{0,160}?method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`])/gi)) {
      const method = (match[1] || match[4] || 'GET').toUpperCase();
      const routePath = match[2] || match[3] || '/';
      candidates.push({
        surface: 'api',
        kind: 'route-handler',
        source: file.rel,
        file: file.rel,
        label: `${method} ${routePath}`,
        method,
        path: routePath,
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/g)) {
      const method = match[1].toUpperCase().replace('DELETE', 'DELETE');
      const routePath = match[2] ? `/${String(match[2]).replace(/^\/+/, '')}` : apiRoutePathFromFile(file.rel);
      candidates.push({
        surface: 'api',
        kind: 'route-handler',
        source: file.rel,
        file: file.rel,
        label: `${method} ${routePath}`,
        method,
        path: routePath,
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/@\w+\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi)) {
      candidates.push({
        surface: 'api',
        kind: 'route-handler',
        source: file.rel,
        file: file.rel,
        label: `${match[1].toUpperCase()} ${match[2]}`,
        method: match[1].toUpperCase(),
        path: match[2],
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/^\s*(get|post|put|patch|delete)\s+['"`]([^'"`]+)['"`]/gmi)) {
      candidates.push({
        surface: 'api',
        kind: 'rails-route',
        source: file.rel,
        file: file.rel,
        label: `${match[1].toUpperCase()} ${match[2]}`,
        method: match[1].toUpperCase(),
        path: match[2],
        text: match[0],
      });
    }
    for (const match of file.text.matchAll(/\b(?:http\.)?HandleFunc\s*\(\s*['"`]([^'"`]+)['"`]/gi)) {
      candidates.push({
        surface: 'api',
        kind: 'go-http-handler',
        source: file.rel,
        file: file.rel,
        label: `ANY ${match[1]}`,
        method: '',
        path: match[1],
        text: match[0],
      });
    }
    if (/\/api\/.*\/route\.(js|cjs|mjs|ts|tsx)$/i.test(file.rel)) {
      for (const match of file.text.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
        const routePath = apiRoutePathFromFile(file.rel);
        candidates.push({
          surface: 'api',
          kind: 'next-route-handler',
          source: file.rel,
          file: file.rel,
          label: `${match[1].toUpperCase()} ${routePath}`,
          method: match[1].toUpperCase(),
          path: routePath,
          text: match[0],
        });
      }
    }
    if (/(^|\/)pages\/api\//i.test(file.rel)) {
      candidates.push({
        surface: 'api',
        kind: 'next-pages-api',
        source: file.rel,
        file: file.rel,
        label: `ANY ${apiRoutePathFromFile(file.rel)}`,
        method: '',
        path: apiRoutePathFromFile(file.rel),
        text: snippetAround(file.text, 0),
      });
    }
    for (const item of providerEvidenceFromText(file.text)) {
      candidates.push({
        surface: 'api',
        kind: 'third-party-integration',
        source: file.rel,
        file: file.rel,
        label: item.provider,
        text: item.snippet,
      });
    }
    for (const item of externalUrlEvidenceFromText(file.text)) {
      candidates.push({
        surface: 'api',
        kind: 'external-http',
        source: file.rel,
        file: file.rel,
        label: item.url,
        url: item.url,
        text: item.snippet,
      });
    }
  }
  return candidates;
}

function collectCliSafetyCandidates(scan) {
  return asArray(scan && scan.commands).map((command) => ({
    surface: 'cli',
    kind: 'cli-command',
    source: command.source || '',
    file: command.source || '',
    label: command.id,
    command: command.command,
    risk: command.risk,
    text: `${command.id} ${command.command} ${command.source || ''}`,
  }));
}

function collectStateSafetyCandidates(cwd, scan) {
  const candidates = asArray(scan && scan.safe_commands).map((command) => ({
    surface: 'state',
    kind: `state-${command.kind || 'command'}`,
    source: command.id || '',
    label: command.id || command.kind || command.command,
    command: command.command,
    text: `${command.kind || ''} ${command.id || ''} ${command.command || ''}`,
  }));
  const migrationFiles = readSurfaceFiles(cwd, asArray(scan && scan.migration_files), 80);
  for (const file of migrationFiles) {
    if (!/(drop|truncate|delete|alter table|rollback|down)/i.test(file.text)) continue;
    candidates.push({
      surface: 'state',
      kind: 'migration-action',
      source: file.rel,
      file: file.rel,
      label: file.rel,
      text: file.text,
    });
  }
  const stateFiles = readSurfaceFiles(cwd, asArray(scan && scan.state_files), 80);
  for (const file of stateFiles) {
    if (!SENSITIVE_DATA_RE.test(file.text) && providerNames(file.text).length === 0 && externalUrlsFromText(file.text, 1).length === 0) continue;
    candidates.push({
      surface: 'state',
      kind: 'state-data-flow',
      source: file.rel,
      file: file.rel,
      label: file.rel,
      text: snippetAround(file.text, Math.max(
        0,
        ...[
          file.text.search(SENSITIVE_DATA_RE),
          providerEvidenceFromText(file.text)[0] ? file.text.indexOf(providerEvidenceFromText(file.text)[0].provider) : -1,
          externalUrlEvidenceFromText(file.text)[0] ? file.text.indexOf(externalUrlEvidenceFromText(file.text)[0].url) : -1,
        ].filter((index) => index >= 0),
      )),
    });
  }
  return candidates;
}

function collectTopologySafetyCandidates(topology) {
  const candidates = [];
  for (const command of asArray(topology && topology.ci && topology.ci.commands)) {
    candidates.push({
      surface: 'ci',
      kind: 'ci-command',
      source: command.file,
      file: command.file,
      label: command.command,
      command: command.command,
      text: `${command.file} ${command.command}`,
    });
  }
  for (const env of asArray(topology && topology.deployment && topology.deployment.env)) {
    candidates.push({
      surface: 'deployment',
      kind: 'deployment-env',
      source: 'deployment',
      label: env,
      text: env,
    });
  }
  for (const file of asArray(topology && topology.deployment && topology.deployment.files)) {
    candidates.push({
      surface: 'deployment',
      kind: 'deployment-config',
      source: file,
      file,
      label: file,
      text: file,
    });
  }
  return candidates;
}

function collectDependencySafetyCandidates(rootPkg) {
  const candidates = [];
  for (const dep of packageDeps(rootPkg)) {
    if (!providerNames(dep).length && !THIRD_PARTY_RE.test(dep)) continue;
    candidates.push({
      surface: 'dependency',
      kind: 'third-party-dependency',
      source: 'package.json',
      file: 'package.json',
      label: dep,
      text: dep,
    });
  }
  return candidates;
}

function classifyDataflowSafety(cwd, dataflow) {
  const out = [];
  for (const edge of asArray(dataflow && dataflow.edges)) {
    const text = readTextMaybe(path.join(cwd, edge.source || ''));
    const classification = classifySafetyText(`${edge.kind} ${edge.evidence} ${text}`, {
      source: edge.source,
      method: edge.kind && /network|api/i.test(edge.kind) ? '' : '',
    });
    if (!classification.categories.some((category) => ['sensitive_data', 'third_party', 'destructive', 'mutating'].includes(category))) continue;
    out.push({
      id: sanitizeId(`dataflow:${edge.from}:${edge.to}:${edge.source}:${edge.kind}`),
      edge,
      level: classification.level,
      categories: classification.categories,
      reasons: classification.reasons,
      decision: classification.decision,
    });
  }
  return out;
}

function schemaFieldSignals(schema, source, prefix = '') {
  const out = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return out;
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const [name, child] of Object.entries(props)) {
    const pathName = prefix ? `${prefix}.${name}` : name;
    const text = `${name} ${child && child.format ? child.format : ''} ${child && child.description ? child.description : ''}`;
    if (PII_FIELD_RE.test(text)) {
      out.push({
        id: sanitizeId(`schema:${source}:${pathName}`),
        source,
        path: pathName,
        field: name,
        format: child && child.format ? child.format : '',
        category: /password|secret|token|key|credential|session|cookie|jwt/i.test(text) ? 'secret' : 'pii',
      });
    }
    out.push(...schemaFieldSignals(child, source, pathName));
    if (child && child.items) out.push(...schemaFieldSignals(child.items, source, `${pathName}[]`));
  }
  if (schema.items) out.push(...schemaFieldSignals(schema.items, source, `${prefix || 'items'}[]`));
  return out;
}

function collectSchemaPiiSignals(cwd, scans, policy = {}) {
  const signals = [];
  for (const op of asArray(scans.api && scans.api.openapi_operations)) {
    signals.push(...schemaFieldSignals(op.request_schema, `${op.source || 'openapi'}:${op.method || ''} ${op.path || op.id}:request`));
    for (const [status, schema] of Object.entries(asObject(op.response_schemas))) {
      signals.push(...schemaFieldSignals(schema, `${op.source || 'openapi'}:${op.method || ''} ${op.path || op.id}:response:${status}`));
    }
    for (const parameter of asArray(op.parameters)) {
      const text = `${parameter.name} ${parameter.in} ${JSON.stringify(parameter.schema || {})}`;
      if (PII_FIELD_RE.test(text)) {
        signals.push({
          id: sanitizeId(`schema:${op.source}:${op.method}:${op.path}:parameter:${parameter.name}`),
          source: op.source || '',
          path: `${op.method || ''} ${op.path || ''}.${parameter.in}.${parameter.name}`,
          field: parameter.name,
          format: parameter.schema && parameter.schema.format ? parameter.schema.format : '',
          category: 'pii',
        });
      }
    }
  }
  for (const op of asArray(scans.api && scans.api.graphql_operations)) {
    for (const arg of asArray(op.args)) {
      const text = `${arg.name} ${arg.type}`;
      if (PII_FIELD_RE.test(text)) {
        signals.push({
          id: sanitizeId(`schema:${op.source}:${op.id}:arg:${arg.name}`),
          source: op.source || '',
          path: `${op.operation_type}.${op.field}.${arg.name}`,
          field: arg.name,
          format: arg.type || '',
          category: /password|secret|token/i.test(text) ? 'secret' : 'pii',
        });
      }
    }
  }
  for (const rel of asArray(scans.state && scans.state.schema_files)) {
    const text = readTextMaybe(path.join(cwd, rel));
    for (const match of text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_?[\]]+)/gm)) {
      const field = match[1];
      if (!PII_FIELD_RE.test(field)) continue;
      signals.push({
        id: sanitizeId(`schema:${rel}:${field}`),
        source: rel,
        path: field,
        field,
        format: match[2],
        category: /password|secret|token|key/i.test(field) ? 'secret' : 'pii',
      });
    }
  }
  for (const key of asArray(policy.sensitive_keys)) {
    signals.push({
      id: sanitizeId(`policy-sensitive-key:${key}`),
      source: policy.path || 'safety-policy',
      path: key,
      field: key,
      format: 'policy',
      category: 'policy-sensitive',
    });
  }
  const seen = new Set();
  return signals.filter((signal) => {
    if (seen.has(signal.id)) return false;
    seen.add(signal.id);
    return true;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function collectRuntimeSafetyCandidates(cwd) {
  const files = [
    ...listFiles(cwd, '.xoloop', (rel) =>
      /(^|\/)(actual|traces|runtime|safety-runtime)\//.test(rel) &&
      /\.(json|jsonl)$/i.test(rel), 220),
  ];
  const out = [];
  for (const rel of files) {
    const absolute = path.join(cwd, rel);
    const payloads = [];
    if (/\.jsonl$/i.test(rel)) {
      for (const line of readTextMaybe(absolute).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { payloads.push(JSON.parse(line)); } catch (_err) { /* skip malformed runtime line */ }
      }
    } else {
      const parsed = readJsonMaybe(absolute);
      if (parsed) payloads.push(parsed);
    }
    for (const payload of payloads) {
      const root = payload && payload.observation && typeof payload.observation === 'object' ? payload.observation : payload;
      for (const interaction of asArray(root.interactions)) {
        out.push({
          surface: 'runtime',
          kind: 'browser-interaction-trace',
          source: rel,
          label: interaction.selector || interaction.text || interaction.action || 'runtime interaction',
          href: interaction.after_url || interaction.href || '',
          text: JSON.stringify(interaction),
        });
      }
      for (const entry of asArray(root.network)) {
        if (entry.phase && entry.phase !== 'request') continue;
        out.push({
          surface: 'runtime',
          kind: 'browser-network-trace',
          source: rel,
          label: `${entry.method || 'GET'} ${entry.url || ''}`,
          method: entry.method || 'GET',
          url: entry.url || '',
          text: JSON.stringify({ url: entry.url, method: entry.method, headers: entry.headers, post_data: entry.post_data }),
        });
      }
      for (const node of asArray(root.dom)) {
        if (!/button|link|input|select|textarea|menuitem|tab/i.test(`${node.tag || ''} ${node.role || ''}`)) continue;
        out.push({
          surface: 'runtime',
          kind: 'browser-dom-action',
          source: rel,
          label: node.name || node.text || node.selector || '',
          href: node.href || '',
          text: JSON.stringify(node),
        });
      }
    }
  }
  return out;
}

function lineNumberForIndex(text, index) {
  return String(text || '').slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function collectStaticTaint(cwd, scans) {
  const files = readSurfaceFiles(cwd, unique([
    ...asArray(scans.api && scans.api.route_files),
    ...asArray(scans.state && scans.state.state_files),
    ...asArray(scans.frontend && scans.frontend.routes),
    ...asArray(scans.frontend && scans.frontend.components),
  ]), 220);
  const flows = [];
  for (const file of files) {
    const sourceMatches = [...file.text.matchAll(new RegExp(REQUEST_SOURCE_RE.source, 'gi'))];
    if (sourceMatches.length === 0) continue;
    const sourceIndex = sourceMatches[0].index || 0;
    const sourceSnippet = snippetAround(file.text, sourceIndex, 240);
    const sinkPatterns = [
      ['database-write', STATE_SINK_RE],
      ['third-party-call', THIRD_PARTY_SINK_RE],
      ['secret-env', SECRET_ENV_RE],
    ];
    for (const [sinkKind, pattern] of sinkPatterns) {
      const match = file.text.match(pattern);
      if (!match) continue;
      const sinkIndex = match.index || 0;
      const between = file.text.slice(Math.min(sourceIndex, sinkIndex), Math.max(sourceIndex, sinkIndex) + 240);
      flows.push({
        id: sanitizeId(`taint:${file.rel}:${sinkKind}:${lineNumberForIndex(file.text, sinkIndex)}`),
        source: file.rel,
        source_kind: /process\.env/i.test(sourceSnippet) ? 'secret-env' : 'request-or-browser-input',
        sink_kind: sinkKind,
        line: lineNumberForIndex(file.text, sinkIndex),
        snippet: snippetAround(between, Math.max(0, sinkIndex - Math.min(sourceIndex, sinkIndex)), 260),
        categories: unique([
          'taint_flow',
          sinkKind === 'database-write' ? 'state_write' : '',
          sinkKind === 'third-party-call' ? 'third_party' : '',
          sinkKind === 'secret-env' ? 'sensitive_data' : '',
          PII_FIELD_RE.test(between) ? 'sensitive_data' : '',
        ]),
      });
    }
  }
  return flows.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeRoutePath(value) {
  const raw = String(value || '').split('?')[0].replace(/^https?:\/\/[^/]+/i, '') || '/';
  return raw
    .replace(/\/+$/, '')
    .replace(/\[([^\]]+)\]/g, ':$1')
    .replace(/:[A-Za-z0-9_]+/g, ':param') || '/';
}

function routePatternMatches(pattern, candidate) {
  const left = normalizeRoutePath(pattern);
  const right = normalizeRoutePath(candidate);
  if (left === right) return true;
  const escaped = left.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\:param/g, '[^/]+');
  return new RegExp(`^${escaped}$`).test(right);
}

function buildSafetyCallGraph(cwd, actions, scans, staticTaint) {
  const nodes = [];
  const edges = [];
  const paths = [];
  const addNode = (id, type, label, extra = {}) => {
    if (!nodes.some((node) => node.id === id)) nodes.push({ id, type, label, ...extra });
    return id;
  };
  const addEdge = (from, to, kind, extra = {}) => {
    const id = sanitizeId(`${from}->${to}:${kind}`);
    if (!edges.some((edge) => edge.id === id)) edges.push({ id, from, to, kind, ...extra });
  };
  const apiActions = asArray(actions).filter((action) => action.surface === 'api' && (action.path || action.url));
  for (const action of actions) addNode(action.id, action.surface, action.label, { level: action.level, decision: action.decision, source: action.source });
  for (const action of actions.filter((item) => ['frontend', 'runtime'].includes(item.surface) && item.url)) {
    const endpoint = action.url;
    const apiMatches = apiActions.filter((candidate) => routePatternMatches(candidate.path || candidate.url || candidate.label, endpoint));
    const api = apiMatches.find((candidate) => /route|handler|pages-api/i.test(candidate.kind)) || apiMatches[0];
    if (!api) continue;
    addEdge(action.id, api.id, 'calls-api', { endpoint });
    const routeText = readTextMaybe(path.join(cwd, api.source || ''));
    const routeTaint = asArray(staticTaint).filter((flow) => flow.source === api.source);
    const stateSink = routeTaint.find((flow) => flow.sink_kind === 'database-write') || (textHasStateCall(routeText) ? { id: sanitizeId(`state:${api.source}`), source: api.source, sink_kind: 'database-write' } : null);
    const thirdPartySink = routeTaint.find((flow) => flow.sink_kind === 'third-party-call') || (providerNames(routeText).length > 0 || externalUrlsFromText(routeText, 1).length > 0 ? { id: sanitizeId(`third-party:${api.source}`), source: api.source, sink_kind: 'third-party-call' } : null);
    const pathNodes = [action.id, api.id];
    if (stateSink) {
      const stateNode = addNode(`state:${sanitizeId(api.source || api.id)}`, 'state-sink', `state sink in ${api.source || api.id}`, { source: api.source });
      addEdge(api.id, stateNode, 'writes-state', { source: api.source });
      pathNodes.push(stateNode);
    }
    if (thirdPartySink) {
      const thirdNode = addNode(`third-party:${sanitizeId(api.source || api.id)}`, 'third-party-sink', `third-party sink in ${api.source || api.id}`, { source: api.source, providers: providerNames(routeText), urls: externalUrlsFromText(routeText) });
      addEdge(api.id, thirdNode, 'calls-third-party', { source: api.source });
      pathNodes.push(thirdNode);
    }
    if (pathNodes.length > 2) {
      paths.push({
        id: sanitizeId(`path:${action.id}:${api.id}`),
        nodes: pathNodes,
        risk: thirdPartySink ? 'mock' : 'state',
        required_obligations: [
          { kind: 'frontend-suite', obligations: ['interaction_behavior', 'network_contract', 'event_contract'] },
          { kind: 'api-suite', obligations: ['request_schema', 'response_schema', 'db_side_effects', 'third_party_replay', 'vcr_replay'] },
          { kind: 'state-suite', obligations: ['snapshot_after', 'unexpected_writes', 'write_allowlist'] },
        ],
      });
    }
  }
  return {
    schema: 'xoloop.safety_call_graph.v0.1',
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    paths: paths.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function buildSafetyHarnessPlan(safety, callGraph) {
  const mocks = asArray(safety.third_party_side_effects).map((effect) => ({
    id: sanitizeId(`mock:${effect.id}`),
    source_action_id: effect.id,
    provider: providerNames(effect.label).join(',') || urlHost(effect.label) || effect.label,
    mode: 'mock-or-sandbox',
    fixture: `safety/mocks/${sanitizeId(effect.id)}.json`,
  }));
  const vcr = asArray(safety.third_party_side_effects).map((effect) => ({
    id: sanitizeId(`vcr:${effect.id}`),
    source_action_id: effect.id,
    match: { method: effect.method || '*', url: effect.label || effect.url || '*' },
    recording: `safety/vcr/${sanitizeId(effect.id)}.json`,
  }));
  const sandboxes = asArray(safety.actions).filter((action) => action.level === 'block').map((action) => ({
    id: sanitizeId(`sandbox:${action.id}`),
    source_action_id: action.id,
    reason: action.reasons[0],
    requirement: 'mock, transaction, rollback, or explicit accepted gap before execution',
  }));
  const runtimeCrawl = {
    id: 'runtime-browser-safety-crawl',
    command: 'xoloop-verify create --kind frontend-suite --goal-id frontend-suite --force',
    output_contract: 'frontend actual/traces JSON is re-ingested by discovery safety classification',
  };
  return {
    schema: 'xoloop.safety_harness_plan.v0.1',
    mocks,
    vcr_recordings: vcr,
    sandboxes,
    runtime_crawl: runtimeCrawl,
    call_graph_paths: asArray(callGraph && callGraph.paths).map((item) => item.id),
  };
}

function buildSafetyClassification(cwd, scans, topology, dataflow, options = {}) {
  const root = path.resolve(cwd);
  const rootPkg = readJsonMaybe(path.join(root, 'package.json')) || {};
  const policy = loadSafetyPolicy(root, options);
  const rawCandidates = [
    ...collectFrontendSafetyCandidates(root, scans.frontend),
    ...collectApiSafetyCandidates(root, scans.api),
    ...collectCliSafetyCandidates(scans.cli),
    ...collectStateSafetyCandidates(root, scans.state),
    ...collectTopologySafetyCandidates(topology),
    ...collectDependencySafetyCandidates(rootPkg),
    ...collectRuntimeSafetyCandidates(root),
  ];
  const actions = [];
  const seen = new Set();
  for (const candidate of rawCandidates) {
    const action = classifyActionCandidate(candidate, policy);
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    actions.push(action);
  }
  const schemaSignals = collectSchemaPiiSignals(root, scans, policy);
  const staticTaint = collectStaticTaint(root, scans);
  const callGraph = buildSafetyCallGraph(root, actions, scans, staticTaint);
  const sensitiveFlows = [];
  const thirdPartyEffects = [];
  const mockDecisions = [];
  for (const action of actions) {
    if (action.categories.includes('sensitive_data')) {
      sensitiveFlows.push({
        id: action.id,
        surface: action.surface,
        source: action.source,
        label: action.label,
        level: action.level,
        decision: action.decision,
        reasons: action.reasons,
      });
    }
    if (action.categories.includes('third_party') || action.categories.some((category) => category.startsWith('provider:'))) {
      thirdPartyEffects.push({
        id: action.id,
        surface: action.surface,
        source: action.source,
        label: action.label,
        level: action.level,
        decision: action.decision,
        reasons: action.reasons,
      });
    }
    mockDecisions.push({
      id: action.id,
      surface: action.surface,
      kind: action.kind,
      label: action.label,
      decision: action.decision,
      level: action.level,
      reason: action.reasons[0],
      real_policy: action.real_policy,
      mock_policy: action.mock_policy,
    });
  }
  const dataflowSafety = classifyDataflowSafety(root, dataflow);
  for (const item of dataflowSafety) {
    if (item.categories.includes('sensitive_data')) sensitiveFlows.push(item);
    if (item.categories.includes('third_party') || item.categories.some((category) => category.startsWith('provider:'))) thirdPartyEffects.push(item);
  }
  for (const signal of schemaSignals) {
    sensitiveFlows.push({
      id: signal.id,
      surface: 'schema',
      source: signal.source,
      label: signal.path,
      level: 'block',
      decision: 'block',
      reasons: [`schema-aware ${signal.category} field detected: ${signal.path}`],
    });
  }
  for (const flow of staticTaint) {
    if (flow.categories.includes('sensitive_data') || flow.categories.includes('taint_flow')) {
      sensitiveFlows.push({
        id: flow.id,
        surface: 'taint',
        source: flow.source,
        label: `${flow.source}:${flow.line}`,
        level: flow.categories.includes('third_party') ? 'mock' : 'block',
        decision: flow.categories.includes('third_party') ? 'mock' : 'block',
        reasons: [`static taint path from ${flow.source_kind} to ${flow.sink_kind}`],
      });
    }
    if (flow.categories.includes('third_party')) {
      thirdPartyEffects.push({
        id: flow.id,
        surface: 'taint',
        source: flow.source,
        label: `${flow.source}:${flow.line}`,
        level: 'mock',
        decision: 'mock',
        reasons: [`static taint path reaches third-party sink in ${flow.source}`],
      });
    }
  }
  const summary = {
    action_count: actions.length,
    safe_count: actions.filter((action) => action.level === 'safe').length,
    review_count: actions.filter((action) => action.level === 'review').length,
    mock_count: actions.filter((action) => action.level === 'mock').length,
    block_count: actions.filter((action) => action.level === 'block').length,
    sensitive_flow_count: sensitiveFlows.length,
    third_party_side_effect_count: thirdPartyEffects.length,
    schema_pii_signal_count: schemaSignals.length,
    static_taint_flow_count: staticTaint.length,
    call_graph_path_count: callGraph.paths.length,
  };
  const safety = {
    schema: 'xoloop.safety_classification.v0.1',
    policy: {
      default: 'prefer real local/dev systems only after safety classification',
      policy_file: policy.path,
      safe_real_systems: [
        'read-only browser actions, GET/HEAD/OPTIONS requests, health/status checks, local dev servers, and rollback-backed state checks',
      ],
      mock_when: [
        'destructive actions are not explicitly allowed or rollback-protected',
        'sensitive data or credentials could be emitted, persisted, or sent',
        'third-party systems could receive writes, payments, emails, SMS, webhooks, deployments, or analytics events',
        'the classifier cannot decide whether an action is safe',
      ],
      block_when: [
        'a destructive or sensitive action would run against a real system without a mock, sandbox, VCR recording, transaction, or explicit acceptance',
      ],
    },
    actions: actions.sort((a, b) => `${a.level}:${a.id}`.localeCompare(`${b.level}:${b.id}`)),
    sensitive_data_flows: sensitiveFlows.sort((a, b) => a.id.localeCompare(b.id)),
    third_party_side_effects: thirdPartyEffects.sort((a, b) => a.id.localeCompare(b.id)),
    dataflow_safety: dataflowSafety.sort((a, b) => a.id.localeCompare(b.id)),
    schema_pii_signals: schemaSignals,
    static_taint_flows: staticTaint,
    call_graph: callGraph,
    mock_decisions: mockDecisions.sort((a, b) => `${a.decision}:${a.id}`.localeCompare(`${b.decision}:${b.id}`)),
    summary,
  };
  safety.harness_plan = buildSafetyHarnessPlan(safety, callGraph);
  return safety;
}

function makeSafetyGap(message, acceptedSet, existingHarnesses, requirements, scope = {}) {
  const gap = makeGap('safety', message, acceptedSet, 0);
  gap.safety_scope = scope;
  gap.coverage_requirements = requirements;
  gap.suggested_harness = requirements[0] && requirements[0].kind ? requirements[0].kind : gap.suggested_harness;
  gap.cover_command = gap.suggested_harness
    ? `xoloop-verify create --kind ${gap.suggested_harness} --goal-id ${gap.suggested_harness} --force`
    : gap.cover_command;
  return coveredGap(gap, coverageForGap(gap, existingHarnesses));
}

function safetyGaps(safety, acceptedSet, existingHarnesses) {
  const gaps = [];
  const blocked = asArray(safety.actions).filter((action) => action.level === 'block');
  const mocked = asArray(safety.actions).filter((action) => action.level === 'mock');
  const review = asArray(safety.actions).filter((action) => action.level === 'review');
  const callGraphPaths = asArray(safety.call_graph && safety.call_graph.paths);
  if (callGraphPaths.length > 0) {
    gaps.push(makeSafetyGap(
      'safety call graph found UI/runtime actions that reach API handlers, mutable state, or third-party sinks',
      acceptedSet,
      existingHarnesses,
      [
        { kind: 'frontend-suite', obligations: ['interaction_behavior', 'network_contract', 'event_contract'] },
        { kind: 'api-suite', obligations: ['request_schema', 'response_schema', 'db_side_effects', 'third_party_replay', 'vcr_replay'] },
        { kind: 'state-suite', obligations: ['snapshot_after', 'query_log', 'unexpected_writes', 'write_allowlist'] },
      ],
      { call_graph_path_ids: callGraphPaths.slice(0, 40).map((item) => item.id) },
    ));
  }
  if (blocked.length > 0) {
    gaps.push(makeSafetyGap(
      'safety classification found destructive or sensitive actions that are blocked until mocked, rollback-protected, or explicitly accepted',
      acceptedSet,
      existingHarnesses,
      [
        { kind: 'frontend-suite', obligations: ['interaction_behavior', 'network_contract', 'event_contract'] },
        { kind: 'api-suite', obligations: ['state_hooks', 'db_side_effects', 'third_party_replay'] },
        { kind: 'state-suite', obligations: ['action_safety', 'transaction_rollback', 'unexpected_writes'] },
        { kind: 'cli-suite', obligations: ['filesystem_effects', 'deterministic'] },
      ],
      { action_ids: blocked.slice(0, 40).map((action) => action.id) },
    ));
  }
  if (mocked.length > 0 || asArray(safety.third_party_side_effects).length > 0) {
    gaps.push(makeSafetyGap(
      'safety classification found third-party side effects that require sandbox, VCR replay, or mocks before real execution',
      acceptedSet,
      existingHarnesses,
      [
        { kind: 'api-suite', obligations: ['third_party_replay', 'vcr_replay', 'request_schema', 'response_schema'] },
        { kind: 'frontend-suite', obligations: ['network_contract', 'event_contract', 'console_clean'] },
        { kind: 'state-suite', obligations: ['unexpected_writes', 'write_allowlist'] },
      ],
      { action_ids: mocked.slice(0, 40).map((action) => action.id), third_party_ids: asArray(safety.third_party_side_effects).slice(0, 40).map((effect) => effect.id) },
    ));
  }
  if (asArray(safety.sensitive_data_flows).length > 0) {
    gaps.push(makeSafetyGap(
      'safety classification found sensitive data flows that require redaction, masking, and local-dev isolation',
      acceptedSet,
      existingHarnesses,
      [
        { kind: 'state-suite', obligations: ['redaction_masks', 'action_safety', 'unexpected_writes'] },
        { kind: 'api-suite', obligations: ['request_schema', 'response_schema', 'auth_matrix'] },
        { kind: 'formal-suite', obligations: ['security_analysis', 'normalized_reports'] },
      ],
      { flow_ids: asArray(safety.sensitive_data_flows).slice(0, 40).map((flow) => flow.id) },
    ));
  }
  if (review.length > 0) {
    gaps.push(makeSafetyGap(
      'safety classification found ambiguous actions that need explicit safe/destructive classification',
      acceptedSet,
      existingHarnesses,
      [
        { kind: 'frontend-suite', obligations: ['interaction_behavior', 'network_contract'] },
        { kind: 'api-suite', obligations: ['surface_coverage', 'request_schema'] },
        { kind: 'cli-suite', obligations: ['surface_coverage', 'filesystem_effects'] },
      ],
      { action_ids: review.slice(0, 40).map((action) => action.id) },
    ));
  }
  return gaps.sort((a, b) => a.id.localeCompare(b.id));
}

function repoDiscoveryPath(cwd) {
  return path.join(path.resolve(cwd || process.cwd()), '.xoloop', 'discovery.json');
}

function discoverRepo(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd);
  const acceptedGaps = normalizeAcceptedGaps(options);
  const acceptedSet = new Set(acceptedGaps);
  const scans = options.scans || collectScans(root);
  const existingHarnesses = Array.isArray(options.existingHarnesses)
    ? options.existingHarnesses
    : discoverExistingHarnesses(root);
  const topology = options.topology || scanRepoTopology(root);
  const dataflow = options.dataflow || analyzeDataflow(root, scans, topology);
  const safety = options.safety || buildSafetyClassification(root, scans, topology, dataflow, options);
  const scanBySurface = {
    frontend: scans.frontend,
    api: scans.api,
    state: scans.state,
    'state-machine': scans.state_machine,
    concurrency: scans.concurrency,
    performance: scans.performance,
    formal: scans.formal,
    cli: scans.cli,
  };
  const surfaces = SURFACE_ORDER.map((id) => buildSurface(id, scanBySurface[id], acceptedSet, existingHarnesses));
  const topologyGapList = topologyGaps(topology, acceptedSet, existingHarnesses);
  const dataflowGapList = dataflowGaps(dataflow, acceptedSet, existingHarnesses);
  const safetyGapList = safetyGaps(safety, acceptedSet, existingHarnesses);
  const gaps = [
    ...surfaces.flatMap((surface) => surface.gaps),
    ...topologyGapList,
    ...dataflowGapList,
    ...safetyGapList,
  ].sort((a, b) => a.id.localeCompare(b.id));
  const blockingGaps = gaps.filter((gap) => gap.blocks_optimization);
  const surfaceHarnesses = surfaces.flatMap((surface) => surface.suggested_harnesses);
  const semanticHarnesses = buildGapHarnessSuggestions(gaps);
  const suggestedHarnesses = [...surfaceHarnesses];
  for (const semanticHarness of semanticHarnesses) {
    const existing = suggestedHarnesses.find((harness) => harness.kind === semanticHarness.kind);
    if (!existing) {
      suggestedHarnesses.push(semanticHarness);
      continue;
    }
    existing.addresses_gap_ids = unique([...asArray(existing.addresses_gap_ids), ...asArray(semanticHarness.addresses_gap_ids)]);
    existing.covers = unique([...asArray(existing.covers), ...asArray(semanticHarness.covers)]);
    existing.obligation_map = [...asArray(existing.obligation_map), ...asArray(semanticHarness.obligation_map)];
    existing.remediation_plan = [...asArray(existing.remediation_plan), ...asArray(semanticHarness.remediation_plan)];
  }
  const topologyObservables = topologyObservableSurfaces(topology);
  const dataflowObservables = dataflow.edges.map((edge) => ({
    surface: 'dataflow',
    description: `${edge.from} -> ${edge.to} (${edge.kind}) in ${edge.source}`,
  }));
  const safetyObservables = asArray(safety.actions).slice(0, 120).map((action) => ({
    surface: 'safety',
    description: `${action.decision} ${action.surface}/${action.kind}: ${action.label || action.id}`,
  }));
  const observableSurfaces = [
    ...surfaces.flatMap((surface) =>
      surface.observable_surfaces.map((description) => ({
        surface: surface.id,
        description,
      })),
    ),
    ...topologyObservables,
    ...dataflowObservables,
    ...safetyObservables,
  ];
  const artifactPaths = unique([
    ...surfaces.flatMap((surface) => surface.artifact_paths),
    ...asArray(topology.artifact_paths),
  ]);
  const detectedSurfaces = surfaces.filter((surface) => surface.detected);
  const automaticSurfaces = surfaces.filter((surface) => surface.detected && surface.automatically_verifiable);
  const remediationPlan = gaps.filter((gap) => gap.blocks_optimization).map((gap) => ({
    gap_id: gap.id,
    surface: gap.surface,
    severity: gap.severity,
    type: gap.type,
    suggested_harness: gap.suggested_harness,
    cover_command: gap.cover_command,
    required_obligations: gap.coverage_requirements,
    steps: gap.remediation_plan,
  }));
  const discovery = {
    schema: 'xoloop.discovery.v0.1',
    cwd: root,
    generated_at: new Date().toISOString(),
    policy: {
      default: 'block optimization on unaccepted discovery gaps',
      block_on_gaps: options.blockOnGaps !== false,
    },
    accepted_gaps: acceptedGaps,
    existing_harnesses: existingHarnesses,
    repo_topology: topology,
    dataflow,
    safety,
    surfaces,
    observable_surfaces: observableSurfaces,
    automatically_verifiable: automaticSurfaces.map((surface) => ({
      surface: surface.id,
      checks: surface.automatic_verification,
    })),
    uncovered_risky_areas: gaps.map((gap) => ({
      id: gap.id,
      surface: gap.surface,
      severity: gap.severity,
      message: gap.message,
      accepted: gap.accepted,
      covered: gap.covered === true,
      covered_by: gap.covered_by || null,
      type: gap.type,
      required_obligations: gap.coverage_requirements,
      blocks_optimization: gap.blocks_optimization,
      cover_command: gap.cover_command,
    })),
    gaps,
    blocking_gaps: blockingGaps,
    suggested_harnesses: suggestedHarnesses,
    remediation_plan: remediationPlan,
    artifact_paths: artifactPaths,
    coverage: {
      total_surfaces: surfaces.length,
      detected_surface_count: detectedSurfaces.length,
      detected_surfaces: detectedSurfaces.map((surface) => surface.id),
      observable_surface_count: observableSurfaces.length,
      topology_surface_count: topologyObservables.length,
      dataflow_edge_count: dataflow.edges.length,
      dataflow_risky_path_count: dataflow.risky_paths.length,
      safety_action_count: safety.summary.action_count,
      safety_safe_count: safety.summary.safe_count,
      safety_review_count: safety.summary.review_count,
      safety_mock_count: safety.summary.mock_count,
      safety_block_count: safety.summary.block_count,
      sensitive_flow_count: safety.summary.sensitive_flow_count,
      third_party_side_effect_count: safety.summary.third_party_side_effect_count,
      schema_pii_signal_count: safety.summary.schema_pii_signal_count,
      static_taint_flow_count: safety.summary.static_taint_flow_count,
      safety_call_graph_path_count: safety.summary.call_graph_path_count,
      automatically_verifiable_surface_count: automaticSurfaces.length,
      suggested_harness_count: suggestedHarnesses.length,
      gap_count: gaps.length,
      accepted_gap_count: gaps.filter((gap) => gap.accepted).length,
      covered_gap_count: gaps.filter((gap) => gap.covered === true).length,
      blocking_gap_count: blockingGaps.length,
    },
    optimization_gate: {
      blocked: options.blockOnGaps !== false && blockingGaps.length > 0,
      blocking_gap_ids: blockingGaps.map((gap) => gap.id),
      message: blockingGaps.length > 0
        ? 'Optimization is blocked until these discovery gaps are covered by harnesses or explicitly accepted.'
        : 'No unaccepted discovery gaps block optimization.',
    },
  };
  return discovery;
}

function writeDiscoveryReport(cwd, discovery, options = {}) {
  const root = path.resolve(cwd || process.cwd());
  const rootPath = options.rootPath || repoDiscoveryPath(root);
  writeJson(rootPath, discovery);
  const paths = { root: rootPath };
  if (options.goalPath) {
    const goalDir = goalBaseDir(options.goalPath);
    const goalDiscoveryPath = path.join(goalDir, 'discovery.json');
    const reportPath = path.join(goalDir, 'reports', 'discovery.json');
    writeJson(goalDiscoveryPath, discovery);
    writeJson(reportPath, discovery);
    paths.goal = goalDiscoveryPath;
    paths.report = reportPath;
  }
  return paths;
}

function buildDiscoverySuiteGoal(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'discovery-suite';
  const discovery = discoverRepo(cwd, {
    acceptedGaps: options.acceptedGaps || options.accepted_gaps || [],
  });
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Inventory every observable repo surface, identify what Verify can prove automatically, and block optimization until risky gaps are covered or accepted.',
    interface: {
      type: 'discovery',
      command: 'xoloop-verify discover --json',
      stdin: 'none',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: discovery.artifact_paths,
    },
    verify: {
      kind: 'discovery-suite',
      properties: DEFAULT_DISCOVERY_OBLIGATIONS,
      block_on_gaps: true,
      accepted_gaps: discovery.accepted_gaps,
      scan: {
        coverage: discovery.coverage,
        detected_surfaces: discovery.coverage.detected_surfaces,
      },
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'blocking_gap_count', direction: 'minimize', threshold: 0 },
        { name: 'gap_count', direction: 'minimize', threshold: 0 },
      ],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0,
      accept_if_any_target_improves: true,
      require_discovery: true,
      accepted_discovery_gaps: discovery.accepted_gaps,
    },
  };
}

function writeSafetyGeneratedAssets(goalDir, discovery) {
  const safetyDir = path.join(goalDir, 'safety');
  for (const dir of ['mocks', 'vcr', 'sandboxes', 'runtime-crawl', 'redactions']) {
    fs.mkdirSync(path.join(safetyDir, dir), { recursive: true });
  }
  writeJson(path.join(safetyDir, 'policy.example.json'), {
    schema: 'xoloop.safety_policy.v0.1',
    allow_real_domains: ['localhost', '127.0.0.1'],
    mock_domains: ['api.stripe.com', 'api.twilio.com', 'api.sendgrid.com'],
    block_patterns: ['delete production', 'drop table', 'send real email'],
    mock_patterns: ['charge card', 'send sms', 'publish webhook'],
    sensitive_keys: ['password', 'token', 'secret', 'cardToken', 'email'],
    action_overrides: [
      { match: 'Preview report', decision: 'real', reason: 'read-only preview action' },
      { match: 'Delete account', decision: 'block', reason: 'destructive user data action' },
    ],
  });
  writeJson(path.join(safetyDir, 'mock-plan.json'), discovery.safety.harness_plan || {});
  writeJson(path.join(safetyDir, 'runtime-crawl', 'frontend-safety-crawl.case.json'), {
    id: 'safety-runtime-crawl',
    url: 'http://localhost:3000/',
    viewport: 'desktop',
    discover_safe_actions: true,
    max_discovered_actions: 50,
    record_get_requests: true,
    note: 'Run frontend-suite with this style of case; discovery ingests actual/traces JSON and reclassifies runtime actions/network.',
  });
  writeJson(path.join(safetyDir, 'redactions', 'schema-pii-masks.json'), {
    redactions: asArray(discovery.safety.schema_pii_signals).map((signal) => ({
      path: signal.path,
      replacement: '<redacted>',
      source: signal.source,
      category: signal.category,
    })),
  });
  for (const item of asArray(discovery.safety.harness_plan && discovery.safety.harness_plan.mocks).slice(0, 80)) {
    writeJson(path.join(goalDir, item.fixture), {
      id: item.id,
      provider: item.provider,
      mode: item.mode,
      source_action_id: item.source_action_id,
      behavior: 'replace live side effect with deterministic fake response',
      response: { ok: true, xoloop_mock: true },
    });
  }
  for (const item of asArray(discovery.safety.harness_plan && discovery.safety.harness_plan.vcr_recordings).slice(0, 80)) {
    writeJson(path.join(goalDir, item.recording), {
      id: item.id,
      source_action_id: item.source_action_id,
      match: item.match,
      interactions: [],
      note: 'Record safe sandbox traffic here; never record production secrets.',
    });
  }
  writeJson(path.join(safetyDir, 'sandboxes', 'blocked-actions.json'), {
    actions: asArray(discovery.safety.harness_plan && discovery.safety.harness_plan.sandboxes),
    requirement: 'Each blocked action needs a mock, transaction/savepoint, rollback proof, or explicit accepted safety gap.',
  });
  fs.writeFileSync(path.join(safetyDir, 'sandbox.env.example'), [
    '# Generated by discovery-suite safety classification.',
    '# Point third-party SDKs at fake/sandbox hosts before running Verify.',
    'STRIPE_API_BASE=http://127.0.0.1:0/xoloop-mock/stripe',
    'TWILIO_API_BASE=http://127.0.0.1:0/xoloop-mock/twilio',
    'SENDGRID_API_BASE=http://127.0.0.1:0/xoloop-mock/sendgrid',
    'XOLOOP_SAFETY_POLICY=.xoloop/safety-policy.json',
    '',
  ].join('\n'), 'utf8');
}

function writeDiscoverySuiteAssets(goalDir, options = {}) {
  for (const dir of ['reports', 'traces', 'suggestions', 'accepted', 'safety']) {
    fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  }
  writeJson(path.join(goalDir, 'accepted', 'accepted-gaps.example.json'), {
    accepted_gaps: [],
    note: 'Add gap IDs here only after the user explicitly accepts a named risk, or after another harness covers it.',
  });
  const discovery = discoverRepo(options.cwd || process.cwd(), {
    acceptedGaps: options.acceptedGaps || options.accepted_gaps || [],
  });
  writeJson(path.join(goalDir, 'reports', 'initial-discovery.json'), discovery);
  writeJson(path.join(goalDir, 'suggestions', 'harnesses.json'), discovery.suggested_harnesses);
  writeSafetyGeneratedAssets(goalDir, discovery);
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# Discovery verification goal',
    '',
    'Generated by `xoloop-verify create --kind discovery-suite`.',
    '',
    'This goal inventories observable repo surfaces, records what Verify can',
    'check automatically, names risky uncovered areas, and blocks optimization',
    'until gaps are covered by generated harnesses or explicitly accepted.',
    '',
    'The latest run writes `.xoloop/discovery.json` plus this goal directory',
    'so optimisation agents have a repo-wide gate before they reshape code.',
    '',
  ].join('\n'), 'utf8');
}

async function runDiscoverySuiteVerification(goal, goalPath, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const discovery = discoverRepo(cwd, {
    acceptedGaps: goal.verify.accepted_gaps || [],
    blockOnGaps: goal.verify.block_on_gaps,
  });
  const reportPaths = writeDiscoveryReport(cwd, discovery, { goalPath });
  const verifications = [];

  if (discovery.coverage.detected_surface_count > 0) {
    verifications.push({
      id: 'surface_inventory',
      status: 'pass',
      detected_surfaces: discovery.coverage.detected_surfaces,
    });
  } else {
    verifications.push({
      id: 'surface_inventory',
      status: 'gap',
      message: 'no observable repo surfaces were detected',
    });
  }

  if (discovery.coverage.observable_surface_count > 0) {
    verifications.push({
      id: 'observable_surfaces',
      status: 'pass',
      count: discovery.coverage.observable_surface_count,
    });
  } else {
    verifications.push({
      id: 'observable_surfaces',
      status: 'gap',
      message: 'no input/output or observable behavior surfaces were found',
    });
  }

  if (discovery.coverage.automatically_verifiable_surface_count > 0) {
    verifications.push({
      id: 'automatic_verification',
      status: 'pass',
      surfaces: discovery.automatically_verifiable.map((item) => item.surface),
    });
  } else {
    verifications.push({
      id: 'automatic_verification',
      status: 'gap',
      message: 'no surface has an automatic verification harness suggestion',
    });
  }

  if (discovery.gaps.length === 0) {
    verifications.push({ id: 'risk_gaps', status: 'pass', message: 'no discovery gaps detected' });
  } else if (discovery.blocking_gaps.length === 0) {
    verifications.push({
      id: 'risk_gaps',
      status: 'pass',
      gap_count: discovery.gaps.length,
      accepted_gap_count: discovery.coverage.accepted_gap_count,
      message: 'all discovery gaps are explicitly accepted or non-blocking',
    });
  } else {
    verifications.push({
      id: 'risk_gaps',
      status: 'gap',
      gap_count: discovery.gaps.length,
      blocking_gap_count: discovery.blocking_gaps.length,
      blocking_gap_ids: discovery.blocking_gaps.map((gap) => gap.id),
    });
  }

  if (discovery.suggested_harnesses.length > 0) {
    verifications.push({
      id: 'suggested_harnesses',
      status: 'pass',
      count: discovery.suggested_harnesses.length,
      commands: discovery.suggested_harnesses.map((harness) => harness.command),
    });
  } else {
    verifications.push({
      id: 'suggested_harnesses',
      status: discovery.coverage.detected_surface_count === 0 ? 'gap' : 'pass',
      count: 0,
    });
  }

  if (discovery.coverage.topology_surface_count > 0) {
    verifications.push({
      id: 'repo_topology',
      status: 'pass',
      topology_surface_count: discovery.coverage.topology_surface_count,
      ci_files: asArray(discovery.repo_topology.ci && discovery.repo_topology.ci.files).length,
      deployment_files: asArray(discovery.repo_topology.deployment && discovery.repo_topology.deployment.files).length,
      packages: asArray(discovery.repo_topology.monorepo && discovery.repo_topology.monorepo.packages).length,
    });
  } else {
    verifications.push({
      id: 'repo_topology',
      status: 'pass',
      topology_surface_count: 0,
      message: 'no CI, deployment, runtime service, mobile/native, or monorepo topology surfaces detected',
    });
  }

  if (discovery.coverage.dataflow_edge_count > 0) {
    verifications.push({
      id: 'dataflow_analysis',
      status: 'pass',
      dataflow_edge_count: discovery.coverage.dataflow_edge_count,
      risky_path_count: discovery.coverage.dataflow_risky_path_count,
    });
  } else {
    verifications.push({
      id: 'dataflow_analysis',
      status: 'pass',
      dataflow_edge_count: 0,
      risky_path_count: 0,
    });
  }

  verifications.push({
    id: 'safety_classification',
    status: 'pass',
    action_count: discovery.coverage.safety_action_count,
    safe_count: discovery.coverage.safety_safe_count,
    review_count: discovery.coverage.safety_review_count,
    mock_count: discovery.coverage.safety_mock_count,
    block_count: discovery.coverage.safety_block_count,
    sensitive_flow_count: discovery.coverage.sensitive_flow_count,
    third_party_side_effect_count: discovery.coverage.third_party_side_effect_count,
    schema_pii_signal_count: discovery.coverage.schema_pii_signal_count,
    static_taint_flow_count: discovery.coverage.static_taint_flow_count,
    call_graph_path_count: discovery.coverage.safety_call_graph_path_count,
    policy: discovery.safety.policy,
  });

  if (discovery.remediation_plan.length > 0 || discovery.blocking_gaps.length === 0) {
    verifications.push({
      id: 'remediation_plan',
      status: 'pass',
      blocking_gap_count: discovery.blocking_gaps.length,
      remediation_step_count: discovery.remediation_plan.reduce((total, item) => total + asArray(item.steps).length, 0),
    });
  } else {
    verifications.push({
      id: 'remediation_plan',
      status: 'gap',
      message: 'gaps exist but no remediation plan was generated',
    });
  }

  let counterexample = null;
  if (goal.verify.block_on_gaps !== false && discovery.blocking_gaps.length > 0) {
    const first = discovery.blocking_gaps[0];
    verifications.push({
      id: 'optimization_block',
      status: 'fail',
      blocking_gap_count: discovery.blocking_gaps.length,
      blocking_gap_ids: discovery.blocking_gaps.map((gap) => gap.id),
      report_path: reportPaths.report || reportPaths.root,
      message: discovery.optimization_gate.message,
    });
    counterexample = {
      obligation: 'optimization_block',
      case_id: first.id,
      message: first.message,
      report_path: reportPaths.report || reportPaths.root,
      replay: `xoloop-verify run ${path.relative(cwd, goalPath).replace(/\\/g, '/')}`,
    };
  } else {
    verifications.push({
      id: 'optimization_block',
      status: 'pass',
      blocking_gap_count: 0,
      report_path: reportPaths.report || reportPaths.root,
    });
  }

  const acceptedUnresolved = asArray(goal.verify.accepted_gaps).filter((id) => !discovery.gaps.some((gap) => gap.id === id));
  if (acceptedUnresolved.length === 0) {
    verifications.push({
      id: 'gap_acceptance',
      status: 'pass',
      accepted_gap_count: discovery.coverage.accepted_gap_count,
    });
  } else {
    verifications.push({
      id: 'gap_acceptance',
      status: 'gap',
      accepted_gap_ids_not_present: acceptedUnresolved,
      message: 'some accepted gap IDs were not present in the current scan',
    });
  }

  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: {
      detected_surface_count: discovery.coverage.detected_surface_count,
      observable_surface_count: discovery.coverage.observable_surface_count,
      automatically_verifiable_surface_count: discovery.coverage.automatically_verifiable_surface_count,
      suggested_harness_count: discovery.coverage.suggested_harness_count,
      gap_count: discovery.coverage.gap_count,
      blocking_gap_count: discovery.coverage.blocking_gap_count,
      accepted_gap_count: discovery.coverage.accepted_gap_count,
      covered_gap_count: discovery.coverage.covered_gap_count,
      topology_surface_count: discovery.coverage.topology_surface_count,
      dataflow_edge_count: discovery.coverage.dataflow_edge_count,
      dataflow_risky_path_count: discovery.coverage.dataflow_risky_path_count,
      safety_action_count: discovery.coverage.safety_action_count,
      safety_safe_count: discovery.coverage.safety_safe_count,
      safety_review_count: discovery.coverage.safety_review_count,
      safety_mock_count: discovery.coverage.safety_mock_count,
      safety_block_count: discovery.coverage.safety_block_count,
      sensitive_flow_count: discovery.coverage.sensitive_flow_count,
      third_party_side_effect_count: discovery.coverage.third_party_side_effect_count,
      schema_pii_signal_count: discovery.coverage.schema_pii_signal_count,
      static_taint_flow_count: discovery.coverage.static_taint_flow_count,
      safety_call_graph_path_count: discovery.coverage.safety_call_graph_path_count,
    },
    environment: {
      discovery_path: reportPaths.root,
      discovery_goal_path: reportPaths.goal || '',
      discovery_report_path: reportPaths.report || '',
      optimization_blocked: discovery.optimization_gate.blocked,
    },
    counterexample,
  };
}

function readDiscoveryLedger(cwd, goal = {}) {
  const acceptance = goal.acceptance && typeof goal.acceptance === 'object' ? goal.acceptance : {};
  const verify = goal.verify && typeof goal.verify === 'object' ? goal.verify : {};
  const candidates = [
    typeof acceptance.discovery_file === 'string' ? acceptance.discovery_file : '',
    typeof verify.discovery_file === 'string' ? verify.discovery_file : '',
    repoDiscoveryPath(cwd),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    const parsed = readJsonMaybe(absolute);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { path: absolute, discovery: parsed };
    }
  }
  return null;
}

function discoveryOptimizationBlocker(cwd, goal = {}) {
  const acceptance = goal.acceptance && typeof goal.acceptance === 'object' ? goal.acceptance : {};
  const verify = goal.verify && typeof goal.verify === 'object' ? goal.verify : {};
  const ledger = readDiscoveryLedger(cwd, goal);
  if (!ledger) {
    if (acceptance.require_discovery === true || verify.require_discovery === true) {
      return {
        blocked: true,
        stop_reason: 'discovery_required_missing',
        message: 'Optimization requires a discovery ledger, but .xoloop/discovery.json was not found.',
        blocking_gap_ids: ['discovery:missing-ledger'],
      };
    }
    return { blocked: false };
  }
  const acceptedSet = new Set([
    ...asArray(acceptance.accepted_discovery_gaps),
    ...asArray(verify.accepted_discovery_gaps),
    ...asArray(verify.accepted_gaps),
  ]);
  const ledgerAccepted = new Set(asArray(ledger.discovery.accepted_gaps));
  const blockers = asArray(ledger.discovery.blocking_gaps).filter((gap) => {
    if (!gap || !gap.id) return false;
    return gap.accepted !== true && !acceptedSet.has(gap.id) && !ledgerAccepted.has(gap.id);
  });
  if (blockers.length === 0) return { blocked: false, path: ledger.path };
  return {
    blocked: true,
    stop_reason: 'discovery_gaps_blocking',
    message: 'Optimization is blocked by unaccepted discovery gaps. Cover them with suggested harnesses or accept named gaps.',
    path: ledger.path,
    blocking_gap_ids: blockers.map((gap) => gap.id),
    blocking_gaps: blockers.slice(0, 20),
  };
}

module.exports = {
  DEFAULT_DISCOVERY_OBLIGATIONS,
  buildSafetyClassification,
  buildDiscoverySuiteGoal,
  classifyActionCandidate,
  classifySafetyText,
  loadSafetyPolicy,
  discoverRepo,
  discoverExistingHarnesses,
  discoveryOptimizationBlocker,
  readDiscoveryLedger,
  repoDiscoveryPath,
  runDiscoverySuiteVerification,
  analyzeDataflow,
  scanRepoTopology,
  writeDiscoveryReport,
  writeDiscoverySuiteAssets,
};
