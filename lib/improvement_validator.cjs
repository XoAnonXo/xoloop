'use strict';

const { AdapterError } = require('./errors.cjs');

/**
 * Compare champion vs challenger run results and produce a verdict.
 *
 * @param {{ output: *, metrics: object }} champion
 * @param {{ output: *, metrics: object }} challenger
 * @param {{ max_regression_per_metric?: number }} constraints
 * @returns {{ verdict: 'IMPROVEMENT'|'NEUTRAL'|'REGRESSION', reason: string, delta: object }}
 */
function validateImprovement(champion, challenger, constraints) {
  if (champion == null || typeof champion !== 'object') {
    throw new AdapterError(
      'VALIDATE_INPUT_REQUIRED',
      'champion',
      'champion must be a non-null object with output and metrics fields',
      { fixHint: 'Pass a valid champion object: { output, metrics }.' },
    );
  }
  if (challenger == null || typeof challenger !== 'object') {
    throw new AdapterError(
      'VALIDATE_INPUT_REQUIRED',
      'challenger',
      'challenger must be a non-null object with output and metrics fields',
      { fixHint: 'Pass a valid challenger object: { output, metrics }.' },
    );
  }
  const maxRegression = (constraints && constraints.max_regression_per_metric) ?? 0.2;

  // -----------------------------------------------------------------------
  // Step 1: Compare outputs — deep equality via JSON serialization
  // -----------------------------------------------------------------------
  const champOutput = JSON.stringify(champion.output);
  const challOutput = JSON.stringify(challenger.output);

  if (champOutput !== challOutput) {
    return {
      verdict: 'REGRESSION',
      reason: 'Output differs between champion and challenger',
      delta: computeDelta(champion.metrics, challenger.metrics),
    };
  }

  // -----------------------------------------------------------------------
  // Step 2: Compare metrics
  // -----------------------------------------------------------------------
  const champMetrics = champion.metrics || {};
  const challMetrics = challenger.metrics || {};
  const delta = computeDelta(champMetrics, challMetrics);

  // Check if any metric regressed beyond the allowed threshold
  const metricKeys = new Set([
    ...Object.keys(champMetrics),
    ...Object.keys(challMetrics),
  ]);

  let anyImproved = false;
  let anyRegressed = false;
  let allIdentical = true;

  for (const key of metricKeys) {
    const champVal = champMetrics[key];
    const challVal = challMetrics[key];

    if (champVal === undefined || challVal === undefined) continue;
    if (champVal === 0 && challVal === 0) continue;

    if (champVal !== challVal) {
      allIdentical = false;
    }

    // For resource metrics, lower is better (minimize direction)
    if (challVal < champVal) {
      anyImproved = true;
    } else if (challVal > champVal) {
      // Check if the regression exceeds the allowed threshold
      const regressionFraction = champVal > 0
        ? (challVal - champVal) / champVal
        : Infinity;

      if (regressionFraction > maxRegression) {
        anyRegressed = true;
      }
    }
  }

  if (allIdentical) {
    return {
      verdict: 'NEUTRAL',
      reason: 'Metrics are identical between champion and challenger',
      delta,
    };
  }

  if (anyRegressed) {
    return {
      verdict: 'REGRESSION',
      reason: 'Challenger exceeds resource regression bounds on one or more metrics',
      delta,
    };
  }

  if (anyImproved) {
    return {
      verdict: 'IMPROVEMENT',
      reason: 'Challenger has lower resource usage with identical output',
      delta,
    };
  }

  return {
    verdict: 'NEUTRAL',
    reason: 'No significant metric changes detected',
    delta,
  };
}

/**
 * Compute per-metric delta object.
 */
