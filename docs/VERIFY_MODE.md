# XOLoop Verify Mode

Verify mode is the contract-building layer for agentic optimization. Its
job is to turn "make this faster" or "rewrite this safely" into a
machine-checkable envelope around the current behavior before any agent is
allowed to experiment.

The central rule is simple:

> Implementation details are movable. Observable contracts are not.

An optimizer may change language, libraries, architecture, algorithms,
data structures, rendering backend, or deployment shape only when the
verification card remains `PASS_EVIDENCED` for the current manifest and
artifact hashes.

## What Verify Can Prove

Verify mode should be honest about assurance. Most production software
cannot be fully proven correct without a formal model, bounded state, and
tool-specific annotations. Verify therefore uses an assurance ladder:

| Level | Name | Meaning |
|---|---|---|
| L0 | Counterexample | A concrete failing input, command, image, trace, or invariant exists. |
| L1 | Golden evidence | Known examples and regression fixtures still match. |
| L2 | Property evidence | General properties pass generated and edge-case inputs. |
| L3 | Differential evidence | Candidate behavior matches a trusted reference/model. |
| L4 | Semantic evidence | Domain structure matches, not only bytes or pixels. |
| L5 | Formal evidence | A model checker, theorem prover, type checker, symbolic executor, or proof tool discharged declared obligations. |

`PASS_EVIDENCED` means all declared obligations for the selected ladder
levels passed. It does not mean universal mathematical proof unless the
manifest declares and passes L5 obligations.

## Universal Agent Workflow

When a user asks for speed, simplification, porting, or aggressive
rewrites, an agent should do this before optimization:

1. Detect observable boundaries: CLI, API, database, browser UI, image,
   SVG, PDF, file transform, network protocol, model output, or state
   machine.
2. Capture the current implementation as the reference when no better
   reference exists.
3. Generate or ask for representative cases that cover common paths,
   edge cases, failure paths, and user-critical scenarios.
4. Add properties: determinism, idempotence, round-trip, monotonicity,
   conservation laws, authorization invariants, schema constraints,
   visual invariants, or protocol invariants.
5. Add fuzz or generated cases when the input domain can be described.
6. Add differential checks against the reference implementation, a simple
   model, a spec implementation, or an external standard tool.
7. Add formal/static checks when available: type checking, linters,
   symbolic execution, model checking, proof commands, or contract
   checkers.
8. Record the card. Only begin optimization after the card reaches
   `PASS_EVIDENCED` or the user explicitly accepts known gaps.

## Contract Families

### Command and Text I/O

Use `general-io` for language-neutral command contracts. It supports
stdin, exit code, exact stdout/stderr, substring checks, JSON stdout,
determinism, no-stderr constraints, and differential equivalence against
`reference_command`.

This covers parsers, compilers, formatters, data transforms, calculators,
generators, and small services exposed through a CLI harness.

Use `cli-suite` when the command surface itself is the product. It scans
bins, scripts, language-specific CLI entrypoints, and shell scripts, then
verifies command cases in isolated workspaces. A strong CLI case can pin:

- command and args
- stdin and env vars
- expected exit code
- stdout/stderr exact, includes, regex, JSON, or schema contracts
- input fixtures and generated output files
- allowed and forbidden filesystem side effects
- deterministic reruns
- differential reference behavior
- wall-time and memory budgets

Uncovered discovered commands, missing stdout/stderr oracles, and missing
performance budgets remain explicit gaps. This is what allows a CLI to be
rewritten in another language while keeping its observable behavior fixed.

### Repo Obligations

Use `command-suite` for named shell obligations:

- unit tests
- integration tests
- type checks
- linters
- coverage gates
- model checkers
- theorem provers
- symbolic execution commands
- framework-specific verification commands

This is the bridge for formal tools. Verify does not need to implement
every prover internally; it needs to run them, name their obligations, hash
the artifacts, and preserve replayable evidence.

### Visual and Rendering Contracts

Rendering is not "just stdout." A chart, canvas, page, PDF, or image has
multiple observable layers:

- artifact bytes: canonical SVG, JSON scene graph, PDF, or PNG hash
- visual pixels: pixel diff, anti-alias-aware diff, SSIM/perceptual diff
- semantic structure: marks, axes, domains, ticks, labels, colors,
  legends, bounds, accessibility names
