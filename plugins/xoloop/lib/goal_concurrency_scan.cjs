'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function listFiles(cwd, rel, predicate, limit = 180) {
  const root = path.resolve(cwd, rel);
  const out = [];
  if (!fs.existsSync(root)) return out;
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
      if (['.git', 'node_modules', 'dist', 'build', 'target', '__pycache__', '.xoloop'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (!predicate || predicate(relPath, absolute)) out.push(relPath);
    }
  }
  walk(root);
  return out.sort();
}

function dependencyNames(pkg) {
  const out = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg && pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}

function detectRuntimes(cwd, pkg) {
  const out = [];
  const add = (runtime, reason) => {
    if (!out.some((item) => item.runtime === runtime)) out.push({ runtime, reason });
  };
  if (pkg) add('node', 'package.json');
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) add('python', 'python project file');
  if (fs.existsSync(path.join(cwd, 'go.mod'))) add('go', 'go.mod');
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) add('rust', 'Cargo.toml');
  return out;
}

function detectAsyncTools(cwd, pkg) {
  const deps = dependencyNames(pkg);
  const out = [];
  const add = (name, domain, reason) => out.push({ name, domain, reason });
  if (deps.has('@sinonjs/fake-timers') || deps.has('lolex')) add('fake-timers', 'clock-control', 'dependency');
  if (deps.has('rxjs')) add('rxjs', 'observable-async', 'dependency');
  if (deps.has('p-limit') || deps.has('p-map') || deps.has('p-queue')) add('promise-concurrency', 'scheduler', 'dependency');
  if (deps.has('bull') || deps.has('bullmq') || deps.has('bee-queue')) add('node-queue', 'queue', 'dependency');
  if (deps.has('bottleneck')) add('bottleneck', 'rate-limit-scheduler', 'dependency');
  if (deps.has('async-mutex') || deps.has('semaphore-async-await')) add('async-locking', 'race-control', 'dependency');
  if (deps.has('jest') || deps.has('vitest')) add('test-fake-timers', 'clock-control', 'test dependency');
  if (fs.existsSync(path.join(cwd, 'go.mod')) && /(goroutine|errgroup|go.uber.org\/goleak|clockwork|benbjohnson\/clock)/i.test(readText(path.join(cwd, 'go.mod')))) add('go-concurrency', 'scheduler', 'go.mod');
  if (fs.existsSync(path.join(cwd, 'Cargo.toml')) && /(tokio|async-std|futures|loom|proptest)/i.test(readText(path.join(cwd, 'Cargo.toml')))) add('rust-async', 'scheduler', 'Cargo.toml');
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) && /(asyncio|trio|anyio|pytest-asyncio|freezegun)/i.test(readText(path.join(cwd, 'pyproject.toml')))) add('python-async', 'scheduler', 'pyproject.toml');
  return out;
}

function detectClockAdapters(cwd, pkg) {
  const deps = dependencyNames(pkg);
  const out = [];
  const add = (name, runtime, reason) => out.push({ name, runtime, reason });
  if (deps.has('@sinonjs/fake-timers') || deps.has('lolex')) add('sinon-fake-timers', 'node', 'dependency');
  if (deps.has('vitest')) add('vitest-fake-timers', 'node', 'dependency');
  if (deps.has('jest')) add('jest-fake-timers', 'node', 'dependency');
  const pyproject = readText(path.join(cwd, 'pyproject.toml'));
  const requirements = readText(path.join(cwd, 'requirements.txt'));
  if (/(freezegun|time-machine|pytest-freezegun)/i.test(`${pyproject}\n${requirements}`)) add('freezegun', 'python', 'python dependency');
  const goMod = readText(path.join(cwd, 'go.mod'));
  if (/(clockwork|benbjohnson\/clock)/i.test(goMod)) add('go-clock', 'go', 'go.mod');
  const cargo = readText(path.join(cwd, 'Cargo.toml'));
  if (/(tokio-test|quanta|mock_instant)/i.test(cargo)) add('rust-time-control', 'rust', 'Cargo.toml');
  return out;
}

function detectDeterministicSchedulers(cwd, pkg) {
  const deps = dependencyNames(pkg);
  const out = [];
  const add = (name, runtime, reason) => out.push({ name, runtime, reason });
  if (pkg) add('node-async-hooks', 'node', 'node runtime');
  if (deps.has('rxjs')) add('rxjs-test-scheduler', 'node', 'dependency');
  if (deps.has('@sinonjs/fake-timers') || deps.has('vitest') || deps.has('jest')) add('node-fake-clock-scheduler', 'node', 'clock dependency');
  const pyproject = readText(path.join(cwd, 'pyproject.toml'));
  const requirements = readText(path.join(cwd, 'requirements.txt'));
  if (/(asyncio|pytest-asyncio)/i.test(`${pyproject}\n${requirements}`)) add('asyncio-loop-policy', 'python', 'python dependency');
  if (/(trio|pytest-trio)/i.test(`${pyproject}\n${requirements}`)) add('trio-mock-clock', 'python', 'python dependency');
  const goMod = readText(path.join(cwd, 'go.mod'));
  if (/(go.uber.org\/goleak|clockwork|benbjohnson\/clock)/i.test(goMod)) add('go-controlled-clock', 'go', 'go.mod');
  const cargo = readText(path.join(cwd, 'Cargo.toml'));
  if (/loom/i.test(cargo)) add('rust-loom', 'rust', 'Cargo.toml');
  if (/tokio/i.test(cargo)) add('tokio-paused-time', 'rust', 'Cargo.toml');
  return out;
}

