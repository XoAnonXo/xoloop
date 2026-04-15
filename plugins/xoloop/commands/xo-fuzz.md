---
description: Fuzz a module's exports with fast-check; find crashes by distinguishing AdapterErrors from real bugs.
---

Run XOLoop fuzz on the module the user names.

Usage: `/xo-fuzz <module-path> [--exports fn1,fn2] [--runs 1000]`

Steps:
1. If user didn't list exports, discover them by reading the module and identifying `module.exports` / ESM exports.
2. Invoke `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-fuzz.cjs --module <path> --exports "..." [flags]`.
3. Report: total runs, shrunk crashes, corpus entries written.
