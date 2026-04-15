---
name: xo-benchmark
description: Use this skill when the user asks to benchmark, measure, profile, or lock deterministic output of code via SHA-256-hashed expected results. Runs entry-point command, captures stdout, parses JSON output, matches against expected. Not for iterative improvement toward a benchmark (use xo-improve), not for general performance work (xo-improve).
allowed-tools: Bash, Read
---

# XOLoop — Benchmark Mode

SHA-256-locked benchmarks. Deterministic input → deterministic expected output. If the output ever changes, the hash breaks and the benchmark fails. This is the objective gate that correctness loops (polish, improve, autoresearch) bounce off of.

## When to invoke

User says any of:
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

# Create a new benchmark
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

- **Not for iterative improvement toward a goal** → route to `xo-improve`
- **Not for finding crashes** → route to `xo-fuzz`
- **Not for auditing correctness logic** → route to `xo-audit`

## Output

- Per-case verdict (pass/fail) in `.xoloop/runs/<timestamp>/benchmark.json`
- Metrics captured: duration, memory, output hash, match status

## Safety

- Read-only — benchmark never modifies code
- Per-worktree lock (locked D.5)
