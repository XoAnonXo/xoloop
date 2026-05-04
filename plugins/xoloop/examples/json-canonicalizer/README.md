# JSON Canonicalizer Goal Seed

This is the first proving-ground target for `xoloop-verify` and
`xoloop-optimise`.

Contract:

- stdin: JSON text in the v0 subset.
- stdout: canonical JSON text for valid input.
- invalid JSON, floats, unsafe integers, and duplicate object keys return
  structured JSON error output and exit non-zero.
- canonical form has no insignificant whitespace and recursively sorted object
  keys.

Try it from the repository root:

```bash
node plugins/xoloop/examples/json-canonicalizer/src/canon.cjs <<<'{"b":2,"a":1}'
plugins/xoloop/bin/xoloop-verify.cjs create --target plugins/xoloop/examples/json-canonicalizer/src/canon.cjs --goal-id json-canon-seed --force
plugins/xoloop/bin/xoloop-verify.cjs run .xoloop/goals/json-canon-seed/goal.yaml
```