- interaction behavior: hover, zoom, click, keyboard, resize, animation
- performance: render time, memory, bundle size, FPS, layout shifts

The future `visual-regression` verifier should run reference and candidate
commands in a pinned environment, render deterministic artifacts, compare
semantic structure first, then image/perceptual diffs, then performance.

For charts, a strong manifest should check both:

- "It looks the same": image or SVG comparison within declared thresholds.
- "It means the same": data series, axis scales, tick labels, legend,
  colors, bounds, and annotations match.

Pixel-perfect checks alone are too brittle across fonts, antialiasing,
browser versions, GPUs, locales, and device pixel ratios. Perceptual
checks alone can miss semantic mistakes. Verify needs both.

### API and Backend Contracts

Backend verification should combine:

- request/response golden traces
- OpenAPI path/method/parameter parsing and GraphQL field/argument parsing
- Ajv-backed JSON Schema validation for request and response payloads
- live GraphQL introspection and execution checks
- status code and error shape checks
- generated negative cases for missing fields, wrong types, and bad auth
- adapter-aware database state invariants before and after commands
- idempotency and retry properties
- authorization, role, and tenant-isolation matrices with coverage checks
- generated VCR proxy record/replay for third-party integrations
- repeated p50/p95/p99 latency budgets with noise-aware rejection
- mutation score checks proving intentional contract breaks are caught
- contract coverage maps for every discovered route, operation, and status
- generated counterexample corpus files for replay

Use `api-suite` for HTTP APIs and backend boundaries. It treats each
endpoint case as a black-box request/response contract and records actuals,
traces, and diffs under the goal directory. A strong API case pins:

- method, path, headers, and request body
- expected status and headers
- request schema plus JSON response schema or expected payload shape
- error response shape for non-2xx cases
- auth denial behavior
- role/tenant auth matrix rows and required coverage dimensions
- setup and teardown hooks
- database snapshot command or adapter config plus side-effect invariant
- third-party expected/actual replay fixture paths or VCR recordings
- idempotency for safe/retryable operations
- retry behavior and acceptable statuses
- latency budgets and confidence run counts
- mutation commands and a required kill score

Schema files from OpenAPI, GraphQL, Prisma, or JSON schemas are discovered
by the scanner and tracked as artifacts. OpenAPI operations generate cases
from paths, methods, path/query/header parameters, request bodies, response
schemas, and status classes. GraphQL schema operations generate POST
`/graphql` cases from Query/Mutation/Subscription fields, args, and return
types; live introspection then confirms the running schema still exposes
those operations. Database adapters such as Prisma, Postgres, MySQL,
SQLite, MongoDB, TypeORM, Sequelize, Knex, and Drizzle are detected and
reported with snapshot hints. Missing auth, schema, retry, idempotency,
coverage, state hooks, database snapshots, VCR replay, fuzz, mutation, or
latency obligations remain explicit gaps.

### Database and State Contracts

Use `state-suite` when the mutable state itself is the behavior boundary:
SQL databases, JSON stores, embedded databases, caches persisted to disk,
tenant-scoped tables, migrations, or repository layers.

A strong state case pins:

- native adapter config for Postgres, MySQL, SQLite, or Redis, or a
  snapshot command that emits canonical JSON before and after the action
- docker-compose/devcontainer start, ready, and stop commands when local
  state services need orchestration
- fixture seed/reset commands for deterministic state
- schema-aware canonicalization with primary keys, stable row ordering,
  redacted columns, masks, and dynamic-field replacement
- migration up/down commands, checksum baselines, and drift commands
- command or transaction command under test
- rollback command, savepoint commands, or rollback-to-savepoint command
  that must restore the before snapshot
- data invariants such as unique IDs, non-negative balances, required
  rows, type checks, min/max counts, and equality checks
- generated tenant matrices from observed tenant fields, not only
  hand-written tenant rules
- query-log/WAL-equivalent write evidence for no unexpected writes
- destructive/sensitive action classification, with destructive actions
  blocked unless explicitly allowed or mocked
- allowed writes and forbidden writes by table/top-level key
- tenant isolation rules with collection, primary key, tenant field, and
  allowed/forbidden tenants
- performance and state-size budgets

