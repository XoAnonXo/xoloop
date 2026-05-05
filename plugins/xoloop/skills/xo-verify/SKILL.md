---
name: xo-verify
description: Use this skill when the user asks to verify code, create a machine-checkable goal contract, prove behavior with golden/fuzz/property checks, produce a verify card, or run the XOLoop /verify runtime. Creates and runs goal manifests under .xoloop/goals/<goal-id>/goal.yaml and writes append-only evidence ledgers. Not for changing implementation code except generated verification assets.
allowed-tools: Bash, Read, Edit, Write
---

# XOLoop — Verify Mode

Create and run machine-checkable goal contracts. Verification treats the
implementation as a black-box command interface and records reproducible
evidence instead of making vague correctness claims.

## When to invoke

- "verify this"
- "create a goal contract"
- "write verifications"
- "make a verify card"
- "prove this behavior with fuzz/golden/property tests"
- "run /verify"

## How to invoke

Create a JSON canonicalizer proving-ground goal:

```bash
xoloop-verify create --target <path> --kind json-canonicalizer --goal-id <id>
```

Create a repo-wide discovery and gap-analysis gate:

```bash
xoloop-verify discover --write --json
xoloop-verify create --kind discovery-suite --goal-id discovery-suite --force
xoloop-verify run .xoloop/goals/discovery-suite/goal.yaml --json
```

Create a conservative frontend verification envelope:

```bash
xoloop-verify scan --json
xoloop-verify create --kind frontend-suite --goal-id frontend-suite --url http://localhost:3000 --force
xoloop-verify run .xoloop/goals/frontend-suite/goal.yaml --update-baselines --json
xoloop-verify run .xoloop/goals/frontend-suite/goal.yaml --json
```

Create a deep CLI verification envelope:

```bash
xoloop-verify scan --surface cli --json
xoloop-verify create --kind cli-suite --target "node cli.cjs" --goal-id cli-suite --force
```

Create an API/backend verification envelope:

```bash
xoloop-verify scan --surface api --json
xoloop-verify create --kind api-suite --base-url http://127.0.0.1:3000 --goal-id api-suite --force
```

Create a database/state verification envelope:

```bash
xoloop-verify scan --surface state --json
xoloop-verify create --kind state-suite --goal-id state-suite --force
```

Create a state-machine/workflow verification envelope:

```bash
xoloop-verify scan --surface state-machine --json
xoloop-verify create --kind state-machine-suite --goal-id state-machine-suite --command "node replay-workflow.cjs" --force
```

Create a concurrency/time/async verification envelope:

```bash
xoloop-verify scan --surface concurrency --json
xoloop-verify create --kind concurrency-suite --goal-id concurrency-suite --command "node async-replay.cjs" --force
```

Create a performance verification envelope:

```bash
xoloop-verify scan --surface performance --json
xoloop-verify create --kind performance-suite --goal-id performance-suite --command "npm run bench" --force
```

Create a formal/static verification envelope:

```bash
xoloop-verify scan --surface formal --json
xoloop-verify create --kind formal-suite --goal-id formal-suite --force
```

Create a whole-repo suite orchestration envelope:

```bash
xoloop-verify create --kind suite --goal-id suite --surfaces cli,frontend,api,state,state-machine,performance,formal --force
xoloop-verify run .xoloop/goals/suite/goal.yaml --json
xoloop-verify run .xoloop/goals/suite/goal.yaml --suite formal --case typecheck --json
```

For arbitrary repositories, prefer a hand-written `general-io` goal when
the contract is black-box input/output behavior:

```json
{
  "version": 0.1,
  "goal_id": "cli-contract",
  "interface": { "type": "cli", "command": "python app.py", "stdin": "text", "stdout": "json" },
  "artifacts": { "paths": ["app.py"] },
  "verify": {
    "kind": "general-io",
    "cases": "cases/*.json",
    "properties": ["deterministic", "stdout_json", "no_stderr"]
  }
}
```

