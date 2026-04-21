---
name: xo-simplify
description: Use this skill when the user asks to simplify, shrink, reduce complexity, remove dead code, collapse abstractions, delete unnecessary layers, or otherwise make the code SMALLER. Runs a subagent-driven DELETION loop — spawns 8 Agent subagents by default, each proposes ONE deletion (remove file, collapse wrapper, kill dead branch), applies atomically with test-gated rollback PLUS a complexity-metric gate that requires ≥1 of {sloc, cyclomatic, exports} to decrease and none to increase. Only touches internal (non-exported) symbols — never tests, never the public API. Not for writing new code (use xo-build), not for tightening style (use xo-polish), not for perf (use xo-improve).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Simplify Mode (subagent-driven deletion loop)

Iteratively DELETES code via **subagent proposals**. Each round spawns
an Agent subagent that reads the target, returns a JSON changeSet
proposing one deletion (or collapse), which the bridge applies
atomically with three gates:

1. **Pre-apply gate** — no test files touched, no exported symbols deleted
2. **Test gate** — validation command must still pass
3. **Metric gate** — at least one of {sloc, cyclomatic, exports} must
   decrease AND none may increase

Any proposal failing any gate is rolled back automatically.

**This is the default operational mode for simplification.** No API key
required — the proposer IS the Claude subagent you spawn.

## When to invoke

User says any of:
- "simplify this"
- "shrink X"
- "remove dead code"
- "collapse these abstractions"
- "reduce complexity in Y"
- "delete unnecessary layers"
- "kill the wrapper around Z"
- "inline the adapter"

## When NOT to invoke

- "rename this" → use `xo-polish`
- "make this faster" → use `xo-improve`
- "find bugs" → use `xo-audit`
- "add a feature" → use `xo-build`

## How it runs (step-by-step)

1. **Initialize or resume the session.** Use
   `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-session.cjs init --mode simplify
   --objective "<what we're simplifying>" --files "<rel/path.js>"` to
   create `.xoloop/session.md` + `.xoloop/session.jsonl`. If either
   exists, read them first — prior rounds' deletions, rollbacks, and
   dead ends all live there.

2. **Read the target file(s) + any callers.** For simplify you MUST
   also grep for importers/requirers of the file, because deleting an
   exported symbol (even "internal" by convention) is blocked at the
   bridge if it's in fact re-exported elsewhere.

3. **Discover the validation command.** From `overnight.yaml`, or ask
   user, or default per-stack (`npm test`, `pytest`, `cargo test`).

4. **Measure baseline complexity.** Shell out:
   ```
   node $CLAUDE_PLUGIN_ROOT/bin/xoloop-simplify.cjs measure \
     --files "<rel/path1>,<rel/path2>"
   ```
   Capture baseline `{sloc, cyclomatic, exports}` for session log.

5. **Loop N rounds** (default: **8**). Each round:

   a. **Spawn a subagent** with Agent tool, `general-purpose` type. Give
      it:
      - Current file content
      - Baseline metric
      - Prior rounds' outcomes (from session.jsonl)
      - The deletion objective: "Propose ONE deletion that makes this
        file shorter or less branchy without changing external behavior.
        You MAY collapse a wrapper into its only caller, remove a dead
        branch, delete an internal helper used only by other internal
        helpers, or remove an unused import. You MAY NOT delete exported
        symbols, touch test files, or change behavior. Return ONLY a
        JSON object matching the schema below."
      - The proposal JSON schema (see below)

   b. **Extract the proposal JSON** from the subagent's response. Write
      it to a temp file.

   c. **Apply via the bridge with simplify gate.** ASI captures what the
      subagent learned:
      ```
      node $CLAUDE_PLUGIN_ROOT/bin/xoloop-apply-proposal.cjs \
        --proposal-file /tmp/xoloop-simplify-round-N.json \
        --allowed-paths "<target-paths>" \
        --validate "<test command>" \
        --require-simplify \
        --asi '{"learned":"...","tried":"...","next":"..."}'
      ```
      The `--require-simplify` flag activates:
      - Test-file refusal
      - Exported-symbol refusal
      - Complexity-metric gate (post-apply)

   d. **Read the bridge report** (one JSON line on stdout). Outcomes:
      - `applied:true, validated:true, rolledBack:false, simplifyVerdict:"improved"`
        → **keep**, re-measure for next round
      - `applied:true, validated:false, rolledBack:true` → tests
        regressed; file restored; log continue
      - `applied:true, validated:true, simplifyVerdict:"regressed"`
        → bridge auto-rolls-back; file restored; log continue
      - `applied:false, errorCode:"SIMPLIFY_TOUCHES_TESTS"` or
        `"SIMPLIFY_DELETES_EXPORT"` → proposal was out of scope; log
        the reason, next round gets that info in its ASI context

   e. **Append to session ledger.** Each round writes one JSON line to
      `.xoloop/session.jsonl` including the simplify-specific fields:
      `{round, mode:"simplify", outcome, delta:{sloc,cyclomatic,exports},
       filesTouched, asi, proposalSummary}`.

   f. **Stop-early triggers (stricter than polish):**
      - 2 consecutive `applied:false` or `rolledBack:true` → stop
      - Subagent returns `{"cannotSimplify": true}` → stop
      - 2 consecutive rounds with `simplifyVerdict:"neutral"` (nothing
        actually got smaller) → stop

