'use strict';

/**
 * autoresearch_council_caller.cjs — Production wiring for the AutoReason
 * Champion vs Challenger council.
 *
 * Maps the three heterogeneous judge personas (architect / pragmatist / hacker)
 * onto concrete model backends and produces ballots in the shape
 * autoresearch_tournament.runRound expects.
 *
 * Persona → model mapping (per session decision):
 *   architect  → Claude Opus  (anthropic provider via model_router)
 *   pragmatist → Claude Sonnet (anthropic provider via model_router)
 *   hacker     → Codex GPT 5.4 X High (codex CLI via codex_integration)
 *
 * Tests inject options.callerOverrides to bypass real model calls.
 */

const { callModel } = require('./model_router.cjs');
const {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  JUDGE_ROLES,
} = require('./autoresearch_tournament.cjs');
const {
  buildRubricPromptInstructions,
  parseRubricScores,
} = require('./autoresearch_rubric.cjs');
const {
  isCodexAvailable,
  runCodexReview,
} = require('./codex_integration.cjs');
const { extractJsonObjectFromText } = require('./baton_common.cjs');
const { AdapterError } = require('./errors.cjs');

const PERSONA_TO_BACKEND = Object.freeze({
  architect: Object.freeze({
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    label: 'Claude Opus',
  }),
  pragmatist: Object.freeze({
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    label: 'Claude Sonnet',
  }),
  hacker: Object.freeze({
    provider: 'codex',
    model: 'gpt-5.4-x-high',
    label: 'Codex GPT 5.4 X High',
  }),
});

const DEFAULT_TIMEOUT_MS = 180000;

function findRole(persona) {
  const role = JUDGE_ROLES.find((entry) => entry.id === persona);
  if (!role) {
    throw new AdapterError(
      'COUNCIL_CALLER_PERSONA_UNKNOWN',
      'persona',
      `Unknown council persona: ${persona}. Must be one of: ${JUDGE_ROLES.map((r) => r.id).join(', ')}`,
      { fixHint: 'Pass a persona that matches one of the JUDGE_ROLES exported by autoresearch_tournament.cjs.' },
    );
  }
  return role;
}

function parseJudgeBallot(text, persona) {
  const json = JSON.parse(extractJsonObjectFromText(text, `${persona} ballot`));
  if (!json || typeof json !== 'object' || !json.candidateA || !json.candidateB) {
    throw new AdapterError(
      'COUNCIL_CALLER_BALLOT_INVALID',
      'ballot',
      `${persona} ballot must contain candidateA and candidateB objects`,
      { fixHint: 'Return JSON with both candidateA and candidateB scored on the four rubric dimensions.' },
    );
  }
  const scoresA = parseRubricScores(JSON.stringify(json.candidateA)).scores;
  const scoresB = parseRubricScores(JSON.stringify(json.candidateB)).scores;
  return {
    candidateA: { scores: scoresA, rationale: String(json.candidateA.rationale || '') },
    candidateB: { scores: scoresB, rationale: String(json.candidateB.rationale || '') },
    persona,
  };
}

async function callAnthropicJudge({ persona, role, systemPrompt, userPrompt, modelOptions }) {
  const backend = PERSONA_TO_BACKEND[persona];
  const response = await callModel({
    provider: backend.provider,
    model: backend.model,
    systemPrompt,
    userPrompt,
    timeoutMs: (modelOptions && modelOptions.timeoutMs) || DEFAULT_TIMEOUT_MS,
    temperature: (modelOptions && modelOptions.temperature) !== undefined
      ? modelOptions.temperature
      : 0.0,
    schema: { type: 'json_object' },
    mode: 'proposal',
  });
  return parseJudgeBallot(response.text, persona);
}

