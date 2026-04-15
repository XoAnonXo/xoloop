---
description: Iteratively polish existing code via tournament (Champion vs Challenger, Opus+Sonnet+Codex council). Loops until saturation or degradation.
---

Run XOLoop polish on the surface the user names.

Usage: `/xo-polish <surface-path> [--rounds N] [--until-saturated] [--dry-run]`

Steps:
1. If no `overnight.yaml` in current repo, run `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-init.cjs --dir .` first.
2. If this is the first polish invocation in this repo, add `--dry-run` by default (locked D.7).
3. Invoke `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-polish.cjs --surface <path> [flags]` via Bash with `run_in_background: true` for runs >5 rounds.
4. Stream progress. Report summary when done: rounds completed, proposals landed, saturation verdict.
