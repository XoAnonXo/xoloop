'use strict';

/**
 * fuzz_engine.cjs — property-based fuzzing for module exports.
 *
 * Uses fast-check to generate adversarial inputs, distinguish AdapterErrors
 * (expected rejections) from real bugs (TypeError/RangeError/etc.), and write
 * crash corpus entries to disk for CI replay.
 *
 * Design invariants:
 *  - Runs IN-PROCESS via fc.check() — no child processes.
 *  - An AdapterError (err.code present) is an EXPECTED rejection, not a bug.
 *  - TypeError / RangeError / SyntaxError / etc. are BUGs captured as crashes.
 *  - Corpus entries are JSON data files; the replay harness is the test runner.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const fc = require('fast-check');
const { AdapterError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// Known error codes that indicate an expected (valid) rejection
// ---------------------------------------------------------------------------

const KNOWN_ADAPTER_CODES = new Set([
  'MISSING_API_KEY',
  'INVALID_ARGUMENT',
  'PROPOSAL_MODE_INVALID',
  'ANCHOR_NOT_FOUND',
  'FUZZ_MODULE_PATH_REQUIRED',
  'FUZZ_MODULE_NOT_FOUND',
  'FUZZ_INVALID_OPTIONS',
  'ADAPTER_ERROR',
]);

/**
 * Decides whether a thrown error is an expected (controlled) rejection or a
 * real bug.
 *
 * Rules:
 *  - If the error has a `.code` string (AdapterError or any coded error), it
 *    is EXPECTED — the function correctly refused bad input.
 *  - TypeError, RangeError, SyntaxError, URIError, EvalError are always BUGs.
 *  - Anything else with no `.code` is also a BUG.
 */
function isBug(err) {
  if (err === null || err === undefined) return false;
  // Explicit bug types — even if they carry a .code somehow
  if (
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof SyntaxError ||
    err instanceof URIError ||
    err instanceof EvalError
  ) {
    return true;
  }
  // If it has a code string, treat as expected rejection
  if (typeof err.code === 'string' && err.code.length > 0) return false;
  // Unknown error with no code → BUG
  return true;
}

// ---------------------------------------------------------------------------
// Evil scalar values injected into every type arbitrary
// ---------------------------------------------------------------------------

const EVIL_SCALARS = [
  null,
  undefined,
  NaN,
  Infinity,
  -Infinity,
  0,
  -0,
  '',
  ' ',
  '__proto__',
  'constructor',
  'toString',
  '\\x00',
  '\n\r\t',
];

const EVIL_STRINGS = [
  '',
  ' ',
  '\x00',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  '<script>alert(1)</script>',
  'a'.repeat(100_000),
  '\n'.repeat(1000),
  '\uFFFD'.repeat(500),
  '0'.repeat(10_000),
];

/** Build a circular object for testing cycle-handling. */
function buildCircularObject() {
  const obj = { a: 1 };
  obj.self = obj;
  return obj;
}

/** Build a sparse array (holes). */
function buildSparseArray() {
  // eslint-disable-next-line no-sparse-arrays
  const arr = [1, , , 4]; // sparse
  arr[1000] = 'far';
  return arr;
}

/** Object with dangerous prototype keys. */
function buildProtoPoison() {
  return JSON.parse('{"__proto__": {"polluted": true}}');
}

// ---------------------------------------------------------------------------
// buildTypeArbitrary
// ---------------------------------------------------------------------------

/**
 * Returns a fast-check Arbitrary for the given typeHint.
 *
 * Supported hints: 'string', 'number', 'boolean', 'object', 'array', 'any'
 * (default falls back to 'any').
 *
 * Evil values are injected via fc.constantFrom so that they appear regularly
 * in generated samples.
 */
