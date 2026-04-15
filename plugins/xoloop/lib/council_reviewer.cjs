'use strict';

/**
 * council_reviewer.cjs — Council of AI Oracles for reviewing proposed fixes before auto-merge.
 *
 * Exports:
 *   buildReviewPrompt(role, diff, context)   — build a role-specific review prompt
 *   parseReviewVerdict(responseText)          — parse { verdict, confidence, reason } from model text
 *   runCouncilReview(options)                 — run all configured reviewers, aggregate verdicts
 *   aggregateCouncilVerdicts(reviews, council) — pure aggregation: quorum, veto, confidence
 *   shouldAutoMerge(councilResult)            — boolean: all approve + no veto + confidence > 0.7
 */

const { AdapterError } = require('./errors.cjs');
const {
  RUBRIC_DIMENSIONS,
  buildRubricPromptInstructions,
  parseRubricScores,
} = require('./autoresearch_rubric.cjs');
const {
  buildJudgeInputPacket,
  nakedizeCode,
} = require('./autoresearch_naked_ast.cjs');

// ---------------------------------------------------------------------------
// Role definitions
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set(['correctness', 'coverage', 'security', 'performance']);

const ROLE_SYSTEM_PROMPTS = {
  correctness: [
    'You are the Correctness Oracle in the Council of AI Reviewers.',
    'Your mandate: verify that the proposed diff is logically correct, does not introduce regressions,',
    'and that the code behaves as intended under all documented invariants.',
    'Flag any incorrect logic, broken control flow, missing null checks, or semantic errors.',
    'Be conservative — if correctness is uncertain, reject or hold.',
  ].join(' '),

  coverage: [
    'You are the Coverage Oracle in the Council of AI Reviewers.',
    'Your mandate: verify that the proposed diff includes adequate test coverage.',
    'Check that new code paths are exercised by tests, edge cases are handled,',
    'and that removed code does not leave uncovered branches.',
    'If meaningful paths are untested, reject or hold.',
  ].join(' '),

  security: [
    'You are the Security Oracle in the Council of AI Reviewers.',
    'Your mandate: audit the proposed diff for security vulnerabilities.',
    'Look for injection risks, unsafe deserialization, credential exposure, path traversal,',
    'insecure defaults, privilege escalation, or other CWE-class issues.',
    'Any confirmed or likely security issue is grounds for rejection. Err on the side of caution.',
  ].join(' '),

  performance: [
    'You are the Performance Oracle in the Council of AI Reviewers.',
    'Your mandate: identify performance regressions in the proposed diff.',
    'Look for O(n²) or worse complexity where O(n) suffices, unnecessary blocking,',
    'excessive allocations, synchronous I/O in hot paths, or missing caching.',
    'Flag concrete bottlenecks; do not reject speculatively without evidence.',
  ].join(' '),
};

const ROLE_INSTRUCTIONS = {
  correctness: [
    'Review the diff for logical correctness.',
    'Check: control flow, type safety, null/undefined handling, invariant preservation.',
    'Verdict approve if the change is correct. Reject if there is a defect. Hold if uncertain.',
  ].join(' '),

  coverage: [
    'Review the diff for test coverage adequacy.',
    'Check: are new branches covered? Are edge cases tested? Are deletions safe?',
    'Verdict approve if coverage is sufficient. Reject if gaps are significant. Hold if borderline.',
  ].join(' '),

  security: [
    'Review the diff for security issues.',
    'Check: injection, credential handling, input validation, path safety, privilege.',
    'Verdict approve if no issues found. Reject if a vulnerability exists. Hold if you need more context.',
  ].join(' '),

  performance: [
    'Review the diff for performance regressions.',
    'Check: algorithmic complexity, I/O patterns, memory allocation, caching.',
    'Verdict approve if performance is acceptable. Reject if a clear regression exists. Hold if uncertain.',
  ].join(' '),
};

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

