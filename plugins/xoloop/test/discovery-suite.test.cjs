'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  discoverRepo,
  runGoalVerify,
} = require('../lib/goal_verify_runner.cjs');
const {
  artifactHash,
  evidencePathForGoal,
  manifestHash,
  writeGoalManifest,
} = require('../lib/goal_manifest.cjs');
const { appendEvidence } = require('../lib/goal_evidence.cjs');
const { runOptimiseLoop } = require('../lib/goal_optimise_runner.cjs');
const { DEFAULT_FRONTEND_OBLIGATIONS } = require('../lib/goal_frontend_suite.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-discovery-suite-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeMixedRepo(cwd) {
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      dev: 'vite --host 127.0.0.1',
      start: 'node src/server/index.js',
      build: 'vite build',
      bench: 'node bench/render.bench.js',
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      seed: 'node scripts/seed.js',
    },
    dependencies: {
      '@prisma/client': '^5.0.0',
      express: '^4.18.0',
      fastify: '^4.0.0',
      pg: '^8.0.0',
      playwright: '^1.40.0',
      react: '^18.0.0',
      'react-dom': '^18.0.0',
      vite: '^5.0.0',
      xstate: '^5.0.0',
      tinybench: '^2.0.0',
      typescript: '^5.0.0',
      eslint: '^8.0.0',
      'fast-check': '^3.0.0',
    },
    devDependencies: {},
  });
  writeText(path.join(cwd, 'src/pages/index.jsx'), 'export default function Home(){ return <button>Save</button>; }\n');
  writeText(path.join(cwd, 'src/components/Button.jsx'), 'export function Button(){ return <button aria-label="Save">Save</button>; }\n');
  writeText(path.join(cwd, 'src/server/index.js'), [
    "const express = require('express');",
    'const app = express();',
    "app.get('/api/users', (req, res) => res.json([{ id: 1 }]));",
    "app.post('/api/users', (req, res) => res.status(201).json({ ok: true }));",
    'module.exports = app;',
    '',
  ].join('\n'));
  writeJson(path.join(cwd, 'openapi.json'), {
    openapi: '3.0.0',
    paths: {
      '/api/users': {
        get: { operationId: 'listUsers', responses: { 200: { description: 'ok' } } },
        post: {
          operationId: 'createUser',
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 201: { description: 'created' } },
        },
      },
    },
  });
  writeText(path.join(cwd, 'prisma/schema.prisma'), [
    'datasource db { provider = "postgresql" url = env("DATABASE_URL") }',
    'model User { id Int @id name String tenant_id String }',
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'prisma/migrations/20240101000000_init/migration.sql'), 'CREATE TABLE users (id int primary key, tenant_id text);\n');
  writeText(path.join(cwd, 'src/jobs/queue.ts'), 'export async function run(xs){ await Promise.all(xs.map(async x => x)); setTimeout(() => {}, 1); }\n');
  writeText(path.join(cwd, 'src/machines/checkout.machine.ts'), 'export const machine = { states: { cart: {}, paid: {} } };\n');
  writeText(path.join(cwd, 'bench/render.bench.js'), 'const { performance } = require("node:perf_hooks"); console.log(performance.now());\n');
  writeText(path.join(cwd, 'dist/app.js'), 'console.log("bundle");\n');
  writeText(path.join(cwd, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  writeText(path.join(cwd, 'scripts/seed.js'), 'console.log("seed");\n');
}

function writeFrontendRepoWithGaps(cwd) {
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      dev: 'vite --host 127.0.0.1',
      build: 'vite build',
    },
    dependencies: {
      react: '^18.0.0',
      'react-dom': '^18.0.0',
      vite: '^5.0.0',
    },
  });
  writeText(path.join(cwd, 'src/pages/index.jsx'), 'export default function Home(){ return <button>Save</button>; }\n');
}

