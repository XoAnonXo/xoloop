---
description: Turn a xoloop session's noisy branch into clean independent reviewable branches grouped by non-overlapping files.
---

Run xoloop-finalize on the current session.

Usage: `/xo-finalize [--base-ref <branch>] [--branch-prefix <prefix>]`

Steps:
1. Confirm `.xoloop/session.jsonl` exists and contains `outcome: keep` entries.
2. Run dry-run: `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-finalize.cjs --dry-run`
3. Show the JSON plan to the user. Describe each group: files, rounds, rationale, metric deltas.
4. Ask for approval. If user tweaks group boundaries, apply changes to the ledger before re-running.
5. On approval, run without `--dry-run`. Report branch names created.
6. Remind the user to push + open PRs manually.
