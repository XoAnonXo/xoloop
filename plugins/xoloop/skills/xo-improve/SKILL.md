---
name: xo-improve
description: Use this skill when the user asks to improve code AGAINST A SPECIFIC BENCHMARK — make it faster, reduce memory, lower cost, hit a target metric. Runs a subagent-driven iteration loop — each round a subagent proposes an optimization, the benchmark runs (not the test suite), keeps if metric improves without regressing correctness. Default 7 iterations. Not for open-ended refinement (use xo-polish), not for finding bugs (use xo-audit).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Improve Mode (subagent-driven)

Benchmark-driven optimization via subagents. Unlike polish (which uses
the test suite as gate), improve uses a **benchmark run** as the
improvement signal. The benchmark measures the metric the user cares
about (latency, memory, cost, throughput).

**Default operational mode — no API key required.**

## When to invoke

- "make X faster"
- "reduce memory of Y"
- "lower cost of Z"
- "hit this benchmark target"
- "improve performance"
- "optimize for <metric>"
- "beat this baseline"

## How it runs

1. **Verify benchmark exists.** If no benchmark defined, tell the user
   to run `/xo-benchmark create` first or switch to `/xo-polish` for
   open-ended refinement.
2. **Baseline run.** Execute the benchmark once, record the metric.
3. **Loop N rounds** (default: **7**):
   a. Spawn a subagent. Give it:
      - Current target file content
      - Baseline metric value
      - Prior rounds' attempted proposals and their metric outcomes
        (so it doesn't repeat rejected ideas)
      - Request: "Propose ONE optimization that reduces
        `<metric>` without regressing test correctness. Return a
        changeSet JSON."
   b. Apply via
      `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-apply-proposal.cjs` with
      `--validate "<test-command> && <benchmark-command>"`
   c. Read bridge report PLUS re-run benchmark, compare to baseline:
      - Metric improved ≥ threshold (default 3%) AND tests pass → **keep**,
        update baseline to new value
      - Metric improved < threshold OR regressed → **rollback** via
        the bridge (validation-gate already handles this, but we also
        rollback on non-improving changes the bridge considered "passed")
      - Tests broke → rollback (bridge handles automatically)
   d. Stop if 2 consecutive no-improvement rounds (saturation).
4. **Report**: baseline metric, final metric, improvement %, rounds
   kept/rolled-back, final implementation summary.

## Proposal schema

Same as xo-polish — `{rationale, changeSet: [...]}`. The rationale field
is especially important here; the next round's subagent reads prior
rationales to avoid repeating ideas.

## Defaults

| Setting | Default |
|---|---|
| Iterations | 7 |
| Improvement threshold | 3% over baseline |
| Benchmark | required (skill will refuse if none defined) |
| Validation | test command + benchmark command |

## What improve does NOT do

- **Not for open-ended polish** → `xo-polish`
- **Not for bug finding** → `xo-audit`
- **Not for new features** → `xo-build`

## EXTRA: API-key mode

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-improve.cjs \
  --benchmark <path> --surface <path> --rounds 10
```
Uses `runImproveLoop` with Opus + Sonnet proposers via API.

## Safety

- Per-round metric measurement with statistical guard (default 3
  consecutive runs, take median)
- Regression auto-rollback via bridge
- Benchmark's own SHA-256 output gate catches behavior changes
