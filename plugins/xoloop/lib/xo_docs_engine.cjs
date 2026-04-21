'use strict';

/**
 * xo_docs_engine.cjs — helpers for xo-docs mode.
 *
 * xo-docs is NOT iterative. It runs 3 fixed rounds:
 *   Round 1: generate — subagent scans public API surface + tests +
 *            existing docs, proposes JSDoc/docstrings, README ToC
 *            update, CHANGELOG stub
 *   Round 2: polish — tighten language, verify examples compile, remove
 *            AI-slop patterns
 *   Round 3: polish — final pass, check links + duplicate headings
 *
 * This module exports the SCAN helpers — the actual subagent prompting
 * lives in the SKILL.md. Scan output becomes the "context packet" the
 * subagent receives.
 *
 * Exports:
 *   - discoverSurfaceFiles(repoRoot) → string[]
 *   - extractPublicSymbols(filePath) → { file, symbols: [{name, kind, existingDoc}] }
 *   - findExistingDocFiles(repoRoot) → string[]
 *   - validateDocsProposal(proposal) → { ok, reason }
 */

const fs = require('node:fs');
const path = require('node:path');
const { scanExports, detectLanguage } = require('./xo_simplify_engine.cjs');

const DOC_FILE_PATTERNS = [
  /^README(\.\w+)?$/i,
  /^CHANGELOG(\.\w+)?$/i,
  /^docs?\/.*\.(md|rst|adoc)$/i,
  /^doc\/.*\.(md|rst|adoc)$/i,
];

const SOURCE_EXTS = ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.rb'];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
  'target', 'venv', '.venv', '__pycache__', '.pytest_cache',
  '.xoloop', '.cache', 'tmp', 'out',
]);

function walkRepo(repoRoot, onFile, relRoot = '') {
  const absolute = path.join(repoRoot, relRoot);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }); }
  catch (_ignoreWalkError) { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (entry.name === '.github') {
        // descend into .github for PR templates etc.
        walkRepo(repoRoot, onFile, path.join(relRoot, entry.name));
      }
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.join(relRoot, entry.name);
    if (entry.isDirectory()) {
      walkRepo(repoRoot, onFile, rel);
    } else if (entry.isFile()) {
      onFile(rel);
    }
  }
}

