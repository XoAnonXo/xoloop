#!/usr/bin/env node
/**
 * xoloop-polish.cjs — thin CLI wrapper around polish_runner.
 *
 * Enforces:
 *   - Bootstrap on first use (ensureConfig)
 *   - Dirty-overlap gate (locked D.1)
 *   - Dry-run default on first invocation per repo (locked D.7)
 */

'use strict';

const {
  requireLib,
  ensureConfig,
  enforceDirtyOverlapGate,
  isFirstInvocationInRepo,
  markFirstInvocationComplete,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const { parsePolishOptions, runPolishLoop } = requireLib('polish_runner.cjs');

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage: xoloop-polish --surface <path> [--rounds N] [--until-saturated] [--dry-run] [--allow-dirty]');
    process.exit(0);
  }

  const cwd = process.cwd();
  const surface = parseFlag(argv, '--surface', null);
  const allowDirty = hasFlag(argv, '--allow-dirty');

  ensureConfig(cwd);
  enforceDirtyOverlapGate(cwd, surface, allowDirty);

  // Locked D.7 — first run per repo is dry-run by default unless --apply forces it.
  let effectiveArgv = argv.slice();
  if (isFirstInvocationInRepo(cwd) && !hasFlag(argv, '--dry-run') && !hasFlag(argv, '--apply')) {
    console.log('[xoloop-polish] First run in this repo — defaulting to --dry-run.');
    console.log('[xoloop-polish] Re-run with --apply after reviewing the proposed changeset.');
    effectiveArgv = argv.concat(['--dry-run']);
  }

  const options = parsePolishOptions(effectiveArgv);
  const summary = await runPolishLoop(options);

  console.log('\n=== Polish Summary ===');
  console.log(`Rounds completed: ${summary.rounds}`);
  console.log(`Proposals landed: ${summary.landed}`);
  console.log(`Proposals failed: ${summary.failed}`);
  console.log(`Saturated:        ${summary.saturated}`);
  console.log(`Recommendation:   ${summary.recommendation}`);

  if (!summary.error) markFirstInvocationComplete(cwd);
  process.exit(summary.error ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-polish] Fatal:', err.message || err);
  process.exit(1);
});
