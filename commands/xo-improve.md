---
description: Iteratively improve code against a specific benchmark (faster, smaller, cheaper) until target met or saturation.
---

Run XOLoop improve against a benchmark.

Usage: `/xo-improve --benchmark <path> --surface <path> [--rounds 10]`

Steps:
1. If no benchmark exists, prompt user: "Create one via /xo-benchmark first, or switch to /xo-polish for open-ended refinement?"
2. Invoke `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-improve.cjs --benchmark <path> --surface <path> [flags]` via Bash with `run_in_background: true`.
3. Report metric history: baseline → per-round → final. Stop reasons: target met / saturated / degradation.
