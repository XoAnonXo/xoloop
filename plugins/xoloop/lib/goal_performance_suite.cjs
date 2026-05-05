'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob, goalBaseDir, stableStringify } = require('./goal_manifest.cjs');
const { captureFrontendWithPlaywright } = require('./goal_frontend_playwright_capture.cjs');
const { scanPerformanceRepo } = require('./goal_performance_scan.cjs');

const DEFAULT_PERFORMANCE_OBLIGATIONS = [
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
];

function sanitizeId(id) {
  return String(id || 'case').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTextMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function artifactPath(goalPath, dirName, testCase, suffix = '.json') {
  return path.join(goalBaseDir(goalPath), dirName, `${sanitizeId(testCase.id)}${suffix}`);
}

function baselinePath(goalPath, testCase) {
  return artifactPath(goalPath, 'baselines', testCase);
}

function addPass(state, id, testCase, extra = {}) {
  state.verifications.push({ id, status: 'pass', case_id: testCase.id, ...extra });
}

function addGap(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'gap', case_id: testCase.id, message, ...extra });
}

function addFailure(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'fail', case_id: testCase.id, message, ...extra });
  if (!state.counterexample) {
    state.counterexample = {
      case_id: testCase.id,
      obligation: id,
      message,
      ...extra,
    };
  }
}

