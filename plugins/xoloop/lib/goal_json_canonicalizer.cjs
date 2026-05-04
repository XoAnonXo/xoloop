'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob } = require('./goal_manifest.cjs');

class JsonSubsetParser {
  constructor(text) {
    this.text = String(text);
    this.i = 0;
  }

  error(message) {
    const err = new Error(`${message} at byte ${this.i}`);
    err.code = 'JSON_SUBSET_INVALID';
    throw err;
  }

  skipWs() {
    while (this.i < this.text.length && /[\t\n\r ]/.test(this.text[this.i])) this.i += 1;
  }

  expect(ch) {
    if (this.text[this.i] !== ch) this.error(`expected ${JSON.stringify(ch)}`);
    this.i += 1;
  }

  parseString() {
    this.expect('"');
    let out = '';
    while (this.i < this.text.length) {
      const ch = this.text[this.i++];
      if (ch === '"') return out;
      if (ch === '\\') {
        if (this.i >= this.text.length) this.error('unterminated escape');
        const esc = this.text[this.i++];
        if (esc === '"' || esc === '\\' || esc === '/') out += esc;
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === 'u') {
          const hex = this.text.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.error('invalid unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else {
          this.error('invalid escape');
        }
      } else {
        if (ch < ' ') this.error('control character in string');
        out += ch;
      }
    }
    this.error('unterminated string');
  }

  parseNumber() {
    const start = this.i;
    if (this.text[this.i] === '-') this.i += 1;
    if (this.text[this.i] === '0') {
      this.i += 1;
    } else if (/[1-9]/.test(this.text[this.i])) {
      while (/[0-9]/.test(this.text[this.i])) this.i += 1;
    } else {
      this.error('invalid number');
    }
    if (this.text[this.i] === '.' || this.text[this.i] === 'e' || this.text[this.i] === 'E') {
      this.error('floats are outside the v0 json-subset');
    }
    const n = Number(this.text.slice(start, this.i));
    if (!Number.isSafeInteger(n)) this.error('integer is outside safe range');
  }

  parseLiteral(literal) {
    if (this.text.slice(this.i, this.i + literal.length) !== literal) {
      this.error(`expected ${literal}`);
    }
    this.i += literal.length;
  }

  parseArray() {
    this.expect('[');
    this.skipWs();
    if (this.text[this.i] === ']') {
      this.i += 1;
      return;
    }
    while (this.i < this.text.length) {
      this.parseValue();
      this.skipWs();
      if (this.text[this.i] === ']') {
        this.i += 1;
        return;
      }
      this.expect(',');
      this.skipWs();
    }
    this.error('unterminated array');
  }

  parseObject() {
    this.expect('{');
    const keys = new Set();
    this.skipWs();
    if (this.text[this.i] === '}') {
      this.i += 1;
      return;
    }
    while (this.i < this.text.length) {
      this.skipWs();
      const key = this.parseString();
      if (keys.has(key)) {
        const err = new Error(`duplicate object key ${JSON.stringify(key)} at byte ${this.i}`);
        err.code = 'JSON_DUPLICATE_KEY';
        throw err;
      }
      keys.add(key);
      this.skipWs();
      this.expect(':');
      this.skipWs();
      this.parseValue();
      this.skipWs();
      if (this.text[this.i] === '}') {
        this.i += 1;
        return;
      }
      this.expect(',');
      this.skipWs();
    }
    this.error('unterminated object');
  }

  parseValue() {
    this.skipWs();
    const ch = this.text[this.i];
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"') return this.parseString();
    if (ch === 't') return this.parseLiteral('true');
    if (ch === 'f') return this.parseLiteral('false');
    if (ch === 'n') return this.parseLiteral('null');
    if (ch === '-' || /[0-9]/.test(ch)) return this.parseNumber();
    this.error('expected JSON value');
  }

  parseAll() {
    this.skipWs();
    this.parseValue();
    this.skipWs();
    if (this.i !== this.text.length) this.error('trailing characters');
  }
}

function assertJsonSubset(text) {
  const parser = new JsonSubsetParser(text);
  parser.parseAll();
}

function canonicalizeValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('number is outside json-canonicalizer v0 safe integer subset');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValue).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`).join(',')}}`;
  }
  throw new Error(`unsupported JSON value type: ${typeof value}`);
}

function canonicalizeJsonText(text) {
  assertJsonSubset(text);
  return canonicalizeValue(JSON.parse(text));
}

function deepEqualJson(a, b) {
  return canonicalizeValue(a) === canonicalizeValue(b);
}

function keysSortedRecursively(value) {
  if (Array.isArray(value)) return value.every(keysSortedRecursively);
  if (!value || typeof value !== 'object') return true;
  const keys = Object.keys(value);
  const sorted = keys.slice().sort();
  if (keys.some((key, index) => key !== sorted[index])) return false;
  return keys.every((key) => keysSortedRecursively(value[key]));
}

function makePrng(seed) {
  let x = (seed >>> 0) || 1;
  return function next() {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function randomJsonValue(rng, depth = 0) {
  const choices = depth > 3 ? ['null', 'bool', 'int', 'string'] : ['null', 'bool', 'int', 'string', 'array', 'object'];
  const pick = choices[Math.floor(rng() * choices.length)];
  if (pick === 'null') return null;
  if (pick === 'bool') return rng() > 0.5;
  if (pick === 'int') return Math.floor(rng() * 2000) - 1000;
  if (pick === 'string') {
    const alphabet = ['a', 'b', 'c', 'z', 'A', ' ', 'é', '雪', '\\', '"'];
    const len = Math.floor(rng() * 8);
    let s = '';
    for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(rng() * alphabet.length)];
    return s;
  }
  if (pick === 'array') {
    const len = Math.floor(rng() * 5);
    return Array.from({ length: len }, () => randomJsonValue(rng, depth + 1));
  }
  const len = Math.floor(rng() * 5);
  const obj = {};
  for (let i = 0; i < len; i += 1) {
    obj[`k${Math.floor(rng() * 20)}_${i}`] = randomJsonValue(rng, depth + 1);
  }
  return obj;
}

function builtInGoldenCases() {
  return [
    { id: 'null', input: 'null', expected_stdout: 'null' },
    { id: 'true', input: 'true', expected_stdout: 'true' },
    { id: 'integer', input: '42', expected_stdout: '42' },
    { id: 'empty-array', input: '[]', expected_stdout: '[]' },
    { id: 'empty-object', input: '{}', expected_stdout: '{}' },
    { id: 'key-order', input: '{"b":2,"a":1}', expected_stdout: '{"a":1,"b":2}' },
    { id: 'nested', input: '{"z":[{"b":2,"a":1}],"a":{"d":4,"c":3}}', expected_stdout: '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}' },
    { id: 'unicode', input: '{"snow":"雪","accent":"é"}', expected_stdout: '{"accent":"é","snow":"雪"}' },
    { id: 'escaped', input: '{"quote":"\\"","slash":"\\\\","line":"\\n"}', expected_stdout: '{"line":"\\n","quote":"\\"","slash":"\\\\"}' },
    { id: 'invalid-syntax', input: '{"a":', expected_error: true },
    { id: 'reject-float', input: '{"a":1.5}', expected_error: true },
    { id: 'reject-duplicate-key', input: '{"a":1,"a":2}', expected_error: true, duplicate_key: true },
  ];
}

function builtInBenchmarkCases() {
  const medium = {};
  for (let i = 50; i >= 0; i -= 1) medium[`k${i}`] = [i, { z: i, a: -i }, true];
  const large = {};
  for (let i = 250; i >= 0; i -= 1) large[`item_${i}`] = { z: i, a: [i, i + 1, i + 2], nested: { b: false, a: true } };
  return [
    { id: 'bench-small', input: '{"b":2,"a":1}', expected_stdout: '{"a":1,"b":2}' },
    { id: 'bench-medium', input: JSON.stringify(medium), expected_stdout: canonicalizeValue(medium) },
    { id: 'bench-large', input: JSON.stringify(large), expected_stdout: canonicalizeValue(large) },
  ];
}

function writeJsonCanonicalizerAssets(goalDir, options = {}) {
  const casesDir = path.join(goalDir, 'cases');
  const benchDir = path.join(goalDir, 'bench');
  fs.mkdirSync(casesDir, { recursive: true });
  fs.mkdirSync(benchDir, { recursive: true });
  for (const c of builtInGoldenCases()) {
    fs.writeFileSync(path.join(casesDir, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`, 'utf8');
  }
  for (const c of builtInBenchmarkCases()) {
    fs.writeFileSync(path.join(benchDir, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`, 'utf8');
  }
  if (options.readme !== false) {
    fs.writeFileSync(path.join(goalDir, 'README.md'), [
      '# JSON canonicalizer verification goal',
      '',
      'Generated by `xoloop-verify create --kind json-canonicalizer`.',
      '',
      'The implementation is treated as a black-box CLI: JSON text on stdin, canonical text on stdout.',
      'Invalid JSON-subset inputs must emit structured JSON error output and exit non-zero.',
      '',
    ].join('\n'), 'utf8');
  }
}

function loadCaseFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`case file must contain an object: ${filePath}`);
  }
  if (typeof parsed.id !== 'string' || typeof parsed.input !== 'string') {
    throw new Error(`case file must contain string id and input: ${filePath}`);
  }
  return parsed;
}

