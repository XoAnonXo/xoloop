#!/usr/bin/env node
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
    console.log('       [--config <path>] [--family <path>] [--mode baseline|proposal|workspace] [--skip-model]');
    process.exit(0);
  }
  const cwd = process.cwd();
  const target = parseFlag(argv, '--target', null);
  const rounds = Number(parseFlag(argv, '--rounds', 5));
  const tokenCap = parseFlag(argv, '--token-cap', 'normal');
  const configPath = parseFlag(argv, '--config', null);
  const familyPath = parseFlag(argv, '--family', null);
  const mode = parseFlag(argv, '--mode', null);
  const skipModel = hasFlag(argv, '--skip-model');
  const allowDirty = hasFlag(argv, '--allow-dirty');

  if (!target) {
    console.error('[xoloop-autoresearch] --target is required.');
    process.exit(1);
  }

  ensureConfig(cwd);
  enforceDirtyOverlapGate(cwd, target, allowDirty);

  const result = await runAutoresearchLoop({
    target: path.resolve(target),
    configPath,
    familyPath,
    maxIterations: Number.isFinite(rounds) && rounds > 0 ? rounds : 5,
    mode: mode || (skipModel ? 'baseline' : undefined),
    skipModel,
    risk: tokenCap === 'strategic' ? 'guarded' : 'safe',
    overrideBudget: tokenCap === 'override',
    cwd,
  });
  const iterations = Array.isArray(result.iterations) ? result.iterations : [];
  const kept = iterations.filter((iteration) => iteration && iteration.decision && iteration.decision.keep).length;
  const winner = kept > 0 ? 'challenger' : 'champion';
  const converged = result.stopReason ? result.stopReason.reason : (iterations.length === 0 ? 'baseline-only' : 'round-limit');

  console.log('\n=== Autoresearch Summary ===');
  console.log(`Rounds:        ${iterations.length}`);
  console.log(`Winner:        ${winner}`);
  console.log(`Converged:     ${converged}`);
  console.log(`Evidence path: ${result.artifacts && result.artifacts.reportPath ? result.artifacts.reportPath : 'n/a'}`);
  if (result.sensitiveDomainGate) {
    console.log(`\n[human approval required] domain=${result.sensitiveDomainGate.domain}`);
  }
  process.exit(result.error ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-autoresearch] Fatal:', err.message || err);
  process.exit(1);
});