function callCodexJudge(options) {
  const safe = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const { persona, systemPrompt, userPrompt, codexOptions } = safe;
  if (!persona || !systemPrompt || !userPrompt) {
    throw new AdapterError(
      'COUNCIL_CALLER_CODEX_OPTIONS_REQUIRED',
      'options',
      'callCodexJudge requires options with persona, systemPrompt, and userPrompt fields',
      { fixHint: 'Pass an options object with all four fields populated; defaults are not assumed.' },
    );
  }
  if (!isCodexAvailable()) {
    throw new AdapterError(
      'COUNCIL_CALLER_CODEX_UNAVAILABLE',
      'codex',
      'Codex CLI is not installed on PATH; cannot run hacker judge',
      { fixHint: 'Install the codex CLI or override the hacker persona to a different backend.' },
    );
  }
  const result = runCodexReview({
    diff: userPrompt,
    instructions: systemPrompt,
    timeout: (codexOptions && codexOptions.timeout) || DEFAULT_TIMEOUT_MS,
    cwd: codexOptions && codexOptions.cwd,
  });
  if (!result.available || result.exitCode !== 0) {
    throw new AdapterError(
      'COUNCIL_CALLER_CODEX_FAILED',
      'codex',
      `Codex review exited non-zero or unavailable: ${(result && result.stderr) || 'no stderr'}`,
      { fixHint: 'Verify codex CLI is installed and inspect the stderr from the runCodexReview result.' },
    );
  }
  return parseJudgeBallot(result.stdout || '', persona);
}

async function callOneJudge(options = {}) {
  const { persona, candidateA, candidateB } = options;
  const role = findRole(persona);
  if (!candidateA || !candidateB) {
    throw new AdapterError(
      'COUNCIL_CALLER_CANDIDATES_REQUIRED',
      'candidateA/candidateB',
      'callOneJudge requires both candidateA and candidateB',
      { fixHint: 'Pass both proposals as candidateA (champion) and candidateB (challenger).' },
    );
  }
  const callerOverride = options.callerOverrides && options.callerOverrides[persona];
  if (typeof callerOverride === 'function') {
    return callerOverride({ persona, role, candidateA, candidateB });
  }
  const systemPrompt = buildJudgeSystemPrompt(role);
  const userPrompt = buildJudgeUserPrompt(
    candidateA,
    candidateB,
    buildRubricPromptInstructions(),
  );
  const backend = PERSONA_TO_BACKEND[persona];
  if (backend.provider === 'anthropic') {
    return callAnthropicJudge({
      persona,
      role,
      systemPrompt,
      userPrompt,
      modelOptions: options.modelOptions,
    });
  }
  if (backend.provider === 'codex') {
    return callCodexJudge({
      persona,
      systemPrompt,
      userPrompt,
      codexOptions: options.codexOptions,
    });
  }
  throw new AdapterError(
    'COUNCIL_CALLER_BACKEND_UNKNOWN',
    'persona',
    `No backend wired for persona ${persona} with provider ${backend.provider}`,
    { fixHint: 'Update PERSONA_TO_BACKEND to map the persona to a known provider.' },
  );
}

async function callCouncil(options = {}) {
  const personas = Array.isArray(options.personas) && options.personas.length > 0
    ? options.personas
    : JUDGE_ROLES.map((role) => role.id);
  const ballots = await Promise.all(personas.map((persona) => callOneJudge({
    persona,
    candidateA: options.candidateA,
    candidateB: options.candidateB,
    modelOptions: options.modelOptions,
    codexOptions: options.codexOptions,
    callerOverrides: options.callerOverrides,
  })));
  return ballots;
}

function buildCallJudgeForRound(options = {}) {
  return async ({ role, candidateA, candidateB }) => callOneJudge({
    persona: role && role.id,
    candidateA,
    candidateB,
    modelOptions: options.modelOptions,
    codexOptions: options.codexOptions,
    callerOverrides: options.callerOverrides,
  });
}

module.exports = {
  PERSONA_TO_BACKEND,
  buildCallJudgeForRound,
  callCodexJudge,
  callCouncil,
  callAnthropicJudge,
  callOneJudge,
  parseJudgeBallot,
};
