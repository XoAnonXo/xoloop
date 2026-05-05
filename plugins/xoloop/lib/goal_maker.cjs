'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');
const { loadGoalManifest, writeGoalManifest } = require('./goal_manifest.cjs');
const { createGoal, discoverRepo } = require('./goal_verify_runner.cjs');

const SURFACE_TO_KIND = {
  api: 'api-suite',
  cli: 'cli-suite',
  concurrency: 'concurrency-suite',
  formal: 'formal-suite',
  frontend: 'frontend-suite',
  performance: 'performance-suite',
  state: 'state-suite',
  'state-machine': 'state-machine-suite',
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function readJsonMaybe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function readTextMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function sanitizeId(value, fallback = 'improve-goal') {
  const id = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return id || fallback;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function readDiscoveryLedger(cwd) {
  const filePath = path.join(path.resolve(cwd), '.xoloop', 'discovery.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function writeDiscoveryLedger(cwd, discovery) {
  return writeJson(path.join(path.resolve(cwd), '.xoloop', 'discovery.json'), discovery);
}

function normalizeIntentText(options = {}) {
  return [
    options.objective,
    options.prompt,
    options.intent,
    options.target,
    options.metric,
  ].filter(Boolean).join(' ').toLowerCase();
}

function tokenize(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'without', 'make', 'faster', 'cheaper', 'backend', 'frontend', 'database', 'state', 'api', 'app', 'repo', 'code', 'speed', 'cost', 'memory', 'size', 'less', 'more', 'better']);
  return String(text || '').toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !stop.has(word))
    .slice(0, 40);
}

function keywordScore(text, keywords) {
  const lower = String(text || '').toLowerCase();
  let score = 0;
  for (const word of keywords) {
    if (word && lower.includes(word)) score += 1;
  }
  return score;
}

function packageInfo(cwd) {
  const pkg = readJsonMaybe(path.join(cwd, 'package.json')) || {};
  const deps = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(asObject(pkg[group], {}))) deps.add(name);
  }
  return { pkg, deps };
}

function walkRepoFiles(cwd, limit = 500) {
  const out = [];
  function walk(dir) {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (['.git', 'node_modules', '.xoloop', 'dist', 'build', 'target', '__pycache__'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) out.push(path.relative(cwd, absolute).replace(/\\/g, '/'));
    }
  }
  walk(cwd);
  return out.sort();
}

function inferTarget(text, explicit = '') {
  const value = String(explicit || '').trim().toLowerCase();
  if (value) return value;
  if (/\b(frontend|ui|browser|react|vue|svelte|render|bundle|web vitals)\b/.test(text)) return 'frontend';
  if (/\b(database|db|postgres|mysql|sqlite|redis|query|migration|state)\b/.test(text)) return 'state';
  if (/\b(api|backend|server|route|endpoint|graphql|request|latency)\b/.test(text)) return 'backend';
  if (/\b(cli|command|terminal|stdout|stderr)\b/.test(text)) return 'cli';
  if (/\b(fullstack|whole app|entire app|everything|whole repo)\b/.test(text)) return 'fullstack';
  return 'repo';
}

function inferMetric(text, explicit = '') {
  const value = String(explicit || '').trim().toLowerCase();
  if (value) return value;
  if (/\b(cheap|cheaper|cost|spend|bill|billing|monthly|compute)\b/.test(text)) return 'cost';
  if (/\b(memory|rss|ram|heap)\b/.test(text)) return 'memory';
  if (/\b(bundle|size|smaller|less code|loc|complexity|dependency)\b/.test(text)) return 'size';
  if (/\b(latency|faster|speed|throughput|p95|p99|cold start|render)\b/.test(text)) return 'speed';
  return 'performance';
}

function discoveredSurfaceIds(discovery) {
  return new Set(asArray(discovery && discovery.coverage && discovery.coverage.detected_surfaces));
}

function addIfDetected(out, detected, id, options = {}) {
  if (options.force || detected.has(id)) out.add(id);
}

