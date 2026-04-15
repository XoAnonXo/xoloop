#!/usr/bin/env node
/**
 * xoloop-benchmark.cjs — thin CLI wrapper for SHA-256-locked benchmarks.
 *
 * Subcommands: run | create
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  requireLib,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const { loadBenchmark } = requireLib('benchmark_loader.cjs');
const { runBenchmarkCase } = requireLib('benchmark_runner.cjs');

async function runCommand(argv) {
  const benchmarkPath = parseFlag(argv, '--benchmark', null);
  if (!benchmarkPath) {
    console.error('[xoloop-benchmark] --benchmark is required for run.');
    process.exit(1);
  }
  const suite = loadBenchmark(path.resolve(benchmarkPath));
  const results = [];
  for (const benchmarkCase of suite.cases) {
    const r = runBenchmarkCase(benchmarkCase, { cwd: process.cwd() });
    results.push({ name: benchmarkCase.name, ...r });
  }
  console.log('\n=== Benchmark Summary ===');
  for (const r of results) {
    console.log(`${r.name}: ${r.verdict}  (hash ${r.outputMatch && r.outputMatch.actualSha256 ? r.outputMatch.actualSha256.slice(0, 12) : 'n/a'})`);
  }
  const failed = results.filter((r) => r.verdict !== 'pass').length;
  process.exit(failed > 0 ? 1 : 0);
}

async function createCommand(argv) {
  const entryPoint = parseFlag(argv, '--entry-point', null);
  const output = parseFlag(argv, '--output', null);
  const name = parseFlag(argv, '--name', 'case-1');
  if (!entryPoint || !output) {
    console.error('[xoloop-benchmark] --entry-point and --output are required for create.');
    process.exit(1);
  }
  console.log(`[xoloop-benchmark] Running "${entryPoint}" to capture output...`);
  const result = spawnSync('sh', ['-c', entryPoint], { encoding: 'utf8', cwd: process.cwd() });
  if (result.status !== 0) {
    console.error('[xoloop-benchmark] entry-point failed:', result.stderr);
    process.exit(1);
  }
  const hash = crypto.createHash('sha256').update(result.stdout).digest('hex');
  const yaml = [
    `benchmark: ${path.basename(output, path.extname(output))}`,
    `cases:`,
    `  - name: ${name}`,
    `    entry_point: ${JSON.stringify(entryPoint)}`,
    `    expected_output_sha256: "${hash}"`,
    ``,
  ].join('\n');
  fs.writeFileSync(output, yaml);
  console.log(`[xoloop-benchmark] Wrote ${output} with hash ${hash.slice(0, 12)}...`);
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log('Usage:');
    console.log('  xoloop-benchmark run --benchmark <path>');
    console.log('  xoloop-benchmark create --entry-point "<cmd>" --output <path>');
    process.exit(0);
  }
  if (sub === 'run') return runCommand(argv.slice(1));
  if (sub === 'create') return createCommand(argv.slice(1));
  console.error(`[xoloop-benchmark] unknown subcommand: ${sub}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[xoloop-benchmark] Fatal:', err.message || err);
  process.exit(1);
});
