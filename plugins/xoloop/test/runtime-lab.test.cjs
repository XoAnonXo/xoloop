'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildRuntimeLabAssets,
  buildRuntimeLabPlan,
  writeRuntimeLabAssets,
} = require('../lib/goal_runtime_lab.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-runtime-lab-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function varValue(plan, name) {
  const variable = plan.env_template.variables.find((item) => item.name === name);
  return variable && variable.value;
}

test('runtime lab plan isolates fullstack JS frontend and API dev servers', () => {
  const plan = buildRuntimeLabPlan({
    cwd: '/workspace/demo',
    goalId: 'fullstack-lab',
    scans: {
      frontend: {
        frameworks: [{ name: 'vite' }, { name: 'react' }],
        safe_commands: [{ kind: 'serve', command: 'npm run dev' }],
        routes: ['src/pages/index.jsx'],
      },
      api: {
        frameworks: [{ name: 'express' }],
        safe_commands: [{ kind: 'serve', command: 'npm run start' }],
        openapi_operations: [{ id: 'listUsers', method: 'GET', path: '/api/users' }],
      },
      state: {
        safe_commands: [
          { kind: 'reset', command: 'npm run db:reset' },
          { kind: 'seed', command: 'npm run db:seed' },
        ],
      },
    },
  });

  assert.equal(plan.schema, 'xoloop.runtime_lab_plan.v0.1');
  assert.equal(plan.goal_id, 'fullstack-lab');
  assert.deepEqual(plan.dev_servers.map((server) => server.id), ['frontend-dev', 'api-dev']);
  assert.equal(plan.dev_servers[0].command, 'npm run dev');
  assert.match(plan.dev_servers[0].lab_command, /^HOST=127\.0\.0\.1 PORT=5173 /);
  assert.equal(plan.dev_servers[0].ready.url, 'http://127.0.0.1:5173/');
  assert.equal(plan.dev_servers[1].command, 'npm run start');
  assert.match(plan.dev_servers[1].lab_command, /^HOST=127\.0\.0\.1 PORT=3001 /);
  assert.equal(plan.dev_servers[1].ready.url, 'http://127.0.0.1:3001/health');
  assert.equal(varValue(plan, 'FRONTEND_BASE_URL'), 'http://127.0.0.1:5173/');
  assert.equal(varValue(plan, 'API_BASE_URL'), 'http://127.0.0.1:3001');
  assert.deepEqual(plan.seed_reset_hooks.before_each.map((hook) => hook.command), ['npm run db:reset', 'npm run db:seed']);
  assert.ok(plan.readiness_checks.some((check) => check.id === 'frontend-dev-http'));
  assert.ok(plan.readiness_checks.some((check) => check.id === 'api-dev-http'));
});

test('runtime lab plan derives docker compose DB and redis orchestration', () => {
  const plan = buildRuntimeLabPlan({
    cwd: '/workspace/demo',
    scans: {
      state: {
        adapters: [
          { kind: 'postgres', env: ['DATABASE_URL'] },
          { kind: 'redis', env: ['REDIS_URL'] },
        ],
        orchestration: {
          files: ['docker-compose.yml'],
          services: ['postgres', 'redis'],
          suggested_start_command: 'docker compose -f docker-compose.yml up -d',
          suggested_ready_command: 'docker compose -f docker-compose.yml ps',
          suggested_stop_command: 'docker compose -f docker-compose.yml down',
        },
      },
    },
    repo_topology: {
      deployment: { files: ['docker-compose.yml'] },
      runtime: { services: [{ name: 'postgres' }, { name: 'redis' }] },
    },
  });

  assert.equal(plan.orchestration.mode, 'docker-compose');
  assert.deepEqual(plan.orchestration.files, ['docker-compose.yml']);
  assert.deepEqual(plan.orchestration.services, ['postgres', 'redis']);
  assert.equal(plan.orchestration.start_command, 'docker compose -f docker-compose.yml up -d');
  assert.equal(plan.orchestration.ready_command, 'docker compose -f docker-compose.yml ps');
  assert.equal(plan.orchestration.stop_command, 'docker compose -f docker-compose.yml down');
  assert.equal(varValue(plan, 'DATABASE_URL'), 'postgres://postgres:postgres@127.0.0.1:5432/xoloop_lab');
  assert.equal(varValue(plan, 'REDIS_URL'), 'redis://127.0.0.1:6379/15');
  assert.ok(plan.readiness_checks.some((check) => check.id === 'postgres-ready' && check.command === 'pg_isready -d "$DATABASE_URL"'));
  assert.ok(plan.readiness_checks.some((check) => check.id === 'redis-ready' && check.command === 'redis-cli -u "$REDIS_URL" ping'));
  assert.deepEqual(plan.seed_reset_hooks.before_all.map((hook) => hook.id), ['orchestration-start', 'orchestration-ready']);
  assert.deepEqual(plan.seed_reset_hooks.after_all.map((hook) => hook.id), ['orchestration-stop']);
});

