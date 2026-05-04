#!/usr/bin/env node
'use strict';

const I = require('./interval-set.cjs');

function usage() {
  return `Usage:
  node cli.cjs normalize <set>
  node cli.cjs complement <set>
  node cli.cjs measure <set>
  node cli.cjs contains <set> <integer>
  node cli.cjs union <set> <set>
  node cli.cjs intersect <set> <set>
  node cli.cjs diff <set> <set>
  node cli.cjs equals <set> <set>
  node cli.cjs subset <set> <set>

Set syntax: "lo..hi:" for empty, or "lo..hi:a..b,c,d..e".`;
}

function need(args, n) {
  if (args.length !== n) throw new I.IntervalSetError(`expected ${n} argument(s)\n${usage()}`);
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') return usage();

  switch (cmd) {
    case 'normalize': need(args, 1); return I.format(I.parse(args[0]));
    case 'complement': need(args, 1); return I.format(I.complement(I.parse(args[0])));
    case 'measure': need(args, 1); return String(I.measure(I.parse(args[0])));
    case 'contains': {
      need(args, 2);
      const n = Number(args[1]);
      return String(I.contains(I.parse(args[0]), n));
    }
    case 'union': need(args, 2); return I.format(I.union(I.parse(args[0]), I.parse(args[1])));
    case 'intersect': need(args, 2); return I.format(I.intersect(I.parse(args[0]), I.parse(args[1])));
    case 'diff': need(args, 2); return I.format(I.diff(I.parse(args[0]), I.parse(args[1])));
    case 'equals': need(args, 2); return String(I.equals(I.parse(args[0]), I.parse(args[1])));
    case 'subset': need(args, 2); return String(I.subset(I.parse(args[0]), I.parse(args[1])));
    default: throw new I.IntervalSetError(`unknown command: ${cmd}\n${usage()}`);
  }
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 2;
  }
}

module.exports = { main };