function computeDelta(champMetrics, challMetrics) {
  const champ = champMetrics || {};
  const chall = challMetrics || {};
  const delta = {};
  const keys = new Set([
    ...Object.keys(champ),
    ...Object.keys(chall),
  ]);

  for (const key of keys) {
    const champVal = champ[key] ?? 0;
    const challVal = chall[key] ?? 0;
    delta[key] = {
      champion: champVal,
      challenger: challVal,
      diff: challVal - champVal,
      fraction: champVal !== 0 ? (challVal - champVal) / champVal : 0,
    };
  }

  return delta;
}

/**
 * Compute a weighted ranking score based on optimization targets.
 *
 * Each target has { metric, direction, weight }. For 'minimize' direction,
 * improvement = (champion - challenger) / champion. Score is the weighted
 * sum of improvements. Positive score = challenger is better overall.
 *
 * @param {object} champion - Champion metrics (e.g. { token_count: 100 })
 * @param {object} challenger - Challenger metrics
 * @param {Array<{ metric: string, direction: string, weight: number }>} targets
 * @returns {number}
 */
function computeRankingScore(champion, challenger, targets) {
  if (!Array.isArray(targets)) {
    throw new AdapterError(
      'RANKING_TARGETS_REQUIRED',
      'targets',
      'targets must be a non-null array of { metric, direction, weight } objects',
      { fixHint: 'Pass an array of optimization targets, e.g. [{ metric: "token_count", direction: "minimize", weight: 1 }].' },
    );
  }
  if (champion == null || typeof champion !== 'object') {
    throw new AdapterError(
      'RANKING_INPUT_REQUIRED',
      'champion',
      'champion must be a non-null object with metric fields',
      { fixHint: 'Pass a valid champion metrics object, e.g. { token_count: 100 }.' },
    );
  }
  if (challenger == null || typeof challenger !== 'object') {
    throw new AdapterError(
      'RANKING_INPUT_REQUIRED',
      'challenger',
      'challenger must be a non-null object with metric fields',
      { fixHint: 'Pass a valid challenger metrics object, e.g. { token_count: 50 }.' },
    );
  }
  let score = 0;

  for (const target of targets) {
    if (target == null) continue;
    const champVal = champion[target.metric];
    const challVal = challenger[target.metric];

    if (champVal === undefined || challVal === undefined || champVal === 0) {
      continue;
    }

    let improvementFraction;
    if (target.direction === 'minimize') {
      // For minimize: improvement = (champion - challenger) / champion
      // Positive when challenger is lower (better)
      improvementFraction = (champVal - challVal) / champVal;
    } else {
      // For maximize: improvement = (challenger - champion) / champion
      improvementFraction = (challVal - champVal) / champVal;
    }

    score += target.weight * improvementFraction;
  }

  return score;
}

/**
 * Determine whether the improvement across multiple runs is statistically
 * significant using median comparison.
 *
 * @param {Array<{ champion: object, challenger: object }>} runs
 * @param {{ threshold?: number }} options
 * @returns {boolean}
 */
function isStatisticallySignificant(runs, options) {
  const threshold = (options && options.threshold) ?? 0.05;

  if (!Array.isArray(runs) || runs.length === 0) {
    return false;
  }

  // Collect improvement fractions for each metric across runs
  // Find all metric keys from the first run
  const sampleChamp = runs[0] && runs[0].champion;
  if (sampleChamp == null || typeof sampleChamp !== 'object') {
    return false;
  }
  const metricKeys = Object.keys(sampleChamp);

  for (const key of metricKeys) {
    const fractions = [];

    for (const run of runs) {
      const champVal = run.champion[key];
      const challVal = run.challenger[key];

      if (champVal === undefined || challVal === undefined || champVal === 0) {
        continue;
      }

      // Improvement fraction (higher is better for the challenger)
      const improvementFraction = (champVal - challVal) / champVal;
      fractions.push(improvementFraction);
    }

    if (fractions.length === 0) continue;

    // Compute median
    const sorted = fractions.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    if (median > threshold) {
      return true;
    }
  }

  return false;
}

module.exports = {
  validateImprovement,
  computeRankingScore,
  isStatisticallySignificant,
};