test('runtime lab plan expands auth, session, tenant, and role fixtures from API hints', () => {
  const plan = buildRuntimeLabPlan({
    scans: {
      api: {
        auth_hints: {
          roles: ['viewer', 'admin'],
          tenant_headers: ['x-tenant-id'],
        },
      },
    },
  });

  assert.deepEqual(plan.fixtures.roles.map((role) => role.id), ['admin', 'viewer']);
  assert.deepEqual(plan.fixtures.tenants.map((tenant) => tenant.id), ['tenant-a', 'tenant-b']);
  assert.deepEqual(plan.fixtures.users.map((user) => user.id), [
    'admin-tenant-a-user',
    'admin-tenant-b-user',
    'viewer-tenant-a-user',
    'viewer-tenant-b-user',
  ]);
  assert.equal(plan.auth_session_matrix.length, 4);
  assert.deepEqual(plan.auth_session_matrix[0], {
    id: 'admin-tenant-a',
    role: 'admin',
    tenant: 'tenant-a',
    user_id: 'admin-tenant-a-user',
    headers: {
      authorization: 'Bearer xoloop-admin-tenant-a',
      'x-tenant-id': 'tenant-a',
    },
    expected_statuses: [200],
  });
  assert.deepEqual(plan.auth_session_matrix[3].expected_statuses, [403]);
});

test('runtime lab plan mocks third-party providers and blocks destructive or sensitive actions', () => {
  const plan = buildRuntimeLabPlan({
    safety: {
      actions: [
        {
          id: 'delete-account',
          label: 'Delete account',
          level: 'block',
          categories: ['destructive', 'sensitive_data'],
          source: 'src/routes/users.js',
        },
      ],
      third_party_side_effects: [
        { id: 'stripe-charge', label: 'Stripe charge', provider: 'stripe', source: 'src/billing.ts' },
        { id: 'sendgrid-email', label: 'SendGrid email', categories: ['provider:sendgrid'], source: 'src/mail.ts' },
      ],
      sensitive_data_flows: [
        { id: 'card-token', label: 'cardToken leaves checkout', reasons: ['card token'] },
      ],
    },
  });

  assert.equal(plan.third_party.mode, 'mock-and-vcr-by-default');
  assert.deepEqual(plan.third_party.providers.map((provider) => provider.provider), ['sendgrid', 'stripe']);
  assert.deepEqual(plan.third_party.providers.find((provider) => provider.provider === 'stripe').env, ['STRIPE_API_BASE']);
  assert.equal(varValue(plan, 'STRIPE_API_BASE'), 'http://127.0.0.1:4010/stripe');
  assert.equal(varValue(plan, 'SENDGRID_API_BASE'), 'http://127.0.0.1:4010/sendgrid');
  assert.ok(plan.third_party.routes.some((route) => route.fixture === 'mocks/stripe.json' && route.vcr === 'vcr/stripe.json'));
  assert.ok(plan.blocks.some((block) => block.id === 'delete-account' && block.level === 'block'));
  assert.ok(plan.blocks.some((block) => block.id === 'card-token' && block.kind === 'sensitive-data-flow'));
});

test('runtime lab assets include generated commands, env templates, fixtures, mocks, and blocks', () => {
  const cwd = tmpDir();
  const plan = buildRuntimeLabPlan({
    cwd,
    goalId: 'runtime-lab',
    scans: {
      frontend: { safe_commands: [{ kind: 'serve', command: 'npm run dev' }], frameworks: [{ name: 'vite' }] },
      api: { auth_hints: { roles: ['admin'], tenant_headers: ['x-tenant'] } },
    },
    safety: {
      actions: [{ id: 'drop-table', label: 'Drop table', level: 'block', categories: ['destructive'] }],
      third_party_side_effects: [{ id: 'twilio-sms', label: 'Twilio SMS', provider: 'twilio' }],
    },
  });

  const assets = buildRuntimeLabAssets(plan);
  assert.ok(assets.files.some((file) => file.path === 'plan.json'));
  assert.ok(assets.files.some((file) => file.path === 'lab.env.example' && /TWILIO_API_BASE=/.test(file.content)));
  assert.ok(assets.files.some((file) => file.path === 'commands/start.sh' && /npm run dev/.test(file.content)));
  assert.ok(assets.files.some((file) => file.path === 'fixtures/auth-matrix.json'));
  assert.ok(assets.files.some((file) => file.path === 'mocks/twilio.json'));
  assert.ok(assets.files.some((file) => file.path === 'blocked-actions.json'));

  const written = writeRuntimeLabAssets(path.join(cwd, '.xoloop', 'goals', 'runtime-lab', 'runtime-lab'), plan);

  assert.equal(fs.existsSync(path.join(written.dir, 'plan.json')), true);
  assert.equal(fs.existsSync(path.join(written.dir, 'lab.env.example')), true);
  assert.equal(fs.existsSync(path.join(written.dir, 'commands', 'start.sh')), true);
  assert.equal(fs.existsSync(path.join(written.dir, 'fixtures', 'users.json')), true);
  assert.equal(fs.existsSync(path.join(written.dir, 'mocks', 'twilio.json')), true);
  assert.equal(fs.existsSync(path.join(written.dir, 'vcr', 'twilio.json')), true);
  assert.equal(readJson(path.join(written.dir, 'plan.json')).goal_id, 'runtime-lab');
  assert.equal(readJson(path.join(written.dir, 'blocked-actions.json')).blocks[0].id, 'drop-table');
});
