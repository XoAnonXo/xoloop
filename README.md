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

## Language parity gate

XOLoop tracks parity across JS/TS, Python, Rust, Go, Ruby, Java,
Kotlin, C#/.NET, Swift, C, and C++. Full support means every supported
language reaches the same mode coverage as the JS/TS reference path.
The parity gate is intentionally strict:

```
JS/TS reference capability
        ↓
Python / Rust / Go / Ruby / JVM / .NET / Swift / C/C++ capability
        ↓
all languages × all modes must have local adapter parity
        ↓
live subagent/API modes are reported separately
        ↓
release allowed
```

Run the gate:

```bash
npm test
node plugins/xoloop/bin/xoloop-completeness.cjs
```

`xoloop-completeness` exits nonzero until every language has local
adapter parity across the 11 user-facing modes. It also tracks `init`
as setup coverage, and reports live-agentic proof for modes that need
subagents/API-backed proposers. Use
`--require-live-agentic` when the release must prove those live paths too,
and `--allow-incomplete` only when you want a report without failing the
shell command. Partial, skipped, missing, or blocked cells do not count as
adapter complete.

## Verify mode contracts

`xo-verify` turns correctness into replayable evidence under
`.xoloop/goals/<goal-id>/`. A goal hashes the manifest plus declared
artifacts, runs black-box obligations, appends evidence to
`evidence.jsonl`, and emits a card with `FAIL`, `NO_EVIDENCE`,
`PASS_WITH_GAPS`, or `PASS_EVIDENCED`.

The generic path is `verify.kind: general-io`: put JSON case files under
`cases/*.json`, declare a CLI command, and Verify checks exit code,
exact/substring stdout and stderr expectations, plus optional properties
such as `deterministic`, `stdout_json`, `no_stderr`, and
`differential_reference` against `verify.reference_command`. This makes
the contract language-neutral: Python, Rust, Java, shell, or a compiled
binary are all just commands with inputs and observable outputs.

For repo-wide optimization readiness, use `verify.kind: discovery-suite`.
`xoloop-verify discover --write` and `xoloop-verify scan --surface
discovery` run the full scanner across frontend, API, state, workflows,
concurrency, performance, formal/static, CLI, and safety surfaces. The
report lists observable surfaces, what Verify can cover automatically,
safe/review/mock/block action classifications, uncovered risky areas, and
suggested harness commands. `xoloop-verify scan --surface safety` prints
the mock-vs-real policy and classified actions directly. Creating a
`discovery-suite` goal writes discovery evidence under
`.xoloop/goals/<id>/` and updates `.xoloop/discovery.json`. Optimization
is blocked while that ledger contains unaccepted blocking gaps. Discovery
also crawls CI, deployment/IaC, runtime services/queues, mobile/native
shells, monorepo package graphs, and coarse dataflow paths such as
frontend → API → state or API → queue → state. Gaps carry semantic
severity, required suite obligations, and multi-step remediation plans.
Safety gaps classify safe clicks/actions, destructive operations,
sensitive data flows, third-party side effects, and whether Verify should
use real local/dev systems, mocks, sandboxes, VCR recordings, or hard
blocks. Safety now also reads an optional `.xoloop/safety-policy.json` or
YAML file for org-specific allowlists/blocklists, ingests frontend runtime
trace JSON from prior browser captures, extracts schema-aware PII/secret
signals from OpenAPI, GraphQL, Prisma, and policy keys, builds static
taint evidence from request/browser inputs into database and third-party
sinks, and records UI/runtime → API → state/third-party call-graph paths.
Discovery goal creation writes generated safety assets under
`.xoloop/goals/<id>/safety/`: policy templates, mock plans, VCR fixture
stubs, sandbox requirements, redaction masks, and a runtime crawl case.
Existing harnesses cover a gap only when the specific mapped obligations
have current passing evidence; a suite-level partial pass no longer hides
unrelated holes. Users can cover gaps by creating the suggested suite
harnesses, or explicitly accept named gap IDs in the discovery goal when
the risk is understood.

