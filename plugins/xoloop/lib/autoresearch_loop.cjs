const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let normalizeSimulationLock;
try {
  ({ normalizeSimulationLock } = require('../../benchmarks/lib/simulation_world.cjs'));
} catch (_) {
  normalizeSimulationLock = (value) => value;
}
const { applyChangeSet, rollbackAppliedChangeSet } = require('./change_set_engine.cjs');
const { DEFAULT_MINIMAX_API_KEY_ENV } = require('./minimax_client.cjs');
const { callModel } = require('./model_router.cjs');
const { loadScenarioFamily } = require('./scenario_family_loader.cjs');
const { extractJsonObjectFromText } = require('./baton_common.cjs');
const {
  buildApprovalTicket,
  extractChangeContent,
  extractTouchedFiles,
  isSensitive,
} = require('./autoresearch_sensitive_domains.cjs');
const { budgetTierForSurface, computeBudget, explainBudget } = require('./autoresearch_token_budget.cjs');
const { JUDGE_ROLES, runRound, runTournament } = require('./autoresearch_tournament.cjs');
const { buildCallJudgeForRound } = require('./autoresearch_council_caller.cjs');
const { AdapterError } = require('./errors.cjs');

const RESEARCH_SCHEMA_VERSION = '1.0.0';
const DEFAULT_GOAL = 'Make Pandora faster, more simple, and more resilient without adding benchmark-only behavior.';
const DEFAULT_QUICK_VALIDATION = Object.freeze([
  'node --test tests/unit/simulation_world.test.cjs',
  'node --test tests/unit/proving_ground_scenario_loader.test.cjs',
  'node --test tests/unit/mirror_replay_service.test.cjs',
]);
const DEFAULT_FULL_VALIDATION = Object.freeze([
  'node --test tests/unit/benchmark_runner.test.cjs',
  'node --test tests/cli/mirror_replay.integration.test.cjs',
]);
const DEFAULT_FOCUS_FILES = Object.freeze([
  'benchmarks/lib/runner.cjs',
  'benchmarks/lib/simulation_world.cjs',
  'cli/lib/mirror_replay_service.cjs',
  'proving-ground/lib/scenario_family_loader.cjs',
]);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeStringList(list, fallback = []) {
  const source = Array.isArray(list) && list.length > 0 ? list : fallback;
  return source
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadResearchConfig(configPath, options = {}) {
  const resolvedPath = path.resolve(options.cwd || process.cwd(), configPath || 'proving-ground/config/proving-ground.example.json');
  const raw = readJson(resolvedPath);
  const document = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rootDir = path.resolve(options.cwd || process.cwd());
  const researchLoop = document.researchLoop && typeof document.researchLoop === 'object' ? document.researchLoop : {};
  const model = document.model && typeof document.model === 'object' ? document.model : {};
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    sourcePath: resolvedPath,
    rootDir,
    suite: normalizeText(document.suite) || 'daemon-in-loop',
    defaultFamilyPath: normalizeText(document.defaultFamilyPath) || 'proving-ground/scenarios/daemon-in-loop/family.json',
    reportDir: normalizeText(document.reportDir) || 'proving-ground/reports',
    holdoutPolicy: document.holdoutPolicy || { enabled: false },
    calibrationPolicy: document.calibrationPolicy || { enabled: false },
    model: {
      provider: normalizeText(model.provider).toLowerCase() || 'minimax',
      apiKeyEnv: normalizeText(model.apiKeyEnv) || DEFAULT_MINIMAX_API_KEY_ENV,
      baseUrl: normalizeText(model.baseUrl) || undefined,
      model: normalizeText(model.model) || undefined,
      reasoningSplit: model.reasoningSplit !== false,
      timeoutMs: normalizeNumber(model.timeoutMs, 120000),
      maxAttempts: Math.max(1, Math.round(normalizeNumber(model.maxAttempts, 3))),
      retryDelayMs: Math.max(0, Math.round(normalizeNumber(model.retryDelayMs, 3000))),
    },
    researchLoop: {
      goal: normalizeText(researchLoop.goal) || DEFAULT_GOAL,
      mode: normalizeText(options.mode) || normalizeText(researchLoop.mode) || 'proposal',
      maxIterations: Math.max(1, Math.round(normalizeNumber(options.maxIterations, normalizeNumber(researchLoop.maxIterations, 1)))),
      allowDirtyTree: options.allowDirty === true || researchLoop.allowDirtyTree === true,
      focusFiles: normalizeStringList(researchLoop.focusFiles, DEFAULT_FOCUS_FILES),
      quickValidation: normalizeStringList(researchLoop.quickValidation, DEFAULT_QUICK_VALIDATION),
      fullValidation: normalizeStringList(researchLoop.fullValidation, DEFAULT_FULL_VALIDATION),
      maxSlowdownRatio: Math.max(1, normalizeNumber(researchLoop.maxSlowdownRatio, 1.02)),
    },
  };
}

function getWorkingTreeState(cwd) {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    return {
      ok: false,
      isDirty: true,
      entries: [],
      error: normalizeText(result.stderr) || 'git status failed',
    };
  }
  const entries = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ok: true,
    isDirty: entries.length > 0,
    entries,
    error: null,
  };
}

// Audit fix P2#4: untracked files created by validation commands leak past
// rollback. Capture the untracked set before apply and after validation so
// we can `git clean` the delta at rollback time. Only returns UNTRACKED
// entries (porcelain prefix "??"), never modified/staged files.
function listUntrackedPaths(cwd) {
  const state = getWorkingTreeState(cwd);
  if (!state.ok) {
    return { ok: false, paths: [], error: state.error };
  }
  const paths = [];
  for (const entry of state.entries) {
    if (entry.startsWith('?? ')) {
      const relPath = entry.slice(3).trim();
      if (relPath) {
        paths.push(relPath);
      }
    }
  }
  return { ok: true, paths, error: null };
}

