'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  inferFuzzLanguage,
  buildNativeFuzzHarness,
  runNativeFuzzHarness,
} = require('../plugins/xoloop/lib/fuzz_engine.cjs');

test('fuzz language inference covers JS, TS, Python, Rust, Go, and Ruby', () => {
  assert.equal(inferFuzzLanguage('src/mod.cjs'), 'javascript');
  assert.equal(inferFuzzLanguage('src/mod.ts'), 'typescript');
  assert.equal(inferFuzzLanguage('pkg/mod.py'), 'python');
  assert.equal(inferFuzzLanguage('src/lib.rs'), 'rust');
  assert.equal(inferFuzzLanguage('mod.go'), 'go');
  assert.equal(inferFuzzLanguage('lib/mod.rb'), 'ruby');
});

test('native fuzz harnesses use each language test ecosystem', () => {
  const cases = [
    ['typescript', 'src/mod.ts', /fast-check/, ['npx', 'tsx', '--test']],
    ['python', 'mod.py', /inspect/, ['python3']],
    ['rust', 'src/lib.rs', /#\[test\]/, ['cargo', 'test']],
    ['go', 'mod.go', /func Fuzz/, ['go', 'test']],
    ['ruby', 'lib/mod.rb', /minitest/, ['ruby', '-Ilib']],
  ];

  for (const [language, modulePath, contentRe, commandPrefix] of cases) {
    const harness = buildNativeFuzzHarness(modulePath, { language, targetName: 'mod' });
    assert.equal(harness.language, language);
    assert.match(harness.content, contentRe);
    assert.deepEqual(harness.command.argv.slice(0, commandPrefix.length), commandPrefix);
    assert.ok(harness.path.length > 0);
  }
});

test('native fuzz harness is null for unknown languages', () => {
  assert.equal(buildNativeFuzzHarness('example.erl'), null);
});

test('native fuzz runner executes a Python stdlib harness', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-python-fuzz-'));
  try {
    fs.writeFileSync(path.join(repo, 'mod.py'), 'def accept(value):\n    return value\n', 'utf8');
    const harness = buildNativeFuzzHarness('mod.py', { language: 'python', targetName: 'mod' });
    const result = runNativeFuzzHarness(repo, harness);
    assert.equal(result.ok, true, result.output);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('native fuzz runner executes a TypeScript fast-check harness through tsx', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-ts-fuzz-'));
  try {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/mod.ts'), 'export function accept(value: unknown): unknown { return value; }\n', 'utf8');
    const harness = buildNativeFuzzHarness('src/mod.ts', { language: 'typescript', targetName: 'mod' });
    const result = runNativeFuzzHarness(repo, harness);
    assert.equal(result.ok, true, result.output);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('native fuzz runner executes a Rust cargo harness', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-rust-fuzz-'));
  try {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'Cargo.toml'), '[package]\nname = "fuzz_sample"\nversion = "0.1.0"\nedition = "2021"\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'src/lib.rs'), 'pub fn accept(value: &str) -> &str { value }\n', 'utf8');
    const harness = buildNativeFuzzHarness('src/lib.rs', { language: 'rust', targetName: 'mod' });
    const result = runNativeFuzzHarness(repo, harness);
    assert.equal(result.ok, true, result.output);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('native fuzz runner executes a Go built-in fuzz harness', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-go-fuzz-'));
  try {
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/fuzz\n\ngo 1.20\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'mod.go'), 'package fuzz\n\nfunc Accept(value string) string { return value }\n', 'utf8');
    const harness = buildNativeFuzzHarness('mod.go', { language: 'go', targetName: 'mod', packageName: 'fuzz' });
    const result = runNativeFuzzHarness(repo, harness);
    assert.equal(result.ok, true, result.output);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('native fuzz runner executes a Ruby minitest harness', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-ruby-fuzz-'));
  try {
    fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'lib/mod.rb'), 'module Mod\n  def self.accept(value)\n    value\n  end\nend\n', 'utf8');
    const harness = buildNativeFuzzHarness('lib/mod.rb', { language: 'ruby', targetName: 'mod' });
    const result = runNativeFuzzHarness(repo, harness);
    assert.equal(result.ok, true, result.output);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
