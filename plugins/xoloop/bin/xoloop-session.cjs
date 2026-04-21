#!/usr/bin/env node
/**
 * xoloop-session.cjs — CLI wrapper for session-file management.
 *
 * Subcommands:
 *   init      — create session.md + session.jsonl for a new run
 *   append    — append a ledger entry (JSON on stdin or --entry-file)
 *   read-doc  — print the session.md to stdout
 *   read-ledger — print the session.jsonl to stdout
 *   tried     — append a bullet to "What's Been Tried"
 *   idea      — append an idea to .xoloop/ideas.md
 *   ideas     — list ideas
 *   confidence — compute confidence from a metric sequence
 *
 * The skills invoke these subcommands via Bash to persist session state
 * across subagent rounds — the state survives context resets and can be
 * read by a fresh subagent resuming the same session.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  requireLib,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const session = requireLib('xoloop_session.cjs');

function parseJSON(raw, label) {
  try { return JSON.parse(raw); }
  catch (err) {
    console.error(`[xoloop-session] invalid JSON in ${label}: ${err.message}`);
    process.exit(1);
  }
}

function readEntryInput(argv) {
  const entryFile = parseFlag(argv, '--entry-file', null);
  if (entryFile) return fs.readFileSync(path.resolve(entryFile), 'utf8');
  return fs.readFileSync(0, 'utf8');
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log('Usage:');
    console.log('  xoloop-session init --mode <name> --objective "<text>" [--files "a,b,c"] [--constraints "<text>"]');
    console.log('  xoloop-session append          (JSON on stdin or --entry-file)');
    console.log('  xoloop-session read-doc');
    console.log('  xoloop-session read-ledger');
    console.log('  xoloop-session tried --bullet "<text>"');
    console.log('  xoloop-session idea "<text>"');
    console.log('  xoloop-session ideas');
    console.log('  xoloop-session confidence --values "1.0,1.1,0.9,0.85,0.88" [--direction lower|higher]');
    process.exit(0);
  }

  const cwd = parseFlag(argv, '--cwd', process.cwd());
  const rest = argv.slice(1);

  if (sub === 'init') {
    const mode = parseFlag(rest, '--mode', 'polish');
    const objective = parseFlag(rest, '--objective', '');
    const filesRaw = parseFlag(rest, '--files', '');
    const constraints = parseFlag(rest, '--constraints', '');
    const filesInScope = filesRaw ? filesRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const result = session.initSession(cwd, { mode, objective, filesInScope, constraints });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (sub === 'append') {
    const raw = readEntryInput(rest);
    const entry = parseJSON(raw, 'entry');
    const persisted = session.appendLedgerEntry(cwd, entry);
    console.log(JSON.stringify(persisted, null, 2));
    process.exit(0);
  }

  if (sub === 'read-doc') {
    const doc = session.readSessionDoc(cwd);
    if (doc === null) {
      console.error('[xoloop-session] no session.md — run `xoloop-session init` first.');
      process.exit(1);
    }
    process.stdout.write(doc);
    process.exit(0);
  }

  if (sub === 'read-ledger') {
    const entries = session.readLedger(cwd);
    console.log(JSON.stringify(entries, null, 2));
    process.exit(0);
  }

  if (sub === 'tried') {
    const bullet = parseFlag(rest, '--bullet', '');
    if (!bullet) {
      console.error('[xoloop-session] tried requires --bullet "<text>".');
      process.exit(1);
    }
    session.appendToTried(cwd, bullet);
    console.log(JSON.stringify({ ok: true }, null, 2));
    process.exit(0);
  }

  if (sub === 'idea') {
    const idea = rest.filter((a) => !a.startsWith('--')).join(' ');
    if (!idea) {
      console.error('[xoloop-session] idea requires a positional text argument.');
      process.exit(1);
    }
    session.appendIdea(cwd, idea);
    console.log(JSON.stringify({ ok: true }, null, 2));
    process.exit(0);
  }

  if (sub === 'ideas') {
    console.log(JSON.stringify(session.listIdeas(cwd), null, 2));
    process.exit(0);
  }

  if (sub === 'confidence') {
    const valuesRaw = parseFlag(rest, '--values', '');
    const direction = parseFlag(rest, '--direction', 'lower');
    const values = valuesRaw.split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
    const score = session.computeConfidence(values, { direction });
    console.log(JSON.stringify(score, null, 2));
    process.exit(0);
  }

  console.error(`[xoloop-session] unknown subcommand: ${sub}`);
  process.exit(1);
}

main();
