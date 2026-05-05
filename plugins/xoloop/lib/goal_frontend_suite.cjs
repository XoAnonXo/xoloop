'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob, goalBaseDir } = require('./goal_manifest.cjs');
const { scanFrontendRepo } = require('./goal_frontend_scan.cjs');

const DEFAULT_FRONTEND_OBLIGATIONS = [
  'baseline_present',
  'visual_perception',
  'semantic_dom',
  'accessibility',
  'interaction_behavior',
  'network_contract',
  'event_contract',
  'console_clean',
  'performance_budget',
];

function sanitizeId(id) {
  return String(id || 'case').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadCaseFile(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`frontend-suite case must be an object: ${filePath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
    throw new Error(`frontend-suite case must contain string id: ${filePath}`);
  }
  return {
    ...parsed,
    id: parsed.id.trim(),
    viewport: parsed.viewport || 'desktop',
    state: typeof parsed.state === 'string' ? parsed.state : 'default',
  };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function loadMasks(goal, goalPath, cwd) {
  const maskFiles = goal.verify.masks ? expandSimpleJsonGlob(goalPath, goal.verify.masks, cwd) : [];
  const merged = {
    ignore_dom_text_selectors: new Set(),
    ignore_dom_bounds_selectors: new Set(),
    ignore_network_headers: new Set(),
    ignore_event_fields: new Set(),
    ignore_console_patterns: [],
    screenshot_regions: [],
  };
  for (const filePath of maskFiles) {
    const mask = readJson(filePath);
    for (const selector of normalizeArray(mask.ignore_dom_text_selectors)) merged.ignore_dom_text_selectors.add(String(selector));
    for (const selector of normalizeArray(mask.ignore_dom_bounds_selectors)) merged.ignore_dom_bounds_selectors.add(String(selector));
    for (const header of normalizeArray(mask.ignore_network_headers)) merged.ignore_network_headers.add(String(header).toLowerCase());
    for (const field of normalizeArray(mask.ignore_event_fields)) merged.ignore_event_fields.add(String(field));
    for (const pattern of normalizeArray(mask.ignore_console_patterns)) merged.ignore_console_patterns.push(String(pattern));
    for (const region of normalizeArray(mask.screenshot_regions)) {
      if (!region || typeof region !== 'object') continue;
      merged.screenshot_regions.push({
        x: Math.max(0, Math.floor(region.x || 0)),
        y: Math.max(0, Math.floor(region.y || 0)),
        width: Math.max(0, Math.floor(region.width || 0)),
        height: Math.max(0, Math.floor(region.height || 0)),
      });
    }
  }
  return merged;
}

function stableCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableCopy);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableCopy(value[key]);
  return out;
}

function stripKeys(value, ignored) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripKeys(item, ignored));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (ignored.has(key)) continue;
    out[key] = stripKeys(value[key], ignored);
  }
  return out;
}

function normalizeDom(elements, masks) {
  return normalizeArray(elements).map((element) => {
    const selector = String(element.selector || element.test_id || element.role || element.name || '');
    const copy = stableCopy(element);
    if (masks.ignore_dom_text_selectors.has(selector)) {
      delete copy.text;
      delete copy.name;
      delete copy.accessible_name;
    }
    if (masks.ignore_dom_bounds_selectors.has(selector)) delete copy.bounds;
    return copy;
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function normalizeNetwork(requests, masks) {
  return normalizeArray(requests).map((request) => {
    const copy = stableCopy(request);
    if (copy.headers && typeof copy.headers === 'object' && !Array.isArray(copy.headers)) {
      const headers = {};
      for (const [key, value] of Object.entries(copy.headers)) {
        if (!masks.ignore_network_headers.has(key.toLowerCase())) headers[key.toLowerCase()] = value;
      }
      copy.headers = headers;
    }
    return copy;
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function normalizeEvents(events, masks) {
  return stripKeys(normalizeArray(events), masks.ignore_event_fields);
}

function visualFingerprint(visual) {
  if (!visual || typeof visual !== 'object') return '';
  if (Array.isArray(visual.pixels)) return JSON.stringify({ width: visual.width, height: visual.height, pixels: visual.pixels });
  if (typeof visual.png_base64 === 'string') return visual.png_base64;
  if (typeof visual.svg === 'string') return visual.svg;
  if (typeof visual.text === 'string') return visual.text;
  if (typeof visual.hash === 'string') return visual.hash;
  return JSON.stringify(stableCopy(visual));
}

function loadPngTools() {
  let PNG;
  try {
    // eslint-disable-next-line global-require
    PNG = require('pngjs').PNG;
  } catch (_err) {
    return null;
  }
  let pixelmatch = null;
  try {
    // eslint-disable-next-line global-require
    pixelmatch = require('pixelmatch');
    if (pixelmatch && typeof pixelmatch.default === 'function') pixelmatch = pixelmatch.default;
  } catch (_err) {
    pixelmatch = null;
  }
  return { PNG, pixelmatch };
}

function visualMaskRegions(visual) {
  const regions = [];
  for (const region of normalizeArray(visual && visual.mask_regions)) {
    if (!region || typeof region !== 'object') continue;
    regions.push({
      x: Math.max(0, Math.floor(region.x || 0)),
      y: Math.max(0, Math.floor(region.y || 0)),
      width: Math.max(0, Math.floor(region.width || 0)),
      height: Math.max(0, Math.floor(region.height || 0)),
    });
  }
  return regions;
}

function applyMaskToPng(png, regions) {
  for (const region of regions) {
    const xEnd = Math.min(png.width, region.x + region.width);
    const yEnd = Math.min(png.height, region.y + region.height);
    for (let y = region.y; y < yEnd; y += 1) {
      for (let x = region.x; x < xEnd; x += 1) {
        const idx = (png.width * y + x) << 2;
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 255;
      }
    }
  }
}

function decodeMaskedPng(visual, extraRegions = []) {
  if (!visual || typeof visual.png_base64 !== 'string') return null;
  const tools = loadPngTools();
  if (!tools) return null;
  const png = tools.PNG.sync.read(Buffer.from(visual.png_base64, 'base64'));
  applyMaskToPng(png, [...extraRegions, ...visualMaskRegions(visual)]);
  return { png, tools };
}

function comparePngVisuals(baseline, actual, thresholds) {
  const base = decodeMaskedPng(baseline, visualMaskRegions(actual));
  const next = decodeMaskedPng(actual, visualMaskRegions(baseline));
  if (!base || !next) return null;
  if (base.png.width !== next.png.width || base.png.height !== next.png.height) {
    return {
      pass: false,
      metrics: { comparable: false, pixel_diff_ratio: 1, ssim: 0 },
      message: 'PNG dimensions differ',
      baseline_png: base.png,
      actual_png: next.png,
      tools: base.tools,
    };
  }
  let differingPixels = 0;
  let mse = 0;
  for (let i = 0; i < base.png.data.length; i += 4) {
    const dr = Math.abs(base.png.data[i] - next.png.data[i]);
    const dg = Math.abs(base.png.data[i + 1] - next.png.data[i + 1]);
    const db = Math.abs(base.png.data[i + 2] - next.png.data[i + 2]);
    const da = Math.abs(base.png.data[i + 3] - next.png.data[i + 3]);
    if (dr + dg + db + da > 0) differingPixels += 1;
    mse += dr * dr + dg * dg + db * db + da * da;
  }
  const totalPixels = Math.max(1, base.png.width * base.png.height);
  mse /= totalPixels * 4;
  const maxPixelDiffRatio = Number.isFinite(thresholds.max_pixel_diff_ratio) ? thresholds.max_pixel_diff_ratio : 0.002;
  const minSsim = Number.isFinite(thresholds.min_ssim) ? thresholds.min_ssim : 0.995;
  const metrics = {
    comparable: true,
    width: base.png.width,
    height: base.png.height,
    pixel_diff_ratio: differingPixels / totalPixels,
    ssim: Math.max(0, 1 - (mse / (255 * 255))),
  };
  const pass = metrics.pixel_diff_ratio <= maxPixelDiffRatio && metrics.ssim >= minSsim;
  return {
    pass,
    metrics,
    message: pass ? 'PNG visual matched thresholds' : 'PNG visual difference exceeded thresholds',
    baseline_png: base.png,
    actual_png: next.png,
    tools: base.tools,
  };
}

function comparePixels(baseline, actual) {
  if (!Array.isArray(baseline.pixels) || !Array.isArray(actual.pixels)) return null;
  if (baseline.width !== actual.width || baseline.height !== actual.height || baseline.pixels.length !== actual.pixels.length) {
    return {
      comparable: false,
      message: 'pixel dimensions differ',
      pixel_diff_ratio: 1,
      ssim: 0,
    };
  }
  let diff = 0;
  let mse = 0;
  for (let i = 0; i < baseline.pixels.length; i += 1) {
    const b = Number(baseline.pixels[i]);
    const a = Number(actual.pixels[i]);
    const delta = Math.abs(b - a);
    if (delta > 0) diff += 1;
    mse += delta * delta;
  }
  mse /= Math.max(1, baseline.pixels.length);
  return {
    comparable: true,
    pixel_diff_ratio: diff / Math.max(1, baseline.pixels.length),
    ssim: Math.max(0, 1 - (mse / (255 * 255))),
  };
}

function compareVisual(baseline, actual, thresholds) {
  const png = comparePngVisuals(baseline, actual, thresholds);
  if (png) return png;
  const pixel = comparePixels(baseline, actual);
  if (pixel) {
    const maxPixelDiffRatio = Number.isFinite(thresholds.max_pixel_diff_ratio) ? thresholds.max_pixel_diff_ratio : 0.002;
    const minSsim = Number.isFinite(thresholds.min_ssim) ? thresholds.min_ssim : 0.995;
    const pass = pixel.comparable && pixel.pixel_diff_ratio <= maxPixelDiffRatio && pixel.ssim >= minSsim;
    return {
      pass,
      metrics: pixel,
      message: pass ? 'visual pixels matched thresholds' : 'visual pixel/perceptual difference exceeded thresholds',
    };
  }
  const baselineHash = sha256Hex(visualFingerprint(baseline));
  const actualHash = sha256Hex(visualFingerprint(actual));
  return {
    pass: baselineHash === actualHash,
    metrics: { baseline_hash: baselineHash, actual_hash: actualHash },
    message: baselineHash === actualHash ? 'visual artifact matched hash' : 'visual artifact hash changed',
  };
}

function deepEqual(a, b) {
  return JSON.stringify(stableCopy(a)) === JSON.stringify(stableCopy(b));
}

function addPass(state, id, testCase, extra = {}) {
  state.verifications.push({ id, status: 'pass', case_id: testCase.id, viewport: testCase.viewport, state: testCase.state, ...extra });
}

function addGap(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'gap', case_id: testCase.id, viewport: testCase.viewport, state: testCase.state, message, ...extra });
}

function addFailure(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'fail', case_id: testCase.id, viewport: testCase.viewport, state: testCase.state, message, ...extra });
  if (!state.counterexample) {
    state.counterexample = {
      case_id: testCase.id,
      viewport: testCase.viewport,
      state: testCase.state,
      obligation: id,
      message,
      ...extra,
    };
  }
}

function baselinePath(goal, goalPath, testCase) {
  return path.join(goalBaseDir(goalPath), goal.verify.baselines_dir || 'baselines', `${sanitizeId(testCase.id)}.json`);
}

function actualPath(goal, goalPath, testCase) {
  return path.join(goalBaseDir(goalPath), goal.verify.actual_dir || 'actual', `${sanitizeId(testCase.id)}.json`);
}

function tracePath(goal, goalPath, testCase) {
  return path.join(goalBaseDir(goalPath), goal.verify.traces_dir || 'traces', `${sanitizeId(testCase.id)}.json`);
}

function diffPath(goal, goalPath, testCase, obligation) {
  return path.join(goalBaseDir(goalPath), goal.verify.diffs_dir || 'diffs', `${sanitizeId(testCase.id)}-${sanitizeId(obligation)}.json`);
}

function pngPathFor(jsonPath) {
  return jsonPath.replace(/\.json$/, '.png');
}

function writeVisualArtifact(jsonPath, visual) {
  if (!visual || typeof visual !== 'object' || typeof visual.png_base64 !== 'string') return null;
  const pngPath = pngPathFor(jsonPath);
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  fs.writeFileSync(pngPath, Buffer.from(visual.png_base64, 'base64'));
  return pngPath;
}

function tryWritePngDiff(filePath, baselineVisual, actualVisual) {
  const compared = comparePngVisuals(baselineVisual, actualVisual, { max_pixel_diff_ratio: 0, min_ssim: 1 });
  if (!compared || !compared.tools) return null;
  try {
    const diff = new compared.tools.PNG({ width: compared.baseline_png.width, height: compared.baseline_png.height });
    if (compared.tools.pixelmatch) {
      compared.tools.pixelmatch(
        compared.baseline_png.data,
        compared.actual_png.data,
        diff.data,
        compared.baseline_png.width,
        compared.baseline_png.height,
        { threshold: 0.1 },
      );
    } else {
      for (let i = 0; i < compared.baseline_png.data.length; i += 4) {
        const changed = compared.baseline_png.data[i] !== compared.actual_png.data[i] ||
          compared.baseline_png.data[i + 1] !== compared.actual_png.data[i + 1] ||
          compared.baseline_png.data[i + 2] !== compared.actual_png.data[i + 2] ||
          compared.baseline_png.data[i + 3] !== compared.actual_png.data[i + 3];
        diff.data[i] = changed ? 255 : compared.actual_png.data[i];
        diff.data[i + 1] = changed ? 0 : compared.actual_png.data[i + 1];
        diff.data[i + 2] = changed ? 0 : compared.actual_png.data[i + 2];
        diff.data[i + 3] = 255;
      }
    }
    const pngPath = filePath.replace(/\.json$/, '.png');
    fs.mkdirSync(path.dirname(pngPath), { recursive: true });
    fs.writeFileSync(pngPath, compared.tools.PNG.sync.write(diff));
    return pngPath;
  } catch (_err) {
    return null;
  }
}

async function captureObservation(goal, cwd, testCase, masks) {
  const command = testCase.capture_command || goal.verify.capture_command || goal.interface.command;
  const payload = JSON.stringify({
    ...testCase,
    masks: {
      ignore_dom_text_selectors: [...masks.ignore_dom_text_selectors],
      ignore_dom_bounds_selectors: [...masks.ignore_dom_bounds_selectors],
      screenshot_selectors: [...masks.ignore_dom_text_selectors, ...masks.ignore_dom_bounds_selectors],
      screenshot_regions: masks.screenshot_regions,
    },
  });
  const result = await runCliCommand(command, payload, {
    cwd,
    timeoutMs: testCase.timeout_ms || goal.interface.timeout_ms,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    const err = new Error(`capture command exited ${result.exitCode}`);
    err.result = result;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (parseErr) {
    const err = new Error(`capture command returned non-JSON stdout: ${parseErr.message}`);
    err.result = result;
    throw err;
  }
  return {
    observation: parsed,
    metrics: result.metrics,
  };
}

function checkConsole(state, testCase, actual, masks) {
  const entries = normalizeArray(actual.console);
  const errors = entries.filter((entry) => {
    const level = String(entry.level || entry.type || '').toLowerCase();
    const text = String(entry.text || entry.message || '');
    if (!['error', 'pageerror', 'unhandledrejection'].includes(level)) return false;
    return !masks.ignore_console_patterns.some((pattern) => new RegExp(pattern).test(text));
  });
  if (errors.length > 0) {
    addFailure(state, 'console_clean', testCase, 'console contained error entries', { errors: errors.slice(0, 5) });
  } else {
    addPass(state, 'console_clean', testCase);
  }
}

function checkPerformance(state, testCase, baseline, actual) {
  const budgets = {
    ...(baseline.performance_budgets || {}),
    ...(testCase.performance_budgets || {}),
    ...(testCase.budgets || {}),
  };
  const actualPerf = actual.performance && typeof actual.performance === 'object' ? actual.performance : {};
  const baselinePerf = baseline.performance && typeof baseline.performance === 'object' ? baseline.performance : {};
  const failures = [];
  const passes = [];
  for (const [name, budget] of Object.entries(budgets)) {
    const value = actualPerf[name];
    if (!Number.isFinite(value)) {
      failures.push({ name, message: 'metric missing', value });
      continue;
    }
    if (Number.isFinite(budget)) {
      if (value <= budget) passes.push({ name, value, lte: budget });
      else failures.push({ name, value, lte: budget });
      continue;
    }
    if (budget && typeof budget === 'object') {
      const max = Number.isFinite(budget.lte) ? budget.lte : budget.max;
      if (Number.isFinite(max) && value > max) failures.push({ name, value, lte: max });
      else if (Number.isFinite(max)) passes.push({ name, value, lte: max });
      if (Number.isFinite(budget.improve_by) && Number.isFinite(baselinePerf[name])) {
        const target = baselinePerf[name] * (1 - budget.improve_by);
        if (value > target) failures.push({ name, value, target, baseline: baselinePerf[name], improve_by: budget.improve_by });
        else passes.push({ name, value, target, baseline: baselinePerf[name] });
      }
    }
  }
  if (failures.length > 0) addFailure(state, 'performance_budget', testCase, 'performance budget failed', { failures });
  else addPass(state, 'performance_budget', testCase, { metrics: passes });
}

function collectMetrics(samples) {
  const valuesByName = {};
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value)) continue;
      if (!valuesByName[key]) valuesByName[key] = [];
      valuesByName[key].push(value);
    }
  }
  const out = {};
  for (const [key, values] of Object.entries(valuesByName)) {
    values.sort((a, b) => a - b);
    out[key] = values[Math.floor(values.length / 2)];
    out[`${key}_p95`] = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
  }
  return out;
}

function requestUrl(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_err) {
      resolve(false);
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await requestUrl(url, 1000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function withDevServer(goal, cases, cwd, fn) {
  const command = goal.verify.serve_command;
  if (!command) return fn();
  const readyUrl = goal.verify.serve_ready_url || (cases[0] && cases[0].url);
  if (!readyUrl) return fn();
  if (await requestUrl(readyUrl, 1000)) return fn();
  const child = spawn('bash', ['-lc', command], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: process.env.CI || '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8').slice(-4000); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(-4000); });
  const ready = await waitForReady(readyUrl, goal.verify.serve_timeout_ms || 30000);
  if (!ready) {
    try { child.kill('SIGTERM'); } catch (_err) { /* already gone */ }
    throw new Error(`frontend dev server did not become ready at ${readyUrl}; stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-1000)}`);
  }
  try {
    return await fn();
  } finally {
    try { child.kill('SIGTERM'); } catch (_err) { /* already gone */ }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_err) { /* already gone */ }
    }, 1500).unref();
  }
}

function measureFrontendStaticMetrics(goal, cwd) {
  const repoRoot = path.resolve(cwd || process.cwd());
  const artifactPaths = Array.isArray(goal.artifacts && goal.artifacts.paths) ? goal.artifacts.paths : [];
  let sourceBytes = 0;
  let sourceLoc = 0;
  let astNodeCount = 0;
  let exportedApiSurface = 0;
  let dependencyCount = 0;
  const packagePath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = readJson(packagePath);
      dependencyCount = Object.keys({
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {}),
      }).length;
    } catch (_err) {
      dependencyCount = 0;
    }
  }
  for (const rel of artifactPaths) {
    const absolute = path.resolve(repoRoot, rel);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    sourceBytes += Buffer.byteLength(text, 'utf8');
    sourceLoc += text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//')).length;
    astNodeCount += (text.match(/[A-Za-z_$][\w$]*|=>|[{}()[\].,?:;]/g) || []).length;
    exportedApiSurface += (text.match(/\bexport\b/g) || []).length;
  }
  let bundleBytes = 0;
  for (const dir of ['dist', 'build', '.next/static']) {
    const absolute = path.join(repoRoot, dir);
    if (!fs.existsSync(absolute)) continue;
    const stack = [absolute];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const next = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(next);
        else if (/\.(js|css|html|wasm|mjs|cjs)$/.test(entry.name)) bundleBytes += fs.statSync(next).size;
      }
    }
  }
  return {
    source_bytes: sourceBytes,
    source_loc: sourceLoc,
    ast_node_count: astNodeCount,
    exported_api_surface: exportedApiSurface,
    dependency_count: dependencyCount,
    bundle_bytes: bundleBytes || sourceBytes,
  };
}

function routeFileToUrl(routeFile) {
  let rel = String(routeFile || '')
    .replace(/\\/g, '/')
    .replace(/^src\/pages\//, '')
    .replace(/^pages\//, '')
    .replace(/^src\/app\//, '')
    .replace(/^app\//, '')
    .replace(/\/page\.(jsx?|tsx?)$/, '')
    .replace(/\.(jsx?|tsx?|vue|svelte)$/, '');
  rel = rel.replace(/(^|\/)index$/, '');
  rel = rel.replace(/\[([^\]]+)\]/g, ':$1');
  if (!rel || rel === '.') return '/';
  return `/${rel.replace(/^\/+/, '')}`;
}

async function verifyOneCase(goal, goalPath, cwd, testCase, masks, options = {}) {
  const state = {
    verifications: [],
    counterexample: null,
    metrics: [],
  };
  const paths = {
    baseline: baselinePath(goal, goalPath, testCase),
    actual: actualPath(goal, goalPath, testCase),
    trace: tracePath(goal, goalPath, testCase),
  };

  let captured;
  try {
    captured = await captureObservation(goal, cwd, testCase, masks);
  } catch (err) {
    addFailure(state, 'capture', testCase, err.message, {
      stdout_tail: err.result ? String(err.result.stdout || '').slice(-2000) : '',
      stderr_tail: err.result ? String(err.result.stderr || '').slice(-2000) : '',
    });
    return state;
  }
  const actual = captured.observation;
  state.metrics.push(captured.metrics);
  if (actual.performance) state.metrics.push(actual.performance);
  writeJson(paths.actual, actual);
  const actualPngPath = writeVisualArtifact(paths.actual, actual.visual || {});
  writeJson(paths.trace, {
    case: testCase,
    console: actual.console || [],
    network: actual.network || [],
    events: actual.events || [],
    performance: actual.performance || {},
    visual_png_path: actualPngPath,
  });

  if (options.updateBaselines) {
    writeJson(paths.baseline, actual);
    const baselinePngPath = writeVisualArtifact(paths.baseline, actual.visual || {});
    addPass(state, 'baseline_present', testCase, { baseline_path: paths.baseline, baseline_png_path: baselinePngPath, updated: true });
    for (const id of (goal.verify.properties || DEFAULT_FRONTEND_OBLIGATIONS).filter((id) => id !== 'baseline_present')) {
      addPass(state, id, testCase, { updated_baseline: true });
    }
    return state;
  }

  if (!fs.existsSync(paths.baseline)) {
    addGap(state, 'baseline_present', testCase, 'baseline missing', { baseline_path: paths.baseline });
    return state;
  }
  addPass(state, 'baseline_present', testCase, { baseline_path: paths.baseline });
  const baseline = readJson(paths.baseline);
  const baselinePngPath = writeVisualArtifact(paths.baseline, baseline.visual || {});

  const thresholds = goal.verify.thresholds || {};
  const visual = compareVisual(baseline.visual || {}, actual.visual || {}, thresholds);
  if (visual.pass) addPass(state, 'visual_perception', testCase, { ...visual.metrics, baseline_png_path: baselinePngPath, actual_png_path: actualPngPath });
  else {
    const filePath = diffPath(goal, goalPath, testCase, 'visual_perception');
    const diffPngPath = tryWritePngDiff(filePath, baseline.visual || {}, actual.visual || {});
    writeJson(filePath, { message: visual.message, metrics: visual.metrics, baseline: baseline.visual || {}, actual: actual.visual || {}, diff_png_path: diffPngPath });
    addFailure(state, 'visual_perception', testCase, visual.message, { diff_path: filePath, diff_png_path: diffPngPath, visual: visual.metrics });
  }

  const baselineDom = normalizeDom(baseline.dom || [], masks);
  const actualDom = normalizeDom(actual.dom || [], masks);
  if (deepEqual(baselineDom, actualDom)) addPass(state, 'semantic_dom', testCase);
  else {
    const filePath = diffPath(goal, goalPath, testCase, 'semantic_dom');
    writeJson(filePath, { baseline: baselineDom, actual: actualDom });
    addFailure(state, 'semantic_dom', testCase, 'DOM/a11y semantic snapshot changed', { diff_path: filePath });
  }

  const baselineA11y = stableCopy(baseline.accessibility || baseline.a11y || []);
  const actualA11y = stableCopy(actual.accessibility || actual.a11y || []);
  if (deepEqual(baselineA11y, actualA11y)) addPass(state, 'accessibility', testCase);
  else {
    const filePath = diffPath(goal, goalPath, testCase, 'accessibility');
    writeJson(filePath, { baseline: baselineA11y, actual: actualA11y });
    addFailure(state, 'accessibility', testCase, 'accessibility snapshot changed', { diff_path: filePath });
  }

  const baselineInteractions = stableCopy(baseline.interactions || []);
  const actualInteractions = stableCopy(actual.interactions || []);
  if (deepEqual(baselineInteractions, actualInteractions)) addPass(state, 'interaction_behavior', testCase);
  else {
    const filePath = diffPath(goal, goalPath, testCase, 'interaction_behavior');
    writeJson(filePath, { baseline: baselineInteractions, actual: actualInteractions });
    addFailure(state, 'interaction_behavior', testCase, 'interaction behavior changed', { diff_path: filePath });
  }

  const baselineNetwork = normalizeNetwork(baseline.network || [], masks);
  const actualNetwork = normalizeNetwork(actual.network || [], masks);
  if (deepEqual(baselineNetwork, actualNetwork)) addPass(state, 'network_contract', testCase);
  else {
    const filePath = diffPath(goal, goalPath, testCase, 'network_contract');
    writeJson(filePath, { baseline: baselineNetwork, actual: actualNetwork });
    addFailure(state, 'network_contract', testCase, 'network request contract changed', { diff_path: filePath });
  }

  const baselineEvents = normalizeEvents(baseline.events || [], masks);
  const actualEvents = normalizeEvents(actual.events || [], masks);
  if (deepEqual(baselineEvents, actualEvents)) {
    addPass(state, 'event_contract', testCase);
  } else {
    const filePath = diffPath(goal, goalPath, testCase, 'event_contract');
    writeJson(filePath, { baseline: baselineEvents, actual: actualEvents });
    addFailure(state, 'event_contract', testCase, 'frontend emitted events changed', { diff_path: filePath });
  }

  checkConsole(state, testCase, actual, masks);
  checkPerformance(state, testCase, baseline, actual);

  return state;
}

async function runFrontendSuiteVerification(goal, goalPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const caseFiles = expandSimpleJsonGlob(goalPath, goal.verify.cases, cwd);
  const cases = caseFiles.map(loadCaseFile);
  const selectedCases = options.caseId ? cases.filter((c) => c.id === options.caseId) : cases;
  if (selectedCases.length === 0) {
    return {
      status: 'fail',
      verifications: [{ id: 'case_selection', status: 'fail', message: `No cases matched ${options.caseId || goal.verify.cases}` }],
      metrics: {},
      counterexample: { obligation: 'case_selection', message: `No cases matched ${options.caseId || goal.verify.cases}` },
    };
  }

  const masks = loadMasks(goal, goalPath, cwd);
  const verifications = [];
  const metrics = [measureFrontendStaticMetrics(goal, cwd)];
  let counterexample = null;
  try {
    await withDevServer(goal, selectedCases, cwd, async () => {
      for (const testCase of selectedCases) {
        const result = await verifyOneCase(goal, goalPath, cwd, testCase, masks, options);
        verifications.push(...result.verifications);
        metrics.push(...result.metrics);
        if (result.counterexample && !counterexample) counterexample = result.counterexample;
      }
    });
  } catch (err) {
    verifications.push({ id: 'dev_server_ready', status: 'fail', message: err.message });
    counterexample = { obligation: 'dev_server_ready', message: err.message };
  }

  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: collectMetrics(metrics),
    counterexample,
  };
}

function writeFrontendSuiteAssets(goalDir, options = {}) {
  for (const dir of ['cases', 'baselines', 'actual', 'diffs', 'traces', 'masks', 'budgets', 'flows']) {
    fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  }
  const baseUrl = options.url || 'http://localhost:3000/';
  const defaultViewports = [
    { id: 'mobile', width: 390, height: 844 },
    { id: 'tablet', width: 768, height: 1024 },
    { id: 'desktop', width: 1440, height: 900 },
  ];
  for (const viewport of defaultViewports) {
    const id = viewport.id === 'desktop' ? 'home' : `home-${viewport.id}`;
    writeJson(path.join(goalDir, 'cases', `${id}.json`), {
      id,
      url: baseUrl,
      browser: 'chromium',
      viewport,
      state: 'default',
      discover_safe_actions: true,
      safe_actions: true,
      performance_budgets: {
        render_ms: { lte: 1000 },
        request_build_ms: { lte: 100 },
      },
    });
  }
  const scanRoutes = options.scan && Array.isArray(options.scan.routes) ? options.scan.routes.slice(0, 20) : [];
  for (const routeFile of scanRoutes) {
    const routePath = routeFileToUrl(routeFile);
    const url = new URL(routePath, baseUrl).toString();
    for (const viewport of defaultViewports) {
      const baseId = sanitizeId(routePath === '/' ? 'route-home' : `route-${routePath}`);
      const id = viewport.id === 'desktop' ? baseId : `${baseId}-${viewport.id}`;
      const filePath = path.join(goalDir, 'cases', `${id}.json`);
      if (fs.existsSync(filePath)) continue;
      writeJson(filePath, {
        id,
        url,
        route_file: routeFile,
        browser: 'chromium',
        viewport,
        state: 'default',
        discover_safe_actions: true,
        safe_actions: true,
        performance_budgets: {
          render_ms: { lte: 1000 },
          request_build_ms: { lte: 100 },
        },
      });
    }
  }
  writeJson(path.join(goalDir, 'masks', 'dynamic-regions.json'), {
    ignore_dom_text_selectors: ['[data-xoloop-dynamic]', '[data-testid="timestamp"]'],
    ignore_dom_bounds_selectors: [],
    screenshot_regions: [],
    ignore_network_headers: ['date', 'x-request-id', 'traceparent'],
    ignore_event_fields: ['timestamp', 'time', 'requestId'],
    ignore_console_patterns: [],
  });
  const pluginLib = __dirname.replace(/\\/g, '/');
  const captureScript = [
    '#!/usr/bin/env node',
    "'use strict';",
    `const { captureFrontendWithPlaywright } = require(${JSON.stringify(path.join(pluginLib, 'goal_frontend_playwright_capture.cjs'))});`,
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', async () => {",
    "  try {",
    "    const testCase = input ? JSON.parse(input) : {};",
    "    const observation = await captureFrontendWithPlaywright(testCase);",
    "    process.stdout.write(JSON.stringify(observation, null, 2));",
    "  } catch (err) {",
    "    process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n');",
    "    process.exit(1);",
    "  }",
    "});",
    '',
  ].join('\n');
  const capturePath = path.join(goalDir, 'capture-frontend.cjs');
  fs.writeFileSync(capturePath, captureScript, 'utf8');
  fs.chmodSync(capturePath, 0o755);
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# Frontend verification goal',
    '',
    'Generated by `xoloop-verify create --kind frontend-suite`.',
    '',
    '`capture-frontend.cjs` uses the built-in Playwright capture library.',
    'Install Playwright in the target repo if it is not already present.',
    'The capture command reads a case JSON object on stdin and writes a JSON observation to stdout.',
    '',
    'Baselines, actual captures, diffs, traces, masks, flows, and budgets all live',
    'under this goal directory so optimization agents have a replayable evidence cage.',
    '',
  ].join('\n'), 'utf8');
}

function buildFrontendSuiteGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'frontend-suite';
  const scan = options.scan || scanFrontendRepo(cwd);
  const goalDirRel = path.posix.join('.xoloop', 'goals', goalId);
  const serve = (scan.safe_commands || []).find((command) => command.kind === 'serve');
  const nodeCommand = JSON.stringify(process.execPath);
  const captureRel = path.posix.join(goalDirRel, 'capture-frontend.cjs');
  const artifacts = Array.isArray(scan.artifact_paths) && scan.artifact_paths.length > 0
    ? scan.artifact_paths
    : ['package.json'].filter((rel) => fs.existsSync(path.resolve(cwd, rel)));
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve frontend visual perception, DOM/a11y semantics, interactions, network behavior, events, and performance budgets while optimizing.',
    interface: {
      type: 'frontend',
      command: `${nodeCommand} ${JSON.stringify(captureRel)}`,
      stdin: 'json',
      stdout: 'json',
      timeout_ms: 30000,
    },
    artifacts: {
      paths: artifacts,
    },
    verify: {
      kind: 'frontend-suite',
      cases: 'cases/*.json',
      masks: 'masks/*.json',
      capture_command: `${nodeCommand} ${JSON.stringify(captureRel)}`,
      serve_command: serve ? serve.command : '',
      serve_ready_url: options.url || 'http://localhost:3000/',
      serve_timeout_ms: 30000,
      baselines_dir: 'baselines',
      actual_dir: 'actual',
      diffs_dir: 'diffs',
      traces_dir: 'traces',
      browsers: ['chromium'],
      viewports: [
        { id: 'mobile', width: 390, height: 844 },
        { id: 'tablet', width: 768, height: 1024 },
        { id: 'desktop', width: 1440, height: 900 },
      ],
      properties: DEFAULT_FRONTEND_OBLIGATIONS,
      thresholds: {
        max_pixel_diff_ratio: 0.002,
        min_ssim: 0.995,
      },
      safe_action_policy: 'safe-only',
      mock_policy: 'destructive-or-sensitive-only',
      block_on_gaps: true,
      scan,
    },
    metrics: {
      repeat: 5,
      targets: [
        { name: 'render_ms', direction: 'minimize', threshold: 0.03 },
        { name: 'request_build_ms', direction: 'minimize', threshold: 0.03 },
        { name: 'bundle_bytes', direction: 'minimize', threshold: 0.03 },
        { name: 'complexity_score', direction: 'minimize', threshold: 0.05 },
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
  DEFAULT_FRONTEND_OBLIGATIONS,
  buildFrontendSuiteGoal,
  runFrontendSuiteVerification,
  writeFrontendSuiteAssets,
};
