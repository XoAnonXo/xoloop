'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');
const { measureComplexity } = require('./goal_complexity.cjs');
const {
  artifactHash,
  evidencePathForGoal,
  goalBaseDir,
  loadGoalManifest,
  manifestHash,
  writeGoalManifest,
} = require('./goal_manifest.cjs');
const {
  appendEvidence,
  currentVerificationRecords,
  latestCounterexample,
  latestRecord,
  readEvidence,
} = require('./goal_evidence.cjs');
const {
  runJsonCanonicalizerVerification,
  writeJsonCanonicalizerAssets,
} = require('./goal_json_canonicalizer.cjs');
const { runGeneralIoVerification } = require('./goal_general_io.cjs');
const { runCommandSuiteVerification } = require('./goal_command_suite.cjs');
const { scanFrontendRepo } = require('./goal_frontend_scan.cjs');
const {
  DEFAULT_FRONTEND_OBLIGATIONS,
  buildFrontendSuiteGoal,
  runFrontendSuiteVerification,
  writeFrontendSuiteAssets,
} = require('./goal_frontend_suite.cjs');
const {
  DEFAULT_CLI_OBLIGATIONS,
  buildCliSuiteGoal,
  runCliSuiteVerification,
  scanCliRepo,
  writeCliSuiteAssets,
} = require('./goal_cli_suite.cjs');
const {
  DEFAULT_API_OBLIGATIONS,
  buildApiSuiteGoal,
  runApiSuiteVerification,
  scanApiRepo,
  writeApiSuiteAssets,
} = require('./goal_api_suite.cjs');
const {
  DEFAULT_STATE_OBLIGATIONS,
  buildStateSuiteGoal,
  runStateSuiteVerification,
  scanStateRepo,
  writeStateSuiteAssets,
} = require('./goal_state_suite.cjs');
const {
  DEFAULT_STATE_MACHINE_OBLIGATIONS,
  buildStateMachineSuiteGoal,
  runStateMachineSuiteVerification,
  scanStateMachineRepo,
  writeStateMachineSuiteAssets,
} = require('./goal_state_machine_suite.cjs');
const {
  DEFAULT_CONCURRENCY_OBLIGATIONS,
  buildConcurrencySuiteGoal,
  runConcurrencySuiteVerification,
  scanConcurrencyRepo,
  writeConcurrencySuiteAssets,
} = require('./goal_concurrency_suite.cjs');
const {
  DEFAULT_PERFORMANCE_OBLIGATIONS,
  buildPerformanceSuiteGoal,
  runPerformanceSuiteVerification,
  scanPerformanceRepo,
  writePerformanceSuiteAssets,
} = require('./goal_performance_suite.cjs');
const {
  DEFAULT_FORMAL_OBLIGATIONS,
  buildFormalSuiteGoal,
  runFormalSuiteVerification,
  scanFormalRepo,
  writeFormalSuiteAssets,
} = require('./goal_formal_suite.cjs');
const {
  DEFAULT_DISCOVERY_OBLIGATIONS,
  buildDiscoverySuiteGoal,
  buildRuntimeLabPlan,
  discoverRepo,
  runDiscoverySuiteVerification,
  scanFunctionRepo,
  writeDiscoverySuiteAssets,
} = require('./goal_discovery.cjs');

function nowIso() {
  return new Date().toISOString();
}

function repoRelative(cwd, filePath) {
  return path.relative(path.resolve(cwd || process.cwd()), path.resolve(filePath)).replace(/\\/g, '/');
}

function sanitizeSuiteId(value) {
  return String(value || 'suite').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'suite';
}

const CORE_SUITE_SURFACES = [
  { id: 'cli', kind: 'cli-suite' },
  { id: 'frontend', kind: 'frontend-suite' },
  { id: 'api', kind: 'api-suite' },
  { id: 'state', kind: 'state-suite' },
  { id: 'state-machine', kind: 'state-machine-suite' },
  { id: 'concurrency', kind: 'concurrency-suite' },
  { id: 'performance', kind: 'performance-suite' },
  { id: 'formal', kind: 'formal-suite' },
];