The verifier stores `snapshots/before`, `snapshots/after`,
`snapshots/rollback`, `diffs`, `traces`, `migrations`, `invariants`,
`fixtures`, `logs`, `adapters`, and `orchestration` under
`.xoloop/goals/<goal-id>/`. It fails on counterexamples such as a changed
table outside the allowlist, an unlogged write, an invariant violation, a
migration checksum drift, a rollback that does not restore the original
snapshot, a blocked destructive action, a budget regression, or a mutation
to another tenant. Missing adapter, orchestration, snapshot, redaction,
migration, rollback, fixture, invariant, tenant, query-log, budget, or
write boundary declarations remain `PASS_WITH_GAPS`.

Generated workflow:

```bash
xoloop-verify scan --surface state --json
xoloop-verify create --kind state-suite --goal-id state-suite --force
xoloop-verify run .xoloop/goals/state-suite/goal.yaml --json
```

The repository test suite includes fast adapter-contract tests and an
opt-in live database lane:

```bash
npm run test:verify-state
npm run test:verify-state-live
```

The live lane exercises SQLite through `sqlite3` and Postgres/MySQL/Redis
through Docker-backed engines, so adapter snapshots are proven against
real CLIs without slowing the default test path.

### State Machines And Workflows

Use `state-machine-suite` when the behavior boundary is a command/event
sequence rather than one HTTP request or one database mutation: queues,
editors, games, CRDTs, checkout flows, onboarding flows, rate limiters,
protocol handshakes, workflow engines, and reducers.

A strong state-machine case pins:

- initial state
- command/event sequence
- replay command or observed trace
- transition model with `from`, `command`, and `to`
- impossible states and declared valid states
- expected terminal state
- invariants that must hold after every step
- reference model or reference command for differential replay

The verifier stores `traces`, `diffs`, and `corpus` under
`.xoloop/goals/<goal-id>/`. It fails on counterexamples such as an
undeclared transition, a transition target mismatch, an impossible state,
a final state mismatch, an invariant failure, nondeterministic replay, or
a difference from the reference model. It reports `PASS_WITH_GAPS` when
there is no replay command, no reference model, no invariant set, no
terminal state, or uncovered declared transitions.

Generated workflow:

```bash
xoloop-verify scan --surface state-machine --json
xoloop-verify create --kind state-machine-suite --goal-id state-machine-suite --command "node replay-workflow.cjs" --force
xoloop-verify run .xoloop/goals/state-machine-suite/goal.yaml --json
```

### Concurrency, Time, And Async

Use `concurrency-suite` when correctness depends on interleavings,
ordering, timeouts, fake clocks, retries, queues, throttlers, debouncers,
workers, promises, tasks, or other async schedules.

A strong concurrency case pins:

- replay command or observed async trace
- deterministic schedule/interleaving list
- systematic schedule exploration events and partial-order constraints
- seeded stress runs with reproducible seeds
- expected or allowed race outcomes
- event ordering guarantees such as `before` and `sequence`
- timeout expectations and duration budgets
- concrete fake-clock adapter, such as Sinon, Vitest/Jest timers,
  Python freezegun, Go clock adapters, or Rust/Tokio paused time
- runtime-specific deterministic scheduler evidence, such as Node
  `async_hooks`, Python asyncio/trio test loops, Go step barriers/race
  detector runs, or Rust Loom/Tokio paused-time runs
- repeated runs per schedule to reject nondeterminism
- deadlock/livelock/starvation policy and terminal events
- temporal invariants such as `eventually`, `never`, `before unless`,
  `after`, `within_ms`, and `count`
- static/runtime race tooling commands, such as `go test -race`, Loom
  tests, async-hooks lock-order checks, or repo-native stress checkers
- reference trace command when a simpler model or prior implementation is available

The verifier stores `traces`, `diffs`, and `corpus` under
`.xoloop/goals/<goal-id>/`. It fails on counterexamples such as a race
result outside the allowed set, an event ordering violation, an unexpected
timeout, missing clock-control evidence, nondeterministic replay for the
same schedule, failed seeded stress replay, deadlock/livelock/starvation,
a temporal invariant violation, race-tool output, or a trace that differs
from the reference command. Corpus entries include exact schedule, clock,
seed, timeout, minimized schedule, and a `replay-counterexample.cjs`
command. It reports `PASS_WITH_GAPS` when schedules, exploration, stress,
runtime schedulers, fake-clock adapters, ordering rules, temporal rules,
race tooling, replay commands, or reference traces are missing.