function writeTopologyAndDataflowRepo(cwd) {
  writeJson(path.join(cwd, 'package.json'), {
    workspaces: ['packages/*'],
    scripts: {
      dev: 'vite --host 127.0.0.1',
      start: 'node src/server/index.js',
      worker: 'node src/workers/user.worker.js',
      test: 'node --test',
    },
    dependencies: {
      '@prisma/client': '^5.0.0',
      bullmq: '^5.0.0',
      express: '^4.18.0',
      expo: '^50.0.0',
      pg: '^8.0.0',
      react: '^18.0.0',
      'react-native': '^0.73.0',
      vite: '^5.0.0',
    },
  });
  writeJson(path.join(cwd, 'packages/web/package.json'), {
    name: '@demo/web',
    dependencies: { '@demo/api': 'workspace:*', react: '^18.0.0' },
  });
  writeJson(path.join(cwd, 'packages/api/package.json'), {
    name: '@demo/api',
    dependencies: { '@prisma/client': '^5.0.0' },
  });
  writeText(path.join(cwd, '.github/workflows/ci.yml'), [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test',
    '      - run: npm run build',
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'docker-compose.yml'), [
    'services:',
    '  api:',
    '    build: .',
    '    ports:',
    '      - "3000:3000"',
    '    environment:',
    '      DATABASE_URL: postgres://postgres:postgres@db/app',
    '      REDIS_URL: redis://redis:6379',
    '  redis:',
    '    image: redis:7',
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'android/build.gradle'), 'plugins { id "com.android.application" }\n');
  writeText(path.join(cwd, 'src/pages/index.jsx'), 'export default function Home(){ fetch("/api/users", { method: "POST" }); return <button>Save</button>; }\n');
  writeText(path.join(cwd, 'src/server/index.js'), [
    "const express = require('express');",
    "const { Queue } = require('bullmq');",
    'const { PrismaClient } = require("@prisma/client");',
    'const app = express();',
    'const prisma = new PrismaClient();',
    'const queue = new Queue("users");',
    'app.post("/api/users", async (req, res) => {',
    '  await prisma.user.create({ data: { tenant_id: "t1" } });',
    '  await queue.add("welcome", { id: 1 });',
    '  res.json({ ok: true });',
    '});',
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'src/workers/user.worker.js'), [
    'const { PrismaClient } = require("@prisma/client");',
    'const prisma = new PrismaClient();',
    'module.exports = async function job(){ await prisma.user.update({ where: { id: 1 }, data: { seen: true } }); };',
    '',
  ].join('\n'));
}

function writeSafetyRepo(cwd) {
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      dev: 'vite --host 127.0.0.1',
      build: 'vite build',
      'deploy:prod': 'node scripts/deploy.js',
      'reset:db': 'node scripts/reset.js',
    },
    dependencies: {
      '@prisma/client': '^5.0.0',
      '@sendgrid/mail': '^8.0.0',
      express: '^4.18.0',
      react: '^18.0.0',
      stripe: '^15.0.0',
      twilio: '^5.0.0',
      vite: '^5.0.0',
    },
  });
  writeText(path.join(cwd, 'src/pages/index.jsx'), [
    'export default function Home(){',
    '  return <main>',
    '    <button data-xoloop-safe="true">Preview report</button>',
    '    <button>Delete account</button>',
    '    <form method="post" action="/api/pay" data-xoloop-mock="true" aria-label="Pay invoice">',
    '      <input type="submit" value="Pay now" />',
    '    </form>',
    '    <a href="mailto:support@example.com">Email support</a>',
    '    <button onClick={() => fetch("/api/charge", { method: "POST", body: JSON.stringify({ cardToken: "tok_123", email: "user@example.com" }) })}>Charge card</button>',
    '    <script>{fetch("https://api.stripe.com/v1/charges", { method: "POST", body: JSON.stringify({ card: "tok_123" }) })}</script>',
    '  </main>;',
    '}',
    '',
  ].join('\n'));
  writeJson(path.join(cwd, 'openapi.json'), {
    openapi: '3.0.0',
    paths: {
      '/api/report': {
        get: { operationId: 'previewReport', summary: 'Preview report', responses: { 200: { description: 'ok' } } },
      },
      '/api/users/{id}': {
        delete: { operationId: 'deleteUser', summary: 'Delete account', responses: { 204: { description: 'deleted' } } },
      },
      '/api/charge': {
        post: {
          operationId: 'chargeCard',
          summary: 'Charge payment card',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { cardToken: { type: 'string' }, email: { type: 'string' } } } } } },
          responses: { 200: { description: 'charged' } },
        },
      },
    },
  });
  writeText(path.join(cwd, 'src/server/index.js'), [
    "const express = require('express');",
    "const Stripe = require('stripe');",
    'const { PrismaClient } = require("@prisma/client");',
    "const sgMail = require('@sendgrid/mail');",
    "const twilio = require('twilio');",
    'const app = express();',
    'const prisma = new PrismaClient();',
    "const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);",
    "const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);",
    "app.get('/api/report', (req, res) => res.json({ ok: true }));",
    "app.delete('/api/users/:id', async (req, res) => res.status(204).end());",
    "app.post('/api/charge', async (req, res) => {",
    '  const cardToken = req.body.cardToken;',
    '  await prisma.payment.create({ data: { email: req.body.email, cardToken } });',
    "  await fetch('https://api.stripe.com/v1/charges', { method: 'POST', headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } });",
    "  await stripe.charges.create({ amount: 1000, currency: 'usd', source: 'tok_visa' });",
    "  await sgMail.send({ to: 'user@example.com', from: 'billing@example.com', subject: 'paid' });",
    "  await client.messages.create({ to: '+15555555555', from: '+15555555556', body: 'paid' });",
    '  res.json({ ok: true });',
    '});',
    'module.exports = app;',
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'db/migrations/20240101000000_drop_sessions.sql'), 'DROP TABLE sessions;\n');
  writeText(path.join(cwd, 'src/db/users.sql'), 'UPDATE users SET password_hash = $1, token = $2 WHERE id = $3;\n');
  writeText(path.join(cwd, 'scripts/deploy.js'), 'console.log("deploy production release");\n');
  writeText(path.join(cwd, 'scripts/reset.js'), 'console.log("reset database");\n');
}

