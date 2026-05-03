'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  scanExports,
  scanPyExportsWithAst,
  scanRbExportsWithRipper,
} = require('../plugins/xoloop/lib/xo_simplify_engine.cjs');
const {
  extractPublicSymbols,
  findPythonDocWithAst,
  findRubyDocWithRipper,
} = require('../plugins/xoloop/lib/xo_docs_engine.cjs');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-parser-support-'));
}

test('Python simplify uses AST-backed __all__ and top-level public symbols', () => {
  const source = [
    '__all__ = ["public_name"]',
    'def public_name():',
    '    return 1',
    'def hidden_by_all():',
    '    return 2',
    '',
  ].join('\n');

  assert.deepEqual([...scanPyExportsWithAst(source)].sort(), ['public_name']);
});

test('Ruby simplify uses Ripper-backed public symbol extraction', () => {
  const source = [
    'module Tools',
    'end',
    'class Runner',
    'end',
    'def public_call',
    'end',
    'def _internal',
    'end',
    'VERSION = "1"',
    '',
  ].join('\n');

  assert.deepEqual([...scanRbExportsWithRipper(source)].sort(), ['Runner', 'Tools', 'VERSION', 'public_call']);
});

test('Python and Ruby docs extract parser-backed existing docs', () => {
  const repo = makeRepo();
  try {
    const pyPath = path.join(repo, 'tool.py');
    const rbPath = path.join(repo, 'tool.rb');
    fs.writeFileSync(pyPath, [
      'def public_name():',
      '    """Return the public name."""',
      '    return "name"',
      '',
    ].join('\n'));
    fs.writeFileSync(rbPath, [
      '# Run the public call.',
      'def public_call',
      'end',
      '',
    ].join('\n'));

    assert.equal(findPythonDocWithAst(fs.readFileSync(pyPath, 'utf8'), 'public_name'), 'Return the public name.');
    assert.equal(findRubyDocWithRipper(fs.readFileSync(rbPath, 'utf8'), 'public_call'), 'Run the public call.');
    assert.deepEqual(extractPublicSymbols(pyPath).symbols, [{
      name: 'public_name',
      kind: 'function',
      existingDoc: 'Return the public name.',
    }]);
    assert.deepEqual(extractPublicSymbols(rbPath).symbols, [{
      name: 'public_call',
      kind: 'function',
      existingDoc: 'Run the public call.',
    }]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('scanExports uses parser-backed Python and Ruby paths', () => {
  const repo = makeRepo();
  try {
    const pyPath = path.join(repo, 'tool.py');
    const rbPath = path.join(repo, 'tool.rb');
    fs.writeFileSync(pyPath, 'class PublicClass:\n    pass\n\ndef public_func():\n    pass\n');
    fs.writeFileSync(rbPath, 'class PublicClass\nend\n\ndef public_func\nend\n');

    assert.deepEqual([...scanExports(pyPath).exports].sort(), ['PublicClass', 'public_func']);
    assert.deepEqual([...scanExports(rbPath).exports].sort(), ['PublicClass', 'public_func']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
