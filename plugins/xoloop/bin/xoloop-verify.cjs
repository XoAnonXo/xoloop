#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

function ensureModernNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isFinite(major) && major >= 16) return;
  const candidates = [
    '/opt/homebrew/bin/node',
    '/Applications/Codex.app/Contents/Resources/node',
    `${process.env.HOME || ''}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`,
  ].filter(Boolean);
  const modern = candidates.find((candidate) => fs.existsSync(candidate) && candidate !== process.execPath);
  if (!modern) return;
  const result = spawnSync(modern, [__filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

ensureModernNode();

const {
  hasFlag,
  parseFlag,
  requireLib,
} = require('./_common.cjs');

const {
  buildVerifyCard,
  createGoal,
  discoverRepo,
  formatVerifyCard,
  runGoalVerify,
  scanApiRepo,
  scanCliRepo,
  scanConcurrencyRepo,
  scanFormalRepo,
  scanFunctionRepo,
  scanFrontendRepo,
  scanPerformanceRepo,
  buildRuntimeLabPlan,
  scanStateMachineRepo,
  scanStateRepo,
} = requireLib('goal_verify_runner.cjs');
const { makeImprovementGoal } = requireLib('goal_maker.cjs');
const { decideTradeoff, listTradeoffs } = requireLib('goal_tradeoffs.cjs');

function printHelp() {
  console.log([
    'Usage:',
    '  xoloop-verify create --target <path> --kind json-canonicalizer --goal-id <id> [--force]',
    '  xoloop-verify create --kind cli-suite --target "node cli.js" --goal-id <id> [--force]',
    '  xoloop-verify create --kind api-suite --url http://127.0.0.1:3000 --goal-id <id> [--force]',
    '  xoloop-verify create --kind frontend-suite --goal-id <id> [--url http://localhost:3000] [--force]',
    '  xoloop-verify create --kind state-suite --goal-id <id> [--force]',
    '  xoloop-verify create --kind state-machine-suite --goal-id <id> [--command "node replay.js"] [--force]',
    '  xoloop-verify create --kind concurrency-suite --goal-id <id> [--command "node async-replay.js"] [--force]',
    '  xoloop-verify create --kind performance-suite --goal-id <id> [--command "npm run bench"] [--force]',
    '  xoloop-verify create --kind formal-suite --goal-id <id> [--force]',
    '  xoloop-verify create --kind suite --goal-id <id> [--surfaces cli,frontend,api,state,state-machine,performance,formal|all|detected] [--force]',
    '  xoloop-verify create --kind discovery-suite --goal-id <id> [--force]',
    '  xoloop-verify make-goal --objective "make backend cheaper" [--target backend|frontend|state|cli|fullstack] [--metric speed|cost|memory|size] [--goal-id <id>] [--force]',
    '  xoloop-verify discover [--json] [--write] [--accept-gaps <id,id>]',
    '  xoloop-verify tradeoff <goal.yaml> [--list|--accept <id>|--reject <id>] [--reason "..."] [--json]',
    '  xoloop-verify scan [--surface cli|api|frontend|state|state-machine|concurrency|performance|formal|function|runtime-lab|safety|discovery|all] [--json]',
    '  xoloop-verify run <general-io goal.yaml> [--suite <id>] [--case <id>] [--update-baselines] [--json]',
    '  xoloop-verify run <goal.yaml> [--suite <id>] [--case <id>] [--json]',
    '  xoloop-verify freeze-baselines <goal.yaml> [--suite <id>] [--case <id>] [--json]',
    '  xoloop-verify card <goal.yaml> [--json]',
  ].join('\n'));
}

function parseCsvFlag(argv, flag) {
  const raw = parseFlag(argv, flag, '');
  if (!raw) return [];
  return String(raw).split(',').map((part) => part.trim()).filter(Boolean);
}

function positionalObjective(argv) {
  const out = [];
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (String(item).startsWith('--')) {
      if (index + 1 < argv.length && !String(argv[index + 1]).startsWith('--')) index += 1;
      continue;
    }
    out.push(item);
  }
  return out.join(' ').trim();
}

function printDiscovery(result) {
  console.log(`detected surfaces: ${result.coverage.detected_surfaces.join(', ') || 'none'}`);
  console.log(`observable surfaces: ${result.coverage.observable_surface_count}`);
  console.log(`automatic harnesses: ${result.coverage.suggested_harness_count}`);
  console.log(`gaps: ${result.coverage.gap_count} total, ${result.coverage.blocking_gap_count} blocking`);
  if (result.safety && result.safety.summary) {
    console.log(`safety: ${result.safety.summary.safe_count} real-safe, ${result.safety.summary.review_count} review, ${result.safety.summary.mock_count} mock, ${result.safety.summary.block_count} block`);
    console.log(`safety analysis: ${result.safety.summary.schema_pii_signal_count || 0} schema PII signals, ${result.safety.summary.static_taint_flow_count || 0} taint flows, ${result.safety.summary.call_graph_path_count || 0} call-graph paths`);
  }
  console.log(`optimization: ${result.optimization_gate.blocked ? 'BLOCKED' : 'open'}`);
  for (const surface of result.surfaces.filter((item) => item.detected)) {
    console.log(`- ${surface.id}: ${surface.observable_count} observables, ${surface.gaps.length} gaps, risk=${surface.risk}`);
  }
  if (result.blocking_gaps.length > 0) {
    console.log('blocking gaps:');
    for (const gap of result.blocking_gaps.slice(0, 12)) console.log(`- ${gap.id}: ${gap.message}`);
  }
  if (result.suggested_harnesses.length > 0) {
    console.log('suggested harnesses:');
    for (const harness of result.suggested_harnesses.slice(0, 12)) console.log(`- ${harness.kind}: ${harness.command}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h') || argv.length === 0) {
    printHelp();
    process.exit(0);
  }
  const sub = argv[0];
  const json = hasFlag(argv, '--json');

  if (sub === 'discover') {
    const result = discoverRepo(process.cwd(), {
      acceptedGaps: [
        ...parseCsvFlag(argv, '--accept-gaps'),
        ...parseCsvFlag(argv, '--accepted-gaps'),
      ],
    });
    if (hasFlag(argv, '--write')) {
      const discoveryPath = require('path').join(process.cwd(), '.xoloop', 'discovery.json');
      fs.mkdirSync(require('path').dirname(discoveryPath), { recursive: true });
      fs.writeFileSync(discoveryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    else printDiscovery(result);
    return;
  }

  if (sub === 'make-goal' || sub === 'goal' || sub === 'goal-maker') {
    const objective = parseFlag(argv, '--objective', null)
      || parseFlag(argv, '--prompt', null)
      || parseFlag(argv, '--intent', null)
      || positionalObjective(argv);
    const result = makeImprovementGoal({
      cwd: process.cwd(),
      objective,
      target: parseFlag(argv, '--target', ''),
      metric: parseFlag(argv, '--metric', ''),
      goalId: parseFlag(argv, '--goal-id', null),
      surfaces: parseFlag(argv, '--surfaces', parseFlag(argv, '--surface', '')),
      threshold: Number.parseFloat(parseFlag(argv, '--threshold', '0.03')),
      repeat: Number.parseInt(parseFlag(argv, '--repeat', '3'), 10),
      acceptedGaps: [
        ...parseCsvFlag(argv, '--accept-gaps'),
        ...parseCsvFlag(argv, '--accepted-gaps'),
      ],
      force: hasFlag(argv, '--force'),
      useExistingDiscovery: hasFlag(argv, '--use-existing-discovery'),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Created improvement goal: ${result.goalPath}`);
      console.log(`Intent: ${result.plan.intent.target}/${result.plan.intent.metric}`);
      console.log(`Surfaces: ${result.plan.selected_surfaces.join(', ') || 'none'}`);
      console.log(`Targets: ${result.plan.metric_targets.map((target) => target.name).join(', ') || 'none'}`);
      console.log(`Optimization gate: ${result.plan.optimization_gate.ready ? 'ready after PASS_EVIDENCED' : 'blocked by discovery gaps'}`);
      if (!result.plan.optimization_gate.ready) {
        console.log(`Blocking gaps: ${result.plan.optimization_gate.blocking_gap_ids.join(', ')}`);
      }
      console.log(`Agent prompt: ${require('path').join(require('path').dirname(result.goalPath), 'agent-prompt.md')}`);
    }
    return;
  }

  if (sub === 'tradeoff' || sub === 'tradeoffs') {
    const goalPath = argv[1];
    if (!goalPath) throw new Error('xoloop-verify tradeoff requires <goal.yaml>');
    const acceptId = parseFlag(argv, '--accept', null);
    const rejectId = parseFlag(argv, '--reject', null);
    const reason = parseFlag(argv, '--reason', '');
    const result = acceptId
      ? decideTradeoff(goalPath, acceptId, 'accepted', { reason })
      : rejectId
        ? decideTradeoff(goalPath, rejectId, 'rejected', { reason })
        : listTradeoffs(goalPath);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (acceptId || rejectId) {
      console.log(`${result.decision === 'accepted' ? 'Accepted' : 'Rejected'} tradeoff: ${result.tradeoff_id}`);
      console.log(`Ledger: ${result.ledger_path}`);
    } else {
      const tradeoffs = result.tradeoffs || [];
      console.log(`Tradeoffs: ${tradeoffs.length}`);
      for (const tradeoff of tradeoffs) {
        const decision = tradeoff.decision ? tradeoff.decision.decision : 'pending';
        console.log(`- ${tradeoff.id}: ${decision} - ${tradeoff.description} (${tradeoff.estimated_savings})`);
      }
    }
    return;
  }

  if (sub === 'scan') {
    const surface = parseFlag(argv, '--surface', 'frontend');
    const result = surface === 'cli'
      ? scanCliRepo(process.cwd())
      : surface === 'api'
        ? scanApiRepo(process.cwd())
      : surface === 'state'
        ? scanStateRepo(process.cwd())
      : surface === 'state-machine' || surface === 'workflow'
        ? scanStateMachineRepo(process.cwd())
      : surface === 'concurrency' || surface === 'async' || surface === 'time'
        ? scanConcurrencyRepo(process.cwd())
      : surface === 'performance' || surface === 'perf' || surface === 'benchmark'
        ? scanPerformanceRepo(process.cwd())
      : surface === 'formal' || surface === 'static' || surface === 'security'
        ? scanFormalRepo(process.cwd())
      : surface === 'function' || surface === 'functions'
        ? scanFunctionRepo(process.cwd())
      : surface === 'runtime-lab' || surface === 'lab'
        ? discoverRepo(process.cwd(), {
            acceptedGaps: [
              ...parseCsvFlag(argv, '--accept-gaps'),
              ...parseCsvFlag(argv, '--accepted-gaps'),
            ],
          }).runtime_lab
      : surface === 'safety'
        ? discoverRepo(process.cwd(), {
            acceptedGaps: [
              ...parseCsvFlag(argv, '--accept-gaps'),
              ...parseCsvFlag(argv, '--accepted-gaps'),
            ],
          }).safety
      : surface === 'discovery' || surface === 'gaps'
        ? discoverRepo(process.cwd(), {
            acceptedGaps: [
              ...parseCsvFlag(argv, '--accept-gaps'),
              ...parseCsvFlag(argv, '--accepted-gaps'),
            ],
          })
      : surface === 'all'
        ? { schema: 'xoloop.scan.v0.1', cli: scanCliRepo(process.cwd()), api: scanApiRepo(process.cwd()), frontend: scanFrontendRepo(process.cwd()), state: scanStateRepo(process.cwd()), state_machine: scanStateMachineRepo(process.cwd()), concurrency: scanConcurrencyRepo(process.cwd()), performance: scanPerformanceRepo(process.cwd()), formal: scanFormalRepo(process.cwd()), function: scanFunctionRepo(process.cwd()), safety: discoverRepo(process.cwd()).safety, runtime_lab: discoverRepo(process.cwd()).runtime_lab }
        : scanFrontendRepo(process.cwd());
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (surface === 'cli') {
      console.log(`commands: ${result.commands.length}`);
      for (const command of result.commands.slice(0, 12)) console.log(`- ${command.id}: ${command.command} (${command.language}, ${command.risk})`);
      if (result.gaps.length > 0) console.log(`gaps: ${result.gaps.join('; ')}`);
    } else if (surface === 'api') {
      console.log(`frameworks: ${result.frameworks.map((f) => f.name).join(', ') || 'none detected'}`);
      console.log(`routes: ${result.route_files.length}`);
      console.log(`schemas: ${result.schema_files.length}`);
      console.log(`openapi operations: ${result.openapi_operations.length}`);
      console.log(`graphql operations: ${result.graphql_operations.length}`);
      if (result.gaps.length > 0) console.log(`gaps: ${result.gaps.join('; ')}`);
    } else if (surface === 'state') {
      console.log(`tools: ${result.tools.map((tool) => tool.name).join(', ') || 'none detected'}`);
      console.log(`migrations: ${result.migration_files.length}`);
      console.log(`schemas: ${result.schema_files.length}`);
      console.log(`state files: ${result.state_files.length}`);
      if (result.gaps.length > 0) console.log(`gaps: ${result.gaps.join('; ')}`);
    } else if (surface === 'state-machine' || surface === 'workflow') {
      console.log(`domains: ${result.domains.join(', ') || 'none detected'}`);
      console.log(`tools: ${result.tools.map((tool) => tool.name).join(', ') || 'none detected'}`);
      console.log(`workflow files: ${result.workflow_files.length}`);
      console.log(`model files: ${result.model_files.length}`);
      if (result.gaps.length > 0) console.log(`gaps: ${result.gaps.join('; ')}`);
    } else if (surface === 'concurrency' || surface === 'async' || surface === 'time') {
      console.log(`runtimes: ${result.runtimes.map((runtime) => runtime.runtime).join(', ') || 'none detected'}`);
      console.log(`tools: ${result.tools.map((tool) => tool.name).join(', ') || 'none detected'}`);
      console.log(`clock adapters: ${result.clock_adapters.map((adapter) => adapter.name).join(', ') || 'none detected'}`);
      console.log(`deterministic schedulers: ${result.deterministic_schedulers.map((scheduler) => scheduler.name).join(', ') || 'none detected'}`);
      console.log(`race tooling: ${result.race_tooling.map((tool) => tool.id).join(', ') || 'none detected'}`);
      console.log(`async files: ${result.async_files.length}`);
      console.log(`schedule files: ${result.schedule_files.length}`);
      if (result.gaps.length > 0) console.log(`gaps: ${result.gaps.join('; ')}`);
    } else if (surface === 'performance' || surface === 'perf' || surface === 'benchmark') {
      console.log(`tools: ${result.tools.map((tool) => tool.name).join(', ') || 'none detected'}`);
      console.log(`benchmark commands: ${result.commands.filter((command) => command.kind === 'benchmark').length}`);
      console.log(`benchmark files: ${result.benchmark_files.length}`);
      console.log(`bundle files: ${result.bundle_files.length}`);
      if (result.gaps.length > 0) console.log(`gaps: ${result.gaps.join('; ')}`);
    } else if (surface === 'formal' || surface === 'static' || surface === 'security') {
      console.log(`categories: ${result.categories.join(', ') || 'none detected'}`);
      console.log(`checks: ${result.checks.length}`);
      console.log(`formal files: ${result.formal_files.length}`);
      if (result.gaps.length > 0) console.log(`gaps: ${result.gaps.join('; ')}`);
    } else if (surface === 'safety') {
      console.log(`actions: ${result.summary.action_count}`);
      console.log(`decisions: ${result.summary.safe_count} real-safe, ${result.summary.review_count} review, ${result.summary.mock_count} mock, ${result.summary.block_count} block`);
      console.log(`sensitive flows: ${result.summary.sensitive_flow_count}`);
      console.log(`third-party side effects: ${result.summary.third_party_side_effect_count}`);
      console.log(`schema PII signals: ${result.summary.schema_pii_signal_count || 0}`);
      console.log(`static taint flows: ${result.summary.static_taint_flow_count || 0}`);
      console.log(`call-graph paths: ${result.summary.call_graph_path_count || 0}`);
      for (const decision of result.mock_decisions.slice(0, 12)) console.log(`- ${decision.decision}: ${decision.surface}/${decision.kind} ${decision.label}`);
    } else if (surface === 'function' || surface === 'functions') {
      const functions = Array.isArray(result.functions) ? result.functions : [];
      const publicFunctions = functions.filter((fn) => fn.visibility === 'public' || fn.visibility === 'exported' || fn.exported === true);
      const sideEffectful = functions.filter((fn) => fn.purity && fn.purity.classification === 'side_effectful');
      console.log(`functions: ${functions.length}`);
      console.log(`public/exported: ${publicFunctions.length}`);
      console.log(`side-effectful: ${sideEffectful.length}`);
      console.log(`generated cases: ${Array.isArray(result.generated_cases) ? result.generated_cases.length : 0}`);
      console.log(`missing obligations: ${Array.isArray(result.missing_obligations) && result.missing_obligations.length ? result.missing_obligations.join(', ') : 'none'}`);
      for (const fn of publicFunctions.slice(0, 12)) {
        const purity = fn.purity && fn.purity.classification ? fn.purity.classification : 'unknown';
        console.log(`- ${fn.visibility} ${fn.language} ${fn.name} (${purity}) ${fn.file}:${fn.line}`);
      }
    } else if (surface === 'runtime-lab' || surface === 'lab') {
      const summary = result.summary || {};
      console.log(`dev servers: ${summary.dev_server_count || (Array.isArray(result.dev_servers) ? result.dev_servers.length : 0)}`);
      console.log(`services: ${summary.service_count || (result.orchestration && Array.isArray(result.orchestration.services) ? result.orchestration.services.length : 0)}`);
      console.log(`readiness checks: ${Array.isArray(result.readiness_checks) ? result.readiness_checks.length : 0}`);
      console.log(`auth sessions: ${summary.auth_session_count || (Array.isArray(result.auth_session_matrix) ? result.auth_session_matrix.length : 0)}`);
      console.log(`third-party providers: ${summary.third_party_provider_count || (result.third_party && Array.isArray(result.third_party.providers) ? result.third_party.providers.length : 0)}`);
      console.log(`blocked actions: ${summary.blocked_action_count || (Array.isArray(result.blocks) ? result.blocks.length : 0)}`);
      for (const server of (Array.isArray(result.dev_servers) ? result.dev_servers : []).slice(0, 8)) console.log(`- ${server.id}: ${server.lab_command || server.command}`);
    } else if (surface === 'discovery' || surface === 'gaps') {
      printDiscovery(result);
    } else if (surface === 'all') {
      console.log(`cli commands: ${result.cli.commands.length}`);
      console.log(`api routes: ${result.api.route_files.length}`);
      console.log(`api operations: ${result.api.openapi_operations.length + result.api.graphql_operations.length}`);
      console.log(`frontend frameworks: ${result.frontend.frameworks.map((f) => f.name).join(', ') || 'none detected'}`);
      console.log(`state tools: ${result.state.tools.map((tool) => tool.name).join(', ') || 'none detected'}`);
      console.log(`state-machine domains: ${result.state_machine.domains.join(', ') || 'none detected'}`);
      console.log(`concurrency tools: ${result.concurrency.tools.map((tool) => tool.name).join(', ') || 'none detected'}`);
      console.log(`concurrency race tooling: ${result.concurrency.race_tooling.map((tool) => tool.id).join(', ') || 'none detected'}`);
      console.log(`performance tools: ${result.performance.tools.map((tool) => tool.name).join(', ') || 'none detected'}`);
      console.log(`formal categories: ${result.formal.categories.join(', ') || 'none detected'}`);
      console.log(`functions: ${result.function.functions.length}`);
      console.log(`runtime lab dev servers: ${(result.runtime_lab.dev_servers || []).length}`);
      console.log(`safety decisions: ${result.safety.summary.safe_count} real-safe, ${result.safety.summary.review_count} review, ${result.safety.summary.mock_count} mock, ${result.safety.summary.block_count} block`);
      const gaps = [...result.cli.gaps, ...result.api.gaps, ...result.frontend.gaps, ...result.state.gaps, ...result.state_machine.gaps, ...result.concurrency.gaps, ...result.performance.gaps, ...result.formal.gaps];
      if (gaps.length > 0) console.log(`gaps: ${gaps.join('; ')}`);
    } else {
      console.log(`frameworks: ${result.frameworks.map((f) => f.name).join(', ') || 'none detected'}`);
      console.log(`tools: ${result.tools.map((t) => t.name).join(', ') || 'none detected'}`);
      console.log(`routes: ${result.routes.length}`);
      console.log(`components: ${result.components.length}`);
      console.log(`api schemas: ${result.api_schemas.length}`);
      if (result.gaps.length > 0) console.log(`gaps: ${result.gaps.join('; ')}`);
    }
    return;
  }

  if (sub === 'create') {
    const kind = parseFlag(argv, '--kind', 'json-canonicalizer');
    const result = createGoal({
      cwd: process.cwd(),
      target: parseFlag(argv, '--target', null),
      kind,
      goalId: parseFlag(argv, '--goal-id', kind === 'frontend-suite' ? 'frontend-suite' : (kind === 'cli-suite' ? 'cli-suite' : (kind === 'api-suite' ? 'api-suite' : (kind === 'state-suite' ? 'state-suite' : (kind === 'state-machine-suite' ? 'state-machine-suite' : (kind === 'concurrency-suite' ? 'concurrency-suite' : (kind === 'performance-suite' ? 'performance-suite' : (kind === 'formal-suite' ? 'formal-suite' : (kind === 'discovery-suite' ? 'discovery-suite' : (kind === 'suite' ? 'suite' : 'json-canon-seed')))))))))),
      surfaces: parseFlag(argv, '--surfaces', parseFlag(argv, '--surface', '')),
      url: parseFlag(argv, '--url', null),
      baseUrl: parseFlag(argv, '--base-url', parseFlag(argv, '--url', null)),
      command: parseFlag(argv, '--command', null),
      acceptedGaps: [
        ...parseCsvFlag(argv, '--accept-gaps'),
        ...parseCsvFlag(argv, '--accepted-gaps'),
      ],
      force: hasFlag(argv, '--force'),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Created goal: ${result.goalPath}`);
      console.log(`Manifest: ${result.manifest_hash}`);
    }
    return;
  }

  if (sub === 'run') {
    const goalPath = argv[1];
    if (!goalPath) throw new Error('xoloop-verify run requires <goal.yaml>');
    const { card } = await runGoalVerify(goalPath, {
      cwd: process.cwd(),
      suiteId: parseFlag(argv, '--suite', parseFlag(argv, '--obligation', null)),
      caseId: parseFlag(argv, '--case', null),
      updateBaselines: hasFlag(argv, '--update-baselines'),
    });
    if (json) console.log(JSON.stringify(card, null, 2));
    else console.log(formatVerifyCard(card));
    process.exit(card.verdict === 'FAIL' ? 1 : 0);
  }

  if (sub === 'freeze-baselines' || sub === 'baseline' || sub === 'baselines') {
    const goalPath = argv[1];
    if (!goalPath) throw new Error('xoloop-verify freeze-baselines requires <goal.yaml>');
    const { card } = await runGoalVerify(goalPath, {
      cwd: process.cwd(),
      suiteId: parseFlag(argv, '--suite', parseFlag(argv, '--obligation', null)),
      caseId: parseFlag(argv, '--case', null),
      updateBaselines: true,
    });
    if (json) console.log(JSON.stringify(card, null, 2));
    else console.log(formatVerifyCard(card));
    process.exit(card.verdict === 'FAIL' ? 1 : 0);
  }

  if (sub === 'card') {
    const goalPath = argv[1];
    if (!goalPath) throw new Error('xoloop-verify card requires <goal.yaml>');
    const card = buildVerifyCard(goalPath, { cwd: process.cwd() });
    if (json) console.log(JSON.stringify(card, null, 2));
    else console.log(formatVerifyCard(card));
    process.exit(card.verdict === 'FAIL' ? 1 : 0);
  }

  throw new Error(`unknown xoloop-verify subcommand: ${sub}`);
}

main().catch((err) => {
  console.error('[xoloop-verify] Fatal:', err.message || err);
  process.exit(1);
});
