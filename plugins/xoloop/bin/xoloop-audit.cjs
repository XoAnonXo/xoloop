#!/usr/bin/env node
/**
 * xoloop-audit.cjs — thin CLI wrapper for the audit→fix loop.
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

const { runAuditFixLoop } = requireLib('audit_runner.cjs');
const { callAuditorWithCodex } = requireLib('audit_caller_codex.cjs');
const { callFixerWithOpus } = requireLib('audit_caller_opus.cjs');

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage: xoloop-audit --target <path> [--severity-floor P2] [--max-rounds 10] [--read-only] [--allow-dirty]');
    process.exit(0);
  }

  const cwd = process.cwd();
  const target = parseFlag(argv, '--target', null);
  const severityFloor = parseFlag(argv, '--severity-floor', 'P2');
  const maxRounds = Number(parseFlag(argv, '--max-rounds', 10));
  const readOnly = hasFlag(argv, '--read-only');
  const allowDirty = hasFlag(argv, '--allow-dirty');

  if (!target) {
    console.error('[xoloop-audit] --target is required.');
    process.exit(1);
  }

  ensureConfig(cwd);
  if (!readOnly) enforceDirtyOverlapGate(cwd, target, allowDirty);

  const result = await runAuditFixLoop({
    target: {
      cwd,
      files: [path.resolve(target)],
      description: `Audit ${target} for correctness and security issues.`,
    },
    callAuditor: callAuditorWithCodex,
    callFixer: readOnly ? null : callFixerWithOpus,
    severityFloor,
    maxRounds,
    readOnly,
  });

  console.log('\n=== Audit Summary ===');
  console.log(`Rounds:           ${result.rounds}`);
  console.log(`Findings closed:  ${result.findingsClosed || 0}`);
  console.log(`Converged:        ${result.converged}`);
  console.log(`Remaining (by severity):`, result.remainingBySeverity || {});
  process.exit(result.error ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-audit] Fatal:', err.message || err);
  process.exit(1);
});
