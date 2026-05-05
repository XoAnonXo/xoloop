'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function listFiles(cwd, rel, predicate, limit = 120) {
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
      if (['.git', 'node_modules', 'dist', 'build', 'target', '__pycache__'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (!predicate || predicate(relPath, absolute)) out.push(relPath);
    }
  }
  walk(root);
  return out.sort();
}

function addCommand(commands, command) {
  if (!command || !command.id || !command.command) return;
  if (commands.some((existing) => existing.id === command.id && existing.command === command.command)) return;
  commands.push({
    risk: 'unknown',
    help_command: `${command.command} --help`,
    ...command,
  });
}

function dependencyNames(pkg) {
  const out = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg && pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}

function scanPackageJson(cwd, pkg, commands, artifactPaths) {
  if (!pkg) return;
  artifactPaths.add('package.json');
  if (typeof pkg.bin === 'string') {
    artifactPaths.add(pkg.bin);
    addCommand(commands, {
      id: 'node-bin',
      command: `node ${JSON.stringify(pkg.bin)}`,
      source: 'package.json#bin',
      language: 'javascript',
      risk: 'safe',
    });
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, binPath] of Object.entries(pkg.bin)) {
      if (typeof binPath !== 'string') continue;
      artifactPaths.add(binPath);
      addCommand(commands, {
        id: `bin-${name}`,
        command: `node ${JSON.stringify(binPath)}`,
        source: `package.json#bin.${name}`,
        language: 'javascript',
        risk: 'safe',
      });
    }
  }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  for (const [name, script] of Object.entries(scripts)) {
    if (!/(^|:)(cli|bin|start|dev|test|check|lint|build|help|version)$/.test(name) && !/\b(node|tsx|python|ruby|go run|cargo run)\b/.test(script)) continue;
    addCommand(commands, {
      id: `script-${name.replace(/[^a-zA-Z0-9_.-]+/g, '-')}`,
      command: `npm run ${name}`,
      source: `package.json#scripts.${name}`,
      language: 'shell',
      risk: /deploy|publish|release|delete|rm\b/.test(script) ? 'destructive' : 'unknown',
    });
  }
  const deps = dependencyNames(pkg);
  for (const tool of ['commander', 'yargs', 'oclif', 'cac', 'clipanion']) {
    if (deps.has(tool)) artifactPaths.add('package.json');
  }
  if (fs.existsSync(path.resolve(cwd, 'tsconfig.json'))) artifactPaths.add('tsconfig.json');
}

function scanPython(cwd, commands, artifactPaths) {
  const pyproject = readText(path.resolve(cwd, 'pyproject.toml'));
  if (pyproject) {
    artifactPaths.add('pyproject.toml');
    const scriptsBlock = pyproject.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/);
    if (scriptsBlock) {
      for (const line of scriptsBlock[1].split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/);
        if (!match) continue;
        addCommand(commands, {
          id: `python-script-${match[1]}`,
          command: `python -m ${match[2].split(':')[0]}`,
          source: 'pyproject.toml#project.scripts',
          language: 'python',
          risk: 'safe',
        });
      }
    }
  }
  const candidates = listFiles(cwd, '.', (rel) => rel.endsWith('.py'), 80);
  for (const rel of candidates) {
    const text = readText(path.resolve(cwd, rel));
    if (!/(argparse|click\.|typer\.|fire\.Fire)/.test(text)) continue;
    artifactPaths.add(rel);
    addCommand(commands, {
      id: `python-${rel.replace(/[^a-zA-Z0-9_.-]+/g, '-')}`,
      command: `python ${JSON.stringify(rel)}`,
      source: rel,
      language: 'python',
      risk: /delete|remove|unlink|rmtree|drop/.test(text) ? 'destructive' : 'unknown',
    });
  }
}

function scanRustGoShell(cwd, commands, artifactPaths) {
  if (fs.existsSync(path.resolve(cwd, 'Cargo.toml'))) {
    artifactPaths.add('Cargo.toml');
    if (fs.existsSync(path.resolve(cwd, 'src/main.rs'))) artifactPaths.add('src/main.rs');
    addCommand(commands, {
      id: 'cargo-run',
      command: 'cargo run --quiet --',
      source: 'Cargo.toml',
      language: 'rust',
      risk: 'unknown',
      help_command: 'cargo run --quiet -- --help',
    });
  }
  if (fs.existsSync(path.resolve(cwd, 'go.mod'))) {
    artifactPaths.add('go.mod');
    const mains = listFiles(cwd, '.', (rel, abs) => rel.endsWith('.go') && /package\s+main/.test(readText(abs)), 20);
    for (const rel of mains) {
      artifactPaths.add(rel);
      addCommand(commands, {
        id: `go-${rel.replace(/[^a-zA-Z0-9_.-]+/g, '-')}`,
        command: `go run ${JSON.stringify(rel)}`,
        source: rel,
        language: 'go',
        risk: 'unknown',
      });
    }
  }
  const shells = listFiles(cwd, '.', (rel, abs) => {
    if (!/\.(sh|bash|zsh)$/.test(rel)) return false;
    return /^#!.*(sh|bash|zsh)/.test(readText(abs));
  }, 40);
  for (const rel of shells) {
    artifactPaths.add(rel);
    addCommand(commands, {
      id: `shell-${rel.replace(/[^a-zA-Z0-9_.-]+/g, '-')}`,
      command: `bash ${JSON.stringify(rel)}`,
      source: rel,
      language: 'shell',
      risk: 'unknown',
    });
  }
}

function scanCliRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const pkg = readJson(path.join(root, 'package.json'));
  const commands = [];
  const artifactPaths = new Set();
  scanPackageJson(root, pkg, commands, artifactPaths);
  scanPython(root, commands, artifactPaths);
  scanRustGoShell(root, commands, artifactPaths);
  const destructive = commands.filter((command) => command.risk === 'destructive');
  const gaps = [];
  if (commands.length === 0) gaps.push('no obvious CLI commands found');
  if (commands.some((command) => command.risk === 'unknown')) gaps.push('some commands need safe/destructive classification');
  if (destructive.length > 0) gaps.push('destructive-looking commands require explicit opt-in or mocks');
  return {
    schema: 'xoloop.cli_scan.v0.1',
    cwd: root,
    commands: commands.sort((a, b) => a.id.localeCompare(b.id)),
    artifact_paths: [...artifactPaths].filter((rel) => fs.existsSync(path.resolve(root, rel))).sort(),
    gaps,
  };
}

module.exports = {
  scanCliRepo,
};