function writeOptimiseGoal(cwd, acceptance = {}) {
  writeText(path.join(cwd, 'src/noop.cjs'), [
    '#!/usr/bin/env node',
    "console.log('ok');",
    '',
  ].join('\n'));
  const goalPath = path.join(cwd, '.xoloop', 'goals', 'noop', 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'noop',
    objective: 'noop',
    interface: {
      type: 'command-suite',
      command: 'node src/noop.cjs',
      stdin: 'none',
      stdout: 'text',
      timeout_ms: 10000,
    },
    artifacts: {
      paths: ['src/noop.cjs'],
    },
    verify: {
      kind: 'command-suite',
      commands: [
        { id: 'noop', command: 'node src/noop.cjs', expect_exit_code: 0 },
      ],
    },
    metrics: {
      repeat: 1,
      targets: [],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0,
      accept_if_any_target_improves: true,
      ...acceptance,
    },
  });
  return goalPath;
}

function writePassingFrontendHarness(cwd) {
  const goalPath = path.join(cwd, '.xoloop', 'goals', 'frontend-suite', 'goal.yaml');
  const { goal } = writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'frontend-suite',
    objective: 'frontend evidence',
    interface: {
      type: 'frontend',
      command: 'node .xoloop/goals/frontend-suite/capture-frontend.cjs',
      stdin: 'json',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: ['package.json', 'src/pages/index.jsx'],
    },
    verify: {
      kind: 'frontend-suite',
      cases: 'cases/*.json',
      properties: DEFAULT_FRONTEND_OBLIGATIONS,
    },
    metrics: {
      repeat: 1,
      targets: [],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0,
      accept_if_any_target_improves: true,
    },
  });
  appendEvidence(evidencePathForGoal(goalPath), {
    schema: 'xoloop.evidence.v0.1',
    goal_id: goal.goal_id,
    manifest_hash: manifestHash(goal),
    artifact_hash: artifactHash(goal, cwd, goalPath),
    status: 'pass',
    started_at: new Date().toISOString(),
    verifications: DEFAULT_FRONTEND_OBLIGATIONS.map((id) => ({ id, status: 'pass' })),
    summary: {
      total: DEFAULT_FRONTEND_OBLIGATIONS.length,
      passed: DEFAULT_FRONTEND_OBLIGATIONS.length,
      failed: 0,
      gaps: 0,
    },
    metrics: {},
    complexity: {},
    counterexample: null,
  });
}

