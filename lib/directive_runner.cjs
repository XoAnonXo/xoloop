'use strict';

/**
 * directive_runner.cjs — Route validated directives to engine mode runners.
 *
 * Exports:
 *   parseDirectiveCommand(argv)  — parse CLI args into { directivePath, dryRun, repoRoot }
 *   routeDirective(directive)    — pure routing: returns { mode, options }
 *   runDirective(options)        — load directive, route, execute runner
 *
 * Dependency injection:
 *   options.runners = { polish, improve, build } lets tests supply mock runners.
 *   Defaults to real runners via lazy require when runners are not provided.
 *
 * Priority → round count:
 *   P0 → 10 rounds
 *   P1 → 5 rounds
 *   P2 → 3 rounds
 *   P3 → 1 round
 *
 * Error codes (all AdapterError):
 *   DIRECTIVE_RUN_INVALID_OPTIONS  — null/non-object options
 *   DIRECTIVE_RUN_PATH_REQUIRED    — missing directivePath
 *   DIRECTIVE_RUN_UNSUPPORTED_ACTION — unknown action
 *   DIRECTIVE_RUN_FAILED           — runner threw
 */

const path = require('node:path');
const { AdapterError } = require('./errors.cjs');
const { loadDirective } = require('./directive_loader.cjs');

// ---------------------------------------------------------------------------
// Priority → round count map
// ---------------------------------------------------------------------------

const PRIORITY_ROUNDS = {
  P0: 10,
  P1: 5,
  P2: 3,
  P3: 1,
};

// ---------------------------------------------------------------------------
// parseDirectiveCommand
// ---------------------------------------------------------------------------

/**
 * Parse CLI-style argv into a structured options object for the directive runner.
 *
 * @param {string[]} argv
 * @returns {{ directivePath: string|undefined, dryRun: boolean, repoRoot: string|undefined }}
 */
