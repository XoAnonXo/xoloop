---
name: xo-fuzz
description: Use this skill when the user asks to fuzz, stress-test, property-test, or find crashes in existing code. Runs fast-check property-based fuzzing on module exports, distinguishing AdapterErrors (expected rejections) from real bugs (TypeError/RangeError/etc). Writes crash corpus for CI replay. Not for unit testing (use xo-build), not for logic-level bugs (use xo-audit).
allowed-tools: Bash, Read
---

# XOLoop — Fuzz Mode

Property-based fuzzing that distinguishes expected rejections from real bugs. An `AdapterError` (structured `err.code`) is fine — it's the module saying "no" intentionally. Anything else (TypeError, RangeError, unhandled promise rejection, timeout) is a real bug and gets written to the crash corpus.

## When to invoke

User says any of:
- "fuzz this"
- "stress test X"
- "property-test Y"
- "find edge cases in Z"
- "what inputs crash this?"
- "throw random data at this and see what breaks"

## How to invoke

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-fuzz.cjs \
  --module <path> \
  --exports "<fnName1,fnName2>" \
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

- Crash corpus entries in `.xoloop/corpus/<module>/<hash>.json` (inputs + stack)
- CI can replay via `--replay-corpus` flag
- Summary: total runs, shrunk crashes, replay coverage

## Safety

- Read-only — fuzz never modifies code
- Per-worktree lock (locked D.5 — read-only mode)
- No filesystem writes outside `.xoloop/corpus/`