function normalizeSuiteSurface(value) {
  const text = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (text === 'db' || text === 'database') return 'state';
  if (text === 'workflow' || text === 'state-machine-suite') return 'state-machine';
  if (text === 'perf' || text === 'benchmark') return 'performance';
  if (text === 'static' || text === 'formal-static') return 'formal';
  if (text === 'backend') return 'api';
  return text;
}

function selectedSuiteSurfaces(options = {}) {
  const raw = options.surfaces || options.surface || '';
  const requested = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (requested.length === 0 || requested.includes('detected')) return [];
  if (requested.includes('all')) return CORE_SUITE_SURFACES;
  const wanted = new Set(requested.map(normalizeSuiteSurface));
  return CORE_SUITE_SURFACES.filter((surface) => wanted.has(surface.id) || wanted.has(surface.kind));
}

function scanSuiteSurfaces(cwd) {
  return {
    cli: scanCliRepo(cwd),
    frontend: scanFrontendRepo(cwd),
    api: scanApiRepo(cwd),
    state: scanStateRepo(cwd),
    'state-machine': scanStateMachineRepo(cwd),
    performance: scanPerformanceRepo(cwd),
    formal: scanFormalRepo(cwd),
  };
}

function surfaceDetected(id, scan) {
  if (!scan) return false;
  if (id === 'cli') return (scan.commands || []).length > 0;
  if (id === 'frontend') return (scan.frameworks || []).length > 0 || (scan.routes || []).length > 0 || (scan.components || []).length > 0;
  if (id === 'api') return (scan.frameworks || []).length > 0 || (scan.route_files || []).length > 0 || (scan.openapi_operations || []).length > 0 || (scan.graphql_operations || []).length > 0;
  if (id === 'state') return (scan.tools || []).length > 0 || (scan.migration_files || []).length > 0 || (scan.schema_files || []).length > 0 || (scan.state_files || []).length > 0;
  if (id === 'state-machine') return (scan.domains || []).length > 0 || (scan.workflow_files || []).length > 0 || (scan.model_files || []).length > 0;
  if (id === 'concurrency') return (scan.runtimes || []).length > 0 || (scan.tools || []).length > 0 || (scan.clock_adapters || []).length > 0 || (scan.deterministic_schedulers || []).length > 0 || (scan.race_tooling || []).length > 0 || (scan.async_files || []).length > 0 || (scan.schedule_files || []).length > 0;
  if (id === 'performance') return (scan.commands || []).length > 0 || (scan.benchmark_files || []).length > 0 || (scan.bundle_files || []).length > 0;
  if (id === 'formal') return (scan.categories || []).length > 0 || (scan.checks || []).length > 0 || (scan.formal_files || []).length > 0 || (scan.language_presets || []).length > 0;
  return false;
}

function detectedSuiteSurfaces(scans) {
  const detected = CORE_SUITE_SURFACES.filter((surface) => surfaceDetected(surface.id, scans[surface.id]));
  return detected.length > 0 ? detected : CORE_SUITE_SURFACES.filter((surface) => surface.id === 'formal');
}

function buildJsonCanonicalizerGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'json-canon-seed';
  const target = options.target;
  if (!target || typeof target !== 'string') {
    throw new AdapterError('GOAL_CREATE_TARGET_REQUIRED', 'target', '--target is required');
  }
  const targetAbs = path.resolve(cwd, target);
  if (!fs.existsSync(targetAbs)) {
    throw new AdapterError(
      'GOAL_CREATE_TARGET_MISSING',
      'target',
      `Target does not exist: ${target}`,
      { fixHint: 'Create the CLI implementation first, then run xoloop-verify create.' },
    );
  }
  const targetRel = repoRelative(cwd, targetAbs);
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve exact JSON canonicalization behavior while minimizing wall time, memory, and complexity.',
    interface: {
      type: 'cli',
      command: `node ${JSON.stringify(targetRel)}`,
      stdin: 'json',
      stdout: 'text',
      timeout_ms: 10000,
    },
    artifacts: {
      paths: [targetRel],
    },
    verify: {
      kind: 'json-canonicalizer',
      golden_cases: 'cases/*.json',
      benchmark_cases: 'bench/*.json',
      fuzz: {
        generator: 'json-subset',
        seed: 12345,
        runs: 100,
      },
      properties: [
        'idempotent',
        'parse_equivalent',
        'canonical_key_order',
        'rejects_duplicate_keys',
      ],
    },
    metrics: {
      repeat: 3,
      targets: [
        { name: 'wall_time_ms', direction: 'minimize', threshold: 0.03 },
        { name: 'peak_memory_mb', direction: 'minimize', threshold: 0.03 },
        { name: 'complexity_score', direction: 'minimize', threshold: 0.05 },
      ],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0.02,
      accept_if_any_target_improves: true,
    },
  };
}

