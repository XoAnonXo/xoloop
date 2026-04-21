#!/usr/bin/env node
/**
 * xoloop-simplify.cjs — thin CLI for simplify mode.
 *
 * Subcommands:
 *   measure --files <csv>     Print baseline {sloc, cyclomatic, exports} per file
 *   validate --proposal <f>   Pre-check a proposal against simplify gates
 *   run --surface <path>      EXTRA API-key path: spawn the engine loop
 *                             (needs ANTHROPIC_API_KEY or --proposer)
 *
 * The skill (xo-simplify) uses `measure` + `validate` + the bridge's
 * `--require-simplify` flag. The `run` subcommand is for CI / headless
 * / true-overnight use.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const {
  requireLib,
  hasFlag,
  parseFlag,
} = require('./_common.cjs');

const simplifyEngine = requireLib('xo_simplify_engine.cjs');

function printUsage() {
  console.log('Usage: xoloop-simplify <subcommand> [options]');
  console.log('');
  console.log('Subcommands:');
  console.log('  measure --files <csv>       Emit {sloc,cyclomatic,exports} per file');
  console.log('  validate --proposal <f>     Pre-check a proposal against simplify gates');
  console.log('  run --surface <path>        EXTRA engine-mode loop (API-key required)');
  console.log('');
  console.log('Interactive (recommended): use the xo-simplify skill inside Claude Code.');
}

function cmdMeasure(argv) {
  const filesCsv = parseFlag(argv, '--files', null);
  if (!filesCsv || typeof filesCsv !== 'string') {
    console.error('[xoloop-simplify] measure requires --files "<comma-separated paths>"');
    process.exit(1);
  }
  const rels = filesCsv.split(',').map((s) => s.trim()).filter(Boolean);
  const result = { total: { sloc: 0, cyclomatic: 0, exports: 0 }, perFile: {} };
  for (const rel of rels) {
    const absolutePath = path.resolve(process.cwd(), rel);
    const metric = simplifyEngine.measureComplexity(absolutePath);
    result.perFile[rel] = metric;
    result.total.sloc += metric.sloc;
    result.total.cyclomatic += metric.cyclomatic;
    result.total.exports += metric.exports;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

function cmdValidate(argv) {
  const proposalPath = parseFlag(argv, '--proposal', null);
  if (!proposalPath) {
    console.error('[xoloop-simplify] validate requires --proposal <file>');
    process.exit(1);
  }
  let proposal;
  try { proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8')); }
  catch (err) {
    console.error(`[xoloop-simplify] failed to parse proposal: ${err.message}`);
    process.exit(1);
  }
  const verdict = simplifyEngine.validateSimplifyProposal(proposal, process.cwd());
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  process.exit(verdict.ok ? 0 : 2);
}

function cmdRun(argv) {
  // EXTRA API-key path. Requires either ANTHROPIC_API_KEY in env or
  // --proposer shell-command. Delegates to polish_runner with simplify
  // gates overlaid — implementation lives in lib/ so tests can exercise
  // it headlessly.
  const surface = parseFlag(argv, '--surface', null);
  const rounds = parseInt(parseFlag(argv, '--rounds', '8'), 10);
  const proposerCommand = parseFlag(argv, '--proposer', null);
  if (!surface) {
    console.error('[xoloop-simplify] run requires --surface <path>');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY && !proposerCommand) {
    console.error('[xoloop-simplify] run requires ANTHROPIC_API_KEY or --proposer <cmd>.');
    console.error('[xoloop-simplify] For interactive use, invoke the xo-simplify skill instead.');
    process.exit(1);
  }
  // Reuse polish runner semantics but overlay simplify gates.
  const { parsePolishOptions, runPolishLoop } = requireLib('polish_runner.cjs');
  const { buildExternalProposalLoader } = require('./_common.cjs');
  const options = parsePolishOptions(['--surface', surface, '--rounds', String(rounds)]);
  options.mode = 'simplify';
  options.perRoundValidator = async ({ proposal, repoRoot }) => {
    const gate = simplifyEngine.validateSimplifyProposal(proposal, repoRoot || process.cwd());
    if (!gate.ok) throw Object.assign(new Error(gate.reason), { code: 'SIMPLIFY_GATE' });
  };
  if (proposerCommand) {
    options.proposalLoader = buildExternalProposalLoader(proposerCommand, process.cwd());
  }
  runPolishLoop(options).then((summary) => {
    console.log(JSON.stringify({ mode: 'simplify', ...summary }, null, 2));
    process.exit(summary.error ? 1 : 0);
  }).catch((err) => {
    console.error('[xoloop-simplify] Fatal:', err.message || err);
    process.exit(1);
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h') || argv.length === 0) {
    printUsage();
    process.exit(0);
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'measure') return cmdMeasure(rest);
  if (sub === 'validate') return cmdValidate(rest);
  if (sub === 'run') return cmdRun(rest);
  console.error(`[xoloop-simplify] unknown subcommand: ${sub}`);
  printUsage();
  process.exit(1);
}

main();
