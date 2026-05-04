#!/usr/bin/env node
'use strict';

const {
  requireLib,
  ensureConfig,
  hasFlag,
} = require('./_common.cjs');

const { parseBuildCommand, runBuildCommand } = requireLib('build_runner.cjs');

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage:');
    console.log('  xoloop-build run <feature.yaml> [--adapter <path>]');
    console.log('  xoloop-build review <featureId>');
    console.log('  xoloop-build promote <featureId>');
    process.exit(0);
  }

  const cwd = process.cwd();
  ensureConfig(cwd);

  const cmd = parseBuildCommand(argv);
  if (!cmd.command) {
    console.error('[xoloop-build] error: no subcommand (run | review | promote).');
    process.exit(1);
  }

  const result = await runBuildCommand(cmd);
  if (cmd.command === 'review' && result && result.featureId) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result);
  }
  process.exit(result && result.error ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-build] Fatal:', err.message || err);
  process.exit(1);
});
