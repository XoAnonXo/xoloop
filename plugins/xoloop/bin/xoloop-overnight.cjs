#!/usr/bin/env node
/**
 * xoloop-overnight.cjs — thin CLI wrapper for the batch orchestrator.
 *
 * Subcommands: run | xo | inspect | promote | cleanup
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

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
const { loadOvernightAdapter } = requireLib('overnight_adapter.cjs');

// Default when the adapter doesn't override it (mirrors
// overnight_engine.cjs:DEFAULT_REPORT_DIR).
const DEFAULT_REPORT_DIR = 'proving-ground/reports/overnight';

// Resolve --batch-id / --batch-dir into an absolute batchDir path.
//
// Round-1 smoke test caught path.resolve(undefined) throwing cryptic
// "paths[0] must be of type string. Received null". Round-2 smoke test
// caught a worse bug in my round-1 fix: defaultWorktreeRoot returns
// `<repo>-baton-worktrees/<id>` (git worktree location), but the engine
// writes the manifest at `<repoRoot>/<adapter.defaults.reportDir>/<id>/`.
// Worktree dir ≠ report/manifest dir — completely different trees.
//
// Correct resolution order:
//   1. --batch-dir <path>                → absolute-resolve it
//   2. --batch-id <id> + overnight.yaml  → repoRoot/reportDir/id
//   3. --batch-id <id> without adapter   → fall back to repoRoot/DEFAULT_REPORT_DIR/id
//   4. None                              → return null (wrapper prints clean error)
function resolveBatchDir(options) {
  if (options.batchDir && typeof options.batchDir === 'string') {
    return path.resolve(options.batchDir);
  }
  if (!options.batchId || typeof options.batchId !== 'string') {
    return null;
  }
  const repoRoot = options.repoRoot || process.cwd();
  let reportDir = DEFAULT_REPORT_DIR;
  try {
    const adapter = loadOvernightAdapter(
      options.adapterPath || path.join(repoRoot, 'overnight.yaml'),
      { repoRoot },
    );
    if (adapter && adapter.defaults && adapter.defaults.reportDir) {
      reportDir = adapter.defaults.reportDir;
    }
  } catch (_adapterErr) {
    // Adapter missing/invalid — fall through with DEFAULT_REPORT_DIR.
    // Caller's downstream MANIFEST_NOT_FOUND is still actionable.
  }
  return path.resolve(repoRoot, reportDir, options.batchId);
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