Generated workflow:

```bash
xoloop-verify scan --surface concurrency --json
xoloop-verify create --kind concurrency-suite --goal-id concurrency-suite --command "node async-replay.cjs" --force
xoloop-verify run .xoloop/goals/concurrency-suite/goal.yaml --json
```

### Performance Contracts

Use `performance-suite` when the optimization target is speed, resource
usage, bundle weight, startup, rendering, or request formation latency.

A strong performance case pins:

- benchmark command, warmup count, repeated measured sample count, and
  cooldown
- paired champion/challenger command when comparing an optimization
- p50, p95, and p99 latency evidence
- process-tree CPU time, peak RSS, bundle bytes, gzip bytes,
  chunk/source-map/dependency attribution, cold start, built-in
  Playwright/web-vitals render timing, and request formation time where
  relevant
- absolute budgets such as p95 under a target or bundle bytes below a
  limit
- frozen baseline distributions with sample counts/stddev when available
- improvement targets with a minimum effect size
- noise policy with minimum samples, stable metrics, max coefficient of
  variation, regression threshold, and confidence floor
- environment preflight gates for host load, power state, and warnings

The verifier stores `actual`, `diffs`, `traces`, `profiles`, `baselines`,
`bundles`, and `reports` under `.xoloop/goals/<goal-id>/`. It fails on
counterexamples such as p95 budget violations, insufficient samples,
unstable measurements, environment preflight failures, regressions beyond
noise, or claimed improvements that are statistically inside noise.
Missing baselines, paired runs, improvement targets, CPU/memory metrics,
bundle attribution, render/request timings, sample size, or budgets remain
`PASS_WITH_GAPS`.

Generated workflow:

```bash
xoloop-verify scan --surface performance --json
xoloop-verify create --kind performance-suite --goal-id performance-suite --command "npm run bench" --force
xoloop-verify freeze-baselines .xoloop/goals/performance-suite/goal.yaml --json
xoloop-verify run .xoloop/goals/performance-suite/goal.yaml --json
```

### Formal And Static Contracts

Use `formal-suite` when correctness is checked by static analyzers,
formal methods, proof tools, or security tooling.

A strong formal/static case pins:

- type checkers such as `tsc`, `mypy`, `pyright`, `cargo check`, or
  `go vet`
- linters such as ESLint, Biome, Ruff, Clippy, ShellCheck, or
  golangci-lint
- model checkers such as TLA+/TLC, Apalache, Alloy, Spin, or nuXmv
- symbolic execution tools such as KLEE, CBMC, Kani, angr, Manticore, or
  SeaHorn
- theorem provers such as Coq, Lean, Isabelle, Agda, Dafny, Why3, F*, or
  Frama-C/SPARK
- property/fuzz tools such as fast-check, Hypothesis, QuickCheck,
  proptest, cargo-fuzz, Go fuzzing, or Jazzer
- security analyzers such as Semgrep, Bandit, npm audit, cargo-audit,
  gosec, Snyk, Trivy, OSV-Scanner, CodeQL, or pip-audit
- language presets for TypeScript, Python, Rust, Go, Java, and C/C++
- generated property/fuzz harness templates agents can specialize
- severity gates for security analyzers
- a formal coverage map that names which files, models, proofs, and specs
  are actually covered
- tool-specific parsers for CodeQL, Semgrep, mypy, pyright, cargo, gosec,
  CBMC, KLEE, TLC, Coq, and Lean
- function/module-level coverage requirements for optimization-critical
  symbols
- CI-native JSON, JUnit XML, SARIF, and GitHub step-summary reports
- opt-in live fixtures for CI images with real analyzers installed