/**
 * Build a review prompt for a specific oracle role.
 *
 * @param {string} role — one of: correctness, coverage, security, performance
 * @param {string} diff — the unified diff to review
 * @param {object} context — optional context (e.g. { repoName, objective, priorErrors })
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildReviewPrompt(role, diff, context) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!VALID_ROLES.has(normalizedRole)) {
    throw new AdapterError(
      'COUNCIL_INVALID_ROLE',
      'role',
      `Invalid oracle role: "${role}". Must be one of: ${Array.from(VALID_ROLES).join(', ')}`,
      { fixHint: `Set role to one of: ${Array.from(VALID_ROLES).join(', ')}.` },
    );
  }

  const normalizedDiff = String(diff || '').trim();
  if (!normalizedDiff) {
    throw new AdapterError(
      'COUNCIL_DIFF_REQUIRED',
      'diff',
      'diff is required and must be a non-empty string',
      { fixHint: 'Pass the unified diff of the proposed change as the second argument to buildReviewPrompt.' },
    );
  }

  const safeContext = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const systemPrompt = ROLE_SYSTEM_PROMPTS[normalizedRole];

  const contextSection = Object.keys(safeContext).length > 0
    ? `\n\nContext:\n${JSON.stringify(safeContext, null, 2)}`
    : '';

  const userPrompt = [
    `Role: ${normalizedRole}`,
    '',
    ROLE_INSTRUCTIONS[normalizedRole],
    '',
    'Respond ONLY with valid JSON in this exact shape:',
    '{',
    '  "verdict": "approve" | "reject" | "hold",',
    '  "confidence": <number 0.0–1.0>,',
    '  "reason": "<one-paragraph explanation>"',
    '}',
    '',
    `--- DIFF ---${contextSection}`,
    '',
    normalizedDiff,
  ].join('\n');

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// parseReviewVerdict
// ---------------------------------------------------------------------------

const VERDICT_RE = /"verdict"\s*:\s*"(approve|reject|hold)"/i;
const CONFIDENCE_RE = /"confidence"\s*:\s*([0-9]*\.?[0-9]+)/;
const REASON_RE = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Extract { verdict, confidence, reason } from a model response string.
 * Tolerates leading prose before the JSON object.
 *
 * @param {string} responseText
 * @returns {{ verdict: 'approve'|'reject'|'hold', confidence: number, reason: string }}
 */
function parseReviewVerdict(responseText) {
  const text = String(responseText || '').trim();
  if (!text) {
    throw new AdapterError(
      'COUNCIL_VERDICT_PARSE_FAILED',
      'responseText',
      'Response text is empty — cannot extract verdict',
      { fixHint: 'Ensure the model returns a non-empty JSON object with verdict, confidence, and reason fields.' },
    );
  }

  // Try to extract a JSON object from the text
  let parsed = null;
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    const candidate = text.slice(jsonStart, jsonEnd + 1);
    try {
      parsed = JSON.parse(candidate);
    } catch {
      parsed = null;
    }
  }

  // Fall back to regex extraction when JSON parse fails
  if (!parsed || typeof parsed !== 'object') {
    const verdictMatch = VERDICT_RE.exec(text);
    const confidenceMatch = CONFIDENCE_RE.exec(text);
    const reasonMatch = REASON_RE.exec(text);

    if (!verdictMatch) {
      throw new AdapterError(
        'COUNCIL_VERDICT_PARSE_FAILED',
        'responseText',
        'Could not extract verdict from response — expected JSON with "verdict": "approve"|"reject"|"hold"',
        { fixHint: 'Ensure the model returns valid JSON with a verdict field set to approve, reject, or hold.' },
      );
    }

    parsed = {
      verdict: verdictMatch[1],
      confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
      reason: reasonMatch ? reasonMatch[1] : '',
    };
  }

  const verdict = String(parsed.verdict || '').trim().toLowerCase();
  if (!['approve', 'reject', 'hold'].includes(verdict)) {
    throw new AdapterError(
      'COUNCIL_VERDICT_PARSE_FAILED',
      'responseText',
      `Invalid verdict value: "${parsed.verdict}". Must be approve, reject, or hold`,
      { fixHint: 'Ensure the model returns verdict as one of: approve, reject, hold.' },
    );
  }

  const rawConfidence = parsed.confidence;
  const confidence = Number.isFinite(Number(rawConfidence)) ? Math.min(1, Math.max(0, Number(rawConfidence))) : 0;

  const reason = String(parsed.reason || '').trim();

  return { verdict, confidence, reason };
}

// ---------------------------------------------------------------------------
// aggregateCouncilVerdicts
// ---------------------------------------------------------------------------

/**
 * Pure aggregation of council reviews.
 *
 * Rules:
 *  - All approve → auto-merge candidate
 *  - Any veto-role rejects → hold for human (vetoedBy populated)
 *  - Non-veto role rejects but quorum met → still auto-merge
 *  - Below quorum → hold for human
 *  - Any confidence <= 0.7 → hold for human
 *
 * @param {Array<{ role, verdict, confidence, reason }>} reviews
 * @param {{ quorum: number, vetoRoles: string[] }} council
 * @returns {{ verdict: 'approve'|'hold', reviews, unanimous, vetoedBy: string[]|null }}
 */