function cleanNewUntrackedPaths(cwd, beforePaths, afterPaths) {
  const before = new Set(Array.isArray(beforePaths) ? beforePaths : []);
  const after = Array.isArray(afterPaths) ? afterPaths : [];
  const newPaths = after.filter((p) => !before.has(p));
  if (newPaths.length === 0) {
    return { cleaned: [], failed: [], attempted: [] };
  }
  // Use `git clean -f -- <paths>` — no -x so .gitignored artifacts stay.
  // We explicitly pass the specific paths, never a broad clean.
  const result = runGitCommand(cwd, ['clean', '-f', '--', ...newPaths]);
  if (result.exitCode === 0) {
    return { cleaned: newPaths, failed: [], attempted: newPaths };
  }
  return {
    cleaned: [],
    failed: newPaths,
    attempted: newPaths,
    error: normalizeText(result.stderr) || normalizeText(result.stdout) || 'git clean failed',
  };
}

function summarizeScenarioFamily(family) {
  const typeCounts = {};
  let totalExternalTradeCount = 0;
  let totalExternalTradeVolumeUsdc = 0;
  let totalVenueResponseCount = 0;
  let totalRestartCount = 0;
  let hedgeCaseCount = 0;
  let recoveryCaseCount = 0;
  let maxRecoveryMs = 0;

  for (const scenarioCase of family.cases) {
    const expectations = scenarioCase.expectations || {};
    if (expectations.requiresHedge) {
      hedgeCaseCount += 1;
    }
    if (expectations.requiresRecovery) {
      recoveryCaseCount += 1;
    }
    maxRecoveryMs = Math.max(maxRecoveryMs, Number(expectations.maxRecoveryMs) || 0);
    for (const event of (scenarioCase.events || [])) {
      const type = normalizeText(event.type) || 'unknown';
      typeCounts[type] = Number(typeCounts[type] || 0) + 1;
      if (type === 'external-trade') {
        totalExternalTradeCount += 1;
        totalExternalTradeVolumeUsdc += Number(event.amountUsdc) || 0;
      } else if (type === 'venue-response') {
        totalVenueResponseCount += 1;
      } else if (type === 'daemon-restart') {
        totalRestartCount += 1;
      }
    }
  }

  return {
    familyId: family.familyId,
    title: family.title,
    caseCount: family.caseCount,
    caseIds: family.cases.map((scenarioCase) => scenarioCase.id),
    typeCounts,
    totalExternalTradeCount,
    totalExternalTradeVolumeUsdc,
    totalVenueResponseCount,
    totalRestartCount,
    hedgeCaseCount,
    recoveryCaseCount,
    maxRecoveryMs,
    worldLock: normalizeSimulationLock({
      suite: 'proving-ground',
      name: family.familyId,
      simulation: {
        version: family.worldLock && family.worldLock.schemaVersion,
        seed: family.generator && family.generator.seed,
        scenarioFamily: family.familyId,
        feeModel: family.worldLock && family.worldLock.feeModel,
        latencyModel: family.worldLock && family.worldLock.latencyModel,
        marketModelHash: family.worldLock && family.worldLock.marketModel,
        policyHash: family.worldLock && family.worldLock.riskPolicy,
      },
      tags: ['proving-ground', family.familyId],
    }),
  };
}

