# XOLoop — Claude Code Plugin

Loop-based code improvement framework for Claude Code. Install once; every
Claude Code session in any repo gains 8 iterative modes that cannot be
forgotten under task pressure.

## The 8 modes

| Mode | Trigger phrases | What it does |
|---|---|---|
| **xo-build** | "build a new…", "implement…", "scaffold…" | Serialized TDD: failing tests first, then implementation, red→green validated |
| **xo-polish** | "polish…", "refine…", "clean up…", "tighten…" | Tournament-based refinement on existing code, loops until saturation |
| **xo-fuzz** | "fuzz…", "property-test…", "find edge cases…" | fast-check property fuzzing; writes crash corpus for CI replay |
| **xo-benchmark** | "benchmark…", "lock the output of…" | SHA-256-locked deterministic behavior tests |
| **xo-improve** | "make X faster", "reduce memory of…", "hit this benchmark" | Benchmark-driven iteration toward a metric |
| **xo-audit** | "audit…", "find bugs in…", "security review…" | Codex auditor + Opus fixer loop; fails closed on protocol drift |
| **xo-autoresearch** | "research alternatives to…", "is there a better way…" | Champion vs Challenger tournament with heterogeneous council |
| **xo-overnight** | "run overnight", "full XO pipeline" | Orchestrator chaining polish + fuzz + benchmark + improve + audit |

## Why this exists

CLAUDE.md entries and slash commands are **soft reminders** — the model reads
them once near session start, then task pressure dominates. The default
behavior (writing code directly) always wins the shortest-path race.

This plugin gives the framework **teeth**:

1. **Skills** surface in Claude Code's `<system-reminder>` blocks. When user
   intent matches, Claude is required to invoke the skill before responding.
2. **An adaptive UserPromptSubmit hook** classifies every prompt against 8
   trigger sets. When the prompt matches XOLoop-shaped intent, it injects a
   routing hint. When it doesn't, it stays silent (no banner-blindness).
3. **Slash commands** (`/xo-polish`, `/xo-audit`, …) for direct invocation
   when you want to bypass skill-routing.

## Installation

### Sideload (recommended for power users)

```bash
git clone <this repo> ~/.claude/plugins/xoloop
```

Claude Code picks up the plugin on next session start. Verify with `/plugin list`.

### Per-repo (scoped to one project)

Clone into the target repo's `.claude-plugin/` directory.

## First run in a foreign repo

The plugin bootstraps automatically. First time you invoke any `xo-*` command,
the wrapper runs `xoloop-init` to detect the project's test command, source
layout, and surface boundaries, then generates `overnight.yaml` +
`objective.yaml`.

**The very first mutating run in each repo defaults to `--dry-run`** (locked
D.7 from Oracle review). Review the proposed changeset, then re-run with
`--apply`.

## Directory layout

```
xoloop-plugin/
├── .claude-plugin/plugin.json      # plugin manifest
├── lib/                            # bundled framework code (73 files, from proving-ground/lib)
├── bin/                            # thin CLI wrappers per mode
├── skills/                         # 8 narrow skills with trigger-phrase descriptions
├── commands/                       # 8 slash commands
├── hooks/hooks.json                # registers UserPromptSubmit → classify-intent.cjs
├── defaults.yaml                   # language-aware bootstrap defaults
└── scripts/bundle-framework.cjs    # syncs lib/ from source-of-truth
```

## Safety posture (locked from Oracle review)

- **Worktree isolation.** Every mutating mode runs in `git worktree add`.
  Dirty changes that overlap the requested surface are refused unless you
  pass `--allow-dirty` to snapshot them.
- **Gitignore respected.** Plus a plugin-specific `.xoloop-ignore` for
  extra carve-outs.
- **Untracked files untouched** unless explicitly named in the surface.
- **Tiered secret detection.** Hard-block canonical secret files
  (`.env`, `*.pem`, `credentials.json`) + known key prefixes (`sk-*`,
  `AKIA*`, `ghp_*`). Soft-warn on ambiguous high-entropy inline strings.
- **Per-repo lock** for write modes; **per-worktree lock** for read modes
  (benchmark, fuzz, read-only audit).
- **Credentials** inherit from Claude Code session; fall back to env vars
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).

## Development

To iterate on the framework code:

1. Edit source of truth in `/Users/mac/xoanonxoLoop/proving-ground/lib/`
2. Re-sync the plugin bundle:
   ```bash
   node scripts/bundle-framework.cjs
   ```
3. Verify bundle matches source:
   ```bash
   node scripts/bundle-framework.cjs --verify
   ```

## Where things live

| Category | Location | Reason |
|---|---|---|
| Human-visible config + summaries | `.xoloop/` in repo | Reviewable, git-ignorable |
| Bulky state (logs, worktrees, corpora) | `${CLAUDE_PLUGIN_DATA}` | Survives plugin updates, doesn't pollute repo |
| Source of truth for framework | `/Users/mac/xoanonxoLoop/proving-ground/lib` | One repo for dev; plugin is a build artifact |

## Design decisions

See `docs/ORACLE_QUESTION_XOLOOP_PLUGIN_DISTRIBUTION.md` in the source
repo for the full decision log — 4 decision blocks, 3 Oracle verdicts
(Grok, Gemini, GPT-5 high), locked resolutions with rationale.

## License

MIT