function aggregateCouncilVerdicts(reviews, council) {
  const safeReviews = Array.isArray(reviews) ? reviews : [];
  const safeCouncil = council && typeof council === 'object' ? council : {};
  const quorum = Math.max(1, Number.isFinite(Number(safeCouncil.quorum)) ? Number(safeCouncil.quorum) : 1);
  const vetoRoles = new Set(Array.isArray(safeCouncil.vetoRoles) ? safeCouncil.vetoRoles : []);

  const approvals = safeReviews.filter((r) => r && r.verdict === 'approve');
  const rejections = safeReviews.filter((r) => r && r.verdict === 'reject');
  const holds = safeReviews.filter((r) => r && r.verdict === 'hold');

  // Check for veto-role rejections
  const vetoedBy = rejections
    .filter((r) => vetoRoles.has(r.role))
    .map((r) => r.role);

  if (vetoedBy.length > 0) {
    return {
      verdict: 'hold',
      reviews: safeReviews,
      unanimous: false,
      vetoedBy,
    };
  }

  // Check quorum (only counting approvals against required quorum)
  const approveCount = approvals.length;
  if (approveCount < quorum) {
    return {
      verdict: 'hold',
      reviews: safeReviews,
      unanimous: false,
      vetoedBy: null,
    };
  }

  // Check confidence on approvals
  const lowConfidence = approvals.filter((r) => {
    const c = Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 0;
    return c <= 0.7;
  });

  if (lowConfidence.length > 0) {
    return {
      verdict: 'hold',
      reviews: safeReviews,
      unanimous: false,
      vetoedBy: null,
    };
  }

  // All holds with no approvals => hold
  if (approveCount === 0 && (holds.length > 0 || rejections.length > 0)) {
    return {
      verdict: 'hold',
      reviews: safeReviews,
      unanimous: false,
      vetoedBy: null,
    };
  }

  const unanimous = rejections.length === 0 && holds.length === 0;

  return {
    verdict: 'approve',
    reviews: safeReviews,
    unanimous,
    vetoedBy: null,
  };
}

// ---------------------------------------------------------------------------
// shouldAutoMerge
// ---------------------------------------------------------------------------

/**
 * Returns true only when ALL of:
 *  - overall verdict is 'approve'
 *  - no veto was triggered (vetoedBy is null or empty)
 *  - all individual reviewer confidences are > 0.7
 *
 * @param {{ verdict: string, reviews: Array, vetoedBy: string[]|null }} councilResult
 * @returns {boolean}
 */
