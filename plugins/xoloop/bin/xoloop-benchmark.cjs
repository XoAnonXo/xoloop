#!/usr/bin/env node
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

// Parse `METRIC name=value [unit]` lines out of a script's stdout.
// Mirrors the pi-autoresearch contract so operators can drop an
// `autoresearch.sh`-style script and get structured metrics out without
// writing a full benchmark.yaml. Three accepted formats:
//   METRIC name=value
//   METRIC name: value
//   METRIC name value
function parseMetricLines(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('METRIC')) continue;
    const rest = trimmed.slice('METRIC'.length).trim();
    const eqMatch = rest.match(/^([A-Za-z0-9_\-.]+)\s*[=:]\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(\S*)$/);
    const spaceMatch = !eqMatch ? rest.match(/^([A-Za-z0-9_\-.]+)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(\S*)$/) : null;
    const m = eqMatch || spaceMatch;
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    out.push({ name: m[1], value, unit: m[3] || null });
  }
  return out;
}

function runScriptCommand(argv) {
  const scriptPath = parseFlag(argv, '--script', null);
  if (!scriptPath) {
    console.error('[xoloop-benchmark] --script is required for run (when using simpler pi-style contract) or use --benchmark <yaml> for SHA-256-locked mode.');
    process.exit(1);
  }
  const absScript = path.resolve(scriptPath);
  if (!fs.existsSync(absScript)) {
    console.error(`[xoloop-benchmark] script not found: ${absScript}`);
    process.exit(1);
  }
  const t0 = Date.now();
  const result = spawnSync('bash', [absScript], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - t0;
  const exitCode = result.status === null ? 1 : result.status;
  const metrics = parseMetricLines(result.stdout);
  const report = {
    mode: 'script',
    scriptPath: absScript,
    exitCode,
    elapsedMs,
    metricCount: metrics.length,
    metrics,
    stdoutTail: String(result.stdout || '').slice(-2000),
    stderrTail: String(result.stderr || '').slice(-2000),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(exitCode === 0 && metrics.length > 0 ? 0 : 1);
}

async function runCommand(argv) {
  if (hasFlag(argv, '--script')) {
    return runScriptCommand(argv);
  }
  const benchmarkPath = parseFlag(argv, '--benchmark', null)
    || argv.find((arg) => typeof arg === 'string' && !arg.startsWith('--'));
  if (!benchmarkPath) {
    console.error('[xoloop-benchmark] run requires either --script <bash> (simpler pi-style contract) or --benchmark <yaml> (SHA-256-locked).');
    process.exit(1);
  }
  const suite = loadBenchmark(path.resolve(benchmarkPath));
  const results = suite.cases.map((benchmarkCase) => ({
    name: benchmarkCase.name || benchmarkCase.id,
    ...runBenchmarkCase(benchmarkCase, { cwd: process.cwd() }),
  }));
  console.log('\n=== Benchmark Summary ===');
  for (const r of results) {
    console.log(`${r.name || r.id}: ${r.verdict}  (hash ${r.outputMatch && r.outputMatch.actualSha256 ? r.outputMatch.actualSha256.slice(0, 12) : 'n/a'})`);
  }
  const failed = results.some((r) => String(r.verdict || '').toLowerCase() !== 'pass');
  process.exit(failed ? 1 : 0);
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
  const document = {
    benchmark: path.basename(output, path.extname(output)),
    cases: [
      {
        id: name,
        name,
        entry_point: entryPoint,
        expected_output_sha256: hash,
        bounds: {},
      },
    ],
  };
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`[xoloop-benchmark] Wrote ${output} with hash ${hash.slice(0, 12)}...`);
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log('Usage:');
    console.log('  xoloop-benchmark run --benchmark <yaml>    SHA-256-locked mode');
    console.log('  xoloop-benchmark run --script <bash>       simpler pi-style contract');
    console.log('  xoloop-benchmark create --entry-point "<cmd>" --output <path>');
    console.log('');
    console.log('Script mode: bash script outputs `METRIC name=value` lines. Any');
    console.log('metric, any workload. Inspired by pi-autoresearch.');
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