function discoverSurfaceFiles(repoRoot) {
  const files = [];
  walkRepo(repoRoot, (rel) => {
    const ext = path.extname(rel).toLowerCase();
    if (!SOURCE_EXTS.includes(ext)) return;
    // Skip test files — they're input for examples, not targets for docs.
    if (/[._-](test|spec)[._-]|(^|\/)__tests__\//.test(rel)) return;
    files.push(rel);
  });
  return files.sort();
}

function findExistingDocFiles(repoRoot) {
  const docs = [];
  walkRepo(repoRoot, (rel) => {
    const base = path.basename(rel);
    for (const re of DOC_FILE_PATTERNS) {
      if (re.test(rel) || re.test(base)) { docs.push(rel); break; }
    }
  });
  return docs.sort();
}

/**
 * Extract public symbols (exports) with their kind + any existing doc
 * immediately preceding them.
 */
function extractPublicSymbols(filePath) {
  if (!fs.existsSync(filePath)) return { file: filePath, symbols: [] };
  const source = fs.readFileSync(filePath, 'utf8');
  const language = detectLanguage(filePath);
  const info = scanExports(filePath);
  const symbolList = [];
  for (const sym of info.exports) {
    symbolList.push({
      name: sym,
      kind: inferKind(source, sym, language),
      existingDoc: findExistingDoc(source, sym, language),
    });
  }
  return { file: filePath, symbols: symbolList, language };
}

function inferKind(source, name, language) {
  if (language === 'javascript') {
    if (new RegExp(`\\bclass\\s+${name}\\b`).test(source)) return 'class';
    if (new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\b`).test(source)) return 'function';
    if (new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(source)) return 'variable';
    return 'symbol';
  }
  if (language === 'python') {
    if (new RegExp(`^class\\s+${name}\\b`, 'm').test(source)) return 'class';
    if (new RegExp(`^(?:async\\s+)?def\\s+${name}\\b`, 'm').test(source)) return 'function';
    return 'symbol';
  }
  return 'symbol';
}

/**
 * Find a docblock / docstring immediately preceding a symbol definition.
 * Returns the text of the doc (if present) or null.
 */
function findExistingDoc(source, name, language) {
  if (language === 'javascript') {
    // Look for /** ... */ right before a line that mentions `name`
    const re = new RegExp(`/\\*\\*([\\s\\S]*?)\\*/\\s*(?:export\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+${name}\\b`);
    const m = source.match(re);
    return m ? m[1].trim() : null;
  }
  if (language === 'python') {
    // Def / class with a """...""" immediately after the signature
    const re = new RegExp(`^(?:async\\s+)?(?:def|class)\\s+${name}\\b[^:]*:[\\s\\r\\n]*"""([\\s\\S]*?)"""`, 'm');
    const m = source.match(re);
    return m ? m[1].trim() : null;
  }
  return null;
}

/**
 * Validate a docs proposal. Unlike simplify, docs proposals CAN create
 * new files but CANNOT touch source files outside of a docblock region.
 *
 * Allowed ops:
 *   - create_file for docs/ or README*
 *   - replace_once for docs/ or README* or CHANGELOG*
 *   - replace_once for source files where match+replace differ only in
 *     a comment/docstring block (heuristic: if match OR replace starts
 *     with /**, //, #, """, or is purely a docblock region)
 */
function validateDocsProposal(proposal) {
  if (!proposal || !Array.isArray(proposal.changeSet)) {
    return { ok: false, reason: 'proposal.changeSet must be an array' };
  }
  for (const op of proposal.changeSet) {
    if (!op || !op.path) continue;
    const rel = String(op.path).replace(/\\/g, '/');
    const isDocTarget = DOC_FILE_PATTERNS.some((re) => re.test(rel) || re.test(path.basename(rel)));
    if (isDocTarget) continue;
    // Non-doc target: only accept if it's a comment/docstring edit
    if (op.kind === 'create_file') {
      return { ok: false, reason: `docs cannot create new source files: ${rel}` };
    }
    if (op.kind === 'delete_file') {
      return { ok: false, reason: `docs cannot delete files: ${rel}` };
    }
    if (op.kind === 'replace_once') {
      const match = String(op.match || '');
      const replace = String(op.replace || '');
      if (!isDocblockEdit(match, replace)) {
        return {
          ok: false,
          reason: `docs can only edit docblocks in source files, not logic: ${rel}`,
        };
      }
    }
  }
  return { ok: true };
}

function isDocblockEdit(match, replace) {
  // Conservative heuristic: both sides must look like a pure docblock OR
  // the edit must be adding docblock content (insertion only).
  const docblockRe = /^(\s*(?:\/\*\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"""[\s\S]*?""")\s*)+$/;
  const matchIsDoc = docblockRe.test(match) || match.trim() === '';
  const replaceIsDoc = docblockRe.test(replace) || replace.trim() === '';
  // Both empty → trivial, fine. One empty = pure insertion/deletion of doc.
  if (matchIsDoc && replaceIsDoc) return true;
  // Otherwise: require the NON-doc parts to be byte-identical
  const matchCleaned = stripDocblocks(match);
  const replaceCleaned = stripDocblocks(replace);
  return matchCleaned === replaceCleaned;
}

function stripDocblocks(text) {
  return String(text)
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/(^|\n)\s*#[^\n]*/g, '$1')
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  discoverSurfaceFiles,
  findExistingDocFiles,
  extractPublicSymbols,
  validateDocsProposal,
  isDocblockEdit,
};