function writeAgent(cwd, name, body) {
  const filePath = path.join(cwd, name);
  fs.writeFileSync(filePath, body, 'utf8');
  fs.chmodSync(filePath, 0o755);
  return `node ${JSON.stringify(filePath)}`;
}

test('discovery scan inventories observable surfaces and suggests harnesses', () => {
  const cwd = tmpDir();
  writeMixedRepo(cwd);

  const discovery = discoverRepo(cwd);

  for (const surface of ['frontend', 'api', 'state', 'state-machine', 'concurrency', 'performance', 'formal', 'cli']) {
    assert.ok(discovery.coverage.detected_surfaces.includes(surface), `expected ${surface} surface`);
  }
  assert.ok(discovery.observable_surfaces.length >= 12);
  assert.ok(discovery.automatically_verifiable.length >= 6);
  assert.ok(discovery.function_verification.functions.length >= 2);
  assert.ok(discovery.coverage.public_function_count >= 2);
  assert.equal(discovery.runtime_lab.schema, 'xoloop.runtime_lab_plan.v0.1');
  assert.ok(discovery.runtime_lab.dev_servers.length >= 2);
  assert.ok(discovery.runtime_lab.auth_session_matrix.length >= 4);
  assert.ok(discovery.observable_surfaces.some((surface) => surface.surface === 'function'));
  assert.ok(discovery.observable_surfaces.some((surface) => surface.surface === 'runtime-lab'));
  for (const kind of ['frontend-suite', 'api-suite', 'state-suite', 'state-machine-suite', 'concurrency-suite', 'performance-suite', 'formal-suite', 'cli-suite']) {
    assert.ok(discovery.suggested_harnesses.some((harness) => harness.kind === kind), `expected ${kind}`);
  }
  assert.equal(discovery.optimization_gate.blocked, true);
  assert.ok(discovery.blocking_gaps.length > 0);
});

test('discovery-suite writes gap evidence and blocks optimization by default', async () => {
  const cwd = tmpDir();
  writeFrontendRepoWithGaps(cwd);
  const created = createGoal({ cwd, kind: 'discovery-suite', goalId: 'discovery-suite', force: true });

  const { card } = await runGoalVerify(created.goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'optimization_block');
  assert.ok(card.counterexample.case_id);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'discovery.json')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'discovery-suite', 'reports', 'discovery.json')), true);
});

test('accepted discovery gaps can produce PASS_EVIDENCED for the current inventory', async () => {
  const cwd = tmpDir();
  writeFrontendRepoWithGaps(cwd);
  const initial = discoverRepo(cwd);
  const acceptedGaps = initial.blocking_gaps.map((gap) => gap.id);
  const created = createGoal({
    cwd,
    kind: 'discovery-suite',
    goalId: 'discovery-suite',
    acceptedGaps,
    force: true,
  });

  const { card } = await runGoalVerify(created.goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.metrics.blocking_gap_count, 0);
  assert.equal(card.metrics.accepted_gap_count, acceptedGaps.length);
});

test('discovery treats PASS_EVIDENCED existing harnesses as covering surface gaps', () => {
  const cwd = tmpDir();
  writeFrontendRepoWithGaps(cwd);
  writePassingFrontendHarness(cwd);

  const discovery = discoverRepo(cwd);
  const frontend = discovery.surfaces.find((surface) => surface.id === 'frontend');

  assert.equal(frontend.risk, 'covered');
  assert.ok(frontend.existing_harnesses.some((harness) => harness.verdict === 'PASS_EVIDENCED'));
  assert.ok(frontend.gaps.length > 0);
  assert.ok(frontend.gaps.every((gap) => gap.covered === true));
  assert.equal(discovery.blocking_gaps.some((gap) => gap.surface === 'frontend'), false);
  assert.ok(discovery.coverage.covered_gap_count >= frontend.gaps.length);
});