function selectSurfaces(discovery, intent, options = {}) {
  const detected = discoveredSurfaceIds(discovery);
  const out = new Set();
  const explicit = asArray(options.surfaces).length > 0
    ? asArray(options.surfaces)
    : String(options.surfaces || options.surface || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (explicit.length > 0) {
    for (const item of explicit) {
      const id = String(item).toLowerCase().replace(/_/g, '-');
      if (id === 'backend') {
        out.add('api');
        out.add('state');
      } else if (id === 'db' || id === 'database') out.add('state');
      else if (id === 'workflow') out.add('state-machine');
      else if (SURFACE_TO_KIND[id]) out.add(id);
    }
  }

  if (out.size === 0) {
    if (intent.target === 'frontend') {
      addIfDetected(out, detected, 'frontend', { force: true });
      addIfDetected(out, detected, 'api');
      addIfDetected(out, detected, 'state');
    } else if (intent.target === 'backend') {
      addIfDetected(out, detected, 'api', { force: true });
      addIfDetected(out, detected, 'state');
      addIfDetected(out, detected, 'concurrency');
      addIfDetected(out, detected, 'state-machine');
      addIfDetected(out, detected, 'cli');
    } else if (intent.target === 'state') {
      addIfDetected(out, detected, 'state', { force: true });
      addIfDetected(out, detected, 'api');
    } else if (intent.target === 'cli') {
      addIfDetected(out, detected, 'cli', { force: true });
      addIfDetected(out, detected, 'state');
    } else {
      for (const id of ['frontend', 'api', 'state', 'state-machine', 'concurrency', 'cli']) addIfDetected(out, detected, id);
    }
  }

  out.add('performance');
  out.add('formal');
  return [...out].filter((id) => SURFACE_TO_KIND[id]).sort();
}

function metricTargets(intent, surfaces, options = {}) {
  if (Array.isArray(options.targets) && options.targets.length > 0) return options.targets;
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.03;
  const has = (id) => surfaces.includes(id);
  const out = [];
  function target(name, direction = 'minimize', value = threshold) {
    out.push({ name, direction, threshold: value });
  }

  if (intent.metric === 'cost') {
    target('performance:monthly_cost_usd', 'minimize', 0.02);
    target('performance:cost_usd', 'minimize', 0.02);
    target('performance:cpu_ms_p95', 'minimize', threshold);
    target('performance:peak_memory_mb_p95', 'minimize', threshold);
    target('performance:wall_time_ms_p95', 'minimize', threshold);
  } else if (intent.metric === 'memory') {
    target('performance:peak_memory_mb_p95', 'minimize', threshold);
    target('performance:heap_used_mb_p95', 'minimize', threshold);
    target('performance:cpu_ms_p95', 'minimize', threshold);
  } else if (intent.metric === 'size') {
    target('performance:bundle_bytes', 'minimize', threshold);
    target('complexity_score', 'minimize', threshold);
  } else {
    target('performance:wall_time_ms_p95', 'minimize', threshold);
    target('performance:cpu_ms_p95', 'minimize', threshold);
    target('performance:cold_start_ms_p50', 'minimize', threshold);
  }

  if (has('api')) target('api:latency_ms_p95', 'minimize', threshold);
  if (has('frontend')) {
    target('performance:render_time_ms_p95', 'minimize', threshold);
    target('performance:request_formation_time_ms_p95', 'minimize', threshold);
    target('performance:bundle_bytes', 'minimize', threshold);
  }
  if (intent.metric !== 'size') target('complexity_score', 'minimize', 0.02);
  const seen = new Set();
  return out.filter((item) => {
    const key = `${item.name}|${item.direction}|${item.threshold}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectCostSignals(cwd, discovery) {
  const { pkg, deps } = packageInfo(cwd);
  const files = walkRepoFiles(cwd, 700);
  const fileText = files.slice(0, 220).map((rel) => `${rel}\n${readTextMaybe(path.join(cwd, rel)).slice(0, 4000)}`).join('\n');
  const hasDep = (patterns) => [...deps].some((name) => patterns.some((pattern) => pattern.test(name)));
  const matchingFiles = (patterns) => files.filter((file) => patterns.some((pattern) => pattern.test(file))).slice(0, 40);
  const cloudProviders = [];
  if (hasDep([/^aws-sdk$/, /^@aws-sdk\//]) || /aws_|aws:|amazonaws|lambda|ecs|dynamodb|sqs/i.test(fileText)) cloudProviders.push('aws');
  if (hasDep([/^@google-cloud\//]) || /gcp|google_project|cloud_run|pubsub|bigquery/i.test(fileText)) cloudProviders.push('gcp');
  if (hasDep([/^@azure\//]) || /azurerm_|azure|cosmosdb|servicebus/i.test(fileText)) cloudProviders.push('azure');

  const apm = [];
  if (hasDep([/dd-trace|datadog/i]) || /datadog|dd-trace/i.test(fileText)) apm.push('datadog');
  if (hasDep([/newrelic/i]) || /newrelic/i.test(fileText)) apm.push('newrelic');
  if (hasDep([/@opentelemetry\//i]) || /opentelemetry|otel/i.test(fileText)) apm.push('opentelemetry');
  if (hasDep([/prom-client|prometheus/i]) || /prometheus|prom-client/i.test(fileText)) apm.push('prometheus');

  const queueProviders = [];
  if (hasDep([/bullmq|bull|bee-queue/i]) || /bullmq|bee-queue/i.test(fileText)) queueProviders.push('redis-queue');
  if (hasDep([/amqplib|rabbitmq/i]) || /rabbitmq|amqplib/i.test(fileText)) queueProviders.push('rabbitmq');
  if (hasDep([/kafkajs|kafka/i]) || /kafka/i.test(fileText)) queueProviders.push('kafka');
  if (hasDep([/^@aws-sdk\/client-sqs$/, /^aws-sdk$/]) || /\bSQS\b|sqs:/i.test(fileText)) queueProviders.push('sqs');
  if (/celery|sidekiq/i.test(fileText)) queueProviders.push('worker-queue');

  const stateScan = scanForSurface(discovery, 'state');
  return {
    schema: 'xoloop.cost_model.v0.1',
    cloud: {
      providers: [...new Set(cloudProviders)].sort(),
      infra_files: matchingFiles([/\.tf$/i, /serverless\.(ya?ml|json)$/i, /template\.(ya?ml|json)$/i, /(^|\/)k8s\//i, /(^|\/)helm\//i, /Dockerfile$/i, /docker-compose\.ya?ml$/i]),
      env_inputs: ['XOLOOP_MONTHLY_COST_USD', 'XOLOOP_CLOUD_REQUEST_COST_USD', 'XOLOOP_EGRESS_GB'],
    },
    apm: {
      providers: [...new Set(apm)].sort(),
      env_inputs: ['XOLOOP_APM_SPAN_MS', 'XOLOOP_APM_ERROR_RATE', 'XOLOOP_APM_TRACE_COST_USD'],
    },
    database: {
      adapters: asArray(stateScan.adapters).map((adapter) => adapter.kind || adapter.name).filter(Boolean),
      tools: asArray(stateScan.tools).map((tool) => tool.name).filter(Boolean),
      schema_files: asArray(stateScan.schema_files),
      env_inputs: ['XOLOOP_DB_QUERY_COUNT', 'XOLOOP_DB_QUERY_MS', 'XOLOOP_DB_BYTES_READ', 'XOLOOP_DB_BYTES_WRITTEN'],
    },
    queues: {
      providers: [...new Set(queueProviders)].sort(),
      files: matchingFiles([/queue|worker|job|consumer|producer/i]),
      env_inputs: ['XOLOOP_QUEUE_JOB_MS', 'XOLOOP_QUEUE_DEPTH', 'XOLOOP_QUEUE_REQUEST_COST_USD'],
    },
    infra: {
      resource_files: matchingFiles([/\.tf$/i, /serverless\.(ya?ml|json)$/i, /template\.(ya?ml|json)$/i, /kustomization\.ya?ml$/i, /deployment\.ya?ml$/i]),
      env_inputs: ['XOLOOP_INFRA_RESOURCE_COUNT', 'XOLOOP_REPLICA_COUNT'],
    },
    package_scripts: asObject(pkg.scripts, {}),
  };
}

function costMetricTargets(costSignals, threshold) {
  const out = [
    { name: 'performance:monthly_cost_usd_p95', direction: 'minimize', threshold: 0.02 },
    { name: 'performance:cloud_request_cost_usd_p95', direction: 'minimize', threshold: 0.02 },
  ];
  if (asArray(costSignals.database.adapters).length > 0 || asArray(costSignals.database.tools).length > 0) {
    out.push({ name: 'performance:db_query_count_p95', direction: 'minimize', threshold });
    out.push({ name: 'performance:db_query_ms_p95', direction: 'minimize', threshold });
  }
  if (asArray(costSignals.queues.providers).length > 0) {
    out.push({ name: 'performance:queue_job_ms_p95', direction: 'minimize', threshold });
    out.push({ name: 'performance:queue_depth_p95', direction: 'minimize', threshold });
  }
  if (asArray(costSignals.apm.providers).length > 0) {
    out.push({ name: 'performance:apm_span_ms_p95', direction: 'minimize', threshold });
    out.push({ name: 'performance:apm_trace_cost_usd_p95', direction: 'minimize', threshold });
  }
  if (asArray(costSignals.infra.resource_files).length > 0) {
    out.push({ name: 'performance:infra_resource_count_p95', direction: 'minimize', threshold });
  }
  return out;
}

function buildMetricAnalysis(intent, surfaces, discovery, costSignals, chains, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.03;
  const base = metricTargets(intent, surfaces, options);
  const extra = intent.metric === 'cost' ? costMetricTargets(costSignals, threshold) : [];
  const candidates = [];
  const addCandidate = (name, source, reason) => candidates.push({ name, source, reason });
  for (const target of [...base, ...extra]) addCandidate(target.name, 'goal-target', 'declared optimisation gate metric');
  for (const chain of chains) {
    for (const metric of asArray(chain.metrics)) addCandidate(metric, `chain:${chain.id}`, 'observable bottleneck metric on selected obligation chain');
  }
  const seen = new Set();
  const targets = [...base, ...extra].filter((target) => {
    const key = `${target.name}|${target.direction}|${target.threshold}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    schema: 'xoloop.metric_analysis.v0.1',
    intent,
    keywords: tokenize(intent.raw),
    selected_targets: targets,
    candidate_metrics: candidates,
    cost_signals: costSignals,
    chain_count: chains.length,
  };
}

function scanForSurface(discovery, id) {
  if (!discovery) return {};
  if (id === 'state-machine') return asObject(discovery.surfaces && discovery.surfaces.find((surface) => surface.id === id), {}).scan || {};
  return asObject(discovery.surfaces && discovery.surfaces.find((surface) => surface.id === id), {}).scan || {};
}

function selectedArtifactPaths(discovery, surfaces) {
  const paths = new Set();
  function add(value) {
    for (const item of asArray(value)) {
      const raw = typeof item === 'string'
        ? item
        : item && typeof item === 'object' && !Array.isArray(item)
          ? item.file || item.path || item.file_path || ''
          : '';
      const rel = String(raw || '').replace(/\\/g, '/');
      if (!rel || rel.startsWith('.xoloop/')) continue;
      paths.add(rel);
    }
  }
  for (const id of surfaces) {
    const scan = scanForSurface(discovery, id);
    add(scan.artifact_paths);
    add(scan.route_files);
    add(scan.routes);
    add(scan.components);
    add(scan.state_files);
    add(scan.schema_files);
    add(scan.migration_files);
    add(scan.workflow_files);
    add(scan.model_files);
    add(scan.async_files);
    add(scan.schedule_files);
    add(scan.benchmark_files);
    add(scan.bundle_files);
    add(scan.formal_files);
  }
  add(asArray(discovery && discovery.function_verification && discovery.function_verification.files));
  add(asArray(discovery && discovery.repo_topology && discovery.repo_topology.artifact_paths));
  if (paths.size === 0) add(asArray(discovery && discovery.artifact_paths));
  return [...paths].sort().slice(0, 300);
}

function operationLabel(operation) {
  return [
    operation.id,
    operation.operationId,
    operation.method,
    operation.path,
    operation.summary,
    ...(Array.isArray(operation.tags) ? operation.tags : []),
  ].filter(Boolean).join(' ');
}

function routeLabel(route) {
  return [
    route.id,
    route.name,
    route.method,
    route.path,
    route.file,
    route.source,
  ].filter(Boolean).join(' ');
}

function topMatches(items, keywords, labelFn, limit = 5) {
  return asArray(items).map((item) => ({
    item,
    score: keywordScore(labelFn(item), keywords),
  })).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

function firstN(items, limit = 5) {
  return asArray(items).slice(0, limit);
}

function buildObligationChains(discovery, surfaces, intent, artifactPaths) {
  const keywords = tokenize(intent.raw);
  const chains = [];
  const add = (chain) => chains.push({
    schema: 'xoloop.obligation_chain.v0.1',
    ...chain,
    artifacts: asArray(chain.artifacts).filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).sort(),
    metrics: asArray(chain.metrics).filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).sort(),
    obligations: asArray(chain.obligations).filter(Boolean),
  });

  const apiScan = scanForSurface(discovery, 'api');
  const openapi = topMatches(apiScan.openapi_operations, keywords, operationLabel, 8);
  const apiRoutes = openapi.length > 0 ? openapi : firstN(apiScan.openapi_operations, 4);
  for (const operation of apiRoutes) {
    add({
      id: `api:${sanitizeId(operation.id || `${operation.method}-${operation.path}`, 'operation')}`,
      surface_path: ['api', 'performance', ...(surfaces.includes('state') ? ['state'] : [])],
      reason: 'API operation is a direct input/output contract for the objective.',
      entrypoint: { surface: 'api', method: operation.method, path: operation.path, operation_id: operation.id, source: operation.source },
      artifacts: [operation.source, ...asArray(apiScan.route_files), ...asArray(apiScan.schema_files)].slice(0, 20),
      obligations: [
        'api:request_schema',
        'api:response_schema',
        'api:status_code',
        'api:auth_invariant',
        'performance:stable_benchmark',
        'performance:latency_percentiles',
        ...(surfaces.includes('state') ? ['state:unexpected_writes', 'state:tenant_isolation'] : []),
      ],
      metrics: ['api:latency_ms_p95', 'performance:wall_time_ms_p95', 'performance:cpu_ms_p95', 'performance:db_query_ms_p95'],
    });
  }

  const routeFiles = topMatches(apiScan.route_files, keywords, (file) => file, 6);
  for (const file of routeFiles.length > 0 && apiRoutes.length === 0 ? routeFiles : []) {
    add({
      id: `api-file:${sanitizeId(file, 'route')}`,
      surface_path: ['api', 'performance'],
      reason: 'Route file text matched the objective, but no schema operation was available.',
      entrypoint: { surface: 'api', file },
      artifacts: [file],
      obligations: ['api:surface_coverage', 'api:response_schema', 'performance:stable_benchmark'],
      metrics: ['api:latency_ms_p95', 'performance:wall_time_ms_p95'],
    });
  }

  const frontendScan = scanForSurface(discovery, 'frontend');
  const frontendRoutes = topMatches(frontendScan.routes, keywords, (file) => file, 5);
  for (const file of frontendRoutes.length > 0 ? frontendRoutes : (intent.target === 'frontend' ? firstN(frontendScan.routes, 3) : [])) {
    add({
      id: `frontend:${sanitizeId(file, 'screen')}`,
      surface_path: ['frontend', 'performance', ...(surfaces.includes('api') ? ['api'] : [])],
      reason: 'Screen/page output is part of the visible input/output contract.',
      entrypoint: { surface: 'frontend', file },
      artifacts: [file, ...asArray(frontendScan.components).slice(0, 12)],
      obligations: ['frontend:visual_perception', 'frontend:semantic_dom', 'frontend:interaction_behavior', 'frontend:network_contract', 'performance:render_time'],
      metrics: ['performance:render_time_ms_p95', 'performance:request_formation_time_ms_p95', 'performance:bundle_bytes'],
    });
  }

  const stateScan = scanForSurface(discovery, 'state');
  const stateFiles = [
    ...topMatches(stateScan.schema_files, keywords, (file) => file, 5),
    ...topMatches(stateScan.state_files, keywords, (file) => file, 5),
  ].filter((value, index, arr) => arr.indexOf(value) === index);
  for (const file of stateFiles.length > 0 ? stateFiles.slice(0, 5) : (surfaces.includes('state') ? firstN(stateScan.schema_files, 3) : [])) {
    add({
      id: `state:${sanitizeId(file, 'state')}`,
      surface_path: ['state', 'api', 'performance'].filter((surface) => surfaces.includes(surface)),
      reason: 'State artifact constrains data invariants, migrations, writes, and cost-sensitive query behavior.',
      entrypoint: { surface: 'state', file },
      artifacts: [file, ...asArray(stateScan.migration_files).slice(0, 10)],
      obligations: ['state:canonical_snapshot', 'state:data_invariants', 'state:transaction_rollback', 'state:query_log', 'state:unexpected_writes'],
      metrics: ['performance:db_query_count_p95', 'performance:db_query_ms_p95', 'performance:state_size_bytes_p95'],
    });
  }

  const functionScan = discovery && discovery.function_verification ? discovery.function_verification : {};
  const functions = topMatches(functionScan.functions, keywords, (fn) => `${fn.name || ''} ${fn.file || ''} ${fn.signature || ''}`, 8);
  for (const fn of functions) {
    add({
      id: `function:${sanitizeId(fn.name || fn.file, 'function')}`,
      surface_path: ['function', 'formal', 'performance'],
      reason: 'Exported/public function matched the objective and should have direct input/output obligations before rewrite.',
      entrypoint: { surface: 'function', name: fn.name, file: fn.file, line: fn.line, language: fn.language },
      artifacts: [fn.file],
      obligations: ['function:example_oracle', 'function:property_check', 'function:fuzz_cases', 'formal:function_coverage', 'performance:stable_benchmark'],
      metrics: ['performance:wall_time_ms_p95', 'performance:cpu_ms_p95'],
    });
  }

  if (chains.length === 0) {
    add({
      id: 'repo:selected-artifacts',
      surface_path: surfaces,
      reason: 'No exact objective keyword match was found; the chain falls back to the selected observable surfaces.',
      entrypoint: { surface: 'repo', objective: intent.raw },
      artifacts: artifactPaths.slice(0, 30),
      obligations: surfaces.map((surface) => `${surface}:suite_obligation`),
      metrics: metricTargets(intent, surfaces).map((target) => target.name),
    });
  }
  return chains;
}

function firstApiEndpoint(discovery, chains, options = {}) {
  const explicit = options.url || options.baseUrl || options.base_url || '';
  const apiChain = chains.find((chain) => chain.entrypoint && chain.entrypoint.surface === 'api' && chain.entrypoint.path);
  const apiScan = scanForSurface(discovery, 'api');
  const operation = apiChain ? apiChain.entrypoint : firstN(apiScan.openapi_operations, 1)[0];
  const pathPart = operation && operation.path ? operation.path : '/';
  return {
    method: operation && operation.method ? operation.method : 'GET',
    path: pathPart,
    url: explicit ? `${String(explicit).replace(/\/$/, '')}${pathPart.startsWith('/') ? pathPart : `/${pathPart}`}` : '',
    operation_id: operation && operation.operation_id ? operation.operation_id : (operation && operation.id ? operation.id : ''),
  };
}

function benchmarkScriptText() {
  return `#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

function numberEnv(name, fallback = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    if (!url) return resolve({ statusCode: 0, bytes: 0 });
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(url, { method, timeout: numberEnv('XOLOOP_BENCH_HTTP_TIMEOUT_MS', 5000) }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, bytes }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });
    req.end();
  });
}

async function main() {
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const mode = process.env.XOLOOP_BENCH_URL ? 'http' : (process.env.XOLOOP_BENCH_COMMAND ? 'command' : 'static');
  let response = { statusCode: 0, bytes: 0 };
  if (mode === 'http') {
    response = await request(process.env.XOLOOP_BENCH_URL, process.env.XOLOOP_BENCH_METHOD || 'GET');
    if (response.statusCode >= 500) process.exitCode = 1;
  } else if (mode === 'command') {
    const child = spawnSync('bash', ['-lc', process.env.XOLOOP_BENCH_COMMAND], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: numberEnv('XOLOOP_BENCH_COMMAND_TIMEOUT_MS', 10000),
    });
    response.bytes = Buffer.byteLength(String(child.stdout || '')) + Buffer.byteLength(String(child.stderr || ''));
    if (child.status !== 0) process.exitCode = child.status || 1;
  }
  const elapsed = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const metrics = {
    wall_time_ms: elapsed,
    cpu_ms: (cpu.user + cpu.system) / 1000,
    peak_memory_mb: process.memoryUsage().rss / 1024 / 1024,
    cold_start_ms: elapsed,
    response_bytes: response.bytes,
    status_code: response.statusCode,
    monthly_cost_usd: numberEnv('XOLOOP_MONTHLY_COST_USD'),
    cloud_request_cost_usd: numberEnv('XOLOOP_CLOUD_REQUEST_COST_USD'),
    db_query_count: numberEnv('XOLOOP_DB_QUERY_COUNT'),
    db_query_ms: numberEnv('XOLOOP_DB_QUERY_MS'),
    db_bytes_read: numberEnv('XOLOOP_DB_BYTES_READ'),
    db_bytes_written: numberEnv('XOLOOP_DB_BYTES_WRITTEN'),
    queue_job_ms: numberEnv('XOLOOP_QUEUE_JOB_MS'),
    queue_depth: numberEnv('XOLOOP_QUEUE_DEPTH'),
    apm_span_ms: numberEnv('XOLOOP_APM_SPAN_MS'),
    apm_trace_cost_usd: numberEnv('XOLOOP_APM_TRACE_COST_USD'),
    infra_resource_count: numberEnv('XOLOOP_INFRA_RESOURCE_COUNT'),
    replica_count: numberEnv('XOLOOP_REPLICA_COUNT'),
  };
  process.stdout.write(JSON.stringify({ metrics }) + '\\n');
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n');
  process.exit(1);
});
`;
}

function writeBenchmarkHarness(goalDir, cwd, discovery, chains, intent, options = {}) {
  const harnessDir = path.join(goalDir, 'harnesses', 'performance');
  fs.mkdirSync(harnessDir, { recursive: true });
  const scriptPath = path.join(harnessDir, 'goal-benchmark.cjs');
  fs.writeFileSync(scriptPath, benchmarkScriptText(), 'utf8');
  fs.chmodSync(scriptPath, 0o755);
  const endpoint = firstApiEndpoint(discovery, chains, options);
  const pkg = packageInfo(cwd).pkg;
  const scripts = asObject(pkg.scripts, {});
  const benchScriptName = Object.keys(scripts).find((name) => /bench|perf|profile/i.test(name));
  const generated = {
    schema: 'xoloop.generated_benchmark.v0.1',
    command: `node ${path.relative(cwd, scriptPath).replace(/\\/g, '/')}`,
    endpoint,
    benchmark_script: benchScriptName ? `npm run ${benchScriptName}` : '',
    env: {
      XOLOOP_BENCH_URL: endpoint.url,
      XOLOOP_BENCH_METHOD: endpoint.method,
      XOLOOP_BENCH_COMMAND: benchScriptName ? `npm run ${benchScriptName}` : '',
    },
    metrics: [
      'wall_time_ms',
      'cpu_ms',
      'peak_memory_mb',
      'cold_start_ms',
      'monthly_cost_usd',
      'cloud_request_cost_usd',
      'db_query_count',
      'db_query_ms',
      'queue_job_ms',
      'apm_span_ms',
      'infra_resource_count',
    ],
  };
  writeJson(path.join(harnessDir, 'goal-benchmark.json'), generated);
  const performanceDir = path.join(goalDir, 'suites', 'performance');
  if (fs.existsSync(performanceDir)) {
    const casePath = path.join(performanceDir, 'cases', 'goal-maker-benchmark.json');
    writeJson(casePath, {
      id: 'goal-maker-benchmark',
      command: generated.command,
      env: generated.env,
      warmup: 1,
      repeat: Number.isFinite(options.repeat) ? options.repeat : 9,
      cooldown_ms: 0,
      expected_exit_code: 0,
      metrics_from_stdout: true,
      budgets: intent.metric === 'cost'
        ? { monthly_cost_usd_p95: { lte: Number.isFinite(options.maxMonthlyCostUsd) ? Number(options.maxMonthlyCostUsd) : 1000000000 } }
        : {},
      noise: {
        min_samples: 5,
        max_cv: 0.50,
        min_effect_ratio: Number.isFinite(options.threshold) ? options.threshold : 0.03,
        stable_metrics: ['wall_time_ms', 'cpu_ms'],
      },
      metadata: {
        generated_by: 'xoloop-verify make-goal',
        objective: intent.raw,
        note: 'Set XOLOOP_BENCH_URL, XOLOOP_BENCH_COMMAND, and cost/APM/DB/queue env inputs for deeper local evidence.',
      },
    });
  }
  return generated;
}

function agentOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      operations: { type: 'array', items: { type: 'object' } },
      tradeoffs: { type: 'array', items: { type: 'object' } },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'operations'],
  };
}