Run the goal:

```bash
xoloop-verify run .xoloop/goals/<id>/goal.yaml --json
```

Show the evidence card:

```bash
xoloop-verify card .xoloop/goals/<id>/goal.yaml --json
```

## Semantics

- `FAIL`: current counterexample exists.
- `NO_EVIDENCE`: manifest exists but no current evidence has run.
- `PASS_WITH_GAPS`: executed checks passed, but declared checks are missing.
- `PASS_EVIDENCED`: all declared checks passed for the current manifest and artifact hashes.

## Verification ladder

- `command-suite`: named shell obligations such as tests, type checks,
  linters, model checkers, or proof tools.
- `general-io`: language-agnostic CLI contracts from case files,
  deterministic checks, JSON stdout checks, stderr constraints, and
  optional differential equivalence via `reference_command`.
- `cli-suite`: deep CLI envelope for commands, args, stdin, env, isolated
  filesystems, output contracts, generated files, side effects,
  deterministic reruns, differential references, performance budgets, and
  surface coverage gaps.
- `api-suite`: backend/API envelope for HTTP request/response traces,
  OpenAPI path/method/parameter parsing, GraphQL field/argument parsing,
  generated HTTP/GraphQL cases, Ajv-backed request and response schemas,
  live GraphQL introspection/execution, schema-derived negative fuzzing,
  auth invariants, exhaustive role/tenant matrix coverage,
  setup/teardown hooks, adapter-aware database side-effect checks,
  generated VCR proxy/replay fixtures, idempotency, retry behavior,
  error-shape compatibility, repeated p50/p95/p99 latency budgets,
  mutation score checks, traces, actuals, diffs, generated counterexample
  corpus files, and route/operation/status coverage gaps.
- `state-suite`: database/state envelope for Postgres/MySQL/SQLite/Redis
  native adapters, docker-compose/devcontainer orchestration,
  schema-aware canonical snapshots, redaction/masking,
  migration up/down/checksum/drift checks, fixture seed/reset strategies,
  transaction/savepoint rollback behavior, generated tenant matrices,
  query-log/WAL write evidence, action safety, write allowlists,
  forbidden writes, performance/state-size budgets, traces, diffs, and
  replayable state counterexamples.
- `state-machine-suite`: workflow/state-machine envelope for queues,
  editors, games, CRDTs, checkout/onboarding flows, reducers, and
  protocol workflows. Replays command/event sequences, checks initial and
  terminal states, validates transitions against a model, rejects
  impossible states, runs invariants after every step, compares against a
  reference model or reference command, verifies deterministic replay,
  reports transition coverage gaps, and writes replayable counterexample
  corpus files.
- `concurrency-suite`: async/time envelope for race conditions, ordering
  guarantees, timeout behavior, fake-clock control, deterministic
  scheduling, queues, retries, throttlers, debouncers, and workers.
  Replays declared schedules/interleavings, checks allowed race outcomes,
  systematically generates bounded schedules, runs seeded stress schedules,
  checks concrete fake-clock adapters, verifies runtime-specific scheduler
  evidence for Node/Python/Go/Rust style harnesses, detects
  deadlock/livelock/starvation signals, runs temporal invariant DSL rules,
  invokes static/runtime race tooling, compares optional reference traces,
  records timing metrics, and writes replayable counterexample corpus files
  with exact schedule, clock, seed, timeout, minimized schedule, and replay
  command.
- `performance-suite`: stable benchmark envelope for speed and resource
  optimization. Runs warmups and repeated measured samples, records
  p50/p95/p99, process-tree CPU/memory, bundle bytes, chunk/source-map
  attribution, cold start, built-in Playwright/web-vitals render timing,
  and request formation time, enforces environment gates,
  budgets/frozen baselines/regression guards, supports paired
  champion/challenger runs, and rejects claimed improvements inside
  bootstrap confidence noise.
