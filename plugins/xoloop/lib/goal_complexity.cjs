'use strict';

const fs = require('node:fs');
const path = require('node:path');

function countBranchTokens(text) {
  const stripped = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
  const matches = stripped.match(/\b(if|for|while|case|catch|switch)\b|&&|\|\||\?/g);
  return matches ? matches.length : 0;
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
};
