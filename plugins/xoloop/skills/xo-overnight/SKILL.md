---
name: xo-overnight
description: Use this skill when the user asks to run XOLoop unattended for a long period, chain multiple modes, do a full XO pipeline, or improve a codebase over a long session. Runs a subagent-driven orchestrator that chains polish + fuzz + benchmark + improve + audit phases, up to 50 total iterations across all phases. Not for a single mode (use the specific skill).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Overnight Mode (subagent-driven, long-horizon)

The long-running orchestrator. Chains multiple modes across multiple
surfaces in one invocation, budget-managed across the whole batch. Uses
subagents for all proposals (no API key required) — which means the
50-iteration cap is **per skill invocation's session budget**, not
true overnight running.

**Default operational mode — no API key required. 50 iterations total.**

For TRUE hands-off overnight-for-hours workflows, use EXTRA API-key
mode (`xoloop-overnight.cjs`) — that path has no session budget cap
and uses `runOvernightBatch` with worktree lifecycle + process-group
timeouts.

## When to invoke

- "run overnight"
- "do a full XO pipeline"
- "run the full loop"
- "chain polish and audit"
- "improve the codebase while I sleep" (with the caveat above)
- "run all modes on X"

For a single mode, route to the specific skill instead.

## How it runs

1. **Load config.** Read `overnight.yaml` for surface list,
   validation command, and phase selection. If no config, run
   `/xo-init` first.
2. **Budget allocation.** 50 iterations split across phases:
   - polish: 20
   - audit: 10
   - improve: 10
   - autoresearch: 5
   - fuzz: 3 (deterministic, fast)
   - benchmark: 2 (deterministic)
   Override via `--budget <phase>:<n>` pairs.
3. **For each configured surface, in order:**
   a. **Polish phase** — invoke `xo-polish` logic up to its budget
   b. **Fuzz phase** — invoke `xo-fuzz` (deterministic, budget ≈ 1)
   c. **Benchmark phase** — invoke `xo-benchmark` (deterministic,
      budget ≈ 1)
   d. **Improve phase** — invoke `xo-improve` logic up to its budget
   e. **Audit phase** — invoke `xo-audit` logic up to its budget
4. **Abort conditions:**
   - Any phase reports 3 consecutive rollbacks → stop that phase,
     move to next
   - Total iteration budget exhausted → stop pipeline
   - User interrupts → partial results still saved
5. **Report**: per-surface per-phase outcomes, iterations consumed,
   budget remaining (if any).

## Defaults

| Setting | Default |
|---|---|
| Total iterations | 50 across all phases |
| Per-phase budget | polish 20 / audit 10 / improve 10 / autoresearch 5 / fuzz 3 / benchmark 2 |
| Surface order | as listed in `overnight.yaml` |
| Parallelism | serialized (one surface at a time, one phase at a time) |

## What overnight does NOT do

- **Not a substitute for a single mode** — if user wants just polish,
  use `xo-polish`
- **Not for research from scratch** — use `xo-autoresearch` first, then
  overnight can polish the winner
- **Not a multi-hour true-overnight runner** inside a Claude session —
  the session budget caps this at ~50 iterations. For true overnight,
  use the EXTRA API-key mode below.

## EXTRA: API-key mode (true overnight batch)

For unattended multi-hour runs with worktree isolation and process-
group lifecycle management:

```bash
ANTHROPIC_API_KEY=... node $CLAUDE_PLUGIN_ROOT/bin/xoloop-overnight.cjs xo \
  --repo-root .
```

This uses `runOvernightBatch` — batch manifest, per-surface worktree,
SIGTERM + grace + SIGKILL process lifecycle, no session budget cap.
Runs for hours unattended.

## Safety

- Worktree isolation enforced for every mutating phase
- Per-repo write lock — only one overnight run at a time per repo
- Rollback on validation failure (every phase uses the same bridge
  as polish)
- Progress written to `.xoloop/runs/<batch-id>/progress.jsonl` — user
  can tail this to watch a long-running batch
