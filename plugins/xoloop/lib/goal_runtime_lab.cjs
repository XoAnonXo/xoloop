'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LAB_SCHEMA = 'xoloop.runtime_lab_plan.v0.1';

const KNOWN_SERVICE_ORDER = ['postgres', 'mysql', 'mariadb', 'sqlite', 'redis'];

const PROVIDERS = {
  anthropic: {
    env: 'ANTHROPIC_BASE_URL',
    real_base_url: 'https://api.anthropic.com',
  },
  github: {
    env: 'GITHUB_API_BASE',
    real_base_url: 'https://api.github.com',
  },
  openai: {
    env: 'OPENAI_BASE_URL',
    real_base_url: 'https://api.openai.com',
  },
  sendgrid: {
    env: 'SENDGRID_API_BASE',
    real_base_url: 'https://api.sendgrid.com',
  },
  slack: {
    env: 'SLACK_API_BASE',
    real_base_url: 'https://slack.com/api',
  },
  stripe: {
    env: 'STRIPE_API_BASE',
    real_base_url: 'https://api.stripe.com',
  },
  twilio: {
    env: 'TWILIO_API_BASE',
    real_base_url: 'https://api.twilio.com',
  },
};

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeId(value, fallback = 'xoloop') {
  const id = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || fallback;
}

