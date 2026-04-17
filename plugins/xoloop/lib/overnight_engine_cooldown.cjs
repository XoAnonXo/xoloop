/**
 * overnight_engine_cooldown.cjs — cool-down, novelty gating, and ledger helpers
 * extracted from overnight_engine.cjs.
 *
 * Handles: surface cool-down logic, no-retry idea lists, cross-batch ledger
 * merging, proposal gating, planner decision gating, patch fingerprint novelty,
 * and post-repair rechecking.
 */

const fs = require('node:fs');
const path = require('node:path');

const { normalizeText, nowIso } = require('./baton_common.cjs');
const {
  isForbiddenPath,
  isManualOnlyPath,
  isPathAllowedForSurface,
} = require('./overnight_adapter.cjs');
const {
  buildCandidateFingerprint,
  isNonCodePath,
  shouldCoolSourceTarget,
} = require('./overnight_staged.cjs');
const {
  buildCandidateRejection,
  buildLedgerProposalFallback,
  buildRejectionStructuredError,
  buildRejectionSummary,
  buildSurfaceBudget,
  checkRepairCompatibility,
  collectChangedSymbols,
  collectProposalPaths,
  createPatchFamilyFingerprint,
  createPatchFingerprint,
  proposalSummary,
} = require('./overnight_engine_proposal.cjs');

function shouldCoolSurfaceDown(ledger, objectiveHash, surfaceId) {
  const relevant = ledger.filter((entry) => entry.objectiveHash === objectiveHash && entry.surfaceId === surfaceId);
  const noBenefit = relevant.filter((entry) => [
    'no-safe-change',
    'validation-failed',
    'full-validation-failed',
    'audit-reject',
    'missing-tests',
    'scope-gate',
    'duplicate',
    'duplicate-family',
    'duplicate-target',
    'anchor-preflight-failed',
    'invalid-target-window',
    'planner-schema-failed',
    'planner-call-failed',
    'editor-schema-failed',
    'hallucinated-reference',
  ].includes(entry.reasonCode));
  return noBenefit.length >= 2;
}

function listNoRetryIdeas(ledger, objectiveHash, surfaceId) {
  return ledger
    .filter((entry) => entry.objectiveHash === objectiveHash && entry.surfaceId === surfaceId)
    .map((entry) => ({
      patchFingerprint: entry.patchFingerprint,
      patchFamilyFingerprint: entry.patchFamilyFingerprint || null,
      outcome: entry.outcome,
      reasonCode: entry.reasonCode,
      changedPaths: entry.changedPaths,
      summary: entry.summary,
      rejectionSummary: entry.rejectionSummary || entry.summary,
      // Planner-only attempts produce no fingerprint, but they DO have source/test
      // targets that future attempts should avoid re-proposing. Exposing them here
      // lets the planner prompt see "these targets were already explored" without
      // relying on patch-level novelty.
      sourceTarget: entry.sourceTarget || null,
      testTarget: entry.testTarget || null,
    }));
}

/**
 * Extract the set of (source.path, source.symbol) tuples already explored by
 * any prior attempt on this surface. The planner consumes this as an explicit
 * "already-explored targets" hint so it picks materially different targets
 * instead of dogpiling the same handful of functions across many batches.
 */
