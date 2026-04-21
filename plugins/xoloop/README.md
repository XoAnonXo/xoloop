# XOLoop — Claude Code Plugin

Subagent-driven code improvement framework for Claude Code. Install once;
every Claude Code session in any repo gains 11 iterative modes that use
**Agent subagents as the default proposer**.

**No API key required for the default path.** The proposer IS the Claude
subagent you spawn — no separate Anthropic/OpenAI account needed. API-key
mode exists as an EXTRA for CI / headless / true-overnight runs.

## v0.3.0 — what's new

- **`xo-simplify`** — new deletion-focused mode (8 rounds default).
  Each round spawns a subagent proposing ONE deletion; bridge enforces
  three gates: no test-file edits, no exported-symbol deletions
  (AST-lite scan), and a post-apply metric gate requiring ≥1 of
  {sloc, cyclomatic, exports} to decrease AND none to increase.
- **`xo-docs`** — new documentation-generation mode (3 fixed rounds:
  generate + polish + polish). Scans public API surface + tests +
  existing docs, only edits docblock regions in source files,
  creates/updates README and CHANGELOG freely.
- **11-phase overnight pipeline** — budget bumped from 50 → 80 to
  accommodate new phases. Pipeline:
  `build → simplify → polish → fuzz → bench → improve → autoresearch →
  polish → audit → polish → docs`.
- **1.5× rounds across the board** — polish 7→11, audit 7→11, improve
  7→11, autoresearch 5→8, build 2→3, plus new simplify (8) and docs (3),
  based on saturation data from v0.2.0 runs. Stop-early still protects
  against wasted budget.
- **Bridge gates `--require-simplify` and `--require-docs`** — pre-apply
  validation + simplify post-apply metric verification, enforced at the
  bridge layer so API-key EXTRA wrappers get the same safety.

## v0.2.0 — recap

- Session persistence (`.xoloop/session.md` + `session.jsonl` +
  `ideas.md`) survives context resets. Inspired by
  [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).
- `xo-finalize` — turns a noisy session into clean reviewable branches.
- MAD-based confidence score in `xo-improve`.
- ASI (Agent-Supplied Information) on every apply.
- Simpler benchmark contract: `METRIC name=value` lines.
- Security hardening: TOCTOU-free symlink refusal (O_NOFOLLOW), opt-in
  auto-exec gates, markdown injection sanitization.

## The 11 modes

| Mode | Default iterations | Trigger phrases | What it does |
|---|---|---|---|
| **xo-build** | 3 (spec + impl + refactor) | "build new…", "implement…", "scaffold…" | Subagent TDD: failing tests first, implementation second, light refactor third |
| **xo-simplify** ⭐ | 8 | "simplify…", "shrink…", "remove dead code…", "collapse this wrapper…" | Deletion-focused subagent loop. Metric-gated (sloc/cyclomatic/exports must decrease, none increase). Internal symbols only — never tests, never public API. |
| **xo-polish** | 11 | "polish…", "refine…", "clean up…", "tighten…" | Refinement subagent loop → bridge applies atomically → tests gate → keep or rollback |
| **xo-fuzz** | deterministic (150 trials) | "fuzz…", "property-test…", "find edge cases…" | fast-check property fuzzing (no LLM, no API) |
| **xo-benchmark** | deterministic (8 samples) | "benchmark…", "lock output…" | SHA-256-locked deterministic tests + `METRIC name=value` script contract |
| **xo-improve** | 11 | "make X faster", "reduce memory…", "hit this benchmark" | Benchmark-driven optimization with MAD-based noise-aware confidence score |
| **xo-autoresearch** | 8 | "research alternatives to…", "is there a better way…" | Champion-vs-Challenger subagent tournament with judge subagent scoring on 1-5 rubric |
| **xo-audit** | 11 | "audit…", "find bugs in…", "security review…" | Auditor subagent finds P1/P2/P3 findings; fixer subagents one-per-blocking, bridge-gated |
| **xo-docs** ⭐ | 3 (generate + polish + polish) | "generate docs…", "update README…", "add JSDoc…" | Scans public API surface + tests + existing docs. Source files: docblock edits only. Doc files: free rein. |
| **xo-overnight** | 80 | "run overnight", "full XO pipeline" | 11-phase orchestrator across build→simplify→polish→fuzz→bench→improve→autoresearch→polish→audit→polish→docs |
| **xo-finalize** | n/a | "finalize…", "split into PRs", "turn run into branches" | Group kept proposals by non-overlapping file sets, create independent reviewable branches from merge-base |

## The full pipeline (overnight)

```
build (3) → simplify (8) → polish (11) → fuzz (det) → bench (det) →
improve (11) → autoresearch (8) → polish (8) → audit (11) →
polish (5) → docs (3)

= 68 LLM rounds + deterministic phases. Fits 80 budget with 12 headroom.
```

**Why this ordering:**
- `simplify` before `polish` → don't beautify dead code
- `polish` appears 3×: after simplify skeletons, after improve scars, after audit fixes
- `audit` late → finds real bugs in mature code, not draft bugs
- `docs` last → docs describe the final API, not the draft API

## Why subagent-default / API-key-extra

When XOLoop runs as a Claude Code plugin, **the user is already in a
Claude session**. The "model" the proposer needs IS the current Claude.
Spawning an `Agent()` subagent means:

- No separate API key required (inherits session auth)
- Same model quality — it IS a real Claude call through the harness
- Works out of the box for every Claude Code user
- No distribution-layer credential setup