- `formal-suite`: formal/static analyzer envelope for type checkers,
  linters, model checkers, symbolic execution, theorem provers,
  property/fuzz tools, and security analyzers. It includes language
  presets, generated property/fuzz harness templates, CodeQL/Semgrep/
  mypy/pyright/cargo/gosec/CBMC/KLEE/TLC/Coq/Lean parsers, SARIF/JUnit/
  JSON/JSONL/plain report normalization, proof/model artifact hashes,
  severity gates, function/module coverage maps, dependency installation
  guidance, opt-in live fixtures, and CI-native JSON/JUnit/SARIF/GitHub
  reports. Passing analyzers become evidence; failures become minimized
  replayable counterexamples with traces and diff/report artifacts.
- `frontend-suite`: conservative frontend envelope with visual
  perception, DOM/a11y semantics, interactions, network contracts,
  console/event traces, performance budgets, masks, baselines, actuals,
  diffs, built-in Playwright capture, and replayable counterexamples.
- `discovery-suite`: repo-wide observable-surface inventory and gap gate.
  It scans frontend, API, state, workflows, concurrency, performance,
  formal/static, CLI, and safety surfaces; crawls CI, deployment/IaC, runtime
  services/queues, mobile/native shells, monorepo package graphs, and
  coarse dataflow paths; records automatically verifiable areas; names
  uncovered risky gaps with semantic severity and mapped suite
  obligations; classifies safe clicks/actions, destructive operations,
  sensitive data flows, third-party side effects, and mock-vs-real
  execution decisions; reads `.xoloop/safety-policy.json` or YAML for
  org-specific policy; ingests prior frontend runtime traces; extracts
  schema-aware PII/secret signals; builds static taint flows and
  UI/runtime → API → state/third-party call graph paths; generates mock,
  VCR, sandbox, redaction, and runtime-crawl assets; suggests multi-step
  harness remediation; writes
  `.xoloop/discovery.json`; and blocks optimization until blocking gaps are
  covered by the specific required obligations or explicitly accepted by ID.
- `suite`: orchestration envelope that combines child goals under
  `suites/<surface>/` for CLI, frontend, API, DB/state, state-machine,
  performance, and formal/static checks. It prefixes obligations with the
  child id, namespaces metrics, and preserves exact replay via
  `--suite <id> --case <id>`.
- `json-canonicalizer`: proving-ground verifier with golden cases, fuzz,
  metamorphic properties, and benchmark cases.

## Agent workflow before optimization

When the user asks to make code faster, simpler, cheaper, or portable,
use Verify as the safety envelope before aggressive implementation work:

1. Identify observable boundaries: CLI, API, database state, browser UI,
   image/SVG/PDF output, file transform, protocol, or state machine.
2. Capture current behavior as a reference when no stronger spec exists.
3. Create golden cases for common paths, edge cases, failure paths, and
   user-critical scenarios.
4. Add properties such as determinism, idempotence, round-trip,
   monotonicity, schema validity, authorization invariants, visual
   invariants, or protocol invariants.
5. Add differential checks against the reference, a simpler model, or an
   external standard tool.
6. Add command-suite obligations for repo tests, type checks, static
   analyzers, model checkers, symbolic execution, or proof tools.
7. Run the goal and report the card. Start optimization only after
   `PASS_EVIDENCED`, unless the user explicitly accepts named gaps.

For visual/chart work, do not rely on text I/O alone. The intended future
shape is the `frontend-suite` verifier: launch Playwright, capture real
PNG screenshots, semantic DOM/a11y structure, interactions, network
formation, console/page errors, events, and browser performance under a
pinned render environment. Missing baselines or uncovered surfaces must
produce `PASS_WITH_GAPS`, and optimization must not proceed unless the user
explicitly accepts the named gaps.

