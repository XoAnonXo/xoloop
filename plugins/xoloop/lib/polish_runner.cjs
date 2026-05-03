'use strict';

const path = require('node:path');
const { makeProposalLoader } = require('./live_agent_provider.cjs');

// ---------------------------------------------------------------------------
// parsePolishOptions
// ---------------------------------------------------------------------------

/**
 * Parse CLI-style argv into a structured options object.
 *
 * @param {string[]} argv
 * @returns {{
 *   rounds: number,
 *   untilSaturated: boolean,
 *   dryRun: boolean,
 *   adapterPath: string,
 *   objectivePath: string,
 *   repoRoot: string | undefined,
 * }}
 */
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--rounds' && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      opts.rounds = Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
    } else if (arg === '--until-saturated') {
      opts.untilSaturated = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--adapter' && i + 1 < args.length) {
      opts.adapterPath = args[++i];
    } else if (arg === '--objective' && i + 1 < args.length) {
      opts.objectivePath = args[++i];
    } else if (arg === '--repo-root' && i + 1 < args.length) {
      opts.repoRoot = args[++i];
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// buildPolishSummary
// ---------------------------------------------------------------------------

/**
 * Build an aggregate summary from an array of per-round result objects.
 *
 * @param {Array<{ landed: number, failed: number, testsAdded: number, saturated: boolean }>} roundResults
 * @returns {{
 *   rounds: number,
 *   landed: number,
 *   failed: number,
 *   testsAdded: number,
 *   saturated: boolean,
 *   recommendation: string,
 * }}
 */
function buildPolishSummary(roundResults) {
  const results = Array.isArray(roundResults) ? roundResults : [];

  const rounds = results.length;
  let landed = 0;
  let failed = 0;
  let testsAdded = 0;
  let saturated = false;

  for (const r of results) {
    if (r == null) continue;
    landed += Number(r.landed) || 0;
    failed += Number(r.failed) || 0;
    testsAdded += Number(r.testsAdded) || 0;
  }

  // Saturation is true when the last round signals saturated
  const lastRound = results.length > 0 ? results[results.length - 1] : null;
  if (lastRound != null && lastRound.saturated) {
    saturated = true;
  }

  let recommendation;
  if (rounds === 0) {
    recommendation = 'No rounds were executed.';
  } else if (saturated) {
    recommendation = 'Diminishing returns detected. Consider switching to BUILD mode or stopping.';
  } else if (landed === 0) {
    recommendation = 'No proposals landed. Review the objective or adapter configuration.';
  } else {
    recommendation = `${landed} proposal(s) landed across ${rounds} round(s). Continue polishing or switch to BUILD mode.`;
  }

  return {
    rounds,
    landed,
    failed,
    testsAdded,
    saturated,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// runPolishLoop
// ---------------------------------------------------------------------------

/**
 * Run the polish loop: load adapter + objective, execute rounds, collect
 * results, and return a summary.
 *
 * The loop never throws -- it catches errors and returns a summary with an
 * error indication.
 *
 * @param {{
 *   rounds: number,
 *   untilSaturated: boolean,
 *   dryRun: boolean,
 *   adapterPath: string,
 *   objectivePath: string,
 *   repoRoot?: string,
 * }} options
 * @returns {Promise<{
 *   rounds: number,
 *   landed: number,
 *   failed: number,
 *   testsAdded: number,
 *   saturated: boolean,
 *   recommendation: string,
 *   error?: string,
 * }>}
 */
async function runPolishLoop(options) {
  if (options != null && (typeof options !== 'object' || Array.isArray(options))) {
    return {
      rounds: 0,
      landed: 0,
      failed: 0,
      testsAdded: 0,
      saturated: false,
      recommendation: 'options must be an object or nullish.',
      error: 'INVALID_OPTIONS: expected object, got ' + (Array.isArray(options) ? 'array' : typeof options),
    };
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

  // -----------------------------------------------------------------------
  // Step 1: Load adapter and objective
  // -----------------------------------------------------------------------
  let adapter;

  try {
    const { loadOvernightAdapter } = require('./overnight_adapter.cjs');
    adapter = loadOvernightAdapter(adapterPath, { repoRoot });
  } catch (err) {
    return {
      rounds: 0,
      landed: 0,
      failed: 0,
      testsAdded: 0,
      saturated: false,
      recommendation: `Failed to load adapter: ${err.message}`,
      error: `adapter_load_error: ${err.message}`,
    };
  }

  try {
    const { loadOvernightObjective } = require('./overnight_objective.cjs');
    loadOvernightObjective(objectivePath, adapter, { repoRoot });
  } catch (err) {
    return {
      rounds: 0,
      landed: 0,
      failed: 0,
      testsAdded: 0,
      saturated: false,
      recommendation: `Failed to load objective: ${err.message}`,
      error: `objective_load_error: ${err.message}`,
    };
  }

  // -----------------------------------------------------------------------
  // Step 2: Run rounds
  // -----------------------------------------------------------------------
  const roundResults = [];

  for (let roundNum = 0; roundNum < maxRounds; roundNum++) {
    // In dry-run mode, simulate a single round with zero results and stop.
    if (dryRun) {
      roundResults.push({
        landed: 0,
        failed: 0,
        testsAdded: 0,
        saturated: false,
      });
      break;
    }

    // Attempt a real batch round.
    let batchResult;
    try {
      const { runOvernightBatch } = require('./overnight_engine.cjs');
      batchResult = await runOvernightBatch({
        cwd: repoRoot,
        adapterPath,
        objectivePath,
        allowDirty: true,
        proposalLoader: effectiveProposalLoader,
      });
    } catch (err) {
      // Record the failed round and continue
      roundResults.push({
        landed: 0,
        failed: 1,
        testsAdded: 0,
        saturated: false,
      });
      continue;
    }

    const landed = Number(batchResult && batchResult.landed) || 0;
    const failed = Number(batchResult && batchResult.failed) || 0;
    const testsAdded = Number(batchResult && batchResult.testsAdded) || 0;

    // Check diminishing returns
    let saturated = false;
    if (untilSaturated) {
      try {
        const { detectDiminishingReturns } = require('./diminishing_returns.cjs');
        const roundHistory = roundResults.map((r, idx) => ({
          roundNumber: idx + 1,
          landed: r.landed,
          attempted: r.landed + r.failed,
        }));
        // Add the current round
        roundHistory.push({
          roundNumber: roundResults.length + 1,
          landed,
          attempted: landed + failed,
        });
        const detection = detectDiminishingReturns(roundHistory, []);
        saturated = detection.saturated;
      } catch (_) {
        // If detection fails, continue without saturation signal
      }
    }

    roundResults.push({ landed, failed, testsAdded, saturated });

    if (saturated) {
      break;
    }
  }

  return buildPolishSummary(roundResults);
}

module.exports = {
  parsePolishOptions,
  buildPolishSummary,
  runPolishLoop,
};
