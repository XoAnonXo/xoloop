'use strict';

const fs = require('node:fs');

function loadPlaywright() {
  try {
    // Prefer the runtime package; @playwright/test re-exports browser types
    // in many installs but the core package is the stable capture surface.
    // eslint-disable-next-line global-require
    return require('playwright');
  } catch (firstErr) {
    try {
      // eslint-disable-next-line global-require
      return require('@playwright/test');
    } catch (_secondErr) {
      const err = new Error('Playwright is required for built-in frontend capture. Install playwright or @playwright/test.');
      err.code = 'XOLOOP_PLAYWRIGHT_MISSING';
      err.fixHint = 'Run npm install --save-dev playwright pngjs pixelmatch, then install browser binaries if Playwright asks.';
      err.cause = firstErr;
      throw err;
    }
  }
}

function systemBrowserExecutable(browserName) {
  if (browserName !== 'chromium') return '';
  const candidates = [
    process.env.XOLOOP_CHROME_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function viewportFor(testCase) {
  if (testCase.viewport && typeof testCase.viewport === 'object') {
    return {
      width: Math.floor(testCase.viewport.width || 1440),
      height: Math.floor(testCase.viewport.height || 900),
    };
  }
  const named = {
    mobile: { width: 390, height: 844 },
    tablet: { width: 768, height: 1024 },
    desktop: { width: 1440, height: 900 },
  };
  return named[testCase.viewport] || named.desktop;
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = value;
  return out;
}

function safeAction(action) {
  if (!action || typeof action !== 'object') return false;
  if (action.safe === true) return true;
  if (action.safe === false) return false;
  const kind = String(action.action || action.type || '').toLowerCase();
  const selector = String(action.selector || '');
  const text = String(action.text || action.name || action.href || action.formAction || selector).toLowerCase();
  const destructive = [
    'delete', 'remove', 'destroy', 'cancel', 'pay', 'purchase', 'buy', 'checkout',
    'submit', 'send', 'email', 'logout', 'sign out', 'unsubscribe', 'transfer',
    'withdraw', 'confirm', 'book', 'reserve', 'save card', 'password',
  ];
  if (destructive.some((word) => text.includes(word))) return false;
  if (action.formMethod && !['get', 'dialog'].includes(String(action.formMethod).toLowerCase())) return false;
  if (action.href && /^(mailto:|tel:|sms:)/i.test(String(action.href))) return false;
  if (action.target === '_blank' && !action.allow_new_tab) return false;
  return ['click', 'hover', 'focus', 'keyboard', 'press', 'fill'].includes(kind);
}

async function runAction(page, action) {
  const kind = String(action.action || action.type || '').toLowerCase();
  const selector = action.selector;
  if (kind === 'click') await page.locator(selector).click({ timeout: action.timeout_ms || 5000 });
  else if (kind === 'hover') await page.locator(selector).hover({ timeout: action.timeout_ms || 5000 });
  else if (kind === 'focus') await page.locator(selector).focus({ timeout: action.timeout_ms || 5000 });
  else if (kind === 'fill') await page.locator(selector).fill(String(action.value || ''), { timeout: action.timeout_ms || 5000 });
  else if (kind === 'keyboard' || kind === 'press') await page.keyboard.press(String(action.key || action.value || 'Tab'));
  else throw new Error(`unsupported frontend action: ${kind}`);
}

async function discoverSafeActions(page, limit = 20) {
  const candidates = await page.evaluate((max) => {
    function selectorFor(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-xoloop-id');
      if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (text) return `${el.tagName.toLowerCase()}:has-text("${text.replace(/"/g, '\\"')}")`;
      return el.tagName.toLowerCase();
    }
    return Array.from(document.querySelectorAll('button,a[href],[role="button"],input[type="button"],input[type="submit"]'))
      .filter((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length))
      .slice(0, max)
      .map((el) => ({
        action: 'click',
        selector: selectorFor(el),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' '),
        href: el.getAttribute('href') || '',
        target: el.getAttribute('target') || '',
        formMethod: el.getAttribute('formmethod') || (el.form && el.form.method) || '',
        safe: el.getAttribute('data-xoloop-safe') === 'true' ? true : undefined,
      }));
  }, limit);
  return candidates.filter(safeAction);
}

async function extractDom(page) {
  return page.evaluate(() => {
    function boundsFor(el) {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }
    function selectorFor(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-xoloop-id');
      if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
      const role = el.getAttribute('role');
      const tag = el.tagName.toLowerCase();
      if (role) return `${tag}[role="${role}"]`;
      return tag;
    }
    function accessibleName(el) {
      return el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        (el.labels && el.labels[0] && el.labels[0].innerText) ||
        el.innerText ||
        el.textContent ||
        '';
    }
    const candidates = Array.from(document.querySelectorAll([
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      '[role]',
      '[aria-label]',
      '[tabindex]',
      '[data-testid]',
      'main',
      'nav',
      'header',
      'footer',
      'h1',
      'h2',
      'h3',
      '[data-xoloop-observe]',
    ].join(','))).slice(0, 500);
    return candidates.map((el) => ({
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      name: accessibleName(el).trim().replace(/\s+/g, ' ').slice(0, 240),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 240),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
      tabIndex: el.tabIndex,
      bounds: boundsFor(el),
      aria: {
        expanded: el.getAttribute('aria-expanded'),
        selected: el.getAttribute('aria-selected'),
        checked: el.getAttribute('aria-checked'),
        current: el.getAttribute('aria-current'),
      },
    }));
  });
}

