#!/usr/bin/env node
/**
 * xoloop-autoresearch.cjs — thin CLI wrapper for Champion vs Challenger tournament.
 */

'use strict';

const path = require('node:path');
const {
  requireLib,
  ensureConfig,
  enforceDirtyOverlapGate,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const { runAutoresearchLoop } = requireLib('autoresearch_loop.cjs');

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage: xoloop-autoresearch --target <path> [--rounds 5] [--token-cap utility|normal|strategic|override]');
    process.exit(0);
  }
  const cwd = process.cwd();
  const target = parseFlag(argv, '--target', null);
  const rounds = Number(parseFlag(argv, '--rounds', 5));
  const tokenCap = parseFlag(argv, '--token-cap', 'normal');
  const allowDirty = hasFlag(argv, '--allow-dirty');

  if (!target) {
    console.error('[xoloop-autoresearch] --target is required.');
    process.exit(1);
  }

  ensureConfig(cwd);
  enforceDirtyOverlapGate(cwd, target, allowDirty);

  const result = await runAutoresearchLoop({
    target: path.resolve(target),
    maxRounds: rounds,
    tokenBudgetTier: tokenCap,
    cwd,
  });

  console.log('\n=== Autoresearch Summary ===');
  console.log(`Rounds:        ${result.rounds}`);
  console.log(`Winner:        ${result.winner}`);
  console.log(`Converged:     ${result.converged}`);
  console.log(`Evidence path: ${result.evidencePath || 'n/a'}`);
  if (result.sensitiveDomainGate) {
    console.log(`\n[human approval required] domain=${result.sensitiveDomainGate.domain}`);
  }
  process.exit(result.error ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-autoresearch] Fatal:', err.message || err);
  process.exit(1);
});
