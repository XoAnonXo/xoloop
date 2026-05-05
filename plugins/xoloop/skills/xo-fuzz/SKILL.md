---
name: xo-fuzz
description: Use this skill when the user asks to fuzz, stress-test, property-test, or find crashes in existing code. Runs fast-check property-based fuzzing on module exports. This mode is deterministic — no subagents or API required. Distinguishes AdapterErrors (expected rejections) from real bugs (TypeError/RangeError/etc). Writes crash corpus for CI replay.
allowed-tools: Bash, Read
---

# XOLoop — Fuzz Mode (deterministic, no LLM)

Property-based fuzzing via fast-check. **This mode does not use LLM
calls at all** — it's pure property testing that generates adversarial
inputs and distinguishes expected rejections (`AdapterError` with
`err.code`) from real bugs (`TypeError`, `RangeError`, unhandled
promise rejection, etc).

No API key required, no subagents spawned — the fuzz engine is fully
deterministic given a seed.

## When to invoke

- "fuzz this"
- "stress test X"
- "property-test Y"
- "find edge cases in Z"
- "what inputs crash this?"
- "throw random data at this and see what breaks"

## Verify / Discovery use

Fuzz is read-only, but it should feed Verify before risky refactor or
optimization work. Run `xoloop-verify discover --write --json`, select
repo-specific suites from detected frontend, api, state, function, runtime-lab, performance,
formal, cli, concurrency, state-machine, and safety surfaces, then add
crash corpus or property cases to the matching goal. Treat
`PASS_EVIDENCED` as usable evidence; keep `PASS_WITH_GAPS` visible and
require accepted named gaps before downstream mutation.

## How to invoke

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-fuzz.cjs \
  --module <path> \
  [--runs 1000] \
  [--seed <int>]
```

### Defaults

- `--runs 1000` (fast-check default; increase to 10000 for deeper runs)
- `--seed` auto-generated; recorded in output for repro

## What fuzz does NOT do

- **Not for writing unit tests** → route to `xo-build`
- **Not for finding logic bugs** → route to `xo-audit`
- **Not for performance** → route to `xo-improve`

## Output

- Crash corpus entries in `.xoloop/corpus/<module>/<hash>.json`
  (inputs + stack)
- CI can replay via `--replay-corpus` flag
- Summary: total runs, shrunk crashes, replay coverage

## Safety

- Read-only — fuzz never modifies code
- No LLM calls, no network, no API key
- No filesystem writes outside `.xoloop/corpus/`