async function capturePerformance(page, startedAt) {
  const browserMetrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByType('paint');
    const firstPaint = paint.find((entry) => entry.name === 'first-paint');
    const fcp = paint.find((entry) => entry.name === 'first-contentful-paint');
    const vitals = window.__xoloopVitals || {};
    const requestFormation = (window.__xoloopRequestFormation || []).map((entry) => entry.duration).filter(Number.isFinite).sort((a, b) => a - b);
    const p95Index = requestFormation.length > 0 ? Math.min(requestFormation.length - 1, Math.ceil(requestFormation.length * 0.95) - 1) : -1;
    return {
      dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load_ms: nav ? Math.round(nav.loadEventEnd) : null,
      first_paint_ms: firstPaint ? Math.round(firstPaint.startTime) : null,
      first_contentful_paint_ms: fcp ? Math.round(fcp.startTime) : null,
      largest_contentful_paint_ms: Number.isFinite(vitals.lcp) ? Math.round(vitals.lcp) : null,
      cumulative_layout_shift: Number.isFinite(vitals.cls) ? Number(vitals.cls.toFixed(4)) : null,
      long_task_count: Number.isFinite(vitals.longTaskCount) ? vitals.longTaskCount : null,
      total_blocking_time_ms: Number.isFinite(vitals.totalBlockingTime) ? Math.round(vitals.totalBlockingTime) : null,
      request_formation_time_ms: p95Index >= 0 ? Number(requestFormation[p95Index].toFixed(3)) : null,
      request_formation_count: requestFormation.length,
      resource_count: performance.getEntriesByType('resource').length,
    };
  });
  const renderMs = Date.now() - startedAt;
  const out = { render_ms: renderMs };
  for (const [key, value] of Object.entries(browserMetrics)) {
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

async function applyDynamicMasks(page, masks) {
  const selectors = [
    ...(Array.isArray(masks && masks.ignore_dom_text_selectors) ? masks.ignore_dom_text_selectors : []),
    ...(Array.isArray(masks && masks.screenshot_selectors) ? masks.screenshot_selectors : []),
  ];
  if (selectors.length === 0) return;
  await page.addStyleTag({
    content: selectors.map((selector) => `${selector}{visibility:hidden!important;}`).join('\n'),
  });
}

async function collectMaskRegions(page, masks) {
  const selectors = [
    ...(Array.isArray(masks && masks.ignore_dom_text_selectors) ? masks.ignore_dom_text_selectors : []),
    ...(Array.isArray(masks && masks.ignore_dom_bounds_selectors) ? masks.ignore_dom_bounds_selectors : []),
    ...(Array.isArray(masks && masks.screenshot_selectors) ? masks.screenshot_selectors : []),
  ];
  const manual = Array.isArray(masks && masks.screenshot_regions) ? masks.screenshot_regions : [];
  const selectorRegions = selectors.length > 0
    ? await page.evaluate((items) => {
        const regions = [];
        for (const selector of items) {
          for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 50)) {
            const r = el.getBoundingClientRect();
            regions.push({
              selector,
              x: Math.max(0, Math.floor(r.x)),
              y: Math.max(0, Math.floor(r.y)),
              width: Math.max(0, Math.ceil(r.width)),
              height: Math.max(0, Math.ceil(r.height)),
            });
          }
        }
        return regions;
      }, selectors)
    : [];
  return [
    ...manual.map((region) => ({
      x: Math.max(0, Math.floor(region.x || 0)),
      y: Math.max(0, Math.floor(region.y || 0)),
      width: Math.max(0, Math.floor(region.width || 0)),
      height: Math.max(0, Math.floor(region.height || 0)),
    })),
    ...selectorRegions,
  ];
}