The API-key path (`bin/xoloop-*.cjs` wrappers with `--proposer` flag or
`ANTHROPIC_API_KEY` env) exists for:

- True overnight runs spanning hours (no session budget)
- CI pipelines running without a Claude session
- Headless servers
- Routing through custom model backends (`--proposer "<shell-command>"`
  reads JSON prompts on stdin, returns JSON responses on stdout)

## How the subagent-default flow works

```
User: "polish src/widget.js"
  ↓
xo-polish skill fires
  ↓
Claude reads src/widget.js and runs the loop:
  Round 1:
    ↓
    Agent() subagent with polish prompt + current code
    ↓
    Subagent returns JSON changeSet proposal
    ↓
    Bash: node bin/xoloop-apply-proposal.cjs --validate "npm test"
    ↓
    Bridge applies atomically, runs tests, rolls back on failure
    ↓
    Bridge returns outcome JSON
  Round 2: ... (with previous round's result in context)
  ...
  Round 7
  ↓
Final summary to user
```

The bridge (`bin/xoloop-apply-proposal.cjs`) is the subagent → engine
boundary. It:
- Validates proposal JSON schema
- Applies via `change_set_engine.applyChangeSet` (atomic temp+rename,
  realpath allowlist, verificationManifest TOCTOU gate)
- Runs the validation command (npm test / pytest / etc.)
- Auto-rollbacks via snapshot on validation failure
- Emits one JSON line to stdout describing the outcome

## Installation

```bash
# Sideload
git clone https://github.com/XoAnonXo/xoloop ~/.claude/plugins/marketplaces/xoloop

# Register in ~/.claude/settings.json:
#   "extraKnownMarketplaces": {
#     "xoloop": { "source": { "source": "github", "repo": "XoAnonXo/xoloop" } }
#   },
#   "enabledPlugins": { "xoloop@xoloop": true }
```

Restart Claude Code. The plugin panel shows `xoloop` marketplace with
`xoloop` plugin enabled.

## First run in a foreign repo

The plugin bootstraps automatically. First `xo-*` invocation detects the
repo's test command and generates `overnight.yaml` / `objective.yaml`.

**The first mutating run defaults to `--dry-run`** — review the proposal,
then re-run with `--apply` to land changes.

## Directory layout

```
xoloop-plugin/
├── .claude-plugin/plugin.json      # plugin manifest
├── lib/                            # 73 bundled framework files (from proving-ground/lib)
├── bin/                            # CLI wrappers + subagent bridge
│   ├── xoloop-apply-proposal.cjs   # ⭐ subagent → engine bridge (default path)
│   ├── classify-intent.cjs         # UserPromptSubmit hook classifier
│   ├── xoloop-{polish,build,audit,fuzz,benchmark,improve,autoresearch,overnight,init}.cjs
│   └── _common.cjs                 # shared: bootstrap, dirty-gate, buildExternalProposalLoader
├── skills/                         # 8 SKILL.md files (subagent-driven by default)
├── commands/                       # 8 slash commands (/xo-polish etc.)
├── hooks/hooks.json                # UserPromptSubmit → classifier
├── defaults.yaml                   # language-aware bootstrap
└── scripts/bundle-framework.cjs    # sync lib/ from source-of-truth
```

## Safety posture

- **Atomic apply** — every changeSet goes through temp-file-stage +
  fs.renameSync with SHA-256 verificationManifest TOCTOU gate
- **Worktree isolation** — every mutating mode can run in `git worktree`
  (`--worktree` flag)
- **Dirty-overlap gate** — refuses to run when uncommitted changes
  overlap the surface unless `--allow-dirty` explicitly passed
- **Respects `.gitignore`** + plugin-specific `.xoloop-ignore`
- **Opt-in for auto-exec** — `--allow-benchmark-exec`,
  `--allow-directive-exec`, `--allow-fuzz-exec` required by default
  because those phases auto-execute committed files
- **Tiered secret detection** — hard-block canonical secret files +
  known key prefixes
- **Per-repo lock** for write modes, per-worktree for read-only
- **Credentials** — inherit from Claude Code session; fall back to env
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) only for EXTRA API-key path

## Where things live

| Category | Location | Why |
|---|---|---|
| Human-visible config + summaries | `.xoloop/` in repo | Reviewable, git-ignorable |
| Bulky state (logs, worktrees, corpora) | `${CLAUDE_PLUGIN_DATA}` | Survives plugin updates |
| Source of truth for framework | `/Users/mac/xoanonxoLoop/proving-ground/lib` (internal) | One repo for dev; plugin is a build artifact |

## Development

To iterate on framework code:

1. Edit source in `proving-ground/lib/` (internal repo)
2. Re-sync the plugin bundle:
   ```bash
   node scripts/bundle-framework.cjs
   ```
3. Verify:
   ```bash
   node scripts/bundle-framework.cjs --verify
   ```

## Design decisions

See `docs/ORACLE_QUESTION_XOLOOP_PLUGIN_DISTRIBUTION.md` in the source
repo for the locked 4-block decision log (Grok / Gemini / GPT-5 high
Oracles reviewed).

The subagent-default / API-key-extra split emerged from real-world
debug experience: a user hit `MISSING_API_KEY` while running xoloop-
polish on a foreign repo, and the engine had masked that error as
`planner-schema-failed`. Both issues fixed in the same commit that
introduced this README.

## License

MIT
