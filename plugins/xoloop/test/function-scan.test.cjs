'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scanFunctionRepo } = require('../lib/goal_function_scan.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-function-scan-'));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function byName(scan, name) {
  return scan.functions.find((fn) => fn.name === name);
}

test('function scan finds JS and TS exported functions with candidate examples and test oracles', () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'src/math.ts'), [
    '/**',
    ' * Adds two finite numbers.',
    ' * @example add(1, 2) => 3',
    ' * @returns the sum as a number',
    ' */',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export const slugify = (value: string): string => value.trim().toLowerCase();',
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'src/text.js'), [
    'exports.normalize = function normalize(value) {',
    '  return String(value).trim();',
    '};',
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'test/math.test.ts'), [
    "import { add, slugify } from '../src/math';",
    "expect(add(1, 2)).toBe(3);",
    "assert.equal(slugify('Hello World'), 'hello world');",
    '',
  ].join('\n'));

  const scan = scanFunctionRepo(cwd);
  const add = byName(scan, 'add');
  const slugify = byName(scan, 'slugify');
  const normalize = byName(scan, 'normalize');

  assert.equal(scan.schema, 'xoloop.function_scan.v0.1');
  assert.equal(add.language, 'typescript');
  assert.equal(add.visibility, 'exported');
  assert.deepEqual(add.params.map((param) => [param.name, param.type]), [['a', 'number'], ['b', 'number']]);
  assert.equal(add.returns.type, 'number');
  assert.equal(add.purity.classification, 'pure');
  assert.ok(add.candidate_inputs.some((input) => input.source === 'comment-example'));
  assert.ok(add.candidate_outputs.some((output) => output.value === '3'));
  assert.ok(add.oracles.some((oracle) => oracle.source === 'existing-test'));
  assert.equal(slugify.purity.classification, 'pure');
  assert.equal(normalize.file, 'src/text.js');
  assert.ok(scan.files.includes('src/math.ts'));
});

test('function scan treats CommonJS module.exports object entries as exported API', () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'lib/index.cjs'), [
    'function normalize(value) {',
    '  return String(value).trim();',
    '}',
    '',
    'const slug = (value) => String(value).toLowerCase();',
    '',
    'const parse = function parse(value) {',
    '  return JSON.parse(value);',
    '};',
    '',
    'module.exports = {',
    '  normalize,',
    '  slugify: slug,',
    '  parse,',
    '};',
    '',
  ].join('\n'));

  const scan = scanFunctionRepo(cwd);

  assert.equal(byName(scan, 'normalize').visibility, 'exported');
  assert.equal(byName(scan, 'slugify').visibility, 'exported');
  assert.equal(byName(scan, 'parse').visibility, 'exported');
  assert.equal(byName(scan, 'slug'), undefined);
});

test('function scan finds public Python defs and flags filesystem side effects', () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'pkg/api.py'), [
    'def tokenize(text: str) -> list[str]:',
    '    """Example: tokenize("a b") == ["a", "b"]."""',
    '    return text.split()',
    '',
    'def save_report(path: str, body: str) -> None:',
    '    with open(path, "w") as handle:',
    '        handle.write(body)',
    '',
    'def _private_helper(value):',
    '    return value',
    '',
  ].join('\n'));

  const scan = scanFunctionRepo(cwd);
  const tokenize = byName(scan, 'tokenize');
  const saveReport = byName(scan, 'save_report');

  assert.equal(tokenize.language, 'python');
  assert.equal(tokenize.visibility, 'public');
  assert.deepEqual(tokenize.params.map((param) => [param.name, param.type]), [['text', 'str']]);
  assert.equal(tokenize.returns.type, 'list[str]');
  assert.equal(tokenize.purity.classification, 'pure');
  assert.equal(saveReport.purity.classification, 'side_effectful');
  assert.ok(saveReport.side_effects.some((effect) => effect.kind === 'filesystem'));
  assert.equal(byName(scan, '_private_helper'), undefined);
});