For serious CLI optimization, use `verify.kind: cli-suite`.
`xoloop-verify scan --surface cli` discovers package bins/scripts,
Python argparse/click/typer CLIs, Rust/Go entrypoints, and shell scripts.
`xoloop-verify create --kind cli-suite` generates isolated cases and
directories for fixtures, expected outputs, actuals, diffs, traces, and
corpus captures. `cli-suite` verifies args, stdin, env, exit code,
stdout/stderr contracts, generated files, filesystem side effects,
determinism, differential references, and performance budgets. Uncovered
commands or missing output/performance oracles produce `PASS_WITH_GAPS`.

For backend/API optimization, use `verify.kind: api-suite`.
`xoloop-verify scan --surface api` discovers route/controller files,
OpenAPI paths/methods/parameters, GraphQL fields/args, schema files,
backend frameworks, and local serve/test commands. `xoloop-verify create
--kind api-suite` generates HTTP and GraphQL cases plus
trace/actual/diff/schema/corpus directories. `api-suite` verifies status
codes, headers, Ajv-backed JSON Schema semantics for request/response
schemas, expected payload shape, error-shape compatibility, live GraphQL
introspection and execution, auth denial invariants, exhaustive role/tenant
matrix coverage, setup/teardown hooks, adapter-aware database side-effect
snapshots, generated VCR proxy/replay fixtures for third-party calls,
idempotency, retry behavior, repeated p50/p95/p99 latency budgets,
schema-derived negative fuzz cases, mutation score, and contract coverage
for every discovered route/operation/status class. Missing schemas, auth
rules, coverage, replay fixtures, state hooks, DB snapshots,
retry/idempotency declarations, generated negative cases, mutation tests,
or latency budgets produce `PASS_WITH_GAPS`.

For database/state optimization, use `verify.kind: state-suite`.
`xoloop-verify scan --surface state` discovers Prisma/Drizzle/Knex,
Rails/Django/Alembic-style migrations, schema files, state repositories,
Postgres/MySQL/SQLite/Redis adapter hints, docker-compose/devcontainer
orchestration, and migration/snapshot/rollback/seed/reset scripts.
`xoloop-verify create --kind state-suite` generates cases, native adapter
guidance, snapshot helpers, invariant files, and
snapshots/diffs/traces/migrations/fixtures/logs directories.
`state-suite` verifies native DB snapshots through `psql`, `mysql`,
`sqlite3`, or `redis-cli` when declared, schema-aware canonical snapshots,
redaction/masking, before/after state, migration up/down/checksum/drift,
fixture seed/reset, local DB orchestration, action safety, true
transaction/savepoint hooks, generated tenant matrices, query-log/WAL
write evidence, write allowlists, forbidden writes, rollback restoration,
performance budgets, and state-size budgets. Missing adapter,
orchestration, snapshot, redaction, migration, rollback, invariant,
tenant, query-log, fixture, or budget declarations produce
`PASS_WITH_GAPS`. Native adapter behavior is covered by fast fake-CLI tests
and opt-in live engine tests via `npm run test:verify-state-live`, which
exercise SQLite directly and Postgres/MySQL/Redis through Docker.

For state-machine and workflow optimization, use
`verify.kind: state-machine-suite`. `xoloop-verify scan --surface
state-machine` detects XState/Robot/Redux/Zustand, queues, Temporal-style
workflows, CRDT libraries, editor/game/checkout/onboarding flow files,
statechart model files, and replay scripts. `xoloop-verify create --kind
state-machine-suite` generates workflow cases, a transition model, and
trace/diff/corpus directories. `state-machine-suite` replays command/event
sequences, verifies initial and terminal states, checks every observed
transition against the model, rejects impossible or undeclared states,
checks invariants after every step, compares implementation traces against
a reference model or reference command, verifies deterministic replay, and
reports transition coverage gaps. This is the envelope for queues,
editors, games, CRDTs, checkout flows, onboarding flows, and other
workflow engines.

For concurrency, time, and async optimization, use
`verify.kind: concurrency-suite`. `xoloop-verify scan --surface
concurrency` detects fake-clock libraries, promise/queue schedulers,
async locks, worker/retry/timeout files, deterministic schedule files, and
async replay scripts for Node, Python, Go, and Rust. `xoloop-verify
create --kind concurrency-suite` generates replay cases, schedule and
stress inputs, fake-clock/runtime-scheduler adapter templates, traces,
diffs, and replayable corpus directories. `concurrency-suite` explores
declared and generated interleavings, runs seeded stress schedules,
verifies race outcomes, ordering guarantees, timeout behavior,
fake-clock adapters, deterministic runtime schedulers, deadlock/livelock
policies, temporal invariant DSL rules, static/runtime race tooling, and
optional reference traces. Counterexamples include exact schedule, clock,
seed, timeout, minimized schedule, and replay command. This is the
envelope for race-condition fixes, queue workers, retries, throttlers,
clock-sensitive code, debounced UI behavior, and any async refactor where
"it usually works" is not strong enough.