test('discovery covers gaps at mapped obligation level, not only suite level', () => {
  const cwd = tmpDir();
  writeFrontendRepoWithGaps(cwd);

  const discovery = discoverRepo(cwd, {
    existingHarnesses: [
      {
        kind: 'frontend-suite',
        goal_id: 'frontend-partial',
        goal_path: path.join(cwd, '.xoloop', 'goals', 'frontend-partial', 'goal.yaml'),
        verdict: 'PASS_WITH_GAPS',
        passed_obligations: [
          'visual_perception',
          'semantic_dom',
          'accessibility',
          'interaction_behavior',
          'network_contract',
          'event_contract',
          'console_clean',
        ],
        failed_obligations: [],
        gap_obligations: ['performance_budget'],
      },
    ],
  });
  const frontend = discovery.surfaces.find((surface) => surface.id === 'frontend');
  const browserGaps = frontend.gaps.filter((gap) => gap.type === 'frontend-browser-capture');

  assert.ok(browserGaps.length > 0);
  assert.ok(browserGaps.every((gap) => gap.covered === true));
  assert.ok(browserGaps.every((gap) => gap.covered_by.coverage_status === 'mapped_obligations_passed'));
  assert.ok(browserGaps.every((gap) => gap.covered_by.obligations.includes('visual_perception')));
});

test('discovery crawls topology, runtime services, mobile/native, monorepo graph, and dataflow', () => {
  const cwd = tmpDir();
  writeTopologyAndDataflowRepo(cwd);

  const discovery = discoverRepo(cwd);
  const gapSurfaces = new Set(discovery.gaps.map((gap) => gap.surface));

  assert.ok(discovery.repo_topology.ci.files.some((file) => file.includes('.github/workflows')));
  assert.ok(discovery.repo_topology.deployment.files.includes('docker-compose.yml'));
  assert.ok(discovery.repo_topology.runtime.services.some((service) => service.name === 'bullmq' || service.name === 'redis'));
  assert.ok(discovery.repo_topology.mobile_native.frameworks.includes('react-native'));
  assert.ok(discovery.repo_topology.monorepo.edges.some((edge) => edge.from === '@demo/web' && edge.to === '@demo/api'));
  assert.ok(discovery.dataflow.edges.some((edge) => edge.from === 'frontend' && edge.to === 'api'));
  assert.ok(discovery.dataflow.edges.some((edge) => edge.from === 'api' && edge.to === 'state'));
  assert.ok(discovery.dataflow.risky_paths.some((flow) => flow.id === 'frontend-api-state'));
  for (const surface of ['ci', 'deployment', 'runtime', 'mobile-native', 'monorepo', 'dataflow']) {
    assert.ok(gapSurfaces.has(surface), `expected ${surface} gap`);
  }
  const dataflowGap = discovery.gaps.find((gap) => gap.surface === 'dataflow');
  assert.equal(dataflowGap.severity, 'blocker');
  assert.ok(dataflowGap.coverage_requirements.some((requirement) => requirement.kind === 'api-suite'));
  assert.ok(discovery.remediation_plan.some((item) => item.gap_id === dataflowGap.id));
});

