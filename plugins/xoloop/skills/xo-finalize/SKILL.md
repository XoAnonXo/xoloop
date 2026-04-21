---
name: xo-finalize
description: Use this skill when the user asks to finalize, split, squash, or turn a noisy xoloop run into clean reviewable branches. Reads .xoloop/session.jsonl, groups kept proposals by non-overlapping file sets, and creates one independent branch per group starting from the merge-base. Each branch is a standalone reviewable PR. Not for running the loop itself (use xo-polish / xo-audit / etc.).
allowed-tools: Bash, Read
---

# XOLoop — Finalize Mode

Turn a messy autoresearch branch into clean, independently-reviewable
branches — one per logical change, each from the pre-session merge-base,
each touching a disjoint set of files.

**Inspired by `pi-autoresearch/autoresearch-finalize`.** We adopt the
same non-overlapping-files grouping rule: if two kept proposals touched
the same file, they're conceptually coupled and stay in one branch.

## When to invoke

- "finalize the xoloop run"
- "split the autoresearch branch into PRs"
- "turn the session into reviewable branches"
- "clean up the noisy loop output"

## How it runs

1. **Check session ledger.** Confirm `.xoloop/session.jsonl` exists with
   outcome='keep' entries.
2. **Dry-run first.** Always invoke with `--dry-run` first to show the
   user the proposed grouping:
   ```bash
   node $CLAUDE_PLUGIN_ROOT/bin/xoloop-finalize.cjs --dry-run
   ```
   The output is JSON describing: how many groups, which files each
   group touches, which rounds it spans, cumulative rationale, metric
   deltas.
3. **Human approval.** Show the plan. Ask the user to confirm before
   creating branches. They may want to tweak group boundaries, rename
   branches, or squash/expand. Respect their edits.
4. **Create branches.** If approved, run without `--dry-run`:
   ```bash
   node $CLAUDE_PLUGIN_ROOT/bin/xoloop-finalize.cjs \
     --base-ref main \
     --branch-prefix xoloop/
   ```
   Each group becomes a branch starting from `merge-base HEAD main`,
   with commits that touch only that group's files cherry-picked onto
   it. Cherry-pick conflicts abort cleanly — operator resolves
   manually then re-runs.
5. **Report.** Each branch name + commits cherry-picked + files touched.
   Operator pushes + opens PRs.

## Defaults

| Setting | Default |
|---|---|
| Base ref | `main` |
| Branch prefix | `xoloop/` |
| Ledger | `.xoloop/session.jsonl` |
| Mode | dry-run (safe preview) — operator must explicitly drop the flag |

## Grouping algorithm

Union-find over "files touched." Two kept proposals with any file in
common end up in the same group. Groups are numbered by earliest round.
Branch names: `xoloop/group-N-round-R`.

Why this rule? Branches that share files can't be merged independently
without conflicts. By enforcing disjoint file sets, every resulting
branch is a self-contained PR: reviewable on its own, mergeable on its
own, revertable on its own.

## What finalize does NOT do

- **Doesn't run loops.** Finalize is a post-processing step.
- **Doesn't push or open PRs.** Branch creation only. Operator pushes.
- **Doesn't rewrite history.** Cherry-picks create new commits from
  the base; the original noisy branch stays intact for reference.

## Safety

- Always dry-run first. Human approval gate is the skill's default UX.
- Cherry-pick conflicts abort the whole operation (no partial branch
  creation).
- Runs `git` in read-mostly mode until the explicit branch-creation
  phase. Checks merge-base resolution before any writes.
