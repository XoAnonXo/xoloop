'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  runGoalVerify,
  scanPerformanceRepo,
} = require('../lib/goal_verify_runner.cjs');
const { evaluateCandidate } = require('../lib/goal_optimise_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-performance-suite-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeScript(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
}

function writePerformanceGoal(cwd, options = {}) {
  const goalId = options.goalId || 'perf';
  const goalDir = path.join(cwd, '.xoloop', 'goals', goalId);
  for (const item of options.cases || []) {
    writeJson(path.join(goalDir, 'cases', `${item.id}.json`), item);
  }
  const goalPath = path.join(goalDir, 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: goalId,
    objective: 'Verify performance evidence.',
    interface: {
      type: 'performance',
      command: options.command || 'node bench.cjs',
      stdin: 'text',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: options.artifacts || ['bench.cjs', 'dist/app.js'],
    },
    verify: {
      kind: 'performance-suite',
      command: options.command || 'node bench.cjs',
      cases: 'cases/*.json',
      properties: options.properties || [
        'case_present',
        'environment_preflight',
        'sample_size',
        'stable_benchmark',
        'paired_benchmark',
        'metric_capture',
        'latency_percentiles',
        'cpu_metrics',
        'memory_metrics',
        'bundle_size',
        'bundle_attribution',
        'cold_start',
        'render_time',
        'request_formation_time',
        'performance_budget',
        'baseline_update',
        'regression_guard',
        'noise_adjusted_confidence',
      ],
      repeat: 5,
      warmup: 0,
      cooldown_ms: 0,
      noise: {
        min_samples: 5,
        max_cv: 0.05,
        min_effect_ratio: 0.03,
        bootstrap_iterations: 80,
        stable_metrics: ['render_time_ms', 'request_formation_time_ms'],
      },
      environment: {
        max_load_per_cpu: 100,
        fail_on_warning: true,
      },
      bundle_files: ['dist/*.js'],
      budgets: {},
      baseline: {},
      improvement_targets: [],
      block_on_gaps: true,
    },
    metrics: {
      repeat: 5,
      targets: [
        { name: 'render_time_ms_p95', direction: 'minimize', threshold: 0.05 },
        { name: 'request_formation_time_ms_p95', direction: 'minimize', threshold: 0.05 },
        { name: 'bundle_bytes', direction: 'minimize', threshold: 0.03 },
      ],
    },
  });
  return goalPath;
}

function seedBundle(cwd, content = 'console.log("small");\n') {
  fs.mkdirSync(path.join(cwd, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'dist', 'app.js'), content, 'utf8');
}

test('performance scan detects benchmark scripts, tools, files, and bundles', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      bench: 'node bench.cjs',
      build: 'vite build',
    },
    devDependencies: {
      tinybench: '^3.0.0',
      lighthouse: '^12.0.0',
      vite: '^6.0.0',
    },
  });
  writeScript(path.join(cwd, 'bench.cjs'), 'const { performance } = require("node:perf_hooks"); console.log(performance.now());\n');
  seedBundle(cwd);

  const scan = scanPerformanceRepo(cwd);

  assert.ok(scan.tools.some((tool) => tool.name === 'js-benchmark'));
  assert.ok(scan.tools.some((tool) => tool.name === 'lighthouse'));
  assert.ok(scan.commands.some((command) => command.kind === 'benchmark'));
  assert.ok(scan.benchmark_files.includes('bench.cjs'));
  assert.ok(scan.bundle_files.includes('dist/app.js'));
});

test('performance-suite create writes harness assets and manifest', () => {
  const cwd = tmpDir();

  const created = createGoal({ cwd, kind: 'performance-suite', goalId: 'performance-suite', force: true });

  assert.equal(created.goal.verify.kind, 'performance-suite');
  assert.equal(created.goal.interface.type, 'performance');
  for (const dir of ['cases', 'baselines', 'actual', 'diffs', 'traces', 'profiles', 'bundles', 'reports']) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'performance-suite', dir)), true);
  }
});

