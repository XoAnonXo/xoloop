'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  detectLanguage,
  scanExports,
  validateSimplifyProposal,
} = require('../plugins/xoloop/lib/xo_simplify_engine.cjs');
const {
  discoverSurfaceFiles,
  extractPublicSymbols,
} = require('../plugins/xoloop/lib/xo_docs_engine.cjs');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-lang-support-'));
}

test('simplify detects Go and Rust public API exports', () => {
  const repo = makeRepo();
  try {
    const goPath = path.join(repo, 'calc.go');
    const rustPath = path.join(repo, 'src/lib.rs');
    fs.mkdirSync(path.dirname(rustPath), { recursive: true });
    fs.writeFileSync(goPath, [
      'package calc',
      'func PublicAdd(a int, b int) int { return a + b }',
      'func privateAdd(a int, b int) int { return a + b }',
      'type Client struct{}',
      'const Version = "1"',
      '',
    ].join('\n'));
    fs.writeFileSync(rustPath, [
      'pub fn public_add(a: i32, b: i32) -> i32 { a + b }',
      'fn private_add(a: i32, b: i32) -> i32 { a + b }',
      'pub struct Client;',
      'pub enum Mode { Fast }',
      '',
    ].join('\n'));

    assert.equal(detectLanguage(goPath), 'go');
    assert.equal(detectLanguage(rustPath), 'rust');
    assert.deepEqual([...scanExports(goPath).exports].sort(), ['Client', 'PublicAdd', 'Version']);
    assert.deepEqual([...scanExports(rustPath).exports].sort(), ['Client', 'Mode', 'public_add']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('simplify blocks deleting exported Go and Rust symbols', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'calc.go'), 'package calc\nfunc PublicAdd() int { return 1 }\n');
    fs.writeFileSync(path.join(repo, 'src/lib.rs'), 'pub fn public_add() -> i32 { 1 }\n');

    const goResult = validateSimplifyProposal({
      changeSet: [{
        kind: 'replace_once',
        path: 'calc.go',
        match: 'func PublicAdd() int { return 1 }',
        replace: '',
      }],
    }, repo);
    const rustResult = validateSimplifyProposal({
      changeSet: [{
        kind: 'replace_once',
        path: 'src/lib.rs',
        match: 'pub fn public_add() -> i32 { 1 }',
        replace: '',
      }],
    }, repo);

    assert.equal(goResult.ok, false);
    assert.match(goResult.reason, /calc\.go:PublicAdd/);
    assert.equal(rustResult.ok, false);
    assert.match(rustResult.reason, /src\/lib\.rs:public_add/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('docs discovers Go and Rust surfaces and extracts existing docs', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'calc.go'), [
      'package calc',
      '// PublicAdd adds two numbers.',
      'func PublicAdd(a int, b int) int { return a + b }',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(repo, 'src/lib.rs'), [
      '/// public_add adds two numbers.',
      'pub fn public_add(a: i32, b: i32) -> i32 { a + b }',
      '',
    ].join('\n'));

    assert.deepEqual(discoverSurfaceFiles(repo), ['calc.go', 'src/lib.rs']);

    const goSymbols = extractPublicSymbols(path.join(repo, 'calc.go')).symbols;
    const rustSymbols = extractPublicSymbols(path.join(repo, 'src/lib.rs')).symbols;

    assert.deepEqual(goSymbols, [{
      name: 'PublicAdd',
      kind: 'function',
      existingDoc: 'PublicAdd adds two numbers.',
    }]);
    assert.deepEqual(rustSymbols, [{
      name: 'public_add',
      kind: 'function',
      existingDoc: 'public_add adds two numbers.',
    }]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