6. **Final re-measure.** Shell out again to `xoloop-simplify.cjs measure`
   and compute total delta.

7. **Report to the user**: rounds run, deletions landed, rollbacks,
   total complexity delta (SLOC removed, cyclomatic reduced, exports
   unchanged), session.md path.

## Proposal JSON schema

The subagent must return:

```json
{
  "rationale": "one sentence explaining why this deletion is safe",
  "metricClaim": { "sloc": -12, "cyclomatic": -3, "exports": 0 },
  "changeSet": [
    {
      "kind": "replace_once",
      "path": "relative/path/from/repo/root.js",
      "match": "exact substring to delete or collapse",
      "replace": "replacement (often empty string for pure deletion)"
    }
  ]
}
```

Also valid: `"kind": "delete_file"` (removes whole file — but the bridge
refuses if the file has any exported symbols).

`metricClaim` is advisory — the bridge re-measures post-apply regardless.
It's a self-check: if the subagent's claim doesn't match reality, the
ledger records the divergence.

## Defaults

| Setting | Default |
|---|---|
| Iterations | **8** |
| Stop-early (consecutive no-ops) | 2 |
| Validation | `npm test` / `pytest` / `cargo test` (detected) |
| Allowed paths | target file(s) + grep'd callers |
| First run per repo | dry-run preview |

## Safety

- Pre-apply: test files + exported-symbol deletions are refused before
  anything touches disk
- Apply: atomic temp+rename with verificationManifest TOCTOU gate
- Post-apply: test-gate + metric-gate; either failure triggers snapshot
  rollback
- Unknown-language files (Go, Rust, Java without AST support): refused
  fail-safe
- Defense-in-depth: engine's realpath allowlist + `.gitignore` +
  `.xoloop-ignore`

## Hard rules (enforced by `--require-simplify`)

| Rule | Enforcement |
|---|---|
| No test files | `isTestFile(path)` regex pre-check |
| No exported-symbol deletion | AST-lite export scan before apply |
| Must reduce ≥1 metric, regress none | post-apply measure + compare |
| No unknown-language file deletion | `detectLanguage()` must return a supported value |

## Why the 8-iteration default (vs polish's 7 or 11)

Deletion-reward decays faster than refinement. After round 3 most
subagent proposals return "nothing left to delete safely." 8 gives two
extra chances for compound effects (deleting abstraction A makes
abstraction B deletable). Stop-early at 2 consecutive no-ops typically
terminates by round 5-6 in practice.

## EXTRA: API-key proposer (headless / CI / overnight)

For unattended runs where no Claude session is available:

```bash
ANTHROPIC_API_KEY=... \
  node $CLAUDE_PLUGIN_ROOT/bin/xoloop-simplify.cjs \
  run --surface <path> --rounds <N>
```

Also accepts `--proposer <shell-command>` to route proposals through an
external binary (JSON stdin → JSON stdout). Use when there's no Claude
subagent available. For interactive use inside Claude Code, the
subagent-driven path above is the default.