function uniqueSorted(values, order = []) {
  const seen = new Set();
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    seen.add(String(value));
  }
  const rank = new Map(order.map((value, index) => [value, index]));
  return [...seen].sort((a, b) => {
    const ar = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER;
    const br = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function collectInputs(input = {}) {
  const discovery = asObject(input.discovery);
  const scans = {
    ...asObject(discovery.scans),
    ...asObject(input.scan),
    ...asObject(input.scans),
  };
  return {
    cwd: input.cwd || discovery.cwd || scans.cwd || process.cwd(),
    goalId: input.goalId || input.goal_id || 'runtime-lab',
    scans: {
      frontend: asObject(input.frontend_scan || input.frontend || scans.frontend || scans.frontend_scan),
      api: asObject(input.api_scan || input.api || scans.api || scans.api_scan),
      state: asObject(input.state_scan || input.state || scans.state || scans.state_scan),
    },
    topology: asObject(input.repo_topology || input.topology || discovery.repo_topology),
    safety: asObject(input.safety || scans.safety || discovery.safety),
    thirdPartyProviders: asArray(input.third_party_providers || input.thirdPartyProviders),
  };
}

function commandLabel(command) {
  return String(command.name || command.id || command.command || '');
}

function commandRank(command, surface) {
  const text = commandLabel(command).toLowerCase();
  if (surface === 'frontend') {
    if (/\bdev\b/.test(text)) return 0;
    if (/\bserve\b/.test(text)) return 1;
    if (/\bpreview\b/.test(text)) return 2;
    if (/\bstart\b/.test(text)) return 3;
  }
  if (/\bstart\b/.test(text)) return 0;
  if (/\bdev\b/.test(text)) return 1;
  if (/\bserve\b/.test(text)) return 2;
  return 10;
}

function serveCommand(scan, surface) {
  const commands = asArray(scan.safe_commands)
    .filter((command) => command && command.kind === 'serve' && command.command)
    .slice()
    .sort((a, b) => {
      const rank = commandRank(a, surface) - commandRank(b, surface);
      if (rank !== 0) return rank;
      return commandLabel(a).localeCompare(commandLabel(b));
    });
  return commands[0] || null;
}

function frameworkNames(scan) {
  return asArray(scan.frameworks).map((framework) => normalizeId(framework.name || framework)).filter(Boolean);
}

function parsePort(command) {
  const text = String(command || '');
  const env = text.match(/(?:^|\s)PORT=(\d{2,5})(?:\s|$)/);
  if (env) return Number(env[1]);
  const flag = text.match(/(?:--port|-p)\s+(\d{2,5})/);
  if (flag) return Number(flag[1]);
  const listen = text.match(/listen\((\d{2,5})\)/);
  if (listen) return Number(listen[1]);
  return null;
}

function frontendPort(scan, command) {
  const parsed = parsePort(command);
  if (parsed) return parsed;
  const frameworks = new Set(frameworkNames(scan));
  if (frameworks.has('vite') || frameworks.has('svelte') || frameworks.has('solid')) return 5173;
  if (frameworks.has('next') || frameworks.has('react') || frameworks.has('remix') || frameworks.has('astro')) return 3000;
  return 5173;
}

function apiPort(command, frontend) {
  const parsed = parsePort(command);
  if (parsed) return parsed;
  return frontend ? 3001 : 3000;
}

function shellValue(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function envPrefix(env) {
  return Object.entries(env)
    .filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== '')
    .map(([key, value]) => `${key}=${shellValue(value)}`)
    .join(' ');
}

function withEnv(command, env) {
  const prefix = envPrefix(env);
  return prefix ? `${prefix} ${command}` : command;
}

function variable(name, value, source, options = {}) {
  return {
    name,
    value: String(value),
    source,
    sensitive: Boolean(options.sensitive),
    description: options.description || '',
  };
}

function upsertVariable(list, item) {
  const index = list.findIndex((existing) => existing.name === item.name);
  if (index >= 0) list[index] = { ...list[index], ...item };
  else list.push(item);
}

function normalizeServiceName(value) {
  const raw = normalizeId(value && typeof value === 'object' ? value.name || value.kind || value.service : value, '');
  if (!raw) return '';
  if (/postgres|postgresql|pg/.test(raw)) return 'postgres';
  if (/mariadb/.test(raw)) return 'mariadb';
  if (/mysql/.test(raw)) return 'mysql';
  if (/redis/.test(raw)) return 'redis';
  if (/sqlite/.test(raw)) return 'sqlite';
  return raw;
}

function collectServices(stateScan, topology) {
  const runtime = asObject(topology.runtime);
  const values = [
    ...asArray(asObject(stateScan.orchestration).services),
    ...asArray(runtime.services),
    ...asArray(stateScan.adapters).map((adapter) => adapter.kind || adapter.name),
  ].map(normalizeServiceName).filter(Boolean);
  return uniqueSorted(values, KNOWN_SERVICE_ORDER);
}

function deploymentFiles(topology, stateScan) {
  const deployment = asObject(topology.deployment);
  return uniqueSorted([
    ...asArray(asObject(stateScan.orchestration).files),
    ...asArray(deployment.files),
  ]);
}

function firstComposeFile(files) {
  return files.find((file) => /(^|\/)(docker-compose|compose)\.ya?ml$/i.test(file)) || '';
}

function buildOrchestration(stateScan, topology) {
  const orchestration = asObject(stateScan.orchestration);
  const files = deploymentFiles(topology, stateScan);
  const services = collectServices(stateScan, topology);
  const composeFile = firstComposeFile(files);
  const devcontainerFile = files.find((file) => /(^|\/)\.devcontainer\/devcontainer\.json$/i.test(file)) || '';

  if (composeFile || orchestration.suggested_start_command || /docker compose/.test(orchestration.start_command || '')) {
    const file = composeFile || 'docker-compose.yml';
    return {
      mode: 'docker-compose',
      files: files.length ? files : [file],
      services,
      start_command: orchestration.start_command || orchestration.suggested_start_command || `docker compose -f ${file} up -d`,
      ready_command: orchestration.ready_command || orchestration.suggested_ready_command || `docker compose -f ${file} ps`,
      stop_command: orchestration.stop_command || orchestration.suggested_stop_command || `docker compose -f ${file} down`,
    };
  }

  if (devcontainerFile || /devcontainer/.test(orchestration.suggested_start_command || orchestration.start_command || '')) {
    return {
      mode: 'devcontainer',
      files: files.length ? files : ['.devcontainer/devcontainer.json'],
      services,
      start_command: orchestration.start_command || orchestration.suggested_start_command || 'devcontainer up --workspace-folder .',
      ready_command: orchestration.ready_command || orchestration.suggested_ready_command || 'devcontainer read-configuration --workspace-folder .',
      stop_command: orchestration.stop_command || orchestration.suggested_stop_command || '',
    };
  }

  return {
    mode: services.length ? 'manual' : 'none',
    files,
    services,
    start_command: orchestration.start_command || '',
    ready_command: orchestration.ready_command || '',
    stop_command: orchestration.stop_command || '',
  };
}

function serviceEnvVariables(services, stateScan) {
  const adapterEnv = new Set(asArray(stateScan.adapters).flatMap((adapter) => asArray(adapter.env)));
  const vars = [];
  if (services.includes('postgres') || adapterEnv.has('DATABASE_URL')) {
    vars.push(variable('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:5432/xoloop_lab', 'runtime-lab:postgres'));
  }
  if (services.includes('mysql') || services.includes('mariadb') || adapterEnv.has('MYSQL_URL')) {
    vars.push(variable('MYSQL_URL', 'mysql://root:xoloop@127.0.0.1:3306/xoloop_lab', 'runtime-lab:mysql'));
  }
  if (services.includes('sqlite') || adapterEnv.has('SQLITE_DATABASE')) {
    vars.push(variable('SQLITE_DATABASE', '.xoloop/runtime-lab/state.sqlite', 'runtime-lab:sqlite'));
  }
  if (services.includes('redis') || adapterEnv.has('REDIS_URL')) {
    vars.push(variable('REDIS_URL', 'redis://127.0.0.1:6379/15', 'runtime-lab:redis'));
  }
  return vars;
}

function readinessForService(service) {
  if (service === 'postgres') return { id: 'postgres-ready', kind: 'command', command: 'pg_isready -d "$DATABASE_URL"', timeout_ms: 30000 };
  if (service === 'mysql' || service === 'mariadb') return { id: 'mysql-ready', kind: 'command', command: 'mysqladmin ping --protocol=tcp --host=127.0.0.1 --silent', timeout_ms: 30000 };
  if (service === 'redis') return { id: 'redis-ready', kind: 'command', command: 'redis-cli -u "$REDIS_URL" ping', timeout_ms: 30000 };
  if (service === 'sqlite') return { id: 'sqlite-ready', kind: 'file', path: '$SQLITE_DATABASE', timeout_ms: 1000 };
  return { id: `${normalizeId(service)}-ready`, kind: 'manual', command: '', timeout_ms: 30000 };
}

function buildDevServers(scans) {
  const out = [];
  const frontend = serveCommand(scans.frontend, 'frontend');
  const api = serveCommand(scans.api, 'api');
  if (frontend) {
    const port = frontendPort(scans.frontend, frontend.command);
    const apiBaseUrl = api ? `http://127.0.0.1:${apiPort(api.command, true)}` : '';
    const env = {
      HOST: '127.0.0.1',
      PORT: String(port),
      ...(apiBaseUrl ? { API_BASE_URL: apiBaseUrl } : {}),
      XOLOOP_LAB_MODE: 'isolated',
    };
    out.push({
      id: 'frontend-dev',
      surface: 'frontend',
      command: frontend.command,
      lab_command: withEnv(frontend.command, env),
      cwd: '.',
      env,
      ready: {
        id: 'frontend-dev-http',
        kind: 'http',
        url: `http://127.0.0.1:${port}/`,
        timeout_ms: 30000,
      },
      source: frontend.id || frontend.name || 'frontend-safe-command',
    });
  }
  if (api) {
    const port = apiPort(api.command, Boolean(frontend));
    const env = {
      HOST: '127.0.0.1',
      PORT: String(port),
      XOLOOP_LAB_MODE: 'isolated',
    };
    out.push({
      id: 'api-dev',
      surface: 'api',
      command: api.command,
      lab_command: withEnv(api.command, env),
      cwd: '.',
      env,
      ready: {
        id: 'api-dev-http',
        kind: 'http',
        url: `http://127.0.0.1:${port}/health`,
        timeout_ms: 30000,
      },
      source: api.id || api.name || 'api-safe-command',
    });
  }
  return out;
}

function buildSeedResetHooks(stateScan, orchestration) {
  const commands = asArray(stateScan.safe_commands);
  const reset = commands
    .filter((command) => command && command.kind === 'reset' && command.command)
    .sort((a, b) => commandLabel(a).localeCompare(commandLabel(b)));
  const seed = commands
    .filter((command) => command && command.kind === 'seed' && command.command)
    .sort((a, b) => commandLabel(a).localeCompare(commandLabel(b)));
  const beforeAll = [];
  const afterAll = [];
  if (orchestration.start_command) beforeAll.push({ id: 'orchestration-start', phase: 'before_all', command: orchestration.start_command });
  if (orchestration.ready_command) beforeAll.push({ id: 'orchestration-ready', phase: 'before_all', command: orchestration.ready_command });
  if (orchestration.stop_command) afterAll.push({ id: 'orchestration-stop', phase: 'after_all', command: orchestration.stop_command });
  const beforeEach = [
    ...reset.map((command) => ({ id: `reset-${normalizeId(command.id || command.name || command.command)}`, phase: 'before_each', command: command.command })),
    ...seed.map((command) => ({ id: `seed-${normalizeId(command.id || command.name || command.command)}`, phase: 'before_each', command: command.command })),
  ];
  const afterEach = reset.map((command) => ({ id: `reset-after-${normalizeId(command.id || command.name || command.command)}`, phase: 'after_each', command: command.command }));
  return {
    before_all: beforeAll,
    before_each: beforeEach,
    after_each: afterEach,
    after_all: afterAll,
  };
}

function tenantHeaders(apiScan) {
  return uniqueSorted(asArray(asObject(apiScan.auth_hints).tenant_headers));
}

function rolesFor(apiScan) {
  const roles = uniqueSorted(asArray(asObject(apiScan.auth_hints).roles));
  return roles.length ? roles : ['admin', 'viewer'];
}

function tenantsFor(apiScan) {
  const headers = tenantHeaders(apiScan);
  if (headers.length === 0 && asArray(asObject(apiScan.auth_hints).tenants).length > 0) {
    return uniqueSorted(asArray(asObject(apiScan.auth_hints).tenants));
  }
  return ['tenant-a', 'tenant-b'];
}

function buildFixtures(apiScan) {
  const roles = rolesFor(apiScan);
  const tenants = tenantsFor(apiScan);
  const headers = tenantHeaders(apiScan);
  const roleFixtures = roles.map((role) => ({
    id: role,
    permissions: role === 'admin' || role === 'owner' || role === 'superadmin' ? ['*'] : ['read'],
  }));
  const tenantFixtures = tenants.map((tenant, index) => ({
    id: tenant,
    name: `XOLOOP ${tenant.toUpperCase()}`,
    ordinal: index + 1,
  }));
  const users = [];
  const sessions = [];
  const matrix = [];
  for (const role of roles) {
    for (const tenant of tenants) {
      const userId = `${role}-${tenant}-user`;
      const token = `xoloop-${role}-${tenant}`;
      const requestHeaders = {
        authorization: `Bearer ${token}`,
      };
      for (const header of headers) requestHeaders[header] = tenant;
      const expectedStatuses = role === roles[0] && tenant === tenants[0] ? [200] : [403];
      users.push({
        id: userId,
        email: `${role}.${tenant}@example.invalid`,
        role,
        tenant,
        display_name: `${role} ${tenant}`,
      });
      sessions.push({
        id: `${role}-${tenant}`,
        user_id: userId,
        role,
        tenant,
        token,
        headers: requestHeaders,
      });
      matrix.push({
        id: `${role}-${tenant}`,
        role,
        tenant,
        user_id: userId,
        headers: requestHeaders,
        expected_statuses: expectedStatuses,
      });
    }
  }
  return {
    roles: roleFixtures,
    tenants: tenantFixtures,
    users,
    sessions,
    auth_session_matrix: matrix,
  };
}

function providerFromText(value) {
  const text = String(value || '').toLowerCase();
  for (const provider of Object.keys(PROVIDERS).sort()) {
    if (text.includes(provider)) return provider;
  }
  return '';
}

function providerFromItem(item) {
  if (typeof item === 'string') return providerFromText(item) || normalizeId(item, '');
  const object = asObject(item);
  if (object.provider) return normalizeId(object.provider, '');
  for (const category of asArray(object.categories)) {
    const match = String(category).match(/^provider:(.+)$/i);
    if (match) return normalizeId(match[1], '');
  }
  return providerFromText(`${object.id || ''} ${object.label || ''} ${object.source || ''}`);
}

function collectProviders(safety, explicitProviders) {
  return uniqueSorted([
    ...explicitProviders.map(providerFromItem),
    ...asArray(safety.third_party_side_effects).map(providerFromItem),
    ...asArray(safety.actions).map(providerFromItem),
    ...asArray(safety.mock_decisions).map(providerFromItem),
  ].filter(Boolean));
}

function providerConfig(provider) {
  const known = PROVIDERS[provider] || {};
  const upper = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return {
    provider,
    real_base_url: known.real_base_url || `https://${provider}.example.invalid`,
    mock_base_url: `http://127.0.0.1:4010/${provider}`,
    env: [known.env || `${upper}_API_BASE`],
    fixture: `mocks/${provider}.json`,
    vcr: `vcr/${provider}.json`,
    mode: 'mock',
  };
}

function buildThirdParty(safety, explicitProviders) {
  const providers = collectProviders(safety, explicitProviders).map(providerConfig);
  return {
    mode: providers.length ? 'mock-and-vcr-by-default' : 'none',
    mock_server: providers.length ? 'http://127.0.0.1:4010' : '',
    providers,
    routes: providers.map((provider) => ({
      provider: provider.provider,
      match: provider.real_base_url,
      target: provider.mock_base_url,
      fixture: provider.fixture,
      vcr: provider.vcr,
      mode: 'mock',
    })),
  };
}

function actionIsBlocked(action) {
  const object = asObject(action);
  const categories = asArray(object.categories).map((category) => String(category).toLowerCase());
  const text = `${object.level || ''} ${object.label || ''} ${object.id || ''}`.toLowerCase();
  return object.level === 'block'
    || categories.some((category) => ['destructive', 'sensitive_data', 'dangerous', 'production'].includes(category))
    || /\b(delete|drop|truncate|destroy|purge|charge|send real|production)\b/.test(text);
}

function buildBlocks(safety) {
  const blocks = [];
  for (const action of asArray(safety.actions)) {
    if (!actionIsBlocked(action)) continue;
    const object = asObject(action);
    blocks.push({
      id: normalizeId(object.id || object.label, 'blocked-action'),
      kind: 'runtime-action',
      label: object.label || object.id || 'blocked action',
      level: 'block',
      categories: uniqueSorted(asArray(object.categories)),
      source: object.source || '',
      reason: 'destructive or sensitive runtime action requires a mock, sandbox, or rollback proof',
    });
  }
  for (const flow of asArray(safety.sensitive_data_flows)) {
    const object = asObject(flow);
    blocks.push({
      id: normalizeId(object.id || object.label, 'sensitive-data-flow'),
      kind: 'sensitive-data-flow',
      label: object.label || object.id || 'sensitive data flow',
      level: 'block',
      categories: ['sensitive_data'],
      source: object.source || '',
      reason: asArray(object.reasons).join('; ') || 'sensitive data flow requires redaction and mock routing before runtime execution',
    });
  }
  return blocks.sort((a, b) => a.id.localeCompare(b.id));
}

function buildEnvTemplate(devServers, orchestration, stateScan, thirdParty) {
  const variables = [
    variable('XOLOOP_LAB_MODE', 'isolated', 'runtime-lab'),
    variable('NODE_ENV', 'test', 'runtime-lab'),
    variable('SESSION_SECRET', 'xoloop-runtime-lab-session-secret', 'runtime-lab', { sensitive: true }),
    variable('AUTH_SECRET', 'xoloop-runtime-lab-auth-secret', 'runtime-lab', { sensitive: true }),
  ];
  const frontend = devServers.find((server) => server.surface === 'frontend');
  const api = devServers.find((server) => server.surface === 'api');
  if (frontend) upsertVariable(variables, variable('FRONTEND_BASE_URL', frontend.ready.url, 'runtime-lab:frontend'));
  if (api) upsertVariable(variables, variable('API_BASE_URL', api.ready.url.replace(/\/health$/, ''), 'runtime-lab:api'));
  for (const item of serviceEnvVariables(orchestration.services, stateScan)) upsertVariable(variables, item);
  for (const provider of thirdParty.providers) {
    for (const envName of provider.env) upsertVariable(variables, variable(envName, provider.mock_base_url, `runtime-lab:${provider.provider}`));
  }
  return {
    file: '.xoloop/runtime-lab/lab.env.example',
    variables,
  };
}

function planAssetsSummary(thirdParty) {
  return {
    directory: '.xoloop/runtime-lab',
    files: [
      'plan.json',
      'lab.env.example',
      'commands/start.sh',
      'commands/ready.sh',
      'commands/reset.sh',
      'commands/stop.sh',
      'fixtures/users.json',
      'fixtures/tenants.json',
      'fixtures/roles.json',
      'fixtures/sessions.json',
      'fixtures/auth-matrix.json',
      'blocked-actions.json',
      ...thirdParty.providers.flatMap((provider) => [provider.fixture, provider.vcr]),
    ].sort(),
  };
}

function buildRuntimeLabPlan(input = {}) {
  const { cwd, goalId, scans, topology, safety, thirdPartyProviders } = collectInputs(input);
  const root = path.resolve(cwd || process.cwd());
  const orchestration = buildOrchestration(scans.state, topology);
  const devServers = buildDevServers(scans);
  const readinessChecks = [
    ...devServers.map((server) => server.ready),
    ...orchestration.services.map(readinessForService),
  ];
  const seedResetHooks = buildSeedResetHooks(scans.state, orchestration);
  const fixtureBundle = buildFixtures(scans.api);
  const thirdParty = buildThirdParty(safety, thirdPartyProviders);
  const blocks = buildBlocks(safety);
  const envTemplate = buildEnvTemplate(devServers, orchestration, scans.state, thirdParty);

  return {
    schema: LAB_SCHEMA,
    goal_id: goalId,
    cwd: root,
    isolation: {
      host: '127.0.0.1',
      network: 'xoloop-runtime-lab',
      data_policy: 'synthetic-fixtures-only',
      third_party_policy: thirdParty.mode,
      destructive_policy: blocks.length ? 'block-by-default' : 'monitor',
    },
    dev_servers: devServers,
    orchestration,
    env_template: envTemplate,
    seed_reset_hooks: seedResetHooks,
    readiness_checks: readinessChecks,
    fixtures: {
      roles: fixtureBundle.roles,
      tenants: fixtureBundle.tenants,
      users: fixtureBundle.users,
      sessions: fixtureBundle.sessions,
    },
    auth_session_matrix: fixtureBundle.auth_session_matrix,
    third_party: thirdParty,
    blocks,
    assets: planAssetsSummary(thirdParty),
    summary: {
      dev_server_count: devServers.length,
      service_count: orchestration.services.length,
      auth_session_count: fixtureBundle.auth_session_matrix.length,
      third_party_provider_count: thirdParty.providers.length,
      blocked_action_count: blocks.length,
    },
  };
}

function envFileContent(plan) {
  const lines = [
    '# Generated by XOLoop runtime lab planner.',
    '# Values are deterministic local defaults; replace with sandbox-only endpoints as needed.',
  ];
  for (const item of asArray(asObject(plan.env_template).variables)) {
    if (item.description) lines.push(`# ${item.description}`);
    lines.push(`${item.name}=${item.value}`);
  }
  lines.push('');
  return lines.join('\n');
}

function commandScript(commands, options = {}) {
  const lines = ['#!/usr/bin/env sh', 'set -eu'];
  if (options.chdir) lines.push(options.chdir);
  for (const line of commands.filter(Boolean)) lines.push(line);
  lines.push('');
  return lines.join('\n');
}

function buildStartCommands(plan) {
  const commands = [];
  if (plan.orchestration && plan.orchestration.start_command) commands.push(plan.orchestration.start_command);
  if (plan.orchestration && plan.orchestration.ready_command) commands.push(plan.orchestration.ready_command);
  if (plan.dev_servers.length > 0) {
    commands.push('printf "%s\\n" "Start each dev server in a separate shell:"');
    for (const server of plan.dev_servers) commands.push(`printf "%s\\n" ${JSON.stringify(server.lab_command)}`);
  }
  return commands;
}

function buildReadyCommands(plan) {
  return asArray(plan.readiness_checks).map((check) => {
    if (check.kind === 'http') return `curl -fsS ${shellValue(check.url)} >/dev/null`;
    if (check.kind === 'command') return check.command;
    if (check.kind === 'file') return `test -e ${shellValue(check.path)}`;
    return `printf "%s\\n" ${JSON.stringify(`manual readiness check: ${check.id}`)}`;
  });
}

function buildResetCommands(plan) {
  return [
    ...asArray(asObject(plan.seed_reset_hooks).before_each).map((hook) => hook.command),
    ...asArray(asObject(plan.seed_reset_hooks).after_each).map((hook) => hook.command),
  ];
}

function buildRuntimeLabAssets(plan) {
  const files = [
    { path: 'plan.json', content: stableJson(plan) },
    { path: 'lab.env.example', content: envFileContent(plan) },
    { path: 'commands/start.sh', content: commandScript(buildStartCommands(plan)), mode: 0o755 },
    { path: 'commands/ready.sh', content: commandScript(buildReadyCommands(plan)), mode: 0o755 },
    { path: 'commands/reset.sh', content: commandScript(buildResetCommands(plan)), mode: 0o755 },
    { path: 'commands/stop.sh', content: commandScript([asObject(plan.orchestration).stop_command || 'printf "%s\\n" "No orchestration stop command declared."']), mode: 0o755 },
    { path: 'fixtures/users.json', content: stableJson(asObject(plan.fixtures).users || []) },
    { path: 'fixtures/tenants.json', content: stableJson(asObject(plan.fixtures).tenants || []) },
    { path: 'fixtures/roles.json', content: stableJson(asObject(plan.fixtures).roles || []) },
    { path: 'fixtures/sessions.json', content: stableJson(asObject(plan.fixtures).sessions || []) },
    { path: 'fixtures/auth-matrix.json', content: stableJson(plan.auth_session_matrix || []) },
    { path: 'blocked-actions.json', content: stableJson({ blocks: plan.blocks || [] }) },
    {
      path: 'README.md',
      content: [
        '# Runtime lab',
        '',
        'This directory is generated from scan/topology inputs.',
        'It keeps local servers, orchestration, fixtures, mocks, VCR routes, and blocked actions together for an isolated fullstack verification run.',
        '',
      ].join('\n'),
    },
  ];

  for (const provider of asArray(asObject(plan.third_party).providers)) {
    files.push({
      path: provider.fixture,
      content: stableJson({
        schema: 'xoloop.runtime_lab_mock.v0.1',
        provider: provider.provider,
        mode: provider.mode,
        match: provider.real_base_url,
        response: { ok: true, xoloop_mock: true, provider: provider.provider },
      }),
    });
    files.push({
      path: provider.vcr,
      content: stableJson({
        schema: 'xoloop.runtime_lab_vcr.v0.1',
        provider: provider.provider,
        interactions: [],
        note: 'Record sandbox traffic only; never record production secrets.',
      }),
    });
  }

  return {
    schema: 'xoloop.runtime_lab_assets.v0.1',
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function writeRuntimeLabAssets(dir, plan) {
  const root = path.resolve(dir);
  const assets = buildRuntimeLabAssets(plan);
  const written = [];
  for (const file of assets.files) {
    const filePath = path.join(root, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf8');
    if (file.mode) fs.chmodSync(filePath, file.mode);
    written.push(filePath);
  }
  return {
    dir: root,
    files: written.sort(),
  };
}

module.exports = {
  LAB_SCHEMA,
  buildRuntimeLabAssets,
  buildRuntimeLabPlan,
  writeRuntimeLabAssets,
};
