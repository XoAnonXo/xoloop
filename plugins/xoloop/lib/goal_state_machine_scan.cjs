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

function detectWorkflowTools(cwd, pkg) {
  const deps = dependencyNames(pkg);
  const out = [];
  const add = (name, domain, reason) => out.push({ name, domain, reason });
  if (deps.has('xstate')) add('xstate', 'state-machine', 'dependency');
  if (deps.has('robot3')) add('robot3', 'state-machine', 'dependency');
  if (deps.has('@reduxjs/toolkit') || deps.has('redux')) add('redux', 'reducer-workflow', 'dependency');
  if (deps.has('zustand')) add('zustand', 'state-store', 'dependency');
  if (deps.has('bull') || deps.has('bullmq') || deps.has('bee-queue')) add('node-queue', 'queue', 'dependency');
  if (deps.has('@temporalio/workflow') || deps.has('@temporalio/client')) add('temporal', 'workflow', 'dependency');
  if (deps.has('yjs')) add('yjs', 'crdt', 'dependency');
  if (deps.has('automerge') || deps.has('@automerge/automerge')) add('automerge', 'crdt', 'dependency');
  if (fs.existsSync(path.join(cwd, 'Cargo.toml')) && /(bevy|hecs|legion|rapier|ggez|macroquad)/i.test(readText(path.join(cwd, 'Cargo.toml')))) add('rust-game-state', 'game', 'Cargo.toml');
  if (fs.existsSync(path.join(cwd, 'go.mod')) && /(temporal|machinery|asynq|watermill)/i.test(readText(path.join(cwd, 'go.mod')))) add('go-workflow', 'workflow', 'go.mod');
  return out;
}

function detectWorkflowFiles(cwd) {
  const namePattern = /(^|\/)(machines?|workflows?|flows?|reducers?|queues?|jobs?|crdt|editor|checkout|onboarding|game|fsm|statechart|sagas?)\//i;
  const filePattern = /(^|\/).*(machine|workflow|flow|reducer|queue|job|crdt|editor|checkout|onboarding|game|fsm|statechart|saga).*\.(js|cjs|mjs|ts|tsx|py|rb|go|rs|json|yaml|yml)$/i;
  return listFiles(cwd, '.', (rel, abs) => {
    if (namePattern.test(rel) || filePattern.test(rel)) return true;
    if (!/\.(js|cjs|mjs|ts|tsx|py|rb|go|rs)$/i.test(rel)) return false;
    const text = readText(abs);
    return /(createMachine|transition\s*\(|reducer\s*\(|statechart|enqueue|dequeue|checkout|onboarding|applyUpdate|merge|CRDT|undo|redo|validTransition|impossibleState)/i.test(text);
  }, 180);
}

function detectModelFiles(cwd) {
  return listFiles(cwd, '.', (rel) =>
    /(^|\/)(models?|statecharts?|machines?)\/.*\.(json|ya?ml)$/i.test(rel) ||
    /(^|\/).*(state-machine|statechart|workflow-model|fsm)\.(json|ya?ml)$/i.test(rel),
  80);
}

function detectWorkflowScripts(pkg) {
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const out = [];
  for (const [name, command] of Object.entries(scripts)) {
    const text = `${name} ${command}`.toLowerCase();
    const kind = /replay|trace/.test(text) ? 'replay'
      : /workflow|state.?machine|fsm|statechart|checkout|onboarding|queue|crdt/.test(text) ? 'workflow'
        : /test|spec/.test(text) ? 'test'
          : 'other';
    if (kind !== 'other') out.push({ id: `script-${name}`, command: `npm run ${name}`, kind });
  }
  return out;
}

function inferDomains(files, tools) {
  const domains = new Set(tools.map((tool) => tool.domain));
  const text = files.join('\n').toLowerCase();
  if (/queue|job/.test(text)) domains.add('queue');
  if (/editor|undo|redo/.test(text)) domains.add('editor');
  if (/game/.test(text)) domains.add('game');
  if (/crdt|yjs|automerge/.test(text)) domains.add('crdt');
  if (/checkout|cart|payment|shipping/.test(text)) domains.add('checkout');
  if (/onboarding|signup|activation/.test(text)) domains.add('onboarding');
  if (domains.size === 0 && files.length > 0) domains.add('state-machine');
  return [...domains].sort();
}

function scanStateMachineRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const pkg = readJson(path.join(root, 'package.json'));
  const tools = detectWorkflowTools(root, pkg);
  const workflowFiles = detectWorkflowFiles(root);
  const modelFiles = detectModelFiles(root);
  const scripts = detectWorkflowScripts(pkg);
  const domains = inferDomains([...workflowFiles, ...modelFiles], tools);
  const artifactPaths = [
    pkg ? 'package.json' : null,
    ...modelFiles,
    ...workflowFiles.slice(0, 100),
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const gaps = [];
  if (tools.length === 0 && workflowFiles.length === 0) gaps.push('no obvious workflow/state-machine implementation detected');
  if (modelFiles.length === 0) gaps.push('no state machine/reference model file detected');
  if (scripts.filter((script) => script.kind === 'replay').length === 0) gaps.push('no command-sequence replay script detected');
  return {
    schema: 'xoloop.state_machine_scan.v0.1',
    cwd: root,
    domains,
    tools,
    safe_commands: scripts,
    workflow_files: workflowFiles,
    model_files: modelFiles,
    artifact_paths: artifactPaths,
    gaps,
  };
}

module.exports = {
  scanStateMachineRepo,
};