function buildChildSuiteGoal(surface, options, scan) {
  const childOptions = {
    ...options,
    goalId: `${options.goalId || 'suite'}-${surface.id}`,
    scan,
  };
  if (surface.kind === 'cli-suite') return buildCliSuiteGoal(childOptions);
  if (surface.kind === 'frontend-suite') return buildFrontendSuiteGoal(childOptions);
  if (surface.kind === 'api-suite') return buildApiSuiteGoal(childOptions);
  if (surface.kind === 'state-suite') return buildStateSuiteGoal(childOptions);
  if (surface.kind === 'state-machine-suite') return buildStateMachineSuiteGoal(childOptions);
  if (surface.kind === 'concurrency-suite') return buildConcurrencySuiteGoal(childOptions);
  if (surface.kind === 'performance-suite') return buildPerformanceSuiteGoal(childOptions);
  if (surface.kind === 'formal-suite') return buildFormalSuiteGoal(childOptions);
  throw new AdapterError('GOAL_CREATE_KIND_UNSUPPORTED', 'kind', `Unsupported suite child kind: ${surface.kind}`);
}

function writeChildSuiteAssets(surface, childDir, options, scan) {
  const childOptions = {
    ...options,
    goalId: `${options.goalId || 'suite'}-${surface.id}`,
    scan,
  };
  if (surface.kind === 'cli-suite') return writeCliSuiteAssets(childDir, childOptions);
  if (surface.kind === 'frontend-suite') return writeFrontendSuiteAssets(childDir, childOptions);
  if (surface.kind === 'api-suite') return writeApiSuiteAssets(childDir, childOptions);
  if (surface.kind === 'state-suite') return writeStateSuiteAssets(childDir, childOptions);
  if (surface.kind === 'state-machine-suite') return writeStateMachineSuiteAssets(childDir, childOptions);
  if (surface.kind === 'concurrency-suite') return writeConcurrencySuiteAssets(childDir, childOptions);
  if (surface.kind === 'performance-suite') return writePerformanceSuiteAssets(childDir, childOptions);
  if (surface.kind === 'formal-suite') return writeFormalSuiteAssets(childDir, childOptions);
  throw new AdapterError('GOAL_CREATE_KIND_UNSUPPORTED', 'kind', `Unsupported suite child kind: ${surface.kind}`);
}

function obligationFromChildGoal(surface, childGoal, childGoalPath, parentGoalDir) {
  return {
    id: surface.id,
    goal_path: repoRelative(parentGoalDir, childGoalPath),
    interface: childGoal.interface,
    artifacts: childGoal.artifacts,
    metrics: childGoal.metrics,
    acceptance: childGoal.acceptance,
    ...childGoal.verify,
  };
}

function writeSuiteAssets(goalDir, options = {}) {
  fs.mkdirSync(path.join(goalDir, 'suites'), { recursive: true });
  fs.mkdirSync(path.join(goalDir, 'reports'), { recursive: true });
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'suite';
  const scans = options.scans || scanSuiteSurfaces(cwd);
  const requested = selectedSuiteSurfaces(options);
  const surfaces = requested.length > 0 ? requested : detectedSuiteSurfaces(scans);
  const obligations = [];
  const children = [];
  for (const surface of surfaces) {
    const childDir = path.join(goalDir, 'suites', sanitizeSuiteId(surface.id));
    fs.mkdirSync(childDir, { recursive: true });
    const scan = scans[surface.id];
    writeChildSuiteAssets(surface, childDir, { ...options, goalId }, scan);
    const childGoal = buildChildSuiteGoal(surface, { ...options, cwd, goalId }, scan);
    const childGoalPath = path.join(childDir, 'goal.yaml');
    writeGoalManifest(childGoalPath, childGoal);
    obligations.push(obligationFromChildGoal(surface, childGoal, childGoalPath, goalDir));
    children.push({
      id: surface.id,
      kind: surface.kind,
      goal_path: repoRelative(goalDir, childGoalPath),
      detected: surfaceDetected(surface.id, scan),
      artifact_paths: childGoal.artifacts.paths || [],
    });
  }
  const manifest = {
    schema: 'xoloop.suite_orchestration.v0.1',
    goal_id: goalId,
    surfaces: children,
    generated_at: nowIso(),
  };
  fs.writeFileSync(path.join(goalDir, 'suite.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# Verify suite orchestration goal',
    '',
    'Generated by `xoloop-verify create --kind suite`.',
    '',
    'This goal combines multiple Verify envelopes into one orchestrated',
    'contract. Child suite artifacts live under `suites/<surface>/`, while',
    'the top-level evidence card prefixes obligations with the surface id.',
    '',
    ...children.map((child) => `- ${child.id}: ${child.kind} (${child.goal_path})`),
    '',
  ].join('\n'), 'utf8');
  return { obligations, scans, surfaces: children };
}

