const fs = require('node:fs');
const path = require('node:path');

/**
 * reference_verifier.cjs — fact-check proposals against the real filesystem.
 *
 * Context: burst6/burst7 pinned-plan hybrid runs produced 6 committed patches
 * that passed every existing gate (staged check, test:unit, quick + full
 * validation) but contained references to npm scripts, file paths, and field
 * names that did not exist. Four of them shipped `npm run init:overnight`,
 * `mcp:stdio -- init`, `--tool init`, or `scripts/overnight_loop.cjs` — all
 * fabricated. A single grep against package.json and the filesystem would
 * have caught every one of them in under a second, but the engine had no
 * stage that did that grep.
 *
 * This module scans the replace blocks of a parsed proposal for three
 * reference patterns and fails fast when any one of them points at a target
 * that does not exist on disk:
 *
 *   1. `npm run <script>` — the <script> must be a key in package.json's scripts.
 *   2. `node scripts/<file>` (or bare `scripts/<file>`) — the file must exist.
 *   3. `require('./...')` / `require('../...')` — relative path must resolve
 *      with a .js / .cjs / .mjs / .json extension, or an index file.
 *
 * Scope deliberately excludes:
 *   - External npm packages (`require('yaml')`) — they may live in dependencies.
 *   - Absolute paths — safer to leave alone than to validate against a user's
 *     filesystem layout.
 *   - Shell comments (`# npm run foo`) — treated the same as live commands
 *     because docs comments can still mislead contributors.
 *
 * The verifier only inspects the REPLACE text of code_changes and test_changes.
 * SEARCH text is what the editor is removing, so it is not the engine's problem
 * if the incoming file already contains a bad reference — only what the model
 * is ADDING counts.
 */

const NPM_RUN_PATTERN = /npm\s+run\s+([A-Za-z0-9_:\-.]+)/g;
const NODE_SCRIPT_PATTERN = /\bnode\s+(scripts\/[A-Za-z0-9_./-]+)/g;
const BARE_SCRIPT_PATTERN = /(?:^|[\s`"'(])(scripts\/[A-Za-z0-9_./-]+\.c?m?js)(?=[\s`"')]|$)/g;
const REQUIRE_PATTERN = /require\(\s*['"](\.{1,2}\/[^'"\s]+)['"]\s*\)/g;

function loadPackageScripts(repoRoot) {
  try {
    const pkgPath = path.join(repoRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return {};
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function collectMatches(text, pattern) {
  const results = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    results.push({ full: match[0], captured: match[1] });
    match = pattern.exec(text);
  }
  return results;
}

function fileExistsWithCommonExtensions(repoRoot, relativePath) {
  const base = path.resolve(repoRoot, relativePath);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.json`,
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
  ];
  return candidates.some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

/**
 * Verify a single block of replace text against the repoRoot. Returns an
 * array of hallucinated references (empty array means clean).
 */
function verifyReplaceText(text, options) {
  const { repoRoot, packageScripts, sourcePath } = options;
  const hallucinated = [];

  for (const { captured } of collectMatches(text, NPM_RUN_PATTERN)) {
    if (!Object.prototype.hasOwnProperty.call(packageScripts, captured)) {
      hallucinated.push({
        kind: 'npm-script',
        reference: `npm run ${captured}`,
        reason: `package.json has no script "${captured}"`,
      });
    }
  }

  const nodeScriptPaths = new Set();
  for (const { captured } of collectMatches(text, NODE_SCRIPT_PATTERN)) {
    nodeScriptPaths.add(captured);
    const scriptPath = path.resolve(repoRoot, captured);
    if (!fs.existsSync(scriptPath)) {
      hallucinated.push({
        kind: 'node-script-path',
        reference: `node ${captured}`,
        reason: `${captured} does not exist at ${repoRoot}`,
      });
    }
  }

  for (const { captured } of collectMatches(text, BARE_SCRIPT_PATTERN)) {
    if (nodeScriptPaths.has(captured)) continue;
    const scriptPath = path.resolve(repoRoot, captured);
    if (!fs.existsSync(scriptPath)) {
      hallucinated.push({
        kind: 'bare-script-path',
        reference: captured,
        reason: `${captured} does not exist at ${repoRoot}`,
      });
    }
  }

  // Require paths resolve relative to the file being edited, not the repo
  // root. If sourcePath is missing we skip require checks entirely.
  if (sourcePath) {
    const sourceDir = path.dirname(path.resolve(repoRoot, sourcePath));
    for (const { captured } of collectMatches(text, REQUIRE_PATTERN)) {
      const resolvedBase = path.resolve(sourceDir, captured);
      const repoRelative = path.relative(repoRoot, resolvedBase);
      if (!fileExistsWithCommonExtensions(repoRoot, repoRelative)) {
        hallucinated.push({
          kind: 'require-path',
          reference: `require('${captured}')`,
          reason: `relative path ${captured} (from ${sourcePath}) does not resolve to a file`,
        });
      }
    }
  }

  return hallucinated;
}

/**
 * Top-level API. Accepts a parsed proposal (as produced by parseProposal) and
 * a repoRoot (typically the surface worktree path). Returns:
 *   { ok: true }                 — nothing hallucinated
 *   { ok: false, hallucinated }  — array of findings, each with {kind, reference, reason, path}
 */
function verifyProposalReferences(proposal, options = {}) {
  if (!proposal || typeof proposal !== 'object') {
    return { ok: true };
  }
  const safeOptions = options && typeof options === 'object' ? options : {};
  const { repoRoot } = safeOptions;
  if (!repoRoot) {
    return { ok: true };
  }
  const packageScripts = loadPackageScripts(repoRoot);
  const hallucinated = [];
  const blocks = [
    ...(Array.isArray(proposal.codeChanges) ? proposal.codeChanges : []),
    ...(Array.isArray(proposal.testChanges) ? proposal.testChanges : []),
  ];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const replaceText = String(block.replace || '');
    if (!replaceText) continue;
    const findings = verifyReplaceText(replaceText, {
      repoRoot,
      packageScripts,
      sourcePath: block.path,
    });
    for (const finding of findings) {
      hallucinated.push({ ...finding, path: block.path });
    }
  }
  if (hallucinated.length === 0) {
    return { ok: true };
  }
  return { ok: false, hallucinated };
}

/**
 * Build a human-readable, machine-parsable summary line from the hallucinated
 * array so the engine can pass it into the rejection reason and the next
 * repair prompt without post-processing.
 *
 * Each entry includes the source file path when present so repair prompts
 * know exactly which file contains the bad reference without re-scanning.
 */
function summarizeHallucinated(hallucinated) {
  if (!Array.isArray(hallucinated) || hallucinated.length === 0) return '';
  return hallucinated
    .map((entry) => {
      const location = entry.path ? ` in ${entry.path}` : '';
      return `${entry.kind}: ${entry.reference}${location} (${entry.reason})`;
    })
    .join('; ');
}

module.exports = {
  verifyProposalReferences,
  summarizeHallucinated,
  // Exported for tests:
  verifyReplaceText,
  loadPackageScripts,
};