function structuredError(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    return parsed && typeof parsed === 'object' && typeof parsed.error === 'string';
  } catch (_err) {
    return false;
  }
}

async function verifyOneCase(goal, cwd, testCase, source) {
  const result = await runCliCommand(goal.interface.command, testCase.input, {
    cwd,
    timeoutMs: goal.interface.timeout_ms,
  });
  const verifications = [];
  let status = 'pass';
  let counterexample = null;

  function fail(obligation, message, extra = {}) {
    status = 'fail';
    verifications.push({ id: obligation, status: 'fail', message, source });
    if (!counterexample) {
      counterexample = {
        case_id: testCase.id,
        source,
        obligation,
        input: testCase.input,
        message,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        ...extra,
      };
    }
  }

  if (testCase.expected_error) {
    if (result.exitCode === 0) {
      fail('reject_invalid', 'expected non-zero exit for invalid JSON-subset input');
    } else if (!structuredError(result.stdout)) {
      fail('structured_error', 'expected stdout to be a JSON object with an error string');
    } else {
      verifications.push({ id: testCase.duplicate_key ? 'rejects_duplicate_keys' : 'reject_invalid', status: 'pass', source });
    }
    return { status, verifications, metrics: result.metrics, counterexample };
  }

  if (result.exitCode !== 0) {
    fail('cli_exit_zero', 'expected zero exit for valid input');
    return { status, verifications, metrics: result.metrics, counterexample };
  }
  const stdout = String(result.stdout || '').trim();
  const expected = testCase.expected_stdout || canonicalizeJsonText(testCase.input);
  if (stdout !== expected) {
    fail('golden_output', 'stdout did not match canonical expected output', { expected_stdout: expected });
    return { status, verifications, metrics: result.metrics, counterexample };
  }
  verifications.push({ id: 'golden_output', status: 'pass', source });

  let parsedInput;
  let parsedOutput;
  try {
    parsedInput = JSON.parse(testCase.input);
    parsedOutput = JSON.parse(stdout);
  } catch (err) {
    fail('parse_output', `failed to parse input/output: ${err.message}`);
    return { status, verifications, metrics: result.metrics, counterexample };
  }

  if (goal.verify.properties.includes('parse_equivalent')) {
    if (!deepEqualJson(parsedInput, parsedOutput)) fail('parse_equivalent', 'canonical output parses to a different JSON value');
    else verifications.push({ id: 'parse_equivalent', status: 'pass', source });
  }
  if (goal.verify.properties.includes('canonical_key_order')) {
    if (!keysSortedRecursively(parsedOutput) || canonicalizeValue(parsedOutput) !== stdout) {
      fail('canonical_key_order', 'output is not recursively canonical');
    } else {
      verifications.push({ id: 'canonical_key_order', status: 'pass', source });
    }
  }
  if (goal.verify.properties.includes('idempotent')) {
    const second = await runCliCommand(goal.interface.command, stdout, {
      cwd,
      timeoutMs: goal.interface.timeout_ms,
    });
    if (second.exitCode !== 0 || String(second.stdout || '').trim() !== stdout) {
      fail('idempotent', 'canon(canon(x)) did not equal canon(x)', { second_stdout: second.stdout, second_exit_code: second.exitCode });
    } else {
      verifications.push({ id: 'idempotent', status: 'pass', source });
    }
  }

  return { status, verifications, metrics: result.metrics, counterexample };
}

