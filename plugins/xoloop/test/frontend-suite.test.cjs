'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  runGoalVerify,
  scanFrontendRepo,
} = require('../lib/goal_verify_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');
const { runOptimiseLoop } = require('../lib/goal_optimise_runner.cjs');
const { safeAction } = require('../lib/goal_frontend_playwright_capture.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-frontend-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function baselineObservation(overrides = {}) {
  return {
    schema: 'xoloop.frontend_observation.v0.1',
    visual: { width: 2, height: 2, pixels: [0, 0, 255, 255] },
    dom: [
      { selector: '#save', role: 'button', name: 'Save', enabled: true, visible: true, tabIndex: 0, bounds: { x: 10, y: 10, width: 80, height: 32 } },
      { selector: '#status', role: 'status', text: 'Ready', visible: true },
    ],
    accessibility: [
      { role: 'button', name: 'Save' },
      { role: 'status', name: 'Ready' },
    ],
    interactions: [
      { action: 'click', selector: '#save', result: 'saved' },
      { action: 'keyboard', key: 'Tab', focus: '#save' },
    ],
    network: [
      { method: 'POST', url: '/api/save', headers: { 'content-type': 'application/json', 'x-request-id': 'abc' }, body: { draft: false } },
    ],
    events: [
      { name: 'save', payload: { draft: false }, timestamp: 100 },
    ],
    console: [
      { level: 'info', text: 'ready' },
    ],
    performance: {
      render_ms: 30,
      request_build_ms: 20,
      api_ms: 120,
    },
    ...overrides,
  };
}

function pngBase64(width, height, rgbaPixels) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width, height });
  for (let i = 0; i < rgbaPixels.length; i += 1) png.data[i] = rgbaPixels[i];
  return PNG.sync.write(png).toString('base64');
}

function pngObservation(pixels, maskRegions = []) {
  return baselineObservation({
    visual: {
      type: 'png',
      png_base64: pngBase64(2, 2, pixels),
      mask_regions: maskRegions,
    },
  });
}