The verifier stores `actual`, `diffs`, `traces`, `reports`, `proofs`,
`models`, `corpus`, `security`, `normalized`, `coverage`, `templates`,
`presets`, `adapters`, `install`, `ci`, `replay`, and `live-fixtures`
under `.xoloop/goals/<goal-id>/`. It normalizes SARIF, JUnit, generic
JSON, JSONL, and plain-text analyzer output into a single finding schema,
hashes declared proof/model artifacts, extracts minimized replayable
counterexamples from model/symbolic/fuzz tools, and fails on type errors,
lint failures, model-checker counterexamples, symbolic execution findings,
failed proofs, fuzz/property crashes, or security findings above policy.
Missing analyzer categories or uncovered declared files/functions/modules
remain `PASS_WITH_GAPS`.

Generated workflow:

```bash
xoloop-verify scan --surface formal --json
xoloop-verify create --kind formal-suite --goal-id formal-suite --force
xoloop-verify run .xoloop/goals/formal-suite/goal.yaml --json
```

## Chart Renderer Example

Goal: make a chart renderer faster while preserving user-visible output.

Verification envelope:

1. Cases: line chart, bar chart, stacked chart, empty series, long labels,
   negative values, log scale, dense ticks, responsive resize, theme
   variants, RTL/locale cases.
2. Reference: current renderer command.
3. Candidate: proposed renderer command, maybe JS, Rust, C, or WASM.
4. Semantic extractor: emits normalized chart IR:
   series, scales, domains, ticks, labels, colors, legend, mark bounds.
5. Visual renderer: emits PNG at fixed viewport, DPR, fonts, locale, and
   browser version.
6. Checks:
   - normalized chart IR exactly matches
   - required text exists
   - mark bounds are within tolerance
   - pixel/perceptual diff is below threshold
   - no unexpected console errors
   - render time improves

Only after this envelope passes should an agent try aggressive rewrites.

## Suite Orchestration

Use `verify.kind: suite` when one optimization envelope must combine
multiple surfaces. `xoloop-verify create --kind suite` writes a top-level
goal plus child goals under `suites/<surface>/` for CLI, frontend, API,
DB/state, state-machine, performance, and formal/static checks. The runner
executes child goals through the same evidence ledger, prefixes every
obligation with the suite id, namespaces metrics, and keeps exact replay
selection with `--suite <id> --case <id>`.

```json
{
  "interface": { "type": "suite", "command": "xoloop verify suite" },
  "verify": {
    "kind": "suite",
    "obligations": [
      { "id": "cli", "kind": "cli-suite", "goal_path": "suites/cli/goal.yaml", "cases": "cases/*.json" },
      { "id": "frontend", "kind": "frontend-suite", "goal_path": "suites/frontend/goal.yaml", "cases": "cases/*.json" },
      { "id": "api", "kind": "api-suite", "goal_path": "suites/api/goal.yaml", "cases": "cases/*.json" },
      { "id": "state", "kind": "state-suite", "goal_path": "suites/state/goal.yaml", "cases": "cases/*.json" },
      { "id": "state-machine", "kind": "state-machine-suite", "goal_path": "suites/state-machine/goal.yaml", "cases": "cases/*.json" },
      { "id": "performance", "kind": "performance-suite", "goal_path": "suites/performance/goal.yaml", "cases": "cases/*.json" },
      { "id": "formal", "kind": "formal-suite", "goal_path": "suites/formal/goal.yaml", "cases": "cases/*.json" }
    ]
  }
}
```

The current implementation supports `general-io`, `command-suite`,
`cli-suite`, `api-suite`, `frontend-suite`, `state-suite`,
`state-machine-suite`, `concurrency-suite`, `performance-suite`,
`formal-suite`, `discovery-suite`, `suite`, and the proving-ground
`json-canonicalizer`.

### Discovery Suite Manifest

`discovery-suite` is the repo-wide gap-analysis gate. It runs the full
scanner and writes `.xoloop/discovery.json` plus goal-local reports. The
report names:

- all detected observable surfaces
- which surfaces can be verified automatically
- uncovered risky areas and stable gap IDs
- CI, deployment/IaC, runtime services/queues, mobile/native shells, and
  monorepo package graph surfaces
- coarse dataflow paths such as frontend → API → state, API → queue →
  state, or CLI → state
- safety classification for safe clicks/actions, destructive operations,
  sensitive data flows, third-party side effects, and mock-vs-real
  execution decisions
- user safety policy overrides from `.xoloop/safety-policy.json` or YAML
- schema-aware PII/secret signals, static taint flows, runtime browser
  traces, and UI/runtime → API → state/third-party call-graph paths
