'use strict';

const { inspect } = require('node:util');

/**
 * Deep-equal comparison of actual vs expected values.
 *
 * @param {*} actual
 * @param {*} expected
 * @returns {{ verdict: 'pass'|'fail', diff: string|null }}
 */
function matchExact(actual, expected) {
  try {
    // Use JSON serialised-string comparison for deep structural equality
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);

    if (actualJson === expectedJson) {
      return { verdict: 'pass', diff: null };
    }

    return {
      verdict: 'fail',
      diff: `expected ${inspect(expected, { depth: 10 })}, got ${inspect(actual, { depth: 10 })}`,
    };
  } catch (_err) {
    // Fallback for non-serializable values
    if (actual === expected) {
      return { verdict: 'pass', diff: null };
    }
    return {
      verdict: 'fail',
      diff: `expected ${inspect(expected, { depth: 10 })}, got ${inspect(actual, { depth: 10 })}`,
    };
  }
}

/**
 * Validate actual value against a schema definition.
 * Schema supports: { type: 'number', min, max, exact } and nested objects.
 *
 * @param {object} actual - The actual value to validate.
 * @param {object} schema - Schema definition object.
 * @returns {{ verdict: 'pass'|'fail', violations: string[] }}
 */
function matchSchema(actual, schema) {
  if (actual == null) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('MATCH_SCHEMA_ACTUAL_REQUIRED', 'actual',
      'actual must be a non-null value',
      { fixHint: 'Pass the actual output object to matchSchema(); do not pass null or undefined.' });
  }
  const violations = [];

  function validate(value, schemaDef, path, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 50) {
      violations.push(`${path}: schema depth exceeds maximum (50)`);
      return;
    }
    if (!schemaDef || typeof schemaDef !== 'object') {
      return;
    }

    if (schemaDef.type === 'number') {
      if (typeof value !== 'number') {
        violations.push(`${path}: expected number, got ${typeof value}`);
        return;
      }
      if (schemaDef.exact !== undefined && value !== schemaDef.exact) {
        violations.push(`${path}: expected exact ${schemaDef.exact}, got ${value}`);
      }
      if (schemaDef.min !== undefined && value < schemaDef.min) {
        violations.push(`${path}: ${value} is below min ${schemaDef.min}`);
      }
      if (schemaDef.max !== undefined && value > schemaDef.max) {
        violations.push(`${path}: ${value} exceeds max ${schemaDef.max}`);
      }
      return;
    }

    if (schemaDef.type === 'string') {
      if (typeof value !== 'string') {
        violations.push(`${path}: expected string, got ${typeof value}`);
      }
      return;
    }

    // Nested object schema — iterate keys
    if (!schemaDef.type) {
      if (typeof value !== 'object' || value === null) {
        violations.push(`${path}: expected object, got ${typeof value}`);
        return;
      }
      for (const key of Object.keys(schemaDef)) {
        validate(value[key], schemaDef[key], path ? `${path}.${key}` : key, depth + 1);
      }
    }
  }

  if (typeof schema === 'object' && schema !== null) {
    for (const key of Object.keys(schema)) {
      validate(
        actual[key],
        schema[key],
        key,
        0,
      );
    }
  }

  if (violations.length === 0) {
    return { verdict: 'pass', violations: [] };
  }

  return { verdict: 'fail', violations };
}

/**
 * Dispatch to matchExact or matchSchema based on expectedOutput shape.
 *
 * @param {*} actual - The actual output.
 * @param {object} expectedOutput - The expected output descriptor with type field.
 * @returns {{ verdict: 'pass'|'fail', diff?: string|null, violations?: string[] }}
 */
function matchOutput(actual, expectedOutput) {
  if (!expectedOutput || typeof expectedOutput !== 'object') {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('MATCH_OUTPUT_INVALID', 'expectedOutput',
      'expectedOutput must be a non-null object',
      { fixHint: 'Pass an object with an .exact or .schema key to matchOutput().' });
  }

  // If expectedOutput has an 'exact' field, use matchExact
  if (expectedOutput.exact !== undefined) {
    return matchExact(actual, expectedOutput.exact);
  }

  // If expectedOutput has a 'schema' field, use matchSchema
  if (expectedOutput.schema !== undefined) {
    return matchSchema(actual, expectedOutput.schema);
  }

  // Default: treat the whole expectedOutput as exact comparison
  return matchExact(actual, expectedOutput);
}

module.exports = {
  matchExact,
  matchSchema,
  matchOutput,
};
