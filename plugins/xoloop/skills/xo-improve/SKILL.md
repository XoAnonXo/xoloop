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

## Verify / Discovery gate

Before any optimization round, run `xoloop-verify discover --write --json`
and select repo-specific suites from the detected frontend, api, state, function, runtime-lab, performance, formal,
cli, concurrency, state-machine, and safety surfaces. Use `performance-suite` for the metric plus the matching
behavior suite(s) for correctness. Start improving only when those goals
are `PASS_EVIDENCED`; `PASS_WITH_GAPS` requires accepted named gaps, and
`FAIL`/`NO_EVIDENCE` blocks optimization.

For broad objectives without a ready benchmark, generate the goal after
discovery:

```bash
xoloop-verify make-goal --objective "make backend cheaper/faster"
```

Use the generated suite goal to identify the metric, correctness suites,
accepted gaps, objective-specific bottleneck metrics, generated benchmark
harnesses, exact screen/API/function/state obligation chains, cost/APM/DB/
queue/infra inputs, and tradeoff policy. Behavior-changing cost savings are
proposal-only until the user accepts the tradeoff explicitly with
`xoloop-verify tradeoff <goal.yaml> --accept <id>`.

## How it runs

1. **Initialize the session** via
   `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-session.cjs init --mode improve
   --objective "<metric to improve>" --files "<paths>"`. Every round's
   metric measurement is persisted so the MAD-based confidence score
   (below) stabilizes as the session progresses.
2. **Verify benchmark exists.** If no benchmark defined, tell the user
   to run `/xo-benchmark create` first or switch to `/xo-polish` for
   open-ended refinement.
3. **Baseline run.** Execute the benchmark once, record the metric.
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
| Improvement threshold | MAD-based confidence ≥ 2.0× (pi-autoresearch pattern) |
| Benchmark | required (skill will refuse if none defined) |
| Validation | test command + benchmark command |

## MAD-based confidence (noise-aware)

After 3+ rounds, compute confidence via
`node $CLAUDE_PLUGIN_ROOT/bin/xoloop-session.cjs confidence --values "<csv>" --direction lower`.
Returns `{ confidence, color, bestImprovement, mad }`. Color meanings:
`green` (≥2.0× = likely real), `yellow` (1.0-2.0× = above noise but
marginal — re-run to confirm), `red` (<1.0× = within noise, discard
unless other evidence). **Advisory only** — the skill still decides
keep/discard, confidence is context for the decision.

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