test('discovery classifies safety, destructive actions, sensitive flows, and third-party effects', () => {
  const cwd = tmpDir();
  writeSafetyRepo(cwd);

  const discovery = discoverRepo(cwd);
  const summary = discovery.safety.summary;
  const safetyGaps = discovery.gaps.filter((gap) => gap.surface === 'safety');

  assert.ok(summary.action_count >= 8);
  assert.ok(summary.safe_count > 0);
  assert.ok(summary.review_count > 0);
  assert.ok(summary.mock_count > 0);
  assert.ok(summary.block_count > 0);
  assert.ok(summary.sensitive_flow_count > 0);
  assert.ok(summary.third_party_side_effect_count > 0);
  assert.ok(summary.schema_pii_signal_count > 0);
  assert.ok(summary.static_taint_flow_count > 0);
  assert.ok(summary.call_graph_path_count > 0);
  assert.ok(discovery.safety.actions.some((action) => action.level === 'safe' && /Preview report|GET \/api\/report/.test(action.label)));
  assert.ok(discovery.safety.actions.some((action) => action.level === 'block' && /Delete account|DELETE \/api\/users/.test(action.label)));
  assert.ok(discovery.safety.actions.some((action) => action.level === 'mock' && /Pay invoice|api\/pay/.test(action.label)));
  const chargePath = discovery.safety.call_graph.paths.find((item) => item.nodes.some((node) => /api-charge/.test(node)));
  assert.ok(chargePath);
  assert.ok(chargePath.nodes.some((node) => node.startsWith('state:')));
  assert.ok(chargePath.nodes.some((node) => node.startsWith('third-party:')));
  assert.ok(discovery.safety.static_taint_flows.some((flow) => flow.sink_kind === 'database-write'));
  assert.ok(discovery.safety.static_taint_flows.some((flow) => flow.sink_kind === 'third-party-call'));
  assert.ok(discovery.safety.schema_pii_signals.some((signal) => /cardToken|email/.test(signal.path)));
  assert.ok(discovery.safety.actions.some((action) => action.categories.includes('third_party')));
  assert.ok(discovery.safety.actions.some((action) => action.categories.includes('sensitive_data')));
  assert.ok(discovery.safety.mock_decisions.some((decision) => decision.decision === 'real' && /Preview report|GET \/api\/report/.test(decision.label)));
  assert.ok(discovery.safety.mock_decisions.some((decision) => decision.decision === 'mock' && /Pay invoice|api\/pay/.test(decision.label)));
  assert.ok(discovery.safety.mock_decisions.some((decision) => decision.decision === 'block' && /Delete account|DELETE \/api\/users/.test(decision.label)));
  assert.ok(safetyGaps.length >= 4);
  assert.ok(safetyGaps.every((gap) => gap.type === 'safety-classification'));
  assert.ok(safetyGaps.some((gap) => gap.coverage_requirements.some((requirement) => requirement.kind === 'state-suite' && requirement.obligations.includes('action_safety'))));
  assert.ok(safetyGaps.some((gap) => gap.coverage_requirements.some((requirement) => requirement.kind === 'api-suite' && requirement.obligations.includes('vcr_replay'))));
  assert.ok(discovery.remediation_plan.some((item) => item.surface === 'safety'));
  assert.equal(discovery.optimization_gate.blocked, true);
});

test('discovery records when to use real systems versus mocks', () => {
  const cwd = tmpDir();
  writeSafetyRepo(cwd);

  const discovery = discoverRepo(cwd);

  assert.ok(discovery.safety.policy.safe_real_systems.some((entry) => /read-only/i.test(entry)));
  assert.ok(discovery.safety.policy.mock_when.some((entry) => /third-party/i.test(entry)));
  assert.ok(discovery.safety.policy.block_when.some((entry) => /destructive or sensitive/i.test(entry)));
  assert.ok(discovery.safety.third_party_side_effects.some((effect) => /stripe|sendgrid|twilio/i.test(effect.label)));
  assert.ok(discovery.safety.sensitive_data_flows.some((flow) => /secret|token|card|email|users\.sql/i.test(`${flow.label} ${flow.reasons.join(' ')}`)));
  assert.ok(discovery.observable_surfaces.some((surface) => surface.surface === 'safety' && /real frontend\/click: Preview report/.test(surface.description)));
  assert.ok(discovery.observable_surfaces.some((surface) => surface.surface === 'safety' && /mock frontend\/form-submit: Pay invoice/.test(surface.description)));
});

test('discovery applies user safety policy overrides', () => {
  const cwd = tmpDir();
  writeSafetyRepo(cwd);
  writeJson(path.join(cwd, '.xoloop', 'safety-policy.json'), {
    action_overrides: [
      { match: 'Delete account', decision: 'mock', reason: 'exercise mocked account deletion flow in sandbox' },
    ],
    block_patterns: ['Preview report'],
    mock_domains: ['api.stripe.com'],
    sensitive_keys: ['cardToken'],
  });

  const discovery = discoverRepo(cwd);

  assert.ok(discovery.safety.policy.policy_file.endsWith('.xoloop/safety-policy.json'));
  assert.ok(discovery.safety.actions.some((action) => /Delete account/.test(action.label) && action.level === 'mock' && action.categories.includes('policy_override')));
  assert.ok(discovery.safety.actions.some((action) => /Preview report/.test(action.label) && action.level === 'block' && action.categories.includes('policy_override')));
  assert.ok(discovery.safety.schema_pii_signals.some((signal) => signal.id.includes('policy-sensitive-key-cardtoken')));
});