function writeCapture(cwd, name, observation) {
  const filePath = path.join(cwd, name);
  fs.writeFileSync(filePath, [
    '#!/usr/bin/env node',
    "'use strict';",
    'process.stdin.resume();',
    `process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(observation))}));`,
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(filePath, 0o755);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(name)}`;
}

function writeFrontendGoal(cwd, captureCommand, options = {}) {
  const goalPath = path.join(cwd, '.xoloop', 'goals', options.id || 'frontend', 'goal.yaml');
  writeJson(path.join(cwd, '.xoloop', 'goals', options.id || 'frontend', 'cases', 'home.json'), {
    id: 'home',
    url: 'http://localhost:3000/',
    viewport: 'desktop',
    state: 'default',
    performance_budgets: {
      render_ms: { lte: 50 },
      request_build_ms: { lte: 40 },
      api_ms: { lte: 600 },
    },
  });
  writeJson(path.join(cwd, '.xoloop', 'goals', options.id || 'frontend', 'masks', 'dynamic.json'), {
    ignore_network_headers: ['x-request-id'],
    ignore_event_fields: ['timestamp'],
  });
  if (options.baseline !== false) {
    writeJson(path.join(cwd, '.xoloop', 'goals', options.id || 'frontend', 'baselines', 'home.json'), baselineObservation());
  }
  const quoted = [...captureCommand.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const captureArtifact = quoted.findLast ? quoted.findLast((item) => item.endsWith('.cjs')) : quoted.reverse().find((item) => item.endsWith('.cjs'));
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: options.id || 'frontend',
    objective: 'Verify frontend equivalence.',
    interface: {
      type: 'frontend',
      command: captureCommand,
      stdin: 'json',
      stdout: 'json',
      timeout_ms: 10000,
    },
    artifacts: {
      paths: [captureArtifact || 'package.json'].filter(Boolean),
    },
    verify: {
      kind: 'frontend-suite',
      cases: 'cases/*.json',
      masks: 'masks/*.json',
      capture_command: captureCommand,
      properties: [
        'baseline_present',
        'visual_perception',
        'semantic_dom',
        'accessibility',
        'interaction_behavior',
        'network_contract',
        'event_contract',
        'console_clean',
        'performance_budget',
      ],
      thresholds: {
        max_pixel_diff_ratio: 0.002,
        min_ssim: 0.995,
      },
      block_on_gaps: true,
    },
    metrics: {
      repeat: 3,
      targets: [
        { name: 'render_ms', direction: 'minimize', threshold: 0.03 },
        { name: 'request_build_ms', direction: 'minimize', threshold: 0.03 },
      ],
    },
  });
  return goalPath;
}

test('frontend scan detects frameworks, tools, commands, routes, and schemas', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      dev: 'vite --host 127.0.0.1',
      build: 'vite build',
      test: 'vitest',
    },
    dependencies: {
      react: '^19.0.0',
      vite: '^7.0.0',
    },
    devDependencies: {
      '@playwright/test': '^1.50.0',
    },
  });
  fs.mkdirSync(path.join(cwd, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'pages', 'index.tsx'), 'export default function Home() { return null; }\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'openapi.yaml'), 'openapi: 3.0.0\n', 'utf8');

  const scan = scanFrontendRepo(cwd);

  assert.ok(scan.frameworks.some((f) => f.name === 'react'));
  assert.ok(scan.frameworks.some((f) => f.name === 'vite'));
  assert.ok(scan.tools.some((t) => t.name === 'playwright'));
  assert.ok(scan.safe_commands.some((cmd) => cmd.kind === 'serve'));
  assert.deepEqual(scan.routes, ['src/pages/index.tsx']);
  assert.deepEqual(scan.api_schemas, ['openapi.yaml']);
});

test('frontend-suite create writes conservative harness directories and manifest', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: { dev: 'vite --host 127.0.0.1' },
    dependencies: { react: '^19.0.0', vite: '^7.0.0' },
  });
  fs.mkdirSync(path.join(cwd, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'pages', 'about.tsx'), 'export default function About() { return null; }\n', 'utf8');

  const created = createGoal({ cwd, kind: 'frontend-suite', goalId: 'frontend-suite', force: true, url: 'http://localhost:4173/' });

  assert.equal(created.goal.verify.kind, 'frontend-suite');
  for (const dir of ['cases', 'baselines', 'actual', 'diffs', 'traces', 'masks', 'budgets', 'flows']) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'frontend-suite', dir)), true);
  }
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'frontend-suite', 'capture-frontend.cjs')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'frontend-suite', 'cases', 'route-about.json')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'frontend-suite', 'cases', 'home-mobile.json')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'frontend-suite', 'cases', 'route-about-tablet.json')), true);
  assert.match(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'frontend-suite', 'capture-frontend.cjs'), 'utf8'), /captureFrontendWithPlaywright/);
});

test('frontend-suite reaches PASS_EVIDENCED for unchanged perception and behavior', async () => {
  const cwd = tmpDir();
  const capture = writeCapture(cwd, 'capture.cjs', baselineObservation());
  const goalPath = writeFrontendGoal(cwd, capture);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.deepEqual(card.missing_obligations, []);
  assert.equal(card.summary.failed, 0);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'frontend', 'actual', 'home.json')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'frontend', 'traces', 'home.json')), true);
});

test('frontend-suite reports PASS_WITH_GAPS when baselines are missing', async () => {
  const cwd = tmpDir();
  const capture = writeCapture(cwd, 'capture.cjs', baselineObservation());
  const goalPath = writeFrontendGoal(cwd, capture, { id: 'gappy', baseline: false });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.ok(card.missing_obligations.includes('baseline_present'));
  assert.equal(card.summary.failed, 0);
});

test('frontend-suite update-baselines writes baselines and reaches PASS_EVIDENCED', async () => {
  const cwd = tmpDir();
  const capture = writeCapture(cwd, 'capture.cjs', baselineObservation());
  const goalPath = writeFrontendGoal(cwd, capture, { id: 'update-baseline', baseline: false });

  const update = await runGoalVerify(goalPath, { cwd, updateBaselines: true });
  const verify = await runGoalVerify(goalPath, { cwd });

  assert.equal(update.card.verdict, 'PASS_EVIDENCED');
  assert.equal(verify.card.verdict, 'PASS_EVIDENCED');
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'update-baseline', 'baselines', 'home.json')), true);
});

test('frontend-suite fails with visual diff artifacts for perception drift', async () => {
  const cwd = tmpDir();
  const capture = writeCapture(cwd, 'capture.cjs', baselineObservation({
    visual: { width: 2, height: 2, pixels: [0, 0, 0, 255] },
  }));
  const goalPath = writeFrontendGoal(cwd, capture, { id: 'visual-drift' });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'visual_perception');
  assert.equal(fs.existsSync(card.counterexample.diff_path), true);
  assert.match(card.replay, /--case home/);
});

test('frontend-suite applies PNG mask regions and writes real PNG diffs', async () => {
  const cwd = tmpDir();
  const black = [0, 0, 0, 255];
  const white = [255, 255, 255, 255];
  const red = [255, 0, 0, 255];
  const baseline = pngObservation([...black, ...black, ...black, ...black], [{ x: 0, y: 0, width: 1, height: 1 }]);
  const maskedChange = pngObservation([...white, ...black, ...black, ...black], [{ x: 0, y: 0, width: 1, height: 1 }]);
  const capture = writeCapture(cwd, 'capture.cjs', maskedChange);
  const goalPath = writeFrontendGoal(cwd, capture, { id: 'png-mask' });
  writeJson(path.join(cwd, '.xoloop', 'goals', 'png-mask', 'baselines', 'home.json'), baseline);

  const masked = await runGoalVerify(goalPath, { cwd });
  assert.equal(masked.card.verdict, 'PASS_EVIDENCED');

  const outsideChange = pngObservation([...white, ...red, ...black, ...black], [{ x: 0, y: 0, width: 1, height: 1 }]);
  fs.writeFileSync(path.join(cwd, 'capture.cjs'), [
    '#!/usr/bin/env node',
    "'use strict';",
    'process.stdin.resume();',
    `process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(outsideChange))}));`,
    '',
  ].join('\n'), 'utf8');
  const failed = await runGoalVerify(goalPath, { cwd });

  assert.equal(failed.card.verdict, 'FAIL');
  assert.equal(failed.card.counterexample.obligation, 'visual_perception');
  assert.ok(failed.card.counterexample.diff_png_path);
  assert.equal(fs.existsSync(failed.card.counterexample.diff_png_path), true);
});


test('frontend-suite fails on DOM, network, console, and performance regressions', async () => {
  const cwd = tmpDir();
  const changed = baselineObservation({
    dom: [
      { selector: '#save', role: 'button', name: 'Submit', enabled: true, visible: true, tabIndex: 0, bounds: { x: 10, y: 10, width: 80, height: 32 } },
      { selector: '#status', role: 'status', text: 'Ready', visible: true },
    ],
    accessibility: [
      { role: 'button', name: 'Submit' },
      { role: 'status', name: 'Ready' },
    ],
    network: [
      { method: 'POST', url: '/api/save', headers: { 'content-type': 'application/json', 'x-request-id': 'def' }, body: { draft: true } },
    ],
    console: [
      { level: 'error', text: 'boom' },
    ],
    performance: {
      render_ms: 90,
      request_build_ms: 70,
      api_ms: 900,
    },
  });
  const capture = writeCapture(cwd, 'capture.cjs', changed);
  const goalPath = writeFrontendGoal(cwd, capture, { id: 'semantic-drift' });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.ok(card.summary.by_id.semantic_dom.failed > 0);
  assert.ok(card.summary.by_id.network_contract.failed > 0);
  assert.ok(card.summary.by_id.console_clean.failed > 0);
  assert.ok(card.summary.by_id.performance_budget.failed > 0);
});

test('frontend safe action classifier blocks destructive and sensitive actions', () => {
  assert.equal(safeAction({ action: 'click', text: 'Open menu' }), true);
  assert.equal(safeAction({ action: 'click', text: 'Delete account' }), false);
  assert.equal(safeAction({ action: 'click', text: 'Pay now' }), false);
  assert.equal(safeAction({ action: 'click', href: 'mailto:user@example.com' }), false);
  assert.equal(safeAction({ action: 'click', text: 'Submit application' }), false);
  assert.equal(safeAction({ action: 'click', text: 'Delete account', safe: true }), true);
});

test('frontend-suite supports static bundle and source metrics', async () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.join(cwd, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'dist', 'app.js'), 'console.log("bundle");\n', 'utf8');
  writeJson(path.join(cwd, 'package.json'), { dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' } });
  const capture = writeCapture(cwd, 'capture.cjs', baselineObservation());
  const goalPath = writeFrontendGoal(cwd, capture, { id: 'static-metrics' });
  const loaded = require('../lib/goal_manifest.cjs').loadGoalManifest(goalPath);
  loaded.goal.artifacts.paths.push('package.json');
  writeGoalManifest(goalPath, loaded.goal);

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.ok(card.metrics.bundle_bytes > 0);
  assert.ok(card.metrics.dependency_count >= 2);
});

test('frontend-suite launches a real fixture app when Playwright is installed', { skip: !process.env.XOLOOP_RUN_PLAYWRIGHT_E2E }, async () => {
  const cwd = tmpDir();
  const port = 49153 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(path.join(cwd, 'server.cjs'), [
    "'use strict';",
    "const http = require('node:http');",
    `const port = ${port};`,
    "const html = `<!doctype html><html><head><title>XO Verify</title><style>body{font-family:sans-serif}.box{width:120px;height:40px;background:#246;color:white}.stamp{position:absolute;left:0;top:0}</style></head><body><main><h1>XO Verify</h1><button id='open' data-xoloop-safe='true'>Open panel</button><button id='danger'>Delete account</button><div class='box' role='status'>Ready</div><span class='stamp' data-testid='timestamp'>12345</span><script>window.__xoloopEmit&&window.__xoloopEmit('ready',{ok:true});document.getElementById('open').addEventListener('click',()=>{window.__xoloopEmit('open',{panel:true});fetch('/api/panel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({panel:true})});});</script></main></body></html>`;",
    "http.createServer((req,res)=>{ if(req.url==='/api/panel'){ req.resume(); res.writeHead(200, {'content-type':'application/json'}); res.end('{\"ok\":true}'); return; } res.writeHead(200, {'content-type':'text/html'}); res.end(html); }).listen(port, '127.0.0.1');",
    '',
  ].join('\n'), 'utf8');
  const goalPath = path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'goal.yaml');
  writeJson(path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'cases', 'home.json'), {
    id: 'home',
    url: `http://127.0.0.1:${port}/`,
    browser: 'chromium',
    viewport: { id: 'desktop', width: 800, height: 600 },
    discover_safe_actions: true,
    performance_budgets: { render_ms: { lte: 5000 } },
  });
  writeJson(path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'cases', 'mobile.json'), {
    id: 'mobile',
    url: `http://127.0.0.1:${port}/`,
    browser: 'chromium',
    viewport: { id: 'mobile', width: 390, height: 844 },
    discover_safe_actions: true,
    wait_until: 'load',
    performance_budgets: { render_ms: { lte: 5000 } },
  });
  writeJson(path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'masks', 'dynamic.json'), {
    ignore_dom_text_selectors: ['[data-testid="timestamp"]'],
    screenshot_regions: [{ x: 0, y: 0, width: 80, height: 30 }],
    ignore_event_fields: ['timestamp'],
    ignore_network_headers: ['date'],
  });
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'real-frontend',
    objective: 'Real browser frontend fixture.',
    interface: {
      type: 'frontend',
      command: `${JSON.stringify(process.execPath)} .xoloop/goals/real-frontend/capture-frontend.cjs`,
      stdin: 'json',
      stdout: 'json',
      timeout_ms: 20000,
    },
    artifacts: { paths: ['server.cjs'] },
    verify: {
      kind: 'frontend-suite',
      cases: 'cases/*.json',
      masks: 'masks/*.json',
      capture_command: `${JSON.stringify(process.execPath)} .xoloop/goals/real-frontend/capture-frontend.cjs`,
      serve_command: `${JSON.stringify(process.execPath)} server.cjs`,
      serve_ready_url: `http://127.0.0.1:${port}/`,
      properties: [
        'baseline_present',
        'visual_perception',
        'semantic_dom',
        'accessibility',
        'interaction_behavior',
        'network_contract',
        'event_contract',
        'console_clean',
        'performance_budget',
      ],
      thresholds: { max_pixel_diff_ratio: 0.002, min_ssim: 0.995 },
    },
  });
  const captureSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'goal_frontend_suite.cjs'), 'utf8');
  assert.match(captureSource, /captureFrontendWithPlaywright/);
  const created = createGoal({ cwd, kind: 'frontend-suite', goalId: 'tmp-capture', force: true, url: `http://127.0.0.1:${port}/` });
  fs.copyFileSync(path.join(cwd, '.xoloop', 'goals', 'tmp-capture', 'capture-frontend.cjs'), path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'capture-frontend.cjs'));

  const updated = await runGoalVerify(goalPath, { cwd, updateBaselines: true });
  const verified = await runGoalVerify(goalPath, { cwd });

  assert.equal(updated.card.verdict, 'PASS_EVIDENCED');
  assert.equal(verified.card.verdict, 'PASS_EVIDENCED');
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'baselines', 'home.png')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'actual', 'home.png')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'baselines', 'mobile.png')), true);
  const actual = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'real-frontend', 'actual', 'home.json'), 'utf8'));
  assert.equal(actual.browser, 'chromium');
  assert.equal(actual.viewport.width, 800);
  assert.ok(Number.isFinite(actual.performance.render_ms));
  assert.ok(Number.isFinite(actual.performance.resource_count));
});

test('optimise blocks frontend-suite goals that are only PASS_WITH_GAPS', async () => {
  const cwd = tmpDir();
  const capture = writeCapture(cwd, 'capture.cjs', baselineObservation());
  const goalPath = writeFrontendGoal(cwd, capture, { id: 'blocked', baseline: false });
  const agent = writeCapture(cwd, 'agent.cjs', { summary: 'noop', operations: [] });

  const summary = await runOptimiseLoop({ cwd, goalPath, agentCommand: agent, rounds: 1 });

  assert.equal(summary.stop_reason, 'champion_not_verified');
  assert.match(summary.error, /PASS_WITH_GAPS/);
});