function listExploredTargets(ledger, objectiveHash, surfaceId) {
  const seen = new Set();
  const targets = [];
  for (const entry of ledger) {
    if (entry.objectiveHash !== objectiveHash || entry.surfaceId !== surfaceId) continue;
    const src = entry.sourceTarget;
    if (!src || !src.path) continue;
    const key = `${src.path}::${src.symbol || src.anchorText || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      path: src.path,
      symbol: src.symbol || src.anchorText || null,
      outcome: entry.outcome,
      reasonCode: entry.reasonCode,
    });
  }
  return targets;
}

/**
 * Cross-batch novelty: walk sibling batch directories under the same report root
 * and aggregate their ledger entries so the current attempt sees what prior batches
 * already proposed/rejected. Prevents the night-1 failure mode where 6 different
 * batches proposed the same maybeParseStructured wrap.
 *
 * Best-effort: any unreadable manifest is silently skipped so a corrupted sibling
 * can't block the current batch. Caps at 200 sibling batches so a disk with
 * thousands of stale runs doesn't blow up RAM.
 */
function loadSiblingLedgerEntries(manifest) {
  try {
    if (!manifest || !manifest.reportRoot || !manifest.batchId) {
      return [];
    }
    const siblingsRoot = path.dirname(manifest.reportRoot);
    if (!fs.existsSync(siblingsRoot)) {
      return [];
    }
    const entries = [];
    const siblings = fs.readdirSync(siblingsRoot)
      .filter((name) => name !== manifest.batchId)
      .sort()
      .slice(-200);
    for (const sibling of siblings) {
      const siblingManifestPath = path.join(siblingsRoot, sibling, 'manifest.json');
      try {
        if (!fs.existsSync(siblingManifestPath)) {
          continue;
        }
        const parsed = JSON.parse(fs.readFileSync(siblingManifestPath, 'utf8'));
        if (parsed && Array.isArray(parsed.ledger)) {
          // Avoid spread-push: V8 limits the number of arguments you can
          // spread into a function call (~65K-125K).  A single sibling with
          // a massive ledger (long overnight run, corrupted manifest) would
          // throw RangeError: Maximum call stack size exceeded and crash the
          // current batch.  A simple for-loop has no such limit.  Cap at 500
          // entries per sibling so one bloated manifest can't dominate the
          // merged ledger and blow RAM.
          const cap = Math.min(parsed.ledger.length, 500);
          for (let i = 0; i < cap; i += 1) {
            entries.push(parsed.ledger[i]);
          }
        }
      } catch {
        // Skip unreadable siblings silently.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Merge the current batch ledger with cross-batch sibling ledger entries so
 * novelty checks, no-retry lists, and cool-down logic can see the full history.
 */
function mergedLedgerForNovelty(manifest) {
  const current = Array.isArray(manifest.ledger) ? manifest.ledger : [];
  const siblings = loadSiblingLedgerEntries(manifest);
  return [...current, ...siblings];
}

function buildLedgerEntry(report, objectiveHash, surface, patchFingerprint) {
  const proposal = buildLedgerProposalFallback(report);
  return {
    time: nowIso(),
    attemptId: report.attemptId,
    objectiveHash,
    surfaceId: surface.id,
    pipelineMode: report.pipelineMode || 'legacy',
    stage: report.failureStage || (report.outcome === 'kept' ? 'accepted' : 'legacy'),
    patchFingerprint,
    patchFamilyFingerprint: report.patchFamilyFingerprint || null,
    candidateFingerprint: report.candidateFingerprint || null,
    sourceTarget: report.sourceTarget || null,
    testTarget: report.testTarget || null,
    windowFingerprint: report.windowFingerprint || null,
    changedPaths: collectProposalPaths(proposal),
    changedSymbols: collectChangedSymbols(report, proposal),
    outcome: report.outcome,
    reasonCode: report.reasonCode,
    failureKind: report.failureKind || report.reasonCode,
    failedPath: report.failedPath || null,
    failedSearchExcerpt: normalizeText(report.failedSearchExcerpt),
    baseCommit: report.baseCommit,
    commitSha: report.commit && report.commit.sha ? report.commit.sha : null,
    summary: proposalSummary(proposal),
    rejectionSummary: buildRejectionSummary(report, proposal),
    structuredError: buildRejectionStructuredError(report),
  };
}

function gateProposal(adapter, objective, surface, proposal, manifest, surfaceState) {
  // Same split as gatePlannerDecision: novelty is cross-batch, cool-down is per-batch.
  const currentBatchLedger = Array.isArray(manifest && manifest.ledger) ? manifest.ledger : [];
  const allBlocks = proposal.codeChanges.concat(proposal.testChanges);
  const touchedPaths = collectProposalPaths(proposal);
  const budget = buildSurfaceBudget(surface);
  if (surfaceState && surfaceState.frozen) {
    return { ok: false, reasonCode: 'surface-frozen', nextStep: 'Wait for a new objective or a new base commit before reopening this surface.' };
  }
  if (surface.risk === 'manual') {
    return { ok: false, reasonCode: 'manual-surface', nextStep: 'Leave this surface for manual review.' };
  }
  if (proposal.codeChanges.length > 0 && proposal.testChanges.length === 0) {
    const nonCodeOnly = proposal.codeChanges.every((entry) => isNonCodePath(entry.path));
    if (!nonCodeOnly) {
      return { ok: false, reasonCode: 'missing-tests', nextStep: 'Add test changes before changing production files.' };
    }
  }
  if (touchedPaths.length > budget.maxFiles || allBlocks.length > budget.maxBlocks) {
    return { ok: false, reasonCode: 'risk-budget-exceeded', nextStep: 'Make the proposal smaller.' };
  }
  for (const targetPath of touchedPaths) {
    if (isManualOnlyPath(adapter, targetPath)) {
      return { ok: false, reasonCode: 'manual-only-path', nextStep: 'Leave manual-only paths untouched.' };
    }
    if (!isPathAllowedForSurface(adapter, surface, targetPath, { includeTests: true })) {
      return { ok: false, reasonCode: 'scope-gate', nextStep: 'Keep edits inside the allowed surface.' };
    }
    if (isForbiddenPath(surface, targetPath)) {
      return { ok: false, reasonCode: 'forbidden-path', nextStep: 'Remove forbidden paths from the proposal.' };
    }
  }
  if (shouldCoolSurfaceDown(currentBatchLedger, objective.objectiveHash, surface.id)) {
    return { ok: false, reasonCode: 'surface-cooled-down', nextStep: 'Wait for new evidence or a new objective before reopening this surface.' };
  }
  return { ok: true };
}

function gatePlannerDecision(adapter, objective, surface, plan, manifest, surfaceState) {
  // Novelty checks span sibling batches so we never re-propose work another
  // batch already tried. Cool-down, by contrast, is a per-batch concept:
  // it's meant to stop a single batch from thrashing on the same surface,
  // not to permanently disable a surface once 2 historical rejects exist.
  // Using the merged ledger for cool-down was a burst4 regression that
  // crashed plan rate from 64% to 18% because every surface was immediately
  // "cooled" by cross-batch reject history.
  const ledger = mergedLedgerForNovelty(manifest);
  const currentBatchLedger = Array.isArray(manifest && manifest.ledger) ? manifest.ledger : [];
  if (surfaceState && surfaceState.frozen) {
    return buildCandidateRejection('surface-frozen', 'Wait for a new objective or a new base commit before reopening this surface.');
  }
  if (surface.risk === 'manual') {
    return buildCandidateRejection('manual-surface', 'Leave this surface for manual review.');
  }
  if (plan.decision === 'no_safe_change') {
    return {
      ok: true,
      noSafeChange: true,
      candidateFingerprint: null,
    };
  }
  if (!isPathAllowedForSurface(adapter, surface, plan.sourceTarget.path, { includeTests: false })) {
    return buildCandidateRejection('scope-gate', 'Keep the planned source target inside the allowed surface.');
  }
  if (!isPathAllowedForSurface(adapter, surface, plan.testTarget.path, { includeTests: true })) {
    return buildCandidateRejection('scope-gate', 'Keep the planned test target inside the allowed surface.');
  }
  if (isManualOnlyPath(adapter, plan.sourceTarget.path) || isManualOnlyPath(adapter, plan.testTarget.path)) {
    return buildCandidateRejection('manual-only-path', 'Leave manual-only paths untouched.');
  }
  if (isForbiddenPath(surface, plan.sourceTarget.path) || isForbiddenPath(surface, plan.testTarget.path)) {
    return buildCandidateRejection('forbidden-path', 'Remove forbidden paths from the planned target pair.');
  }
  const candidateFingerprint = buildCandidateFingerprint(objective.objectiveHash, surface.id, plan);
  const duplicate = ledger.find((entry) => (
    entry.objectiveHash === objective.objectiveHash
    && entry.surfaceId === surface.id
    && entry.candidateFingerprint === candidateFingerprint
  ));
  if (duplicate) {
    return buildCandidateRejection('duplicate', 'Choose a materially different target pair.');
  }
  // Target-level novelty (belt and suspenders): reject when (path, symbol) has
  // already been attempted on this surface, even if the full candidateFingerprint
  // differs because the model picked a different test anchor or rephrased the
  // source anchor text. This is what burst1 lacked — 7 plans all targeted
  // `summarizeValidationResults` because their full fingerprints varied but the
  // target was identical.
  const planPath = normalizeText(plan.sourceTarget && plan.sourceTarget.path);
  const planSymbol = normalizeText(plan.sourceTarget && (plan.sourceTarget.symbol || plan.sourceTarget.anchorText));
  if (planPath) {
    const sameTarget = ledger.find((entry) => (
      entry.objectiveHash === objective.objectiveHash
      && entry.surfaceId === surface.id
      && entry.sourceTarget
      && normalizeText(entry.sourceTarget.path) === planPath
      && normalizeText(entry.sourceTarget.symbol || entry.sourceTarget.anchorText) === planSymbol
    ));
    if (sameTarget) {
      return buildCandidateRejection('duplicate-target', `Target ${planPath}::${planSymbol || '(file)'} already proposed. Pick a different source target on this surface.`);
    }
  }
  if (shouldCoolSourceTarget(currentBatchLedger, objective.objectiveHash, surface.id, plan.sourceTarget)) {
    return buildCandidateRejection('surface-cooled-down', 'Wait for new evidence before reopening this source target.');
  }
  if (shouldCoolSurfaceDown(currentBatchLedger, objective.objectiveHash, surface.id)) {
    return buildCandidateRejection('surface-cooled-down', 'Wait for new evidence or a new objective before reopening this surface.');
  }
  return {
    ok: true,
    candidateFingerprint,
  };
}

function getPatchFingerprintOrReject(manifest, objectiveHash, surfaceId, proposal) {
  const patchFingerprint = createPatchFingerprint(objectiveHash, surfaceId, proposal);
  const patchFamilyFingerprint = createPatchFamilyFingerprint(objectiveHash, surfaceId, proposal);
  // Novelty now spans sibling batches so night-N cannot re-propose night-(N-1)'s rejects.
  const ledgerForNovelty = mergedLedgerForNovelty(manifest);
  const duplicate = ledgerForNovelty.find((entry) => (
    entry.objectiveHash === objectiveHash
    && entry.surfaceId === surfaceId
    && entry.patchFingerprint === patchFingerprint
  ));
  if (duplicate) {
    return {
      ok: false,
      patchFingerprint,
      patchFamilyFingerprint,
      duplicate,
      duplicateKind: 'exact',
    };
  }
  const familyDuplicate = ledgerForNovelty.find((entry) => (
    entry.objectiveHash === objectiveHash
    && entry.surfaceId === surfaceId
    && entry.patchFamilyFingerprint
    && entry.patchFamilyFingerprint === patchFamilyFingerprint
  ));
  if (familyDuplicate) {
    return {
      ok: false,
      patchFingerprint,
      patchFamilyFingerprint,
      duplicate: familyDuplicate,
      duplicateKind: 'family',
    };
  }
  return {
    ok: true,
    patchFingerprint,
    patchFamilyFingerprint,
  };
}

function recheckProposalAfterRepair(options) {
  const compatibility = checkRepairCompatibility(options.originalProposal, options.proposal);
  if (!compatibility.ok) {
    return {
      ok: false,
      reasonCode: compatibility.reasonCode,
      nextStep: compatibility.nextStep,
      patchFingerprint: createPatchFingerprint(options.objective.objectiveHash, options.surface.id, options.proposal),
      patchFamilyFingerprint: createPatchFamilyFingerprint(options.objective.objectiveHash, options.surface.id, options.proposal),
    };
  }
  const gate = gateProposal(
    options.adapter,
    options.objective,
    options.surface,
    options.proposal,
    options.manifest,
    options.surfaceState,
  );
  if (!gate.ok) {
    return {
      ok: false,
      reasonCode: gate.reasonCode,
      nextStep: gate.nextStep,
      patchFingerprint: createPatchFingerprint(options.objective.objectiveHash, options.surface.id, options.proposal),
      patchFamilyFingerprint: createPatchFamilyFingerprint(options.objective.objectiveHash, options.surface.id, options.proposal),
    };
  }
  const novelty = getPatchFingerprintOrReject(
    options.manifest,
    options.objective.objectiveHash,
    options.surface.id,
    options.proposal,
  );
  if (!novelty.ok) {
    return {
      ok: false,
      reasonCode: novelty.duplicateKind === 'family' ? 'duplicate-family' : 'duplicate',
      nextStep: novelty.duplicateKind === 'family'
        ? 'This repair reopened the same failed change family. Pick a different anchor or idea.'
        : 'Start from a materially different idea or wait for new evidence.',
      patchFingerprint: novelty.patchFingerprint,
      patchFamilyFingerprint: novelty.patchFamilyFingerprint,
    };
  }
  return {
    ok: true,
    patchFingerprint: novelty.patchFingerprint,
    patchFamilyFingerprint: novelty.patchFamilyFingerprint,
  };
}

module.exports = {
  shouldCoolSurfaceDown,
  listNoRetryIdeas,
  listExploredTargets,
  loadSiblingLedgerEntries,
  mergedLedgerForNovelty,
  buildLedgerEntry,
  gateProposal,
  gatePlannerDecision,
  getPatchFingerprintOrReject,
  recheckProposalAfterRepair,
};