function shouldAutoMerge(councilResult) {
  if (!councilResult || typeof councilResult !== 'object') {
    return false;
  }
  if (councilResult.verdict !== 'approve') {
    return false;
  }
  if (Array.isArray(councilResult.vetoedBy) && councilResult.vetoedBy.length > 0) {
    return false;
  }
  const reviews = Array.isArray(councilResult.reviews) ? councilResult.reviews : [];
  for (const review of reviews) {
    const c = Number.isFinite(Number(review && review.confidence)) ? Number(review.confidence) : 0;
    if (c <= 0.7) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// runCouncilReview
// ---------------------------------------------------------------------------

/**
 * Run all configured reviewers in sequence and aggregate verdicts.
 *
 * @param {{
 *   diff: string,
 *   context: object,
 *   council: { quorum: number, vetoRoles: string[], reviewers: Array<{ role: string, model: string }> },
 *   modelCaller: async (options: { role, model, systemPrompt, userPrompt }) => { text: string }
 * }} options
 * @returns {Promise<{ verdict: string, reviews: Array, unanimous: boolean, vetoedBy: string[]|null }>}
 */
async function runCouncilReview(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AdapterError(
      'COUNCIL_INVALID_OPTIONS',
      'options',
      'runCouncilReview requires a non-null options object',
      { fixHint: 'Pass an options object with at least diff, council, and modelCaller fields.' },
    );
  }

  const diff = String(options.diff || '').trim();
  if (!diff) {
    throw new AdapterError(
      'COUNCIL_DIFF_REQUIRED',
      'options.diff',
      'options.diff is required and must be a non-empty string',
      { fixHint: 'Set options.diff to the unified diff of the proposed change.' },
    );
  }

  const context = options.context && typeof options.context === 'object' ? options.context : {};
  const council = options.council && typeof options.council === 'object' ? options.council : {};
  const reviewers = Array.isArray(council.reviewers) ? council.reviewers : [];
  const modelCaller = typeof options.modelCaller === 'function' ? options.modelCaller : null;

  const reviews = [];

  for (const reviewer of reviewers) {
    const role = String(reviewer && reviewer.role ? reviewer.role : '').trim().toLowerCase();
    const model = String(reviewer && reviewer.model ? reviewer.model : '').trim();

    let prompts;
    try {
      prompts = buildReviewPrompt(role, diff, context);
    } catch (promptErr) {
      throw new AdapterError(
        'COUNCIL_REVIEW_FAILED',
        `reviewer.${role}`,
        `Failed to build prompt for role "${role}": ${promptErr && promptErr.message ? promptErr.message : String(promptErr)}`,
        { fixHint: `Ensure role "${role}" is valid and diff is non-empty.`, cause: promptErr },
      );
    }

    let responseText;
    try {
      const callerFn = modelCaller;
      if (typeof callerFn !== 'function') {
        throw new AdapterError(
          'COUNCIL_REVIEW_FAILED',
          'options.modelCaller',
          'modelCaller must be a function',
          { fixHint: 'Provide options.modelCaller as an async function that calls the model.' },
        );
      }
      const response = await callerFn({
        role,
        model,
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
      });
      responseText = response && typeof response.text === 'string' ? response.text : String(response || '');
    } catch (callErr) {
      if (callErr && callErr.code && callErr.code.startsWith('COUNCIL_')) {
        throw callErr;
      }
      throw new AdapterError(
        'COUNCIL_REVIEW_FAILED',
        `reviewer.${role}`,
        `Model call failed for role "${role}": ${callErr && callErr.message ? callErr.message : String(callErr)}`,
        { fixHint: `Check that modelCaller can handle role "${role}" with model "${model}".`, cause: callErr },
      );
    }

    let verdict;
    try {
      verdict = parseReviewVerdict(responseText);
    } catch (parseErr) {
      throw new AdapterError(
        'COUNCIL_VERDICT_PARSE_FAILED',
        `reviewer.${role}`,
        `Failed to parse verdict for role "${role}": ${parseErr && parseErr.message ? parseErr.message : String(parseErr)}`,
        { fixHint: `Ensure the model returns valid JSON with verdict, confidence, and reason for role "${role}".`, cause: parseErr },
      );
    }

    reviews.push({
      role,
      model,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reason: verdict.reason,
    });
  }

  return {
    ...aggregateCouncilVerdicts(reviews, council),
    reviews,
  };
}

// ---------------------------------------------------------------------------
// AutoReason rubric path — alternative to verdict-based review per SPEC v2
// ---------------------------------------------------------------------------

const RUBRIC_PERSONA_PROMPTS = {
  architect: 'You are an architect oracle. Weigh structural patterns and codebase-scale clarity.',
  pragmatist: 'You are a pragmatist oracle. Weigh simplicity and operational cost above elegance.',
  hacker: 'You are a hacker oracle. Weigh brevity, runtime behavior, and whether the change actually works.',
};

function buildRubricReviewPrompt(persona, codeChange, context) {
  const personaKey = String(persona || '').trim().toLowerCase();
  if (!RUBRIC_PERSONA_PROMPTS[personaKey]) {
    throw new AdapterError(
      'COUNCIL_RUBRIC_PERSONA_INVALID',
      'persona',
      `Unknown rubric persona: "${persona}". Must be one of: ${Object.keys(RUBRIC_PERSONA_PROMPTS).join(', ')}`,
      { fixHint: `Set persona to architect, pragmatist, or hacker.` },
    );
  }
  if (codeChange === null || codeChange === undefined) {
    throw new AdapterError(
      'COUNCIL_RUBRIC_CODE_REQUIRED',
      'codeChange',
      'buildRubricReviewPrompt requires a codeChange string or proposal object',
      { fixHint: 'Pass either the naked code as a string or a proposal object whose changeSet should be nakedized.' },
    );
  }
  const naked = typeof codeChange === 'string'
    ? nakedizeCode(codeChange)
    : buildJudgeInputPacket(codeChange).naked;
  const safeContext = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const contextSection = Object.keys(safeContext).length > 0
    ? `\n\nContext:\n${JSON.stringify(safeContext, null, 2)}`
    : '';
  const systemPrompt = [
    'You are one judge on the AutoReason council.',
    RUBRIC_PERSONA_PROMPTS[personaKey],
    'Score the candidate on the 1-5 anchored rubric — never invent dimensions.',
    'Do NOT score correctness; the objective gate already proved this candidate passes tests.',
    'Return JSON only.',
  ].join(' ');
  const userPrompt = [
    buildRubricPromptInstructions(),
    '',
    'Candidate (naked AST — comments and prose stripped):',
    typeof naked === 'string' ? naked : JSON.stringify(naked, null, 2),
    contextSection,
  ].filter(Boolean).join('\n');
  return { systemPrompt, userPrompt };
}

function parseRubricReview(responseText) {
  return parseRubricScores(responseText);
}

function rubricDimensions() {
  return RUBRIC_DIMENSIONS.slice();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  RUBRIC_PERSONA_PROMPTS,
  aggregateCouncilVerdicts,
  buildReviewPrompt,
  buildRubricReviewPrompt,
  parseReviewVerdict,
  parseRubricReview,
  rubricDimensions,
  runCouncilReview,
  shouldAutoMerge,
};
