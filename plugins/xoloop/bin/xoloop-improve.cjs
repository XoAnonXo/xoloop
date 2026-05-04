#!/usr/bin/env node
'use strict';

const {
  requireLib,
  ensureConfig,
  enforceDirtyOverlapGate,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const { parseImproveOptions, runImproveLoop } = requireLib('improve_runner.cjs');

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage: xoloop-improve --benchmark <path> --surface <path> [--rounds 10] [--allow-dirty]');
    process.exit(0);
  }
  const cwd = process.cwd();
  const surface = parseFlag(argv, '--surface', null);
  const target = surface || parseFlag(argv, '--target', null);
  const allowDirty = hasFlag(argv, '--allow-dirty');

  ensureConfig(cwd);
  enforceDirtyOverlapGate(cwd, target, allowDirty);

  const options = parseImproveOptions(argv);
  const summary = await runImproveLoop(options);

  console.log('\n=== Improve Summary ===');
  console.log(`Rounds completed: ${summary.rounds}`);
  console.log(`Improvements:     ${summary.improvements}`);
  console.log(`Regressions:      ${summary.regressions}`);
  console.log(`Neutrals:         ${summary.neutrals}`);
  console.log(`Saturated:        ${summary.saturated}`);
  if (summary.error) console.log(`Error:            ${summary.error}`);
  process.exit(summary.error ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-improve] Fatal:', err.message || err);
  process.exit(1);
});
