---
name: xo-build
description: Use this skill when the user asks to build, create, implement, scaffold, or write a NEW feature from scratch. Runs serialized TDD — Agent A writes failing tests from acceptance criteria and an exemplar, engine confirms red, Agent B writes implementation, engine confirms green via red→green delta validator. Not for modifying existing code (use xo-polish), not for fixing bugs (use xo-audit).
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Build Mode

Serialized TDD pipeline for greenfield features. Produces test file + implementation file from a `feature.yaml` spec. Two-agent handoff: Spec Writer → Builder, with engine-enforced red→green validation between them.

## When to invoke

User says any of:
- "build a new X"
- "implement a Y function"
- "create a module that does Z"
- "add a feature that..."
- "scaffold a utility for..."
- "write me a ... from scratch"

## How to invoke

```bash
# Step 1 — first invocation in a foreign repo: bootstrap
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-init.cjs --dir .

# Step 2 — BUILD requires a feature.yaml
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-build.cjs run <featurePath> \
  --adapter overnight.yaml

# Step 3 — review the generated bundle before promoting
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-build.cjs review <featureId>

# Step 4 — promote accepted implementation
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-build.cjs promote <featureId>
```

### feature.yaml required

BUILD is the only mode that requires a full feature spec. Per locked B.5, minimal-config modes (polish, audit, fuzz) auto-generate; BUILD requires:

```yaml
feature: my-new-feature
version: 1
surface: src/my_new_feature.js
acceptance:
  - given: "input X"
    when: "function is called"
    then: "returns Y"
exemplar: src/similar_existing_file.js   # style reference
```

### Exemplar handling (locked B.4)

If `exemplar:` is omitted, the wrapper attempts ranked fallback:
1. Nearest credible in-repo file (rank by extension + directory proximity + framework match; reject vendor/generated/test-fixture)
2. Bundled generic language exemplar (`$CLAUDE_PLUGIN_ROOT/exemplars/<lang>/module.*`)
3. Hard-fail with clear error if confidence below threshold

Never picks a random file.

## What build does NOT do

- **Not for existing code refinement** → route to `xo-polish`
- **Not for finding bugs** → route to `xo-audit`
- **Not for replacing an existing implementation with a better one** → route to `xo-autoresearch`

## Output

- Test file created and verified to fail (red baseline)
- Implementation file created and verified to make tests pass (green)
- Review bundle JSON in `.xoloop/runs/<timestamp>/build-review.json`
- Nothing committed until user runs `promote`

## Safety

- Runs in worktree (locked D.1)
- Prompts once on first net-new file creation (locked D.2)
- Inherits session credentials (locked D.6)
