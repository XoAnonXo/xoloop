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
  hasFlag,
  parseFlag,
  requireLib,
} = require('./_common.cjs');

const {
  buildVerifyCard,
  createGoal,
  formatVerifyCard,
  runGoalVerify,
} = requireLib('goal_verify_runner.cjs');

function printHelp() {
  console.log([
    'Usage:',
    '  xoloop-verify create --target <path> --kind json-canonicalizer --goal-id <id> [--force]',
    '  xoloop-verify run <goal.yaml> [--case <id>] [--json]',
    '  xoloop-verify card <goal.yaml> [--json]',
  ].join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h') || argv.length === 0) {
    printHelp();
    process.exit(0);
  }
  const sub = argv[0];
  const json = hasFlag(argv, '--json');

  if (sub === 'create') {
    const result = createGoal({
      cwd: process.cwd(),
      target: parseFlag(argv, '--target', null),
      kind: parseFlag(argv, '--kind', 'json-canonicalizer'),
      goalId: parseFlag(argv, '--goal-id', 'json-canon-seed'),
      force: hasFlag(argv, '--force'),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Created goal: ${result.goalPath}`);
      console.log(`Manifest: ${result.manifest_hash}`);
    }
    return;
  }

  if (sub === 'run') {
    const goalPath = argv[1];
    if (!goalPath) throw new Error('xoloop-verify run requires <goal.yaml>');
    const { card } = await runGoalVerify(goalPath, {
      cwd: process.cwd(),
      caseId: parseFlag(argv, '--case', null),
    });
    if (json) console.log(JSON.stringify(card, null, 2));
    else console.log(formatVerifyCard(card));
    process.exit(card.verdict === 'FAIL' ? 1 : 0);
  }

  if (sub === 'card') {
    const goalPath = argv[1];
    if (!goalPath) throw new Error('xoloop-verify card requires <goal.yaml>');
    const card = buildVerifyCard(goalPath, { cwd: process.cwd() });
    if (json) console.log(JSON.stringify(card, null, 2));
    else console.log(formatVerifyCard(card));
    process.exit(card.verdict === 'FAIL' ? 1 : 0);
  }

  throw new Error(`unknown xoloop-verify subcommand: ${sub}`);
}

main().catch((err) => {
  console.error('[xoloop-verify] Fatal:', err.message || err);
  process.exit(1);
});