function truncateOutput(text, maxLength = 800) {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function runValidationCommand(command, cwd) {
  const startedAt = Date.now();
  const result = spawnSync('bash', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command,
    exitCode: result.status === null ? 1 : result.status,
    passed: result.status === 0,
    elapsedMs: Date.now() - startedAt,
    stdout: truncateOutput(result.stdout),
    stderr: truncateOutput(result.stderr),
  };
}

function summarizeValidationResults(results) {
  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  const totalElapsedMs = results.reduce((sum, result) => sum + Number(result.elapsedMs || 0), 0);
  return {
    commandCount: results.length,
    passedCount,
    failedCount,
    passRate: results.length === 0 ? 1 : passedCount / results.length,
    totalElapsedMs,
    overallPass: failedCount === 0,
  };
}

function runValidationPlan(commands, cwd) {
  const results = commands.map((command) => runValidationCommand(command, cwd));
  return {
    commands: results,
    summary: summarizeValidationResults(results),
  };
}

function selectGateSummary(validation) {
  if (validation.full && validation.full.summary.commandCount > 0) {
    return validation.full.summary;
  }
  return validation.quick.summary;
}

function loadFocusFileContext(focusFiles, cwd) {
  return focusFiles.map((filePath) => {
    const resolvedPath = path.resolve(cwd, filePath);
    const content = fs.readFileSync(resolvedPath, 'utf8');
    return {
      path: filePath,
      excerpt: content.length > 2400 ? `${content.slice(0, 2400)}\n...` : content,
    };
  });
}

function buildResearchPrompt(options) {
  const focusFiles = loadFocusFileContext(options.focusFiles, options.cwd);
  return {
    systemPrompt: [
      'You are the Pandora proving-ground improvement researcher.',
      'Return JSON only.',
      'Propose one bounded change that can improve speed, simplicity, or resilience without adding benchmark-only behavior.',
      'If you cannot propose a safe deterministic code mutation, return an empty changeSet and a strong written hypothesis.',
      'Allowed changeSet operations: replace_once, insert_after_once, insert_before_once.',
      'Every match or anchor must be exact current repo text.',
    ].join(' '),
    userPrompt: JSON.stringify({
      goal: options.goal,
      mode: options.mode,
      dirtyTree: options.dirtyTree,
      simulation: options.simulationSummary,
      baseline: options.baseline,
      focusFiles,
      returnShape: {
        hypothesisId: 'short-id',
        summary: 'plain-English summary',
        why: 'why this should help',
        targetFiles: ['relative/path'],
        expectedImpact: {
          speed: 'plain-English expectation',
          simplicity: 'plain-English expectation',
          resilience: 'plain-English expectation',
        },
        validationNotes: ['what to verify'],
        changeSet: [
          {
            kind: 'replace_once | insert_after_once | insert_before_once',
            path: 'relative/path',
            match: 'for replace_once only',
            replace: 'for replace_once only',
            anchor: 'for insert operations only',
            text: 'for insert operations only',
          },
        ],
      },
    }, null, 2),
  };
}

function extractFirstJsonObject(text) {
  return extractJsonObjectFromText(text, 'Model response');
}

function parseResearchProposal(text) {
  const proposal = JSON.parse(extractFirstJsonObject(text));
  return {
    hypothesisId: normalizeText(proposal.hypothesisId) || 'proposal',
    summary: normalizeText(proposal.summary),
    why: normalizeText(proposal.why),
    targetFiles: normalizeStringList(proposal.targetFiles),
    expectedImpact: proposal.expectedImpact && typeof proposal.expectedImpact === 'object'
      ? {
          speed: normalizeText(proposal.expectedImpact.speed),
          simplicity: normalizeText(proposal.expectedImpact.simplicity),
          resilience: normalizeText(proposal.expectedImpact.resilience),
        }
      : { speed: '', simplicity: '', resilience: '' },
    validationNotes: normalizeStringList(proposal.validationNotes),
    changeSet: Array.isArray(proposal.changeSet) ? proposal.changeSet : [],
  };
}

function buildInvalidProposalFallback(message) {
  return {
    hypothesisId: 'invalid-proposal',
    summary: 'Model returned an invalid JSON proposal; the loop discarded it safely.',
    why: normalizeText(message),
    targetFiles: [],
    expectedImpact: {
      speed: '',
      simplicity: '',
      resilience: 'The loop should keep running even when a proposal is malformed.',
    },
    validationNotes: [
      'Tighten the model response contract or add stronger proposal sanitation before the next mutation run.',
    ],
    changeSet: [],
  };
}

function buildDecisionSummary(baselineGate, candidateGate, appliedChangeSet, config) {
  const baselineElapsedMs = Number(baselineGate.totalElapsedMs || 0);
  const candidateElapsedMs = Number(candidateGate.totalElapsedMs || 0);
  const speedRatio = baselineElapsedMs > 0 ? candidateElapsedMs / baselineElapsedMs : 1;
  const improvedSpeed = candidateElapsedMs < baselineElapsedMs;
  const improvedResilience = candidateGate.passRate > baselineGate.passRate;
  const noRegression = candidateGate.failedCount <= baselineGate.failedCount && candidateGate.passRate >= baselineGate.passRate;
  const acceptableSpeed = speedRatio <= Number(config.researchLoop.maxSlowdownRatio || 1.02);
  const keep = noRegression && acceptableSpeed && (improvedSpeed || improvedResilience);
  return {
    keep,
    noRegression,
    acceptableSpeed,
    improvedSpeed,
    improvedResilience,
    speedRatio,
    simplicity: appliedChangeSet ? appliedChangeSet.summary : {
      touchedFiles: 0,
      addedLines: 0,
      removedLines: 0,
      netLineDelta: 0,
    },
  };
}

function formatDuration(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric)) {
    return 'n/a';
  }
  if (numeric < 1000) {
    return `${numeric.toFixed(1)} ms`;
  }
  return `${(numeric / 1000).toFixed(2)} s`;
}

function buildResearchHandoff(report) {
  const gate = selectGateSummary(report.baseline);
  const iteration = report.iterations[0] || null;
  const modelUsage = iteration && iteration.model ? iteration.model.usage : {};
  const nextMoveLines = iteration && iteration.proposal && iteration.proposal.validationNotes.length > 0
    ? iteration.proposal.validationNotes.map((note) => `- ${note}`)
    : ['- Run the next bounded proposal after the runtime daemon simulator is wired in.'];
  return [
    '# Pandora Proving-Ground Handoff',
    '',
    '## What we tested',
    `- Sandbox family: ${report.simulation.familyId}`,
    `- Cases: ${report.simulation.caseCount}`,
    `- External trades: ${report.simulation.totalExternalTradeCount}`,
    `- Restarts: ${report.simulation.totalRestartCount}`,
    '',
    '## Baseline',
    `- Quick gate pass: ${report.baseline.quick.summary.overallPass}`,
    `- Full gate pass: ${report.baseline.full ? report.baseline.full.summary.overallPass : false}`,
    `- Gate time: ${formatDuration(gate.totalElapsedMs)}`,
    '',
    '## Research result',
    iteration
      ? `- Outcome: ${iteration.outcome}`
      : '- Outcome: baseline only',
    iteration && iteration.proposal
      ? `- Hypothesis: ${iteration.proposal.summary || 'n/a'}`
      : '- Hypothesis: n/a',
    iteration && iteration.decision
      ? `- Keep decision: ${iteration.decision.keep}`
      : '- Keep decision: n/a',
    '',
    '## Model',
    iteration && iteration.model
      ? `- Model: ${iteration.model.model}`
      : '- Model: not called',
    iteration && iteration.model
      ? `- Tokens: ${Number(modelUsage.total_tokens || 0)} total (${Number(modelUsage.prompt_tokens || 0)} prompt / ${Number(modelUsage.completion_tokens || 0)} completion)`
      : '- Tokens: 0',
    iteration && iteration.model
      ? `- Model time: ${formatDuration(iteration.model.elapsedMs)}`
      : '- Model time: n/a',
    '',
    '## Next move',
    ...nextMoveLines,
    '',
  ].join('\n');
}

