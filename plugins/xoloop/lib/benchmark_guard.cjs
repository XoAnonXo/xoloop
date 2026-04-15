'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { AdapterError } = require('./errors.cjs');

/**
 * Compute the SHA-256 hex digest of a file.
 *
 * @param {string} filePath - Absolute path to the file.
 * @returns {string} Lowercase hex SHA-256 hash (64 characters).
 */
function computeHash(filePath) {
  if (filePath == null || typeof filePath !== 'string' || filePath.length === 0) {
    throw new AdapterError(
      'BENCHMARK_GUARD_PATH_REQUIRED',
      'filePath',
      'filePath must be a non-empty string',
      { fixHint: 'Pass the absolute path to the benchmark file as a non-empty string.' },
    );
  }
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Lock a benchmark file by recording its hash in a registry JSON file.
 * Creates or updates the registry file at registryPath.
 *
 * @param {string} benchmarkPath - Absolute path to the benchmark file.
 * @param {string} registryPath - Absolute path to the registry JSON file.
 */
function lockBenchmark(benchmarkPath, registryPath) {
  if (benchmarkPath == null || typeof benchmarkPath !== 'string' || benchmarkPath.length === 0) {
    throw new AdapterError(
      'BENCHMARK_GUARD_PATH_REQUIRED',
      'benchmarkPath',
      'benchmarkPath must be a non-empty string',
      { fixHint: 'Pass the absolute path to the benchmark file as a non-empty string.' },
    );
  }
  if (registryPath == null || typeof registryPath !== 'string' || registryPath.length === 0) {
    throw new AdapterError(
      'BENCHMARK_GUARD_REGISTRY_PATH_REQUIRED',
      'registryPath',
      'registryPath must be a non-empty string',
      { fixHint: 'Pass the absolute path to the registry JSON file as a non-empty string.' },
    );
  }

  const hash = computeHash(benchmarkPath);

  // Read existing registry or start fresh
  let registry = {};
  try {
    const existing = fs.readFileSync(registryPath, 'utf8');
    registry = JSON.parse(existing);
  } catch (_err) {
    // File doesn't exist yet or is invalid — start fresh
  }

  registry[benchmarkPath] = hash;
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
}

/**
 * Verify that a benchmark file has not been tampered with since it was locked.
 *
 * @param {string} benchmarkPath - Absolute path to the benchmark file.
 * @param {string} registryPath - Absolute path to the registry JSON file.
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyIntegrity(benchmarkPath, registryPath) {
  if (benchmarkPath == null || typeof benchmarkPath !== 'string' || benchmarkPath.length === 0) {
    throw new AdapterError(
      'BENCHMARK_GUARD_PATH_REQUIRED',
      'benchmarkPath',
      'benchmarkPath must be a non-empty string',
      { fixHint: 'Pass the absolute path to the benchmark file as a non-empty string.' },
    );
  }
  if (registryPath == null || typeof registryPath !== 'string' || registryPath.length === 0) {
    throw new AdapterError(
      'BENCHMARK_GUARD_REGISTRY_PATH_REQUIRED',
      'registryPath',
      'registryPath must be a non-empty string',
      { fixHint: 'Pass the absolute path to the registry JSON file as a non-empty string.' },
    );
  }

  // Read the registry
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (_err) {
    return { ok: false, reason: 'registry file not found or invalid' };
  }

  if (registry == null || typeof registry !== 'object' || Array.isArray(registry)) {
    return { ok: false, reason: 'registry file not found or invalid' };
  }

  const lockedHash = registry[benchmarkPath];
  if (!lockedHash) {
    return { ok: false, reason: `no hash recorded for ${benchmarkPath}` };
  }

  const currentHash = computeHash(benchmarkPath);

  if (currentHash === lockedHash) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `hash mismatch: expected ${lockedHash}, got ${currentHash} — file was tampered with`,
  };
}

module.exports = {
  computeHash,
  lockBenchmark,
  verifyIntegrity,
};
