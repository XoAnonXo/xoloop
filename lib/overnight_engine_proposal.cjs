const {
  createFingerprint,
  extractJsonObjectFromText,
  normalizeText,
} = require('./baton_common.cjs');
const { AdapterError, extractStructuredError } = require('./errors.cjs');

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => normalizeText(entry)).filter(Boolean)
    : [];
}

function classifySyntaxFailure(validation) {
  const commands = Array.isArray(validation && validation.commands) ? validation.commands : [];
  const haystack = commands
    .map((entry) => `${entry.stdout || ''}\n${entry.stderr || ''}`)
    .join('\n');
  return /SyntaxError|Unexpected token|ParseError|ReferenceError:.*is not defined|Cannot use import statement|ERR_MODULE_NOT_FOUND/i.test(haystack);
}

function buildSurfaceBudget(surface) {
  const safeSurface = surface && typeof surface === 'object' && !Array.isArray(surface) ? surface : {};
  if (safeSurface.risk === 'safe') {
    return { maxFiles: 4, maxBlocks: 8 };
  }
  if (safeSurface.risk === 'guarded') {
    return { maxFiles: 6, maxBlocks: 12 };
  }
  return { maxFiles: 0, maxBlocks: 0 };
}

function collectProposalPaths(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return [];
  }
  const codeChanges = Array.isArray(proposal.codeChanges) ? proposal.codeChanges : [];
  const testChanges = Array.isArray(proposal.testChanges) ? proposal.testChanges : [];
  return Array.from(new Set(
    codeChanges.concat(testChanges).map((entry) => normalizeText(entry.path)).filter(Boolean),
  ));
}

function createPatchFingerprint(objectiveHash, surfaceId, proposal) {
  const safeProposal = proposal && typeof proposal === 'object' && !Array.isArray(proposal) ? proposal : {};
  const codeChanges = Array.isArray(safeProposal.codeChanges) ? safeProposal.codeChanges : [];
  const testChanges = Array.isArray(safeProposal.testChanges) ? safeProposal.testChanges : [];
  // Guard against circular references — preserve all patch fields but break cycles
  const seen = new WeakSet();
  const safePatch = (arr) => arr.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
    if (seen.has(entry)) return { path: '[Circular]' };
    seen.add(entry);
    return {
      path: normalizeText(entry.path),
      search: normalizeText(entry.search),
      replace: normalizeText(entry.replace),
      context_before: normalizeText(entry.context_before || entry.contextBefore),
      context_after: normalizeText(entry.context_after || entry.contextAfter),
    };
  });
  return createFingerprint({
    objectiveHash,
    surfaceId,
    codeChanges: safePatch(codeChanges),
    testChanges: safePatch(testChanges),
  });
}

function createPatchFamilyFingerprint(objectiveHash, surfaceId, proposal, options = {}) {
  const safeProposal = proposal && typeof proposal === 'object' && !Array.isArray(proposal) ? proposal : {};
  const codeChanges = Array.isArray(safeProposal.codeChanges) ? safeProposal.codeChanges : [];
  const testChanges = Array.isArray(safeProposal.testChanges) ? safeProposal.testChanges : [];
  const seen = new WeakSet();
  const normalizeBlock = (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { path: '', search: '', contextBefore: '', contextAfter: '' };
    if (seen.has(entry)) return { path: '[Circular]', search: '', contextBefore: '', contextAfter: '' };
    seen.add(entry);
    return {
      path: normalizeText(entry.path),
      search: normalizeText(entry.search),
      contextBefore: normalizeText(entry.context_before || entry.contextBefore),
      contextAfter: normalizeText(entry.context_after || entry.contextAfter),
    };
  };
  return createFingerprint({
    objectiveHash,
    surfaceId,
    codeAnchors: codeChanges.map(normalizeBlock),
    testAnchors: testChanges.map(normalizeBlock),
    sourceTarget: options && options.sourceTarget ? options.sourceTarget : null,
    testTarget: options && options.testTarget ? options.testTarget : null,
  });
}

