'use strict';

const { AdapterError } = require('./errors.cjs');

// Keywords and built-in language constructs to skip during cache-candidate detection.
const SKIP_CALL_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'throw',
  'require', 'import', 'function', 'async', 'await', 'typeof',
  'new', 'delete', 'void', 'class', 'super', 'this',
]);

/**
 * Detect optimization hotspots in source code via static analysis.
 *
 * @param {string} sourceContent - The source code to analyze.
 * @returns {Array<{ type: string, count?: number, detail?: string }>}
 */
function detectHotspots(sourceContent) {
  if (sourceContent == null || typeof sourceContent !== 'string') {
    throw new AdapterError(
      'HOTSPOT_SOURCE_REQUIRED',
      'sourceContent',
      'sourceContent must be a non-null string',
      { fixHint: 'Pass a string of source code as the first argument to detectHotspots().' },
    );
  }

  const hotspots = [];

  // -------------------------------------------------------------------------
  // 1. serial_awaits — sequences of await expressions not inside Promise.all
  // -------------------------------------------------------------------------
  detectSerialAwaits(sourceContent, hotspots);

  // -------------------------------------------------------------------------
  // 2. repeated_import — same require() or import path appearing > 1 time
  // -------------------------------------------------------------------------
  detectRepeatedImports(sourceContent, hotspots);

  // -------------------------------------------------------------------------
  // 3. cache_candidate — same function call with identical arguments > 1 time
  // -------------------------------------------------------------------------
  detectCacheCandidates(sourceContent, hotspots);

  return hotspots;
}

/** @private Push a serial_awaits hotspot entry — extracted to avoid duplication. */
function pushSerialAwaitsHotspot(hotspots, count) {
  hotspots.push({
    type: 'serial_awaits',
    count,
    detail: `${count} consecutive await expressions could potentially be parallelized with Promise.all`,
  });
}

/**
 * Find sequences of consecutive `await` expressions that are not wrapped
 * in Promise.all.
 */
function detectSerialAwaits(source, hotspots) {
  const lines = source.split('\n');
  let consecutiveAwaits = 0;

  /** Flush the current run: emit a hotspot if the count qualifies, then reset. */
  function flushRun() {
    if (consecutiveAwaits >= 2) {
      pushSerialAwaitsHotspot(hotspots, consecutiveAwaits);
    }
    consecutiveAwaits = 0;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    // Strip trailing inline comments (both // and /* */) so that
    // "doSomething(); // await ..." or "doSomething(); /* await ... */"
    // do not falsely match as real await expressions.
    const code = trimmed.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      // blank lines and comments don't break the sequence
    } else if (/\bawait\s+Promise\.all\s*\(/.test(code)) {
      // already-parallelized awaits are not serial, and they break the sequence
      // because they represent a real synchronization point — awaits before and
      // after a Promise.all cannot be parallelized together.
      flushRun();
    } else if (/\bawait\b/.test(code)) {
      consecutiveAwaits++;
    } else {
      flushRun();
    }
  }

  // Check trailing sequence
  flushRun();
}

/**
 * Find duplicate require() or import paths.
 */
function detectRepeatedImports(source, hotspots) {
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const importPattern = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;

  const pathCounts = Object.create(null);

  let match;
  while ((match = requirePattern.exec(source)) !== null) {
    const modPath = match[1];
    pathCounts[modPath] = (pathCounts[modPath] || 0) + 1;
  }

  while ((match = importPattern.exec(source)) !== null) {
    const modPath = match[1];
    pathCounts[modPath] = (pathCounts[modPath] || 0) + 1;
  }

  for (const [modPath, count] of Object.entries(pathCounts)) {
    if (count > 1) {
      hotspots.push({
        type: 'repeated_import',
        module: modPath,
        count,
        detail: `'${modPath}' is imported ${count} times — consider importing once and reusing`,
      });
    }
  }
}

/**
 * Find identical function calls (same function name + same arguments) that
 * appear more than once — candidates for memoization / caching.
 */
function detectCacheCandidates(source, hotspots) {
  // Match function calls like: functionName(arg1, arg2, ...)
  // We capture the full call expression including arguments.
  const callPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)/g;

  const callCounts = Object.create(null);

  let match;
  while ((match = callPattern.exec(source)) !== null) {
    const fnName = match[1];
    const args = match[2].trim();

    if (SKIP_CALL_NAMES.has(fnName)) continue;
    if (!args) continue; // skip no-arg calls — less likely cache candidates

    const callSig = `${fnName}(${args})`;
    callCounts[callSig] = (callCounts[callSig] || 0) + 1;
  }

  for (const [callSig, count] of Object.entries(callCounts)) {
    if (count > 1) {
      hotspots.push({
        type: 'cache_candidate',
        call: callSig,
        count,
        detail: `'${callSig}' is called ${count} times with the same arguments — consider caching the result`,
      });
    }
  }
}

module.exports = {
  detectHotspots,
};
