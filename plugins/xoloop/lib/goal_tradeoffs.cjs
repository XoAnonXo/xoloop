'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');
const { appendEvidence, currentOptimiseEvents, readEvidence } = require('./goal_evidence.cjs');
const {
  evidencePathForGoal,
  goalBaseDir,
  loadGoalManifest,
  manifestHash,
  writeGoalManifest,
} = require('./goal_manifest.cjs');

function nowIso() {
  return new Date().toISOString();
}

function ledgerPath(goalPath) {
  return path.join(goalBaseDir(goalPath), 'tradeoffs.json');
}

function readLedger(goalPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(goalPath), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function writeLedger(goalPath, ledger) {
  const filePath = ledgerPath(goalPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return filePath;
}

function normalizeTradeoff(item, round = null) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = String(item.id || item.name || '').trim();
  if (!id) return null;
  return {
    id,
    description: String(item.description || item.summary || id),
    estimated_savings: String(item.estimated_savings || item.savings || 'unknown'),
    behavior_change: String(item.behavior_change || item.user_impact || 'requires review'),
    verification_impact: String(item.verification_impact || 'requires Verify contract update'),
    requires_user_approval: item.requires_user_approval !== false,
    round,
  };
}

function collectTradeoffProposals(goalPath) {
  const loaded = loadGoalManifest(goalPath);
  const evidencePath = evidencePathForGoal(loaded.goalPath);
  const events = currentOptimiseEvents(readEvidence(evidencePath), loaded.goal.goal_id, manifestHash(loaded.goal));
  const byId = new Map();
  for (const event of events) {
    for (const raw of Array.isArray(event.tradeoffs) ? event.tradeoffs : []) {
      const tradeoff = normalizeTradeoff(raw, event.round || null);
      if (tradeoff) byId.set(tradeoff.id, { ...byId.get(tradeoff.id), ...tradeoff, last_seen_at: event.started_at || event.generated_at || null });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function listTradeoffs(goalPath) {
  const loaded = loadGoalManifest(goalPath);
  const ledger = readLedger(loaded.goalPath);
  const decisions = ledger.decisions && typeof ledger.decisions === 'object' && !Array.isArray(ledger.decisions)
    ? ledger.decisions
    : {};
  return {
    schema: 'xoloop.tradeoffs.v0.1',
    goal_id: loaded.goal.goal_id,
    goal_path: loaded.goalPath,
    tradeoffs: collectTradeoffProposals(loaded.goalPath).map((tradeoff) => ({
      ...tradeoff,
      decision: decisions[tradeoff.id] || null,
    })),
    ledger_path: ledgerPath(loaded.goalPath),
  };
}

function updateManifestDecision(goalPath, id, decision) {
  const loaded = loadGoalManifest(goalPath);
  const acceptance = loaded.goal.acceptance || {};
  const accepted = new Set(Array.isArray(acceptance.accepted_tradeoffs) ? acceptance.accepted_tradeoffs : []);
  const rejected = new Set(Array.isArray(acceptance.rejected_tradeoffs) ? acceptance.rejected_tradeoffs : []);
  if (decision === 'accepted') {
    accepted.add(id);
    rejected.delete(id);
  } else if (decision === 'rejected') {
    rejected.add(id);
    accepted.delete(id);
  }
  const next = {
    ...loaded.goal,
    acceptance: {
      ...acceptance,
      accepted_tradeoffs: [...accepted].sort(),
      rejected_tradeoffs: [...rejected].sort(),
    },
  };
  writeGoalManifest(loaded.goalPath, next);
  return loadGoalManifest(loaded.goalPath).goal;
}

function decideTradeoff(goalPath, id, decision, options = {}) {
  const loaded = loadGoalManifest(goalPath);
  const cleanId = String(id || '').trim();
  if (!cleanId) throw new AdapterError('GOAL_TRADEOFF_ID_REQUIRED', 'id', 'tradeoff id is required');
  if (!['accepted', 'rejected'].includes(decision)) {
    throw new AdapterError('GOAL_TRADEOFF_DECISION_INVALID', 'decision', 'decision must be accepted or rejected');
  }
  const proposals = collectTradeoffProposals(loaded.goalPath);
  const proposal = proposals.find((tradeoff) => tradeoff.id === cleanId) || { id: cleanId };
  const ledger = readLedger(loaded.goalPath);
  const nextLedger = {
    schema: 'xoloop.tradeoff_ledger.v0.1',
    goal_id: loaded.goal.goal_id,
    decisions: {
      ...(ledger.decisions && typeof ledger.decisions === 'object' && !Array.isArray(ledger.decisions) ? ledger.decisions : {}),
      [cleanId]: {
        decision,
        reason: String(options.reason || '').trim(),
        decided_at: nowIso(),
        proposal,
      },
    },
  };
  const filePath = writeLedger(loaded.goalPath, nextLedger);
  const goal = updateManifestDecision(loaded.goalPath, cleanId, decision);
  appendEvidence(evidencePathForGoal(loaded.goalPath), {
    schema: 'xoloop.tradeoff_decision.v0.1',
    goal_id: loaded.goal.goal_id,
    manifest_hash: manifestHash(goal),
    tradeoff_id: cleanId,
    decision,
    reason: String(options.reason || '').trim(),
    decided_at: nowIso(),
    proposal,
  });
  return {
    schema: 'xoloop.tradeoff_decision.v0.1',
    goal_id: loaded.goal.goal_id,
    tradeoff_id: cleanId,
    decision,
    ledger_path: filePath,
    goal,
  };
}

module.exports = {
  decideTradeoff,
  listTradeoffs,
};
