'use strict';

/**
 * library_swap.cjs — IMPROVE mode sub-mode: replace hand-rolled code with
 * battle-tested allowlisted libraries.
 *
 * Only packages on the ALLOWED_LIBRARIES allowlist may be proposed.
 * Proposals must produce a net line reduction and use MIT/Apache-2.0/ISC/BSD
 * licenses.
 *
 * Exports:
 *   ALLOWED_LIBRARIES        — hardcoded allowlist
 *   isLibraryAllowed(name)   — allowlist lookup
 *   validateLibraryProposal  — validate a swap proposal
 *   buildLibrarySwapPrompt   — build the LLM prompt
 *   scoreLibrarySwap         — score an accepted proposal
 */

const { AdapterError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// ALLOWED_LIBRARIES
// ---------------------------------------------------------------------------

/**
 * Hardcoded allowlist of battle-tested packages that may be proposed in a
 * LIBRARY_SWAP improvement. Only these packages may appear in addDependencies.
 *
 * Schema per entry:
 *   { description: string, license: string, category: string }
 */
const ALLOWED_LIBRARIES = {
  lodash: {
    description: 'Utility library providing functional programming helpers for arrays, objects, and strings.',
    license: 'MIT',
    category: 'utility',
  },
  yaml: {
    description: 'Fast, standards-compliant YAML 1.2 parser and serialiser.',
    license: 'ISC',
    category: 'serialisation',
  },
  zod: {
    description: 'TypeScript-first schema validation with static type inference.',
    license: 'MIT',
    category: 'validation',
  },
  ajv: {
    description: 'The fastest JSON Schema validator for Node.js with full draft-07 support.',
    license: 'MIT',
    category: 'validation',
  },
  'p-retry': {
    description: 'Retry a promise-returning or async function with configurable backoff.',
    license: 'MIT',
    category: 'async',
  },
  'p-limit': {
    description: 'Run multiple promise-returning functions with limited concurrency.',
    license: 'MIT',
    category: 'async',
  },
  ms: {
    description: 'Tiny millisecond converter: parse and format time strings like "2 days".',
    license: 'MIT',
    category: 'utility',
  },
  debug: {
    description: 'Tiny debugging utility modelled after Node.js core debugging technique.',
    license: 'MIT',
    category: 'logging',
  },
  semver: {
    description: 'Semantic versioning parser, comparator, and range resolver.',
    license: 'ISC',
    category: 'versioning',
  },
  minimatch: {
    description: 'Glob matching library; used by npm and many CLI tools.',
    license: 'ISC',
    category: 'filesystem',
  },
  glob: {
    description: 'File globbing using shell-style patterns; the canonical Node.js glob.',
    license: 'ISC',
    category: 'filesystem',
  },
  'fast-glob': {
    description: 'Extremely fast and lightweight glob implementation using micromatch.',
    license: 'MIT',
    category: 'filesystem',
  },
  'safe-stable-stringify': {
    description: 'Deterministic, cycle-safe JSON serialiser with stable key ordering.',
    license: 'MIT',
    category: 'serialisation',
  },
  json5: {
    description: 'JSON5 parser that allows comments, trailing commas, and unquoted keys.',
    license: 'MIT',
    category: 'serialisation',
  },
  chalk: {
    description: 'Terminal string styling: colors, bold, underline, and more.',
    license: 'MIT',
    category: 'cli',
  },
  'strip-ansi': {
    description: 'Strip ANSI escape codes from a string for clean plain-text output.',
    license: 'MIT',
    category: 'cli',
  },
  'escape-string-regexp': {
    description: 'Escape RegExp special characters so a string can be used in a RegExp.',
    license: 'MIT',
    category: 'utility',
  },
  'deep-equal': {
    description: 'Deep equality comparison with optional strict mode.',
    license: 'MIT',
    category: 'utility',
  },
  'fast-deep-equal': {
    description: 'Fastest deep equality check, ~10× faster than deep-equal for plain objects.',
    license: 'MIT',
    category: 'utility',
  },
  nanoid: {
    description: 'Tiny, secure, URL-friendly unique string ID generator.',
    license: 'MIT',
    category: 'id-generation',
  },
  uuid: {
    description: 'RFC-compliant UUID v1/v3/v4/v5 generator and parser.',
    license: 'MIT',
    category: 'id-generation',
  },
  dotenv: {
    description: 'Load environment variables from a .env file into process.env.',
    license: 'BSD-2-Clause',
    category: 'configuration',
  },
  ini: {
    description: 'INI file parser and serialiser — encode and decode .ini config files.',
    license: 'ISC',
    category: 'configuration',
  },
  toml: {
    description: "Tom's Obvious, Minimal Language parser — reads .toml configuration files.",
    license: 'MIT',
    category: 'configuration',
  },
  picomatch: {
    description: 'Blazing fast and accurate glob matcher; used internally by fast-glob.',
    license: 'MIT',
    category: 'filesystem',
  },
};

// ---------------------------------------------------------------------------
// Allowed license set
// ---------------------------------------------------------------------------

const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause']);

// ---------------------------------------------------------------------------
// isLibraryAllowed
// ---------------------------------------------------------------------------

/**
 * Check whether a package name is on the allowlist.
 *
 * @param {string} packageName
 * @returns {{ allowed: boolean, entry: object|null }}
 */
function isLibraryAllowed(packageName) {
  if (typeof packageName !== 'string' || packageName.trim().length === 0) {
    throw new AdapterError(
      'LIBRARY_NOT_ALLOWED',
      'packageName',
      'packageName must be a non-empty string',
      { fixHint: 'Provide the exact npm package name as a string.' },
    );
  }

  const entry = ALLOWED_LIBRARIES[packageName.trim()] || null;
  return {
    allowed: entry !== null,
    entry,
  };
}

// ---------------------------------------------------------------------------
// validateLibraryProposal
// ---------------------------------------------------------------------------

/**
 * Validate a library-swap proposal.
 *
 * Proposal shape:
 *   {
 *     addDependencies: Array<{ name: string, version: string }>,
 *     linesRemoved: number,
 *     linesAdded: number,
 *   }
 *
 * Rules enforced:
 *   1. Proposal must be an object with the required fields.
 *   2. addDependencies must be an array.
 *   3. Every entry in addDependencies must have a name and version string.
 *   4. Every proposed package must be in ALLOWED_LIBRARIES.
 *   5. linesRemoved and linesAdded must be non-negative integers.
 *   6. Net must be a simplification: linesRemoved > linesAdded.
 *   7. Every proposed package's license must be in ALLOWED_LICENSES.
 *
 * @param {object} proposal
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateLibraryProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'proposal',
      'proposal must be a non-null object',
      { fixHint: 'Pass an object with addDependencies, linesRemoved, and linesAdded fields.' },
    );
  }

  // Check required top-level fields
  if (!('addDependencies' in proposal)) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'addDependencies',
      'proposal is missing required field: addDependencies',
      { fixHint: 'Include addDependencies as an array of { name, version } objects.' },
    );
  }
  if (!('linesRemoved' in proposal)) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'linesRemoved',
      'proposal is missing required field: linesRemoved',
      { fixHint: 'Include linesRemoved as a non-negative integer.' },
    );
  }
  if (!('linesAdded' in proposal)) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'linesAdded',
      'proposal is missing required field: linesAdded',
      { fixHint: 'Include linesAdded as a non-negative integer.' },
    );
  }

  if (!Array.isArray(proposal.addDependencies)) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'addDependencies',
      'addDependencies must be an array',
      { fixHint: 'Set addDependencies to an array of { name, version } objects.' },
    );
  }

  const linesRemoved = proposal.linesRemoved;
  const linesAdded = proposal.linesAdded;

  if (typeof linesRemoved !== 'number' || !Number.isFinite(linesRemoved) || linesRemoved < 0) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'linesRemoved',
      'linesRemoved must be a non-negative finite number',
      { fixHint: 'Set linesRemoved to the count of lines the swap deletes from the codebase.' },
    );
  }
  if (typeof linesAdded !== 'number' || !Number.isFinite(linesAdded) || linesAdded < 0) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'linesAdded',
      'linesAdded must be a non-negative finite number',
      { fixHint: 'Set linesAdded to the count of new call-site lines introduced.' },
    );
  }

  // Validate each dependency entry shape
  for (let i = 0; i < proposal.addDependencies.length; i++) {
    const dep = proposal.addDependencies[i];
    if (!dep || typeof dep !== 'object' || Array.isArray(dep)) {
      throw new AdapterError(
        'LIBRARY_SWAP_INVALID_PROPOSAL',
        `addDependencies[${i}]`,
        `addDependencies[${i}] must be an object with name and version`,
        { fixHint: 'Each dependency entry must be { name: string, version: string }.' },
      );
    }
    if (typeof dep.name !== 'string' || dep.name.trim().length === 0) {
      throw new AdapterError(
        'LIBRARY_SWAP_INVALID_PROPOSAL',
        `addDependencies[${i}].name`,
        `addDependencies[${i}].name must be a non-empty string`,
        { fixHint: 'Set name to the exact npm package name.' },
      );
    }
    if (typeof dep.version !== 'string' || dep.version.trim().length === 0) {
      throw new AdapterError(
        'LIBRARY_SWAP_INVALID_PROPOSAL',
        `addDependencies[${i}].version`,
        `addDependencies[${i}].version must be a non-empty string`,
        { fixHint: 'Set version to a semver range like "^1.0.0".' },
      );
    }
  }

  // Collect rule violations
  const violations = [];

  // Rule 1: only allowlisted packages
  for (const dep of proposal.addDependencies) {
    const { allowed } = isLibraryAllowed(dep.name);
    if (!allowed) {
      violations.push(`LIBRARY_NOT_ALLOWED: "${dep.name}" is not on the approved library allowlist`);
    }
  }

  // Rule 2: net simplification
  if (linesRemoved <= linesAdded) {
    violations.push(
      `LIBRARY_SWAP_NET_INCREASE: proposal adds ${linesAdded} lines but only removes ${linesRemoved} — must remove more than it adds`,
    );
  }

  // Rule 3: license check (only for allowlisted packages — unlisted already flagged above)
  for (const dep of proposal.addDependencies) {
    const entry = ALLOWED_LIBRARIES[dep.name.trim()];
    if (entry && !ALLOWED_LICENSES.has(entry.license)) {
      violations.push(
        `LICENSE_NOT_ALLOWED: "${dep.name}" has license "${entry.license}" which is not in [${[...ALLOWED_LICENSES].join(', ')}]`,
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// buildLibrarySwapPrompt
// ---------------------------------------------------------------------------

/**
 * Build the prompt asking the model to identify hand-rolled code that can be
 * replaced with an allowlisted library.
 *
 * @param {string} sourceContent  — full text of the source file
 * @param {string} targetPath     — file path (for context in the prompt)
 * @returns {string}              — the complete prompt text
 */
function buildLibrarySwapPrompt(sourceContent, targetPath) {
  if (typeof sourceContent !== 'string') {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'sourceContent',
      'sourceContent must be a string',
      { fixHint: 'Pass the full text of the source file as a string.' },
    );
  }
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'targetPath',
      'targetPath must be a non-empty string',
      { fixHint: 'Pass the file path of the file being analysed.' },
    );
  }

  const allowlistLines = Object.entries(ALLOWED_LIBRARIES).map(([name, meta]) =>
    `  - ${name} (${meta.license}, ${meta.category}): ${meta.description}`,
  );

  const prompt = [
    '# LIBRARY_SWAP IMPROVE Mode',
    '',
    'You are a refactoring engineer. Your job is to identify hand-rolled utility',
    'code in the file below that can be replaced by one of the approved libraries.',
    '',
    '## Rules',
    '1. You MUST only propose libraries from the APPROVED ALLOWLIST below.',
    '2. The swap MUST reduce the total line count: linesRemoved > linesAdded.',
    '3. You MUST NOT add install scripts or native add-ons — pure JS only.',
    '4. Allowed licenses: MIT, Apache-2.0, ISC, BSD.',
    '5. Respond with a JSON object (and nothing else) matching this schema:',
    '   {',
    '     "explanation": "<why this swap simplifies the code>",',
    '     "addDependencies": [{ "name": "<pkg>", "version": "<semver>" }],',
    '     "removedCode": "<short description of what is deleted>",',
    '     "linesRemoved": <integer>,',
    '     "linesAdded": <integer>',
    '   }',
    '6. If no beneficial swap exists, respond with:',
    '   { "explanation": "no library swap found", "addDependencies": [], "linesRemoved": 0, "linesAdded": 0 }',
    '',
    '## Approved Library Allowlist',
    ...allowlistLines,
    '',
    `## Target File: ${targetPath}`,
    '```',
    sourceContent,
    '```',
  ].join('\n');

  return prompt;
}