function loadCaseFile(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`performance-suite case must be an object: ${filePath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
    throw new Error(`performance-suite case must contain string id: ${filePath}`);
  }
  return {
    ...parsed,
    id: parsed.id.trim(),
    command: typeof parsed.command === 'string' ? parsed.command : '',
    baseline_command: typeof parsed.baseline_command === 'string' ? parsed.baseline_command : '',
    stdin: parsed.stdin == null ? '' : String(parsed.stdin),
    env: asObject(parsed.env, {}),
    baseline_env: asObject(parsed.baseline_env, {}),
    setup_command: typeof parsed.setup_command === 'string' ? parsed.setup_command : '',
    teardown_command: typeof parsed.teardown_command === 'string' ? parsed.teardown_command : '',
    serve_command: typeof parsed.serve_command === 'string' ? parsed.serve_command : '',
    serve_ready_url: typeof parsed.serve_ready_url === 'string' ? parsed.serve_ready_url : '',
    url: typeof parsed.url === 'string' ? parsed.url : '',
    browser: typeof parsed.browser === 'string' ? parsed.browser : '',
    viewport: parsed.viewport && typeof parsed.viewport === 'object' && !Array.isArray(parsed.viewport) ? parsed.viewport : parsed.viewport,
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    discover_safe_actions: parsed.discover_safe_actions === true,
    expected_exit_code: Number.isInteger(parsed.expected_exit_code) ? parsed.expected_exit_code : 0,
    warmup: Number.isFinite(parsed.warmup) && parsed.warmup >= 0 ? Math.floor(parsed.warmup) : null,
    repeat: Number.isFinite(parsed.repeat) && parsed.repeat > 0 ? Math.floor(parsed.repeat) : null,
    cooldown_ms: Number.isFinite(parsed.cooldown_ms) && parsed.cooldown_ms >= 0 ? Math.floor(parsed.cooldown_ms) : null,
    timeout_ms: Number.isFinite(parsed.timeout_ms) && parsed.timeout_ms > 0 ? Math.floor(parsed.timeout_ms) : null,
    max_buffer: Number.isFinite(parsed.max_buffer) && parsed.max_buffer > 0 ? Math.floor(parsed.max_buffer) : null,
    metrics_from_stdout: parsed.metrics_from_stdout !== false,
    metric_map: asObject(parsed.metric_map, {}),
    budgets: asObject(parsed.budgets || parsed.performance_budgets, {}),
    baseline: asObject(parsed.baseline || parsed.baselines, {}),
    baseline_file: typeof parsed.baseline_file === 'string' ? parsed.baseline_file : '',
    improvement_targets: parsed.improvement_targets || parsed.targets || null,
    noise: asObject(parsed.noise, {}),
    paired: parsed.paired === true || (parsed.paired && typeof parsed.paired === 'object' && !Array.isArray(parsed.paired)) ? parsed.paired : false,
    environment: asObject(parsed.environment, {}),
    bundle_files: Array.isArray(parsed.bundle_files) ? parsed.bundle_files.map(String) : [],
  };
}

function buildCommand(goal, testCase) {
  return testCase.command || goal.verify.command || goal.interface.command;
}

function parseTimeOutput(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(real|user|sys)\s+([0-9.]+)$/);
    if (!match) continue;
    out[match[1]] = Number(match[2]);
  }
  const metrics = {};
  if (Number.isFinite(out.real)) metrics.wall_time_ms = out.real * 1000;
  if (Number.isFinite(out.user)) metrics.cpu_user_ms = out.user * 1000;
  if (Number.isFinite(out.sys)) metrics.cpu_system_ms = out.sys * 1000;
  if (Number.isFinite(metrics.cpu_user_ms) || Number.isFinite(metrics.cpu_system_ms)) {
    metrics.cpu_ms = (metrics.cpu_user_ms || 0) + (metrics.cpu_system_ms || 0);
  }
  return metrics;
}

async function runMeasuredCommand(command, input, options = {}) {
  const timeBin = fs.existsSync('/usr/bin/time') ? '/usr/bin/time' : '';
  if (!timeBin) return runCliCommand(command, input, options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-perf-time-'));
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  const timePath = path.join(dir, 'time.txt');
  const inner = `${command} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`;
  const wrapper = `${shellQuote(timeBin)} -p bash -lc ${shellQuote(inner)} 2> ${shellQuote(timePath)}`;
  try {
    const result = await runCliCommand(wrapper, input, options);
    const stdout = readTextMaybe(stdoutPath);
    const stderr = readTextMaybe(stderrPath);
    const timeMetrics = parseTimeOutput(readTextMaybe(timePath));
    return {
      ...result,
      stdout,
      stderr: stderr || result.stderr,
      metrics: {
        ...result.metrics,
        ...timeMetrics,
      },
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
}

function parseJsonFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      if (!/^[{[]/.test(line)) continue;
      try {
        return JSON.parse(line);
      } catch (__err) {
        // Keep looking for a JSON metrics line.
      }
    }
  }
  return null;
}

function normalizeMetricName(name) {
  const key = String(name || '').trim();
  const aliases = {
    cpu: 'cpu_ms',
    cpuTime: 'cpu_ms',
    cpu_time_ms: 'cpu_ms',
    memory_mb: 'peak_memory_mb',
    memory: 'peak_memory_mb',
    peak_rss_mb: 'peak_memory_mb',
    bundle_size: 'bundle_bytes',
    bundleSize: 'bundle_bytes',
    cold_start: 'cold_start_ms',
    coldStartMs: 'cold_start_ms',
    cold_start_time_ms: 'cold_start_ms',
    render_ms: 'render_time_ms',
    renderTimeMs: 'render_time_ms',
    request_formation_ms: 'request_formation_time_ms',
    requestFormationMs: 'request_formation_time_ms',
  };
  return aliases[key] || key;
}

function extractStdoutMetrics(stdout, metricMap = {}) {
  const parsed = parseJsonFromText(stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const source = parsed.metrics && typeof parsed.metrics === 'object' && !Array.isArray(parsed.metrics)
    ? parsed.metrics
    : parsed;
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const mapped = metricMap[rawKey] || normalizeMetricName(rawKey);
    const value = Number(rawValue);
    if (Number.isFinite(value)) out[mapped] = value;
  }
  return out;
}

async function executeCommandSample(goal, testCase, cwd, phase, index, overrides = {}) {
  const command = overrides.command || buildCommand(goal, testCase);
  const result = await runMeasuredCommand(command, overrides.stdin === undefined ? testCase.stdin : overrides.stdin, {
    cwd,
    env: { ...testCase.env, ...(overrides.env || {}) },
    timeoutMs: testCase.timeout_ms || goal.interface.timeout_ms,
    maxBuffer: testCase.max_buffer || 32 * 1024 * 1024,
  });
  const stdoutMetrics = testCase.metrics_from_stdout
    ? extractStdoutMetrics(result.stdout, testCase.metric_map)
    : {};
  const metrics = {
    ...result.metrics,
    ...stdoutMetrics,
  };
  if (phase === 'measure' && index === 0 && !Number.isFinite(metrics.cold_start_ms)) {
    metrics.cold_start_ms = metrics.wall_time_ms;
  }
  return {
    phase,
    index,
    command,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout_tail: String(result.stdout || '').slice(-2000),
    stderr_tail: String(result.stderr || '').slice(-2000),
    metrics,
  };
}

function playwrightMetricsFromObservation(observation) {
  const perf = asObject(observation && observation.performance, {});
  const out = {};
  for (const [key, value] of Object.entries(perf)) {
    const metric = normalizeMetricName(key);
    if (Number.isFinite(value)) out[metric] = value;
  }
  if (Number.isFinite(out.render_time_ms) && !Number.isFinite(out.cold_start_ms)) out.cold_start_ms = out.render_time_ms;
  return out;
}

async function executePlaywrightSample(goal, testCase, cwd, phase, index) {
  const observation = await captureFrontendWithPlaywright({
    ...testCase,
    url: testCase.url || goal.verify.url,
    browser: testCase.browser || goal.verify.browser || 'chromium',
    viewport: testCase.viewport || goal.verify.viewport || { width: 1440, height: 900 },
    actions: testCase.actions,
    discover_safe_actions: testCase.discover_safe_actions,
    timeout_ms: testCase.timeout_ms || goal.interface.timeout_ms,
  }, {
    browser: testCase.browser || goal.verify.browser || 'chromium',
  });
  return {
    phase,
    index,
    url: observation.url,
    exit_code: 0,
    timed_out: false,
    stdout_tail: '',
    stderr_tail: '',
    metrics: playwrightMetricsFromObservation(observation),
    observation: {
      browser: observation.browser,
      viewport: observation.viewport,
      network_count: Array.isArray(observation.network) ? observation.network.length : 0,
      console_count: Array.isArray(observation.console) ? observation.console.length : 0,
      performance: observation.performance,
    },
  };
}

async function executeSample(goal, testCase, cwd, phase, index, overrides = {}) {
  if (testCase.url || goal.verify.url) return executePlaywrightSample(goal, testCase, cwd, phase, index);
  return executeCommandSample(goal, testCase, cwd, phase, index, overrides);
}

function percentile(sortedValues, q) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(q * sortedValues.length) - 1));
  return sortedValues[index];
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function summarizeSamples(samples) {
  const byName = {};
  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample.metrics || {})) {
      if (!Number.isFinite(value)) continue;
      const key = normalizeMetricName(name);
      if (!byName[key]) byName[key] = [];
      byName[key].push(value);
    }
  }
  const summary = {};
  const distributions = {};
  for (const [name, values] of Object.entries(byName)) {
    const sorted = values.slice().sort((a, b) => a - b);
    const avg = mean(sorted);
    const sd = stddev(sorted);
    summary[`${name}_p50`] = percentile(sorted, 0.50);
    summary[`${name}_p95`] = percentile(sorted, 0.95);
    summary[`${name}_p99`] = percentile(sorted, 0.99);
    summary[`${name}_mean`] = avg;
    summary[`${name}_stddev`] = sd;
    summary[`${name}_cv`] = avg && avg !== 0 ? Math.abs(sd / avg) : 0;
    summary[`${name}_min`] = sorted[0];
    summary[`${name}_max`] = sorted[sorted.length - 1];
    summary[`${name}_samples`] = sorted.length;
    if (!Object.prototype.hasOwnProperty.call(summary, name)) summary[name] = percentile(sorted, 0.50);
    distributions[name] = sorted;
  }
  return { summary, distributions };
}

function walkFiles(root) {
  const out = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (['.git', 'node_modules', '.xoloop'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  }
  walk(root);
  return out;
}

function patternToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::DOUBLE_STAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function resolveBundleFiles(cwd, patterns) {
  const root = path.resolve(cwd);
  const all = walkFiles(root);
  const matched = new Set();
  for (const pattern of patterns) {
    const absolute = path.resolve(root, pattern);
    if (fs.existsSync(absolute)) {
      const stat = fs.statSync(absolute);
      if (stat.isFile()) matched.add(absolute);
      else if (stat.isDirectory()) for (const file of walkFiles(absolute)) matched.add(file);
      continue;
    }
    const re = patternToRegExp(String(pattern).replace(/\\/g, '/'));
    for (const file of all) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      if (re.test(rel)) matched.add(file);
    }
  }
  return [...matched].sort();
}

function measureBundleFiles(cwd, goal, testCase) {
  const patterns = [
    ...asArray(goal.verify.bundle_files).map(String),
    ...testCase.bundle_files,
  ].filter(Boolean);
  if (patterns.length === 0) return null;
  const files = resolveBundleFiles(cwd, patterns);
  let bytes = 0;
  let gzipBytes = 0;
  const chunks = [];
  const dependencySources = new Set();
  let sourceCount = 0;
  let sourceMapCount = 0;
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    const rel = path.relative(cwd, file).replace(/\\/g, '/');
    const mapFile = fs.existsSync(`${file}.map`) ? `${file}.map` : '';
    let sources = [];
    if (mapFile) {
      const parsed = parseJsonFromText(readTextMaybe(mapFile));
      if (parsed && Array.isArray(parsed.sources)) {
        sourceMapCount += 1;
        sources = parsed.sources.map(String);
        sourceCount += sources.length;
        for (const source of sources) {
          if (/node_modules|webpack:\/\/\/\.\/node_modules|\/npm\//.test(source)) dependencySources.add(source);
        }
      }
    }
    bytes += buffer.length;
    const gz = zlib.gzipSync(buffer).length;
    gzipBytes += gz;
    chunks.push({
      path: rel,
      bytes: buffer.length,
      gzip_bytes: gz,
      type: path.extname(file).replace(/^\./, '') || 'asset',
      source_map: mapFile ? path.relative(cwd, mapFile).replace(/\\/g, '/') : '',
      source_count: sources.length,
      dependency_source_count: sources.filter((source) => /node_modules|webpack:\/\/\/\.\/node_modules|\/npm\//.test(source)).length,
    });
  }
  chunks.sort((a, b) => b.bytes - a.bytes);
  return {
    bundle_file_count: files.length,
    bundle_bytes: bytes,
    bundle_gzip_bytes: gzipBytes,
    bundle_largest_chunk_bytes: chunks[0] ? chunks[0].bytes : 0,
    bundle_chunk_count: chunks.length,
    bundle_source_map_count: sourceMapCount,
    bundle_source_count: sourceCount,
    bundle_dependency_source_count: dependencySources.size,
    bundle_dependency_sources: [...dependencySources].sort().slice(0, 50),
    bundle_files: files.map((file) => path.relative(cwd, file).replace(/\\/g, '/')),
    chunks,
  };
}

function metricValue(summary, metricName) {
  const name = normalizeMetricName(metricName);
  if (Number.isFinite(summary[name])) return summary[name];
  if (Number.isFinite(summary[`${name}_p50`])) return summary[`${name}_p50`];
  return null;
}

function metricDirection(metricName, fallback = 'minimize') {
  if (/throughput|ops_per_sec|requests_per_second|score/i.test(metricName)) return 'maximize';
  return fallback === 'maximize' ? 'maximize' : 'minimize';
}

function normalizeTargets(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([metric, config]) => ({
      metric,
      ...(config && typeof config === 'object' && !Array.isArray(config) ? config : { min_improvement_ratio: Number(config) }),
    }));
  }
  return [];
}

function baselineEntry(baseline, metricName) {
  const direct = baseline[metricName];
  if (Number.isFinite(direct)) return { value: direct };
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    const value = Number.isFinite(direct.value) ? direct.value
      : Number.isFinite(direct.p50) ? direct.p50
        : Number.isFinite(direct.median) ? direct.median
          : null;
    return {
      value,
      stddev: Number.isFinite(direct.stddev) ? direct.stddev : null,
      samples: Number.isFinite(direct.samples) ? direct.samples : null,
    };
  }
  const normalized = normalizeMetricName(metricName);
  if (normalized !== metricName) return baselineEntry(baseline, normalized);
  return { value: null };
}

function baselineFromSummary(summary = {}, distributions = {}) {
  const out = {};
  for (const [key, value] of Object.entries(summary || {})) {
    if (!Number.isFinite(value)) continue;
    const baseMetric = distributionNameForMetric(key);
    out[key] = {
      value,
      stddev: Number.isFinite(summary[`${baseMetric}_stddev`]) ? summary[`${baseMetric}_stddev`] : null,
      samples: Number.isFinite(summary[`${baseMetric}_samples`]) ? summary[`${baseMetric}_samples`] : (Array.isArray(distributions[baseMetric]) ? distributions[baseMetric].length : null),
    };
  }
  return out;
}

function readBaselineArtifact(goalPath, testCase, cwd) {
  const candidates = [];
  if (testCase.baseline_file) candidates.push(path.isAbsolute(testCase.baseline_file) ? testCase.baseline_file : path.resolve(goalBaseDir(goalPath), testCase.baseline_file));
  candidates.push(baselinePath(goalPath, testCase));
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = readJson(file);
      return {
        file,
        summary: asObject(parsed.summary, {}),
        distributions: asObject(parsed.distributions, {}),
        baseline: baselineFromSummary(asObject(parsed.summary, {}), asObject(parsed.distributions, {})),
      };
    } catch (_err) {
      // Ignore stale or malformed baseline files; missing baseline stays visible as a gap.
    }
  }
  return { file: '', summary: {}, distributions: {}, baseline: {} };
}

function noiseConfig(goal, testCase) {
  const config = { ...asObject(goal.verify.noise, {}), ...testCase.noise };
  return {
    min_samples: Number.isFinite(config.min_samples) && config.min_samples > 0 ? Math.floor(config.min_samples) : 5,
    max_cv: Number.isFinite(config.max_cv) && config.max_cv >= 0 ? config.max_cv : 0.35,
    min_effect_ratio: Number.isFinite(config.min_effect_ratio) && config.min_effect_ratio >= 0 ? config.min_effect_ratio : 0.03,
    max_regression_ratio: Number.isFinite(config.max_regression_ratio) && config.max_regression_ratio >= 0 ? config.max_regression_ratio : 0.02,
    confidence_z: Number.isFinite(config.confidence_z) && config.confidence_z > 0 ? config.confidence_z : 1.96,
    bootstrap_iterations: Number.isFinite(config.bootstrap_iterations) && config.bootstrap_iterations > 0 ? Math.floor(config.bootstrap_iterations) : 400,
    stable_metrics: Array.isArray(config.stable_metrics) && config.stable_metrics.length > 0 ? config.stable_metrics.map(String) : ['wall_time_ms'],
  };
}

function environmentConfig(goal, testCase) {
  const config = { ...asObject(goal.verify.environment, {}), ...testCase.environment };
  return {
    max_load_1m: Number.isFinite(config.max_load_1m) && config.max_load_1m >= 0 ? config.max_load_1m : null,
    max_load_per_cpu: Number.isFinite(config.max_load_per_cpu) && config.max_load_per_cpu >= 0 ? config.max_load_per_cpu : 4,
    require_ac_power: config.require_ac_power === true,
    fail_on_warning: config.fail_on_warning === true,
  };
}

function acPowerState() {
  if (process.platform !== 'darwin') return { known: false, ac: null };
  try {
    const result = require('node:child_process').spawnSync('pmset', ['-g', 'batt'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const text = String(result.stdout || '');
    if (/AC Power/i.test(text)) return { known: true, ac: true };
    if (/Battery Power/i.test(text)) return { known: true, ac: false };
  } catch (_err) {
    // Best effort; benchmark evidence records unknown power state.
  }
  return { known: false, ac: null };
}

function environmentSnapshot() {
  const cpus = Math.max(1, os.cpus().length);
  const load1m = os.loadavg()[0] || 0;
  const power = acPowerState();
  return {
    platform: process.platform,
    arch: process.arch,
    cpu_count: cpus,
    load_1m: load1m,
    load_per_cpu: load1m / cpus,
    free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
    total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
    ac_power: power.ac,
    ac_power_known: power.known,
  };
}

function checkEnvironmentPreflight(state, testCase, snapshot, config) {
  const warnings = [];
  if (Number.isFinite(config.max_load_1m) && snapshot.load_1m > config.max_load_1m) {
    warnings.push({ metric: 'load_1m', value: snapshot.load_1m, max: config.max_load_1m });
  }
  if (Number.isFinite(config.max_load_per_cpu) && snapshot.load_per_cpu > config.max_load_per_cpu) {
    warnings.push({ metric: 'load_per_cpu', value: snapshot.load_per_cpu, max: config.max_load_per_cpu });
  }
  if (config.require_ac_power && snapshot.ac_power_known && snapshot.ac_power !== true) {
    warnings.push({ metric: 'ac_power', value: snapshot.ac_power, expected: true });
  }
  if (warnings.length > 0 && config.fail_on_warning) {
    addFailure(state, 'environment_preflight', testCase, 'benchmark environment failed preflight gates', { environment: snapshot, warnings });
  } else {
    addPass(state, 'environment_preflight', testCase, { environment: snapshot, warnings });
  }
}

function improvementFraction(baseline, current, direction) {
  if (!Number.isFinite(baseline) || !Number.isFinite(current) || baseline === 0) return null;
  return direction === 'maximize'
    ? (current - baseline) / Math.abs(baseline)
    : (baseline - current) / Math.abs(baseline);
}

function noiseAbsFor(metricName, baseline, currentStddev, currentSamples, baseEntry, noise) {
  const ratioFloor = Math.abs(baseline || 0) * noise.min_effect_ratio;
  const currentSe = Number.isFinite(currentStddev) && currentSamples > 0 ? currentStddev / Math.sqrt(currentSamples) : 0;
  const baselineSe = Number.isFinite(baseEntry.stddev) && baseEntry.samples > 0 ? baseEntry.stddev / Math.sqrt(baseEntry.samples) : 0;
  const statistical = noise.confidence_z * Math.sqrt((currentSe ** 2) + (baselineSe ** 2));
  const absoluteFloor = /_ms($|_)/.test(metricName) ? 1 : 0;
  return Math.max(ratioFloor, statistical, absoluteFloor);
}

function makePrng(seed = 12345) {
  let x = (Number(seed) >>> 0) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function distributionNameForMetric(metric) {
  return normalizeMetricName(metric).replace(/_(p50|p95|p99|mean|median|min|max)$/, '');
}

function quantileForMetric(metric) {
  const text = normalizeMetricName(metric);
  if (/_p95$/.test(text)) return 0.95;
  if (/_p99$/.test(text)) return 0.99;
  return 0.50;
}

function sampleQuantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return percentile(sorted, q);
}

function bootstrapImprovement(baselineValues, currentValues, metric, direction, options = {}) {
  const baseline = baselineValues.filter(Number.isFinite);
  const current = currentValues.filter(Number.isFinite);
  if (baseline.length === 0 || current.length === 0) return null;
  const random = makePrng(options.seed || 12345);
  const iterations = Number.isFinite(options.iterations) && options.iterations > 0 ? Math.floor(options.iterations) : 400;
  const paired = options.paired === true && baseline.length === current.length;
  const q = quantileForMetric(metric);
  const effects = [];
  for (let i = 0; i < iterations; i += 1) {
    const baseSample = [];
    const currentSample = [];
    const n = paired ? baseline.length : Math.max(baseline.length, current.length);
    for (let j = 0; j < n; j += 1) {
      const bi = Math.floor(random() * baseline.length);
      const ci = paired ? bi : Math.floor(random() * current.length);
      baseSample.push(baseline[bi]);
      currentSample.push(current[ci]);
    }
    const base = sampleQuantile(baseSample, q);
    const curr = sampleQuantile(currentSample, q);
    const effect = improvementFraction(base, curr, direction);
    if (Number.isFinite(effect)) effects.push(effect);
  }
  if (effects.length === 0) return null;
  effects.sort((a, b) => a - b);
  const point = improvementFraction(sampleQuantile(baseline, q), sampleQuantile(current, q), direction);
  return {
    point,
    ci_low: percentile(effects, 0.025),
    ci_high: percentile(effects, 0.975),
    iterations: effects.length,
    paired,
  };
}

function checkSampleSize(state, testCase, samples, noise) {
  if (samples.length >= noise.min_samples) addPass(state, 'sample_size', testCase, { samples: samples.length, min_samples: noise.min_samples });
  else addFailure(state, 'sample_size', testCase, 'not enough benchmark samples for stable evidence', { samples: samples.length, min_samples: noise.min_samples });
}

function checkStability(state, testCase, summary, noise) {
  const failures = [];
  for (const metric of noise.stable_metrics) {
    const cv = summary[`${normalizeMetricName(metric)}_cv`];
    const n = summary[`${normalizeMetricName(metric)}_samples`];
    if (!Number.isFinite(cv) || !Number.isFinite(n) || n < 2) {
      failures.push({ metric, message: 'missing repeated samples' });
    } else if (cv > noise.max_cv) {
      failures.push({ metric, cv, max_cv: noise.max_cv });
    }
  }
  if (failures.length === 0) addPass(state, 'stable_benchmark', testCase, { stable_metrics: noise.stable_metrics, max_cv: noise.max_cv });
  else addFailure(state, 'stable_benchmark', testCase, 'benchmark noise exceeded configured stability threshold', { failures });
}

function checkMetricPresence(state, testCase, summary, bundleMetrics) {
  if (Number.isFinite(summary.wall_time_ms_p50)) addPass(state, 'metric_capture', testCase, { metrics: Object.keys(summary).filter((key) => !key.endsWith('_samples')).length });
  else addFailure(state, 'metric_capture', testCase, 'wall-time metric was not captured');
  if (Number.isFinite(summary.wall_time_ms_p50) && Number.isFinite(summary.wall_time_ms_p95) && Number.isFinite(summary.wall_time_ms_p99)) {
    addPass(state, 'latency_percentiles', testCase, {
      p50: summary.wall_time_ms_p50,
      p95: summary.wall_time_ms_p95,
      p99: summary.wall_time_ms_p99,
    });
  } else addGap(state, 'latency_percentiles', testCase, 'p50/p95/p99 timing metrics were not available');
  if (Number.isFinite(summary.cpu_ms_p50)) addPass(state, 'cpu_metrics', testCase, { cpu_ms_p50: summary.cpu_ms_p50, cpu_ms_p95: summary.cpu_ms_p95 });
  else addGap(state, 'cpu_metrics', testCase, 'CPU time metric missing; emit cpu_ms or run where /usr/bin/time is available');
  if (Number.isFinite(summary.peak_memory_mb_p50)) addPass(state, 'memory_metrics', testCase, { peak_memory_mb_p50: summary.peak_memory_mb_p50, peak_memory_mb_p95: summary.peak_memory_mb_p95 });
  else addGap(state, 'memory_metrics', testCase, 'peak memory metric missing');
  if (bundleMetrics) addPass(state, 'bundle_size', testCase, { bundle_bytes: bundleMetrics.bundle_bytes, bundle_gzip_bytes: bundleMetrics.bundle_gzip_bytes, bundle_file_count: bundleMetrics.bundle_file_count });
  else addGap(state, 'bundle_size', testCase, 'no bundle files declared or discovered');
  if (bundleMetrics && Array.isArray(bundleMetrics.chunks) && bundleMetrics.chunks.length > 0) {
    addPass(state, 'bundle_attribution', testCase, {
      chunks: bundleMetrics.chunks.slice(0, 10),
      source_maps: bundleMetrics.bundle_source_map_count,
      dependency_sources: bundleMetrics.bundle_dependency_source_count,
    });
  } else addGap(state, 'bundle_attribution', testCase, 'no bundle chunk/source-map/dependency attribution available');
  if (Number.isFinite(summary.cold_start_ms_p50)) addPass(state, 'cold_start', testCase, { cold_start_ms: summary.cold_start_ms_p50 });
  else addGap(state, 'cold_start', testCase, 'cold start metric missing');
  if (Number.isFinite(summary.render_time_ms_p50)) addPass(state, 'render_time', testCase, { render_time_ms_p50: summary.render_time_ms_p50, render_time_ms_p95: summary.render_time_ms_p95 });
  else addGap(state, 'render_time', testCase, 'render time metric missing; emit render_time_ms or render_ms');
  if (Number.isFinite(summary.request_formation_time_ms_p50)) addPass(state, 'request_formation_time', testCase, { request_formation_time_ms_p50: summary.request_formation_time_ms_p50, request_formation_time_ms_p95: summary.request_formation_time_ms_p95 });
  else addGap(state, 'request_formation_time', testCase, 'request formation metric missing; emit request_formation_time_ms or request_formation_ms');
}

function budgetValue(summary, bundleMetrics, key) {
  if (bundleMetrics && Number.isFinite(bundleMetrics[key])) return bundleMetrics[key];
  return metricValue(summary, key);
}

function checkBudgets(goal, goalPath, testCase, state, summary, bundleMetrics) {
  const budgets = { ...asObject(goal.verify.budgets, {}), ...testCase.budgets };
  const failures = [];
  const missing = [];
  for (const [metric, configValue] of Object.entries(budgets)) {
    const config = configValue && typeof configValue === 'object' && !Array.isArray(configValue)
      ? configValue
      : { lte: Number(configValue) };
    const value = budgetValue(summary, bundleMetrics, metric);
    if (!Number.isFinite(value)) {
      missing.push(metric);
      continue;
    }
    if (Number.isFinite(config.lte) && value > config.lte) failures.push({ metric, value, lte: config.lte });
    if (Number.isFinite(config.gte) && value < config.gte) failures.push({ metric, value, gte: config.gte });
  }
  if (Object.keys(budgets).length === 0) addGap(state, 'performance_budget', testCase, 'no performance budgets declared');
  else if (failures.length === 0 && missing.length === 0) addPass(state, 'performance_budget', testCase, { budgets });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-performance-budget.json'), {
      budgets,
      summary,
      bundle: bundleMetrics,
      failures,
      missing,
    });
    addFailure(state, 'performance_budget', testCase, 'performance budget failed', { diff_path, failures, missing });
  }
}

function checkRegressionGuard(goal, goalPath, testCase, state, summary, noise, baselineArtifact = {}) {
  const explicitBaseline = { ...asObject(goal.verify.baseline || goal.verify.baselines, {}), ...testCase.baseline };
  const baseline = { ...asObject(baselineArtifact.baseline, {}), ...explicitBaseline };
  const targetKeys = [
    ...normalizeTargets(goal.verify.improvement_targets),
    ...normalizeTargets(testCase.improvement_targets),
    ...asArray(goal.metrics && goal.metrics.targets),
  ].map((target) => target.metric || target.name).filter(Boolean);
  const candidateKeys = Object.keys(explicitBaseline).length > 0
    ? Object.keys(explicitBaseline)
    : (targetKeys.length > 0 ? targetKeys : Object.keys(baseline));
  const entries = [...new Set(candidateKeys)].filter((key) => Number.isFinite(metricValue(summary, key)) && Number.isFinite(baselineEntry(baseline, key).value));
  if (entries.length === 0) {
    addGap(state, 'regression_guard', testCase, 'no comparable baseline metrics declared');
    return;
  }
  const failures = [];
  for (const metric of entries) {
    const base = baselineEntry(baseline, metric);
    const current = metricValue(summary, metric);
    const direction = metricDirection(metric);
    const improvement = improvementFraction(base.value, current, direction);
    if (!Number.isFinite(improvement)) continue;
    const currentStddev = summary[`${normalizeMetricName(metric)}_stddev`] || 0;
    const currentSamples = summary[`${normalizeMetricName(metric)}_samples`] || 1;
    const floorAbs = noiseAbsFor(metric, base.value, currentStddev, currentSamples, base, noise);
    const regressionAbs = direction === 'maximize' ? base.value - current : current - base.value;
    if (improvement < -noise.max_regression_ratio && regressionAbs > floorAbs) {
      failures.push({ metric, baseline: base.value, current, regression_ratio: -improvement, noise_abs: floorAbs });
    }
  }
  if (failures.length === 0) addPass(state, 'regression_guard', testCase, { baseline_metrics: entries.length });
  else {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-regression-guard.json'), { baseline, summary, failures });
    addFailure(state, 'regression_guard', testCase, 'one or more performance metrics regressed beyond noise', { diff_path, failures });
  }
}

function checkNoiseAdjustedConfidence(goal, goalPath, testCase, state, summary, distributions, noise, baselineArtifact = {}) {
  const baseline = { ...asObject(goal.verify.baseline || goal.verify.baselines, {}), ...asObject(baselineArtifact.baseline, {}), ...testCase.baseline };
  const targets = [
    ...normalizeTargets(goal.verify.improvement_targets),
    ...normalizeTargets(testCase.improvement_targets),
  ];
  if (targets.length === 0) {
    addGap(state, 'noise_adjusted_confidence', testCase, 'no improvement targets declared');
    return;
  }
  const failures = [];
  const passes = [];
  const gaps = [];
  for (const target of targets) {
    const metric = normalizeMetricName(target.metric || target.name || '');
    const current = metricValue(summary, metric);
    const base = Number.isFinite(target.baseline) ? { value: target.baseline } : baselineEntry(baseline, metric);
    if (!metric || !Number.isFinite(current) || !Number.isFinite(base.value)) {
      gaps.push({ metric, message: 'target, current metric, or baseline missing' });
      continue;
    }
    const direction = metricDirection(metric, target.direction);
    const improvement = improvementFraction(base.value, current, direction);
    const requiredRatio = Number.isFinite(target.min_improvement_ratio) ? target.min_improvement_ratio
      : Number.isFinite(target.threshold) ? target.threshold
        : noise.min_effect_ratio;
    const currentStddev = summary[`${metric}_stddev`] || 0;
    const currentSamples = summary[`${metric}_samples`] || 1;
    const floorAbs = noiseAbsFor(metric, base.value, currentStddev, currentSamples, base, noise);
    const improvementAbs = direction === 'maximize' ? current - base.value : base.value - current;
    const distributionName = distributionNameForMetric(metric);
    const bootstrap = bootstrapImprovement(
      asArray(baselineArtifact.distributions && baselineArtifact.distributions[distributionName]),
      asArray(distributions && distributions[distributionName]),
      metric,
      direction,
      {
        paired: (testCase.paired === true || (testCase.paired && testCase.paired.enabled === true) || goal.verify.paired === true),
        iterations: noise.bootstrap_iterations,
      },
    );
    const clearsBootstrap = bootstrap ? bootstrap.ci_low >= requiredRatio : true;
    const ok = Number.isFinite(improvement) && improvement >= requiredRatio && improvementAbs > floorAbs && clearsBootstrap;
    const record = { metric, baseline: base.value, current, improvement_ratio: improvement, required_ratio: requiredRatio, improvement_abs: improvementAbs, noise_abs: floorAbs, bootstrap };
    if (ok) passes.push(record);
    else failures.push({ ...record, message: improvement > 0 ? 'claimed improvement is inside noise' : 'metric did not improve' });
  }
  if (failures.length === 0 && gaps.length === 0) addPass(state, 'noise_adjusted_confidence', testCase, { targets: passes });
  else if (failures.length > 0) {
    const diff_path = writeJson(artifactPath(goalPath, 'diffs', testCase, '-noise-adjusted-confidence.json'), { targets, baseline, summary, failures, gaps });
    addFailure(state, 'noise_adjusted_confidence', testCase, 'performance improvement did not clear the noise-adjusted confidence gate', { diff_path, failures, gaps });
  } else {
    addGap(state, 'noise_adjusted_confidence', testCase, 'improvement target baseline or metric missing', { gaps });
  }
}

async function runSetupTeardown(command, phase, cwd, timeoutMs, trace) {
  if (!command) return null;
  const result = await runMeasuredCommand(command, '', { cwd, timeoutMs });
  trace.commands.push({
    phase,
    command,
    exit_code: result.exitCode,
    stderr_tail: String(result.stderr || '').slice(-2000),
    metrics: result.metrics,
  });
  return result;
}

function waitForUrl(url, timeoutMs = 30000) {
  if (!url) return Promise.resolve(false);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const client = url.startsWith('https:') ? https : http;
    function attempt() {
      const req = client.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(true);
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(3000, () => {
        req.destroy();
        retry();
      });
    }
    function retry() {
      if (Date.now() >= deadline) resolve(false);
      else setTimeout(attempt, 250);
    }
    attempt();
  });
}

async function startServeIfNeeded(goal, testCase, cwd, trace) {
  const command = testCase.serve_command || goal.verify.serve_command || '';
  if (!command) return async () => {};
  const child = spawn('bash', ['-lc', command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...testCase.env },
  });
  const entry = { phase: 'serve_start', command, pid: child.pid, stdout_tail: '', stderr_tail: '' };
  child.stdout.on('data', (chunk) => { entry.stdout_tail = `${entry.stdout_tail}${chunk.toString('utf8')}`.slice(-2000); });
  child.stderr.on('data', (chunk) => { entry.stderr_tail = `${entry.stderr_tail}${chunk.toString('utf8')}`.slice(-2000); });
  trace.commands.push(entry);
  const readyUrl = testCase.serve_ready_url || goal.verify.serve_ready_url || testCase.url || goal.verify.url || '';
  if (readyUrl) {
    const ready = await waitForUrl(readyUrl, goal.verify.serve_timeout_ms || testCase.timeout_ms || goal.interface.timeout_ms);
    trace.commands.push({ phase: 'serve_ready', url: readyUrl, ready });
  }
  return async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_err) { /* already stopped */ }
    await sleep(100);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_err) { /* already stopped */ }
  };
}

async function verifyOneCase(goal, goalPath, testCase, cwd, options = {}) {
  const state = {
    verifications: [],
    metrics: [],
    distributions: {},
    counterexample: null,
    trace: { case: testCase, command: buildCommand(goal, testCase), samples: [], commands: [] },
  };
  addPass(state, 'case_present', testCase);
  const noise = noiseConfig(goal, testCase);
  const envConfig = environmentConfig(goal, testCase);
  const envSnapshot = environmentSnapshot();
  state.environment = envSnapshot;
  checkEnvironmentPreflight(state, testCase, envSnapshot, envConfig);
  const warmup = testCase.warmup === null ? goal.verify.warmup : testCase.warmup;
  const repeat = testCase.repeat || goal.verify.repeat || goal.metrics.repeat || 1;
  const cooldownMs = testCase.cooldown_ms === null ? goal.verify.cooldown_ms : testCase.cooldown_ms;
  const baselineArtifact = readBaselineArtifact(goalPath, testCase, cwd);
  const baselineCommand = testCase.baseline_command || goal.verify.baseline_command || (testCase.paired && testCase.paired.baseline_command) || '';
  const setup = await runSetupTeardown(testCase.setup_command || goal.verify.setup_command || '', 'setup', cwd, testCase.timeout_ms || goal.interface.timeout_ms, state.trace);
  if (setup && setup.exitCode !== 0) addFailure(state, 'metric_capture', testCase, 'setup command failed', { exit_code: setup.exitCode, stderr_tail: setup.stderr });
  const stopServe = await startServeIfNeeded(goal, testCase, cwd, state.trace);
  try {
    for (let i = 0; i < warmup; i += 1) {
      if (baselineCommand) {
        const baselineWarmup = await executeSample(goal, testCase, cwd, 'baseline_warmup', i, { command: baselineCommand, env: testCase.baseline_env });
        state.trace.samples.push(baselineWarmup);
      }
      const sample = await executeSample(goal, testCase, cwd, 'warmup', i);
      state.trace.samples.push(sample);
      if (cooldownMs > 0) await sleep(cooldownMs);
    }
    const measured = [];
    const baselineMeasured = [];
    for (let i = 0; i < repeat; i += 1) {
      if (baselineCommand) {
        const baselineSample = await executeSample(goal, testCase, cwd, 'baseline_measure', i, { command: baselineCommand, env: testCase.baseline_env });
        state.trace.samples.push(baselineSample);
        baselineMeasured.push(baselineSample);
        if (cooldownMs > 0) await sleep(cooldownMs);
      }
      const sample = await executeSample(goal, testCase, cwd, 'measure', i);
      state.trace.samples.push(sample);
      measured.push(sample);
      if (sample.exit_code !== testCase.expected_exit_code) {
        addFailure(state, 'metric_capture', testCase, `expected exit ${testCase.expected_exit_code}, got ${sample.exit_code}`, {
          exit_code: sample.exit_code,
          stdout_tail: sample.stdout_tail,
          stderr_tail: sample.stderr_tail,
        });
        break;
      }
      if (cooldownMs > 0) await sleep(cooldownMs);
    }
    const bundleMetrics = measureBundleFiles(cwd, goal, testCase);
    if (bundleMetrics) {
      measured.push({ phase: 'bundle', index: 0, metrics: bundleMetrics });
      state.trace.bundle = bundleMetrics;
      writeJson(artifactPath(goalPath, 'bundles', testCase), bundleMetrics);
    }
    const { summary, distributions } = summarizeSamples(measured);
    const baselineSummary = baselineMeasured.length > 0 ? summarizeSamples(baselineMeasured) : null;
    const effectiveBaseline = baselineSummary
      ? {
          file: '',
          summary: baselineSummary.summary,
          distributions: baselineSummary.distributions,
          baseline: baselineFromSummary(baselineSummary.summary, baselineSummary.distributions),
        }
      : baselineArtifact;
    state.metrics.push(summary);
    state.distributions = distributions;
    writeJson(artifactPath(goalPath, 'actual', testCase), { summary, bundle: bundleMetrics });
    writeJson(artifactPath(goalPath, 'profiles', testCase), { distributions });
    if (options.updateBaselines) {
      const file = writeJson(baselinePath(goalPath, testCase), {
        summary,
        distributions,
        bundle: bundleMetrics,
        environment: envSnapshot,
      });
      addPass(state, 'baseline_update', testCase, { baseline_path: file, updated: true });
    } else if (Object.keys({ ...asObject(goal.verify.baseline || goal.verify.baselines, {}), ...testCase.baseline, ...asObject(baselineArtifact.baseline, {}) }).length > 0 || baselineCommand) {
      addPass(state, 'baseline_update', testCase, { baseline_path: baselineArtifact.file || '', inline: Object.keys(testCase.baseline).length > 0, paired: Boolean(baselineCommand) });
    } else {
      addGap(state, 'baseline_update', testCase, 'no baseline file or inline baseline declared; run xoloop-verify freeze-baselines to capture one');
    }
    if (baselineCommand) addPass(state, 'paired_benchmark', testCase, { baseline_command: baselineCommand, pairs: Math.min(baselineMeasured.length, measured.filter((sample) => sample.phase === 'measure').length) });
    else addGap(state, 'paired_benchmark', testCase, 'no paired baseline_command declared for champion/challenger alternating runs');
    checkSampleSize(state, testCase, measured.filter((sample) => sample.phase === 'measure'), noise);
    checkStability(state, testCase, summary, noise);
    checkMetricPresence(state, testCase, summary, bundleMetrics);
    checkBudgets(goal, goalPath, testCase, state, summary, bundleMetrics);
    checkRegressionGuard(goal, goalPath, testCase, state, summary, noise, effectiveBaseline);
    checkNoiseAdjustedConfidence(goal, goalPath, testCase, state, summary, distributions, noise, effectiveBaseline);
  } finally {
    await stopServe();
    const teardown = await runSetupTeardown(testCase.teardown_command || goal.verify.teardown_command || '', 'teardown', cwd, testCase.timeout_ms || goal.interface.timeout_ms, state.trace);
    if (teardown && teardown.exitCode !== 0) addFailure(state, 'metric_capture', testCase, 'teardown command failed', { exit_code: teardown.exitCode, stderr_tail: teardown.stderr });
    writeJson(artifactPath(goalPath, 'traces', testCase), state.trace);
  }
  return state;
}

function aggregateMetrics(samples) {
  const merged = {};
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value)) continue;
      if (!merged[key]) merged[key] = [];
      merged[key].push(value);
    }
  }
  const out = {};
  for (const [key, values] of Object.entries(merged)) {
    const sorted = values.sort((a, b) => a - b);
    out[key] = percentile(sorted, 0.50);
  }
  return out;
}

async function runPerformanceSuiteVerification(goal, goalPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const caseFiles = expandSimpleJsonGlob(goalPath, goal.verify.cases, cwd);
  const cases = caseFiles.map(loadCaseFile);
  const selectedCases = options.caseId ? cases.filter((testCase) => testCase.id === options.caseId) : cases;
  if (selectedCases.length === 0) {
    return {
      status: 'fail',
      verifications: [{ id: 'case_selection', status: 'fail', message: `No cases matched ${options.caseId || goal.verify.cases}` }],
      metrics: {},
      counterexample: { obligation: 'case_selection', message: `No cases matched ${options.caseId || goal.verify.cases}` },
    };
  }
  const verifications = [];
  const metrics = [];
  const distributions = {};
  const environments = [];
  let counterexample = null;
  for (const testCase of selectedCases) {
    const result = await verifyOneCase(goal, goalPath, testCase, cwd, options);
    verifications.push(...result.verifications);
    metrics.push(...result.metrics);
    environments.push(result.environment);
    for (const [name, values] of Object.entries(result.distributions || {})) {
      if (!distributions[name]) distributions[name] = [];
      distributions[name].push(...values);
    }
    if (result.counterexample && !counterexample) counterexample = result.counterexample;
  }
  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: aggregateMetrics(metrics),
    distributions,
    environment: environments[0] || {},
    counterexample,
  };
}

function writePerformanceSuiteAssets(goalDir, options = {}) {
  for (const dir of ['cases', 'baselines', 'actual', 'diffs', 'traces', 'profiles', 'bundles', 'reports']) {
    fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  }
  const command = options.command || options.target || 'node -e "console.log(JSON.stringify({ metrics: { render_time_ms: 1, request_formation_time_ms: 1 } }))"';
  writeJson(path.join(goalDir, 'cases', 'perf-smoke.json'), {
    id: 'perf-smoke',
    command,
    warmup: 1,
    repeat: 7,
    cooldown_ms: 0,
    expected_exit_code: 0,
    budgets: {
      wall_time_ms_p95: { lte: 5000 },
      peak_memory_mb_p95: { lte: 1024 },
    },
    noise: {
      min_samples: 5,
      max_cv: 0.50,
      min_effect_ratio: 0.03,
      stable_metrics: ['render_time_ms'],
    },
    metadata: {
      note: 'Add baselines and improvement_targets before using this goal as an optimization gate.',
    },
  });
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# Performance verification goal',
    '',
    'Generated by `xoloop-verify create --kind performance-suite`.',
    '',
    'Cases run warmups plus repeated measured samples, record p50/p95/p99,',
    'CPU, memory, bundle bytes, cold start, render time, and request',
    'formation metrics when available. Baselines plus improvement targets',
    'reject claimed wins that sit inside measured noise.',
    '',
  ].join('\n'), 'utf8');
}

function buildPerformanceSuiteGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'performance-suite';
  const scan = options.scan || scanPerformanceRepo(cwd);
  const target = options.command || options.target || ((scan.commands || []).find((command) => command.kind === 'benchmark') || {}).command || 'node -e "console.log(JSON.stringify({ metrics: {} }))"';
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve behavior while proving performance changes with stable benchmarks, p50/p95/p99, resource metrics, budgets, and noise-adjusted confidence.',
    interface: {
      type: 'performance',
      command: target,
      stdin: 'text',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: scan.artifact_paths || [],
    },
    verify: {
      kind: 'performance-suite',
      command: target,
      cases: 'cases/*.json',
      properties: DEFAULT_PERFORMANCE_OBLIGATIONS,
      warmup: 1,
      repeat: 9,
      cooldown_ms: 0,
      serve_command: '',
      serve_ready_url: '',
      url: '',
      browser: 'chromium',
      baseline_command: '',
      paired: false,
      noise: {
        min_samples: 5,
        max_cv: 0.35,
        min_effect_ratio: 0.03,
        max_regression_ratio: 0.02,
        confidence_z: 1.96,
        bootstrap_iterations: 400,
        stable_metrics: ['wall_time_ms'],
      },
      environment: {
        max_load_per_cpu: 4,
        fail_on_warning: false,
      },
      budgets: {},
      baseline: {},
      improvement_targets: [],
      bundle_files: scan.bundle_files || [],
      scan,
      block_on_gaps: true,
    },
    metrics: {
      repeat: 9,
      targets: [
        { name: 'wall_time_ms_p50', direction: 'minimize', threshold: 0.05 },
        { name: 'wall_time_ms_p95', direction: 'minimize', threshold: 0.05 },
        { name: 'cpu_ms_p95', direction: 'minimize', threshold: 0.05 },
        { name: 'peak_memory_mb_p95', direction: 'minimize', threshold: 0.05 },
        { name: 'bundle_bytes', direction: 'minimize', threshold: 0.03 },
        { name: 'cold_start_ms_p50', direction: 'minimize', threshold: 0.05 },
        { name: 'render_time_ms_p95', direction: 'minimize', threshold: 0.05 },
        { name: 'request_formation_time_ms_p95', direction: 'minimize', threshold: 0.05 },
      ],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0.02,
      accept_if_any_target_improves: true,
    },
  };
}

module.exports = {
  DEFAULT_PERFORMANCE_OBLIGATIONS,
  buildPerformanceSuiteGoal,
  runPerformanceSuiteVerification,
  scanPerformanceRepo,
  writePerformanceSuiteAssets,
};
