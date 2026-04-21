---
name: xo-docs
description: Use this skill when the user asks to generate, update, refresh, or sync documentation for the repo. Scans public API surface + tests + existing docs, proposes JSDoc/docstrings/README/CHANGELOG updates, then runs two polish passes for tightness and link/example correctness. NOT iterative — fixed 3-round pipeline (generate + polish + polish). Can only edit docblocks in source files, never logic; can create/update doc files freely. Not for writing new code (use xo-build), not for refining source logic (use xo-polish).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Docs Mode (subagent-driven generation + 2 polish passes)

Generates and refreshes repository documentation. Unlike polish/simplify,
this is NOT an iterative search — it's a fixed 3-round pipeline:

- **Round 1 (generate)**: scan public API surface, extract examples from
  tests, propose JSDoc/docstrings + README table-of-contents + CHANGELOG
  entry
- **Round 2 (polish)**: tighten language, remove AI-slop patterns, verify
  any code examples compile/parse
- **Round 3 (polish)**: final pass — check all links resolve, code blocks
  parse, no duplicate headings, consistent voice

Docs are not tournament-searched. Each round is deterministic sequential
improvement over the previous.

## When to invoke

User says any of:
- "generate docs"
- "update the README"
- "document this repo"
- "refresh the docs"
- "write JSDoc for X"
- "add docstrings"
- "sync the changelog"
- "make the docs current"

## When NOT to invoke

- "explain this code" (to me right now) — just answer, no skill needed
- "review the docs for tone" — that's a prose-review task, use polish
  with surface = docs/
- "translate docs" — out of scope

## How it runs (step-by-step)

1. **Initialize session.**
   ```
   node $CLAUDE_PLUGIN_ROOT/bin/xoloop-session.cjs init --mode docs \
     --objective "generate/refresh docs for <scope>"
   ```

2. **Scan the repo.** Shell out:
   ```
   node $CLAUDE_PLUGIN_ROOT/bin/xoloop-docs.cjs scan
   ```
   This emits one JSON blob on stdout with:
   - `surfaceFiles`: all source files (public API candidates)
   - `existingDocs`: README, CHANGELOG, docs/*.md, etc.
   - `publicSymbols`: for each surface file, the list of exported names
     with `kind` (class/function/variable) and any existing docblock
     text
   - `undocumentedCount`: how many public symbols have no docblock

3. **Round 1 — generate** (spawn Agent subagent):
   - Give it the full scan output as context
   - Ask it to propose a changeSet that:
     - Adds JSDoc/docstrings for any public symbol missing one
     - Updates README.md's API table / overview if stale (or creates one)
     - Appends a CHANGELOG.md stub entry for the current work
     - Does NOT change any logic — only docblocks + doc-target files
   - Apply via bridge with `--require-docs` flag:
     ```
     node $CLAUDE_PLUGIN_ROOT/bin/xoloop-apply-proposal.cjs \
       --proposal-file /tmp/xoloop-docs-round-1.json \
       --allowed-paths "README.md,docs/,CHANGELOG.md,<any source file for JSDoc>" \
       --validate "<test command>" \
       --require-docs
     ```
   - The `--require-docs` gate refuses changes to source files that
     aren't inside a docblock region (comment/JSDoc/docstring).

4. **Round 2 — polish (language)**: spawn a second subagent. Give it
   the generated docs from round 1. Ask it to:
   - Tighten verbose sentences
   - Remove AI-slop patterns ("It's important to note that…", "In
     conclusion…", "Furthermore…", "Let's explore…")
   - Replace vague phrasings with specific ones
   - Ensure consistent tense (prefer imperative for instructions,
     present for explanations)
   - Apply via bridge with `--require-docs`

5. **Round 3 — polish (mechanical)**: spawn a third subagent. Ask it to:
   - Verify every markdown link resolves to an existing file/section
   - Verify every fenced code block either parses (for supported
     languages) or is explicitly marked as pseudocode
   - Deduplicate headings
   - Ensure TOC (if any) matches actual headings
   - Apply via bridge with `--require-docs`

6. **Final report**: docs files changed, symbols newly documented,
   broken-link fixes, session.md path.

## Proposal JSON schema

Standard changeSet schema (same as polish). Additions allowed by
`--require-docs`:

- `kind: "create_file"` — but only for paths matching README*, CHANGELOG*,
  or docs/**/*.md|rst|adoc
- `kind: "replace_once"` on source files — allowed ONLY if the `match`
  and `replace` differ inside a docblock (comment, JSDoc, or docstring)
  and the non-doc parts are byte-identical

## Defaults

| Setting | Default |
|---|---|
| Rounds | **3** (1 generate + 2 polish) — fixed, no tournament |
| Scope | whole repo |
| Target file types | .js .cjs .mjs .ts .tsx .jsx .py .rb + all doc files |
| Validation | repo's test command (must still pass — even though docs don't affect behavior, a busted docblock can break build tooling) |

## Safety

- `--require-docs` gate refuses logic edits to source files
- No file deletions allowed
- New files can only be created under doc-shaped paths
- Test command must pass after every round (catches broken JSDoc that
  trips up typedoc / sphinx / etc.)
- Respects `.gitignore` + `.xoloop-ignore`

## Why fixed 3 rounds (not iterative)

Docs don't have a search space. The first round generates; the next
two polish. There's no "try 8 different documentations and keep the
best" — each round strictly improves on the previous. Going beyond 3
rounds hits diminishing returns fast because round-3 output is already
polished + mechanical-verified.

If the repo is HUGE and one pass misses parts, run the skill twice on
different scopes (e.g., `--scope lib/` then `--scope bin/`).

## EXTRA: API-key proposer (headless / CI / overnight)

```bash
ANTHROPIC_API_KEY=... \
  node $CLAUDE_PLUGIN_ROOT/bin/xoloop-docs.cjs \
  run --scope <dir-or-repo>
```

Also accepts `--proposer <shell-command>`.
