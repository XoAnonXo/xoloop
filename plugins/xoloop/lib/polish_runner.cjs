'use strict';

const path = require('node:path');
const { makeProposalLoader } = require('./live_agent_provider.cjs');

const VALUE_FLAGS = {
  '--adapter': 'adapterPath',
  '--objective': 'objectivePath',
  '--repo-root': 'repoRoot',
  '--surface': 'surface',
};

function parsePolishOptions(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const opts = {
    rounds: Infinity,
    untilSaturated: false,
    dryRun: false,
    adapterPath: 'overnight.yaml',
    objectivePath: 'objective.yaml',
    repoRoot: undefined,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--rounds' && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      opts.rounds = Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
    } else if (arg === '--until-saturated') {
      opts.untilSaturated = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (VALUE_FLAGS[arg] && i + 1 < args.length) {
      opts[VALUE_FLAGS[arg]] = args[++i];
    }
  }

  return opts;
}

const numberOrZero = (value) => Number(value) || 0;

function emptyPolishSummary(recommendation, error) {
  return {
    rounds: 0,
    landed: 0,
    failed: 0,
    testsAdded: 0,
    saturated: false,
    recommendation,
    ...(error ? { error } : {}),
  };
}

function buildRecommendation(rounds, saturated, landed) {
  if (rounds === 0) return 'No rounds were executed.';
  if (saturated) return 'Diminishing returns detected. Consider switching to BUILD mode or stopping.';
  if (landed === 0) return 'No proposals landed. Review the objective or adapter configuration.';
  return `${landed} proposal(s) landed across ${rounds} round(s). Continue polishing or switch to BUILD mode.`;
}

function buildPolishSummary(roundResults) {
  const results = Array.isArray(roundResults) ? roundResults : [];
  const totals = results.reduce((acc, result) => {
    if (!result) return acc;
    acc.landed += numberOrZero(result.landed);
    acc.failed += numberOrZero(result.failed);
    acc.testsAdded += numberOrZero(result.testsAdded);
    return acc;
  }, { landed: 0, failed: 0, testsAdded: 0 });
  const rounds = results.length;
  const lastRound = rounds > 0 ? results[rounds - 1] : null;
  const saturated = Boolean(lastRound && lastRound.saturated);

  return {
    rounds,
    ...totals,
    saturated,
    recommendation: buildRecommendation(rounds, saturated, totals.landed),
  };
}

function normalizeBatchResult(batchResult) {
  return {
    landed: numberOrZero(batchResult && batchResult.landed),
    failed: numberOrZero(batchResult && batchResult.failed),
    testsAdded: numberOrZero(batchResult && batchResult.testsAdded),
    saturated: false,
  };
}

function detectSaturation(roundResults, currentRound) {
  const { detectDiminishingReturns } = require('./diminishing_returns.cjs');
  const roundHistory = roundResults.map((result, index) => ({
    roundNumber: index + 1,
    landed: result.landed,
    attempted: result.landed + result.failed,
  }));
  roundHistory.push({
    roundNumber: roundResults.length + 1,
    landed: currentRound.landed,
    attempted: currentRound.landed + currentRound.failed,
  });
  return Boolean(detectDiminishingReturns(roundHistory, []).saturated);
}

async function runPolishLoop(options) {
  if (options != null && (typeof options !== 'object' || Array.isArray(options))) {
    const received = Array.isArray(options) ? 'array' : typeof options;
    return emptyPolishSummary(
      'options must be an object or nullish.',
      `INVALID_OPTIONS: expected object, got ${received}`,
    );
  }

  const {
    rounds: maxRounds = Infinity,
    untilSaturated = false,
    dryRun = false,
    adapterPath = 'overnight.yaml',
    objectivePath = 'objective.yaml',
    repoRoot: rawRepoRoot,
    proposalLoader,
    liveAgentProvider,
  } = options || {};
  const repoRoot = path.resolve(rawRepoRoot || process.cwd());
  const effectiveProposalLoader = proposalLoader || makeProposalLoader(liveAgentProvider, 'polish');

  let adapter;

  try {
    adapter = require('./overnight_adapter.cjs').loadOvernightAdapter(adapterPath, { repoRoot });
  } catch (err) {
    return emptyPolishSummary(`Failed to load adapter: ${err.message}`, `adapter_load_error: ${err.message}`);
  }

  try {
    require('./overnight_objective.cjs').loadOvernightObjective(objectivePath, adapter, { repoRoot });
  } catch (err) {
    return emptyPolishSummary(`Failed to load objective: ${err.message}`, `objective_load_error: ${err.message}`);
  }

  const roundResults = [];
  for (let roundNum = 0; roundNum < maxRounds; roundNum += 1) {
    if (dryRun) {
      return buildPolishSummary([{ landed: 0, failed: 0, testsAdded: 0, saturated: false }]);
    }

    let round;
    try {
      const { runOvernightBatch } = require('./overnight_engine.cjs');
      round = normalizeBatchResult(await runOvernightBatch({
        cwd: repoRoot,
        adapterPath,
        objectivePath,
        allowDirty: true,
        proposalLoader: effectiveProposalLoader,
      }));
    } catch (_err) {
      round = { landed: 0, failed: 1, testsAdded: 0, saturated: false };
    }

    if (untilSaturated) {
      try {
        round.saturated = detectSaturation(roundResults, round);
      } catch (_) {
        round.saturated = false;
      }
    }

    roundResults.push(round);
    if (round.saturated) break;
  }

  return buildPolishSummary(roundResults);
}

module.exports = {
  parsePolishOptions,
  buildPolishSummary,
  runPolishLoop,
};
