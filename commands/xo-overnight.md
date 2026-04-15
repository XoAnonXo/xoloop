---
description: Run the full XO pipeline overnight — chains polish, fuzz, benchmark, improve, audit across configured surfaces.
---

Run XOLoop overnight engine.

Usage:
- `/xo-overnight` — run full XO on all configured surfaces
- `/xo-overnight --surface <id> --xo-phases "polish,audit"` — single surface, specific phases
- `/xo-overnight inspect --batch-id <id>` — review a prior batch
- `/xo-overnight promote --batch-id <id>` — promote accepted batch

Steps:
1. Verify `overnight.yaml` + `objective.yaml` exist; if not, run init first.
2. Check working tree cleanliness. If dirty, ask user whether dirty changes should be included in the worktree snapshot.
3. Invoke `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-overnight.cjs xo --repo-root .` with `run_in_background: true`. MUST be background — overnight runs are 1-8 hours.
4. Return shell ID to user. Tell them to check progress with BashOutput or watch `.xoloop/runs/<batch-id>/progress.jsonl`.
