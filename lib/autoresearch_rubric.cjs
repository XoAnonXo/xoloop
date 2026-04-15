'use strict';

/**
 * autoresearch_rubric.cjs — 1-5 anchored rubric for AutoReason subjective judging.
 *
 * Per AutoReason SPEC v2 (docs/ORACLE_QUESTION_AUTORESEARCH_SUBJECTIVE_BENCHMARKS.md):
 *
 *   - Scale: 1-5 anchored (paper-accurate, avoids pointwise tie collapse)
 *   - Dimensions: simplicity, cost, maintainability, readability
 *   - Correctness is NOT a judge dimension — objective gate handles it
 *   - Simplicity uses a NEGATIVE rubric (start at 5, deduct for bloat)
 *   - Readability is scored on the naked AST (comments/prose stripped)
 */

const { AdapterError } = require('./errors.cjs');
const { extractJsonObjectFromText, normalizeText } = require('./baton_common.cjs');

const RUBRIC_DIMENSIONS = Object.freeze(['simplicity', 'cost', 'maintainability', 'readability']);

const RUBRIC_WEIGHTS = Object.freeze({
  simplicity: 0.30,
  cost: 0.30,
  maintainability: 0.25,
  readability: 0.15,
});

const RUBRIC_ANCHORS = Object.freeze({
  simplicity: Object.freeze({
    1: 'unacceptable — deep nested abstractions, ceremonial bloat, many new dependencies',
    2: 'weak — unnecessary layering, one or more gratuitous abstractions',
    3: 'acceptable — no bloat added but no reduction either',
    4: 'strong — reduces abstraction count or dependency count versus champion',
    5: 'exemplary — fewer dependencies AND fewer abstraction layers AND lower cyclomatic complexity than champion',
  }),
  cost: Object.freeze({
    1: 'unacceptable — significantly higher API $, compute, or memory than champion',
    2: 'weak — marginally higher cost without compensating benefit',
    3: 'acceptable — cost parity with champion',
    4: 'strong — measurably cheaper than champion on one cost axis',
    5: 'exemplary — cheaper on multiple cost axes with no regressions',
  }),
  maintainability: Object.freeze({
    1: 'unacceptable — would require specialist knowledge to safely modify in 6 months',
    2: 'weak — modification requires reading unrelated modules to understand intent',
    3: 'acceptable — a competent engineer could modify this in 6 months without surprises',
    4: 'strong — intent is self-evident from naming and structure',
    5: 'exemplary — obviously correct on first read, zero hidden coupling',
  }),
  readability: Object.freeze({
    1: 'unacceptable — unclear naming, tangled control flow, impossible to trace without a debugger',
    2: 'weak — requires effort to follow on first read',
    3: 'acceptable — readable with normal attention',
    4: 'strong — flows naturally, good naming, obvious structure',
    5: 'exemplary — reads like prose; could be reviewed by a non-author in under 30 seconds',
  }),
});

const DEFAULT_CONTESTED_SPREAD = 2;
const DEFAULT_ABSOLUTE_VETO_SCORE = 1;

function buildRubricPromptInstructions() {
  const anchorLines = RUBRIC_DIMENSIONS.map((dim) => {
    const anchors = RUBRIC_ANCHORS[dim];
    const bullets = [5, 4, 3, 2, 1].map((score) => `      ${score} = ${anchors[score]}`).join('\n');
    return `  ${dim}:\n${bullets}`;
  }).join('\n');
  return [
    'Score the proposal on the four AutoReason dimensions using the 1-5 anchored rubric below.',
    'Do NOT score correctness — the objective gate handles that before you see anything.',
    'Simplicity uses a NEGATIVE rubric: start at 5 and deduct for new deps / new abstraction layers / cyclomatic increase.',
    'Return JSON only with keys: simplicity, cost, maintainability, readability, rationale.',
    'Each score is an integer 1-5. Rationale is a short sentence citing concrete code evidence.',
    '',
    'Anchors:',
    anchorLines,
  ].join('\n');
}

