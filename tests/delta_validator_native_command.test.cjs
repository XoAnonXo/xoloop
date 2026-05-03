'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  runTestsInDir,
  validateRedGreenDelta,
} = require('../plugins/xoloop/lib/delta_validator.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-delta-test-'));
}

function writeExecutableScript(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, 'utf8');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

test('runTestsInDir can use an argv-backed native test command', () => {
  const dir = makeTempDir();
  try {
    const passing = writeExecutableScript(dir, 'pass.sh', '#!/usr/bin/env bash\nexit 0\n');
    const failing = writeExecutableScript(dir, 'fail.sh', '#!/usr/bin/env bash\nexit 1\n');

    assert.deepEqual(
      runTestsInDir(['native.test'], dir, { testCommand: { argv: [passing] } }),
      { total: 1, passed: 1, failed: 0, output: `$ ${passing}` },
    );

    const result = runTestsInDir(['native.test'], dir, { testCommand: { argv: [failing] } });
    assert.equal(result.total, 1);
    assert.equal(result.passed, 0);
    assert.equal(result.failed, 1);
    assert.match(result.output, new RegExp(failing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateRedGreenDelta accepts a native command for red and green phases', () => {
  const baseDir = makeTempDir();
  const candidateDir = makeTempDir();
  try {
    const script = writeExecutableScript(
      candidateDir,
      'native-check.sh',
      '#!/usr/bin/env bash\nif [ -f implementation.ok ]; then exit 0; fi\nexit 1\n',
    );
    fs.writeFileSync(path.join(candidateDir, 'implementation.ok'), 'yes\n', 'utf8');

    const delta = validateRedGreenDelta({
      baseDir,
      candidateDir,
      testPaths: ['native.test'],
      testCommand: './native-check.sh',
      fullValidation: [],
    });

    assert.equal(delta.ok, true);
    assert.deepEqual(delta.red, { total: 1, failed: 1, passed: 0 });
    assert.deepEqual(delta.green, { total: 1, failed: 0, passed: 1 });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }
});
