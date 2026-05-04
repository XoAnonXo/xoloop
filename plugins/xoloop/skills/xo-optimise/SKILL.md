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
3. The user or caller provides an agent command that speaks the XOLoop
   optimiser protocol on stdin/stdout.

## How to invoke

Run a bounded optimisation:

```bash
xoloop-optimise run .xoloop/goals/<id>/goal.yaml \
  --agent-command "<cmd>" \
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

## Safety

- Failed verification rolls back the candidate and records the counterexample.
- Malformed agent output is rejected without mutation.
- Operations outside allowed artifact paths are rejected.
- Every accept/reject/fail event is appended to the goal evidence ledger.
