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
const { spawnSync } = require('node:child_process');
const { scanExports, detectLanguage } = require('./xo_simplify_engine.cjs');

const DOC_FILE_PATTERNS = [
  /^README(\.\w+)?$/i,
  /^CHANGELOG(\.\w+)?$/i,
  /^docs?\/.*\.(md|rst|adoc)$/i,
  /^doc\/.*\.(md|rst|adoc)$/i,
];

const SOURCE_EXTS = ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.swift', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'];

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
  if (language === 'ruby') {
    if (new RegExp(`^class\\s+${name}\\b`, 'm').test(source)) return 'class';
    if (new RegExp(`^module\\s+${name}\\b`, 'm').test(source)) return 'module';
    if (new RegExp(`^def\\s+(?:self\\.)?${name}\\b`, 'm').test(source)) return 'function';
    return 'symbol';
  }
  if (language === 'go') {
    if (new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\(`, 'm').test(source)) return 'function';
    if (new RegExp(`^type\\s+${name}\\s+struct\\b`, 'm').test(source)) return 'struct';
    if (new RegExp(`^type\\s+${name}\\s+interface\\b`, 'm').test(source)) return 'interface';
    if (new RegExp(`^type\\s+${name}\\b`, 'm').test(source)) return 'type';
    if (new RegExp(`^(?:var|const)\\s+${name}\\b`, 'm').test(source)) return 'variable';
    return 'symbol';
  }
  if (language === 'rust') {
    if (new RegExp(`\\bpub\\s+(?:async\\s+)?fn\\s+${name}\\b`).test(source)) return 'function';
    if (new RegExp(`\\bpub\\s+struct\\s+${name}\\b`).test(source)) return 'struct';
    if (new RegExp(`\\bpub\\s+enum\\s+${name}\\b`).test(source)) return 'enum';
    if (new RegExp(`\\bpub\\s+trait\\s+${name}\\b`).test(source)) return 'trait';
    if (new RegExp(`\\bpub\\s+mod\\s+${name}\\b`).test(source)) return 'module';
    return 'symbol';
  }
  if (language === 'java' || language === 'kotlin') {
    if (new RegExp(`\\b(?:public\\s+)?(?:class|data\\s+class)\\s+${name}\\b`).test(source)) return 'class';
    if (new RegExp(`\\b(?:public\\s+)?interface\\s+${name}\\b`).test(source)) return 'interface';
    if (new RegExp(`\\b(?:public\\s+)?(?:enum\\s+class|enum)\\s+${name}\\b`).test(source)) return 'enum';
    if (new RegExp(`\\b(?:public\\s+)?(?:fun|[A-Za-z_][\\w<>, ?\\[\\]]+)\\s+${name}\\s*\\(`).test(source)) return 'function';
    return 'symbol';
  }
  if (language === 'csharp') {
    if (new RegExp(`\\bpublic\\s+(?:class|record)\\s+${name}\\b`).test(source)) return 'class';
    if (new RegExp(`\\bpublic\\s+interface\\s+${name}\\b`).test(source)) return 'interface';
    if (new RegExp(`\\bpublic\\s+struct\\s+${name}\\b`).test(source)) return 'struct';
    if (new RegExp(`\\bpublic\\s+enum\\s+${name}\\b`).test(source)) return 'enum';
    if (new RegExp(`\\bpublic\\s+(?:static\\s+)?(?:async\\s+)?[A-Za-z_][\\w<>, ?\\[\\]]*\\s+${name}\\s*\\(`).test(source)) return 'function';
    return 'symbol';
  }
  if (language === 'swift') {
    if (new RegExp(`\\b(?:public|open)\\s+(?:final\\s+)?class\\s+${name}\\b`).test(source)) return 'class';
    if (new RegExp(`\\b(?:public|open)\\s+struct\\s+${name}\\b`).test(source)) return 'struct';
    if (new RegExp(`\\b(?:public|open)\\s+enum\\s+${name}\\b`).test(source)) return 'enum';
    if (new RegExp(`\\b(?:public|open)\\s+protocol\\s+${name}\\b`).test(source)) return 'protocol';
    if (new RegExp(`\\b(?:public|open)\\s+(?:static\\s+)?func\\s+${name}\\s*\\(`).test(source)) return 'function';
    return 'symbol';
  }
  if (language === 'c' || language === 'cpp') {
    if (new RegExp(`\\b(?:class|struct)\\s+${name}\\b`).test(source)) return language === 'cpp' ? 'class' : 'struct';
    if (new RegExp(`\\b(?:enum)\\s+${name}\\b`).test(source)) return 'enum';
    if (new RegExp(`\\b${name}\\s*\\(`).test(source)) return 'function';
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
    const astDoc = findPythonDocWithAst(source, name);
    if (astDoc !== undefined) return astDoc;
    const re = new RegExp(`^(?:async\\s+)?(?:def|class)\\s+${name}\\b[^:]*:[\\s\\r\\n]*"""([\\s\\S]*?)"""`, 'm');
    const m = source.match(re);
    return m ? m[1].trim() : null;
  }
  if (language === 'ruby') {
    const ripperDoc = findRubyDocWithRipper(source, name);
    if (ripperDoc !== undefined) return ripperDoc;
    const re = new RegExp(`((?:^\\s*#.*\\n)+)\\s*(?:class|module|def\\s+(?:self\\.)?)${name}\\b`, 'm');
    const m = source.match(re);
    return m ? m[1].replace(/^\s*#\s?/gm, '').trim() : null;
  }
  if (language === 'go') {
    const re = new RegExp(`((?:^//\\s*.*\\n)+)(?:func\\s+(?:\\([^)]*\\)\\s*)?|type\\s+|var\\s+|const\\s+)${name}\\b`, 'm');
    const m = source.match(re);
    return m ? m[1].replace(/^\/\/\s?/gm, '').trim() : null;
  }
  if (language === 'rust') {
    const re = new RegExp(`((?:^\\s*///\\s*.*\\n)+)\\s*pub\\s+(?:async\\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\\s+${name}\\b`, 'm');
    const m = source.match(re);
    return m ? m[1].replace(/^\s*\/\/\/\s?/gm, '').trim() : null;
  }
  if (language === 'java' || language === 'kotlin' || language === 'csharp' || language === 'swift' || language === 'c' || language === 'cpp') {
    return findLeadingBlockDoc(source, name);
  }
  return null;
}

function findLeadingBlockDoc(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const symbolLine = new RegExp(`\\b${escaped}\\b`);
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!symbolLine.test(line)) continue;
    if (/^\s*(?:\/|\*)/.test(line)) continue;
    if (!/[({]/.test(line)) continue;

    let cursor = i - 1;
    while (cursor >= 0 && lines[cursor].trim() === '') cursor -= 1;
    if (cursor < 0) return null;

    if (/^\s*\/\/\//.test(lines[cursor])) {
      const docLines = [];
      while (cursor >= 0 && /^\s*\/\/\//.test(lines[cursor])) {
        docLines.unshift(lines[cursor].replace(/^\s*\/\/\/\s?/, ''));
        cursor -= 1;
      }
      return docLines.join('\n').trim() || null;
    }

    if (/^\s*\*\//.test(lines[cursor])) {
      const docLines = [];
      cursor -= 1;
      while (cursor >= 0 && !/^\s*\/\*\*/.test(lines[cursor])) {
        docLines.unshift(lines[cursor].replace(/^\s*\*\s?/, ''));
        cursor -= 1;
      }
      if (cursor >= 0) {
        const first = lines[cursor].replace(/^\s*\/\*\*\s?/, '').replace(/\*\/\s*$/, '');
        if (first.trim()) docLines.unshift(first);
      }
      return docLines.join('\n').trim() || null;
    }
  }
  return null;
}

function findPythonDocWithAst(source, name) {
  const script = [
    'import ast, json, sys',
    'source = sys.stdin.read()',
    'name = sys.argv[1]',
    'tree = ast.parse(source)',
    'docs = {}',
    'for node in tree.body:',
    '    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):',
    '        docs[node.name] = ast.get_docstring(node)',
    'print(json.dumps(docs.get(name)))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script, name], {
    input: source,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout || 'null');
  } catch (_err) {
    return undefined;
  }
}

function findRubyDocWithRipper(source, name) {
  // Ripper gives stable line numbers; use those to collect the contiguous
  // comment block immediately above the public definition.
  const lines = source.split(/\r?\n/);
  const definitionPatterns = [
    new RegExp(`^\\s*def\\s+(?:self\\.)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    new RegExp(`^\\s*class\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    new RegExp(`^\\s*module\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  ];
  const lineIndex = lines.findIndex((line) => definitionPatterns.some((re) => re.test(line)));
  if (lineIndex < 0) return undefined;
  const docs = [];
  for (let i = lineIndex - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/^\s*#/.test(line)) {
      docs.unshift(line.replace(/^\s*#\s?/, ''));
      continue;
    }
    if (line.trim() === '') continue;
    break;
  }
  return docs.length > 0 ? docs.join('\n').trim() : null;
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
  findPythonDocWithAst,
  findRubyDocWithRipper,
};
