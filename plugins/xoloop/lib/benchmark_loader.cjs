'use strict';

const { readYamlFile } = require('./overnight_yaml.cjs');
const { AdapterError } = require('./errors.cjs');

function caseIdOf(benchmarkCase) {
  return typeof benchmarkCase.id === 'string' && benchmarkCase.id.trim()
    ? benchmarkCase.id.trim()
    : String(benchmarkCase.name || '').trim();
}

function hasEntryPoint(benchmarkCase) {
  return typeof benchmarkCase.entry_point === 'string'
    || Boolean(benchmarkCase.entry_point && typeof benchmarkCase.entry_point.command === 'string');
}

function normalizeBenchmarkCase(benchmarkCase, index) {
  const id = caseIdOf(benchmarkCase) || `case-${index + 1}`;
  return {
    ...benchmarkCase,
    id,
    name: benchmarkCase.name || id,
    bounds: benchmarkCase.bounds || {},
    entry_point: typeof benchmarkCase.entry_point === 'string'
      ? { command: benchmarkCase.entry_point }
      : benchmarkCase.entry_point,
  };
}

/**
 * Validate the shape of a benchmark YAML/JSON document.
 * Supports both current exact-output cases and legacy SHA-256-locked cases
 * emitted by `xoloop-benchmark create`.
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
    const id = caseIdOf(c);
    if (!id) {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}].id`,
        `case at index ${i} must have a non-empty string id or name`,
        { fixHint: `Ensure cases[${i}].id or cases[${i}].name is a non-empty string.` },
      );
    }
    if (!hasEntryPoint(c)) {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}].entry_point`,
        `case "${id}" must have an entry_point command`,
        { fixHint: `Add entry_point: "node ..." or entry_point.command to case "${id}".` },
      );
    }
    if (c.expected_output == null && typeof c.expected_output_sha256 !== 'string') {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}].expected_output`,
        `case "${id}" must have expected_output or expected_output_sha256`,
        { fixHint: `Add expected_output for JSON matching, or expected_output_sha256 for locked stdout matching to case "${id}".` },
      );
    }
    if (c.bounds != null && (typeof c.bounds !== 'object' || Array.isArray(c.bounds))) {
      throw new AdapterError(
        'BENCHMARK_SCHEMA_INVALID',
        `cases[${i}].bounds`,
        `case "${id}" bounds must be an object when present`,
        { fixHint: `Set bounds to an object, or omit bounds for case "${id}".` },
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
    cases: document.cases.map(normalizeBenchmarkCase),
  };
}

module.exports = {
  normalizeBenchmarkCase,
  loadBenchmark,
  validateBenchmarkSchema,
};
