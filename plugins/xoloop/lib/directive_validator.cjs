'use strict';

/**
 * directive_validator.cjs — Validate that a directive actually helped after
 * execution by comparing before/after metrics.
 *
 * Validation rules by directive type:
 *   bug         — compare error frequency (lower is better)
 *   performance — compare p95 latency (lower is better)
 *   feature     — just record that it was built (no auto-validation)
 *
 * Exports:
 *   validateDirectiveOutcome(directive, beforeMetrics, afterMetrics)
 *   buildValidationReport(directive, outcome)
 *
 * Error codes (all AdapterError):
 *   VALIDATION_DIRECTIVE_REQUIRED — directive is null/missing/not an object
 *   VALIDATION_METRICS_REQUIRED   — beforeMetrics or afterMetrics is null/missing
 */

const { AdapterError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIRECTIVE_TYPES = {
  BUG: 'bug',
  PERFORMANCE: 'performance',
  FEATURE: 'feature',
};

// Default metric keys we look for when no explicit key is provided
const DEFAULT_BUG_METRIC = 'errorFrequency';
const DEFAULT_PERF_METRIC = 'p95Latency';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assert directive is a non-null object with a `directive` type field.
 * @param {*} directive
 */
function assertDirective(directive) {
  if (!directive || typeof directive !== 'object' || Array.isArray(directive)) {
    throw new AdapterError(
      'VALIDATION_DIRECTIVE_REQUIRED',
      'directive',
      'directive must be a non-null object with a directive type field',
      { fixHint: 'Pass a validated directive object (e.g. from loadDirective) as the first argument.' },
    );
  }
  if (!directive.directive || typeof directive.directive !== 'string') {
    throw new AdapterError(
      'VALIDATION_DIRECTIVE_REQUIRED',
      'directive.directive',
      'directive.directive must be a non-empty string (bug | performance | feature)',
      { fixHint: 'Ensure the directive object has a "directive" field set to "bug", "performance", or "feature".' },
    );
  }
}

/**
 * Assert that a metrics argument is a non-null object.
 * @param {*} metrics
 * @param {string} fieldName
 */
function assertMetrics(metrics, fieldName) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new AdapterError(
      'VALIDATION_METRICS_REQUIRED',
      fieldName,
      `${fieldName} must be a non-null object containing metric values`,
      { fixHint: `Pass an object of metric key/value pairs as ${fieldName}.` },
    );
  }
}

/**
 * Pick the numeric value for a metric key from a metrics object.
 * Returns NaN if the key is absent or not a number.
 * @param {object} metrics
 * @param {string} key
 * @returns {number}
 */
function pickMetric(metrics, key) {
  const val = metrics[key];
  if (typeof val === 'number') return val;
  return NaN;
}

/**
 * Format a percentage-change string for use in descriptions.
 * When the baseline is 0 the ratio is undefined, so we return
 * "n/a (baseline was 0)" rather than silently lying with "+0.0%".
 * @param {number} before
 * @param {number} after
 * @returns {string}  e.g. "-40.0%" | "+10.0%" | "n/a (baseline was 0)"
 */
