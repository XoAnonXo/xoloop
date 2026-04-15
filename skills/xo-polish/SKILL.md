---
name: xo-polish
description: Use this skill when the user asks to polish, refine, optimize, clean up, tighten, iterate on, or make better any EXISTING code. Runs a tournament-based refinement loop (Champion vs Challenger, Opus+Sonnet+Codex council, 1-5 anchored rubric, naked AST judging) until saturation or degradation. Not for writing new code from scratch (use xo-build), not for finding bugs (use xo-audit), not for making code faster per a specific benchmark (use xo-improve).
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Polish Mode

Iteratively refines existing code via tournament. Champion (current impl) vs Challenger (proposed alternative) judged by heterogeneous council. Loops until no proposal wins twice in a row, or until a degradation signal fires.

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

## How to invoke

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-polish.cjs \
  --surface <path> \
  --rounds <N> \
  [--until-saturated] \
  [--dry-run]
```

### First invocation in a foreign repo

If no `overnight.yaml` exists, the wrapper auto-delegates to `xoloop-init` first, then proceeds. Per locked decision D.7, the FIRST invocation per repo runs with `--dry-run` by default; user confirms the changeset before applying.

### Arguments to pass

| Arg | Source |
|---|---|
| `--surface` | File path user named, or inferred from current selection |
| `--rounds` | User-specified N; default 10 |
| `--until-saturated` | Pass if user said "until saturation" / "until diminishing returns" |
| `--dry-run` | Auto-on for first run per repo (locked D.7) |

### Long-running invocation

Polish loops can run 10-60+ minutes. Use `run_in_background: true` when invoking via Bash tool. Stream progress via the returned shell ID.

## What polish does NOT do

- **Not for new features** → route to `xo-build`
- **Not for bug hunting** → route to `xo-audit`
- **Not for perf against a specific benchmark** → route to `xo-improve`
- **Not for "find alternative implementations"** → route to `xo-autoresearch`

## Output

- Changeset applied atomically via temp-file-stage + rename (verificationManifest TOCTOU-protected)
- Tournament log in `.xoloop/runs/<timestamp>/polish.log`
- Summary: rounds completed, proposals landed, saturation verdict

## Safety

- Runs in `git worktree` (locked D.1). If dirty changes overlap surface, refuses unless user confirms snapshot.
- Respects `.gitignore` + `.xoloop-ignore`.
- Never touches untracked files unless in surface (locked D.2).
