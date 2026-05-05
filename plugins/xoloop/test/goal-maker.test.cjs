'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { loadGoalManifest } = require('../lib/goal_manifest.cjs');
const { makeImprovementGoal } = require('../lib/goal_maker.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-goal-maker-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeBackendRepo(cwd) {
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      start: 'node src/server.js',
      bench: 'node bench/api.bench.cjs',
      test: 'node --test',
    },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.0.0',
      tinybench: '^2.0.0',
    },
  });
  writeText(path.join(cwd, 'src/server.js'), [
    "const express = require('express');",
    "const { Pool } = require('pg');",
    'const app = express();',
    'app.use(express.json());',
    "app.get('/api/invoices', async (_req, res) => res.json([{ id: 1, total: 42 }]));",
    "app.post('/api/invoices', async (req, res) => res.status(201).json({ ok: true, body: req.body }));",
    'module.exports = { app, Pool };',
    '',
  ].join('\n'));
  writeJson(path.join(cwd, 'openapi.json'), {
    openapi: '3.0.0',
    paths: {
      '/api/invoices': {
        get: { operationId: 'listInvoices', responses: { 200: { description: 'ok' } } },
        post: { operationId: 'createInvoice', responses: { 201: { description: 'created' } } },
      },
    },
  });
  writeText(path.join(cwd, 'bench/api.bench.cjs'), [
    "const { performance } = require('node:perf_hooks');",
    "console.log(JSON.stringify({ wall_time_ms: performance.now(), cpu_ms: 1, peak_memory_mb: 1 }));",
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'db/schema.sql'), 'CREATE TABLE invoices (id integer primary key, tenant_id text, total numeric);\n');
}

function writeCostRepoWithoutBench(cwd) {
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      start: 'node src/server.js',
    },
    dependencies: {
      '@aws-sdk/client-sqs': '^3.0.0',
      'dd-trace': '^5.0.0',
      express: '^4.18.0',
      pg: '^8.0.0',
      bullmq: '^5.0.0',
    },
  });
  writeText(path.join(cwd, 'src/server.js'), [
    "const express = require('express');",
    'const app = express();',
    "app.get('/api/invoices', (_req, res) => res.json([{ id: 1 }]));",
    'module.exports = app;',
    '',
  ].join('\n'));
  writeJson(path.join(cwd, 'openapi.json'), {
    openapi: '3.0.0',
    paths: {
      '/api/invoices': {
        get: { operationId: 'listInvoices', tags: ['billing'], responses: { 200: { description: 'ok' } } },
      },
    },
  });
  writeText(path.join(cwd, 'infra/main.tf'), 'resource "aws_lambda_function" "api" { function_name = "api" }\n');
  writeText(path.join(cwd, 'src/workers/invoice.queue.js'), 'const { Queue } = require("bullmq"); module.exports = new Queue("invoice");\n');
  writeText(path.join(cwd, 'db/schema.sql'), 'CREATE TABLE invoices (id integer primary key, tenant_id text, total numeric);\n');
}

test('makeImprovementGoal turns a backend cost objective into an optimisation suite contract', () => {
  const cwd = tmpDir();
  writeBackendRepo(cwd);

  const result = makeImprovementGoal({
    cwd,
    objective: 'make backend cheaper without changing API behavior',
    target: 'backend',
    metric: 'cost',
    goalId: 'backend-cost',
    force: true,
  });
  const { goal } = loadGoalManifest(result.goalPath);

  assert.equal(goal.verify.kind, 'suite');
  assert.equal(goal.goal_maker.intent.target, 'backend');
  assert.equal(goal.goal_maker.intent.metric, 'cost');
  assert.ok(result.plan.selected_surfaces.includes('api'));
  assert.ok(result.plan.selected_surfaces.includes('performance'));
  assert.ok(result.plan.selected_surfaces.includes('formal'));
  assert.ok(goal.metrics.targets.some((target) => target.name === 'performance:cpu_ms_p95'));
  assert.ok(goal.metrics.targets.some((target) => target.name === 'performance:monthly_cost_usd'));
  assert.ok(goal.metrics.targets.some((target) => target.name === 'api:latency_ms_p95'));
  assert.ok(goal.goal_maker.obligation_chains.some((chain) => chain.id === 'api:listinvoices'));
  assert.ok(goal.artifacts.paths.includes('src/server.js'));
  assert.equal(goal.acceptance.require_discovery, true);
  assert.match(goal.acceptance.tradeoff_policy, /explicit named user acceptance/);
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'discovery.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'backend-cost', 'goal-maker.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'backend-cost', 'metric-analysis.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'backend-cost', 'obligation-chains.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'backend-cost', 'agents', 'codex-agent-command.sh')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'backend-cost', 'agents', 'claude-agent-command.sh')));
  assert.match(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'backend-cost', 'agent-prompt.md'), 'utf8'), /tradeoffs/);
});

test('makeImprovementGoal synthesizes benchmark, cost model, and obligation chains when no benchmark exists', () => {
  const cwd = tmpDir();
  writeCostRepoWithoutBench(cwd);

  const result = makeImprovementGoal({
    cwd,
    objective: 'make invoice billing endpoint cheaper',
    target: 'backend',
    metric: 'cost',
    goalId: 'invoice-cost',
    force: true,
  });
  const goalDir = path.join(cwd, '.xoloop', 'goals', 'invoice-cost');
  const costModel = JSON.parse(fs.readFileSync(path.join(goalDir, 'cost-model.json'), 'utf8'));
  const chains = JSON.parse(fs.readFileSync(path.join(goalDir, 'obligation-chains.json'), 'utf8'));
  const perfCase = JSON.parse(fs.readFileSync(path.join(goalDir, 'suites', 'performance', 'cases', 'goal-maker-benchmark.json'), 'utf8'));
  const { goal } = loadGoalManifest(result.goalPath);

  assert.deepEqual(costModel.cloud.providers, ['aws']);
  assert.ok(costModel.apm.providers.includes('datadog'));
  assert.ok(costModel.queues.providers.includes('redis-queue'));
  assert.ok(goal.metrics.targets.some((target) => target.name === 'performance:db_query_count_p95'));
  assert.ok(goal.metrics.targets.some((target) => target.name === 'performance:queue_job_ms_p95'));
  assert.ok(goal.metrics.targets.some((target) => target.name === 'performance:apm_span_ms_p95'));
  assert.ok(chains.some((chain) => chain.entrypoint.path === '/api/invoices'));
  assert.match(perfCase.command, /goal-benchmark\.cjs/);
  assert.ok(fs.existsSync(path.join(goalDir, 'harnesses', 'performance', 'goal-benchmark.cjs')));
  assert.match(result.plan.agent_orchestration.optimise_with_codex, /codex-agent-command/);
});

test('xoloop-verify make-goal exposes the goal maker through the CLI', () => {
  const cwd = tmpDir();
  writeBackendRepo(cwd);
  const cliPath = path.resolve(__dirname, '..', 'bin', 'xoloop-verify.cjs');

  const result = spawnSync(process.execPath, [
    cliPath,
    'make-goal',
    '--objective',
    'make backend faster',
    '--target',
    'backend',
    '--metric',
    'speed',
    '--goal-id',
    'backend-speed',
    '--force',
    '--json',
  ], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.plan.intent.metric, 'speed');
  assert.ok(payload.plan.metric_targets.some((target) => target.name === 'performance:wall_time_ms_p95'));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'backend-speed', 'goal.yaml')));
});
