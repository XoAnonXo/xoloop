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

function listFiles(cwd, rel, predicate, limit = 200) {
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
      if (['.git', 'node_modules', '.xoloop', 'target', '__pycache__'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (!predicate || predicate(relPath, absolute)) out.push(relPath);
    }
  }
  walk(root);
  return out.sort();
}

function packageDependencyNames(pkg) {
  const out = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg && pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}

function detectTools(cwd, pkg) {
  const deps = packageDependencyNames(pkg);
  const out = [];
  const add = (name, reason, files = []) => out.push({ name, reason, files });
  if (deps.has('benchmark') || deps.has('tinybench') || deps.has('mitata')) add('js-benchmark', 'benchmark dependency');
  if (deps.has('playwright')) add('playwright', 'dependency');
  if (deps.has('lighthouse')) add('lighthouse', 'dependency');
  if (deps.has('web-vitals')) add('web-vitals', 'dependency');
  if (deps.has('vite') || fs.existsSync(path.join(cwd, 'vite.config.ts')) || fs.existsSync(path.join(cwd, 'vite.config.js'))) add('vite', 'config/dependency');
  if (deps.has('webpack') || fs.existsSync(path.join(cwd, 'webpack.config.js'))) add('webpack', 'config/dependency');
  if (deps.has('rollup') || fs.existsSync(path.join(cwd, 'rollup.config.js'))) add('rollup', 'config/dependency');
  if (deps.has('next') || fs.existsSync(path.join(cwd, 'next.config.js'))) add('next', 'config/dependency');
  if (fs.existsSync(path.join(cwd, 'Cargo.toml')) && /criterion|divan/i.test(readText(path.join(cwd, 'Cargo.toml')))) add('rust-benchmark', 'Cargo.toml benchmark dependency');
  if (fs.existsSync(path.join(cwd, 'go.mod')) && /benchstat|pprof|testing/i.test(readText(path.join(cwd, 'go.mod')))) add('go-benchmark', 'go.mod benchmark hints');
  return out;
}

function detectScripts(pkg) {
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const out = [];
  for (const [name, command] of Object.entries(scripts)) {
    const text = `${name} ${command}`.toLowerCase();
    const kind = /bench|benchmark|perf|profile|lighthouse|web-vitals/.test(text) ? 'benchmark'
      : /build|bundle|compile/.test(text) ? 'build'
        : /start|serve|dev/.test(text) ? 'serve'
          : /test/.test(text) ? 'test'
            : 'other';
    if (kind !== 'other') out.push({ id: `script-${name}`, command: `npm run ${name}`, kind });
  }
  return out;
}

function detectBenchmarkFiles(cwd) {
  return listFiles(cwd, '.', (rel, abs) => {
    if (!/\.(js|cjs|mjs|ts|tsx|py|rs|go|sh)$/i.test(rel)) return false;
    if (/(^|\/)(bench|benchmark|benchmarks|perf|performance|profile|profiles)(\/|\.|-|_)/i.test(rel)) return true;
    return /\b(benchmark|performance|perf_hooks|tinybench|mitata|criterion|pprof|web-vitals|lighthouse)\b/i.test(readText(abs));
  }, 160);
}

function detectBundleFiles(cwd) {
  const candidates = [
    ...listFiles(cwd, 'dist', (rel) => /\.(js|css|mjs|wasm)$/i.test(rel), 120),
    ...listFiles(cwd, 'build', (rel) => /\.(js|css|mjs|wasm)$/i.test(rel), 120),
    ...listFiles(cwd, '.next/static', (rel) => /\.(js|css|mjs|wasm)$/i.test(rel), 120),
    ...listFiles(cwd, 'public', (rel) => /\.(js|css|mjs|wasm)$/i.test(rel), 80),
  ];
  return [...new Set(candidates)].sort().slice(0, 200);
}

function scanPerformanceRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = detectScripts(pkg);
  const tools = detectTools(root, pkg);
  const benchmarkFiles = detectBenchmarkFiles(root);
  const bundleFiles = detectBundleFiles(root);
  const artifactPaths = [
    pkg ? 'package.json' : null,
    ...benchmarkFiles.slice(0, 100),
    ...bundleFiles.slice(0, 100),
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const gaps = [];
  if (scripts.filter((script) => script.kind === 'benchmark').length === 0) gaps.push('no benchmark/performance package script detected');
  if (benchmarkFiles.length === 0) gaps.push('no benchmark/performance source files detected');
  if (bundleFiles.length === 0) gaps.push('no built bundle files detected');
  if (!tools.some((tool) => /benchmark|lighthouse|web-vitals|playwright/.test(tool.name))) gaps.push('no dedicated performance measurement tool detected');
  return {
    schema: 'xoloop.performance_scan.v0.1',
    cwd: root,
    tools,
    commands: scripts,
    benchmark_files: benchmarkFiles,
    bundle_files: bundleFiles,
    artifact_paths: artifactPaths,
    gaps,
  };
}

module.exports = {
  scanPerformanceRepo,
};