function collectChangedSymbols(report, proposal) {
  const symbols = [];
  if (report && report.sourceTarget) {
    symbols.push(report.sourceTarget.symbol || report.sourceTarget.anchorText);
  }
  if (report && report.testTarget) {
    symbols.push(report.testTarget.anchorText);
  }
  if (proposal && typeof proposal === 'object') {
    const codeChanges = Array.isArray(proposal.codeChanges) ? proposal.codeChanges : [];
    codeChanges.forEach((entry) => {
      const search = normalizeText(entry.search);
      const match = search.match(/\b(function|class|const|let|var)\s+([A-Za-z0-9_]+)/);
      if (match && match[2]) {
        symbols.push(match[2]);
      }
    });
  }
  return Array.from(new Set(symbols.map((entry) => normalizeText(entry)).filter(Boolean)));
}

function proposalSummary(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return 'objective-driven overnight change';
  }
  return normalizeText(proposal.logicalExplanation && proposal.logicalExplanation.problem) || 'objective-driven overnight change';
}

function buildRejectionSummary(report, proposal) {
  const safeReport = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const reason = normalizeText(safeReport.reasonCode || safeReport.failureKind || safeReport.outcome || 'rejected');
  const stage = normalizeText(safeReport.failureStage);
  const stageToken = stage ? `stage:${stage}` : '';
  const summary = proposalSummary(proposal);
  const nextStep = normalizeText(safeReport.nextStep);
  return [reason, stageToken, summary, nextStep].filter(Boolean).join(' | ');
}

/**
 * Pull structured error fields out of a report. Returns null if the applyError
 * on the report is not an AdapterError (or does not carry one in its cause chain).
 * The returned shape is machine-consumable by the next repair attempt.
 */
function buildRejectionStructuredError(report) {
  if (!report || !report.applyError) {
    return null;
  }
  const structured = extractStructuredError(report.applyError);
  if (!structured) {
    return null;
  }
  return {
    code: structured.code,
    field: structured.field,
    message: structured.message,
    fix_hint: structured.fixHint,
    failure_stage: report.failureStage || null,
  };
}

function proposalHasNoChanges(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return true;
  }
  const codeChanges = Array.isArray(proposal.codeChanges) ? proposal.codeChanges : [];
  const testChanges = Array.isArray(proposal.testChanges) ? proposal.testChanges : [];
  return codeChanges.length === 0 && testChanges.length === 0;
}

function normalizePatchList(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new AdapterError(
      'PROPOSAL_FIELD_MUST_BE_ARRAY',
      fieldName,
      `${fieldName} must be an array`,
      { fixHint: `Ensure the model returns "${fieldName}" as a JSON array, not a string or object.` }
    );
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AdapterError(
        'PROPOSAL_FIELD_ENTRY_MUST_BE_OBJECT',
        `${fieldName}[${index}]`,
        `${fieldName}[${index}] must be an object`,
        { fixHint: `Each entry in "${fieldName}" must be a JSON object with path, search, and replace keys.` }
      );
    }
    return {
      path: normalizeText(entry.path),
      search: String(entry.search ?? ''),
      replace: String(entry.replace ?? ''),
      context_before: String(entry.context_before ?? entry.contextBefore ?? ''),
      context_after: String(entry.context_after ?? entry.contextAfter ?? ''),
    };
  });
}

function normalizeExplanation(value) {
  // Accept a plain string as shorthand for { problem: string } so proposers
  // that condense the explanation into a single sentence (observed in both
  // the sonnet and opus bursts) don't silently fail the required-problem
  // check. The model's intent is clear — the string IS the problem statement.
  if (typeof value === 'string') {
    return {
      problem: normalizeText(value),
      whyThisSurface: '',
      invariantsPreserved: [],
      whyThisIsBounded: '',
      residualRisks: [],
    };
  }
  const explanation = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    problem: normalizeText(explanation.problem),
    whyThisSurface: normalizeText(explanation.why_this_surface || explanation.whyThisSurface),
    invariantsPreserved: normalizeStringList(explanation.invariants_preserved || explanation.invariantsPreserved),
    whyThisIsBounded: normalizeText(explanation.why_this_is_bounded || explanation.whyThisIsBounded),
    residualRisks: normalizeStringList(explanation.residual_risks || explanation.residualRisks),
  };
}