function codexAgentScript(goalRel) {
  return `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GOAL="$ROOT/${goalRel}"
PROMPT="$ROOT/$(dirname "${goalRel}")/agent-prompt.md"
SCHEMA="$ROOT/$(dirname "${goalRel}")/agents/agent-output.schema.json"
PAYLOAD="$(mktemp)"
FINAL="$(mktemp)"
cat > "$PAYLOAD"
if [[ -n "\${XOLOOP_AGENT_COMMAND:-}" ]]; then
  "$XOLOOP_AGENT_COMMAND" < "$PAYLOAD"
  exit 0
fi
if ! command -v codex >/dev/null 2>&1; then
  printf '{"summary":"codex command not found","operations":[],"notes":["Install Codex CLI or set XOLOOP_AGENT_COMMAND."],"tradeoffs":[]}\n'
  exit 0
fi
{
  cat "$PROMPT"
  printf '\\nGoal manifest: %s\\n' "$GOAL"
  printf '\\nOptimise payload JSON:\\n'
  cat "$PAYLOAD"
} | codex exec -C "$ROOT" --sandbox workspace-write --ask-for-approval never --output-schema "$SCHEMA" --output-last-message "$FINAL" - >/dev/null
node -e 'const fs=require("fs"); const text=fs.readFileSync(process.argv[1],"utf8").trim(); try { JSON.parse(text); process.stdout.write(text+"\\n"); } catch (_) { process.stdout.write(JSON.stringify({summary:text||"codex returned empty output",operations:[],tradeoffs:[],notes:["Codex output was not JSON; inspect the session output."]})+"\\n"); }' "$FINAL"
`;
}

