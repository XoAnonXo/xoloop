#!/usr/bin/env node
'use strict';

const {
  requireLib,
  hasFlag,
  parseFlag,
} = require('./_common.cjs');

const {
  formatCompletenessReport,
  summarizeCompleteness,
} = requireLib('completeness_checker.cjs');
const { readLiveAgentEvidence } = requireLib('live_agent_provider.cjs');

function printHelp() {
  console.log(`Usage: xoloop-completeness [--json] [--allow-incomplete] [--require-live-agentic] [--live-agentic-evidence <jsonl>]

Checks whether every supported language has local adapter parity with JS/TS
across the 11 user-facing XOLoop modes. The report separately shows setup
coverage for init and live-agentic proof for
subagent/API-backed modes. Exits nonzero when adapter parity is incomplete,
or when --require-live-agentic is passed and live-agentic proof is incomplete,
unless --allow-incomplete is passed. Use --live-agentic-evidence to include
recorded provider calls from a subagent/API-backed run.`);
}

function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    printHelp();
    process.exit(0);
  }

  const evidencePath = parseFlag(argv, '--live-agentic-evidence', null);
  const liveAgenticEvidence = evidencePath ? readLiveAgentEvidence(evidencePath) : null;
  const summary = summarizeCompleteness({ liveAgenticEvidence });
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatCompletenessReport(summary));
  }

  const requireLiveAgentic = hasFlag(argv, '--require-live-agentic');
  const failed = requireLiveAgentic
    ? !summary.liveAgenticComplete
    : !summary.userModeComplete;

  if (failed && !hasFlag(argv, '--allow-incomplete')) {
    process.exit(1);
  }
}

main();