For performance optimization, use `verify.kind: performance-suite`.
`xoloop-verify scan --surface performance` discovers benchmark/perf
scripts, perf source files, Lighthouse/web-vitals/benchmark tooling, build
tools, and bundle artifacts. `xoloop-verify create --kind
performance-suite` generates repeated benchmark cases, baselines, actuals,
diffs, traces, profiles, and bundle reports. `performance-suite` runs
warmups plus stable measured samples, can alternate paired
champion/challenger runs, records p50/p95/p99, process-tree CPU/memory,
bundle bytes and gzip bytes, chunk/source-map/dependency attribution, cold
start, built-in Playwright/web-vitals render timing, and request formation
time when available. It enforces environment preflight gates, absolute
budgets, frozen baselines, regression guards, bootstrap confidence
intervals, and rejects claimed improvements that do not clear a
noise-adjusted floor. `xoloop-verify freeze-baselines <goal.yaml>` captures
baseline distributions. Missing baselines, paired benchmarks, improvement
targets, CPU/memory/resource metrics, bundle attribution, render/request
timings, sample size, or budgets produce `PASS_WITH_GAPS`.

For formal and static verification, use `verify.kind: formal-suite`.
`xoloop-verify scan --surface formal` discovers type checkers, linters,
model checkers, symbolic execution tools, theorem provers, property/fuzz
tools, and security analyzers from package scripts, configs, dependencies,
and formal/spec files. `xoloop-verify create --kind formal-suite`
generates runnable analyzer cases plus actual/diff/trace/report/proof/
model/corpus/security/normalized/coverage/templates/presets/adapters/
install/ci/replay/live-fixtures artifact directories. `formal-suite`
treats each tool as executable evidence: passing analyzers record proof
traces and artifact hashes, while CodeQL, Semgrep, mypy, pyright, cargo,
gosec, CBMC, KLEE, TLC, Coq, Lean, SARIF, JUnit, generic JSON, JSONL, and
plain analyzer output is normalized into one finding schema. Type errors,
lint failures, model counterexamples, symbolic execution findings, failed
proofs, fuzz crashes, or security findings over the configured severity
gate become minimized replayable counterexamples. Coverage tracks files,
modules, functions, specs, proofs, and models. Missing analyzer categories
or uncovered files/symbols remain `PASS_WITH_GAPS`; CI reports are emitted
as JSON, JUnit XML, SARIF, and GitHub step-summary Markdown.

Use `verify.kind: suite` when a whole-repo optimization needs one
orchestrated envelope across surfaces. `xoloop-verify create --kind suite`
generates child goals under `suites/<surface>/` for detected or requested
CLI, frontend, API, DB/state, state-machine, performance, and
formal/static suites. `xoloop-verify run` executes them as one goal,
prefixes every obligation with the child id, namespaces metrics such as
`cli:wall_time_ms`, and preserves replay commands like
`--suite formal --case typecheck` for exact counterexamples.

Use `command-suite` for named repo obligations like `npm test`, `cargo
test`, type checks, static analyzers, model checkers, or external formal
proof tools. Use specialized verifiers, such as `json-canonicalizer`, when
the domain has richer built-in oracles, fuzzers, and metamorphic
properties.

`frontend-suite` is the conservative frontend envelope. `xoloop-verify
scan` discovers frameworks, scripts, routes, components, Storybook/test
tools, and API schemas. `xoloop-verify create --kind frontend-suite`
generates cases, masks, budgets, baselines/actual/diff/trace directories,
and a built-in Playwright capture harness. It verifies real screenshot
perception, DOM/a11y semantics, interactions, network formation, emitted
events, console cleanliness, and performance budgets. Missing baselines or
uncovered surfaces produce `PASS_WITH_GAPS`, which blocks optimisation by
default.

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
│   ├── xoloop-completeness.cjs     # language parity release gate
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
