'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runBenchmarkCase } = require('../plugins/xoloop/lib/benchmark_runner.cjs');

test('benchmark fails when command exits nonzero even if stdout matches', () => {
  const result = runBenchmarkCase({
    id: 'prints-json-then-fails',
    entry_point: { command: 'printf \'{"ok":true}\\n\'; exit 7' },
    expected_output: { exact: { ok: true } },
    bounds: { wallTimeMs: 5000 },
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.outputMatch.verdict, 'pass');
  assert.equal(result.verdict, 'BENCHMARK_VIOLATION');
});
