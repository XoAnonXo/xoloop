---
description: Research alternative implementations via Champion vs Challenger tournament with heterogeneous council.
---

Run XOLoop autoresearch on the target the user names.

Usage: `/xo-autoresearch <target-path> [--rounds 5] [--token-cap normal|strategic|override]`

Steps:
1. If target touches crypto / auth / schemas / migrations / public_api, warn user that auto-apply is disabled for sensitive domains — council result routes to human approval queue.
2. Invoke `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-autoresearch.cjs --target <path> [flags]` via Bash with `run_in_background: true` (research runs typically 10-60 min).
3. Report: convergence verdict, winning implementation (Champion or Challenger), evidence packet path.