function writeResearchArtifacts(report, config) {
  const runId = report.runId;
  const targetDir = path.resolve(config.rootDir, config.reportDir, runId);
  fs.mkdirSync(targetDir, { recursive: true });
  const reportPath = path.join(targetDir, 'report.json');
  const handoffPath = path.join(targetDir, 'handoff.md');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(handoffPath, `${buildResearchHandoff(report)}\n`);
  return {
    reportDir: targetDir,
    reportPath,
    handoffPath,
  };
}

function runGitCommand(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return {
    exitCode: result.status === null ? 1 : result.status,
    stdout: normalizeText(result.stdout),
    stderr: normalizeText(result.stderr),
  };
}

function buildAcceptedCommitMessage(iteration) {
  const proposal = iteration && iteration.proposal ? iteration.proposal : {};
  const hypothesisId = normalizeText(proposal.hypothesisId) || `iteration-${Number(iteration && iteration.index) || 0}`;
  const summary = normalizeText(proposal.summary) || 'autoresearch accepted change';
  return `autoresearch: ${hypothesisId} - ${summary}`;
}

function countLinesIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return 0;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').length;
  } catch (_) {
    return 0;
  }
}

function computeFocusFilesBudget(config, options = {}) {
  const cwd = path.resolve(options.cwd || config.rootDir || process.cwd());
  const focusFiles = Array.isArray(config.researchLoop && config.researchLoop.focusFiles)
    ? config.researchLoop.focusFiles
    : [];
  let totalLoc = 0;
  const perFile = [];
  for (const relPath of focusFiles) {
    const absolute = path.resolve(cwd, relPath);
    const loc = countLinesIfExists(absolute);
    totalLoc += loc;
    perFile.push({ path: relPath, loc });
  }
  const tier = budgetTierForSurface({
    risk: options.risk || 'safe',
    locCount: totalLoc,
    overrideBudget: options.overrideBudget === true,
    publicApi: options.publicApi === true,
    hotPath: options.hotPath === true,
    critical: options.critical === true,
  });
  return {
    ...explainBudget(totalLoc, tier),
    perFile,
    focusFileCount: focusFiles.length,
  };
}

