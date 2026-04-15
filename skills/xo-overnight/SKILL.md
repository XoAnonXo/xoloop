---
name: xo-overnight
description: Use this skill when the user asks to run XOLoop unattended overnight, do a full XO pipeline, chain multiple modes, or improve a codebase over a long session. Runs the orchestrator that chains build → polish → fuzz → benchmark → improve → audit across a batch of surfaces, with worktree isolation and per-repo locking. Not for a single mode (use the specific skill).
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Overnight Engine

The batch orchestrator. Chains multiple modes across multiple surfaces in one run. Handles worktree isolation, validation-command checks, verification manifests, argv-form command injection, batch lockfiles, worktree cleanup. This is what you invoke for an unattended overnight run.

## When to invoke

User says any of:
- "run overnight"
- "do a full XO pipeline"
- "run the full loop"
- "chain polish and audit"
- "improve the codebase while I sleep"
- "run all modes on X"

For a single mode, route to the specific skill instead.

## How to invoke

```bash
# Full pipeline on configured surfaces
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-overnight.cjs xo \
  --repo-root .

# Single surface, specific phases
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-overnight.cjs run \
  --surface <id> \
  --xo-phases "polish,audit,improve"

# Inspect a prior batch
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-overnight.cjs inspect \
  --batch-id <id>

# Promote an accepted batch
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-overnight.cjs promote \
  --batch-id <id>
```

### Prerequisites

- `overnight.yaml` + `objective.yaml` exist (run `xoloop-init` if not)
- Working tree clean OR dirty overlap with requested surfaces approved (D.1)
- Model credentials available (session or env; D.6)

### Long-running

Overnight runs commonly take 1-8 hours. ALWAYS invoke via Bash with `run_in_background: true`. Stream progress via returned shell ID. Poll with BashOutput; the engine writes structured progress to `.xoloop/runs/<batch-id>/progress.jsonl`.

## What overnight does NOT do

- **Not a substitute for a single mode** — if user wants just polish, use `xo-polish`
- **Not for research from scratch** — use `xo-autoresearch` first, then overnight can implement the winner

## Output

- Per-surface reports in `.xoloop/runs/<batch-id>/`
- Aggregate summary: surfaces attempted, landed, failed, tests added, audit findings closed
- Commit history on the worktree branch (not main) until promoted

## Safety

- Worktree isolation enforced (locked D.1)
- Per-repo write lock (locked D.5)
- Exclusive batch directory creation (`mkdirSync {recursive: false}`)
- Outer try/finally for worktree cleanup on any exit path
- Verification manifest (SHA-256) re-checked immediately before each write