test('discovery ingests runtime browser traces as safety evidence', () => {
  const cwd = tmpDir();
  writeFrontendRepoWithGaps(cwd);
  writeJson(path.join(cwd, '.xoloop', 'goals', 'frontend-suite', 'actual', 'checkout.json'), {
    schema: 'xoloop.frontend_observation.v0.1',
    interactions: [
      { action: 'click', selector: '#checkout', text: 'Checkout' },
    ],
    network: [
      { phase: 'request', method: 'POST', url: 'https://api.stripe.com/v1/charges', post_data: '{"card":"tok_123"}' },
    ],
    dom: [
      { tag: 'button', role: 'button', name: 'Checkout', selector: '#checkout' },
    ],
  });

  const discovery = discoverRepo(cwd);

  assert.ok(discovery.safety.actions.some((action) => action.surface === 'runtime' && action.kind === 'browser-network-trace' && action.level === 'mock'));
  assert.ok(discovery.safety.third_party_side_effects.some((effect) => effect.source.includes('checkout.json')));
});

test('discovery-suite writes generated safety mock, VCR, sandbox, policy, and crawl assets', () => {
  const cwd = tmpDir();
  writeSafetyRepo(cwd);

  createGoal({ cwd, kind: 'discovery-suite', goalId: 'discovery-suite', force: true });
  const goalDir = path.join(cwd, '.xoloop', 'goals', 'discovery-suite');
  const mockPlan = readJson(path.join(goalDir, 'safety', 'mock-plan.json'));

  assert.equal(fs.existsSync(path.join(goalDir, 'safety', 'policy.example.json')), true);
  assert.equal(fs.existsSync(path.join(goalDir, 'safety', 'runtime-crawl', 'frontend-safety-crawl.case.json')), true);
  assert.equal(fs.existsSync(path.join(goalDir, 'safety', 'redactions', 'schema-pii-masks.json')), true);
  assert.equal(fs.existsSync(path.join(goalDir, 'safety', 'sandboxes', 'blocked-actions.json')), true);
  assert.equal(fs.existsSync(path.join(goalDir, 'safety', 'sandbox.env.example')), true);
  assert.equal(fs.existsSync(path.join(goalDir, 'runtime-lab', 'plan.json')), true);
  assert.equal(fs.existsSync(path.join(goalDir, 'runtime-lab', 'lab.env.example')), true);
  assert.equal(fs.existsSync(path.join(goalDir, 'runtime-lab', 'commands', 'start.sh')), true);
  assert.equal(fs.existsSync(path.join(goalDir, 'runtime-lab', 'fixtures', 'auth-matrix.json')), true);
  assert.ok(mockPlan.mocks.length > 0);
  assert.ok(mockPlan.vcr_recordings.length > 0);
  assert.ok(mockPlan.sandboxes.length > 0);
  assert.ok(fs.readdirSync(path.join(goalDir, 'safety', 'mocks')).some((name) => name.endsWith('.json')));
  assert.ok(fs.readdirSync(path.join(goalDir, 'safety', 'vcr')).some((name) => name.endsWith('.json')));
});

test('optimise refuses to start when the discovery ledger has unaccepted blockers', async () => {
  const cwd = tmpDir();
  const goalPath = writeOptimiseGoal(cwd);
  writeJson(path.join(cwd, '.xoloop', 'discovery.json'), {
    schema: 'xoloop.discovery.v0.1',
    accepted_gaps: [],
    blocking_gaps: [
      { id: 'frontend:playwright-missing', surface: 'frontend', message: 'real browser capture missing' },
    ],
  });
  const agentCommand = writeAgent(cwd, 'agent.cjs', "process.stdout.write(JSON.stringify({ summary: 'noop', operations: [] }));\n");

  const summary = await runOptimiseLoop({ cwd, goalPath, agentCommand, rounds: 1 });

  assert.equal(summary.stop_reason, 'discovery_gaps_blocking');
  assert.deepEqual(summary.discovery.blocking_gap_ids, ['frontend:playwright-missing']);
});