function buildSuiteGoal(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'suite';
  const suiteAssets = options.suiteAssets || { obligations: [] };
  const artifactSet = new Set();
  for (const obligation of suiteAssets.obligations || []) {
    for (const rel of (obligation.artifacts && obligation.artifacts.paths) || []) artifactSet.add(rel);
  }
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve whole-repo behavior by orchestrating CLI, frontend, API, database/state, state-machine, performance, and formal/static verification suites.',
    interface: {
      type: 'suite',
      command: 'xoloop verify suite orchestration',
      stdin: 'none',
      stdout: 'json',
      timeout_ms: 300000,
    },
    artifacts: {
      paths: [...artifactSet].sort(),
    },
    verify: {
      kind: 'suite',
      block_on_gaps: true,
      surfaces: (suiteAssets.surfaces || []).map((surface) => surface.id),
      scan: suiteAssets.scans || {},
      obligations: suiteAssets.obligations || [],
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'complexity_score', direction: 'minimize', threshold: 0.05 },
      ],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0.02,
      accept_if_any_target_improves: true,
    },
  };
}

function createGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const kind = options.kind || 'json-canonicalizer';
  if (!['json-canonicalizer', 'frontend-suite', 'cli-suite', 'api-suite', 'state-suite', 'state-machine-suite', 'concurrency-suite', 'performance-suite', 'formal-suite', 'discovery-suite', 'suite'].includes(kind)) {
    throw new AdapterError('GOAL_CREATE_KIND_UNSUPPORTED', 'kind', `Unsupported goal kind: ${kind}`);
  }
  const goalId = options.goalId || (kind === 'frontend-suite' ? 'frontend-suite' : (kind === 'cli-suite' ? 'cli-suite' : (kind === 'api-suite' ? 'api-suite' : (kind === 'state-suite' ? 'state-suite' : (kind === 'state-machine-suite' ? 'state-machine-suite' : (kind === 'concurrency-suite' ? 'concurrency-suite' : (kind === 'performance-suite' ? 'performance-suite' : (kind === 'formal-suite' ? 'formal-suite' : (kind === 'discovery-suite' ? 'discovery-suite' : (kind === 'suite' ? 'suite' : 'json-canon-seed'))))))))));
  const goalDir = path.resolve(cwd, '.xoloop', 'goals', goalId);
  const goalPath = path.join(goalDir, 'goal.yaml');
  if (fs.existsSync(goalPath) && !options.force) {
    throw new AdapterError(
      'GOAL_CREATE_EXISTS',
      'goal_id',
      `Goal already exists: ${goalPath}`,
      { fixHint: 'Pass --force to overwrite generated verification assets.' },
    );
  }
  fs.mkdirSync(goalDir, { recursive: true });
  let goal;
  if (kind === 'frontend-suite') {
    const scan = scanFrontendRepo(cwd);
    writeFrontendSuiteAssets(goalDir, { ...options, scan });
    goal = buildFrontendSuiteGoal({ ...options, cwd, goalId, scan });
  } else if (kind === 'cli-suite') {
    writeCliSuiteAssets(goalDir, options);
    goal = buildCliSuiteGoal({ ...options, cwd, goalId });
  } else if (kind === 'api-suite') {
    const scan = scanApiRepo(cwd);
    writeApiSuiteAssets(goalDir, { ...options, scan });
    goal = buildApiSuiteGoal({ ...options, cwd, goalId, scan });
  } else if (kind === 'state-suite') {
    const scan = scanStateRepo(cwd);
    writeStateSuiteAssets(goalDir, { ...options, goalId, scan });
    goal = buildStateSuiteGoal({ ...options, cwd, goalId, scan });
  } else if (kind === 'state-machine-suite') {
    const scan = scanStateMachineRepo(cwd);
    writeStateMachineSuiteAssets(goalDir, { ...options, goalId, scan });
    goal = buildStateMachineSuiteGoal({ ...options, cwd, goalId, scan });
  } else if (kind === 'concurrency-suite') {
    const scan = scanConcurrencyRepo(cwd);
    writeConcurrencySuiteAssets(goalDir, { ...options, goalId, scan });
    goal = buildConcurrencySuiteGoal({ ...options, cwd, goalId, scan });
  } else if (kind === 'performance-suite') {
    const scan = scanPerformanceRepo(cwd);
    writePerformanceSuiteAssets(goalDir, { ...options, goalId, scan });
    goal = buildPerformanceSuiteGoal({ ...options, cwd, goalId, scan });
  } else if (kind === 'formal-suite') {
    const scan = scanFormalRepo(cwd);
    writeFormalSuiteAssets(goalDir, { ...options, goalId, scan });
    goal = buildFormalSuiteGoal({ ...options, cwd, goalId, scan });
  } else if (kind === 'discovery-suite') {
    writeDiscoverySuiteAssets(goalDir, { ...options, cwd, goalId });
    goal = buildDiscoverySuiteGoal({ ...options, cwd, goalId });
  } else if (kind === 'suite') {
    const suiteAssets = writeSuiteAssets(goalDir, { ...options, cwd, goalId });
    goal = buildSuiteGoal({ ...options, cwd, goalId, suiteAssets });
  } else {
    writeJsonCanonicalizerAssets(goalDir);
    goal = buildJsonCanonicalizerGoal({ ...options, cwd, goalId });
  }
  return writeGoalManifest(goalPath, goal);
}

