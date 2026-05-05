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

function exists(cwd, rel) {
  return fs.existsSync(path.resolve(cwd, rel));
}

function listFiles(cwd, rel, predicate, limit = 80) {
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
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (!predicate || predicate(relPath)) out.push(relPath);
    }
  }
  walk(root);
  return out.sort();
}

function dependencyNames(pkg) {
  const names = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg && pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function detectFrameworks(cwd, pkg, deps) {
  const frameworks = [];
  const add = (name, reason) => frameworks.push({ name, reason });
  if (deps.has('next') || exists(cwd, 'next.config.js') || exists(cwd, 'next.config.mjs')) add('next', 'next dependency or config');
  if (deps.has('@vitejs/plugin-react') || deps.has('vite') || exists(cwd, 'vite.config.js') || exists(cwd, 'vite.config.ts')) add('vite', 'vite dependency or config');
  if (deps.has('react') || deps.has('react-dom')) add('react', 'react dependency');
  if (deps.has('vue')) add('vue', 'vue dependency');
  if (deps.has('svelte') || deps.has('@sveltejs/kit')) add('svelte', 'svelte dependency');
  if (deps.has('@angular/core') || exists(cwd, 'angular.json')) add('angular', 'angular dependency or config');
  if (deps.has('solid-js')) add('solid', 'solid-js dependency');
  if (pkg && pkg.scripts) {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (/\bastro\b/.test(command)) add('astro', `script:${name}`);
      if (/\bremix\b/.test(command)) add('remix', `script:${name}`);
    }
  }
  return frameworks;
}

function detectTools(pkg, deps) {
  const tools = [];
  const add = (name, reason) => tools.push({ name, reason });
  if (deps.has('@playwright/test') || deps.has('playwright')) add('playwright', 'dependency');
  if (deps.has('cypress')) add('cypress', 'dependency');
  if (deps.has('vitest')) add('vitest', 'dependency');
  if (deps.has('jest')) add('jest', 'dependency');
  if (deps.has('@storybook/react') || deps.has('storybook')) add('storybook', 'dependency');
  if (pkg && pkg.scripts) {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (/\bplaywright\b/.test(command)) add('playwright', `script:${name}`);
      if (/\bcypress\b/.test(command)) add('cypress', `script:${name}`);
      if (/\bstorybook\b/.test(command)) add('storybook', `script:${name}`);
      if (/\bvitest\b/.test(command)) add('vitest', `script:${name}`);
    }
  }
  return tools;
}

function detectCommands(pkg) {
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const safe = [];
  const names = Object.keys(scripts).sort();
  for (const name of names) {
    const command = scripts[name];
    const kind = /(^|:)(dev|start|preview)$/.test(name) ? 'serve'
      : /build/.test(name) ? 'build'
        : /test|spec/.test(name) ? 'test'
          : /type|check|lint/.test(name) ? 'static'
            : 'other';
    if (kind !== 'other') safe.push({ name, command: `npm run ${name}`, kind });
  }
  return safe;
}

function scanFrontendRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJson(pkgPath);
  const deps = dependencyNames(pkg);
  const routes = [
    ...listFiles(root, 'src/pages', (file) => /\.(jsx?|tsx?|vue|svelte)$/.test(file), 60),
    ...listFiles(root, 'src/app', (file) => /\.(jsx?|tsx?)$/.test(file) && /\/page\./.test(file), 60),
    ...listFiles(root, 'pages', (file) => /\.(jsx?|tsx?)$/.test(file), 60),
    ...listFiles(root, 'app', (file) => /\.(jsx?|tsx?)$/.test(file) && /\/page\./.test(file), 60),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const components = [
    ...listFiles(root, 'src/components', (file) => /\.(jsx?|tsx?|vue|svelte)$/.test(file), 80),
    ...listFiles(root, 'components', (file) => /\.(jsx?|tsx?|vue|svelte)$/.test(file), 80),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const apiSchemas = [
    ...listFiles(root, '.', (file) => /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i.test(file), 30),
    ...listFiles(root, '.', (file) => /(^|\/).*\.graphql$/i.test(file), 30),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const storybook = [
    ...listFiles(root, '.storybook', () => true, 20),
    ...listFiles(root, 'src', (file) => /\.stories\.(jsx?|tsx?|mdx)$/.test(file), 60),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const artifacts = [
    pkg ? 'package.json' : null,
    ...routes,
    ...components.slice(0, 80),
  ].filter(Boolean);

  const gaps = [];
  if (!pkg) gaps.push('package.json not found');
  if (routes.length === 0) gaps.push('no obvious route/page files found');
  if (detectCommands(pkg).filter((cmd) => cmd.kind === 'serve').length === 0) gaps.push('no obvious local serve command found');
  if (!deps.has('@playwright/test') && !deps.has('playwright')) gaps.push('playwright dependency not detected');

  return {
    schema: 'xoloop.frontend_scan.v0.1',
    cwd: root,
    package_json: pkg ? 'package.json' : null,
    frameworks: detectFrameworks(root, pkg, deps),
    tools: detectTools(pkg, deps),
    scripts: pkg && pkg.scripts ? pkg.scripts : {},
    safe_commands: detectCommands(pkg),
    routes,
    components,
    storybook,
    api_schemas: apiSchemas,
    artifact_paths: artifacts,
    gaps,
  };
}

module.exports = {
  scanFrontendRepo,
};