test('function scan finds exported Go funcs', () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'calc/calc.go'), [
    'package calc',
    '',
    '// Combine returns the sum of the values.',
    'func Combine(values []int, seed int) int {',
    '  total := seed',
    '  for _, value := range values {',
    '    total += value',
    '  }',
    '  return total',
    '}',
    '',
    'func hidden() int { return 0 }',
    '',
  ].join('\n'));

  const scan = scanFunctionRepo(cwd);
  const combine = byName(scan, 'Combine');

  assert.equal(combine.language, 'go');
  assert.equal(combine.visibility, 'public');
  assert.deepEqual(combine.params.map((param) => [param.name, param.type]), [['values', '[]int'], ['seed', 'int']]);
  assert.equal(combine.returns.type, 'int');
  assert.equal(combine.purity.classification, 'pure');
  assert.equal(byName(scan, 'hidden'), undefined);
});

test('function scan finds Rust pub fns', () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'src/lib.rs'), [
    '/// Clamp a value into an inclusive range.',
    'pub fn clamp(value: i32, min: i32, max: i32) -> i32 {',
    '    value.max(min).min(max)',
    '}',
    '',
    'fn hidden() -> i32 { 0 }',
    '',
  ].join('\n'));

  const scan = scanFunctionRepo(cwd);
  const clamp = byName(scan, 'clamp');

  assert.equal(clamp.language, 'rust');
  assert.equal(clamp.visibility, 'public');
  assert.deepEqual(clamp.params.map((param) => [param.name, param.type]), [['value', 'i32'], ['min', 'i32'], ['max', 'i32']]);
  assert.equal(clamp.returns.type, 'i32');
  assert.equal(clamp.purity.classification, 'pure');
  assert.equal(byName(scan, 'hidden'), undefined);
});

test('function scan classifies network, process, logging, and time effects', () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'src/effects.js'), [
    'export async function fetchUser(id) {',
    "  const response = await fetch('/api/users/' + id);",
    '  console.log(response.status);',
    '  return response.json();',
    '}',
    '',
    'export function nowLabel(prefix) {',
    '  return prefix + Date.now();',
    '}',
    '',
  ].join('\n'));
  writeText(path.join(cwd, 'cmd/run.go'), [
    'package cmd',
    '',
    'func Run(name string) error {',
    '  fmt.Println(name)',
    '  return exec.Command("echo", name).Run()',
    '}',
    '',
  ].join('\n'));

  const scan = scanFunctionRepo(cwd);
  const fetchUser = byName(scan, 'fetchUser');
  const nowLabel = byName(scan, 'nowLabel');
  const run = byName(scan, 'Run');

  assert.equal(fetchUser.purity.classification, 'side_effectful');
  assert.ok(fetchUser.side_effects.some((effect) => effect.kind === 'network'));
  assert.ok(fetchUser.side_effects.some((effect) => effect.kind === 'logging'));
  assert.equal(nowLabel.purity.classification, 'side_effectful');
  assert.ok(nowLabel.side_effects.some((effect) => effect.kind === 'time'));
  assert.equal(run.purity.classification, 'side_effectful');
  assert.ok(run.side_effects.some((effect) => effect.kind === 'process'));
});

test('function scan suggests missing obligations plus generated cases and harnesses', () => {
  const cwd = tmpDir();
  writeText(path.join(cwd, 'src/hash.ts'), [
    '/** Deterministic stable hash. Invariant: equal inputs produce equal outputs. */',
    'export function stableHash(input: string): string {',
    '  return input.split("").reverse().join("");',
    '}',
    '',
  ].join('\n'));

  const scan = scanFunctionRepo(cwd);
  const stableHash = byName(scan, 'stableHash');

  assert.ok(stableHash.obligations.missing.includes('property'));
  assert.ok(stableHash.obligations.missing.includes('fuzz'));
  assert.ok(stableHash.obligations.missing.includes('differential'));
  assert.ok(stableHash.obligations.present.includes('formal_comment'));
  assert.ok(stableHash.generated_cases.some((item) => item.kind === 'property'));
  assert.ok(stableHash.harness_suggestions.some((item) => item.kind === 'property'));
  assert.ok(stableHash.harness_suggestions.some((item) => item.kind === 'fuzz'));
  assert.ok(stableHash.harness_suggestions.some((item) => item.kind === 'differential'));
  assert.ok(scan.missing_obligations.includes('property'));
  assert.ok(scan.generated_cases.some((item) => item.function_id === stableHash.id));
});
