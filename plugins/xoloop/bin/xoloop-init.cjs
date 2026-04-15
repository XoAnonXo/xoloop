#!/usr/bin/env node
/**
 * xoloop-init.cjs — Foreign-repo bootstrap wrapper.
 *
 * Per locked B.1 (Option 3 + repair loop): inspect the repo, draft config,
 * interrupt ONLY on ambiguity. Delegates to the framework's own init_generator
 * which already implements the detection logic.
 */

'use strict';

const path = require('node:path');
const { requireLib } = require('./_common.cjs');

const { runInit } = requireLib('init_generator.cjs');

function parseArgs(argv) {
  const options = { dir: process.cwd(), force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      options.dir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--force') {
      options.force = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: xoloop-init [--dir <path>] [--force]');
      console.log('');
      console.log('Scans a repo and generates overnight.yaml + objective.yaml.');
      console.log('Runs automatically on first invocation of any other xoloop-* command.');
      process.exit(0);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`[xoloop-init] Scanning ${options.dir}...\n`);
  try {
    const result = runInit(options.dir, { force: options.force });
    console.log(result.summary);
    console.log('\n[xoloop-init] Ready. Next: run any /xo-* command.');
    process.exit(0);
  } catch (err) {
    console.error(`[xoloop-init] Error: ${err.message}`);
    if (err.fixHint) console.error(`[xoloop-init] Hint: ${err.fixHint}`);
    process.exit(1);
  }
}

main();
