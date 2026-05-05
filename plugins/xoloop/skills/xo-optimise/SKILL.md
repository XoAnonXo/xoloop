---
name: xo-optimise
description: Use this skill when the user asks to optimise, optimize, loop, search indefinitely, improve speed/memory/complexity, or run the XOLoop /optimise runtime against a passing goal contract. Consumes a PASS_EVIDENCED goal manifest, calls an external agent command for candidate patches, verifies each candidate, rolls back failures, and keeps only evidence-backed metric improvements.
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Optimise Mode

Run a resumable optimisation loop against a passing goal contract. The
implementation language does not matter; only the declared command
interface, verification evidence, and objective metrics matter.

## When to invoke

- "optimise this"
- "optimize this"
- "loop until it improves"
- "make it faster without breaking behavior"
- "reduce memory or complexity under verification"
- "run /optimise"

## Preconditions

1. A goal manifest exists at `.xoloop/goals/<id>/goal.yaml`.
2. `xoloop-verify card <goal.yaml> --json` reports `PASS_EVIDENCED`.
3. Discovery has no unaccepted blocking gaps for the target repo.
4. The user or caller provides an agent command that speaks the XOLoop
   optimiser protocol on stdin/stdout.

## Verify / Discovery gate

Before optimisation, run `xoloop-verify discover --write --json` and
select repo-specific suites from the detected frontend, api, state, function, runtime-lab, performance, formal,
cli, concurrency, state-machine, and safety surfaces. Optimise consumes only `PASS_EVIDENCED` contracts. A
`PASS_WITH_GAPS` card is not an optimisation contract unless the named
gaps are explicitly accepted in the goal/discovery ledger; `FAIL` and
`NO_EVIDENCE` block the loop.

For objective-led work with no prepared goal, generate the suite goal after
discovery:

```bash
xoloop-verify make-goal --objective "make backend cheaper/faster"
```

The generated goal should carry discovered surfaces, target metrics,
objective-specific metric analysis, exact obligation chains, generated
benchmark harnesses, cost/APM/DB/queue/infra signals, accepted gap IDs,
agent command wrappers, and tradeoff policy into the optimisation contract.

## How to invoke

Run a bounded optimisation:

```bash
xoloop-optimise run .xoloop/goals/<id>/goal.yaml \
  --agent-command "<cmd>" \
  --rounds 10 \
  --json
```

For goals created by `make-goal`, prefer the generated agent wrappers:

```bash
xoloop-optimise run .xoloop/goals/<id>/goal.yaml \
  --agent-command ".xoloop/goals/<id>/agents/codex-agent-command.sh" \
  --rounds 10 \
  --json
```

Claude Code wrapper:

```bash
xoloop-optimise run .xoloop/goals/<id>/goal.yaml \
  --agent-command ".xoloop/goals/<id>/agents/claude-agent-command.sh" \
  --rounds 10 \
  --json
```

US spelling alias:

```bash
xoloop-optimize run .xoloop/goals/<id>/goal.yaml \
  --agent-command "<cmd>" \
  --rounds 10
```

Run a resumable long loop:

```bash
xoloop-optimise run .xoloop/goals/<id>/goal.yaml \
  --agent-command "<cmd>" \
  --forever
```

## Acceptance Rule

Each candidate is accepted only if all verification obligations pass, no
protected metric regresses beyond the manifest budget, and at least one
target improves beyond its threshold, or runtime ties and complexity
improves.

Agents may return JSON with `operations` plus `tradeoffs` and `notes`.
Apply only the verifiable operations. If a cost saving depends on changed
behavior, weaker guarantees, reduced quality, skipped work, altered
retention, or different external effects, keep it proposal-only and ask the
user to accept the tradeoff before allowing it into the goal or code.
Use `xoloop-verify tradeoff <goal.yaml> --accept <id>` or `--reject <id>`
to record that decision in the goal manifest and tradeoff ledger.

## Safety

- Failed verification rolls back the candidate and records the counterexample.
- Malformed agent output is rejected without mutation.
- Operations outside allowed artifact paths are rejected.
- Every accept/reject/fail event is appended to the goal evidence ledger.
