/**
 * overnight_engine_repair.cjs — repair-loop helpers extracted from overnight_engine.cjs.
 *
 * Handles structured-response loading with automatic repair turns for proposals,
 * planner responses, and arbitrary JSON payloads that may need a second model call
 * to fix malformed output.
 */

const { normalizeText, readTextIfExists, resolveRepoPath } = require('./baton_common.cjs');
const { callModel } = require('./model_router.cjs');

function extractPatchPathFromError(errorMessage) {
  const normalized = normalizeText(errorMessage);
  const match = normalized.match(/ in ([^ ]+\.(?:cjs|mjs|js|ts|tsx|json|md|yaml|yml|toml|txt|ini|rst|adoc))(?=$|[^A-Za-z0-9_/])/i);
  return match ? normalizeText(match[1]) : '';
}

function buildRepairContext(cwd, errorMessage) {
  const failedPath = extractPatchPathFromError(errorMessage);
  if (!failedPath) {
    return null;
  }
  try {
    const resolved = resolveRepoPath(cwd, failedPath);
    const content = readTextIfExists(resolved.absolutePath);
    return {
      failed_path: failedPath,
      file_excerpt: content.length > 2600 ? `${content.slice(0, 2600)}\n...` : content,
    };
  } catch {
    // Best-effort enrichment: if the extracted path escapes the repo root or
    // is otherwise unresolvable, fall back gracefully instead of crashing the
    // repair flow.
    return null;
  }
}

function buildRepairPrompt(prompt, originalText, errorMessage, options = {}) {
  const repairContext = options.cwd ? buildRepairContext(options.cwd, errorMessage) : null;
  // When the caller supplies a structured error (AdapterError fields), surface them
  // as distinct JSON keys so the model can act on them without regexing prose.
  const structuredError = options.structuredError || null;
  const payload = {
    task: 'Repair the previous proposal. Keep the same intent. Only fix JSON shape, SEARCH/REPLACE blocks, or syntax-oriented mistakes.',
    error: errorMessage,
    original_response: originalText,
    repair_context: repairContext,
    patch_rules: [
      'Use the provided current file excerpt when repairing SEARCH or context mismatches.',
      'Prefer stable anchors such as named tests, function declarations, or exact small blocks.',
      'Do not keep version strings or other brittle literals as the main SEARCH anchor when a stronger anchor exists.',
      'Keep matching test_changes whenever you edit a source-code file.',
    ],
    reminder: 'Return JSON only with top-level keys logical_explanation, code_changes, test_changes.',
  };
  if (structuredError) {
    payload.error_code = structuredError.code;
    payload.error_field = structuredError.field;
    payload.fix_hint = structuredError.fix_hint;
  }
  return {
    systemPrompt: prompt.systemPrompt,
    userPrompt: JSON.stringify(payload, null, 2),
  };
}

async function callProposer(prompt, modelConfig, options = {}) {
  if (typeof options.proposalLoader === 'function') {
    return options.proposalLoader({
      prompt,
      requestKind: options.requestKind || 'proposal',
      surface: options.surface,
      objective: options.objective,
      errorMessage: options.errorMessage || null,
      priorText: options.priorText || null,
    });
  }
  const response = await callModel({
    ...modelConfig,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    mode: options.requestKind || 'proposal',
    schema: { type: 'json_object' },
    temperature: modelConfig.temperature === null || modelConfig.temperature === undefined ? 0.2 : modelConfig.temperature,
  });
  return response;
}

async function loadStructuredResponseWithRepair(prompt, modelConfig, repairTurns, parser, repairPromptBuilder, options = {}) {
  let currentPrompt = prompt;
  let turnsUsed = 0;
  let lastText = null;
  const initialRequestKind = options.requestKind || 'proposal';
  const repairRequestKind = options.repairRequestKind || 'repair';
  while (true) {
    const response = await callProposer(currentPrompt, modelConfig, {
      ...options,
      requestKind: turnsUsed === 0 ? initialRequestKind : repairRequestKind,
      errorMessage: options.errorMessage,
      priorText: lastText,
    });
    lastText = response.text;
    try {
      return {
        response,
        parsed: parser(response.text),
        repairTurnsUsed: turnsUsed,
      };
    } catch (error) {
      if (turnsUsed >= repairTurns) {
        error.responseText = response.text;
        throw error;
      }
      currentPrompt = repairPromptBuilder(currentPrompt, response.text, error.message);
      turnsUsed += 1;
    }
  }
}

async function loadProposalWithRepair(prompt, modelConfig, repairTurns, options = {}) {
  const { parseProposal: parse } = require('./overnight_engine_proposal.cjs');
  const loaded = await loadStructuredResponseWithRepair(
    prompt,
    modelConfig,
    repairTurns,
    parse,
    (currentPrompt, originalText, errorMessage) => buildRepairPrompt(currentPrompt, originalText, errorMessage, {
      cwd: options.cwd,
    }),
    options,
  );
  return {
    response: loaded.response,
    proposal: loaded.parsed,
    repairTurnsUsed: loaded.repairTurnsUsed,
  };
}

async function loadPlannerWithRepair(prompt, modelConfig, repairTurns, options = {}) {
  const { parsePlannerResponse: parsePlanner } = require('./overnight_staged.cjs');
  const loaded = await loadStructuredResponseWithRepair(
    prompt,
    modelConfig,
    repairTurns,
    parsePlanner,
    (currentPrompt, originalText, errorMessage) => ({
      systemPrompt: currentPrompt.systemPrompt,
      userPrompt: JSON.stringify({
        task: 'Repair the staged planner response. Keep the same intent. Only fix malformed JSON or missing required planner fields.',
        error: errorMessage,
        original_response: originalText,
        original_user_prompt: currentPrompt.userPrompt,
        reminder: 'Return JSON only with decision, change_summary, source_target, test_target, why_bounded, invariants_preserved, expected_test_kind.',
      }, null, 2),
    }),
    {
      ...options,
      requestKind: options.requestKind || 'planner',
    },
  );
  return {
    response: loaded.response,
    plan: loaded.parsed,
    repairTurnsUsed: loaded.repairTurnsUsed,
  };
}

module.exports = {
  extractPatchPathFromError,
  buildRepairContext,
  buildRepairPrompt,
  callProposer,
  loadStructuredResponseWithRepair,
  loadProposalWithRepair,
  loadPlannerWithRepair,
};