function claudeAgentScript(goalRel) {
  return `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GOAL="$ROOT/${goalRel}"
PROMPT="$ROOT/$(dirname "${goalRel}")/agent-prompt.md"
SCHEMA="$ROOT/$(dirname "${goalRel}")/agents/agent-output.schema.json"
PAYLOAD="$(mktemp)"
cat > "$PAYLOAD"
if [[ -n "\${XOLOOP_AGENT_COMMAND:-}" ]]; then
  "$XOLOOP_AGENT_COMMAND" < "$PAYLOAD"
  exit 0
fi
if ! command -v claude >/dev/null 2>&1; then
  printf '{"summary":"claude command not found","operations":[],"notes":["Install Claude Code or set XOLOOP_AGENT_COMMAND."],"tradeoffs":[]}\n'
  exit 0
fi
REQUEST="$(mktemp)"
{
  cat "$PROMPT"
  printf '\\nGoal manifest: %s\\n' "$GOAL"
  printf '\\nOptimise payload JSON:\\n'
  cat "$PAYLOAD"
} > "$REQUEST"
claude --print --permission-mode acceptEdits --output-format json --json-schema "$(cat "$SCHEMA")" "$(cat "$REQUEST")" | node -e 'const fs=require("fs"); const raw=fs.readFileSync(0,"utf8").trim(); let parsed; try { parsed=JSON.parse(raw); } catch (_) { parsed=null; } const text=parsed && typeof parsed.result==="string" ? parsed.result : raw; try { JSON.parse(text); process.stdout.write(text+"\\n"); } catch (_) { process.stdout.write(JSON.stringify({summary:text||"claude returned empty output",operations:[],tradeoffs:[],notes:["Claude output was not JSON; inspect the session output."]})+"\\n"); }'
`;
}