function writeApprovalTicket(ticket, config, runId, iterationIndex) {
  const ticketDir = path.resolve(config.rootDir, '.xoanon', 'research', 'pending-approval');
  fs.mkdirSync(ticketDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeRunId = String(runId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const ticketPath = path.join(ticketDir, `${safeRunId}-iter${iterationIndex}-${stamp}.json`);
  fs.writeFileSync(ticketPath, `${JSON.stringify(ticket, null, 2)}\n`, 'utf8');
  return ticketPath;
}

function routeSensitiveProposalToApproval(options = {}) {
  const proposal = options.proposal;
  if (!proposal || typeof proposal !== 'object') {
    return { gated: false, sensitiveDomains: [], ticket: null, ticketPath: null };
  }
  const ticket = buildApprovalTicket(proposal, {
    requestedBy: options.requestedBy || 'autoresearch_loop',
    requestedAt: new Date().toISOString(),
  });
  if (!ticket.requiresApproval) {
    return { gated: false, sensitiveDomains: [], ticket: null, ticketPath: null };
  }
  let ticketPath = null;
  if (options.config && options.runId !== undefined && options.iterationIndex !== undefined) {
    ticketPath = writeApprovalTicket(ticket, options.config, options.runId, options.iterationIndex);
  }
  return {
    gated: true,
    sensitiveDomains: ticket.sensitiveDomains,
    ticket,
    ticketPath,
  };
}

function enforceProposalPathScope(proposal, allowedFiles) {
  if (!proposal || typeof proposal !== 'object') {
    throw new AdapterError(
      'AUTORESEARCH_PATH_SCOPE_PROPOSAL_REQUIRED',
      'proposal',
      'enforceProposalPathScope requires a proposal object',
      { fixHint: 'Pass the proposal whose changeSet paths must stay within the allowed surface.' },
    );
  }
  const allowedSet = new Set(
    (Array.isArray(allowedFiles) ? allowedFiles : [])
      .map((entry) => (typeof entry === 'string' ? entry.replace(/\\/g, '/') : ''))
      .filter(Boolean),
  );
  if (allowedSet.size === 0) {
    return { allowed: true, violations: [] };
  }
  const touched = extractTouchedFiles(proposal);
  const violations = touched.filter((file) => !allowedSet.has(file));
  if (violations.length > 0) {
    throw new AdapterError(
      'AUTORESEARCH_PATH_OUT_OF_SCOPE',
      'changeSet.path',
      `Proposal touches files outside the allowed surface: ${violations.join(', ')}`,
      { fixHint: `changeSet.path entries must be inside the focusFiles set: ${Array.from(allowedSet).join(', ')}.` },
    );
  }
  return { allowed: true, violations: [] };
}

function buildBaselineChampion(proposal, cwd) {
  // Audit fix P2#2: the champion must represent the CURRENT on-disk state so
  // judges can compare "file X currently contains Y, challenger proposes Z"
  // rather than scoring the challenger against an empty placeholder.
  const targetFiles = Array.isArray(proposal && proposal.targetFiles)
    ? proposal.targetFiles.slice()
    : [];
  const result = {
    targetFiles,
    changeSet: [],
    isBaseline: true,
  };
  if (cwd === undefined || cwd === null) {
    return result;
  }
  const baselineSnapshot = [];
  let snapshotError = null;
  try {
    const resolvedCwd = path.resolve(cwd);
    for (const relPath of targetFiles) {
      const absolute = path.resolve(resolvedCwd, relPath);
      try {
        const content = fs.readFileSync(absolute, 'utf8');
        baselineSnapshot.push({ path: relPath, content });
      } catch (fileError) {
        snapshotError = normalizeText(fileError && fileError.message ? fileError.message : fileError)
          || 'baseline snapshot read failed';
        break;
      }
    }
  } catch (outerError) {
    snapshotError = normalizeText(outerError && outerError.message ? outerError.message : outerError)
      || 'baseline snapshot resolve failed';
  }
  if (snapshotError) {
    result.baselineSnapshotError = snapshotError;
    return result;
  }
  result.baselineSnapshot = baselineSnapshot;
  return result;
}

async function evaluateProposalWithCouncil(options = {}) {
  const proposal = options.proposal;
  if (!proposal || !Array.isArray(proposal.changeSet)) {
    throw new AdapterError(
      'AUTORESEARCH_COUNCIL_PROPOSAL_REQUIRED',
      'proposal',
      'evaluateProposalWithCouncil requires a proposal with a changeSet',
      { fixHint: 'Pass the candidate proposal as options.proposal with at least an empty changeSet array.' },
    );
  }
  const champion = options.champion || buildBaselineChampion(proposal, options.cwd);
  const callJudge = typeof options.callJudge === 'function'
    ? options.callJudge
    : buildCallJudgeForRound({
        modelOptions: options.modelOptions,
        codexOptions: options.codexOptions,
        callerOverrides: options.callerOverrides,
      });
  const round = await runRound({
    champion,
    challenger: proposal,
    callJudge,
    judgeRoles: Array.isArray(options.judgeRoles) && options.judgeRoles.length > 0
      ? options.judgeRoles
      : JUDGE_ROLES,
  });
  return {
    keep: round.winner === 'challenger',
    winner: round.winner,
    contested: round.contested,
    challengerVeto: round.challenger && round.challenger.veto === true,
    championComposite: round.champion.aggregate.composite.mean,
    challengerComposite: round.challenger.aggregate.composite.mean,
    judgeCount: round.judgeCount,
    round,
  };
}

async function judgeChampionVsChallenger(options = {}) {
  const { champion, challenger, callJudge, judgeRoles } = options;
  if (typeof callJudge !== 'function') {
    throw new AdapterError(
      'AUTORESEARCH_JUDGE_CALL_REQUIRED',
      'callJudge',
      'judgeChampionVsChallenger requires a callJudge function',
      { fixHint: 'Inject a callJudge function that takes { role, candidateA, candidateB } and returns ballots.' },
    );
  }
  return runRound({
    champion,
    challenger,
    callJudge,
    judgeRoles: Array.isArray(judgeRoles) && judgeRoles.length > 0 ? judgeRoles : JUDGE_ROLES,
  });
}

async function judgeIterativeTournament(options = {}) {
  const { champion, challengerFactory, callJudge, maxRounds, judgeRoles } = options;
  if (typeof callJudge !== 'function') {
    throw new AdapterError(
      'AUTORESEARCH_JUDGE_CALL_REQUIRED',
      'callJudge',
      'judgeIterativeTournament requires a callJudge function',
      { fixHint: 'Inject a callJudge function that takes { role, candidateA, candidateB } and returns ballots.' },
    );
  }
  if (typeof challengerFactory !== 'function') {
    throw new AdapterError(
      'AUTORESEARCH_CHALLENGER_FACTORY_REQUIRED',
      'challengerFactory',
      'judgeIterativeTournament requires a challengerFactory that produces a fresh Challenger per round',
      { fixHint: 'Pass a challengerFactory that takes ({ round, previousChampion, history }) and returns the next challenger proposal.' },
    );
  }
  return runTournament({
    champion,
    challengerFactory,
    callJudge,
    judgeRoles: Array.isArray(judgeRoles) && judgeRoles.length > 0 ? judgeRoles : JUDGE_ROLES,
    maxRounds: Number.isFinite(Number(maxRounds)) && Number(maxRounds) > 0 ? Number(maxRounds) : 5,
  });
}

function commitAcceptedIteration(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const appliedChangeSet = options.appliedChangeSet;
  if (!appliedChangeSet || !Array.isArray(appliedChangeSet.files) || appliedChangeSet.files.length === 0) {
    throw new AdapterError(
      'GIT_COMMIT_PRECONDITION',
      'appliedChangeSet.files',
      'commitAcceptedIteration requires an applied change-set with touched files',
      { fixHint: 'Provide an appliedChangeSet with a non-empty files array.' },
    );
  }
  const files = appliedChangeSet.files
    .map((entry) => normalizeText(entry && entry.path))
    .filter(Boolean);
  const addResult = runGitCommand(cwd, ['add', '--', ...files]);
  if (addResult.exitCode !== 0) {
    throw new AdapterError(
      'GIT_COMMAND_FAILED',
      'git-add',
      addResult.stderr || 'git add failed',
      { fixHint: 'Check that the worktree path exists and the files are valid.' },
    );
  }

  const diffResult = runGitCommand(cwd, ['diff', '--cached', '--quiet', '--', ...files]);
  if (diffResult.exitCode === 0) {
    return {
      skipped: true,
      reason: 'no-staged-diff',
      files,
      message: buildAcceptedCommitMessage(options.iteration),
    };
  }
  if (diffResult.exitCode !== 1) {
    throw new AdapterError(
      'GIT_COMMAND_FAILED',
      'git-diff',
      diffResult.stderr || 'git diff --cached --quiet failed',
      { fixHint: 'Verify git is functional in the worktree directory.' },
    );
  }

  const message = buildAcceptedCommitMessage(options.iteration);
  const commitArgs = [
    '-c', 'user.name=Codex',
    '-c', 'user.email=codex@example.com',
    'commit',
    '-m', message,
    '--',
    ...files,
  ];
  const commitResult = runGitCommand(cwd, commitArgs);
  if (commitResult.exitCode !== 0) {
    throw new AdapterError(
      'GIT_COMMAND_FAILED',
      'git-commit',
      commitResult.stderr || commitResult.stdout || 'git commit failed',
      { fixHint: 'Check that the staged diff is non-empty and git user config is set.' },
    );
  }
  const headResult = runGitCommand(cwd, ['rev-parse', 'HEAD']);
  if (headResult.exitCode !== 0) {
    throw new AdapterError(
      'GIT_COMMAND_FAILED',
      'git-rev-parse',
      headResult.stderr || 'git rev-parse HEAD failed',
      { fixHint: 'Verify the git repository has at least one commit.' },
    );
  }
  return {
    skipped: false,
    sha: headResult.stdout,
    message,
    files,
  };
}

async function loadModelProposal(options) {
  if (options.liveAgentProvider && typeof options.liveAgentProvider.call === 'function') {
    return options.liveAgentProvider.call({
      mode: 'autoresearch',
      role: 'proposer',
      language: options.language || (options.context && options.context.language) || null,
      requestKind: 'proposal',
      prompt: options.prompt,
      context: {
        cwd: options.cwd,
        tokenBudget: options.tokenBudget || null,
      },
      schema: { type: 'json_object' },
    });
  }
  if (typeof options.modelLoader === 'function') {
    return options.modelLoader(options);
  }
  if (options.mockResponsePath) {
    const responseText = fs.readFileSync(path.resolve(options.cwd, options.mockResponsePath), 'utf8');
    return {
      provider: 'mock',
      model: 'mock-minimax',
      text: responseText,
      reasoning: '',
      usage: {},
      elapsedMs: 0,
    };
  }
  return callModel({
    ...options.modelConfig,
    systemPrompt: options.prompt.systemPrompt,
    userPrompt: options.prompt.userPrompt,
    mode: 'proposal',
    schema: { type: 'json_object' },
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

async function loadModelProposalWithRetry(options) {
  const maxAttempts = Math.max(1, Math.round(Number(options.modelConfig && options.modelConfig.maxAttempts) || 1));
  const retryDelayMs = Math.max(0, Math.round(Number(options.modelConfig && options.modelConfig.retryDelayMs) || 0));
  const attempts = [];
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await loadModelProposal(options);
      return {
        ...response,
        attempts,
      };
    } catch (error) {
      const message = normalizeText(error && error.message ? error.message : error) || 'Model call failed';
      attempts.push({
        attempt,
        message,
      });
      lastError = error;
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await delay(retryDelayMs * attempt);
      }
    }
  }

  const failure = new Error(normalizeText(lastError && lastError.message ? lastError.message : lastError) || 'Model call failed');
  failure.attempts = attempts;
  throw failure;
}

async function runAutoresearchLoop(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const config = loadResearchConfig(options.configPath, {
    cwd,
    mode: options.mode,
    maxIterations: options.maxIterations,
    allowDirty: options.allowDirty,
  });
  const dirtyTree = getWorkingTreeState(cwd);
  if (config.researchLoop.mode === 'workspace' && dirtyTree.isDirty && !config.researchLoop.allowDirtyTree) {
    throw new AdapterError(
      'DIRTY_TREE',
      'researchLoop.allowDirtyTree',
      'workspace mutation mode requires a clean git tree',
      { fixHint: 'Run in proposal mode or pass --allow-dirty when you own the tree.' },
    );
  }

  const familyPath = path.resolve(cwd, options.familyPath || config.defaultFamilyPath);
  const family = loadScenarioFamily(familyPath);
  const simulationSummary = summarizeScenarioFamily(family);
  const baseline = {
    quick: runValidationPlan(config.researchLoop.quickValidation, cwd),
    full: null,
  };
  if (baseline.quick.summary.overallPass && config.researchLoop.fullValidation.length > 0) {
    baseline.full = runValidationPlan(config.researchLoop.fullValidation, cwd);
  }

  // Audit fix P2#5: compute focus-files token budget at loop start and
  // track cumulative model usage. The loop short-circuits when cumulative
  // usage exceeds finalBudget so council model spend stays bounded.
  let budget = null;
  try {
    budget = computeFocusFilesBudget(config, {
      cwd,
      risk: options.risk,
      overrideBudget: options.overrideBudget === true,
      publicApi: options.publicApi === true,
      hotPath: options.hotPath === true,
      critical: options.critical === true,
    });
  } catch (budgetError) {
    budget = {
      error: normalizeText(budgetError && budgetError.message ? budgetError.message : budgetError),
    };
  }

  const report = {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    runId: options.runId || `pg-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    startedAt: new Date().toISOString(),
    cwd,
    mode: config.researchLoop.mode,
    goal: config.researchLoop.goal,
    dirtyTree,
    configSourcePath: config.sourcePath,
    simulation: simulationSummary,
    baseline,
    budget,
    usage: { totalModelTokens: 0 },
    iterations: [],
  };

  if (options.skipModel || config.researchLoop.mode === 'baseline') {
    report.finishedAt = new Date().toISOString();
    report.artifacts = writeResearchArtifacts(report, config);
    return report;
  }

  report.artifacts = writeResearchArtifacts(report, config);

  for (let iterationIndex = 0; iterationIndex < config.researchLoop.maxIterations; iterationIndex += 1) {
    const prompt = buildResearchPrompt({
      cwd,
      goal: config.researchLoop.goal,
      mode: config.researchLoop.mode,
      dirtyTree,
      simulationSummary,
      baseline,
      focusFiles: config.researchLoop.focusFiles,
    });
    // Audit fix P2#5: clamp each model call to the finalBudget derived from
    // the focus-files tier. The loop will also short-circuit if cumulative
    // usage exceeds finalBudget after any iteration.
    const tokenBudget = budget && Number.isFinite(Number(budget.finalBudget))
      ? Number(budget.finalBudget)
      : null;
    let model = null;
    try {
      model = await loadModelProposalWithRetry({
        cwd,
        mockResponsePath: options.mockResponsePath,
        prompt,
        modelConfig: config.model,
        liveAgentProvider: options.liveAgentProvider,
        language: options.language,
        modelLoader: options.modelLoader,
        tokenBudget,
      });
    } catch (error) {
      report.iterations.push({
        index: iterationIndex + 1,
        proposal: buildInvalidProposalFallback('Model call failed before a proposal was returned.'),
        model: {
          provider: config.model.provider,
          model: config.model.model,
          usage: {},
          elapsedMs: 0,
          attempts: Array.isArray(error && error.attempts) ? error.attempts : [],
        },
        outcome: 'model-error',
        decision: {
          keep: false,
          reason: 'model-call-failed',
        },
        modelError: {
          message: normalizeText(error && error.message ? error.message : error),
        },
        postValidation: null,
      });
      report.artifacts = writeResearchArtifacts(report, config);
      continue;
    }
    let proposal = null;
    let parseError = null;
    try {
      proposal = parseResearchProposal(model.text);
    } catch (error) {
      parseError = error;
      proposal = buildInvalidProposalFallback(error && error.message ? error.message : error);
    }
    const iteration = {
      index: iterationIndex + 1,
      proposal,
      model: {
        provider: model.provider,
        model: model.model,
        usage: model.usage || {},
        elapsedMs: model.elapsedMs,
        attempts: Array.isArray(model.attempts) ? model.attempts : [],
      },
      outcome: 'proposal-only',
      decision: null,
      postValidation: null,
    };

    if (parseError) {
      iteration.outcome = 'invalid-proposal';
      iteration.decision = {
        keep: false,
        reason: 'proposal-parse-failed',
      };
      iteration.parseError = {
        message: normalizeText(parseError && parseError.message ? parseError.message : parseError),
      };
      iteration.rawProposalExcerpt = truncateOutput(model.text, 1200);
      report.iterations.push(iteration);
      continue;
    }

    if (config.researchLoop.mode === 'workspace' && Array.isArray(proposal.changeSet) && proposal.changeSet.length > 0) {
      try {
        enforceProposalPathScope(proposal, config.researchLoop.focusFiles);
      } catch (scopeError) {
        iteration.outcome = 'discarded';
        iteration.decision = {
          keep: false,
          reason: 'path-scope-violation',
        };
        iteration.scopeError = {
          code: scopeError.code,
          message: normalizeText(scopeError.message),
        };
        report.iterations.push(iteration);
        report.artifacts = writeResearchArtifacts(report, config);
        continue;
      }
      const sensitiveGate = routeSensitiveProposalToApproval({
        proposal,
        config,
        runId: report.runId,
        iterationIndex: iteration.index,
        requestedBy: 'autoresearch_loop',
      });
      if (sensitiveGate.gated) {
        iteration.outcome = 'pending-approval';
        iteration.decision = {
          keep: false,
          reason: 'sensitive-domain-requires-human-approval',
        };
        iteration.sensitiveApproval = {
          domains: sensitiveGate.sensitiveDomains,
          ticketPath: sensitiveGate.ticketPath,
          requirements: sensitiveGate.ticket && sensitiveGate.ticket.requirements,
        };
        report.iterations.push(iteration);
        report.artifacts = writeResearchArtifacts(report, config);
        continue;
      }
      let appliedChangeSet = null;
      // Audit fix P2#4: capture untracked paths BEFORE apply so validation
      // side-effect files (caches, snapshots, test logs) can be cleaned at
      // rollback time. Without this, discarded iterations leave the tree
      // dirty for later iterations.
      const beforeUntracked = listUntrackedPaths(cwd);
      const workspaceRollback = (changeSet) => {
        let cleanup = null;
        if (beforeUntracked.ok) {
          const afterUntracked = listUntrackedPaths(cwd);
          if (afterUntracked.ok) {
            cleanup = cleanNewUntrackedPaths(cwd, beforeUntracked.paths, afterUntracked.paths);
          } else {
            cleanup = { cleaned: [], failed: [], attempted: [], error: afterUntracked.error };
          }
        }
        rollbackAppliedChangeSet(changeSet);
        return cleanup;
      };
      try {
        appliedChangeSet = applyChangeSet(proposal.changeSet, { cwd });
        const postValidation = {
          quick: runValidationPlan(config.researchLoop.quickValidation, cwd),
          full: null,
        };
        if (postValidation.quick.summary.overallPass && config.researchLoop.fullValidation.length > 0) {
          postValidation.full = runValidationPlan(config.researchLoop.fullValidation, cwd);
        }
        iteration.postValidation = postValidation;
        iteration.decision = buildDecisionSummary(
          selectGateSummary(baseline),
          selectGateSummary(postValidation),
          appliedChangeSet,
          config,
        );
        if (options.enableCouncil === true && iteration.decision.keep && postValidation.quick.summary.overallPass) {
          try {
            const councilVerdict = await evaluateProposalWithCouncil({
              proposal,
              cwd,
              callerOverrides: options.councilCallerOverrides,
              modelOptions: options.councilModelOptions,
              codexOptions: options.councilCodexOptions,
              judgeRoles: options.councilJudgeRoles,
            });
            iteration.councilVerdict = {
              keep: councilVerdict.keep,
              winner: councilVerdict.winner,
              contested: councilVerdict.contested,
              challengerVeto: councilVerdict.challengerVeto,
              championComposite: councilVerdict.championComposite,
              challengerComposite: councilVerdict.challengerComposite,
              judgeCount: councilVerdict.judgeCount,
            };
            if (!councilVerdict.keep) {
              iteration.decision = {
                ...iteration.decision,
                keep: false,
                reason: 'council-vetoed-challenger',
              };
            }
          } catch (councilError) {
            // Audit fix P1: when the council fails AND enableCouncil=true,
            // fail CLOSED — the caller explicitly asked for council review
            // and we cannot commit a change that was never reviewed. The
            // caller may opt into legacy fail-open behavior via
            // options.councilFailOpen=true.
            const councilFailOpen = options.councilFailOpen === true;
            const errorMessage = normalizeText(councilError && councilError.message
              ? councilError.message
              : councilError);
            if (councilFailOpen) {
              iteration.councilVerdict = {
                keep: iteration.decision.keep,
                skipped: true,
                error: errorMessage,
              };
            } else {
              iteration.councilVerdict = {
                keep: false,
                failed: true,
                error: errorMessage,
              };
              iteration.decision = {
                ...iteration.decision,
                keep: false,
                reason: 'council-unavailable',
              };
            }
          }
        }
        iteration.outcome = iteration.decision.keep ? 'kept' : 'discarded';
        iteration.appliedChangeSet = {
          operations: appliedChangeSet.operations.length,
          files: appliedChangeSet.files,
          summary: appliedChangeSet.summary,
        };
        if (iteration.decision.keep) {
          try {
            iteration.commit = commitAcceptedIteration({
              cwd,
              iteration,
              appliedChangeSet,
            });
          } catch (error) {
            // Audit fix P2#3: `git add` may have staged blobs even if the
            // subsequent `git commit` failed (e.g. signing rejected, hook
            // failed). Rolling back file contents is not enough — the index
            // still carries the staged blobs and will contaminate later
            // commits. Always `git reset HEAD -- <files>` before rolling
            // back on-disk content.
            const stagedFiles = Array.isArray(appliedChangeSet && appliedChangeSet.files)
              ? appliedChangeSet.files
                  .map((entry) => normalizeText(entry && entry.path))
                  .filter(Boolean)
              : [];
            if (stagedFiles.length > 0) {
              const resetResult = runGitCommand(cwd, ['reset', 'HEAD', '--', ...stagedFiles]);
              if (resetResult.exitCode === 0) {
                iteration.commitFailureIndexReset = 'ok';
              } else {
                iteration.commitFailureIndexReset = `failed: ${normalizeText(resetResult.stderr) || normalizeText(resetResult.stdout) || 'git reset failed'}`;
              }
            } else {
              iteration.commitFailureIndexReset = 'skipped-no-files';
            }
            const cleanupOnCommitFailure = workspaceRollback(appliedChangeSet);
            if (cleanupOnCommitFailure) {
              iteration.workspaceCleanupFiles = cleanupOnCommitFailure.cleaned;
              if (cleanupOnCommitFailure.failed && cleanupOnCommitFailure.failed.length > 0) {
                iteration.workspaceCleanupFailed = cleanupOnCommitFailure.failed;
              }
              if (cleanupOnCommitFailure.error) {
                iteration.workspaceCleanupError = cleanupOnCommitFailure.error;
              }
            }
            iteration.outcome = 'discarded';
            iteration.decision = {
              ...iteration.decision,
              keep: false,
              reason: 'commit-failed',
            };
            iteration.commitError = {
              message: normalizeText(error && error.message ? error.message : error),
            };
          }
        } else {
          const cleanupOnDiscard = workspaceRollback(appliedChangeSet);
          if (cleanupOnDiscard) {
            iteration.workspaceCleanupFiles = cleanupOnDiscard.cleaned;
            if (cleanupOnDiscard.failed && cleanupOnDiscard.failed.length > 0) {
              iteration.workspaceCleanupFailed = cleanupOnDiscard.failed;
            }
            if (cleanupOnDiscard.error) {
              iteration.workspaceCleanupError = cleanupOnDiscard.error;
            }
          }
        }
      } catch (error) {
        if (appliedChangeSet) {
          const cleanupOnError = workspaceRollback(appliedChangeSet);
          if (cleanupOnError) {
            iteration.workspaceCleanupFiles = cleanupOnError.cleaned;
            if (cleanupOnError.failed && cleanupOnError.failed.length > 0) {
              iteration.workspaceCleanupFailed = cleanupOnError.failed;
            }
            if (cleanupOnError.error) {
              iteration.workspaceCleanupError = cleanupOnError.error;
            }
          }
        }
        iteration.outcome = 'invalid-change-set';
        iteration.decision = {
          keep: false,
          reason: 'change-set-apply-failed',
        };
        iteration.applyError = {
          message: normalizeText(error && error.message ? error.message : error),
        };
      }
    }

    report.iterations.push(iteration);
    // Audit fix P2#5: accumulate cumulative token usage from each model
    // response and short-circuit the loop if we've exceeded the computed
    // focus-files budget.
    const iterationTokens = Number(iteration && iteration.model && iteration.model.usage
      ? iteration.model.usage.total_tokens
      : 0);
    if (Number.isFinite(iterationTokens) && iterationTokens > 0) {
      report.usage.totalModelTokens += iterationTokens;
    }
    report.artifacts = writeResearchArtifacts(report, config);
    if (budget && Number.isFinite(Number(budget.finalBudget))
        && report.usage.totalModelTokens > Number(budget.finalBudget)) {
      report.stopReason = {
        reason: 'budget-exhausted',
        totalModelTokens: report.usage.totalModelTokens,
        finalBudget: Number(budget.finalBudget),
      };
      break;
    }
  }

  report.finishedAt = new Date().toISOString();
  report.artifacts = writeResearchArtifacts(report, config);
  return report;
}

module.exports = {
  RESEARCH_SCHEMA_VERSION,
  buildResearchHandoff,
  buildResearchPrompt,
  extractFirstJsonObject,
  getWorkingTreeState,
  loadResearchConfig,
  loadModelProposal,
  parseResearchProposal,
  buildBaselineChampion,
  buildInvalidProposalFallback,
  buildAcceptedCommitMessage,
  commitAcceptedIteration,
  computeFocusFilesBudget,
  enforceProposalPathScope,
  evaluateProposalWithCouncil,
  judgeChampionVsChallenger,
  judgeIterativeTournament,
  routeSensitiveProposalToApproval,
  runAutoresearchLoop,
  runValidationCommand,
  runGitCommand,
  runValidationPlan,
  summarizeScenarioFamily,
  writeApprovalTicket,
};
