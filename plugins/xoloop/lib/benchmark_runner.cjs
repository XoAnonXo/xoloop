'use strict';

const { spawnSync } = require('node:child_process');
const { createMeter, recordMetrics, checkBounds } = require('./benchmark_meter.cjs');
const { matchOutput } = require('./benchmark_matcher.cjs');
const { AdapterError } = require('./errors.cjs');

/**
 * Execute a single benchmark case: run the entry_point command, capture stdout,
 * parse JSON output, match against expected, measure metrics.
 *
 * @param {object} benchmarkCase - A single case from a benchmark suite.
 * @param {{ cwd: string }} options - Execution options.
 * @returns {{ verdict: string, metrics: object, outputMatch: object }}
 */
function runBenchmarkCase(benchmarkCase, options = {}) {
  if (benchmarkCase === null || typeof benchmarkCase !== 'object') {
    throw new AdapterError(
      'BENCHMARK_CASE_REQUIRED',
      'benchmarkCase',
      'benchmarkCase must be a non-null object',
      { fixHint: 'Pass a valid benchmark case object as the first argument to runBenchmarkCase.' },
    );
  }
  const safeOptions = (options !== null && typeof options === 'object') ? options : {};
  const cwd = safeOptions.cwd || process.cwd();
  const command = benchmarkCase.entry_point && benchmarkCase.entry_point.command;

  if (!command) {
    return {
      verdict: 'BENCHMARK_VIOLATION',
      metrics: { wallTimeMs: 0, cpuTimeMs: 0, peakMemoryMb: 0 },
      outputMatch: { verdict: 'fail', diff: 'no entry_point command specified' },
    };
  }

  const meter = createMeter();

  // Strip NODE_TEST_CONTEXT to avoid interference with nested node processes
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_CHANNEL_FD;

  const result = spawnSync('bash', ['-c', command], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    env: childEnv,
  });

  const metrics = recordMetrics(meter);
  const exitCode = result.status === null ? 1 : result.status;
  const stderr = String(result.stderr || '');

  // Coerce possibly-null stdout to a safe string once
  const rawStdout = result.stdout || '';

  // Parse stdout as JSON
  let actualOutput;
  try {
    actualOutput = JSON.parse(rawStdout.trim());
  } catch (_err) {
    return {
      verdict: 'BENCHMARK_VIOLATION',
      metrics,
      outputMatch: {
        verdict: 'fail',
        diff: `failed to parse stdout as JSON: ${rawStdout.slice(0, 200)}`,
      },
    };
  }

  // Match output against expected
  const outputMatch = matchOutput(actualOutput, benchmarkCase.expected_output);

  // Check bounds
  const boundsMatch = checkBounds(metrics, benchmarkCase.bounds || {});

  // Determine overall verdict
  let verdict;
  if (exitCode !== 0) {
    verdict = 'BENCHMARK_VIOLATION';
  } else if (outputMatch.verdict === 'fail') {
    verdict = 'BENCHMARK_VIOLATION';
  } else if (boundsMatch.verdict === 'BENCHMARK_VIOLATION') {
    verdict = 'BENCHMARK_VIOLATION';
  } else {
    verdict = 'PASS';
  }

  return {
    verdict,
    metrics,
    exitCode,
    stderrTail: stderr.slice(-2000),
    outputMatch,
    boundsMatch,
  };
}

/**
 * Run all cases in a benchmark suite and return per-case results.
 *
 * @param {object} benchmark - The full benchmark object with a cases array.
 * @param {{ cwd: string }} options - Execution options.
 * @returns {Array<{ id: string, verdict: string, metrics: object, outputMatch: object }>}
 */
function runBenchmarkSuite(benchmark, options = {}) {
  if (benchmark === null || benchmark === undefined || typeof benchmark !== 'object') {
    throw new AdapterError(
      'BENCHMARK_SUITE_REQUIRED',
      'benchmark',
      'benchmark must be a non-null object with a cases array',
      { fixHint: 'Pass a valid benchmark object as the first argument to runBenchmarkSuite.' },
    );
  }
  const safeOptions = (options !== null && typeof options === 'object') ? options : {};
  const cases = benchmark.cases || [];
  if (!Array.isArray(cases)) {
    throw new AdapterError(
      'BENCHMARK_SUITE_CASES_INVALID',
      'benchmark.cases',
      'benchmark.cases must be an array of case objects',
      { fixHint: 'Ensure the benchmark object has a cases property that is an array.' },
    );
  }
  const results = [];

  for (const benchmarkCase of cases) {
    const result = runBenchmarkCase(benchmarkCase, safeOptions);
    results.push({
      id: benchmarkCase.id,
      ...result,
    });
  }

  return results;
}

module.exports = {
  runBenchmarkCase,
  runBenchmarkSuite,
};
