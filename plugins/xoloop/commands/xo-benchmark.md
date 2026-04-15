---
description: Create or run a SHA-256-locked deterministic benchmark for code behavior.
---

Run XOLoop benchmark on the target the user names.

Usage:
- `/xo-benchmark run <benchmark-yaml>` — execute an existing benchmark
- `/xo-benchmark create --entry-point "<cmd>" --output <path>` — lock a new one

Steps:
1. If user wants to run an existing benchmark, invoke `xoloop-benchmark.cjs run --benchmark <path>`.
2. If creating, run the entry-point command once, capture stdout, hash it, write benchmark.yaml with the hash as expected_output_sha256.
3. Report per-case verdict: pass/fail with metric deltas.
