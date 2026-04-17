---
name: xo-benchmark
description: Use this skill when the user asks to benchmark, measure, profile, or lock deterministic output of code via SHA-256-hashed expected results. Runs entry-point command, captures stdout, parses JSON output, matches against expected. This mode is deterministic — no subagents or API required. Not for iterative improvement toward a benchmark (use xo-improve).
allowed-tools: Bash, Read
---

# XOLoop — Benchmark Mode (deterministic, no LLM)

SHA-256-locked deterministic benchmarks. **No LLM calls** — pure
execution + measurement + hash comparison. The objective gate that
correctness loops (polish, improve, autoresearch) bounce off of.

No API key required, no subagents spawned.

## When to invoke

- "benchmark this"
- "measure X"
- "profile Y"
- "lock the output of Z"
- "create a regression test for this behavior"
- "how fast is this?"

## How to invoke

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-benchmark.cjs run \
  --benchmark <path/to/benchmark.yaml>

# Create a new benchmark (locks the output hash)
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-benchmark.cjs create \
  --entry-point "<command>" \
  --output <path>
```

### benchmark.yaml shape

```yaml
benchmark: my-benchmark
cases:
  - name: case-1
    entry_point: "node src/my_module.js --input test1.json"
    expected_output_sha256: "<hash>"
    metrics:
      max_duration_ms: 500
      max_memory_mb: 100
```

## What benchmark does NOT do

- **Not for iterative improvement** → route to `xo-improve`
- **Not for finding crashes** → route to `xo-fuzz`
- **Not for correctness auditing** → route to `xo-audit`

## Output

- Per-case verdict (pass/fail) in
  `.xoloop/runs/<timestamp>/benchmark.json`
- Metrics captured: duration, memory, output hash, match status

## Safety

- Read-only — benchmark never modifies code
- No LLM calls, no network, no API key
- Auto-exec of `benchmarks/*.yaml` files requires explicit opt-in via
  `--allow-benchmark-exec` (security gate against committed-but-
  unexamined benchmark files)
