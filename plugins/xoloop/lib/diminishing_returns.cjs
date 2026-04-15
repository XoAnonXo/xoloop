'use strict';

const { AdapterError } = require('./errors.cjs');

/**
 * diminishing_returns.cjs — Diminishing Returns Detector for the POLISH loop.
 *
 * Advisory module: pure functions, no side effects.
 * The caller is responsible for logging the signal (e.g. via appendOvernightEvent).
 *
 * See ARCHITECTURE.md §6.9 for design rationale.
 */

const LAST_N_ROUNDS = 5;
const AVG_LANDED_THRESHOLD = 1.0;
const FRESH_CANDIDATES_THRESHOLD = 10;
const ACTIVE_SURFACE_MIN_FRESH = 5;

/**
 * Compute average landed commits over the last N rounds from roundHistory.
 * Returns 0 when roundHistory is empty.
 *
 * @param {Array<{roundNumber: number, landed: number, attempted: number, timestamp?: string}>} roundHistory
 * @returns {number}
 */
function computeAvgLanded(roundHistory) {
  if (!Array.isArray(roundHistory) || roundHistory.length === 0) {
    return 0;
  }
  const lastN = roundHistory.slice(-LAST_N_ROUNDS);
  const total = lastN.reduce((sum, r) => sum + (r != null ? (Number(r.landed) || 0) : 0), 0);
  return total / lastN.length;
}

/**
 * Count how many consecutive rounds at the tail of roundHistory had 0 landings
 * (stopping at the first round that did land something).
 *
 * @param {Array<{landed: number}>} roundHistory
 * @returns {number}
 */