function aggregateMetrics(samples) {
  const valid = samples.filter(Boolean);
  if (valid.length === 0) return {};
  const keys = new Set();
  for (const sample of valid) Object.keys(sample).forEach((key) => keys.add(key));
  const out = {};
  for (const key of keys) {
    const values = valid.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    out[key] = values[Math.floor(values.length / 2)];
  }
  return out;
}

async function runJsonCanonicalizerVerification(goal, goalPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const caseFilter = options.caseId || null;
  const caseFiles = expandSimpleJsonGlob(goalPath, goal.verify.golden_cases, cwd);
  const benchmarkFiles = goal.verify.benchmark_cases
    ? expandSimpleJsonGlob(goalPath, goal.verify.benchmark_cases, cwd)
    : [];
  const cases = caseFiles.map(loadCaseFile);
  const benchmarkCases = benchmarkFiles.map(loadCaseFile);
  const verifications = [];
  const metricSamples = [];
  const counterexamples = [];

  const selectedCases = caseFilter ? cases.filter((c) => c.id === caseFilter) : cases;
  if (selectedCases.length === 0) {
    return {
      status: 'fail',
      verifications: [{ id: 'case_selection', status: 'fail', message: `No cases matched ${caseFilter || goal.verify.golden_cases}` }],
      metrics: {},
      counterexample: { obligation: 'case_selection', message: `No cases matched ${caseFilter || goal.verify.golden_cases}` },
    };
  }

  for (const c of selectedCases) {
    const result = await verifyOneCase(goal, cwd, c, 'golden');
    verifications.push(...result.verifications);
    metricSamples.push(result.metrics);
    if (result.counterexample) counterexamples.push(result.counterexample);
  }

  if (!caseFilter && goal.verify.fuzz && goal.verify.fuzz.runs > 0) {
    const rng = makePrng(goal.verify.fuzz.seed);
    for (let i = 0; i < goal.verify.fuzz.runs; i += 1) {
      const value = randomJsonValue(rng);
      const input = JSON.stringify(value);
      const result = await verifyOneCase(goal, cwd, {
        id: `fuzz-${goal.verify.fuzz.seed}-${i}`,
        input,
        expected_stdout: canonicalizeValue(value),
      }, 'fuzz');
      verifications.push(...result.verifications);
      metricSamples.push(result.metrics);
      if (result.counterexample) counterexamples.push(result.counterexample);
      if (counterexamples.length > 0) break;
    }
  }

  if (!caseFilter && benchmarkCases.length > 0) {
    const repeat = Math.max(1, goal.metrics.repeat || 1);
    for (let r = 0; r < repeat; r += 1) {
      for (const c of benchmarkCases) {
        const result = await verifyOneCase(goal, cwd, c, 'benchmark');
        verifications.push(...result.verifications);
        metricSamples.push(result.metrics);
        if (result.counterexample) counterexamples.push(result.counterexample);
        if (counterexamples.length > 0) break;
      }
      if (counterexamples.length > 0) break;
    }
  }

  const status = counterexamples.length > 0 ? 'fail' : 'pass';
  return {
    status,
    verifications,
    metrics: aggregateMetrics(metricSamples),
    counterexample: counterexamples[0] || null,
  };
}

module.exports = {
  assertJsonSubset,
  builtInBenchmarkCases,
  builtInGoldenCases,
  canonicalizeJsonText,
  canonicalizeValue,
  keysSortedRecursively,
  runJsonCanonicalizerVerification,
  writeJsonCanonicalizerAssets,
};