- generated safety enforcement assets: mock plans, VCR stubs, sandbox
  requirements, redaction masks, and runtime crawl cases
- semantic severity, risk reason, and exact suite obligations required to
  cover each gap
- suggested harness commands for each detected surface
- multi-step remediation plans per blocking gap
- whether optimization is blocked

Generated workflow:

```bash
xoloop-verify discover --write --json
xoloop-verify scan --surface safety --json
xoloop-verify create --kind discovery-suite --goal-id discovery-suite --force
xoloop-verify run .xoloop/goals/discovery-suite/goal.yaml --json
```

Optimization reads `.xoloop/discovery.json`. If it contains unaccepted
blocking gaps, optimisation stops before the champion verification run.
Gaps should normally be covered by generated suite harnesses. Coverage is
obligation-level: an existing harness covers a gap only when the mapped
obligations have current passing evidence, even if the wider suite still
has unrelated gaps. A user can also accept named gap IDs when the residual
risk is understood. Safety gaps are intentionally conservative: real
local/dev systems are preferred for read-only or rollback-backed actions,
while destructive, sensitive, ambiguous, and third-party side-effecting
actions require mocks, sandboxes, VCR recordings, transaction protection,
or explicit acceptance before optimization proceeds; accepted residual risk
is deliberate and recorded. The generated discovery goal writes safety
assets under `.xoloop/goals/<id>/safety/`, so agents can turn the
classification into concrete API VCR fixtures, frontend runtime crawls,
state redaction masks, and sandbox requirements instead of hand-waving.

### Frontend Suite Manifest

`frontend-suite` is the first universal frontend envelope. It stores all
artifacts under `.xoloop/goals/<goal-id>/`:

- `baselines/`: expected visual/semantic/network/performance observations
- `actual/`: latest observations
- `diffs/`: failure diffs
- `traces/`: console, network, event, and performance traces
- `masks/`: dynamic-region masks
- `cases/`, `flows/`, `budgets/`: declared coverage inputs

The generated capture command uses the built-in Playwright capture library.
It reads a case JSON object on stdin and writes a JSON observation on
stdout. Repos can still replace `verify.capture_command` with Cypress,
Storybook, or any repo-native capture tool if that is a stronger local
oracle.

Minimum observation shape:

```json
{
  "visual": { "width": 2, "height": 2, "pixels": [0, 0, 255, 255] },
  "dom": [{ "selector": "#save", "role": "button", "name": "Save", "enabled": true }],
  "accessibility": [{ "role": "button", "name": "Save" }],
  "interactions": [{ "action": "click", "selector": "#save", "result": "saved" }],
  "network": [{ "method": "POST", "url": "/api/save", "body": { "draft": false } }],
  "events": [{ "name": "save", "payload": { "draft": false } }],
  "console": [{ "level": "info", "text": "ready" }],
  "performance": { "render_ms": 30, "request_build_ms": 20, "api_ms": 120 }
}
```

Generated workflow:

```bash
xoloop-verify scan --json
xoloop-verify create --kind frontend-suite --goal-id frontend-suite --url http://localhost:3000 --force
xoloop-verify run .xoloop/goals/frontend-suite/goal.yaml --update-baselines --json
xoloop-verify run .xoloop/goals/frontend-suite/goal.yaml --json
```

The Playwright capture pins viewport, browser, DPR, locale, color scheme,
and reduced motion. It records PNG screenshots, DOM structure, accessibility
snapshot where the browser exposes it, safe interactions, discovered safe
actions, network requests/responses, console/page errors, custom
`xoloop:*` events, and browser performance timings. Dynamic masks hide or
ignore unstable screenshot/DOM/network/event regions before comparison.

Optimization remains blocked until the frontend card reaches
`PASS_EVIDENCED`; missing baselines produce `PASS_WITH_GAPS`.

## Design Principles

- Verify observable behavior, not source shape.
- Prefer deterministic replay over subjective claims.
- Separate semantic equality from artifact equality.
- Capture counterexamples so failures become new fixtures.
- Make gaps explicit; never call partial evidence proof.
- Allow domain-specific verifiers to plug into the same evidence ledger.
- Treat formal methods as the highest rung, not the only rung.
- Let optimization be wild only after contracts are strict.
