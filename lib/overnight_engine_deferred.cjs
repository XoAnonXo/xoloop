const path = require('node:path');

const {
  normalizeText,
  readJsonIfExists,
} = require('./baton_common.cjs');
const {
  appendOvernightEvent,
  appendSurfaceHistory,
  buildOvernightManifestPaths,
  loadOvernightManifest,
  updateOvernightManifest,
  writeSurfaceStatus,
} = require('./overnight_manifest.cjs');
const { AdapterError } = require('./errors.cjs');
const { proposalSummary } = require('./overnight_engine_proposal.cjs');

/**
 * Resolve a deferred audit for a previously pending-audit attempt.
 *
 * Uses a lazy require for buildAttemptPaths and writeAttemptArtifacts from the
 * main engine to avoid a circular dependency at module-load time. Both
 * functions are only needed at call time, well after the engine module has
 * finished loading.
 */
async function resolveDeferredAudit(options = {}) {
  // Lazy require to break circular dependency with overnight_engine.cjs
  const engine = require('./overnight_engine.cjs');
  const buildAttemptPaths = engine._buildAttemptPaths;
  const writeAttemptArtifacts = engine._writeAttemptArtifacts;

  const batchDir = path.resolve(options.batchDir);
  const surfaceId = normalizeText(options.surfaceId);
  const attemptId = normalizeText(options.attemptId);
  const verdict = normalizeText(options.verdict).toLowerCase();
  const note = normalizeText(options.note || options.notes);
  if (!surfaceId) {
    throw new AdapterError(
      'DEFERRED_AUDIT_MISSING_SURFACE_ID',
      'surfaceId',
      'resolveDeferredAudit requires surfaceId',
      { fixHint: 'Pass a non-empty surfaceId when calling resolveDeferredAudit.' }
    );
  }
  if (!['accept', 'reject'].includes(verdict)) {
    throw new AdapterError(
      'DEFERRED_AUDIT_INVALID_VERDICT',
      'verdict',
      `resolveDeferredAudit verdict must be "accept" or "reject", got: ${JSON.stringify(verdict)}`,
      { fixHint: 'Pass verdict: "accept" or verdict: "reject" when calling resolveDeferredAudit.' }
    );
  }
  const manifestPaths = buildOvernightManifestPaths(batchDir);
  const manifest = loadOvernightManifest(manifestPaths.manifestPath);
  const surface = manifest.surfaces.find((entry) => entry.surfaceId === surfaceId);
  if (!surface) {
    const knownIds = manifest.surfaces.map((s) => s.surfaceId).join(', ');
    throw new AdapterError(
      'DEFERRED_AUDIT_SURFACE_NOT_FOUND',
      'surfaceId',
      `Unknown surface in deferred audit: ${surfaceId}`,
      { fixHint: `Pass a surfaceId that exists in the manifest. Known surfaces: ${knownIds || '(none)'}` }
    );
  }
  const pendingAuditCommits = Array.isArray(surface.pendingAuditCommits) ? surface.pendingAuditCommits : [];
  const pending = attemptId
    ? pendingAuditCommits.find((entry) => entry.attemptId === attemptId)
    : pendingAuditCommits[0];
  if (!pending) {
    throw new AdapterError(
      'DEFERRED_AUDIT_PENDING_NOT_FOUND',
      'attemptId',
      `No pending deferred audit found for ${surfaceId}${attemptId ? ` (${attemptId})` : ''}`,
      { fixHint: 'Check the manifest pendingAuditCommits list or run a new batch before calling resolveDeferredAudit.' }
    );
  }

  const attemptPaths = buildAttemptPaths(manifestPaths.rootDir, surfaceId, pending.attemptId);
  const report = readJsonIfExists(attemptPaths.reportPath);
  if (!report) {
    throw new AdapterError(
      'DEFERRED_AUDIT_REPORT_MISSING',
      'reportPath',
      `Attempt report not found for deferred audit: ${attemptPaths.reportPath}`,
      { fixHint: 'Verify the attempt report.json exists in the batch directory before calling resolveDeferredAudit.' }
    );
  }

  report.audit = {
    verdict,
    confidence: 1,
    blockers: verdict === 'reject'
      ? [note || 'Deferred Codex audit rejected this attempt.']
      : [],
    evidence: [note || `Deferred Codex audit ${verdict === 'accept' ? 'accepted' : 'rejected'} this attempt.`],
    provider: 'codex',
    model: normalizeText(options.model) || 'subagent',
  };
  if (verdict === 'accept') {
    report.outcome = 'kept';
    report.reasonCode = 'accepted';
    report.nextStep = 'This surface is ready for manual morning promotion.';
    report.failureStage = 'accepted';
    report.failureKind = null;
  } else {
    report.outcome = 'discarded';
    report.reasonCode = 'audit-reject';
    report.nextStep = 'Use the Codex audit blockers as the next design brief.';
    report.failureStage = 'audit';
    report.failureKind = 'audit-reject';
  }
  writeAttemptArtifacts(attemptPaths, report);

  await updateOvernightManifest(manifestPaths, (next) => {
    const surfaceState = next.surfaces.find((entry) => entry.surfaceId === surfaceId);
    const pendingIndex = Array.isArray(surfaceState.pendingAuditCommits)
      ? surfaceState.pendingAuditCommits.findIndex((entry) => entry.attemptId === pending.attemptId)
      : -1;
    if (pendingIndex !== -1) {
      surfaceState.pendingAuditCommits.splice(pendingIndex, 1);
    }
    surfaceState.auditPending = surfaceState.pendingAuditCommits.length > 0;
    surfaceState.latestDecision = verdict;
    surfaceState.latestReasonCode = report.reasonCode;
    surfaceState.latestProofPath = attemptPaths.proofPath;
    surfaceState.latestHandoffPath = attemptPaths.handoffPath;
    surfaceState.latestCommit = pending.commit;
    surfaceState.status = report.outcome;
    surfaceState.lastError = null;
    if (verdict === 'accept') {
      const alreadyAccepted = surfaceState.acceptedCommits.some((entry) => entry.commit === pending.commit);
      if (!alreadyAccepted) {
        surfaceState.acceptedCommits.push({
          commit: pending.commit,
          summary: pending.summary,
          attemptId: pending.attemptId,
        });
      }
    }
    surfaceState.frozen = surfaceState.auditPending || surfaceState.acceptedCommits.length > 0;

    const ledgerEntry = next.ledger.find((entry) => entry.surfaceId === surfaceId && entry.attemptId === pending.attemptId);
    if (ledgerEntry) {
      ledgerEntry.outcome = report.outcome;
      ledgerEntry.reasonCode = report.reasonCode;
      ledgerEntry.failureKind = report.failureKind || report.reasonCode;
      ledgerEntry.stage = report.failureStage || (verdict === 'accept' ? 'accepted' : 'audit');
      ledgerEntry.commitSha = pending.commit;
      ledgerEntry.summary = proposalSummary(report.proposal);
    }
  });
  const nextManifest = loadOvernightManifest(manifestPaths.manifestPath);
  const updatedSurfaceState = nextManifest.surfaces.find((entry) => entry.surfaceId === surfaceId);
  writeSurfaceStatus(updatedSurfaceState, {
    proofPath: attemptPaths.proofPath,
    handoffPath: attemptPaths.handoffPath,
  });
  appendSurfaceHistory({
    surfaceId,
    historyPath: updatedSurfaceState.historyPath,
  }, {
    type: 'deferred-audit-resolved',
    attemptId: pending.attemptId,
    outcome: report.outcome,
    reasonCode: report.reasonCode,
    verdict,
  });
  appendOvernightEvent(manifestPaths, {
    type: 'deferred-audit-resolved',
    surfaceId,
    attemptId: pending.attemptId,
    verdict,
  });

  return {
    batchDir,
    surfaceId,
    attemptId: pending.attemptId,
    verdict,
    commit: pending.commit,
    proofPath: attemptPaths.proofPath,
    handoffPath: attemptPaths.handoffPath,
  };
}

module.exports = {
  resolveDeferredAudit,
};
