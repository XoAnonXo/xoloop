---
name: xo-autoresearch
description: Use this skill when the user asks to research, explore alternatives, propose a different implementation, question the approach, or find a better way to do something. Runs a subagent-driven Champion-vs-Challenger tournament — current implementation is Champion; each round spawns a "Challenger" subagent proposing a radically different approach. Both must pass tests; a judge subagent picks the winner on a 1-5 rubric. Converges when Champion wins twice in a row. Default 5 rounds. Not for polishing within the existing paradigm (use xo-polish).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Autoresearch Mode (subagent-driven)

Questions the paradigm. Champion = current implementation; Challenger =
subagent proposal of a radically different approach (different
algorithm, data structure, library, pattern). Both pass the objective
gate (tests). A judge subagent picks the winner on a 1-5 anchored
rubric. Champion wins twice → converged.

**Default operational mode — no API key required.**

## When to invoke

- "research alternatives to X"
- "is there a better way to do this?"
- "find a different approach"
- "what else could we use instead of Y?"
- "propose a radical alternative"
- "explore <domain> for better implementations"

## Verify / Discovery gate

Autoresearch changes paradigms, so run
`xoloop-verify discover --write --json` before the Challenger loop.
Select repo-specific suites from the detected frontend, api, state, function, runtime-lab, performance, formal,
cli, concurrency, state-machine, and safety surfaces. A Challenger can become Champion only when the relevant goal or
suite is `PASS_EVIDENCED`; `PASS_WITH_GAPS` requires accepted named gaps,
and `FAIL`/`NO_EVIDENCE` blocks replacement.

## How it runs

1. **Read target + current test suite.** Champion = current code.
2. **Loop up to 5 rounds** (default — less than polish because each
   round is heavier).
   a. **Challenger subagent.** Spawn Agent with prompt:
      > Propose a radically different implementation of this module
      > (different algorithm, pattern, library, paradigm — not just
      > refactoring). Must pass the same tests. Return changeSet JSON.
   b. **Objective gate.** Apply via
      `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-apply-proposal.cjs` with
      `--validate "<test-command>"`. If tests fail, rollback
      automatically (same bridge contract).
   c. If Challenger passes, **Judge subagent.** Spawn separate Agent:
      > Here are two implementations of the same module. Both pass
      > tests. Score each on: Simplicity (1-5), Cost (1-5),
      > Maintainability (1-5), Readability (1-5). Return JSON with
      > scores and the winner.
      > Version A (Champion): <naked AST>
      > Version B (Challenger): <naked AST>
   d. Naked AST = strip comments, docstrings, and prose rationale
      BEFORE showing to judge, to prevent verbose-JSDoc bias.
   e. **Borda count.** Compare composite scores; higher wins.
3. **Convergence criterion.** Champion wins two consecutive rounds →
   stop. Challenger wins → Challenger becomes new Champion, continue.
4. **Sensitive-domain gate.** If target touches crypto / auth /
   public_api / schemas / migrations, do NOT auto-apply a Challenger
   win. Route to human approval queue with evidence packet
   (scores, rationale, both implementations).
5. **Report**: rounds run, Champion history, final implementation,
   judge scores per round.

## Proposal schema

Same as xo-polish — `{rationale, changeSet: [...]}`. Rationale should
explain the paradigm shift, not just the edit.

## Defaults

| Setting | Default |
|---|---|
| Iterations | 5 (less than polish; each round is expensive) |
| Convergence | Champion wins twice consecutively |
| Sensitive-domain routing | auto-detect from path patterns (crypto/auth/schemas/migrations) |

## What autoresearch does NOT do

- **Not for polishing within the existing paradigm** → `xo-polish`
- **Not for hitting a specific metric** → `xo-improve`
- **Not for bug hunting** → `xo-audit`

## EXTRA: API-key mode (3-judge council)

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-autoresearch.cjs \
  --target <path> --rounds 5 --token-cap strategic
```
Uses Opus (architect) + Sonnet (pragmatist) + Codex (hacker) as
heterogeneous judges via API. The single-judge subagent path above is
the default for skill invocations.

## Safety

- Both Champion and Challenger must pass objective gate before reaching
  judge — broken code never scores
- Sensitive domains escalate to human approval
- Paradigm shifts (language/runtime/provider change) always require
  explicit user confirmation