// ---------------------------------------------------------------------------
// scoreLibrarySwap
// ---------------------------------------------------------------------------

/**
 * Score an accepted library-swap proposal.
 *
 * Scoring:
 *   - Base score = (linesRemoved - linesAdded) — net line reduction
 *   - Penalty    = addDependencies.length * 5  — each new dep costs 5 points
 *   - Final score = max(0, base - penalty)
 *
 * Recommendation thresholds:
 *   score >= 20  → 'accept'
 *   score >= 5   → 'review'
 *   score <  5   → 'reject'
 *
 * @param {{ addDependencies: Array, linesRemoved: number, linesAdded: number }} proposal
 * @returns {{ score: number, recommendation: 'accept'|'review'|'reject' }}
 */
function scoreLibrarySwap(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new AdapterError(
      'LIBRARY_SWAP_INVALID_PROPOSAL',
      'proposal',
      'proposal must be a non-null object',
      { fixHint: 'Pass the same proposal object you validated.' },
    );
  }

  const linesRemoved = typeof proposal.linesRemoved === 'number' && Number.isFinite(proposal.linesRemoved)
    ? Math.max(0, proposal.linesRemoved)
    : 0;
  const linesAdded = typeof proposal.linesAdded === 'number' && Number.isFinite(proposal.linesAdded)
    ? Math.max(0, proposal.linesAdded)
    : 0;
  const depCount = Array.isArray(proposal.addDependencies) ? proposal.addDependencies.length : 0;

  const netReduction = linesRemoved - linesAdded;
  const depPenalty = depCount * 5;
  const score = Math.max(0, netReduction - depPenalty);

  let recommendation;
  if (score >= 20) {
    recommendation = 'accept';
  } else if (score >= 5) {
    recommendation = 'review';
  } else {
    recommendation = 'reject';
  }

  return { score, recommendation };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ALLOWED_LIBRARIES,
  isLibraryAllowed,
  validateLibraryProposal,
  buildLibrarySwapPrompt,
  scoreLibrarySwap,
};