function computeRoundsSinceLastLanding(roundHistory) {
  if (!Array.isArray(roundHistory) || roundHistory.length === 0) {
    return 0;
  }
  let count = 0;
  for (let i = roundHistory.length - 1; i >= 0; i--) {
    const entry = roundHistory[i];
    if (entry != null && (Number(entry.landed) || 0) > 0) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * Aggregate surface stats into total fresh and total candidates.
 *
 * @param {Array<{surfaceId: string, freshCandidates: number, totalCandidates: number}>} surfaceStats
 * @returns {{ fresh: number, total: number }}
 */
function aggregateSurfaceStats(surfaceStats) {
  if (!Array.isArray(surfaceStats) || surfaceStats.length === 0) {
    return { fresh: 0, total: 0 };
  }
  let fresh = 0;
  let total = 0;
  for (const s of surfaceStats) {
    if (s == null) continue;
    fresh += Number(s.freshCandidates) || 0;
    total += Number(s.totalCandidates) || 0;
  }
  return { fresh, total };
}

/**
 * Build the recommendation string based on saturation state.
 *
 * @param {boolean} saturated
 * @param {boolean} declining  — avg < threshold but fresh >= threshold
 * @param {number} avg
 * @param {number} fresh
 * @returns {string}
 */
function buildRecommendation(saturated, declining, avg, fresh) {
  if (typeof avg !== 'number' || !isFinite(avg)) {
    throw new AdapterError(
      'INVALID_ARGUMENT',
      'avg',
      `buildRecommendation: expected avg to be a finite number but received ${avg === null ? 'null' : typeof avg}`,
      { fixHint: 'Pass the numeric avgLandedPerRound value from computeAvgLanded.' },
    );
  }
  const avgStr = avg.toFixed(2);
  if (saturated) {
    return `POLISH_SATURATED: avg ${avgStr} landed/round, ${fresh} fresh candidates remaining. Consider switching to BUILD mode or stopping.`;
  }
  if (declining) {
    return `POLISH_DECLINING: avg ${avgStr} landed/round but ${fresh} fresh candidates remain. Continuing.`;
  }
  return `POLISH_HEALTHY: avg ${avgStr} landed/round, ${fresh} fresh candidates.`;
}

/**
 * detectDiminishingReturns — analyze round history and surface candidate counts.
 *
 * Saturation conditions (BOTH must be true):
 *   - avgLandedPerRound < 1.0 over the last 5 rounds
 *   - freshCandidatesRemaining < 10 across all surfaces
 *
 * @param {Array<{roundNumber: number, landed: number, attempted: number, timestamp?: string}>} roundHistory
 * @param {Array<{surfaceId: string, freshCandidates: number, totalCandidates: number}>} surfaceStats
 * @returns {{
 *   saturated: boolean,
 *   signal: {
 *     avgLandedPerRound: number,
 *     freshCandidatesRemaining: number,
 *     totalCandidatesRemaining: number,
 *     roundsSinceLastLanding: number,
 *     saturationRatio: number,
 *   },
 *   recommendation: string,
 * }}
 */
function detectDiminishingReturns(roundHistory, surfaceStats) {
  const safeHistory = Array.isArray(roundHistory) ? roundHistory : [];
  const safeStats = Array.isArray(surfaceStats) ? surfaceStats : [];

  const avgLandedPerRound = computeAvgLanded(safeHistory);
  const { fresh, total } = aggregateSurfaceStats(safeStats);
  const roundsSinceLastLanding = computeRoundsSinceLastLanding(safeHistory);
  const saturationRatio = total > 0 ? (total - fresh) / total : 0;

  const avgBelowThreshold = avgLandedPerRound < AVG_LANDED_THRESHOLD;
  const freshBelowThreshold = fresh < FRESH_CANDIDATES_THRESHOLD;
  const saturated = avgBelowThreshold && freshBelowThreshold;
  const declining = avgBelowThreshold && !freshBelowThreshold;

  const signal = {
    avgLandedPerRound,
    freshCandidatesRemaining: fresh,
    totalCandidatesRemaining: total,
    roundsSinceLastLanding,
    saturationRatio,
  };

  const recommendation = buildRecommendation(saturated, declining, avgLandedPerRound, fresh);

  return { saturated, signal, recommendation };
}

/**
 * buildSaturationReport — build a detailed report object.
 *
 * @param {Array<{roundNumber: number, landed: number, attempted: number, timestamp?: string}>} roundHistory
 * @param {Array<{surfaceId: string, freshCandidates: number, totalCandidates: number}>} surfaceStats
 * @returns {{
 *   signal: object,
 *   perSurface: Array<{surfaceId: string, freshCandidates: number, totalCandidates: number, exploredRatio: number}>,
 *   roundTrend: Array<{roundNumber: number, landed: number, attempted: number, conversionRate: number}>,
 *   exhaustedSurfaces: string[],
 *   activeSurfaces: string[],
 * }}
 */
function buildSaturationReport(roundHistory, surfaceStats) {
  const { signal } = detectDiminishingReturns(roundHistory, surfaceStats);

  const safeStats = Array.isArray(surfaceStats) ? surfaceStats : [];
  const perSurface = safeStats.filter((s) => s != null).map((s) => {
    const total = Number(s.totalCandidates) || 0;
    const fresh = Number(s.freshCandidates) || 0;
    const explored = total - fresh;
    const exploredRatio = total > 0 ? explored / total : 0;
    return {
      surfaceId: s.surfaceId,
      freshCandidates: fresh,
      totalCandidates: total,
      exploredRatio,
    };
  });

  const safeHistory = Array.isArray(roundHistory) ? roundHistory : [];
  const roundTrend = safeHistory.filter((r) => r != null).map((r) => {
    const attempted = Number(r.attempted) || 0;
    const landed = Number(r.landed) || 0;
    const conversionRate = attempted > 0 ? landed / attempted : 0;
    return {
      roundNumber: r.roundNumber,
      landed,
      attempted,
      conversionRate,
    };
  });

  const exhaustedSurfaces = perSurface
    .filter((s) => s.freshCandidates === 0)
    .map((s) => s.surfaceId);

  const activeSurfaces = perSurface
    .filter((s) => s.freshCandidates >= ACTIVE_SURFACE_MIN_FRESH)
    .map((s) => s.surfaceId);

  return {
    signal,
    perSurface,
    roundTrend,
    exhaustedSurfaces,
    activeSurfaces,
  };
}

/**
 * formatSaturationReport — format the report as a human-readable multi-line string.
 *
 * @param {{
 *   signal: object,
 *   perSurface: Array,
 *   roundTrend: Array,
 *   exhaustedSurfaces: string[],
 *   activeSurfaces: string[],
 * }} report
 * @returns {string}
 */
function formatSaturationReport(report) {
  if (report == null || typeof report !== 'object') {
    const received = report === null ? 'null' : typeof report;
    throw new AdapterError(
      'INVALID_ARGUMENT',
      'report',
      `formatSaturationReport: expected a report object but received ${received}`,
      { fixHint: 'Pass the object returned by buildSaturationReport.' },
    );
  }
  const { signal, perSurface, roundTrend, exhaustedSurfaces, activeSurfaces } = report;
  if (signal == null) {
    throw new AdapterError(
      'INVALID_ARGUMENT',
      'report.signal',
      'formatSaturationReport: report.signal is missing or null',
      { fixHint: 'Pass the object returned by buildSaturationReport.' },
    );
  }
  const lines = [];

  lines.push('=== Saturation Report ===');
  lines.push(`Avg landed/round (last 5): ${signal.avgLandedPerRound.toFixed(2)}`);
  lines.push(`Fresh candidates remaining: ${signal.freshCandidatesRemaining}`);
  lines.push(`Total candidates remaining: ${signal.totalCandidatesRemaining}`);
  lines.push(`Rounds since last landing: ${signal.roundsSinceLastLanding}`);
  lines.push(`Saturation ratio: ${(signal.saturationRatio * 100).toFixed(1)}%`);
  lines.push('');

  lines.push('--- Per-Surface ---');
  if (perSurface.length === 0) {
    lines.push('  (no surfaces)');
  } else {
    for (const s of perSurface) {
      lines.push(
        `  ${s.surfaceId}: fresh=${s.freshCandidates} total=${s.totalCandidates} explored=${(s.exploredRatio * 100).toFixed(1)}%`,
      );
    }
  }
  lines.push('');

  lines.push('--- Round Trend ---');
  if (roundTrend.length === 0) {
    lines.push('  (no rounds)');
  } else {
    for (const r of roundTrend) {
      lines.push(
        `  R${r.roundNumber}: landed=${r.landed} attempted=${r.attempted} conversion=${(r.conversionRate * 100).toFixed(1)}%`,
      );
    }
  }
  lines.push('');

  lines.push(`Exhausted surfaces (0 fresh): ${exhaustedSurfaces.length === 0 ? 'none' : exhaustedSurfaces.join(', ')}`);
  lines.push(`Active surfaces (5+ fresh):   ${activeSurfaces.length === 0 ? 'none' : activeSurfaces.join(', ')}`);

  return lines.join('\n');
}

module.exports = {
  detectDiminishingReturns,
  buildSaturationReport,
  formatSaturationReport,
};
