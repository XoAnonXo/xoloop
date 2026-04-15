---
name: xo-autoresearch
description: Use this skill when the user asks to research, explore alternatives, propose a different implementation, question the approach, or find a better way to do something. Runs Champion vs Challenger tournament with heterogeneous council (Opus architect + Sonnet pragmatist + Codex hacker), 1-5 anchored rubric on naked AST. Not for polishing within the existing paradigm (use xo-polish), not for bug hunting (use xo-audit).
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Autoresearch Mode

Questions the paradigm. Champion is the current implementation; Challenger is an alternative the research agent proposes (different algorithm, library, provider, pattern, sometimes language). Both pass the objective gate (tests + benchmark) before reaching the council. Council judges on naked AST (comments / docstrings / prose stripped). A wins twice → converged.

## When to invoke

User says any of:
- "research alternatives to X"
- "is there a better way to do this?"
- "find a different approach"
- "what else could we use instead of Y?"
- "propose a radical alternative"
- "explore <domain> for better implementations"

## How to invoke

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-autoresearch.cjs \
  --target <path> \
  [--rounds 5] \
  [--token-cap <tier>]
```

### Token tier

| Tier | Cap |
|---|---|
| `utility` | 200K (tiny helpers) |
| `normal` (default) | 750K (standard modules) |
| `strategic` | 2M (hot paths, public APIs) |
| `override` | 5M (explicit opt-in only) |

## Sensitive-domain gate (graduated approval)

If target touches crypto / auth / public_api / schemas / migrations:
- Auto-apply disabled; requires human approval
- +1 specialist judge added to council (4 total)
- Dependency quarantine for any new `require/import`

Research still runs — safety is in the gauntlet, not exclusion.

## What autoresearch does NOT do

- **Not for polishing within the existing paradigm** → route to `xo-polish`
- **Not for hitting a specific metric** → route to `xo-improve`
- **Not for bug hunting** → route to `xo-audit`

## Output

- Evidence packet YAML in `.xoloop/research/<target>/evidence.yaml`
- Challenger implementation (if council votes B)
- Convergence verdict: auto-apply / human-approval / rejected

## Safety

- Runs in worktree (locked D.1)
- Sensitive domains escalate to human approval queue
- Paradigm shifts (language / runtime / provider) always require human approval
