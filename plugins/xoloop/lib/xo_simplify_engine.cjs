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
 *   .go .rs .java → flagged as "unknown" → fail-safe refuse export deletions
 */

const fs = require('node:fs');
const path = require('node:path');

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
  if (['.go', '.rs', '.java', '.kt', '.swift'].includes(ext)) return 'unknown-strict';
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
};