function summarizeVerificationStatuses(verifications) {
  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
    gaps: 0,
    by_id: {},
  };
  for (const v of Array.isArray(verifications) ? verifications : []) {
    if (!v || !v.id) continue;
    summary.total += 1;
    if (v.status === 'pass') summary.passed += 1;
    else if (v.status === 'fail') summary.failed += 1;
    else if (v.status === 'gap') summary.gaps += 1;
    if (!summary.by_id[v.id]) summary.by_id[v.id] = { passed: 0, failed: 0, gaps: 0 };
    if (v.status === 'pass') summary.by_id[v.id].passed += 1;
    if (v.status === 'fail') summary.by_id[v.id].failed += 1;
    if (v.status === 'gap') summary.by_id[v.id].gaps += 1;
  }
  return summary;
}

function requiredObligations(goal) {
  if (goal.verify.kind === 'command-suite') {
    return (goal.verify.commands || []).map((command) => command.id).sort();
  }
  if (goal.verify.kind === 'general-io') {
    const ids = new Set(['exit_code']);
    for (const prop of goal.verify.properties || []) ids.add(prop);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'frontend-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_FRONTEND_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'cli-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_CLI_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'api-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_API_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'state-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_STATE_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'state-machine-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_STATE_MACHINE_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'concurrency-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_CONCURRENCY_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'performance-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_PERFORMANCE_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'formal-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_FORMAL_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'discovery-suite') {
    const ids = new Set((goal.verify.properties && goal.verify.properties.length > 0)
      ? goal.verify.properties
      : DEFAULT_DISCOVERY_OBLIGATIONS);
    return [...ids].sort();
  }
  if (goal.verify.kind === 'suite') {
    const ids = [];
    for (const obligation of goal.verify.obligations || []) {
      const subGoal = { ...goal, verify: { ...obligation }, interface: obligation.interface || goal.interface };
      for (const id of requiredObligations(subGoal)) ids.push(`${obligation.id}:${id}`);
    }
    return ids.sort();
  }
  const ids = new Set(['golden_output']);
  for (const prop of goal.verify.properties || []) ids.add(prop);
  return [...ids].sort();
}

