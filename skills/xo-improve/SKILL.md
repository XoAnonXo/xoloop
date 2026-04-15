---
name: xo-improve
description: Use this skill when the user asks to improve code AGAINST A SPECIFIC BENCHMARK — make it faster, reduce memory, lower cost, match a target metric. Runs benchmark-driven iteration picking what to fix based on metric gaps. Not for open-ended refinement (use xo-polish), not for finding bugs (use xo-audit), not for building new features (use xo-build).
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Improve Mode

Closes the loop between benchmark and refinement. The benchmark defines "better" objectively (faster, smaller, cheaper); improve iterates on the surface driving specifically toward that metric, validated each round.

## When to invoke

User says any of:
- "make X faster"
- "reduce memory of Y"
- "lower cost of Z"
- "hit this benchmark target"
- "improve performance"
- "optimize for <metric>"
- "beat this baseline"

Distinguish from `xo-polish`: polish is open-ended refinement; improve requires a benchmark that defines the target.

## How to invoke

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-improve.cjs \
  --benchmark <path/to/benchmark.yaml> \
  --surface <path> \
  [--rounds 10] \
  [--target-metric duration_ms] \
  [--target-value 100]
```

### If no benchmark exists yet

Wrapper prompts user: "No benchmark defined. Run `xo-benchmark create` first, or switch to `xo-polish` for open-ended refinement?"

## What improve does NOT do

- **Not for open-ended polish** → route to `xo-polish`
- **Not for finding bugs** → route to `xo-audit`
- **Not for new features** → route to `xo-build`

## Output

- Changeset applied atomically per round; benchmark re-run after each
- Metric history in `.xoloop/runs/<timestamp>/improve.json`
- Stops on: target met, saturation, degradation (benchmark broke)

## Safety

- Runs in worktree (locked D.1)
- Per-repo lock (locked D.5 — write mode)
- Rolls back any round that breaks the benchmark
