---
name: xo-overnight
description: Use this skill when the user asks to run XOLoop unattended for a long period, chain multiple modes, do a full XO pipeline, or improve a codebase over a long session. Runs a subagent-driven orchestrator that chains build + simplify + polish + fuzz + benchmark + improve + autoresearch + polish + audit + polish + docs phases, up to 80 total iterations across all phases. Not for a single mode (use the specific skill).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Overnight Mode (subagent-driven, long-horizon)

The long-running orchestrator. Chains all XOLoop modes across multiple
surfaces in one invocation, budget-managed across the whole batch. Uses
subagents for all proposals (no API key required) — which means the
80-iteration cap is **per skill invocation's session budget**, not
true overnight running.

**Default operational mode — no API key required. 80 iterations total.**

For TRUE hands-off overnight-for-hours workflows, use EXTRA API-key
mode (`xoloop-overnight.cjs`) — that path has no session budget cap
and uses `runOvernightBatch` with worktree lifecycle + process-group
timeouts.

## When to invoke

- "run overnight"
- "do a full XO pipeline"
- "run the full loop"
- "chain simplify and polish and audit"
- "improve the codebase while I sleep" (with the caveat above)
- "run all modes on X"

For a single mode, route to the specific skill instead.

## Verify / Discovery gate

Start every overnight run with `xoloop-verify discover --write --json`
and create/run the repo-specific suite mix for detected frontend, api,
state, function, runtime-lab, performance, formal, cli, concurrency,
state-machine, and safety surfaces. The mutating phases (simplify, polish,
improve, autoresearch, audit, and docs touching source docblocks) require
`PASS_EVIDENCED` for their relevant goals. `PASS_WITH_GAPS` is allowed
only when the user accepts named gaps; unaccepted gaps, `FAIL`, or
`NO_EVIDENCE` skip the risky phase instead of spending overnight budget.

## The 11-phase pipeline

Runs phases in order, per surface. Default rounds chosen from experience
(see the budget table below). Every round that fails test gate OR its
mode-specific gate is automatically rolled back.

| # | Phase | Rounds | Purpose |
|---|---|---|---|
| 1 | build | 3 | If surface doesn't exist yet: TDD spec + impl + quick refactor |
| 2 | **simplify** | **8** | Delete over-engineering from the first draft while it's warm |
| 3 | polish | 11 | First cleanup pass — tighten what survived |
| 4 | fuzz | det (150 trials) | Property-based edge-case discovery |
| 5 | bench | det (8 samples) | Baseline perf — 1.5× samples for better MAD noise floor |
| 6 | improve | 11 | Benchmark-driven optimization |
| 7 | autoresearch | 8 | Champion-vs-Challenger alternative search |
| 8 | polish | 8 | Clean up after improve's perf scars |
| 9 | audit | 11 | Find P1/P2/P3 |
| 10 | polish | 5 | Clean audit fixes |
| 11 | **docs** | **3** | 1 generate + 2 polish passes, whole repo |

**Total LLM rounds: 68. Budget: 80. Headroom: 12 for phase overflow.**

## How it runs (step-by-step)

1. **Load config.** Read `overnight.yaml` for surface list, validation
   command, phase selection, and per-phase budget overrides. If no
   config, run `/xo-init` first.

2. **Check preconditions per surface:**
   - If surface does not exist → start at `build` phase
   - If surface exists but no tests → inject build phase first
   - If surface exists with tests → start at `simplify`

3. **Budget allocation** (80 iterations, overrides via `--budget
   <phase>:<n>` pairs):

   | Phase | Default rounds |
   |---|---|
   | build | 3 |
   | simplify | 8 |
   | polish (3 instances) | 11 + 8 + 5 = 24 |
   | fuzz | deterministic |
   | bench | deterministic |
   | improve | 11 |
   | autoresearch | 8 |
   | audit | 11 |
   | docs | 3 |
   | **Total** | **68 LLM rounds** (+ 12 headroom) |

4. **For each configured surface, in order, run all applicable phases:**

   a. **Build phase** (only if surface is new) — invoke `xo-build`
      subagents (spec + impl + quick refactor)
   b. **Simplify phase** — invoke `xo-simplify` logic. Subagents delete
      abstractions, gates refuse tests/exports, metric-gated rollback
   c. **Polish phase #1** — invoke `xo-polish` up to 11 rounds
   d. **Fuzz phase** — invoke `xo-fuzz` deterministic, 150 trials
   e. **Benchmark phase** — invoke `xo-benchmark` deterministic,
      8-sample baseline
   f. **Improve phase** — invoke `xo-improve` benchmark-gated, 11 rounds
   g. **Autoresearch phase** — `xo-autoresearch` tournament, 8 rounds
   h. **Polish phase #2** — 8 rounds cleanup after improve
   i. **Audit phase** — `xo-audit` 11 rounds, P1/P2/P3 fix loop
   j. **Polish phase #3** — 5 rounds cleanup after audit
   k. **Docs phase** — `xo-docs` 3 rounds (generate + polish + polish),
      whole-repo scope

5. **Abort conditions:**
   - Any phase reports 3 consecutive rollbacks → stop that phase, move
     to next
   - Total iteration budget exhausted → stop pipeline
   - Metric gate (simplify/improve) reports 2 consecutive regressions →
     stop that phase
   - User interrupts → partial results still saved

6. **Report**: per-surface per-phase outcomes, iterations consumed,
   total complexity delta (from simplify), perf delta (from improve),
   doc coverage delta (from docs), session.md path.

## Defaults

| Setting | Default |
|---|---|
| Total iterations | **80** across all phases |
| Surface order | as listed in `overnight.yaml` |
| Parallelism | serialized (one surface at a time, one phase at a time) |
| First run per repo | dry-run preview (see Safety) |

## Why this ordering

- **simplify before polish**: deletion-before-refinement means polish
  doesn't beautify dead code
- **polish after improve**: perf optimizations leave ugly scars
- **polish after audit**: fixes leave patches
- **autoresearch after improve**: only meaningful once code is already
  fast enough to care
- **audit late**: finds real bugs in mature code, not draft bugs
- **docs last**: docs describe the final API, not the draft API

## What overnight does NOT do

- **Not a substitute for a single mode** — if user wants just polish,
  use `xo-polish`
- **Not a multi-hour true-overnight runner** inside a Claude session —
  the session budget caps this at ~80 iterations. For true overnight,
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
Runs for hours unattended. Note: the engine-mode CLI supports the
6-phase pipeline (build/polish/fuzz/benchmark/improve/finalPolish) at
time of writing; the full 11-phase pipeline runs through the skill
subagent path above. Extension to the engine-mode orchestrator is
tracked as v0.4 work.

## Safety

- Worktree isolation enforced for every mutating phase
- Per-repo write lock — only one overnight run at a time per repo
- Rollback on validation failure (every phase uses the same bridge
  as polish)
- Simplify + docs phases have additional pre-apply gates (test-file
  refusal, exported-symbol refusal, docblock-only edit enforcement)
- Progress written to `.xoloop/runs/<batch-id>/progress.jsonl` — user
  can tail this to watch a long-running batch