function assertScoreShape(raw, dimension) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new AdapterError(
      'RUBRIC_SCORE_OUT_OF_RANGE',
      dimension,
      `Rubric score for ${dimension} must be an integer 1-5, got ${raw}`,
      { fixHint: 'Return an integer between 1 and 5 inclusive for every rubric dimension.' },
    );
  }
  return value;
}

function parseRubricScores(text) {
  const json = JSON.parse(extractJsonObjectFromText(text, 'Rubric response'));
  const scores = {};
  for (const dimension of RUBRIC_DIMENSIONS) {
    scores[dimension] = assertScoreShape(json[dimension], dimension);
  }
  return {
    scores,
    rationale: normalizeText(json.rationale),
    judgeId: normalizeText(json.judgeId) || null,
  };
}

function computeComposite(scores) {
  if (!scores || typeof scores !== 'object') {
    throw new AdapterError(
      'RUBRIC_SCORES_REQUIRED',
      'scores',
      'computeComposite requires a scores object',
      { fixHint: 'Pass a scores object with all four rubric dimensions.' },
    );
  }
  let total = 0;
  for (const dimension of RUBRIC_DIMENSIONS) {
    const value = assertScoreShape(scores[dimension], dimension);
    total += value * RUBRIC_WEIGHTS[dimension];
  }
  return Number(total.toFixed(3));
}

function aggregateBallots(ballots) {
  if (!Array.isArray(ballots) || ballots.length === 0) {
    throw new AdapterError(
      'RUBRIC_BALLOTS_REQUIRED',
      'ballots',
      'aggregateBallots requires a non-empty array of ballot objects',
      { fixHint: 'Pass at least one ballot with a scores object.' },
    );
  }
  const perDimension = {};
  for (const dimension of RUBRIC_DIMENSIONS) {
    const values = ballots.map((b) => assertScoreShape((b.scores || {})[dimension], dimension));
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);
    perDimension[dimension] = {
      mean: Number(mean.toFixed(3)),
      max,
      min,
      spread: max - min,
      values,
    };
  }
  const composites = ballots.map((b) => computeComposite(b.scores));
  const compositeMean = composites.reduce((sum, v) => sum + v, 0) / composites.length;
  const maxCompositeSpread = Math.max(...composites) - Math.min(...composites);
  return {
    ballotCount: ballots.length,
    perDimension,
    composite: {
      values: composites,
      mean: Number(compositeMean.toFixed(3)),
      max: Math.max(...composites),
      min: Math.min(...composites),
      spread: Number(maxCompositeSpread.toFixed(3)),
    },
  };
}

function isContested(ballots, threshold = DEFAULT_CONTESTED_SPREAD) {
  const aggregate = aggregateBallots(ballots);
  for (const dimension of RUBRIC_DIMENSIONS) {
    if (aggregate.perDimension[dimension].spread > threshold) {
      return true;
    }
  }
  return false;
}

function hasAbsoluteVeto(ballots, vetoScore = DEFAULT_ABSOLUTE_VETO_SCORE) {
  if (!Array.isArray(ballots)) {
    return false;
  }
  for (const ballot of ballots) {
    const scores = (ballot && ballot.scores) || {};
    for (const dimension of RUBRIC_DIMENSIONS) {
      if (scores[dimension] === vetoScore) {
        return true;
      }
    }
  }
  return false;
}

module.exports = {
  RUBRIC_DIMENSIONS,
  RUBRIC_WEIGHTS,
  RUBRIC_ANCHORS,
  DEFAULT_CONTESTED_SPREAD,
  DEFAULT_ABSOLUTE_VETO_SCORE,
  aggregateBallots,
  buildRubricPromptInstructions,
  computeComposite,
  hasAbsoluteVeto,
  isContested,
  parseRubricScores,
};
