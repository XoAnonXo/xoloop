---
name: xo-polish
description: Use this skill when the user asks to polish, refine, optimize, clean up, tighten, iterate on, or make better any EXISTING code. Runs a subagent-driven refinement loop — spawns 7 Agent subagents by default, each proposes one changeSet refinement, applies atomically with test-gated rollback, keeps improvements, discards regressions. Not for writing new code from scratch (use xo-build), not for finding bugs (use xo-audit), not for benchmark-driven perf work (use xo-improve).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Polish Mode (subagent-driven)

Iteratively refines existing code via **subagent proposals**. Each round
spawns a dedicated Agent subagent that reads the current target, returns a
JSON changeSet proposing one refinement, which the engine applies
atomically with test-gated rollback. Keep improvements, discard
regressions.

**This is the default operational mode.** No API key required — the
proposer IS the Claude subagent you spawn.

## When to invoke

User says any of:
- "polish this"
- "clean up X"
- "refine the Y function"
- "tighten this module"
- "iterate on this"
- "make this better"
- "optimize this code"
- "improve the readability of"

## How it runs (step-by-step)

1. **Read the target file(s).** Get the current text into your context.
2. **Discover the validation command.** Look at the repo's `overnight.yaml`
   if it exists; otherwise ask the user or default to something sensible
   for the stack (`npm test`, `pytest`, `cargo test`).
3. **Loop N rounds** (default: **7**). Each round:
   a. **Spawn a subagent** with Agent tool, subagent_type `general-purpose`.
      Give it:
      - The current file content (from step 1 or the previous round's result)
      - A clear refinement objective: "Propose ONE refinement that makes
        this code tighter/clearer/more consistent without changing external
        behavior. Return ONLY a JSON object matching the schema below."
      - The proposal JSON schema (see below)
   b. **Extract the proposal JSON** from the subagent's response. Write it
      to a temp file.
   c. **Apply via the bridge.** Shell out (via Bash):
      ```
      node $CLAUDE_PLUGIN_ROOT/bin/xoloop-apply-proposal.cjs \
        --proposal-file /tmp/xoloop-round-N.json \
        --allowed-paths "<target-path>" \
        --validate "<test command from step 2>"
      ```
   d. **Read the bridge report** (one JSON line on stdout). Outcomes:
      - `applied:true, validated:true, rolledBack:false` → **keep**, re-read
        target for next round (it changed on disk)
      - `applied:true, validated:false, rolledBack:true` → **regression**,
        file is back to pre-round state, log and continue
      - `applied:false` → proposal was malformed or out of scope, log and
        continue
   e. **Stop-early signals:**
      - Saturated: 2 consecutive rounds with no applied changes
      - Degraded: 2 consecutive rollbacks
4. **Report to the user**: rounds run, proposals landed, rollbacks, final
   target state.

## Proposal JSON schema

The subagent must return:

```json
{
  "rationale": "one sentence explaining why this change is safe and useful",
  "changeSet": [
    {
      "kind": "replace_once",
      "path": "relative/path/from/repo/root.js",
      "match": "exact substring that must appear once",
      "replace": "new substring"
    }
  ]
}
```

Valid `kind` values: `replace_once`, `create_file` (use `content` instead
of `match`/`replace`), `delete_file` (no content).

`match` must be an exact substring of the current file — the engine
rejects proposals where `match` appears zero times or more than once. Keep
it long enough to be unique.

## Defaults

| Setting | Default |
|---|---|
| Iterations | 7 |
| Validation | `npm test` / `pytest` / `cargo test` (detected from repo) |
| Allowed paths | just the target file |
| First run per repo | dry-run preview (see Safety) |

## Arguments to pass

| Arg | Default |
|---|---|
| `--rounds N` | 7 (override to any N between 1 and 50) |
| surface/target | the path user named, or inferred from selection |

## What polish does NOT do

- **Not for new features** → route to `xo-build`
- **Not for bug hunting** → route to `xo-audit`
- **Not for perf against a specific benchmark** → route to `xo-improve`
- **Not for "find alternative implementations"** → route to `xo-autoresearch`

## EXTRA: API-key proposer (headless / CI / overnight)

For unattended runs where no Claude session is available, the framework
supports calling an external model API directly. Set
`ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) in the environment and invoke
the engine-mode wrapper:

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-polish.cjs \
  --surface <path> --rounds <N>
```

The wrapper also accepts `--proposer <shell-command>` to route proposals
through any binary that reads a prompt on stdin and returns JSON on
stdout. This path is EXTRA — use it when there's no Claude subagent
available (overnight, CI, headless-server scenarios). For interactive
use inside Claude Code, the subagent-driven path above is the default.

## Safety

- Every apply is atomic (temp+rename) with verificationManifest TOCTOU gate
- Validation-failed changesets auto-rollback via snapshot
- Allowed-paths allowlist enforced by `change_set_engine` realpath check
- Respects `.gitignore` + `.xoloop-ignore` (engine defense-in-depth)
- First run per repo: default to `--rounds 1` and treat as preview —
  the subagent proposes once, you show the user the diff, they approve
  before you run the full 7
