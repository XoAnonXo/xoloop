---
name: xo-verify
description: Use this skill when the user asks to verify code, create a machine-checkable goal contract, prove behavior with golden/fuzz/property checks, produce a verify card, or run the XOLoop /verify runtime. Creates and runs goal manifests under .xoloop/goals/<goal-id>/goal.yaml and writes append-only evidence ledgers. Not for changing implementation code except generated verification assets.
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Verify Mode

Create and run machine-checkable goal contracts. Verification treats the
implementation as a black-box command interface and records reproducible
evidence instead of making vague correctness claims.

## When to invoke

- "verify this"
- "create a goal contract"
- "write verifications"
- "make a verify card"
- "prove this behavior with fuzz/golden/property tests"
- "run /verify"

## How to invoke

Create a JSON canonicalizer proving-ground goal:

```bash
xoloop-verify create --target <path> --kind json-canonicalizer --goal-id <id>
```

Run the goal:

```bash
xoloop-verify run .xoloop/goals/<id>/goal.yaml --json
```

Show the evidence card:

```bash
xoloop-verify card .xoloop/goals/<id>/goal.yaml --json
```

## Semantics

- `FAIL`: current counterexample exists.
- `NO_EVIDENCE`: manifest exists but no current evidence has run.
- `PASS_WITH_GAPS`: executed checks passed, but declared checks are missing.
- `PASS_EVIDENCED`: all declared checks passed for the current manifest and artifact hashes.

## Safety

- Verify mode may generate verification assets under `.xoloop/goals/`.
- Verify mode does not optimise implementation code.
- Always report the replay command and any counterexample path/id.
