---
name: xo-build
description: Use this skill when the user asks to build, create, implement, scaffold, or write a NEW feature from scratch. Runs serialized TDD via TWO subagents — Agent A (Spec Writer) writes failing tests from acceptance criteria, Agent B (Builder) writes implementation that makes tests pass. Fixed 2-iteration sequence (spec → implementation), red→green validated between them. Not for modifying existing code (use xo-polish), not for fixing bugs (use xo-audit).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Build Mode (subagent-driven, serialized TDD)

Greenfield feature implementation via two-subagent serialized TDD.
Agent A writes the tests (red baseline), Agent B writes the
implementation (green). Engine enforces red→green delta validation
between them.

**Default operational mode — no API key required.**

## When to invoke

- "build a new X"
- "implement a Y function"
- "create a module that does Z"
- "add a feature that..."
- "scaffold a utility for..."
- "write me a ... from scratch"

## How it runs

1. **Capture intent.** Either:
   - User passed a `feature.yaml` path → load it
   - User described inline → prompt them for:
     - Feature name
     - Acceptance criteria (list of given/when/then)
     - Exemplar file (optional — style reference)
     - Target surface path
2. **Agent A — Spec Writer.** Spawn Agent with:
   > Write a test file for `<feature>` that verifies
   > `<acceptance criteria>`. Tests MUST FAIL without implementation
   > (reference functions/files that don't exist yet). Style-match
   > `<exemplar>`. Return a changeSet JSON that creates ONLY the test
   > file.
3. **Apply test file.** Shell out to
   `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-apply-proposal.cjs`.
4. **Verify RED.** Run the test command. It MUST fail (tests reference
   non-existent code). If it doesn't fail, the spec is wrong — abort
   and ask Agent A to produce a corrected spec.
5. **Agent B — Builder.** Spawn Agent with:
   > Here's a failing test file for `<feature>`. Here's the exemplar
   > style. Write the IMPLEMENTATION that makes all tests pass without
   > touching the test file. Return a changeSet JSON that creates
   > ONLY the implementation file(s).
6. **Apply implementation.** Bridge again, with `--validate "<test-cmd>"`.
7. **Verify GREEN.** Bridge already validated. If tests failed, bridge
   auto-rolled back implementation; Agent B gets one more chance with
   the failure output as feedback.
8. **Output a review bundle.** Write to
   `.xoloop/features/<feature>/review-bundle.json` with the spec,
   implementation, test output, and style notes. Nothing is committed
   until the user explicitly approves.
9. **Report**: tests added, implementation files created, red→green
   transition summary, review bundle path.

## Proposal schema

Agent A returns changeSet with ONLY `create_file` entries for the test
file(s). Agent B returns changeSet with ONLY `create_file` entries
for the implementation (NO test-file operations — Agent A already
wrote them and Agent B must not modify them).

## Why fixed 2 iterations?

Unlike polish/audit/improve (which loop until saturation), build is a
structured pipeline: spec, then build. If the spec is wrong, we retry
Agent A once; if the implementation fails, we retry Agent B once
(with the failure output as feedback). No more — beyond that, the
feature needs human re-spec.

## Defaults

| Setting | Default |
|---|---|
| Iterations | 2 (spec + impl) + up to 1 repair each |
| Style | inferred from exemplar file |
| Output location | `.xoloop/features/<feature>/review-bundle.json` |
| Auto-commit | **NO** — always requires explicit user approval after review |

## What build does NOT do

- **Not for existing code refinement** → `xo-polish`
- **Not for finding bugs** → `xo-audit`
- **Not for replacing an existing implementation** → `xo-autoresearch`

## EXTRA: API-key mode

```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-build.cjs run <feature.yaml>
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-build.cjs review <featureId>
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-build.cjs promote <featureId>
```
Uses `runBuildPipeline` with API-based Opus for Agents A and B.

## Safety

- Red→green delta validator enforces tests-fail-then-pass transition
- Review bundle written but nothing committed until explicit approval
- Agent A can't touch implementation file; Agent B can't touch test
  file (enforced via per-agent allowed-paths allowlist)