function writeAgentTemplates(goalDir, goalPath, cwd) {
  const rel = path.relative(cwd, goalPath).replace(/\\/g, '/');
  const agentsDir = path.join(goalDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  writeJson(path.join(agentsDir, 'agent-output.schema.json'), agentOutputSchema());
  const codexPath = path.join(agentsDir, 'codex-agent-command.sh');
  const claudePath = path.join(agentsDir, 'claude-agent-command.sh');
  fs.writeFileSync(codexPath, codexAgentScript(rel), 'utf8');
  fs.writeFileSync(claudePath, claudeAgentScript(rel), 'utf8');
  fs.chmodSync(codexPath, 0o755);
  fs.chmodSync(claudePath, 0o755);
  const commands = {
    schema: 'xoloop.agent_orchestration.v0.1',
    codex_agent_command: path.relative(cwd, codexPath).replace(/\\/g, '/'),
    claude_agent_command: path.relative(cwd, claudePath).replace(/\\/g, '/'),
    optimise_with_codex: `xoloop-optimise run ${rel} --agent-command "${path.relative(cwd, codexPath).replace(/\\/g, '/')}" --rounds 10 --json`,
    optimise_with_claude: `xoloop-optimise run ${rel} --agent-command "${path.relative(cwd, claudePath).replace(/\\/g, '/')}" --rounds 10 --json`,
  };
  writeJson(path.join(agentsDir, 'orchestration.json'), commands);
  writeText(path.join(agentsDir, 'README.md'), [
    '# Agent orchestration',
    '',
    'These wrappers implement the XOLoop optimiser protocol: read payload JSON on stdin and write JSON `{ summary, operations, tradeoffs, notes }` on stdout.',
    '',
    `- Codex: \`${commands.optimise_with_codex}\``,
    `- Claude Code: \`${commands.optimise_with_claude}\``,
    '',
    'Set `XOLOOP_AGENT_COMMAND` to route through a custom agent while keeping the same protocol.',
    '',
  ].join('\n'));
  return commands;
}

function buildAgentPrompt(plan) {
  return [
    '# XOLoop improvement goal',
    '',
    `Objective: ${plan.objective}`,
    '',
    'You are proposing candidate patches for an optimisation loop. The current implementation is the champion.',
    '',
    'Hard rules:',
    '- Preserve all behavior covered by the Verify suite. Do not weaken baselines, cases, masks, budgets, or evidence.',
    '- Only edit allowed artifact paths from the goal manifest.',
    '- Return JSON only: `{ "summary": "...", "operations": [...], "tradeoffs": [...], "notes": [...] }`.',
    '- `operations` must use XOLoop operation IR: replace_exact, insert_before, insert_after, or create_file.',
    '- If an idea changes product behavior, removes a feature, relaxes a contract, weakens security, or drops data, do not patch it. Put it in `tradeoffs` instead.',
    '',
    'Tradeoff proposal shape:',
    '```json',
    '{"id":"short-id","description":"what changes","estimated_savings":"rough amount or metric","behavior_change":"what the user loses","verification_impact":"which Verify obligations/baselines would need explicit update","requires_user_approval":true}',
    '```',
    '',
    'Optimisation targets:',
    ...plan.metric_targets.map((target) => `- ${target.name}: ${target.direction} by > ${Math.round((target.threshold || 0) * 100)}% outside noise`),
    '',
    'Obligation chains:',
    ...asArray(plan.obligation_chains).slice(0, 8).map((chain) => `- ${chain.id}: ${chain.obligations.join(', ')}`),
    '',
    'Selected verification surfaces:',
    ...plan.selected_surfaces.map((surface) => `- ${surface}`),
    '',
    'Useful commands:',
    `- Verify champion/candidate: ${plan.commands.verify}`,
    `- Run loop: ${plan.commands.optimise}`,
    ...(plan.agent_orchestration ? [
      `- Run with Codex: ${plan.agent_orchestration.optimise_with_codex}`,
      `- Run with Claude Code: ${plan.agent_orchestration.optimise_with_claude}`,
    ] : []),
    '',
  ].join('\n');
}

function buildPlan({ cwd, objective, goalPath, discovery, intent, surfaces, targets, artifactPaths, chains, metricAnalysis, costSignals, benchmarkHarness, agentOrchestration, options }) {
  const goalRel = path.relative(cwd, goalPath).replace(/\\/g, '/');
  const blockingGaps = asArray(discovery.blocking_gaps).filter((gap) => gap && gap.accepted !== true);
  const plan = {
    schema: 'xoloop.goal_maker.v0.1',
    objective,
    intent,
    source: {
      discovery_path: '.xoloop/discovery.json',
      generated_from: 'discovery + user objective',
    },
    selected_surfaces: surfaces,
    selected_harnesses: surfaces.map((surface) => ({ surface, kind: SURFACE_TO_KIND[surface] })),
    metric_targets: targets,
    metric_analysis: metricAnalysis,
    cost_model: costSignals,
    obligation_chains: chains,
    generated_benchmark: benchmarkHarness,
    agent_orchestration: agentOrchestration,
    allowed_artifact_paths: artifactPaths,
    optimization_gate: {
      ready: blockingGaps.length === 0,
      blocking_gap_ids: blockingGaps.map((gap) => gap.id),
      message: blockingGaps.length === 0
        ? 'Ready to optimise after the generated goal reaches PASS_EVIDENCED.'
        : 'Discovery still has unaccepted blockers; xoloop-optimise will refuse to run until covered or accepted.',
    },
    agent_contract: {
      patch_output: '{ summary: string, operations: Operation[], tradeoffs?: Tradeoff[], notes?: string[] }',
      feature_removal_policy: 'proposal-only unless the user explicitly accepts the named tradeoff and updates verification baselines/contracts',
      no_evidence_policy: 'do not optimise when the goal card is FAIL, NO_EVIDENCE, STALE, or PASS_WITH_GAPS',
    },
    commands: {
      verify: `xoloop-verify run ${goalRel} --json`,
      card: `xoloop-verify card ${goalRel} --json`,
      optimise: `xoloop-optimise run ${goalRel} --agent-command "<agent-json-command>" --rounds 10 --json`,
    },
    notes: [
      'The generated goal is an optimisation contract: same observed behavior, better declared metrics.',
      'If the best savings require behavior changes, agents should produce tradeoff proposals rather than patches.',
    ],
    generated_at: new Date().toISOString(),
  };
  if (options && options.maxMonthlyCostUsd) {
    plan.cost_context = { current_monthly_cost_usd: Number(options.maxMonthlyCostUsd) };
  }
  return plan;
}

function makeImprovementGoal(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const objective = String(options.objective || options.prompt || options.intent || '').trim();
  if (!objective) {
    throw new AdapterError('GOAL_MAKER_OBJECTIVE_REQUIRED', 'objective', 'make-goal requires --objective "<what to improve>"');
  }
  const text = normalizeIntentText(options);
  const intent = {
    target: inferTarget(text, options.target),
    metric: inferMetric(text, options.metric),
    raw: objective,
  };
  const discovery = options.discovery || (options.useExistingDiscovery ? readDiscoveryLedger(cwd) : null) || discoverRepo(cwd, {
    acceptedGaps: options.acceptedGaps || options.accepted_gaps || [],
  });
  writeDiscoveryLedger(cwd, discovery);

  const surfaces = selectSurfaces(discovery, intent, options);
  const goalId = sanitizeId(options.goalId || options.goal_id || `${intent.target}-${intent.metric}-goal`);
  const created = createGoal({
    ...options,
    cwd,
    kind: 'suite',
    goalId,
    surfaces: surfaces.join(','),
    force: options.force === true,
  });
  const loaded = loadGoalManifest(created.goalPath);
  const artifactPaths = selectedArtifactPaths(discovery, surfaces);
  const chains = buildObligationChains(discovery, surfaces, intent, artifactPaths);
  const costSignals = detectCostSignals(cwd, discovery);
  const metricAnalysis = buildMetricAnalysis(intent, surfaces, discovery, costSignals, chains, options);
  const targets = metricAnalysis.selected_targets;
  const goalDir = path.dirname(created.goalPath);
  const benchmarkHarness = writeBenchmarkHarness(goalDir, cwd, discovery, chains, intent, options);
  const agentOrchestration = writeAgentTemplates(goalDir, created.goalPath, cwd);
  const goal = {
    ...loaded.goal,
    objective: `Improve ${intent.target} ${intent.metric}: ${objective}`,
    artifacts: {
      ...loaded.goal.artifacts,
      paths: artifactPaths.length > 0 ? artifactPaths : asArray(loaded.goal.artifacts && loaded.goal.artifacts.paths),
    },
    goal_maker: {
      schema: 'xoloop.goal_maker.v0.1',
      intent,
      selected_surfaces: surfaces,
      metric_analysis: metricAnalysis,
      cost_model_path: 'cost-model.json',
      obligation_chains_path: 'obligation-chains.json',
      generated_benchmark_path: 'harnesses/performance/goal-benchmark.json',
      agent_orchestration_path: 'agents/orchestration.json',
      obligation_chains: chains,
      generated_at: new Date().toISOString(),
    },
    verify: {
      ...loaded.goal.verify,
    },
    metrics: {
      repeat: Number.isFinite(options.repeat) ? options.repeat : (loaded.goal.metrics && loaded.goal.metrics.repeat) || 3,
      targets,
    },
    acceptance: {
      ...loaded.goal.acceptance,
      require_all_verifications: true,
      require_discovery: true,
      accepted_discovery_gaps: asArray(discovery.accepted_gaps),
      max_metric_regression: Number.isFinite(options.maxMetricRegression) ? options.maxMetricRegression : 0,
      accept_if_any_target_improves: true,
      tradeoff_policy: 'feature removals, relaxed obligations, contract changes, or user-visible degradation require explicit named user acceptance',
    },
  };
  const written = writeGoalManifest(created.goalPath, goal);
  const plan = buildPlan({
    cwd,
    objective,
    goalPath: created.goalPath,
    discovery,
    intent,
    surfaces,
    targets,
    artifactPaths: goal.artifacts.paths,
    chains,
    metricAnalysis,
    costSignals,
    benchmarkHarness,
    agentOrchestration,
    options,
  });
  writeJson(path.join(goalDir, 'metric-analysis.json'), metricAnalysis);
  writeJson(path.join(goalDir, 'cost-model.json'), costSignals);
  writeJson(path.join(goalDir, 'obligation-chains.json'), chains);
  writeJson(path.join(goalDir, 'goal-maker.json'), plan);
  writeText(path.join(goalDir, 'agent-prompt.md'), buildAgentPrompt(plan));
  writeText(path.join(goalDir, 'tradeoffs.md'), [
    '# Tradeoff proposals',
    '',
    'Agents may write or report proposal-only savings here when a cost/speed improvement requires behavior changes.',
    'Do not apply those changes until the user explicitly accepts the named tradeoff and the Verify contract is updated.',
    '',
  ].join('\n'));
  return {
    ...written,
    plan,
    discovery,
    ready: plan.optimization_gate.ready,
  };
}

module.exports = {
  inferMetric,
  inferTarget,
  makeImprovementGoal,
  metricTargets,
  selectSurfaces,
};