test('performance-suite reaches PASS_EVIDENCED for stable metrics, budgets, bundles, and confident improvements', async () => {
  const cwd = tmpDir();
  seedBundle(cwd, 'console.log("small bundle");\n');
  writeScript(path.join(cwd, 'baseline.cjs'), [
    'console.log(JSON.stringify({ metrics: {',
    '  cpu_ms: 5,',
    '  peak_memory_mb: 14,',
    '  render_time_ms: 40,',
    '  request_formation_time_ms: 20',
    '} }));',
    '',
  ].join('\n'));
  writeScript(path.join(cwd, 'bench.cjs'), [
    'console.log(JSON.stringify({ metrics: {',
    '  cpu_ms: 4,',
    '  peak_memory_mb: 12,',
    '  render_time_ms: 20,',
    '  request_formation_time_ms: 8',
    '} }));',
    '',
  ].join('\n'));
  const goalPath = writePerformanceGoal(cwd, {
    cases: [{
      id: 'stable',
      command: 'node bench.cjs',
      baseline_command: 'node baseline.cjs',
      repeat: 5,
      warmup: 0,
      bundle_files: ['dist/*.js'],
      budgets: {
        wall_time_ms_p95: { lte: 5000 },
        cpu_ms_p95: { lte: 1000 },
        peak_memory_mb_p95: { lte: 128 },
        bundle_bytes: { lte: 1024 },
        cold_start_ms_p50: { lte: 5000 },
        render_time_ms_p95: { lte: 25 },
        request_formation_time_ms_p95: { lte: 10 },
      },
      baseline: {
        render_time_ms_p95: { value: 40, stddev: 1, samples: 5 },
        request_formation_time_ms_p95: { value: 20, stddev: 1, samples: 5 },
        bundle_bytes: { value: 200, stddev: 0, samples: 1 },
      },
      improvement_targets: [
        { metric: 'render_time_ms_p95', min_improvement_ratio: 0.20 },
        { metric: 'request_formation_time_ms_p95', min_improvement_ratio: 0.20 },
        { metric: 'bundle_bytes', min_improvement_ratio: 0.03 },
      ],
    }],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.failed, 0);
  assert.deepEqual(card.missing_obligations, []);
  assert.equal(card.summary.by_id.noise_adjusted_confidence.passed, 1);
  assert.equal(card.summary.by_id.paired_benchmark.passed, 1);
  assert.equal(card.summary.by_id.bundle_attribution.passed, 1);
  assert.equal(card.summary.by_id.environment_preflight.passed, 1);
  assert.ok(Number.isFinite(card.metrics.render_time_ms_p95));
  assert.ok(Number.isFinite(card.metrics.bundle_bytes));
  assert.ok(Array.isArray(card.distributions.render_time_ms));
});

test('performance-suite rejects claimed improvements inside noise', async () => {
  const cwd = tmpDir();
  seedBundle(cwd);
  writeScript(path.join(cwd, 'bench.cjs'), 'console.log(JSON.stringify({ metrics: { cpu_ms: 4, peak_memory_mb: 12, render_time_ms: 98, request_formation_time_ms: 10 } }));\n');
  const goalPath = writePerformanceGoal(cwd, {
    cases: [{
      id: 'inside-noise',
      command: 'node bench.cjs',
      repeat: 5,
      warmup: 0,
      budgets: {
        wall_time_ms_p95: { lte: 5000 },
        cpu_ms_p95: { lte: 1000 },
        peak_memory_mb_p95: { lte: 128 },
        bundle_bytes: { lte: 1024 },
        cold_start_ms_p50: { lte: 5000 },
        render_time_ms_p95: { lte: 150 },
        request_formation_time_ms_p95: { lte: 15 },
      },
      baseline: {
        render_time_ms_p95: { value: 100, stddev: 1, samples: 5 },
        request_formation_time_ms_p95: { value: 20, stddev: 1, samples: 5 },
        bundle_bytes: { value: 200, stddev: 0, samples: 1 },
      },
      improvement_targets: [
        { metric: 'render_time_ms_p95', min_improvement_ratio: 0.05 },
      ],
    }],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'noise_adjusted_confidence');
  assert.match(card.counterexample.failures[0].message, /inside noise/);
});

test('performance-suite fails p95 budget regressions with replayable diff artifacts', async () => {
  const cwd = tmpDir();
  seedBundle(cwd);
  writeScript(path.join(cwd, 'bench.cjs'), 'console.log(JSON.stringify({ metrics: { cpu_ms: 4, peak_memory_mb: 12, render_time_ms: 35, request_formation_time_ms: 8 } }));\n');
  const goalPath = writePerformanceGoal(cwd, {
    properties: ['case_present', 'sample_size', 'stable_benchmark', 'metric_capture', 'performance_budget'],
    cases: [{
      id: 'budget',
      command: 'node bench.cjs',
      repeat: 5,
      warmup: 0,
      budgets: {
        render_time_ms_p95: { lte: 20 },
      },
    }],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'performance_budget');
  assert.equal(fs.existsSync(card.counterexample.diff_path), true);
  assert.match(card.replay, /--case budget/);
});

test('performance-suite attributes bundles to chunks, sourcemaps, and dependencies', async () => {
  const cwd = tmpDir();
  seedBundle(cwd, 'import "react"; console.log("chunk");\n//# sourceMappingURL=app.js.map\n');
  writeJson(path.join(cwd, 'dist', 'app.js.map'), {
    version: 3,
    file: 'app.js',
    sources: ['webpack:///./src/App.tsx', 'webpack:///./node_modules/react/index.js'],
    names: [],
    mappings: '',
  });
  writeScript(path.join(cwd, 'bench.cjs'), 'console.log(JSON.stringify({ metrics: { cpu_ms: 4, peak_memory_mb: 12, render_time_ms: 10, request_formation_time_ms: 4 } }));\n');
  const goalPath = writePerformanceGoal(cwd, {
    properties: ['case_present', 'environment_preflight', 'sample_size', 'stable_benchmark', 'metric_capture', 'bundle_size', 'bundle_attribution'],
    cases: [{
      id: 'bundle-attribution',
      command: 'node bench.cjs',
      repeat: 5,
      warmup: 0,
      bundle_files: ['dist/*.js'],
      noise: { stable_metrics: ['render_time_ms'], max_cv: 0.05, min_samples: 5 },
    }],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.by_id.bundle_attribution.passed, 1);
  const bundle = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'perf', 'bundles', 'bundle-attribution.json'), 'utf8'));
  assert.equal(bundle.bundle_source_map_count, 1);
  assert.equal(bundle.bundle_dependency_source_count, 1);
});

test('performance-suite generated smoke harness runs as PASS_WITH_GAPS, not FAIL', async () => {
  const cwd = tmpDir();
  const created = createGoal({ cwd, kind: 'performance-suite', goalId: 'performance-suite', force: true });

  const { card } = await runGoalVerify(created.goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.equal(card.summary.failed, 0);
  assert.ok(card.missing_obligations.includes('bundle_size'));
  assert.ok(card.missing_obligations.includes('paired_benchmark'));
  assert.ok(card.missing_obligations.includes('baseline_update'));
  assert.ok(card.missing_obligations.includes('noise_adjusted_confidence'));
});

test('performance-suite freeze baseline writes reusable distribution baselines', async () => {
  const cwd = tmpDir();
  seedBundle(cwd);
  writeScript(path.join(cwd, 'bench.cjs'), 'console.log(JSON.stringify({ metrics: { cpu_ms: 4, peak_memory_mb: 12, render_time_ms: 30, request_formation_time_ms: 9 } }));\n');
  const goalPath = writePerformanceGoal(cwd, {
    properties: ['case_present', 'environment_preflight', 'sample_size', 'stable_benchmark', 'metric_capture', 'baseline_update'],
    cases: [{
      id: 'freeze',
      command: 'node bench.cjs',
      repeat: 5,
      warmup: 0,
    }],
  });

  const { card } = await runGoalVerify(goalPath, { cwd, updateBaselines: true });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  const baselinePath = path.join(cwd, '.xoloop', 'goals', 'perf', 'baselines', 'freeze.json');
  assert.equal(fs.existsSync(baselinePath), true);
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.ok(Array.isArray(baseline.distributions.render_time_ms));
});

test('performance-suite environment preflight can fail noisy benchmark hosts', async () => {
  const cwd = tmpDir();
  writeScript(path.join(cwd, 'bench.cjs'), 'console.log(JSON.stringify({ metrics: { render_time_ms: 1 } }));\n');
  const goalPath = writePerformanceGoal(cwd, {
    properties: ['case_present', 'environment_preflight'],
    cases: [{
      id: 'environment',
      command: 'node bench.cjs',
      repeat: 1,
      environment: {
        max_load_per_cpu: 0,
        fail_on_warning: true,
      },
    }],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'environment_preflight');
});

test('optimise metric gate uses distributions to reject improvements inside confidence interval', () => {
  const goal = {
    verify: { kind: 'performance-suite', noise: { bootstrap_iterations: 80 }, paired: true },
    metrics: {
      targets: [
        { name: 'render_time_ms_p95', direction: 'minimize', threshold: 0.05 },
      ],
    },
    acceptance: { max_metric_regression: 0.02 },
  };
  const champion = { render_time_ms_p95: 100 };
  const challenger = { render_time_ms_p95: 96 };
  const evaluation = evaluateCandidate(champion, challenger, goal, {
    distributions: {
      champion: { render_time_ms: [98, 99, 100, 101, 102] },
      challenger: { render_time_ms: [95, 96, 97, 98, 99] },
    },
  });

  assert.equal(evaluation.verdict, 'reject');
  assert.match(evaluation.reason, /did not improve/);
  assert.ok(evaluation.deltas.render_time_ms_p95.bootstrap);
});

test('performance-suite captures frontend web vitals through Playwright when enabled', { skip: !process.env.XOLOOP_RUN_PLAYWRIGHT_E2E }, async () => {
  const cwd = tmpDir();
  const port = 49300 + Math.floor(Math.random() * 1000);
  writeScript(path.join(cwd, 'server.cjs'), [
    "'use strict';",
    "const http = require('http');",
    `const port = ${port};`,
    "const html = '<!doctype html><button id=\"load\">Load</button><script>document.getElementById(\"load\").addEventListener(\"click\",()=>fetch(\"/api\",{method:\"POST\",body:JSON.stringify({ok:true})}));</script>';",
    "http.createServer((req, res) => {",
    "  if (req.url === '/api') { res.writeHead(200, {'content-type':'application/json'}); res.end('{\"ok\":true}'); return; }",
    "  res.writeHead(200, {'content-type':'text/html'}); res.end(html);",
    `}).listen(port, '127.0.0.1');`,
    '',
  ].join('\n'));
  const goalPath = writePerformanceGoal(cwd, {
    properties: ['case_present', 'environment_preflight', 'sample_size', 'stable_benchmark', 'metric_capture', 'latency_percentiles', 'render_time', 'request_formation_time', 'performance_budget'],
    cases: [{
      id: 'browser',
      url: `http://127.0.0.1:${port}/`,
      serve_command: 'node server.cjs',
      serve_ready_url: `http://127.0.0.1:${port}/`,
      actions: [{ action: 'click', selector: '#load', safe: true, settle_ms: 100 }],
      repeat: 5,
      warmup: 0,
      budgets: {
        render_time_ms_p95: { lte: 10000 },
      },
      noise: { min_samples: 5, max_cv: 2, stable_metrics: ['render_time_ms'] },
    }],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.by_id.render_time.passed, 1);
  assert.equal(card.summary.by_id.request_formation_time.passed, 1);
});