function missingObligations(goal, latest) {
  if (!latest || !Array.isArray(latest.verifications)) return requiredObligations(goal);
  const passed = new Set(latest.verifications.filter((v) => v && v.status === 'pass').map((v) => v.id));
  return requiredObligations(goal).filter((id) => !passed.has(id));
}

function buildVerifyCard(goalPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const loaded = loadGoalManifest(goalPath);
  const goal = loaded.goal;
  const currentManifestHash = manifestHash(goal);
  const currentArtifactHash = artifactHash(goal, cwd, loaded.goalPath);
  const evidencePath = evidencePathForGoal(loaded.goalPath);
  const records = readEvidence(evidencePath);
  const current = currentVerificationRecords(records, goal.goal_id, currentManifestHash, currentArtifactHash);
  const latest = latestRecord(current);
  const staleEvidenceCount = records.filter((record) =>
    record &&
    record.schema === 'xoloop.evidence.v0.1' &&
    record.goal_id === goal.goal_id &&
    (record.manifest_hash !== currentManifestHash || record.artifact_hash !== currentArtifactHash)
  ).length;

  let verdict = 'NO_EVIDENCE';
  let tier = 'L0-syntax';
  const missing = missingObligations(goal, latest);
  if (latest) {
    if (latest.status === 'fail' || latest.counterexample) {
      verdict = 'FAIL';
      tier = 'L0-counterexample';
    } else if (missing.length > 0) {
      verdict = 'PASS_WITH_GAPS';
      tier = 'L1-partial';
    } else {
      verdict = 'PASS_EVIDENCED';
      tier = 'L2-evidence';
    }
  } else if (staleEvidenceCount > 0) {
    verdict = 'STALE';
  }

  return {
    goal_id: goal.goal_id,
    goal_path: loaded.goalPath,
    manifest_hash: currentManifestHash,
    artifact_hash: currentArtifactHash,
    tier,
    verdict,
    status: latest ? latest.status : 'none',
    summary: latest ? latest.summary : summarizeVerificationStatuses([]),
    metrics: latest ? latest.metrics : {},
    distributions: latest ? (latest.distributions || {}) : {},
    environment: latest ? (latest.environment || {}) : {},
    complexity: latest ? latest.complexity : measureComplexity(goal, cwd),
    counterexample: latest ? latest.counterexample : latestCounterexample(current),
    missing_obligations: missing,
    stale_evidence_count: staleEvidenceCount,
    current_evidence_count: current.length,
    evidence_path: evidencePath,
    replay: latest && latest.replay ? latest.replay : `xoloop-verify run ${repoRelative(cwd, loaded.goalPath)}`,
  };
}