function detectAsyncFiles(cwd) {
  const namePattern = /(^|\/)(async|concurrency|scheduler|timers?|timeouts?|queues?|workers?|jobs?|locks?|mutex|semaphore|rate-limit|retry)\//i;
  const filePattern = /(^|\/).*(async|concurrency|scheduler|timer|timeout|queue|worker|job|lock|mutex|semaphore|retry|race).*\.(js|cjs|mjs|ts|tsx|py|go|rs|rb)$/i;
  return listFiles(cwd, '.', (rel, abs) => {
    if (namePattern.test(rel) || filePattern.test(rel)) return true;
    if (!/\.(js|cjs|mjs|ts|tsx|py|go|rs|rb)$/i.test(rel)) return false;
    const text = readText(abs);
    return /(Promise\.all|Promise\.race|setTimeout|setInterval|AbortController|queueMicrotask|process\.nextTick|async\s+function|await\s+|goroutine|go\s+func|tokio::|asyncio|trio|Mutex|Semaphore|race condition|timeout|retry)/i.test(text);
  }, 180);
}

function detectScheduleFiles(cwd) {
  return listFiles(cwd, '.', (rel) =>
    /(^|\/)(schedules?|traces?|interleavings?|timers?)\/.*\.(json|ya?ml)$/i.test(rel) ||
    /(^|\/).*(schedule|interleaving|async-trace|timer-trace)\.(json|ya?ml)$/i.test(rel),
  80);
}

function detectAsyncScripts(pkg) {
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const out = [];
  for (const [name, command] of Object.entries(scripts)) {
    const text = `${name} ${command}`.toLowerCase();
    const kind = /race|concurrency|scheduler|interleaving|async|timer|timeout|clock/.test(text) ? 'async-check'
      : /test|spec/.test(text) ? 'test'
        : 'other';
    if (kind !== 'other') out.push({ id: `script-${name}`, command: `npm run ${name}`, kind });
  }
  return out;
}

function detectRaceTooling(cwd, pkg) {
  const out = [];
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  for (const [name, command] of Object.entries(scripts)) {
    const text = `${name} ${command}`.toLowerCase();
    if (/race|concurrency|async|scheduler|interleaving|loom|goleak|async_hooks|deadlock|stress/.test(text)) {
      out.push({ id: `script-${name}`, command: `npm run ${name}`, runtime: 'node', kind: 'repo-script' });
    }
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) out.push({ id: 'go-test-race', command: 'go test -race ./...', runtime: 'go', kind: 'race-detector' });
  if (/loom/i.test(readText(path.join(cwd, 'Cargo.toml')))) out.push({ id: 'cargo-loom-tests', command: 'cargo test loom', runtime: 'rust', kind: 'scheduler-model-checker' });
  if (/(pytest|pytest-asyncio|pytest-trio)/i.test(readText(path.join(cwd, 'pyproject.toml')))) out.push({ id: 'pytest-async', command: 'pytest', runtime: 'python', kind: 'async-tests' });
  return out;
}

function scanConcurrencyRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const pkg = readJson(path.join(root, 'package.json'));
  const runtimes = detectRuntimes(root, pkg);
  const tools = detectAsyncTools(root, pkg);
  const clockAdapters = detectClockAdapters(root, pkg);
  const deterministicSchedulers = detectDeterministicSchedulers(root, pkg);
  const asyncFiles = detectAsyncFiles(root);
  const scheduleFiles = detectScheduleFiles(root);
  const scripts = detectAsyncScripts(pkg);
  const raceTooling = detectRaceTooling(root, pkg);
  const artifactPaths = [
    pkg ? 'package.json' : null,
    fs.existsSync(path.join(root, 'go.mod')) ? 'go.mod' : null,
    fs.existsSync(path.join(root, 'Cargo.toml')) ? 'Cargo.toml' : null,
    fs.existsSync(path.join(root, 'pyproject.toml')) ? 'pyproject.toml' : null,
    fs.existsSync(path.join(root, 'requirements.txt')) ? 'requirements.txt' : null,
    ...scheduleFiles,
    ...asyncFiles.slice(0, 120),
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const gaps = [];
  if (tools.length === 0 && asyncFiles.length === 0) gaps.push('no obvious async/concurrency implementation detected');
  if (scheduleFiles.length === 0) gaps.push('no deterministic schedule/interleaving files detected');
  if (clockAdapters.length === 0) gaps.push('no fake clock/clock-control adapter detected');
  if (deterministicSchedulers.length === 0) gaps.push('no deterministic scheduler adapter detected');
  if (raceTooling.length === 0) gaps.push('no static/runtime race tooling detected');
  if (scripts.filter((script) => script.kind === 'async-check').length === 0) gaps.push('no async/concurrency replay or check script detected');
  return {
    schema: 'xoloop.concurrency_scan.v0.1',
    cwd: root,
    runtimes,
    tools,
    clock_adapters: clockAdapters,
    deterministic_schedulers: deterministicSchedulers,
    race_tooling: raceTooling,
    safe_commands: scripts,
    async_files: asyncFiles,
    schedule_files: scheduleFiles,
    artifact_paths: artifactPaths,
    gaps,
  };
}

module.exports = {
  scanConcurrencyRepo,
};
