'use strict';

const { readYamlFile } = require('./overnight_yaml.cjs');
const { AdapterError } = require('./errors.cjs');

/**
 * Validate the shape of a benchmark YAML document.
 * Must have: benchmark (string), cases (non-empty array).
 * Each case must have: id, input, expected_output, bounds.
 *
 * @param {object} doc - The parsed YAML document.
 * @throws {AdapterError} with code BENCHMARK_SCHEMA_INVALID on any violation.
 */
function validateBenchmarkSchema(doc) {
  if (!doc || typeof doc !== 'object') {
    throw new AdapterError(
      'BENCHMARK_SCHEMA_INVALID',
      'document',
      'benchmark document must be a non-null object',
      { fixHint: 'Ensure the YAML file contains a mapping with benchmark and cases fields.' },
    );
  }

  if (typeof doc.benchmark !== 'string' || doc.benchmark.length === 0) {
    throw new AdapterError(
      'BENCHMARK_SCHEMA_INVALID',
      'benchmark',
      'benchmark field must be a non-empty string',
      { fixHint: 'Add a "benchmark" name string at the top level of the YAML file.' },
    );
  }

  if (!Array.isArray(doc.cases) || doc.cases.length === 0) {
    throw new AdapterError(
      'BENCHMARK_SCHEMA_INVALID',
      'cases',
      'cases must be a non-empty array',
      { fixHint: 'Add a "cases" array with at least one benchmark case.' },
    );
  }

  for (let i = 0; i < doc.cases.length; i++) {
    const c = doc.cases[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}]`,
        `case at index ${i} must be an object`,
        { fixHint: `Fix cases[${i}] to be a valid object with id, input, expected_output, and bounds.` },
      );
    }
    if (typeof c.id !== 'string' || c.id.trim().length === 0) {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}].id`,
        `case at index ${i} must have a non-empty string id`,
        { fixHint: `Ensure cases[${i}].id is a non-empty, non-whitespace string.` },
      );
    }
    if (c.input == null) {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}].input`,
        `case "${c.id}" must have an input field`,
        { fixHint: `Add an "input" field to case "${c.id}".` },
      );
    }
    if (c.expected_output == null) {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}].expected_output`,
        `case "${c.id}" must have an expected_output field`,
        { fixHint: `Add an "expected_output" field to case "${c.id}".` },
      );
    }
    if (c.bounds == null) {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}].bounds`,
        `case "${c.id}" must have a bounds field`,
        { fixHint: `Add a "bounds" field to case "${c.id}".` },
      );
    }
  }
}

/**
 * Load and validate a .benchmark.yaml file.
 *
 * @param {string} benchmarkPath - Absolute path to the benchmark YAML file.
 * @returns {{ benchmark: string, version: number, created: string|null, immutable: boolean, cases: Array }} structured benchmark object.
 * @throws {AdapterError} BENCHMARK_PATH_REQUIRED if path is null/undefined.
 * @throws {AdapterError} BENCHMARK_SCHEMA_INVALID if document shape is wrong.
 */
function loadBenchmark(benchmarkPath) {
  if (typeof benchmarkPath !== 'string' || benchmarkPath.trim().length === 0) {
    throw new AdapterError(
      'BENCHMARK_PATH_REQUIRED',
      'benchmarkPath',
      'benchmarkPath must be a non-empty string',
      { fixHint: 'Pass the absolute path to a .benchmark.yaml file.' },
    );
  }

  const { document } = readYamlFile(benchmarkPath);
  validateBenchmarkSchema(document);

  return {
    benchmark: document.benchmark,
    version: document.version ?? 1,
    created: document.created ?? null,
    immutable: document.immutable ?? true,
    cases: document.cases,
  };
}

module.exports = {
  loadBenchmark,
  validateBenchmarkSchema,
};
