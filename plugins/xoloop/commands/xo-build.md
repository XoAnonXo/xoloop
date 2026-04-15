---
description: Build a new feature from scratch via serialized TDD (Agent A writes failing tests, Agent B writes implementation, red→green validated).
---

Run XOLoop build for a new feature.

Usage: `/xo-build <feature-yaml-path>` or `/xo-build` (plugin will help author feature.yaml)

Steps:
1. If no `overnight.yaml` in repo, run `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-init.cjs --dir .`.
2. If user did not pass a feature.yaml path, prompt them through authoring one: feature name, acceptance criteria, exemplar. Save to `.xoloop/features/<feature>.yaml`.
3. Invoke `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-build.cjs run <feature.yaml>`.
4. After run completes, call `review <featureId>` and show the user the bundle.
5. Only call `promote <featureId>` after explicit user approval.
