---
name: xo-audit
description: Use this skill when the user asks to audit, review, find bugs, security-check, or validate the correctness of existing code. Runs an audit→fix loop — Codex GPT 5.4 X High auditor finds P1/P2/P3/low findings, Opus fixer produces a changeSet, engine applies and re-audits until only low findings remain. Not for refining well-working code (use xo-polish), not for performance (use xo-improve).
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Audit Mode

Closed-loop bug hunt. Heterogeneous auditor + fixer, severity-filtered, fails closed on protocol drift. Designed to find classes of bug that polish and fuzz don't — missing checks, contract violations, TOCTOU races, forgotten edge cases.

## When to invoke

User says any of:
- "audit this"
- "find bugs in X"
- "security review Y"
- "check Z for vulnerabilities"
- "is this code correct?"
- "what could go wrong with this?"
- "review this for issues"

## How to invoke

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-audit.cjs \
  --target <path-or-dir> \
  [--severity-floor P2] \
  [--max-rounds 10] \
  [--read-only]
```

### Audit modes

- **Read-only mode (`--read-only`)** — Codex finds and reports, Opus doesn't apply fixes. User reviews findings before deciding to fix. Locked as per-worktree (D.5) since it doesn't write.
- **Apply mode (default)** — full loop: audit → fix → apply → re-audit. Per-repo lock (D.5).

### Severity floor

| Floor | Fixes what |
|---|---|
| `P1` | Exploitable now or silent data corruption |
| `P2` (default) | P1 + requires unusual conditions or breaks under maintenance |
| `P3` | P1 + P2 + code smells |
| `low` | Everything |

## What audit does NOT do

- **Not for improving working code** → route to `xo-polish`
- **Not for making it faster** → route to `xo-improve`
- **Not for proposing alternative implementations** → route to `xo-autoresearch`

## Output

- Findings JSON in `.xoloop/runs/<timestamp>/audit-findings.json`
- Fixes applied atomically via patch engine (temp+rename, TOCTOU-protected)
- Summary: rounds completed, findings by severity, fixes landed

## Safety

- Runs in worktree for apply mode (locked D.1)
- Secret scan on proposed changeSets — hard-block canonical secret files + known key prefixes (locked D.4)
- Path scope enforced via canonical realpath allowlist
