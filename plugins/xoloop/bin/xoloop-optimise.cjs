#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

function ensureModernNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isFinite(major) && major >= 16) return;
  const candidates = [
    '/opt/homebrew/bin/node',
    '/Applications/Codex.app/Contents/Resources/node',
    `${process.env.HOME || ''}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`,
  ].filter(Boolean);
  const modern = candidates.find((candidate) => fs.existsSync(candidate) && candidate !== process.execPath);
  if (!modern) return;
  const result = spawnSync(modern, [__filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

ensureModernNode();

const {
  enforceDirtyOverlapGate,
  hasFlag,
  parseFlag,
  requireLib,
} = require('./_common.cjs');

const { runOptimiseLoop } = requireLib('goal_optimise_runner.cjs');

function printHelp() {
  console.log([
    'Usage:',
    '  xoloop-optimise run <goal.yaml> --agent-command "<cmd>" [--rounds 1] [--forever] [--allow-dirty] [--json]',
    '  xoloop-optimize run <goal.yaml> --agent-command "<cmd>" [--rounds 1] [--forever]',
  ].join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h') || argv.length === 0) {
    printHelp();
    process.exit(0);
  }
  const sub = argv[0];
  if (sub !== 'run') throw new Error(`unknown xoloop-optimise subcommand: ${sub}`);
  const goalPath = argv[1];
  if (!goalPath) throw new Error('xoloop-optimise run requires <goal.yaml>');
  const agentCommand = parseFlag(argv, '--agent-command', null);
  if (!agentCommand) throw new Error('xoloop-optimise run requires --agent-command "<cmd>"');

  const allowDirty = hasFlag(argv, '--allow-dirty');
  const surface = parseFlag(argv, '--surface', '.');
  enforceDirtyOverlapGate(process.cwd(), surface, allowDirty);

  const parsedRounds = parseInt(parseFlag(argv, '--rounds', '1'), 10);
  const summary = await runOptimiseLoop({
    cwd: process.cwd(),
    goalPath,
    agentCommand,
    rounds: Number.isFinite(parsedRounds) && parsedRounds > 0 ? parsedRounds : 1,
    forever: hasFlag(argv, '--forever'),
  });

  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('\n=== Optimise Summary ===');
    console.log(`Rounds:   ${summary.rounds}`);
    console.log(`Accepted: ${summary.accepted}`);
    console.log(`Rejected: ${summary.rejected}`);
    console.log(`Noops:    ${summary.noops}`);
    console.log(`Stop:     ${summary.stop_reason}`);
    if (Array.isArray(summary.tradeoffs) && summary.tradeoffs.length > 0) {
      console.log(`Tradeoffs: ${summary.tradeoffs.length}`);
      for (const tradeoff of summary.tradeoffs.slice(0, 5)) {
        console.log(`- ${tradeoff.id}: ${tradeoff.description} (${tradeoff.estimated_savings})`);
      }
    }
    if (Array.isArray(summary.notes) && summary.notes.length > 0) console.log(`Notes:    ${summary.notes.length}`);
    if (summary.error) console.log(`Error:    ${summary.error}`);
    if (summary.final_card) console.log(`Verdict:  ${summary.final_card.verdict}`);
  }
  process.exit(summary.error ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-optimise] Fatal:', err.message || err);
  process.exit(1);
});
