'use strict';

const fs = require('node:fs');
const path = require('node:path');

function countBranchTokens(text) {
  const stripped = stripCommentsAndStrings(String(text));
  const matches = stripped.match(/\b(if|for|while|case|catch|switch)\b|&&|\|\||\?/g);
  return matches ? matches.length : 0;
}

function stripCommentsAndStrings(text) {
  let out = '';
  let state = 'code';
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1] || '';
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        index += 1;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      const end = state === 'single' ? "'" : (state === 'double' ? '"' : '`');
      out += ch === '\n' ? '\n' : ' ';
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === end) {
        state = 'code';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      state = 'line';
      out += '  ';
      index += 1;
    } else if (ch === '/' && next === '*') {
      state = 'block';
      out += '  ';
      index += 1;
    } else if (ch === "'") {
      state = 'single';
      out += ' ';
    } else if (ch === '"') {
      state = 'double';
      out += ' ';
    } else if (ch === '`') {
      state = 'template';
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

function measureComplexity(goal, cwd) {
  const repoRoot = path.resolve(cwd || process.cwd());
  const paths = Array.isArray(goal.artifacts && goal.artifacts.paths) ? goal.artifacts.paths : [];
  const files = [];
  let loc = 0;
  let bytes = 0;
  let branchCount = 0;
  let dependencyCount = 0;

  for (const rel of paths) {
    const absolute = path.resolve(repoRoot, rel);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      files.push({ path: rel, missing: true });
      continue;
    }
    const text = fs.readFileSync(absolute, 'utf8');
    const fileLoc = text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//')).length;
    const fileBranches = countBranchTokens(text);
    const deps = new Set();
    const requirePattern = /\brequire\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g;
    const importPattern = /\bfrom\s+['"]([^.'"][^'"]*)['"]/g;
    let match = requirePattern.exec(text);
    while (match) {
      deps.add(match[1]);
      match = requirePattern.exec(text);
    }
    match = importPattern.exec(text);
    while (match) {
      deps.add(match[1]);
      match = importPattern.exec(text);
    }
    loc += fileLoc;
    bytes += Buffer.byteLength(text, 'utf8');
    branchCount += fileBranches;
    dependencyCount += deps.size;
    files.push({
      path: rel,
      loc: fileLoc,
      bytes: Buffer.byteLength(text, 'utf8'),
      branch_count: fileBranches,
      dependency_count: deps.size,
    });
  }

  const fileCount = files.filter((f) => !f.missing).length;
  const complexityScore = loc + branchCount * 3 + dependencyCount * 5 + fileCount * 2;

  return {
    loc,
    file_count: fileCount,
    dependency_count: dependencyCount,
    bundle_bytes: bytes,
    branch_count: branchCount,
    complexity_score: complexityScore,
    files,
  };
}

module.exports = {
  countBranchTokens,
  measureComplexity,
  stripCommentsAndStrings,
};