async function runGoalVerify(goalPath, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const loaded = loadGoalManifest(goalPath);
  const goal = loaded.goal;
  let result;
  function resolveObligationGoalPath(obligation) {
    if (obligation && typeof obligation.goal_path === 'string' && obligation.goal_path.trim()) {
      const raw = obligation.goal_path.trim();
      return path.isAbsolute(raw) ? raw : path.resolve(goalBaseDir(loaded.goalPath), raw);
    }
    const id = sanitizeSuiteId(obligation && obligation.id ? obligation.id : obligation && obligation.kind ? obligation.kind : 'obligation');
    return path.join(goalBaseDir(loaded.goalPath), 'suites', id, 'goal.yaml');
  }
  async function runOne(subGoal, prefix = '', subGoalPath = loaded.goalPath) {
    let subResult;
    if (subGoal.verify.kind === 'json-canonicalizer') {
      subResult = await runJsonCanonicalizerVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
      });
    } else if (subGoal.verify.kind === 'command-suite') {
      subResult = await runCommandSuiteVerification(subGoal, subGoalPath, {
        cwd,
      });
    } else if (subGoal.verify.kind === 'general-io') {
      subResult = await runGeneralIoVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
      });
    } else if (subGoal.verify.kind === 'frontend-suite') {
      subResult = await runFrontendSuiteVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
        updateBaselines: options.updateBaselines || false,
      });
    } else if (subGoal.verify.kind === 'cli-suite') {
      subResult = await runCliSuiteVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
      });
    } else if (subGoal.verify.kind === 'api-suite') {
      subResult = await runApiSuiteVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
      });
    } else if (subGoal.verify.kind === 'state-suite') {
      subResult = await runStateSuiteVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
      });
    } else if (subGoal.verify.kind === 'state-machine-suite') {
      subResult = await runStateMachineSuiteVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
      });
    } else if (subGoal.verify.kind === 'concurrency-suite') {
      subResult = await runConcurrencySuiteVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
      });
    } else if (subGoal.verify.kind === 'performance-suite') {
      subResult = await runPerformanceSuiteVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
        updateBaselines: options.updateBaselines || false,
      });
    } else if (subGoal.verify.kind === 'formal-suite') {
      subResult = await runFormalSuiteVerification(subGoal, subGoalPath, {
        cwd,
        caseId: options.caseId || null,
      });
    } else if (subGoal.verify.kind === 'discovery-suite') {
      subResult = await runDiscoverySuiteVerification(subGoal, subGoalPath, {
        cwd,
      });
    } else {
      throw new AdapterError('GOAL_VERIFY_KIND_UNSUPPORTED', 'verify.kind', `Unsupported verify kind: ${subGoal.verify.kind}`);
    }
    if (!prefix) return subResult;
    return {
      ...subResult,
      verifications: (subResult.verifications || []).map((v) => ({ ...v, id: `${prefix}:${v.id}` })),
      counterexample: subResult.counterexample
        ? { ...subResult.counterexample, suite_id: prefix, sub_goal_path: subGoalPath, obligation: `${prefix}:${subResult.counterexample.obligation || 'unknown'}` }
        : null,
    };
  }

  if (goal.verify.kind === 'suite') {
    const verifications = [];
    const metrics = {};
    let counterexample = null;
    const suiteId = options.suiteId || options.obligationId || null;
    const obligations = suiteId
      ? (goal.verify.obligations || []).filter((obligation) => obligation.id === suiteId)
      : (goal.verify.obligations || []);
    if (suiteId && obligations.length === 0) {
      result = {
        status: 'fail',
        verifications: [{ id: 'suite_selection', status: 'fail', message: `No suite obligation matched ${suiteId}` }],
        metrics: {},
        counterexample: { obligation: 'suite_selection', message: `No suite obligation matched ${suiteId}` },
      };
    } else {
      for (const obligation of obligations) {
      const subGoal = {
        ...goal,
        interface: obligation.interface || goal.interface,
        artifacts: obligation.artifacts || goal.artifacts,
        metrics: obligation.metrics || goal.metrics,
        acceptance: obligation.acceptance || goal.acceptance,
        verify: { ...obligation },
      };
      const subGoalPath = resolveObligationGoalPath(obligation);
      const subResult = await runOne(subGoal, obligation.id, subGoalPath);
      const hasFailure = (subResult.verifications || []).some((v) => v.status === 'fail');
      const hasGap = (subResult.verifications || []).some((v) => v.status === 'gap');
      verifications.push({
        id: `${obligation.id}:suite_obligation`,
        status: hasFailure ? 'fail' : (hasGap ? 'gap' : 'pass'),
        kind: obligation.kind,
        sub_goal_path: subGoalPath,
      });
      verifications.push(...subResult.verifications);
      for (const [name, value] of Object.entries(subResult.metrics || {})) {
        metrics[`${obligation.id}:${name}`] = value;
      }
      if (subResult.counterexample && !counterexample) counterexample = subResult.counterexample;
      }
      result = {
        status: counterexample ? 'fail' : 'pass',
        verifications,
        metrics,
        counterexample,
      };
    }
  } else if (goal.verify.kind === 'json-canonicalizer') {
    result = await runJsonCanonicalizerVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'command-suite') {
    result = await runCommandSuiteVerification(goal, loaded.goalPath, {
      cwd,
    });
  } else if (goal.verify.kind === 'general-io') {
    result = await runGeneralIoVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'frontend-suite') {
    result = await runFrontendSuiteVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
      updateBaselines: options.updateBaselines || false,
    });
  } else if (goal.verify.kind === 'cli-suite') {
    result = await runCliSuiteVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'api-suite') {
    result = await runApiSuiteVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'state-suite') {
    result = await runStateSuiteVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'state-machine-suite') {
    result = await runStateMachineSuiteVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'concurrency-suite') {
    result = await runConcurrencySuiteVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'performance-suite') {
    result = await runPerformanceSuiteVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
      updateBaselines: options.updateBaselines || false,
    });
  } else if (goal.verify.kind === 'formal-suite') {
    result = await runFormalSuiteVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'discovery-suite') {
    result = await runDiscoverySuiteVerification(goal, loaded.goalPath, {
      cwd,
    });
  } else {
    throw new AdapterError('GOAL_VERIFY_KIND_UNSUPPORTED', 'verify.kind', `Unsupported verify kind: ${goal.verify.kind}`);
  }

  const complexity = measureComplexity(goal, cwd);
  const metrics = {
    ...result.metrics,
    complexity_score: complexity.complexity_score,
  };
  const record = {
    schema: 'xoloop.evidence.v0.1',
    goal_id: goal.goal_id,
    manifest_hash: manifestHash(goal),
    artifact_hash: artifactHash(goal, cwd, loaded.goalPath),
    status: result.status,
    started_at: nowIso(),
    verifications: result.verifications,
    summary: summarizeVerificationStatuses(result.verifications),
    metrics,
    distributions: result.distributions || {},
    environment: result.environment || {},
    complexity,
    counterexample: result.counterexample,
    replay: result.counterexample && result.counterexample.case_id
      ? `xoloop-verify run ${repoRelative(cwd, loaded.goalPath)}${result.counterexample.suite_id ? ` --suite ${result.counterexample.suite_id}` : ''} --case ${result.counterexample.case_id}`
      : `xoloop-verify run ${repoRelative(cwd, loaded.goalPath)}${result.counterexample && result.counterexample.suite_id ? ` --suite ${result.counterexample.suite_id}` : ''}`,
  };
  appendEvidence(evidencePathForGoal(loaded.goalPath), record);
  const card = buildVerifyCard(loaded.goalPath, { cwd });
  return { record, card };
}

