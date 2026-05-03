'use strict';

/**
 * xo_simplify_engine.cjs — gates and metrics for xo-simplify mode.
 *
 * Simplify mode is DELETION-FOCUSED polish. It deletes code, collapses
 * redundant abstractions, removes dead branches — but only when tests
 * still pass AND the complexity metric improves AND only internal
 * symbols are touched.
 *
 * This module exposes pure helpers the bridge (xoloop-apply-proposal)
 * and CLI wrapper (xoloop-simplify) use to gate proposals:
 *
 *   - isTestFile(path) → boolean
 *   - scanExports(filePath) → { exports: Set<string>, language: string }
 *   - measureComplexity(filePath) → { sloc, cyclomatic, exports }
 *   - aggregateMetric(before, after) → { direction, delta }
 *   - validateSimplifyProposal(proposal, repoRoot) →
 *       { ok, reason, deletedExports, touchedTests }
 *
 * Languages handled (by file extension):
 *   .js .cjs .mjs .ts .tsx .jsx → JavaScript/TypeScript
 *   .py → Python
 *   .rb → Ruby (exports = non-underscore constants/methods at top level)
 *   .go → Go exported top-level identifiers
 *   .rs → Rust pub items
 *   .java .kt .cs .swift .c .h .cpp .hpp → public API heuristics
 *   other languages → flagged as "unknown" → fail-safe refuse export deletions
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_FILE_PATTERNS = [
  /(^|[\/\\])__tests__[\/\\]/,
  /(^|[\/\\])tests?[\/\\]/,
  /(^|[\/\\])spec[\/\\]/,
  /\.test\.[a-zA-Z]+$/,
  /\.spec\.[a-zA-Z]+$/,
  /_test\.[a-zA-Z]+$/,
  /_spec\.[a-zA-Z]+$/,
];

function isTestFile(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return TEST_FILE_PATTERNS.some((re) => re.test(normalized));
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx'].includes(ext)) return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rb') return 'ruby';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.java') return 'java';
  if (['.kt', '.kts'].includes(ext)) return 'kotlin';
  if (ext === '.cs') return 'csharp';
  if (ext === '.swift') return 'swift';
  if (['.c', '.h'].includes(ext)) return 'c';
  if (['.cc', '.cpp', '.cxx', '.hpp', '.hh'].includes(ext)) return 'cpp';
  return 'unknown';
}

/**
 * Scan exported symbols in JS/TS:
 *   module.exports = { a, b }           → ['a', 'b']
 *   module.exports.foo = ...             → ['foo']
 *   exports.bar = ...                    → ['bar']
 *   export const x = ...                 → ['x']
 *   export function y() ...              → ['y']
 *   export class Z {}                    → ['Z']
 *   export default ...                   → ['default']
 *   export { a, b as c }                 → ['a', 'c']
 */
function scanJsExports(source) {
  const exports = new Set();

  // export const/let/var NAME
  const constRe = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of source.matchAll(constRe)) exports.add(m[1]);

  // export function NAME / export async function NAME
  const fnRe = /\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
  for (const m of source.matchAll(fnRe)) exports.add(m[1]);

  // export class NAME
  const classRe = /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g;
  for (const m of source.matchAll(classRe)) exports.add(m[1]);

  // export default
  if (/\bexport\s+default\b/.test(source)) exports.add('default');

  // export { a, b as c }
  const braceRe = /\bexport\s*\{([^}]+)\}/g;
  for (const m of source.matchAll(braceRe)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const asMatch = part.match(/(?:^|\s)as\s+([A-Za-z_$][\w$]*)\s*$/);
      if (asMatch) exports.add(asMatch[1]);
      else exports.add(part.replace(/\s+.*/, ''));
    }
  }

  // module.exports = NAME  → value exported, but key list comes from the object literal if any
  const moduleExportsRe = /\bmodule\.exports\s*=\s*\{([^}]+)\}/g;
  for (const m of source.matchAll(moduleExportsRe)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const keyMatch = part.match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (keyMatch) exports.add(keyMatch[1]);
      else if (/^[A-Za-z_$][\w$]*$/.test(part)) exports.add(part);
    }
  }

  // module.exports.X = ...   /  exports.X = ...
  const dotAssignRe = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
  for (const m of source.matchAll(dotAssignRe)) exports.add(m[1]);

  return exports;
}

/**
 * Scan exported symbols in Python.
 * Rules:
 *   - If __all__ = [...] is present, those are the exports (authoritative)
 *   - Otherwise, every module-level def/class not prefixed with _ is exported
 */