function parseDirectiveCommand(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const result = {
    directivePath: undefined,
    dryRun: false,
    repoRoot: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--repo-root' && i + 1 < args.length) {
      result.repoRoot = args[++i];
    } else if (arg === '--directive' && i + 1 < args.length) {
      result.directivePath = args[++i];
    } else if (!arg.startsWith('--') && result.directivePath === undefined) {
      // positional argument — treat as directivePath
      result.directivePath = arg;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// routeDirective
// ---------------------------------------------------------------------------

/**
 * Pure routing function: given a validated directive object, return the
 * target mode and runner options.
 *
 * @param {{
 *   action: 'polish' | 'improve' | 'build',
 *   priority: 'P0' | 'P1' | 'P2' | 'P3',
 *   targetSurface?: string,
 *   benchmarkPath?: string|null,
 *   featureDescription?: string|null,
 *   sourcePath?: string,
 * }} directive
 * @returns {{
 *   mode: 'polish' | 'improve' | 'build',
 *   options: object,
 * }}
 * @throws {AdapterError} DIRECTIVE_RUN_UNSUPPORTED_ACTION if action is unknown
 */
function routeDirective(directive) {
  if (!directive || typeof directive !== 'object' || Array.isArray(directive)) {
    throw new AdapterError(
      'DIRECTIVE_RUN_UNSUPPORTED_ACTION',
      'action',
      'directive must be a non-null object',
      { fixHint: 'Pass a validated directive object (from loadDirective) to routeDirective.' },
    );
  }

  const { action, priority } = directive;
  const rounds = PRIORITY_ROUNDS[priority] !== undefined ? PRIORITY_ROUNDS[priority] : 1;

  if (action === 'polish') {
    return {
      mode: 'polish',
      options: {
        rounds,
        untilSaturated: false,
        targetSurface: directive.targetSurface || undefined,
      },
    };
  }

  if (action === 'improve') {
    return {
      mode: 'improve',
      options: {
        rounds,
        benchmarkPath: directive.benchmarkPath || undefined,
        targetSurface: directive.targetSurface || undefined,
      },
    };
  }

  if (action === 'build') {
    return {
      mode: 'build',
      options: {
        featureDescription: directive.featureDescription || undefined,
        targetSurface: directive.targetSurface || undefined,
        requiresApproval: directive.requiresApproval || false,
      },
    };
  }

  throw new AdapterError(
    'DIRECTIVE_RUN_UNSUPPORTED_ACTION',
    'action',
    `unsupported action: ${JSON.stringify(action)}`,
    { fixHint: 'Directive action must be one of: polish, improve, build.' },
  );
}

// ---------------------------------------------------------------------------
// Lazy-load real runners (avoids circular deps at module load time)
// ---------------------------------------------------------------------------

function getDefaultRunners() {
  const { runPolishLoop } = require('./polish_runner.cjs');
  const { runImproveLoop } = require('./improve_runner.cjs');
  const { runBuildPipeline } = require('./build_pipeline.cjs');
  return {
    polish: runPolishLoop,
    improve: runImproveLoop,
    build: runBuildPipeline,
  };
}

// ---------------------------------------------------------------------------
// runDirective
// ---------------------------------------------------------------------------

/**
 * Load a directive YAML, route it, and execute the appropriate runner.
 *
 * @param {{
 *   directivePath: string,
 *   dryRun?: boolean,
 *   repoRoot?: string,
 *   runners?: {
 *     polish?: function,
 *     improve?: function,
 *     build?: function,
 *   },
 * }} options
 * @returns {Promise<object>} — result from the executed runner
 * @throws {AdapterError} DIRECTIVE_RUN_INVALID_OPTIONS — null/non-object options
 * @throws {AdapterError} DIRECTIVE_RUN_PATH_REQUIRED   — missing directivePath
 * @throws {AdapterError} DIRECTIVE_RUN_UNSUPPORTED_ACTION — unknown action
 * @throws {AdapterError} DIRECTIVE_RUN_FAILED          — runner threw
 */
async function runDirective(options) {
  // Guard: options must be a non-null object
  if (options === null || options === undefined || typeof options !== 'object' || Array.isArray(options)) {
    throw new AdapterError(
      'DIRECTIVE_RUN_INVALID_OPTIONS',
      'options',
      'runDirective options must be a non-null object',
      { fixHint: 'Pass an object with at least { directivePath } to runDirective.' },
    );
  }

  const {
    directivePath,
    dryRun = false,
    repoRoot,
    runners: injectedRunners,
  } = options;

  // Guard: directivePath is required
  if (!directivePath || typeof directivePath !== 'string') {
    throw new AdapterError(
      'DIRECTIVE_RUN_PATH_REQUIRED',
      'directivePath',
      'directivePath must be a non-empty string',
      { fixHint: 'Pass the path to the directive YAML file as options.directivePath.' },
    );
  }

  // Step 1: Load the directive
  const resolvedRepoRoot = repoRoot ? path.resolve(repoRoot) : process.cwd();
  const directive = loadDirective(directivePath, { repoRoot: resolvedRepoRoot });

  // Step 2: Route to mode + runner options
  const { mode, options: routeOpts } = routeDirective(directive);

  // Step 3: Resolve runner (injected > real default)
  const runners = (injectedRunners && typeof injectedRunners === 'object') ? injectedRunners : getDefaultRunners();

  const runner = runners[mode];
  if (typeof runner !== 'function') {
    throw new AdapterError(
      'DIRECTIVE_RUN_UNSUPPORTED_ACTION',
      'mode',
      `no runner registered for mode: ${mode}`,
      { fixHint: `Provide a runners.${mode} function in options.runners, or ensure the real runner module exists.` },
    );
  }

  // Step 4: Build runner call options — merge route options + run context
  const runnerOptions = {
    ...routeOpts,
    dryRun,
    repoRoot: resolvedRepoRoot,
    // For improve: propagate benchmarkPath from directive if present
    ...(directive.benchmarkPath ? { benchmarkPath: directive.benchmarkPath } : {}),
  };

  // Step 5: Execute runner, wrapping errors in DIRECTIVE_RUN_FAILED
  let result;
  try {
    result = await runner(runnerOptions);
  } catch (err) {
    throw new AdapterError(
      'DIRECTIVE_RUN_FAILED',
      'runner',
      `runner for mode "${mode}" threw: ${err && err.message ? err.message : String(err)}`,
      { fixHint: `Inspect the underlying error for mode "${mode}".`, cause: err },
    );
  }

  return result;
}

module.exports = {
  parseDirectiveCommand,
  routeDirective,
  runDirective,
};
