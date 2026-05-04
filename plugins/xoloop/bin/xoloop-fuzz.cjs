#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  requireLib,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const { fuzzModule } = requireLib('fuzz_engine.cjs');

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage: xoloop-fuzz --module <path> [--runs 100] [--seed <int>] [--time-budget-ms <n>]');
    process.exit(0);
  }

  const modulePath = parseFlag(argv, '--module', null);
  const runs = Number(parseFlag(argv, '--runs', 100));
  const seedRaw = parseFlag(argv, '--seed', null);
  const timeBudgetRaw = parseFlag(argv, '--time-budget-ms', null);

  if (!modulePath) {
    console.error('[xoloop-fuzz] --module is required.');
    process.exit(1);
  }

  const absModule = path.resolve(modulePath);
  const options = { numRuns: runs };
  if (seedRaw !== null) options.seed = Number(seedRaw);
  if (timeBudgetRaw !== null) options.timeBudgetMs = Number(timeBudgetRaw);

  const result = fuzzModule(absModule, options);

  let totalRuns = 0;
  let totalCrashes = 0;
  const crashList = [];
  for (const [fnName, r] of Object.entries(result.results || {})) {
    totalRuns += (r.totalRuns || r.runs || 0);
    const crashes = Array.isArray(r.crashes) ? r.crashes : [];
    totalCrashes += crashes.length;
    for (const c of crashes) crashList.push({ fn: fnName, ...c });
  }

  console.log('\n=== Fuzz Summary ===');
  console.log(`Module:         ${absModule}`);
  console.log(`Functions:      ${Object.keys(result.results || {}).length}`);
  console.log(`Total runs:     ${totalRuns}`);
  console.log(`Crashes found:  ${totalCrashes}`);
  if (crashList.length > 0) {
    console.log('\nCrashes:');
    for (const c of crashList.slice(0, 10)) {
      // Crash shape per fuzz_engine: { input, error, shrunk }.
      // `error` may be an Error object, a message string, or a structured object.
      const errText = c.error instanceof Error
        ? `${c.error.name}: ${c.error.message}`
        : typeof c.error === 'string'
          ? c.error
          : (c.error && c.error.message)
            ? `${c.error.name || 'Error'}: ${c.error.message}`
            : JSON.stringify(c.error).slice(0, 120);
      console.log(`  ${c.fn}: ${errText}`);
    }
    if (crashList.length > 10) {
      console.log(`  ... and ${crashList.length - 10} more`);
    }
  }
  process.exit(totalCrashes > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-fuzz] Fatal:', err.message || err);
  process.exit(1);
});