function formatPctChange(before, after) {
  if (before === 0) return 'n/a (baseline was 0)';
  const pct = ((after - before) / before) * 100;
  const sign = pct < 0 ? '' : '+';
  return `${sign}${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// validateDirectiveOutcome
// ---------------------------------------------------------------------------

/**
 * Compare before/after metrics and return an outcome object.
 *
 * For `bug` directives: looks for `errorFrequency` (or any key containing
 *   "error" case-insensitively) — lower-is-better comparison.
 *
 * For `performance` directives: looks for `p95Latency` (or any key containing
 *   "p95" case-insensitively) — lower-is-better comparison.
 *
 * For `feature` directives: records that it was built; improved = true always
 *   (feature delivery is self-validating).
 *
 * @param {{ directive: string, [key: string]: * }} directive
 * @param {object} beforeMetrics
 * @param {object} afterMetrics
 * @returns {{ improved: boolean, delta: number, description: string }}
 * @throws {AdapterError} VALIDATION_DIRECTIVE_REQUIRED
 * @throws {AdapterError} VALIDATION_METRICS_REQUIRED
 */
function validateDirectiveOutcome(directive, beforeMetrics, afterMetrics) {
  assertDirective(directive);
  assertMetrics(beforeMetrics, 'beforeMetrics');
  assertMetrics(afterMetrics, 'afterMetrics');

  const type = directive.directive;

  // -------------------------------------------------------------------------
  // Feature — no numeric validation, always mark improved
  // -------------------------------------------------------------------------
  if (type === DIRECTIVE_TYPES.FEATURE) {
    return {
      improved: true,
      delta: 0,
      description: 'Feature directive: delivery recorded; no automatic metric comparison performed.',
    };
  }

  // -------------------------------------------------------------------------
  // Bug — compare error frequency (lower after = improved)
  // -------------------------------------------------------------------------
  if (type === DIRECTIVE_TYPES.BUG) {
    // Look for explicit key first, then fall back to any key containing "error"
    let metricKey = DEFAULT_BUG_METRIC;
    if (isNaN(pickMetric(beforeMetrics, metricKey))) {
      const fallback = Object.keys(beforeMetrics).find((k) => k.toLowerCase().includes('error'));
      if (fallback) metricKey = fallback;
    }

    const before = pickMetric(beforeMetrics, metricKey);
    const after = pickMetric(afterMetrics, metricKey);

    if (isNaN(before) || isNaN(after)) {
      return {
        improved: false,
        delta: 0,
        description: `Bug directive: metric "${metricKey}" not found or not numeric in before/after metrics. Cannot determine outcome.`,
      };
    }

    const delta = after - before; // negative delta = errors decreased = good
    const improved = after < before;
    const pct = formatPctChange(before, after);
    const description = improved
      ? `Bug directive: error frequency decreased from ${before} to ${after} (${pct} change on "${metricKey}").`
      : `Bug directive: error frequency did not decrease. Before: ${before}, after: ${after} (${pct} change on "${metricKey}").`;

    return { improved, delta, description };
  }

  // -------------------------------------------------------------------------
  // Performance — compare p95 latency (lower after = improved)
  // -------------------------------------------------------------------------
  if (type === DIRECTIVE_TYPES.PERFORMANCE) {
    // Look for explicit key first, then fall back to any key containing "p95"
    let metricKey = DEFAULT_PERF_METRIC;
    if (isNaN(pickMetric(beforeMetrics, metricKey))) {
      const fallback = Object.keys(beforeMetrics).find((k) => k.toLowerCase().includes('p95'));
      if (fallback) metricKey = fallback;
    }

    const before = pickMetric(beforeMetrics, metricKey);
    const after = pickMetric(afterMetrics, metricKey);

    if (isNaN(before) || isNaN(after)) {
      return {
        improved: false,
        delta: 0,
        description: `Performance directive: metric "${metricKey}" not found or not numeric in before/after metrics. Cannot determine outcome.`,
      };
    }

    const delta = after - before; // negative = latency dropped = good
    const improved = after < before;
    const pct = formatPctChange(before, after);
    const description = improved
      ? `Performance directive: p95 latency decreased from ${before} to ${after}ms (${pct} change on "${metricKey}").`
      : `Performance directive: p95 latency did not decrease. Before: ${before}ms, after: ${after}ms (${pct} change on "${metricKey}").`;

    return { improved, delta, description };
  }

  // -------------------------------------------------------------------------
  // Unknown directive type — still return a safe object, no throw
  // -------------------------------------------------------------------------
  return {
    improved: false,
    delta: 0,
    description: `Unknown directive type "${type}": no validation rule defined.`,
  };
}

// ---------------------------------------------------------------------------
// buildValidationReport
// ---------------------------------------------------------------------------

/**
 * Build a structured validation report from a directive and its computed outcome.
 *
 * @param {{ directive: string, [key: string]: * }} directive
 * @param {{ improved: boolean, delta: number, description: string }} outcome
 * @returns {{
 *   directive: object,
 *   outcome: object,
 *   timestamp: string,
 *   improved: boolean,
 * }}
 * @throws {AdapterError} VALIDATION_DIRECTIVE_REQUIRED
 * @throws {AdapterError} VALIDATION_METRICS_REQUIRED  (if outcome is missing)
 */
function buildValidationReport(directive, outcome) {
  assertDirective(directive);

  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new AdapterError(
      'VALIDATION_METRICS_REQUIRED',
      'outcome',
      'outcome must be a non-null object returned by validateDirectiveOutcome',
      { fixHint: 'Call validateDirectiveOutcome(directive, before, after) and pass the result as the second argument.' },
    );
  }

  return {
    directive,
    outcome,
    timestamp: new Date().toISOString(),
    improved: outcome.improved === true,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validateDirectiveOutcome,
  buildValidationReport,
};
