'use strict';

/**
 * xo_pipeline.cjs — Full XO orchestrator: BUILD -> POLISH -> FUZZ -> BENCHMARK -> IMPROVE -> FINAL POLISH.
 *
 * Runs all six phases in sequence as a single command. Uses dependency injection
 * (options.runners) for testability — tests inject mock runners, production
 * lazy-requires the real modules.
 *
 * Exports:
 *   parseXoCommand(argv)        — parse CLI args into structured options
 *   runXoPipeline(options)      — main orchestrator, returns { phases, summary }
 *   buildXoSummary(phaseResults) — aggregate phase results into summary object
 *   formatXoReport(summary)     — render summary as terminal string
 *
 * Error codes (all AdapterError):
 *   XO_INVALID_OPTIONS   — null/non-object options
 *   XO_REPO_ROOT_REQUIRED — missing repoRoot
 */

const path = require('node:path');
const { AdapterError } = require('./errors.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_PHASES = ['build', 'polish', 'fuzz', 'benchmark', 'improve', 'finalPolish'];
const DEFAULT_MAX_POLISH_ROUNDS = 10;
const DEFAULT_FUZZ_RUNS = 100;
const FINAL_POLISH_ROUNDS = 3;
const DEFAULT_CODEX_REASONING = 'medium';

// ---------------------------------------------------------------------------
// parseXoCommand
// ---------------------------------------------------------------------------

/**
 * Parse CLI-style argv into a structured options object.
 *
 * @param {string[]} argv
 * @returns {{
 *   repoRoot: string|undefined,
 *   phases: string[],
 *   dryRun: boolean,
 *   maxPolishRounds: number,
 *   fuzzRuns: number,
 *   codexReasoning: string,
 * }}
 */
function parseXoCommand(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const result = {
    repoRoot: undefined,
    phases: ALL_PHASES.slice(),
    dryRun: false,
    maxPolishRounds: DEFAULT_MAX_POLISH_ROUNDS,
    fuzzRuns: DEFAULT_FUZZ_RUNS,
    codexReasoning: DEFAULT_CODEX_REASONING,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo-root' && i + 1 < args.length) {
      result.repoRoot = args[++i];
    } else if (arg === '--phases' && i + 1 < args.length) {
      const raw = args[++i];
      result.phases = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--max-polish-rounds' && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      result.maxPolishRounds = Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_MAX_POLISH_ROUNDS;
    } else if (arg === '--fuzz-runs' && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      result.fuzzRuns = Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_FUZZ_RUNS;
    } else if (arg === '--codex-reasoning' && i + 1 < args.length) {
      result.codexReasoning = args[++i];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lazy-load real runners (avoids circular deps at module load time)
// ---------------------------------------------------------------------------

function getDefaultRunners() {
  return {
    directive: () => {
      const { listApprovedDirectives } = require('./directive_approval.cjs');
      const { runDirective } = require('./directive_runner.cjs');
      return { listApprovedDirectives, runDirective };
    },
    polish: (opts) => {
      const { runPolishLoop } = require('./polish_runner.cjs');
      return runPolishLoop(opts);
    },
    fuzz: (modulePath, opts) => {
      const { fuzzModule } = require('./fuzz_engine.cjs');
      return fuzzModule(modulePath, opts);
    },
    benchmark: (benchmark, opts) => {
      const { runBenchmarkSuite } = require('./benchmark_runner.cjs');
      return runBenchmarkSuite(benchmark, opts);
    },
    improve: (opts) => {
      const { runImproveLoop } = require('./improve_runner.cjs');
      return runImproveLoop(opts);
    },
    build: (opts) => {
      const { runBuildPipeline } = require('./build_pipeline.cjs');
      return runBuildPipeline(opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Phase runners
// ---------------------------------------------------------------------------

/**
 * Phase 1: BUILD — check for approved directives, run them if present.
 */
async function phaseBuild(options, runners) {
  const directiveRunner = runners.directive;
  let directives;

  if (typeof directiveRunner === 'function') {
    const api = directiveRunner();
    directives = api.listApprovedDirectives(options.repoRoot);
  } else {
    return { skipped: true, reason: 'no directive runner', directives: 0 };
  }

  if (!Array.isArray(directives) || directives.length === 0) {
    return { skipped: true, reason: 'no approved directives', directives: 0 };
  }

  if (options.dryRun) {
    return { skipped: false, dryRun: true, directives: directives.length };
  }

  const results = [];
  for (const d of directives) {
    try {
      const result = await runners.build({
        directivePath: d.path,
        repoRoot: options.repoRoot,
        dryRun: options.dryRun,
      });
      results.push({ path: d.path, ok: true, result });
    } catch (err) {
      results.push({ path: d.path, ok: false, error: err.message || String(err) });
    }
  }

  return { skipped: false, directives: directives.length, results };
}

/**
 * Phase 2: POLISH — run the polish loop.
 */
async function phasePolish(options, runners) {
  if (options.dryRun) {
    return { skipped: false, dryRun: true, rounds: 0 };
  }

  const result = await runners.polish({
    rounds: options.maxPolishRounds || DEFAULT_MAX_POLISH_ROUNDS,
    repoRoot: options.repoRoot,
    dryRun: options.dryRun,
  });

  return { skipped: false, ...result };
}

/**
 * Phase 3: FUZZ — fuzz all modules in proving-ground/lib/.
 */
async function phaseFuzz(options, runners) {
  if (options.dryRun) {
    return { skipped: false, dryRun: true, crashes: [], totalModules: 0 };
  }

  const fs = require('node:fs');
  const libDir = path.join(options.repoRoot, 'proving-ground', 'lib');
  let moduleFiles = [];

  try {
    const entries = fs.readdirSync(libDir);
    moduleFiles = entries.filter((f) => f.endsWith('.cjs') || f.endsWith('.js'));
  } catch (_err) {
    return { skipped: true, reason: 'lib directory not found', crashes: [], totalModules: 0 };
  }

  const allCrashes = [];
  for (const file of moduleFiles) {
    try {
      const modResult = runners.fuzz(path.join(libDir, file), {
        numRuns: options.fuzzRuns || DEFAULT_FUZZ_RUNS,
      });
      if (modResult && Array.isArray(modResult.crashes)) {
        for (const c of modResult.crashes) {
          allCrashes.push({ module: file, ...c });
        }
      } else if (modResult && modResult.results) {
        for (const [fnName, fnResult] of Object.entries(modResult.results)) {
          if (fnResult.crashes && fnResult.crashes.length > 0) {
            for (const c of fnResult.crashes) {
              allCrashes.push({ module: file, fn: fnName, ...c });
            }
          }
        }
      }
    } catch (_err) {
      // Fuzz failure on a module is non-fatal — continue fuzzing others
    }
  }

  return { skipped: false, crashes: allCrashes, totalModules: moduleFiles.length };
}

/**
 * Phase 4: BENCHMARK — run all benchmark YAML files.
 */
async function phaseBenchmark(options, runners) {
  if (options.dryRun) {
    return { skipped: false, dryRun: true, passed: 0, failed: 0, results: [] };
  }

  const fs = require('node:fs');
  const YAML = require('yaml');
  const benchDir = path.join(options.repoRoot, 'benchmarks');
  let benchFiles = [];

  try {
    const entries = fs.readdirSync(benchDir);
    benchFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch (_err) {
    return { skipped: true, reason: 'benchmarks directory not found', passed: 0, failed: 0, results: [] };
  }

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const file of benchFiles) {
    try {
      const text = fs.readFileSync(path.join(benchDir, file), 'utf8');
      const benchmark = YAML.parse(text);
      const caseResults = runners.benchmark(benchmark, { cwd: options.repoRoot });

      // Audit P1: benchmark_runner emits verdict:'PASS' for success and
      // 'BENCHMARK_VIOLATION' for every failure mode. Earlier the filter
      // looked for 'BENCHMARK_PASS' — a string the runner never produces —
      // so every successful case was counted as failed and the pipeline
      // summary inverted reality. Normalize on the runner's actual verdict.
      const filePassed = Array.isArray(caseResults)
        ? caseResults.filter((r) => r && r.verdict === 'PASS').length
        : 0;
      const fileFailed = Array.isArray(caseResults)
        ? caseResults.filter((r) => !r || r.verdict !== 'PASS').length
        : 0;

      passed += filePassed;
      failed += fileFailed;
      results.push({ file, passed: filePassed, failed: fileFailed, cases: caseResults });
    } catch (err) {
      failed += 1;
      results.push({ file, passed: 0, failed: 1, error: err.message || String(err) });
    }
  }

  return { skipped: false, passed, failed, results };
}

/**
 * Phase 5: IMPROVE — run improve loop with 1 Opus + 1 Sonnet proposing optimizations.
 */
async function phaseImprove(options, runners, benchmarkResult) {
  if (options.dryRun) {
    return { skipped: false, dryRun: true, improvements: 0, accepted: 0, agents: ['opus', 'sonnet'] };
  }

  // Only run improve if there were benchmark failures or results present
  const hasRoom = benchmarkResult && (benchmarkResult.failed > 0 || benchmarkResult.passed > 0);
  if (!hasRoom) {
    return { skipped: true, reason: 'no benchmarks to improve against', improvements: 0, accepted: 0 };
  }

  // Run with Opus (deep optimization) + Sonnet (fast challenger) — not MiniMax
  const result = await runners.improve({
    repoRoot: options.repoRoot,
    dryRun: options.dryRun,
    rounds: options.maxPolishRounds || DEFAULT_MAX_POLISH_ROUNDS,
    modelConfig: { agents: ['opus', 'sonnet'] },
  });

  return {
    skipped: false,
    improvements: (result && result.improvements) || 0,
    accepted: (result && result.improvements) || 0,
    ...result,
  };
}

/**
 * Phase 6: FINAL POLISH — one more polish loop with 3 rounds.
 */
async function phaseFinalPolish(options, runners) {
  if (options.dryRun) {
    return { skipped: false, dryRun: true, rounds: 0 };
  }

  const result = await runners.polish({
    rounds: FINAL_POLISH_ROUNDS,
    repoRoot: options.repoRoot,
    dryRun: options.dryRun,
  });

  return { skipped: false, ...result };
}

// ---------------------------------------------------------------------------
// buildXoSummary
// ---------------------------------------------------------------------------

/**
 * Aggregate phase results into a summary object.
 *
 * @param {object} phaseResults — { build, polish, fuzz, benchmark, improve, finalPolish }
 * @returns {{
 *   totalTests: number,
 *   totalCrashes: number,
 *   benchmarksPassed: number,
 *   improvementsAccepted: number,
 *   polishRounds: number,
 *   diminishingReturns: boolean,
 * }}
 */
function buildXoSummary(phaseResults) {
  const pr = (phaseResults && typeof phaseResults === 'object') ? phaseResults : {};

  const polishResult = pr.polish || {};
  const fuzzResult = pr.fuzz || {};
  const benchmarkResult = pr.benchmark || {};
  const improveResult = pr.improve || {};
  const finalPolishResult = pr.finalPolish || {};

  const polishRounds = (polishResult.rounds || 0) + (finalPolishResult.rounds || 0);
  const totalTests = (polishResult.testsAdded || 0) + (finalPolishResult.testsAdded || 0);
  const totalCrashes = Array.isArray(fuzzResult.crashes) ? fuzzResult.crashes.length : 0;
  const benchmarksPassed = benchmarkResult.passed || 0;
  const improvementsAccepted = improveResult.accepted || improveResult.improvements || 0;

  // Detect diminishing returns: polish saturated or improve saturated
  const diminishingReturns = !!(polishResult.saturated || finalPolishResult.saturated || improveResult.saturated);

  return {
    totalTests,
    totalCrashes,
    benchmarksPassed,
    improvementsAccepted,
    polishRounds,
    diminishingReturns,
  };
}

// ---------------------------------------------------------------------------
// formatXoReport
// ---------------------------------------------------------------------------

/**
 * Render a summary as a terminal-friendly report string.
 *
 * @param {object} summary — output from buildXoSummary
 * @returns {string}
 */
function formatXoReport(summary) {
  const s = (summary && typeof summary === 'object') ? summary : {};

  const lines = [
    '=== XO Pipeline Report ===',
    '',
    `  Polish rounds:          ${s.polishRounds ?? 0}`,
    `  Tests added:            ${s.totalTests ?? 0}`,
    `  Fuzz crashes found:     ${s.totalCrashes ?? 0}`,
    `  Benchmarks passed:      ${s.benchmarksPassed ?? 0}`,
    `  Improvements accepted:  ${s.improvementsAccepted ?? 0}`,
    `  Diminishing returns:    ${s.diminishingReturns ? 'yes' : 'no'}`,
    '',
    '==========================',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// runXoPipeline
// ---------------------------------------------------------------------------

/**
 * Main XO orchestrator. Runs 6 phases in sequence:
 *   BUILD -> POLISH -> FUZZ -> BENCHMARK -> IMPROVE -> FINAL POLISH
 *
 * @param {{
 *   repoRoot: string,
 *   phases?: string[],
 *   dryRun?: boolean,
 *   maxPolishRounds?: number,
 *   fuzzRuns?: number,
 *   codexReasoning?: string,
 *   runners?: {
 *     polish?: function,
 *     build?: function,
 *     fuzz?: function,
 *     benchmark?: function,
 *     improve?: function,
 *     directive?: function,
 *   },
 * }} options
 * @returns {Promise<{ phases: object, summary: object }>}
 * @throws {AdapterError} XO_INVALID_OPTIONS — null/non-object
 * @throws {AdapterError} XO_REPO_ROOT_REQUIRED — missing repoRoot
 */
async function runXoPipeline(options) {
  // Guard: options must be a non-null object
  if (options === null || options === undefined || typeof options !== 'object' || Array.isArray(options)) {
    throw new AdapterError(
      'XO_INVALID_OPTIONS',
      'options',
      'runXoPipeline options must be a non-null object',
      { fixHint: 'Pass an object with at least { repoRoot } to runXoPipeline.' },
    );
  }

  // Guard: repoRoot is required
  if (!options.repoRoot || typeof options.repoRoot !== 'string') {
    throw new AdapterError(
      'XO_REPO_ROOT_REQUIRED',
      'repoRoot',
      'repoRoot must be a non-empty string',
      { fixHint: 'Pass options.repoRoot pointing to the repository root directory.' },
    );
  }

  const resolvedRoot = path.resolve(options.repoRoot);
  const activePhases = Array.isArray(options.phases) && options.phases.length > 0
    ? options.phases
    : ALL_PHASES.slice();

  const runners = (options.runners && typeof options.runners === 'object')
    ? { ...getDefaultRunners(), ...options.runners }
    : getDefaultRunners();

  const opts = {
    repoRoot: resolvedRoot,
    dryRun: options.dryRun || false,
    maxPolishRounds: options.maxPolishRounds || DEFAULT_MAX_POLISH_ROUNDS,
    fuzzRuns: options.fuzzRuns || DEFAULT_FUZZ_RUNS,
    codexReasoning: options.codexReasoning || DEFAULT_CODEX_REASONING,
  };

  const phases = {};

  // Phase 1: BUILD
  if (activePhases.includes('build')) {
    phases.build = await phaseBuild(opts, runners);
  } else {
    phases.build = { skipped: true, reason: 'phase not selected' };
  }

  // Phase 2: POLISH
  if (activePhases.includes('polish')) {
    phases.polish = await phasePolish(opts, runners);
  } else {
    phases.polish = { skipped: true, reason: 'phase not selected' };
  }

  // Phase 3: FUZZ
  if (activePhases.includes('fuzz')) {
    phases.fuzz = await phaseFuzz(opts, runners);
  } else {
    phases.fuzz = { skipped: true, reason: 'phase not selected', crashes: [] };
  }

  // Phase 4: BENCHMARK
  if (activePhases.includes('benchmark')) {
    phases.benchmark = await phaseBenchmark(opts, runners);
  } else {
    phases.benchmark = { skipped: true, reason: 'phase not selected', passed: 0, failed: 0, results: [] };
  }

  // Phase 5: IMPROVE
  if (activePhases.includes('improve')) {
    phases.improve = await phaseImprove(opts, runners, phases.benchmark);
  } else {
    phases.improve = { skipped: true, reason: 'phase not selected' };
  }

  // Phase 6: FINAL POLISH
  if (activePhases.includes('finalPolish')) {
    phases.finalPolish = await phaseFinalPolish(opts, runners);
  } else {
    phases.finalPolish = { skipped: true, reason: 'phase not selected' };
  }

  const summary = buildXoSummary(phases);

  return { phases, summary };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parseXoCommand,
  runXoPipeline,
  buildXoSummary,
  formatXoReport,
  ALL_PHASES,
  DEFAULT_MAX_POLISH_ROUNDS,
  DEFAULT_FUZZ_RUNS,
  FINAL_POLISH_ROUNDS,
};