async function captureFrontendWithPlaywright(testCase, options = {}) {
  const playwright = loadPlaywright();
  const browserName = testCase.browser || options.browser || 'chromium';
  const launcher = playwright[browserName];
  if (!launcher || typeof launcher.launch !== 'function') throw new Error(`Unsupported Playwright browser: ${browserName}`);
  const viewport = viewportFor(testCase);
  const executablePath = testCase.executable_path || systemBrowserExecutable(browserName);
  const launchOptions = { headless: true };
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await launcher.launch(launchOptions);
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: testCase.device_scale_factor || 1,
    locale: testCase.locale || 'en-US',
    colorScheme: testCase.color_scheme || 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const consoleEntries = [];
  const network = [];
  const events = [];
  const interactions = [];
  const startedAt = Date.now();

  page.on('console', (msg) => {
    consoleEntries.push({ level: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    consoleEntries.push({ level: 'pageerror', text: err.message });
  });
  page.on('request', (request) => {
    const method = request.method();
    if (method === 'GET' && testCase.record_get_requests === false) return;
    network.push({
      phase: 'request',
      method,
      url: request.url(),
      resource_type: request.resourceType(),
      headers: normalizeHeaders(request.headers()),
      post_data: request.postData() || '',
    });
  });
  page.on('response', (response) => {
    const request = response.request();
    network.push({
      phase: 'response',
      method: request.method(),
      url: response.url(),
      status: response.status(),
      headers: normalizeHeaders(response.headers()),
    });
  });

  await page.exposeFunction('__xoloopRecordEvent', (event) => {
    events.push(event);
  });
  await page.addInitScript(() => {
    window.__xoloopEvents = [];
    window.__xoloopVitals = { cls: 0, lcp: 0, longTaskCount: 0, totalBlockingTime: 0 };
    window.__xoloopRequestFormation = [];
    const recordFormation = (start, end, kind) => {
      window.__xoloopRequestFormation.push({ kind, duration: Math.max(0, end - start) });
      if (window.__xoloopRequestFormation.length > 500) window.__xoloopRequestFormation.shift();
    };
    try {
      const originalFetch = window.fetch;
      window.fetch = function patchedFetch(...args) {
        const started = performance.now();
        let request = args[0];
        let init = args[1];
        try {
          if (!(request instanceof Request)) request = new Request(request, init);
          init = undefined;
        } catch (_err) {
          // If construction fails, let native fetch surface the same behavior.
        }
        recordFormation(started, performance.now(), 'fetch');
        return originalFetch.call(this, request, init);
      };
    } catch (_err) {}
    try {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function patchedOpen(...args) {
        this.__xoloopOpenAt = performance.now();
        return originalOpen.apply(this, args);
      };
      XMLHttpRequest.prototype.send = function patchedSend(...args) {
        const started = this.__xoloopOpenAt || performance.now();
        recordFormation(started, performance.now(), 'xhr');
        return originalSend.apply(this, args);
      };
    } catch (_err) {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__xoloopVitals.cls += entry.value || 0;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (_err) {}
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) window.__xoloopVitals.lcp = last.startTime || 0;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_err) {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__xoloopVitals.longTaskCount += 1;
          window.__xoloopVitals.totalBlockingTime += Math.max(0, (entry.duration || 0) - 50);
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch (_err) {}
    window.__xoloopEmit = (name, payload) => {
      const event = { name, payload, timestamp: Date.now() };
      window.__xoloopEvents.push(event);
      if (window.__xoloopRecordEvent) window.__xoloopRecordEvent(event);
    };
    const originalDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function patchedDispatch(event) {
      if (event && event.type && event.type.startsWith('xoloop:')) {
        const payload = { name: event.type, detail: event.detail || null, timestamp: Date.now() };
        window.__xoloopEvents.push(payload);
        if (window.__xoloopRecordEvent) window.__xoloopRecordEvent(payload);
      }
      return originalDispatch.call(this, event);
    };
  });

  try {
    await page.goto(testCase.url, { waitUntil: testCase.wait_until || 'networkidle', timeout: testCase.timeout_ms || 30000 });
    const explicitActions = Array.isArray(testCase.actions) ? testCase.actions : [];
    const discoveredActions = testCase.discover_safe_actions
      ? await discoverSafeActions(page, testCase.max_discovered_actions || 20)
      : [];
    for (const action of [...explicitActions, ...discoveredActions]) {
      if (!safeAction(action)) {
        interactions.push({ action: action.action || action.type || 'unknown', selector: action.selector || '', skipped: true, reason: 'unsafe action blocked' });
        continue;
      }
      const beforeUrl = page.url();
      await runAction(page, action);
      await page.waitForTimeout(action.settle_ms || 100);
      interactions.push({ action: action.action || action.type, selector: action.selector || '', before_url: beforeUrl, after_url: page.url(), skipped: false });
    }
    const maskRegions = await collectMaskRegions(page, testCase.masks || {});
    if (testCase.hide_masked_regions) await applyDynamicMasks(page, testCase.masks || {});
    const screenshot = await page.screenshot({ fullPage: testCase.full_page !== false, type: 'png' });
    const dom = await extractDom(page);
    let accessibility = [];
    try {
      if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
        accessibility = await page.accessibility.snapshot({ interestingOnly: false });
      }
    } catch (_err) {
      accessibility = [];
    }
    if (!accessibility || (Array.isArray(accessibility) && accessibility.length === 0)) {
      accessibility = dom
        .filter((node) => node.role || node.name)
        .map((node) => ({ role: node.role || node.tag, name: node.name || node.text || '', selector: node.selector }));
    }
    const performance = await capturePerformance(page, startedAt);
    const browserEvents = await page.evaluate(() => window.__xoloopEvents || []);
    return {
      schema: 'xoloop.frontend_observation.v0.1',
      url: page.url(),
      browser: browserName,
      viewport,
      visual: {
        type: 'png',
        png_base64: screenshot.toString('base64'),
        bytes: screenshot.length,
        hash: `sha256:${require('node:crypto').createHash('sha256').update(screenshot).digest('hex')}`,
        mask_regions: maskRegions,
      },
      dom,
      accessibility,
      interactions,
      network,
      events: [...events, ...browserEvents],
      console: consoleEntries,
      performance,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = {
  captureFrontendWithPlaywright,
  loadPlaywright,
  safeAction,
  viewportFor,
};
