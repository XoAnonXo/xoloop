'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('Java rate limiter fixture passes real XOLoop checks without mocks', () => {
  const repoRoot = path.join(__dirname, '..');
  const script = path.join(repoRoot, 'examples/java-rate-limiter/scripts/run-xoloop-java-checks.sh');
  const result = spawnSync('bash', [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALL_REAL_JAVA_CHECKS_PASS/);
  assert.doesNotMatch(result.stdout + result.stderr, /\bmock\b|\bfake\b|\bstub\b/i);
});
