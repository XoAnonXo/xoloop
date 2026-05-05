# Dogfooding XOLoop

Use Verify as the inner-loop cage before asking XOLoop to improve XOLoop.

## Baseline

```bash
git switch -c codex/xoloop-self-improve
node --test plugins/xoloop/test/*.test.cjs
```

## Discovery Goal

Generate the broad map first. It is useful for gap analysis, but may be too
slow or too broad for every candidate patch.

```bash
node plugins/xoloop/bin/xoloop-verify.cjs discover --write --json
node plugins/xoloop/bin/xoloop-verify.cjs make-goal \
  --objective "make the XOLoop plugin smaller, clearer, safer, faster, and more reliable without changing behavior" \
  --target fullstack \
  --metric performance \
  --goal-id xoloop-self-improve \
  --force
```

If discovery finds API/state/runtime gaps that are not real product surfaces
for the plugin repo, create a narrower self-core goal and explicitly accept
those named out-of-scope gaps.

## Fast Inner Gate

Use a fast command-suite goal for simplify, polish, audit, and optimise
rounds. Install the tracked template into the ignored local goal directory:

```bash
mkdir -p .xoloop/goals/xoloop-self-fast
cp docs/xoloop-self-fast.goal.json .xoloop/goals/xoloop-self-fast/goal.yaml
```

Then run:

```bash
node plugins/xoloop/bin/xoloop-verify.cjs run .xoloop/goals/xoloop-self-fast/goal.yaml --json
```

It verifies:

- syntax for new Verify modules and CLIs
- focused runtime tests for goal maker, tradeoffs, discovery, function scan,
  runtime lab, and optimise rollback behavior
- `git diff --check`

Run the full suite before and after larger batches:

```bash
node --test plugins/xoloop/test/*.test.cjs
```

## Optimise Dry Run

Exercise the optimiser protocol against the fast goal before letting a real
agent propose patches:

```bash
node plugins/xoloop/bin/xoloop-optimise.cjs run .xoloop/goals/xoloop-self-fast/goal.yaml \
  --agent-command 'node -e "process.stdout.write(JSON.stringify({summary:\"dry run\",operations:[],tradeoffs:[],notes:[\"champion verified\"]}))"' \
  --rounds 1 \
  --allow-dirty \
  --json
```

Only use generated Codex/Claude wrappers for real optimisation once the fast
goal reports `PASS_EVIDENCED`.
