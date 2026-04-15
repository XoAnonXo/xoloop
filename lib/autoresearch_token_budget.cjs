'use strict';

/**
 * autoresearch_token_budget.cjs — tier-proportional token budget for auto-research.
 *
 * Per AutoReason SPEC v2: a flat 5M cap is a wallet attack. Budget must scale
 * with leverage. Tiny helpers get small budgets; strategic surfaces get more.
 *
 * Formula:
 *   baseBudget = 50_000 + (LOC × 1000)
 *   finalBudget = min(baseBudget, TIER_CAPS[tier])
 *
 * Tiers:
 *   utility    —  200K — small helpers, formatters, utility functions
 *   normal     —  750K — most modules
 *   strategic  — 2.00M — hot paths, public APIs, core engine modules
 *   override   — 5.00M — explicit --override-budget flag only
 */

const { AdapterError } = require('./errors.cjs');

const TIER_CAPS = Object.freeze({
  utility: 200000,
  normal: 750000,
  strategic: 2000000,
  override: 5000000,
});

const TIER_ORDER = Object.freeze(['utility', 'normal', 'strategic', 'override']);

const BASE_FLOOR = 50000;
const PER_LOC_TOKENS = 1000;

function assertTier(tier) {
  if (!Object.prototype.hasOwnProperty.call(TIER_CAPS, tier)) {
    throw new AdapterError(
      'AUTORESEARCH_BUDGET_TIER_UNKNOWN',
      'tier',
      `Unknown budget tier: ${tier}`,
      { fixHint: `Pass one of: ${TIER_ORDER.join(', ')}.` },
    );
  }
  return tier;
}

function assertLocCount(locCount) {
  const value = Number(locCount);
  if (!Number.isInteger(value) || value < 0) {
    throw new AdapterError(
      'AUTORESEARCH_BUDGET_LOC_INVALID',
      'locCount',
      `LOC count must be a non-negative integer, got ${locCount}`,
      { fixHint: 'Pass the line count of the target surface as a non-negative integer.' },
    );
  }
  return value;
}

function computeBaseBudget(locCount) {
  const value = assertLocCount(locCount);
  return BASE_FLOOR + (value * PER_LOC_TOKENS);
}

function computeBudget(locCount, tier = 'normal') {
  const resolvedTier = assertTier(tier);
  const base = computeBaseBudget(locCount);
  const cap = TIER_CAPS[resolvedTier];
  return Math.min(base, cap);
}

function budgetTierForSurface(surface) {
  const safe = (surface && typeof surface === 'object' && !Array.isArray(surface)) ? surface : {};
  if (safe.overrideBudget === true) {
    return 'override';
  }
  const risk = typeof safe.risk === 'string' ? safe.risk.toLowerCase() : '';
  const isCritical = safe.critical === true || safe.publicApi === true || safe.hotPath === true;
  if (isCritical || risk === 'guarded') {
    return 'strategic';
  }
  const loc = Number(safe.locCount);
  if (Number.isFinite(loc) && loc > 0 && loc < 60) {
    return 'utility';
  }
  return 'normal';
}

function explainBudget(locCount, tier = 'normal') {
  const resolvedTier = assertTier(tier);
  const base = computeBaseBudget(locCount);
  const cap = TIER_CAPS[resolvedTier];
  const final = Math.min(base, cap);
  const rationale = base <= cap
    ? `base ${base} is within ${resolvedTier} cap ${cap} — final ${final}`
    : `base ${base} exceeds ${resolvedTier} cap ${cap} — final capped at ${cap}`;
  return {
    tier: resolvedTier,
    locCount: assertLocCount(locCount),
    baseFloor: BASE_FLOOR,
    perLocTokens: PER_LOC_TOKENS,
    baseBudget: base,
    tierCap: cap,
    finalBudget: final,
    rationale,
  };
}

module.exports = {
  BASE_FLOOR,
  PER_LOC_TOKENS,
  TIER_CAPS,
  TIER_ORDER,
  budgetTierForSurface,
  computeBaseBudget,
  computeBudget,
  explainBudget,
};