function formatVerifyCard(card) {
  const lines = [
    `goal: ${card.goal_id}`,
    `verdict: ${card.verdict}`,
    `tier: ${card.tier}`,
    `manifest: ${card.manifest_hash}`,
    `artifact: ${card.artifact_hash}`,
    `evidence: ${card.current_evidence_count} current, ${card.stale_evidence_count} stale`,
    `checks: ${card.summary.passed || 0} passed, ${card.summary.failed || 0} failed, ${card.summary.gaps || 0} gaps`,
  ];
  if (card.metrics && Object.keys(card.metrics).length > 0) {
    lines.push(`metrics: ${Object.entries(card.metrics).map(([k, v]) => `${k}=${Number.isFinite(v) ? Number(v).toFixed(3) : v}`).join(', ')}`);
  }
  if (card.complexity) {
    lines.push(`complexity: score=${card.complexity.complexity_score}, loc=${card.complexity.loc}, branches=${card.complexity.branch_count}`);
  }
  if (card.counterexample) {
    lines.push(`counterexample: ${card.counterexample.case_id || card.counterexample.obligation} (${card.counterexample.message})`);
  }
  if (card.missing_obligations && card.missing_obligations.length > 0) {
    lines.push(`missing: ${card.missing_obligations.join(', ')}`);
  }
  lines.push(`replay: ${card.replay}`);
  return lines.join('\n');
}

module.exports = {
  buildApiSuiteGoal,
  buildJsonCanonicalizerGoal,
  buildCliSuiteGoal,
  buildConcurrencySuiteGoal,
  buildDiscoverySuiteGoal,
  buildSuiteGoal,
  buildPerformanceSuiteGoal,
  buildFormalSuiteGoal,
  buildFrontendSuiteGoal,
  buildStateMachineSuiteGoal,
  buildStateSuiteGoal,
  buildVerifyCard,
  createGoal,
  formatVerifyCard,
  runGoalVerify,
  scanApiRepo,
  scanCliRepo,
  scanConcurrencyRepo,
  discoverRepo,
  scanPerformanceRepo,
  scanFormalRepo,
  scanFunctionRepo,
  scanFrontendRepo,
  buildRuntimeLabPlan,
  scanStateMachineRepo,
  scanStateRepo,
  summarizeVerificationStatuses,
};
