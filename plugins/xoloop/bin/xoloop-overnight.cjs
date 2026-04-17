#!/usr/bin/env node
/**
 * xoloop-overnight.cjs — thin CLI wrapper for the batch orchestrator.
 *
 * Subcommands: run | xo | inspect | promote | cleanup
 */

'use strict';

const {
  requireLib,
  ensureConfig,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const {
  runOvernightBatch,
  inspectOvernightBatch,
  promoteOvernightBatch,
  cleanupOvernightBatch,
  initOvernightEngine,
} = requireLib('overnight_engine.cjs');
const { runXoPipeline, formatXoReport } = requireLib('xo_pipeline.cjs');
const { defaultWorktreeRoot } = requireLib('baton_common.cjs');

// Resolve --batch-id / --batch-dir into an absolute batchDir path.
// inspect / promote / cleanup all need this; the user naturally passes
// `--batch-id X` (the id they see in ledger output) rather than the full
// worktree-root path. Centralize the resolution so we don't crash with
// "paths[0] argument must be of type string. Received null" when only
// batchId was supplied.
function resolveBatchDir(options) {
  if (options.batchDir && typeof options.batchDir === 'string') {
    return path.resolve(options.batchDir);
  }
  if (options.batchId && typeof options.batchId === 'string') {
    return defaultWorktreeRoot(options.repoRoot || process.cwd(), options.batchId);
  }
  return null;
}

function parseArgs(argv) {
  const options = {
    command: 'run',
    repoRoot: process.cwd(),
    adapterPath: null,
    objectivePath: null,
    batchDir: null,
    batchId: null,
    attemptLimit: null,
    maxTotalAttempts: null,
    surfaceId: null,
    proposalMode: null,
    allowDirty: false,
    xoPhases: null,
  };
  const tokens = argv.slice();
  if (tokens.length && !tokens[0].startsWith('--')) {
    options.command = tokens.shift().toLowerCase();
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t === '--repo-root') { options.repoRoot = String(next || '').trim() || options.repoRoot; i += 1; }
    else if (t === '--adapter') { options.adapterPath = String(next || '').trim() || null; i += 1; }
    else if (t === '--objective') { options.objectivePath = String(next || '').trim() || null; i += 1; }
    else if (t === '--batch-dir') { options.batchDir = String(next || '').trim() || null; i += 1; }
    else if (t === '--batch-id') { options.batchId = String(next || '').trim() || null; i += 1; }
    else if (t === '--attempt-limit') { options.attemptLimit = Number(next || 0) || null; i += 1; }
    else if (t === '--max-attempts') { options.maxTotalAttempts = Number(next || 0) || null; i += 1; }
    else if (t === '--surface') { options.surfaceId = String(next || '').trim() || null; i += 1; }
    else if (t === '--proposal-mode') { options.proposalMode = String(next || '').trim().toLowerCase() || null; i += 1; }
    else if (t === '--xo-phases') { options.xoPhases = String(next || '').trim() || null; i += 1; }
    else if (t === '--allow-dirty') { options.allowDirty = true; }
  }
  return options;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage:');
    console.log('  xoloop-overnight xo [--repo-root .]');
    console.log('  xoloop-overnight run --surface <id> [--xo-phases "polish,audit"]');
    console.log('  xoloop-overnight inspect --batch-id <id>');
    console.log('  xoloop-overnight promote --batch-id <id>');
    console.log('  xoloop-overnight cleanup --batch-id <id>');
    process.exit(0);
  }

  const options = parseArgs(argv);
  ensureConfig(options.repoRoot);

  let result;
  switch (options.command) {
    case 'xo': {
      // xo_pipeline.runXoPipeline has its own options shape; map from CLI flags.
      const xoOptions = {
        repoRoot: options.repoRoot,
        dryRun: false,
        phases: options.xoPhases ? options.xoPhases.split(',').map((s) => s.trim()) : undefined,
      };
      result = await runXoPipeline(xoOptions);
      if (result && result.summary) {
        process.stdout.write(formatXoReport(result.summary) + '\n');
      }
      break;
    }
    case 'init':
      result = await initOvernightEngine(options);
      break;
    case 'run':
      result = await runOvernightBatch(options);
      break;
    case 'inspect':
    case 'promote':
    case 'cleanup': {
      const resolvedBatchDir = resolveBatchDir(options);
      if (!resolvedBatchDir) {
        console.error(`[xoloop-overnight] ${options.command} requires --batch-id <id> or --batch-dir <path>`);
        process.exit(1);
      }
      const engineOptions = { ...options, batchDir: resolvedBatchDir };
      if (options.command === 'inspect') result = await inspectOvernightBatch(engineOptions);
      else if (options.command === 'promote') result = await promoteOvernightBatch(engineOptions);
      else result = await cleanupOvernightBatch(engineOptions);
      break;
    }
    default:
      console.error(`[xoloop-overnight] unknown command: ${options.command}`);
      process.exit(1);
  }

  if (options.command !== 'xo') {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(result && result.error ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-overnight] Fatal:', err.message || err);
  process.exit(1);
});