For CLI work, prefer `cli-suite` over raw `general-io` when optimizing or
porting a real command surface. Generated cases run in isolated workspaces
by default and must verify args, stdin, env, stdout/stderr, file outputs,
side effects, determinism, reference equivalence when available, and
performance budgets. Uncovered discovered commands or missing output
oracles must produce `PASS_WITH_GAPS`.

For backend/API work, prefer `api-suite`. Cases should cover success,
auth denial, role/tenant permission matrices, validation errors, live
GraphQL introspection/execution, third-party VCR replay, state
setup/teardown, adapter-aware database side effects, retry/idempotency
behavior, generated schema-negative payloads, operation coverage, mutation
score, and latency confidence. Missing schemas, auth invariants, retry
rules, idempotency declarations, replay/state/DB fixtures, generated cases,
coverage, mutation tests, or latency budgets must stay visible as
`PASS_WITH_GAPS`.

For database/state work, prefer `state-suite`. Cases should use native
Postgres/MySQL/SQLite/Redis adapters or snapshot commands, start local
DB/dev containers when needed, seed/reset fixtures, snapshot state before
and after commands, redact unstable/sensitive columns, name allowed and
forbidden writes, read query logs or WAL-equivalent traces, declare data
invariants, include migration up/down/checksum/drift checks, add rollback
or savepoint commands, and generate tenant matrices for multi-tenant data.
Missing adapters, orchestration, snapshots, redactions, migrations,
rollback, fixtures, query logs, invariants, tenant isolation, budgets, or
write-boundary declarations must stay visible as `PASS_WITH_GAPS`.

For workflow/state-machine work, prefer `state-machine-suite`. Cases
should declare an initial state, command/event sequence, transition model,
impossible states, terminal states, invariants after each step, and a
reference model or command when available. Missing replay commands,
reference models, invariants, terminal states, impossible-state rules, or
transition coverage must stay visible as `PASS_WITH_GAPS`.

For concurrency/time/async work, prefer `concurrency-suite`. Cases should
declare replay commands, schedules/interleavings, fake-clock expectations,
ordering rules, allowed race outcomes, timeout expectations, repeat counts,
systematic exploration events, seeded stress runs, runtime scheduler
adapters, race-tool commands, deadlock/livelock terminal policy, temporal
invariants, and a reference trace command when available. Missing
schedules, generated schedule exploration, replay commands, ordering
rules, fake-clock adapters, runtime scheduler evidence, timeout oracles,
stress runs, race tooling, temporal rules, reference traces, or
deterministic replay evidence must stay visible as `PASS_WITH_GAPS`.

For performance work, prefer `performance-suite`. Cases should declare a
benchmark command, warmup count, repeated sample count, cooldown, budgets,
bundle files, baseline metrics, improvement targets, paired
`baseline_command` when possible, and noise/environment policy. Commands
may emit JSON metrics such as `cpu_ms`, `peak_memory_mb`,
`render_time_ms`, `request_formation_time_ms`, or `cold_start_ms`; URL
cases use built-in Playwright capture. Use `xoloop-verify
freeze-baselines <goal.yaml>` to pin current distributions. Missing
baselines, paired evidence, improvement targets, resource metrics, bundle
attribution, render or request timing, sample size, or budgets must stay
visible as `PASS_WITH_GAPS`.

For formal/static work, prefer `formal-suite`. Cases should wrap repo
type checkers, linters, model checkers, symbolic execution commands,
theorem prover commands, property/fuzz tools, and security analyzers.
Each case should declare its category, tool, command, expected exit code,
report files, proof/model files, covered files, covered functions/modules,
and forbidden output patterns or severity thresholds for security findings.
Missing categories or declared coverage gaps stay visible as
`PASS_WITH_GAPS`.

## Safety

- Verify mode may generate verification assets under `.xoloop/goals/`.
- Verify mode does not optimise implementation code.
- Always report the replay command and any counterexample path/id.
