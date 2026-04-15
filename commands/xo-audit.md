---
description: Audit existing code for bugs via Codex auditor + Opus fixer loop. Runs until only low-severity findings remain.
---

Run XOLoop audit on the target the user names.

Usage: `/xo-audit <path-or-dir> [--severity-floor P2] [--read-only]`

Steps:
1. If no `overnight.yaml`, run init first.
2. If user wants to see findings before fixes, add `--read-only` flag.
3. Invoke `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-audit.cjs --target <path> [flags]` via Bash with `run_in_background: true`.
4. Report findings grouped by severity, and any fixes applied per round.