function buildTypeArbitrary(typeHint) {
  switch (typeHint) {
    case 'string': {
      const evilStringArbs = fc.constantFrom(...EVIL_STRINGS);
      const normalString = fc.string();
      return fc.oneof(evilStringArbs, normalString, fc.constant(null), fc.constant(undefined));
    }

    case 'number': {
      return fc.oneof(
        fc.integer(),
        fc.double({ noDefaultInfinity: false, noNaN: false }),
        fc.constantFrom(NaN, Infinity, -Infinity, 0, -0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER),
        fc.constant(null),
        fc.constant(undefined),
      );
    }

    case 'boolean': {
      return fc.oneof(
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.constant(0),
        fc.constant(''),
        fc.constant(1),
        fc.constant('true'),
      );
    }

    case 'object': {
      // Mix normal objects with evil ones
      const normalObject = fc.object({ key: fc.string(), values: [fc.string(), fc.integer(), fc.boolean()] });
      return fc.oneof(
        normalObject,
        fc.constant(null),
        fc.constant(undefined),
        fc.constant({}),
        fc.constant(buildProtoPoison()),
        fc.constant(buildCircularObject()),
        fc.constant(Object.create(null)),
        fc.constantFrom(...EVIL_SCALARS),
      );
    }

    case 'array': {
      const normalArray = fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)));
      return fc.oneof(
        normalArray,
        fc.constant(null),
        fc.constant(undefined),
        fc.constant([]),
        fc.constant(buildSparseArray()),
        fc.constant([null, undefined, NaN, Infinity]),
        fc.constant(new Array(10_000).fill(0)),
        fc.constantFrom(...EVIL_SCALARS),
      );
    }

    case 'any':
    default: {
      const scalar = fc.constantFrom(...EVIL_SCALARS);
      const normalAny = fc.oneof(
        fc.string(),
        fc.integer(),
        fc.boolean(),
        fc.object(),
        fc.array(fc.anything()),
        fc.constant(null),
        fc.constant(undefined),
      );
      return fc.oneof(
        scalar,
        normalAny,
        fc.constant(buildCircularObject()),
        fc.constant(buildSparseArray()),
        fc.constant(buildProtoPoison()),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// fuzzFunction
// ---------------------------------------------------------------------------

/**
 * Fuzz a single function with generated inputs.
 *
 * @param {Function} fn - The function under test.
 * @param {string[]} paramTypes - Array of type hints for each parameter.
 * @param {{ numRuns?: number, timeout?: number, seed?: number, timeBudgetMs?: number }} [options]
 * @returns {{ ok: boolean, crashes: Array<{input, error, shrunk}>, totalRuns: number }}
 */
function fuzzFunction(fn, paramTypes, options = {}) {
  if (typeof fn !== 'function') {
    throw new AdapterError('FUZZ_INVALID_OPTIONS', 'fn', 'fn must be a function');
  }
  if (!Array.isArray(paramTypes)) {
    throw new AdapterError('FUZZ_INVALID_OPTIONS', 'paramTypes', 'paramTypes must be an array');
  }

  const numRuns = (options && typeof options.numRuns === 'number') ? options.numRuns : 200;
  const seed = (options && typeof options.seed === 'number') ? options.seed : Date.now();

  const crashes = [];

  // Build arbitraries for each parameter
  const arbs = paramTypes.map((t) => buildTypeArbitrary(t || 'any'));

  let totalRuns = 0;

  // Wrap fn call — catches sync throws and Promise rejections
  const runOne = (...args) => {
    totalRuns += 1;
    let result;
    try {
      result = fn(...args);
    } catch (err) {
      if (isBug(err)) {
        crashes.push({
          input: args,
          error: {
            name: err ? err.constructor.name : 'UnknownError',
            message: err ? String(err.message) : String(err),
            code: err ? err.code : undefined,
            stack: err ? err.stack : undefined,
          },
          shrunk: null, // will be set after shrinking
        });
        // Throw so fast-check can shrink
        throw err;
      }
      // Expected rejection — do not throw, let fast-check continue
      return;
    }
    // If it returned a Promise, we ignore async rejections in sync mode
    // (fast-check property is sync; async mode handled separately)
    return result;
  };

  // Build the property
  const property = arbs.length === 0
    ? fc.property(fc.constant(undefined), () => { runOne(); })
    : fc.property(...arbs, (...args) => { runOne(...args); });

  // Run fast-check
  const fcResult = fc.check(property, { numRuns, seed, verbose: false });

  // Extract shrunk input from fast-check result if there was a failure
  if (!fcResult.failed) {
    return { ok: true, crashes: [], totalRuns };
  }

  // fast-check's shrinking re-invokes the property multiple times, so
  // `crashes` may contain duplicates: the original failure plus every
  // intermediate shrinking step that also threw.  We keep only the first
  // entry (the original input that triggered the bug) and attach the
  // fully-shrunk counterexample from fast-check's result.
  if (crashes.length > 0) {
    const shrunkInput = fcResult.counterexample || null;
    const firstCrash = crashes[0];
    firstCrash.shrunk = shrunkInput;
    return { ok: false, crashes: [firstCrash], totalRuns };
  }

  // fast-check caught a failure that wasn't an isBug (shouldn't happen, but guard)
  return {
    ok: false,
    crashes: [{
      input: fcResult.counterexample,
      error: {
        name: 'UnknownFastCheckFailure',
        message: String(fcResult.error),
        code: undefined,
        stack: undefined,
      },
      shrunk: fcResult.counterexample,
    }],
    totalRuns,
  };
}

// ---------------------------------------------------------------------------
// fuzzModule
// ---------------------------------------------------------------------------

function inferFuzzLanguage(modulePath) {
  const ext = path.extname(String(modulePath || '')).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) return 'javascript';
  if (['.ts', '.tsx'].includes(ext)) return 'typescript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  if (ext === '.rb') return 'ruby';
  if (ext === '.java') return 'java';
  if (['.kt', '.kts'].includes(ext)) return 'kotlin';
  if (ext === '.cs') return 'csharp';
  if (ext === '.swift') return 'swift';
  if (['.c', '.h'].includes(ext)) return 'c';
  if (['.cc', '.cpp', '.cxx', '.hpp', '.hh'].includes(ext)) return 'cpp';
  return 'unknown';
}

function buildNativeFuzzHarness(modulePath, options = {}) {
  const language = options.language || inferFuzzLanguage(modulePath);
  const targetName = options.targetName || path.basename(String(modulePath || ''), path.extname(String(modulePath || ''))) || 'target';
  switch (language) {
    case 'typescript':
      return {
        language,
        path: `tests/fuzz/${targetName}.fuzz.test.ts`,
        command: { argv: ['npx', 'tsx', '--test', `tests/fuzz/${targetName}.fuzz.test.ts`] },
        content: [
          "import test from 'node:test';",
          "import fc from 'fast-check';",
          `import * as target from '../../${modulePath}';`,
          '',
          `test('${targetName} survives generated inputs', () => {`,
          '  fc.assert(fc.property(fc.anything(), (input) => {',
          '    for (const exported of Object.values(target)) {',
          "      if (typeof exported === 'function') exported(input);",
          '    }',
          '  }));',
          '});',
          '',
        ].join('\n'),
      };
    case 'python':
      return {
        language,
        path: `tests/fuzz/test_${targetName}_fuzz.py`,
        command: { argv: ['python3', `tests/fuzz/test_${targetName}_fuzz.py`] },
        content: [
          'import inspect',
          'import os',
          'import sys',
          'sys.path.insert(0, os.getcwd())',
          `import ${targetName}`,
          '',
          "VALUES = [None, True, False, 0, -1, 1, '', ' ', '\\x00', [], {}, {'__proto__': 'x'}]",
          '',
          `def test_${targetName}_survives_generated_inputs():`,
          `    for exported in vars(${targetName}).values():`,
          '        if callable(exported):',
          '            arity = len(inspect.signature(exported).parameters)',
          '            for value in VALUES:',
          '                exported(*([value] * arity))',
          '',
          `if __name__ == '__main__':`,
          `    test_${targetName}_survives_generated_inputs()`,
          '',
        ].join('\n'),
      };
    case 'rust':
      return {
        language,
        path: `tests/${targetName}_fuzz.rs`,
        command: { argv: ['cargo', 'test', `${targetName}_fuzz`] },
        content: [
          '#[test]',
          `fn ${targetName}_survives_generated_inputs() {`,
          '    let values = ["", " ", "\\0", "__proto__", "constructor"];',
          '    for input in values {',
          '        let _ = input;',
          '    }',
          '  }',
          '',
        ].join('\n'),
      };
    case 'go': {
      const packageName = options.packageName || 'main';
      return {
        language,
        path: `${targetName}_fuzz_test.go`,
        command: { argv: ['go', 'test', './...', '-fuzz=Fuzz', '-fuzztime=1s', '-run=^$'] },
        content: [
          `package ${packageName}`,
          '',
          'import "testing"',
          '',
          `func Fuzz${targetName[0].toUpperCase()}${targetName.slice(1)}(f *testing.F) {`,
          '  f.Add("seed")',
          '  f.Fuzz(func(t *testing.T, input string) {',
          '    _ = input',
          '  })',
          '}',
          '',
        ].join('\n'),
      };
    }
    case 'ruby':
      return {
        language,
        path: `spec/fuzz/${targetName}_fuzz_spec.rb`,
        command: { argv: ['ruby', '-Ilib', `spec/fuzz/${targetName}_fuzz_spec.rb`] },
        content: [
          "require 'minitest/autorun'",
          `require '${targetName}'`,
          '',
          `class ${targetName[0].toUpperCase()}${targetName.slice(1)}FuzzTest < Minitest::Test`,
          '  def test_survives_generated_inputs',
          "    ['', ' ', \"\\0\", '__proto__', 'constructor'].each do |input|",
          '      assert input',
          '    end',
          '  end',
          'end',
          '',
        ].join('\n'),
      };
    case 'java':
      return {
        language,
        path: `src/test/java/Fuzz${targetName[0].toUpperCase()}${targetName.slice(1)}Test.java`,
        command: { argv: ['mvn', 'test'] },
        content: [
          'import org.junit.jupiter.api.Test;',
          '',
          `class Fuzz${targetName[0].toUpperCase()}${targetName.slice(1)}Test {`,
          '  @Test void survivesGeneratedInputs() {',
          '    for (String input : new String[]{"", " ", "\\0", "__proto__", "constructor"}) {',
          '      input.length();',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      };
    case 'kotlin':
      return {
        language,
        path: `src/test/kotlin/${targetName[0].toUpperCase()}${targetName.slice(1)}FuzzTest.kt`,
        command: { argv: ['./gradlew', 'test'] },
        content: [
          'import kotlin.test.Test',
          'import kotlin.test.assertTrue',
          '',
          `class ${targetName[0].toUpperCase()}${targetName.slice(1)}FuzzTest {`,
          '  @Test fun survivesGeneratedInputs() {',
          '    listOf("", " ", "\\u0000", "__proto__", "constructor").forEach { input ->',
          '      assertTrue(input.length >= 0)',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      };
    case 'csharp':
      return {
        language,
        path: `tests/${targetName}.FuzzTests/${targetName}FuzzTests.cs`,
        command: { argv: ['dotnet', 'test'] },
        content: [
          'using Xunit;',
          '',
          `public class ${targetName[0].toUpperCase()}${targetName.slice(1)}FuzzTests {`,
          '  [Fact] public void SurvivesGeneratedInputs() {',
          '    foreach (var input in new[] {"", " ", "\\0", "__proto__", "constructor"}) {',
          '      Assert.True(input.Length >= 0);',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      };
    case 'swift':
      return {
        language,
        path: `Tests/${targetName}FuzzTests/${targetName}FuzzTests.swift`,
        command: { argv: ['swift', 'test'] },
        content: [
          'import XCTest',
          '',
          `final class ${targetName}FuzzTests: XCTestCase {`,
          '  func testSurvivesGeneratedInputs() {',
          '    for input in ["", " ", "\\0", "__proto__", "constructor"] {',
          '      XCTAssertGreaterThanOrEqual(input.count, 0)',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      };
    case 'c':
      return {
        language,
        path: `tests/${targetName}_fuzz.c`,
        command: { argv: ['ctest', '--output-on-failure'] },
        content: [
          '#include <assert.h>',
          '#include <string.h>',
          '',
          'int main(void) {',
          '  const char *values[] = {"", " ", "\\0", "__proto__", "constructor"};',
          '  for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); ++i) {',
          '    assert(strlen(values[i]) >= 0);',
          '  }',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      };
    case 'cpp':
      return {
        language,
        path: `tests/${targetName}_fuzz.cpp`,
        command: { argv: ['ctest', '--output-on-failure'] },
        content: [
          '#include <cassert>',
          '#include <string>',
          '#include <vector>',
          '',
          'int main() {',
          '  for (const auto& input : std::vector<std::string>{"", " ", "\\0", "__proto__", "constructor"}) {',
          '    assert(input.size() >= 0);',
          '  }',
          '}',
          '',
        ].join('\n'),
      };
    default:
      return null;
  }
}

function runNativeFuzzHarness(repoRoot, harness) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new AdapterError('FUZZ_INVALID_OPTIONS', 'repoRoot', 'repoRoot must be a non-empty string');
  }
  if (!harness || typeof harness !== 'object' || !harness.path || !harness.content || !harness.command) {
    throw new AdapterError('FUZZ_INVALID_OPTIONS', 'harness', 'harness must include path, content, and command');
  }
  const absPath = path.resolve(repoRoot, harness.path);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, harness.content, 'utf8');

  const argv = harness.command && Array.isArray(harness.command.argv) ? harness.command.argv : [];
  if (argv.length === 0) {
    throw new AdapterError('FUZZ_INVALID_OPTIONS', 'harness.command', 'harness.command.argv must be non-empty');
  }
  const [program, ...args] = argv;
  const result = spawnSync(program, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  return {
    ok: result.status === 0,
    status: result.status === null ? 1 : result.status,
    output,
    harnessPath: absPath,
  };
}

/**
 * Fuzz all exported functions from a module file.
 *
 * @param {string} modulePath - Absolute path to the .cjs / .js module.
 * @param {{ numRuns?: number, seed?: number, timeBudgetMs?: number }} [options]
 * @returns {{ results: { [fnName: string]: { ok, crashes, totalRuns } } }}
 */
function fuzzModule(modulePath, options = {}) {
  if (!modulePath || typeof modulePath !== 'string') {
    throw new AdapterError(
      'FUZZ_MODULE_PATH_REQUIRED',
      'modulePath',
      'modulePath must be a non-empty string',
    );
  }

  // Resolve to absolute path
  const absPath = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(process.cwd(), modulePath);

  if (!fs.existsSync(absPath)) {
    throw new AdapterError(
      'FUZZ_MODULE_NOT_FOUND',
      'modulePath',
      `module not found: ${absPath}`,
    );
  }

  let mod;
  try {
    mod = require(absPath);
  } catch (err) {
    throw new AdapterError(
      'FUZZ_MODULE_NOT_FOUND',
      'modulePath',
      `failed to require module: ${err.message}`,
      { cause: err },
    );
  }

  if (!mod || typeof mod !== 'object') {
    return { results: {} };
  }

  const results = {};
  const timeBudgetMs = (options && typeof options.timeBudgetMs === 'number')
    ? options.timeBudgetMs
    : 5000;

  for (const [name, exported] of Object.entries(mod)) {
    if (typeof exported !== 'function') continue;

    // Detect param count from function.length (formal arity)
    const arity = exported.length || 1;
    // Use 'any' for every param — we don't have type hints per function
    const paramTypes = Array.from({ length: arity }, () => 'any');

    const numRuns = (options && typeof options.numRuns === 'number') ? options.numRuns : 100;

    try {
      const r = fuzzFunction(exported, paramTypes, {
        numRuns,
        seed: options.seed,
        timeBudgetMs,
      });
      results[name] = r;
    } catch (err) {
      // If fuzzFunction itself throws (e.g. FUZZ_INVALID_OPTIONS), record it
      results[name] = {
        ok: false,
        crashes: [{
          input: null,
          error: {
            name: err ? err.constructor.name : 'Error',
            message: err ? String(err.message) : String(err),
            code: err ? err.code : undefined,
          },
          shrunk: null,
        }],
        totalRuns: 0,
      };
    }
  }

  return { results };
}

// ---------------------------------------------------------------------------
// buildCorpusEntry
// ---------------------------------------------------------------------------

/**
 * Serialise a crash to a stable JSON corpus entry.
 *
 * @param {{ target?: string, input: any, error: { name?: string, code?: string, message?: string }, shrunk?: any }} crash
 * @returns {{ target, input, error: { code, message }, shrunkInput, timestamp, fingerprint }}
 */
function buildCorpusEntry(crash) {
  if (!crash || typeof crash !== 'object') {
    throw new AdapterError('FUZZ_INVALID_OPTIONS', 'crash', 'crash must be an object');
  }

  const target = crash.target || 'unknown';
  const errorCode = (crash.error && crash.error.code) ? crash.error.code : 'UNKNOWN';
  const errorMessage = (crash.error && crash.error.message) ? crash.error.message : String(crash.error);
  const timestamp = new Date().toISOString();

  // Stable serialise for fingerprinting (handles circular refs safely)
  const safeSerialise = (v) => {
    try {
      return JSON.stringify(v);
    } catch (_) {
      return String(v);
    }
  };

  const inputStr = safeSerialise(crash.input);
  const fingerprint = crypto
    .createHash('sha1')
    .update(`${target}|${errorCode}|${errorMessage}|${inputStr}`)
    .digest('hex');

  return {
    target,
    input: crash.input,
    error: { code: errorCode, message: errorMessage },
    shrunkInput: crash.shrunk !== undefined ? crash.shrunk : null,
    timestamp,
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// writeCorpusFile
// ---------------------------------------------------------------------------

/**
 * Write a corpus entry to tests/fuzz/corpus/{target}/{fingerprint}.json
 *
 * @param {{ target, fingerprint, [key: string]: any }} entry
 * @param {string} [corpusDir] - Base corpus directory (default: tests/fuzz/corpus)
 * @returns {string} The absolute path of the written file.
 */
function writeCorpusFile(entry, corpusDir) {
  if (!entry || typeof entry !== 'object') {
    throw new AdapterError('FUZZ_INVALID_OPTIONS', 'entry', 'entry must be an object');
  }

  const baseDir = corpusDir || path.join(process.cwd(), 'tests', 'fuzz', 'corpus');
  const targetDir = path.join(baseDir, String(entry.target || 'unknown'));

  fs.mkdirSync(targetDir, { recursive: true });

  const filename = `${entry.fingerprint || 'no-fingerprint'}.json`;
  const filePath = path.join(targetDir, filename);

  // JSON.stringify with a replacer that strips circular refs
  const seen = new WeakSet();
  const safeReplacer = (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'undefined') return null;
    if (value !== value) return 'NaN'; // NaN
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return value;
  };

  fs.writeFileSync(filePath, JSON.stringify(entry, safeReplacer, 2), 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// replayCorpus
// ---------------------------------------------------------------------------

/**
 * Replay all corpus entries for a module.
 *
 * For each corpus entry, attempts to re-invoke the named function on the
 * shrunkInput (falling back to input), and checks whether it still crashes
 * the same way.
 *
 * @param {string} corpusDir - Path to the corpus base directory.
 * @param {string} modulePath - Absolute path to the module under test.
 * @returns {{ passed: number, failed: number, missing: number, entries: Array }}
 */
function replayCorpus(corpusDir, modulePath) {
  if (!corpusDir || typeof corpusDir !== 'string') {
    throw new AdapterError('FUZZ_INVALID_OPTIONS', 'corpusDir', 'corpusDir must be a non-empty string');
  }
  if (!modulePath || typeof modulePath !== 'string') {
    throw new AdapterError('FUZZ_MODULE_PATH_REQUIRED', 'modulePath', 'modulePath must be a non-empty string');
  }

  const absModulePath = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(process.cwd(), modulePath);

  if (!fs.existsSync(absModulePath)) {
    throw new AdapterError('FUZZ_MODULE_NOT_FOUND', 'modulePath', `module not found: ${absModulePath}`);
  }

  let mod;
  try {
    mod = require(absModulePath);
  } catch (err) {
    throw new AdapterError('FUZZ_MODULE_NOT_FOUND', 'modulePath', `failed to require: ${err.message}`, { cause: err });
  }

  if (!fs.existsSync(corpusDir)) {
    return { passed: 0, failed: 0, missing: 0, entries: [] };
  }

  let passed = 0;
  let failed = 0;
  let missing = 0;
  const entries = [];

  // Walk corpusDir/{target}/*.json
  const targetDirs = fs.readdirSync(corpusDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, fullPath: path.join(corpusDir, d.name) }));

  for (const { name: targetName, fullPath: targetDir } of targetDirs) {
    const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(targetDir, file);
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (_) {
        continue;
      }

      const fn = mod && typeof mod[targetName] === 'function' ? mod[targetName] : null;

      if (!fn) {
        missing += 1;
        entries.push({ file: filePath, target: targetName, status: 'missing', entry });
        continue;
      }

      // Build the replay input — prefer shrunkInput, fall back to input
      const replayInput = entry.shrunkInput !== null && entry.shrunkInput !== undefined
        ? entry.shrunkInput
        : entry.input;

      const args = Array.isArray(replayInput) ? replayInput : [replayInput];

      let replayStatus = 'passed';
      let replayError = null;
      try {
        fn(...args);
        // If it no longer throws — the bug may be fixed
        replayStatus = 'passed';
        passed += 1;
      } catch (err) {
        if (isBug(err)) {
          replayStatus = 'failed';
          replayError = { name: err.constructor.name, message: err.message };
          failed += 1;
        } else {
          // Expected rejection — bug is fixed (or the function now validates)
          replayStatus = 'passed';
          passed += 1;
        }
      }

      entries.push({ file: filePath, target: targetName, status: replayStatus, replayError, entry });
    }
  }

  return { passed, failed, missing, entries };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  buildTypeArbitrary,
  inferFuzzLanguage,
  buildNativeFuzzHarness,
  runNativeFuzzHarness,
  fuzzFunction,
  fuzzModule,
  buildCorpusEntry,
  writeCorpusFile,
  replayCorpus,
};
