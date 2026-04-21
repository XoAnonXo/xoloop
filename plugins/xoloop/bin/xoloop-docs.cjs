#!/usr/bin/env node
/**
 * xoloop-docs.cjs — thin CLI for docs mode.
 *
 * Subcommands:
 *   scan [--scope <dir>]       Emit JSON: { surfaceFiles, existingDocs,
 *                              publicSymbols[], undocumentedCount }
 *   validate --proposal <f>    Pre-check a proposal against docs gates
 *   run [--scope <dir>]        EXTRA API-key path: 3-round pipeline
 *
 * The skill (xo-docs) uses `scan` + the bridge's `--require-docs` flag.
 * The `run` subcommand is for CI / headless use.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const {
  requireLib,
  hasFlag,
  parseFlag,
} = require('./_common.cjs');

const docsEngine = requireLib('xo_docs_engine.cjs');

function printUsage() {
  console.log('Usage: xoloop-docs <subcommand> [options]');
  console.log('');
  console.log('Subcommands:');
  console.log('  scan [--scope <dir>]       Emit JSON scan of surface/docs/symbols');
  console.log('  validate --proposal <f>    Pre-check a proposal against docs gates');
  console.log('  run [--scope <dir>]        EXTRA 3-round pipeline (API-key required)');
  console.log('');
  console.log('Interactive (recommended): use the xo-docs skill inside Claude Code.');
}

function cmdScan(argv) {
  const scope = parseFlag(argv, '--scope', null);
  const root = scope ? path.resolve(process.cwd(), scope) : process.cwd();
  if (!fs.existsSync(root)) {
    console.error(`[xoloop-docs] scope not found: ${root}`);
    process.exit(1);
  }
  const surfaceFiles = docsEngine.discoverSurfaceFiles(root);
  const existingDocs = docsEngine.findExistingDocFiles(root);
  const publicSymbols = [];
  let undocumentedCount = 0;
  for (const rel of surfaceFiles) {
    const extracted = docsEngine.extractPublicSymbols(path.join(root, rel));
    if (extracted.symbols.length === 0) continue;
    publicSymbols.push({ file: rel, symbols: extracted.symbols });
    for (const sym of extracted.symbols) {
      if (!sym.existingDoc) undocumentedCount += 1;
    }
  }
  const result = {
    scope: path.relative(process.cwd(), root) || '.',
    surfaceFiles,
    existingDocs,
    publicSymbols,
    undocumentedCount,
    summary: {
      surfaceFileCount: surfaceFiles.length,
      existingDocCount: existingDocs.length,
      publicSymbolCount: publicSymbols.reduce((a, f) => a + f.symbols.length, 0),
      undocumentedCount,
    },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

function cmdValidate(argv) {
  const proposalPath = parseFlag(argv, '--proposal', null);
  if (!proposalPath) {
    console.error('[xoloop-docs] validate requires --proposal <file>');
    process.exit(1);
  }
  let proposal;
  try { proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8')); }
  catch (err) {
    console.error(`[xoloop-docs] failed to parse proposal: ${err.message}`);
    process.exit(1);
  }
  const verdict = docsEngine.validateDocsProposal(proposal);
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  process.exit(verdict.ok ? 0 : 2);
}

function cmdRun(argv) {
  const scope = parseFlag(argv, '--scope', '.');
  const proposerCommand = parseFlag(argv, '--proposer', null);
  if (!process.env.ANTHROPIC_API_KEY && !proposerCommand) {
    console.error('[xoloop-docs] run requires ANTHROPIC_API_KEY or --proposer <cmd>.');
    console.error('[xoloop-docs] For interactive use, invoke the xo-docs skill instead.');
    process.exit(1);
  }
  // 3-round pipeline: generate + polish + polish, each via polish_runner.
  const { parsePolishOptions, runPolishLoop } = requireLib('polish_runner.cjs');
  const { buildExternalProposalLoader } = require('./_common.cjs');
  const options = parsePolishOptions(['--surface', scope, '--rounds', '3']);
  options.mode = 'docs';
  options.perRoundValidator = async ({ proposal }) => {
    const gate = docsEngine.validateDocsProposal(proposal);
    if (!gate.ok) throw Object.assign(new Error(gate.reason), { code: 'DOCS_GATE' });
  };
  if (proposerCommand) {
    options.proposalLoader = buildExternalProposalLoader(proposerCommand, process.cwd());
  }
  runPolishLoop(options).then((summary) => {
    console.log(JSON.stringify({ mode: 'docs', ...summary }, null, 2));
    process.exit(summary.error ? 1 : 0);
  }).catch((err) => {
    console.error('[xoloop-docs] Fatal:', err.message || err);
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
  if (sub === 'scan') return cmdScan(rest);
  if (sub === 'validate') return cmdValidate(rest);
  if (sub === 'run') return cmdRun(rest);
  console.error(`[xoloop-docs] unknown subcommand: ${sub}`);
  printUsage();
  process.exit(1);
}

main();