function scanPyExports(source) {
  const astExports = scanPyExportsWithAst(source);
  if (astExports !== null) return astExports;

  const exports = new Set();

  // Check for __all__ first
  const allRe = /^\s*__all__\s*=\s*\[([^\]]+)\]/m;
  const allMatch = source.match(allRe);
  if (allMatch) {
    for (const raw of allMatch[1].split(',')) {
      const s = raw.trim().replace(/^['"]|['"]$/g, '');
      if (s && /^[A-Za-z_][\w]*$/.test(s)) exports.add(s);
    }
    return exports;
  }

  // Module-level def NAME / class NAME, not underscore-prefixed.
  const defRe = /^(?:async\s+)?def\s+([A-Za-z][\w]*)/gm;
  for (const m of source.matchAll(defRe)) {
    if (!m[1].startsWith('_')) exports.add(m[1]);
  }
  const classRe = /^class\s+([A-Za-z][\w]*)/gm;
  for (const m of source.matchAll(classRe)) {
    if (!m[1].startsWith('_')) exports.add(m[1]);
  }

  return exports;
}

/**
 * Scan exported symbols in Ruby.
 * Heuristic: top-level def methods + CONSTANT names that aren't prefixed
 * with _. Classes and modules are also "exported".
 */
function scanRbExports(source) {
  const ripperExports = scanRbExportsWithRipper(source);
  if (ripperExports !== null) return ripperExports;

  const exports = new Set();
  const defRe = /^def\s+(self\.)?([A-Za-z][\w]*[!?=]?)/gm;
  for (const m of source.matchAll(defRe)) {
    const name = m[2];
    if (!name.startsWith('_')) exports.add(name);
  }
  const classRe = /^class\s+([A-Z][\w:]*)/gm;
  for (const m of source.matchAll(classRe)) exports.add(m[1]);
  const modRe = /^module\s+([A-Z][\w:]*)/gm;
  for (const m of source.matchAll(modRe)) exports.add(m[1]);
  const constRe = /^([A-Z][A-Z0-9_]+)\s*=/gm;
  for (const m of source.matchAll(constRe)) exports.add(m[1]);
  return exports;
}

function scanPyExportsWithAst(source) {
  const script = [
    'import ast, json, sys',
    'source = sys.stdin.read()',
    'tree = ast.parse(source)',
    'exports = []',
    'all_names = None',
    'for node in tree.body:',
    '    if isinstance(node, ast.Assign):',
    "        if any(isinstance(t, ast.Name) and t.id == '__all__' for t in node.targets):",
    '            if isinstance(node.value, (ast.List, ast.Tuple)):',
    '                all_names = [elt.value for elt in node.value.elts if isinstance(elt, ast.Constant) and isinstance(elt.value, str)]',
    '    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):',
    "        if not node.name.startswith('_'): exports.append(node.name)",
    'print(json.dumps(all_names if all_names is not None else exports))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script], {
    input: source,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  try {
    const names = JSON.parse(result.stdout || '[]');
    return new Set(Array.isArray(names) ? names.filter((name) => typeof name === 'string') : []);
  } catch (_err) {
    return null;
  }
}

function scanRbExportsWithRipper(source) {
  const script = [
    "require 'json'",
    "require 'ripper'",
    'source = STDIN.read',
    'sexp = Ripper.sexp(source)',
    'exports = []',
    'walk = lambda do |node, depth|',
    '  next unless node.is_a?(Array)',
    '  type = node[0]',
    "  if depth == 0 && type == :def && node[1].is_a?(Array) && node[1][1].is_a?(String)",
    '    name = node[1][1]',
    "    exports << name unless name.start_with?('_')",
    "  elsif depth == 0 && type == :defs && node[3].is_a?(Array) && node[3][1].is_a?(String)",
    '    name = node[3][1]',
    "    exports << name unless name.start_with?('_')",
    "  elsif depth == 0 && [:class, :module].include?(type)",
    '    name_node = node[1]',
    "    names = name_node.flatten.select { |v| v.is_a?(String) && v =~ /^[A-Z]/ }",
    '    exports << names.join("::") unless names.empty?',
    '  end',
    '  node.each_with_index do |child, index|',
    '    next if index == 0',
    '    walk.call(child, depth + 1) if child.is_a?(Array)',
    '  end',
    'end',
    'if sexp && sexp[0] == :program && sexp[1].is_a?(Array)',
    '  sexp[1].each { |child| walk.call(child, 0) }',
    'end',
    'source.scan(/^([A-Z][A-Z0-9_]*)\\s*=/) { |m| exports << m[0] }',
    'puts JSON.generate(exports.uniq)',
  ].join('\n');
  const result = spawnSync('ruby', ['-e', script], {
    input: source,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  try {
    const names = JSON.parse(result.stdout || '[]');
    return new Set(Array.isArray(names) ? names.filter((name) => typeof name === 'string') : []);
  } catch (_err) {
    return null;
  }
}

function scanGoExports(source) {
  const exports = new Set();
  const exportedName = '([A-Z][A-Za-z0-9_]*)';
  const patterns = [
    new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${exportedName}\\s*\\(`, 'gm'),
    new RegExp(`^type\\s+${exportedName}\\b`, 'gm'),
    new RegExp(`^(?:var|const)\\s+${exportedName}\\b`, 'gm'),
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) exports.add(m[1]);
  }
  return exports;
}

function scanRustExports(source) {
  const exports = new Set();
  const patterns = [
    /\bpub\s+(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
    /\bpub\s+(?:struct|enum|trait|type|const|static|mod)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) exports.add(m[1]);
  }
  return exports;
}

function scanJvmExports(source, language) {
  const exports = new Set();
  const patterns = language === 'kotlin'
    ? [
      /\b(?:public\s+)?(?:class|interface|object|enum\s+class|data\s+class)\s+([A-Z][A-Za-z0-9_]*)\b/g,
      /\b(?:public\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    ]
    : [
      /\bpublic\s+(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+([A-Z][A-Za-z0-9_]*)\b/g,
      /\bpublic\s+(?:static\s+)?(?:final\s+)?[A-Za-z_][\w<>, ?\[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) exports.add(m[1]);
  }
  return exports;
}

function scanCSharpExports(source) {
  const exports = new Set();
  const patterns = [
    /\bpublic\s+(?:class|interface|struct|enum|record)\s+([A-Z][A-Za-z0-9_]*)\b/g,
    /\bpublic\s+(?:static\s+)?(?:async\s+)?[A-Za-z_][\w<>, ?\[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) exports.add(m[1]);
  }
  return exports;
}

function scanSwiftExports(source) {
  const exports = new Set();
  const patterns = [
    /\b(?:public|open)\s+(?:final\s+)?(?:class|struct|enum|protocol|actor)\s+([A-Z][A-Za-z0-9_]*)\b/g,
    /\b(?:public|open)\s+(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) exports.add(m[1]);
  }
  return exports;
}

function scanCFamilyExports(source) {
  const exports = new Set();
  const patterns = [
    /^\s*(?:extern\s+)?(?:[A-Za-z_][\w:<>]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*;/gm,
    /^\s*(?:class|struct|enum)\s+([A-Z][A-Za-z0-9_]*)\b/gm,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) exports.add(m[1]);
  }
  return exports;
}

function scanExports(filePath) {
  const language = detectLanguage(filePath);
  if (!fs.existsSync(filePath)) {
    return { exports: new Set(), language, exists: false };
  }
  const source = fs.readFileSync(filePath, 'utf8');
  let exports;
  if (language === 'javascript') exports = scanJsExports(source);
  else if (language === 'python') exports = scanPyExports(source);
  else if (language === 'ruby') exports = scanRbExports(source);
  else if (language === 'go') exports = scanGoExports(source);
  else if (language === 'rust') exports = scanRustExports(source);
  else if (language === 'java' || language === 'kotlin') exports = scanJvmExports(source, language);
  else if (language === 'csharp') exports = scanCSharpExports(source);
  else if (language === 'swift') exports = scanSwiftExports(source);
  else if (language === 'c' || language === 'cpp') exports = scanCFamilyExports(source);
  else exports = new Set(); // unknown — caller decides fail-safe behavior
  return { exports, language, exists: true, source };
}

/**
 * Compute complexity metric for a file.
 *   - sloc: non-blank non-comment lines
 *   - cyclomatic: rough count of branch points
 *   - exports: count of exported symbols
 */
function measureComplexity(filePath) {
  const info = scanExports(filePath);
  if (!info.exists) return { sloc: 0, cyclomatic: 0, exports: 0 };
  const source = info.source || fs.readFileSync(filePath, 'utf8');
  const language = info.language;

  const lines = source.split(/\r?\n/);
  let sloc = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (language === 'python' && line.startsWith('#')) continue;
    if (language === 'ruby' && line.startsWith('#')) continue;
  if (language === 'rust' && line.startsWith('//')) continue;
    if (['java', 'kotlin', 'csharp', 'swift', 'c', 'cpp'].includes(language) && (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*'))) continue;
    if ((language === 'javascript') && (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*'))) continue;
    sloc += 1;
  }

  // Cyclomatic = 1 + branch points. We count common branch tokens.
  const branchPatterns = [
    /\bif\s*\(/g, /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g, /\bwhile\s*\(/g,
    /\bcase\s+/g, /\bcatch\s*\(/g,
    /&&/g, /\|\|/g,
    /\?[^:]*:/g, // ternary — rough
    /\belif\s+/g, /\bexcept\b/g, // python
    /\bunless\b/g, // ruby
  ];
  let branches = 0;
  for (const re of branchPatterns) {
    const matches = source.match(re);
    if (matches) branches += matches.length;
  }

  const exports = info.exports.size;
  return { sloc, cyclomatic: 1 + branches, exports };
}

/**
 * Aggregate before/after metrics into a verdict.
 *   - direction: "improved" | "regressed" | "neutral"
 *   - delta: { sloc, cyclomatic, exports }
 */
function aggregateMetric(before, after) {
  const delta = {
    sloc: after.sloc - before.sloc,
    cyclomatic: after.cyclomatic - before.cyclomatic,
    exports: after.exports - before.exports,
  };
  // Improved: at least one dimension decreased AND none increased.
  const decreased = delta.sloc < 0 || delta.cyclomatic < 0 || delta.exports < 0;
  const increased = delta.sloc > 0 || delta.cyclomatic > 0 || delta.exports > 0;
  let direction;
  if (decreased && !increased) direction = 'improved';
  else if (increased && !decreased) direction = 'regressed';
  else if (!decreased && !increased) direction = 'neutral';
  else direction = 'mixed'; // some up some down — mixed result
  return { direction, delta };
}

/**
 * Pre-validate a simplify proposal before the bridge applies it.
 *
 * Blocks:
 *   - Any changeSet op whose path is a test file
 *   - Any delete_file targeting a file in unknown-strict language (fail-safe)
 *   - Any replace_once whose match contains `export NAME` or `module.exports`
 *     pattern, unless the replace side preserves the same export names
 *
 * Returns { ok, reason?, touchedTests?, deletedExports? }.
 */
function validateSimplifyProposal(proposal, repoRoot) {
  if (!proposal || !Array.isArray(proposal.changeSet)) {
    return { ok: false, reason: 'proposal.changeSet must be an array' };
  }
  const touchedTests = [];
  const deletedExports = [];
  for (const op of proposal.changeSet) {
    if (!op || !op.path) continue;
    const rel = String(op.path);
    if (isTestFile(rel)) {
      touchedTests.push(rel);
      continue;
    }
    const absolutePath = path.resolve(repoRoot || process.cwd(), rel);
    const language = detectLanguage(rel);

    if (op.kind === 'delete_file') {
      if (language === 'unknown-strict' || language === 'unknown') {
        return {
          ok: false,
          reason: `simplify refuses to delete ${rel}: language ${language} (need explicit AST support before deleting)`,
          touchedTests,
          deletedExports,
        };
      }
      const beforeExports = scanExports(absolutePath).exports;
      for (const sym of beforeExports) deletedExports.push({ path: rel, symbol: sym });
    } else if (op.kind === 'replace_once') {
      // Compare before/after export sets. If replace removes an export name
      // OR removes the DEFINITION of an exported name (leaving a dangling
      // reference in module.exports), flag it.
      if (!fs.existsSync(absolutePath)) continue;
      const beforeExports = scanExports(absolutePath).exports;
      const matchText = String(op.match ?? '');
      const replaceText = String(op.replace ?? '');
      const current = fs.readFileSync(absolutePath, 'utf8');
      const simulated = current.replace(matchText, replaceText);
      const afterExports = getExportsForLanguage(simulated, language);
      // Case A: export name disappeared from export list.
      for (const sym of beforeExports) {
        if (!afterExports.has(sym)) {
          deletedExports.push({ path: rel, symbol: sym });
        }
      }
      // Case B: export name still in export list, but definition gone.
      // This catches deleting `function publicFn() {}` while
      // `module.exports = { publicFn }` remains — a dangling export.
      for (const sym of afterExports) {
        if (!hasDefinition(simulated, sym, language) && hasDefinition(current, sym, language)) {
          deletedExports.push({ path: rel, symbol: sym });
        }
      }
    }
  }
  if (touchedTests.length > 0) {
    return {
      ok: false,
      reason: `simplify cannot touch test files: ${touchedTests.join(', ')}`,
      touchedTests,
      deletedExports,
    };
  }
  if (deletedExports.length > 0) {
    return {
      ok: false,
      reason: `simplify refuses to delete exported symbols: ${deletedExports.map((e) => `${e.path}:${e.symbol}`).join(', ')}. Use xo-polish for renames, or xo-audit to deprecate an API first.`,
      touchedTests,
      deletedExports,
    };
  }
  return { ok: true, touchedTests: [], deletedExports: [] };
}

function getExportsForLanguage(source, language) {
  if (language === 'javascript') return scanJsExports(source);
  if (language === 'python') return scanPyExports(source);
  if (language === 'ruby') return scanRbExports(source);
  if (language === 'go') return scanGoExports(source);
  if (language === 'rust') return scanRustExports(source);
  if (language === 'java' || language === 'kotlin') return scanJvmExports(source, language);
  if (language === 'csharp') return scanCSharpExports(source);
  if (language === 'swift') return scanSwiftExports(source);
  if (language === 'c' || language === 'cpp') return scanCFamilyExports(source);
  return new Set();
}

/**
 * Does `source` contain a definition (function/class/const) of the given
 * symbol `name`? Language-aware.
 */
function hasDefinition(source, name, language) {
  if (!name || name === 'default') return true; // `default` export lives in the statement itself
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (language === 'javascript') {
    const patterns = [
      new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${escaped}\\b`),
      new RegExp(`\\b(?:export\\s+)?class\\s+${escaped}\\b`),
      new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
    ];
    return patterns.some((re) => re.test(source));
  }
  if (language === 'python') {
    const patterns = [
      new RegExp(`^(?:async\\s+)?def\\s+${escaped}\\b`, 'm'),
      new RegExp(`^class\\s+${escaped}\\b`, 'm'),
    ];
    return patterns.some((re) => re.test(source));
  }
  if (language === 'ruby') {
    const patterns = [
      new RegExp(`^def\\s+(?:self\\.)?${escaped}\\b`, 'm'),
      new RegExp(`^class\\s+${escaped}\\b`, 'm'),
      new RegExp(`^module\\s+${escaped}\\b`, 'm'),
      new RegExp(`^${escaped}\\s*=`, 'm'),
    ];
    return patterns.some((re) => re.test(source));
  }
  if (language === 'go') {
    const patterns = [
      new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\s*\\(`, 'm'),
      new RegExp(`^type\\s+${escaped}\\b`, 'm'),
      new RegExp(`^(?:var|const)\\s+${escaped}\\b`, 'm'),
    ];
    return patterns.some((re) => re.test(source));
  }
  if (language === 'rust') {
    const patterns = [
      new RegExp(`\\bpub\\s+(?:async\\s+)?fn\\s+${escaped}\\b`),
      new RegExp(`\\bpub\\s+(?:struct|enum|trait|type|const|static|mod)\\s+${escaped}\\b`),
    ];
    return patterns.some((re) => re.test(source));
  }
  if (language === 'java' || language === 'kotlin') {
    return scanJvmExports(source, language).has(name);
  }
  if (language === 'csharp') {
    return scanCSharpExports(source).has(name);
  }
  if (language === 'swift') {
    return scanSwiftExports(source).has(name);
  }
  if (language === 'c' || language === 'cpp') {
    return scanCFamilyExports(source).has(name);
  }
  return true; // unknown language — fail-safe assume definition exists
}

/**
 * Post-apply metric gate.
 * Returns { ok, verdict, delta } where verdict is improved/regressed/neutral/mixed.
 * Ok if direction ∈ {improved}.
 */
function verifyMetricImprovement(beforeMetrics, afterMetrics) {
  const agg = aggregateMetric(beforeMetrics, afterMetrics);
  return {
    ok: agg.direction === 'improved',
    verdict: agg.direction,
    delta: agg.delta,
    reason: agg.direction === 'improved'
      ? null
      : `simplify requires at least one of {sloc,cyclomatic,exports} to decrease AND none to increase; got ${JSON.stringify(agg.delta)} (${agg.direction})`,
  };
}

module.exports = {
  isTestFile,
  detectLanguage,
  scanExports,
  measureComplexity,
  aggregateMetric,
  validateSimplifyProposal,
  verifyMetricImprovement,
  scanPyExportsWithAst,
  scanRbExportsWithRipper,
  scanJvmExports,
  scanCSharpExports,
  scanSwiftExports,
  scanCFamilyExports,
};
