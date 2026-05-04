'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');
const { measureComplexity } = require('./goal_complexity.cjs');
const {
  artifactHash,
  evidencePathForGoal,
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
const { runCommandSuiteVerification } = require('./goal_command_suite.cjs');

function nowIso() {
  return new Date().toISOString();
}

function repoRelative(cwd, filePath) {
  return path.relative(path.resolve(cwd || process.cwd()), path.resolve(filePath)).replace(/\\/g, '/');
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

function createGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const kind = options.kind || 'json-canonicalizer';
  if (kind !== 'json-canonicalizer') {
    throw new AdapterError('GOAL_CREATE_KIND_UNSUPPORTED', 'kind', `Unsupported goal kind: ${kind}`);
  }
  const goalId = options.goalId || 'json-canon-seed';
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
  writeJsonCanonicalizerAssets(goalDir);
  const goal = buildJsonCanonicalizerGoal({ ...options, cwd, goalId });
  return writeGoalManifest(goalPath, goal);
}

function summarizeVerificationStatuses(verifications) {
  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
    by_id: {},
  };
  for (const v of Array.isArray(verifications) ? verifications : []) {
    if (!v || !v.id) continue;
    summary.total += 1;
    if (v.status === 'pass') summary.passed += 1;
    else if (v.status === 'fail') summary.failed += 1;
    if (!summary.by_id[v.id]) summary.by_id[v.id] = { passed: 0, failed: 0 };
    if (v.status === 'pass') summary.by_id[v.id].passed += 1;
    if (v.status === 'fail') summary.by_id[v.id].failed += 1;
  }
  return summary;
}

function requiredObligations(goal) {
  if (goal.verify.kind === 'command-suite') {
    return (goal.verify.commands || []).map((command) => command.id).sort();
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
  const currentArtifactHash = artifactHash(goal, cwd);
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
    complexity: latest ? latest.complexity : measureComplexity(goal, cwd),
    counterexample: latest ? latest.counterexample : latestCounterexample(current),
    missing_obligations: missing,
    stale_evidence_count: staleEvidenceCount,
    current_evidence_count: current.length,
    evidence_path: evidencePath,
    replay: `xoloop-verify run ${repoRelative(cwd, loaded.goalPath)}`,
  };
}

async function runGoalVerify(goalPath, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const loaded = loadGoalManifest(goalPath);
  const goal = loaded.goal;
  let result;
  if (goal.verify.kind === 'json-canonicalizer') {
    result = await runJsonCanonicalizerVerification(goal, loaded.goalPath, {
      cwd,
      caseId: options.caseId || null,
    });
  } else if (goal.verify.kind === 'command-suite') {
    result = await runCommandSuiteVerification(goal, loaded.goalPath, {
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
    artifact_hash: artifactHash(goal, cwd),
    status: result.status,
    started_at: nowIso(),
    verifications: result.verifications,
    summary: summarizeVerificationStatuses(result.verifications),
    metrics,
    complexity,
    counterexample: result.counterexample,
    replay: result.counterexample && result.counterexample.case_id
      ? `xoloop-verify run ${repoRelative(cwd, loaded.goalPath)} --case ${result.counterexample.case_id}`
      : `xoloop-verify run ${repoRelative(cwd, loaded.goalPath)}`,
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
    `checks: ${card.summary.passed || 0} passed, ${card.summary.failed || 0} failed`,
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
  buildJsonCanonicalizerGoal,
  buildVerifyCard,
  createGoal,
  formatVerifyCard,
  runGoalVerify,
  summarizeVerificationStatuses,
};