function parseProposal(text) {
  const payload = JSON.parse(extractJsonObjectFromText(text, 'Proposal response'));
  const proposal = {
    logicalExplanation: normalizeExplanation(payload.logical_explanation || payload.logicalExplanation),
    codeChanges: normalizePatchList(payload.code_changes || payload.codeChanges || [], 'code_changes'),
    testChanges: normalizePatchList(payload.test_changes || payload.testChanges || [], 'test_changes'),
  };
  if (!proposal.logicalExplanation.problem) {
    throw new AdapterError(
      'PROPOSAL_REQUIRED_FIELD_MISSING',
      'logical_explanation.problem',
      'logical_explanation.problem is required',
      { fixHint: 'Set logical_explanation.problem to a non-empty string describing the root-cause being fixed.' }
    );
  }
  return proposal;
}

function validateProposalOperationLimits(proposal, mode = 'polish') {
  const safeProposal = proposal && typeof proposal === 'object' && !Array.isArray(proposal) ? proposal : {};
  const codeCount = Array.isArray(safeProposal.codeChanges) ? safeProposal.codeChanges.length : 0;
  const testCount = Array.isArray(safeProposal.testChanges) ? safeProposal.testChanges.length : 0;
  const total = codeCount + testCount;

  const limits = {
    polish:  { maxCode: 3, maxTest: 3, maxTotal: 6 },
    build:   { maxCode: 10, maxTest: 10, maxTotal: 20 },
    harden:  { maxCode: 3, maxTest: 3, maxTotal: 6 },
  };

  const modeLimits = limits[mode];
  if (!modeLimits) {
    throw new AdapterError(
      'PROPOSAL_MODE_UNSUPPORTED',
      'mode',
      `Unknown proposal mode: ${mode}`,
      { fixHint: `Supported modes are: ${Object.keys(limits).join(', ')}.` }
    );
  }

  if (codeCount > modeLimits.maxCode) {
    throw new AdapterError(
      'PROPOSAL_OPERATION_LIMIT_EXCEEDED',
      'code_changes',
      `code_changes has ${codeCount} operations, exceeds ${mode} limit of ${modeLimits.maxCode}`,
      { fixHint: `Reduce code_changes to at most ${modeLimits.maxCode} patch blocks in ${mode} mode.` }
    );
  }

  if (testCount > modeLimits.maxTest) {
    throw new AdapterError(
      'PROPOSAL_OPERATION_LIMIT_EXCEEDED',
      'test_changes',
      `test_changes has ${testCount} operations, exceeds ${mode} limit of ${modeLimits.maxTest}`,
      { fixHint: `Reduce test_changes to at most ${modeLimits.maxTest} patch blocks in ${mode} mode.` }
    );
  }

  if (total > modeLimits.maxTotal) {
    throw new AdapterError(
      'PROPOSAL_OPERATION_LIMIT_EXCEEDED',
      'code_changes+test_changes',
      `Total operation count ${total} exceeds ${mode} limit of ${modeLimits.maxTotal}`,
      { fixHint: `Reduce the combined code_changes + test_changes to at most ${modeLimits.maxTotal} patch blocks in ${mode} mode.` }
    );
  }
}

function buildLedgerProposalFallback(report) {
  const safeReport = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  return safeReport.proposal || {
    codeChanges: [],
    testChanges: [],
    logicalExplanation: {
      problem: safeReport.reasonCode || 'no-safe-change',
    },
  };
}

function buildCandidateRejection(reasonCode, nextStep) {
  return {
    ok: false,
    reasonCode,
    nextStep,
  };
}

function checkRepairCompatibility(originalProposal, repairedProposal) {
  const originalPaths = new Set(collectProposalPaths(originalProposal));
  const repairedPaths = new Set(collectProposalPaths(repairedProposal));
  const widenedPaths = Array.from(repairedPaths).filter((entry) => !originalPaths.has(entry));
  if (widenedPaths.length > 0) {
    return {
      ok: false,
      reasonCode: 'repair-scope-widened',
      nextStep: 'Keep repair work on the same files instead of expanding the change.',
      widenedPaths,
    };
  }
  return { ok: true };
}

module.exports = {
  buildCandidateRejection,
  buildLedgerProposalFallback,
  buildRejectionStructuredError,
  buildRejectionSummary,
  buildSurfaceBudget,
  checkRepairCompatibility,
  classifySyntaxFailure,
  collectChangedSymbols,
  collectProposalPaths,
  createPatchFamilyFingerprint,
  createPatchFingerprint,
  normalizeExplanation,
  normalizePatchList,
  normalizeStringList,
  parseProposal,
  proposalHasNoChanges,
  proposalSummary,
  validateProposalOperationLimits,
};
