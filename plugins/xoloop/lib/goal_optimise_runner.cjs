'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');
const { appendEvidence, currentOptimiseEvents, readEvidence } = require('./goal_evidence.cjs');
const { applyOperationSet, normalizeOperationSet, rollbackOperationSet } = require('./operation_ir.cjs');
const { artifactHash, evidencePathForGoal, loadGoalManifest, manifestHash } = require('./goal_manifest.cjs');
const { buildVerifyCard, runGoalVerify } = require('./goal_verify_runner.cjs');

function nowIso() {
  return new Date().toISOString();
}

function callAgentCommand(command, payload, cwd, timeoutMs = 600000) {
  const result = spawnSync('bash', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    throw new AdapterError(
      'GOAL_AGENT_COMMAND_FAILED',
      'agent_command',
      `agent command exited ${result.status}`,
      { fixHint: String(result.stderr || '').slice(-1000) },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new AdapterError(
      'GOAL_AGENT_COMMAND_INVALID_JSON',
      'stdout',
      `agent command returned non-JSON stdout: ${err.message}`,
      { fixHint: 'The agent command must write JSON { summary, operations } to stdout.' },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdapterError('GOAL_AGENT_COMMAND_INVALID_JSON', 'stdout', 'agent command JSON must be an object');
  }
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'no summary',
    operations: normalizeOperationSet(Array.isArray(parsed.operations) ? parsed.operations : []),
  };
}

function metricDelta(championValue, challengerValue, direction) {
  if (!Number.isFinite(championValue) || !Number.isFinite(challengerValue)) {
    return { fraction: 0, comparable: false };
  }
  if (championValue === 0 && challengerValue === 0) return { fraction: 0, comparable: true };
  if (championValue === 0) return { fraction: challengerValue === 0 ? 0 : -Infinity, comparable: true };
  const raw = direction === 'maximize'
    ? (challengerValue - championValue) / Math.abs(championValue)
    : (championValue - challengerValue) / Math.abs(championValue);
  return { fraction: raw, comparable: true };
}

function evaluateCandidate(championMetrics, challengerMetrics, goal) {
  const targets = goal.metrics.targets || [];
  const maxRegression = goal.acceptance.max_metric_regression || 0;
  const deltas = {};
  let improved = false;
  let regressed = false;

  for (const target of targets) {
    const champ = championMetrics[target.name];
    const chall = challengerMetrics[target.name];
    const delta = metricDelta(champ, chall, target.direction);
    deltas[target.name] = {
      champion: champ,
      challenger: chall,
      fraction: delta.fraction,
      direction: target.direction,
      threshold: target.threshold,
    };
    if (!delta.comparable) continue;
    if (delta.fraction > (target.threshold || 0)) improved = true;
    if (delta.fraction < -maxRegression) regressed = true;
  }

  if (regressed) {
    return { verdict: 'reject', reason: 'one or more protected metrics regressed beyond max_metric_regression', deltas };
  }
  if (improved) {
    return { verdict: 'accept', reason: 'candidate improved at least one target without protected regressions', deltas };
  }
  return { verdict: 'reject', reason: 'candidate verified but did not improve declared targets', deltas };
}

function buildPriorAttempts(events) {
  return events.slice(-20).map((event) => ({
    round: event.round,
    outcome: event.outcome,
    summary: event.summary,
    reason: event.reason,
  }));
}

function appendOptimiseEvent(evidencePath, event) {
  return appendEvidence(evidencePath, {
    schema: 'xoloop.optimise_event.v0.1',
    started_at: nowIso(),
    ...event,
  });
}

async function runOptimiseLoop(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalPath = options.goalPath;
  const agentCommand = options.agentCommand;
  if (!goalPath) throw new AdapterError('GOAL_OPTIMISE_GOAL_REQUIRED', 'goalPath', 'goalPath is required');
  if (!agentCommand) throw new AdapterError('GOAL_OPTIMISE_AGENT_REQUIRED', 'agent_command', '--agent-command is required');

  const loaded = loadGoalManifest(goalPath);
  const goal = loaded.goal;
  const evidencePath = evidencePathForGoal(loaded.goalPath);
  const roundLimit = options.forever ? Infinity : (Number.isFinite(options.rounds) && options.rounds > 0 ? Math.floor(options.rounds) : 1);
  const summary = { rounds: 0, accepted: 0, rejected: 0, failed: 0, noops: 0, stop_reason: 'round_limit' };

  let championRun = await runGoalVerify(loaded.goalPath, { cwd });
  let championCard = championRun.card;
  if (championCard.verdict !== 'PASS_EVIDENCED') {
    summary.stop_reason = 'champion_not_verified';
    summary.error = `Champion must be PASS_EVIDENCED before optimisation; got ${championCard.verdict}`;
    return summary;
  }

  for (let round = 1; round <= roundLimit; round += 1) {
    const records = readEvidence(evidencePath);
    const events = currentOptimiseEvents(records, goal.goal_id, manifestHash(goal));
    const payload = {
      goal,
      verify_card: championCard,
      latest_counterexample: championCard.counterexample || null,
      champion_metrics: championCard.metrics || {},
      prior_attempts: buildPriorAttempts(events),
      allowed_paths: goal.artifacts.paths || [],
    };

    let proposal;
    try {
      proposal = callAgentCommand(agentCommand, payload, cwd, options.agentTimeoutMs || 600000);
    } catch (err) {
      appendOptimiseEvent(evidencePath, {
        goal_id: goal.goal_id,
        manifest_hash: manifestHash(goal),
        artifact_hash: artifactHash(goal, cwd),
        round,
        outcome: 'agent_error',
        summary: err.message,
        reason: err.fixHint || err.code || 'agent command failed',
      });
      summary.failed += 1;
      summary.stop_reason = 'agent_error';
      summary.error = err.message;
      break;
    }

    if (proposal.operations.length === 0) {
      appendOptimiseEvent(evidencePath, {
        goal_id: goal.goal_id,
        manifest_hash: manifestHash(goal),
        artifact_hash: artifactHash(goal, cwd),
        round,
        outcome: 'noop',
        summary: proposal.summary,
        reason: 'agent returned no operations',
      });
      summary.noops += 1;
      summary.stop_reason = 'agent_noop';
      break;
    }

    let rollbackHandle = null;
    try {
      rollbackHandle = applyOperationSet(proposal.operations, {
        cwd,
        allowedPaths: goal.artifacts.paths || [],
      });
    } catch (err) {
      appendOptimiseEvent(evidencePath, {
        goal_id: goal.goal_id,
        manifest_hash: manifestHash(goal),
        artifact_hash: artifactHash(goal, cwd),
        round,
        outcome: 'apply_reject',
        summary: proposal.summary,
        reason: err.message,
      });
      summary.rejected += 1;
      summary.rounds += 1;
      continue;
    }

    const challengerRun = await runGoalVerify(loaded.goalPath, { cwd });
    const challengerCard = challengerRun.card;
    if (challengerCard.verdict !== 'PASS_EVIDENCED') {
      rollbackOperationSet(rollbackHandle);
      appendOptimiseEvent(evidencePath, {
        goal_id: goal.goal_id,
        manifest_hash: manifestHash(goal),
        artifact_hash: artifactHash(goal, cwd),
        round,
        outcome: 'verify_reject',
        summary: proposal.summary,
        reason: `candidate verification failed: ${challengerCard.verdict}`,
        counterexample: challengerCard.counterexample,
      });
      summary.rejected += 1;
      summary.rounds += 1;
      championCard = buildVerifyCard(loaded.goalPath, { cwd });
      continue;
    }

    const evaluation = evaluateCandidate(championCard.metrics || {}, challengerCard.metrics || {}, goal);
    if (evaluation.verdict === 'accept') {
      appendOptimiseEvent(evidencePath, {
        goal_id: goal.goal_id,
        manifest_hash: manifestHash(goal),
        artifact_hash: artifactHash(goal, cwd),
        round,
        outcome: 'accept',
        summary: proposal.summary,
        reason: evaluation.reason,
        deltas: evaluation.deltas,
      });
      summary.accepted += 1;
      summary.rounds += 1;
      championCard = challengerCard;
      continue;
    }

    rollbackOperationSet(rollbackHandle);
    appendOptimiseEvent(evidencePath, {
      goal_id: goal.goal_id,
      manifest_hash: manifestHash(goal),
      artifact_hash: artifactHash(goal, cwd),
      round,
      outcome: 'metric_reject',
      summary: proposal.summary,
      reason: evaluation.reason,
      deltas: evaluation.deltas,
    });
    summary.rejected += 1;
    summary.rounds += 1;
    championCard = buildVerifyCard(loaded.goalPath, { cwd });
  }

  if (summary.stop_reason === 'round_limit' && options.forever) summary.stop_reason = 'stopped';
  summary.final_card = buildVerifyCard(loaded.goalPath, { cwd });
  return summary;
}

module.exports = {
  callAgentCommand,
  evaluateCandidate,
  runOptimiseLoop,
};
