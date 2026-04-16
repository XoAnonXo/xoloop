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

// Audit P2 helper: find a git-tracked benchmark YAML to drive IMPROVE.
// Prefers whatever the most recent BENCHMARK phase actually exercised
// (that's the contract the improve loop is meant to close against). Falls
// back to the first tracked benchmark file in `benchmarks/`. Returns
// undefined when nothing suitable exists so the caller can skip with a
// clear reason instead of invoking the runner into its no-op branch.
function resolveBenchmarkPath(repoRoot, benchmarkResult) {
  if (!repoRoot || typeof repoRoot !== 'string') return undefined;
  // Audit P2 (round 5): earlier this picked the FIRST benchmark result,
  // which meant IMPROVE ran against a benchmark that already passed —
  // silently optimizing code that didn't need optimizing and ignoring
  // the one that actually failed. Prefer benchmarks with observed
  // failures, then benchmarks with observed passes, then fall back to
  // tracked files. Operators who only have one benchmark see identical
  // behavior; operators with several get the benchmark that the
  // improve loop should actually target.
  const failed = [];
  const passing = [];
  if (benchmarkResult && Array.isArray(benchmarkResult.results)) {
    for (const entry of benchmarkResult.results) {
      if (!entry || typeof entry.file !== 'string' || entry.skipped) continue;
      if ((entry.failed || 0) > 0) failed.push(entry.file);
      else if ((entry.passed || 0) > 0) passing.push(entry.file);
    }
  }
  const candidates = failed.length > 0 ? failed : passing;
  if (candidates.length === 0) {
    const { spawnSync } = require('node:child_process');
    const tracked = spawnSync('git', ['ls-files', '--', 'benchmarks'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (tracked.status === 0) {
      const lines = String(tracked.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.yaml') || line.endsWith('.yml'));
      candidates.push(...lines.map((line) => path.basename(line)));
    }
  }
  if (candidates.length === 0) return undefined;
  return path.join('benchmarks', candidates[0]);
}

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
    allowBenchmarkExec: false,
    allowDirectiveExec: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo-root' && i + 1 < args.length) {
      result.repoRoot = args[++i];
    } else if (arg === '--phases' && i + 1 < args.length) {
      // Audit P3 (round 7): previously any string passed to --phases was
      // stored verbatim and later just checked with `includes()`, so a
      // typo like `--phases buidl,polish` silently disabled the BUILD
      // phase with no warning. Validate against ALL_PHASES at parse
      // time: record unknown entries in `phaseWarnings` (picked up by
      // runXoPipeline and surfaced in summary) and keep only the
      // known-good names in `phases`. Empty payloads are treated as
      // "use defaults" rather than "disable everything", which matches
      // operator intent better than a silent no-op pipeline.
      const raw = args[++i];
      const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const knownSet = new Set(ALL_PHASES);
      const known = requested.filter((p) => knownSet.has(p));
      const unknown = requested.filter((p) => !knownSet.has(p));
      result.phases = known.length > 0 ? known : ALL_PHASES.slice();
      if (unknown.length > 0) {
        if (!Array.isArray(result.phaseWarnings)) result.phaseWarnings = [];
        for (const name of unknown) {
          result.phaseWarnings.push({
            kind: 'unknown-phase',
            requested: name,
            hint: `--phases received "${name}"; known phases are ${ALL_PHASES.join(', ')}`,
          });
        }
      }
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
    } else if (arg === '--allow-benchmark-exec') {
      // Audit P2 (round 4): the BENCHMARK/IMPROVE opt-in gate was
      // unreachable from the CLI because parseXoCommand had no flag
      // exposing it. Runtime callers could set allowBenchmarkExec:true
      // via runXoPipeline({...}) directly, but `xo` on the command line
      // had no way to turn benchmarks on. Expose it as a boolean flag
      // so the gate is genuinely opt-in-able rather than unreachable.
      result.allowBenchmarkExec = true;
    } else if (arg === '--allow-directive-exec') {
      // Audit P1 (round 6): same opt-in pattern for directive
      // execution. CLI now reaches the gate so operators can enable
      // BUILD directive execution explicitly, and the default stays
      // safe against committed-but-unexamined approved directives.
      result.allowDirectiveExec = true;
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
      const { listApprovedDirectives, completeDirective } = require('./directive_approval.cjs');
      const { runDirective } = require('./directive_runner.cjs');
      return { listApprovedDirectives, runDirective, completeDirective };
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
  let api;

  // Audit P2 (round 3): listApprovedDirectives treats its first argument
  // as the directives base directory (default `.xoanon/directives`), so
  // passing the raw `options.repoRoot` was reading from
  // `<repoRoot>/approved` — a directory that almost never exists in real
  // repos. Resolve against the .xoanon/directives subdirectory that
  // directive_approval uses by default.
  const directivesBaseDir = path.join(options.repoRoot, '.xoanon', 'directives');

  // Audit P1 (round 6): any file sitting in `.xoanon/directives/approved/`
  // was treated as "human-approved" and executed. A malicious branch
  // (or a typo during rebase) that commits a YAML file into that folder
  // lands auto-exec. Gate this phase on an explicit opt-in flag — same
  // pattern as benchmark execution — so a committed-but-unexamined
  // directive cannot slip through on the next XO run.
  if (options.allowDirectiveExec !== true) {
    return {
      skipped: true,
      reason: 'directive execution requires explicit opt-in (pass options.allowDirectiveExec=true or --allow-directive-exec); refused by default so committed `.xoanon/directives/approved/*` files cannot auto-exec',
      directives: 0,
    };
  }

  if (typeof directiveRunner === 'function') {
    api = directiveRunner();
    directives = api.listApprovedDirectives(directivesBaseDir);
  } else {
    return { skipped: true, reason: 'no directive runner', directives: 0 };
  }

  if (!Array.isArray(directives) || directives.length === 0) {
    return { skipped: true, reason: 'no approved directives', directives: 0 };
  }

  if (options.dryRun) {
    return { skipped: false, dryRun: true, directives: directives.length };
  }

  // Audit P2 (round 2): earlier this phase was calling `runners.build`
  // (which is the runBuildPipeline feature-authoring entry point) with a
  // `{directivePath, ...}` payload runBuildPipeline silently misinterpreted
  // — then tagging every non-throwing return as `ok: true`. Route through
  // the directive runner's own `runDirective` function (which is already
  // bundled alongside `listApprovedDirectives` in the directive runner
  // API) and honor its contract:
  //   - truthy `ok: false` or present `error` -> failed
  //   - status 'success'/'applied'/'build_complete' -> success
  //   - everything else -> suspicious, surface as failed instead of
  //     silent success
  //
  // Audit P2 (round 2) also: processed directives used to stay in the
  // approved queue so the next XO run replayed them. Move each directive
  // out of approved with `completeDirective` once its attempt finishes
  // (whether success or failure) so the queue state reflects reality.
  const canComplete = typeof api.completeDirective === 'function';
  const canRun = typeof api.runDirective === 'function';
  const results = [];
  for (const d of directives) {
    let ok = false;
    let result = null;
    let errorMsg = null;
    // Scope outside the try so the completion/archive step below can
    // read it (round 8 introduced this state; it was accidentally scoped
    // inside try and triggered ReferenceError in the follow-up logic).
    let pendingExternalAction = false;
    try {
      if (canRun) {
        // Audit P2 (round 3): runDirective takes a SINGLE options object
        // with directivePath as a string — not (directiveObject, opts) like
        // my round-2 fix accidentally coded. Pass the canonical shape.
        result = await api.runDirective({
          directivePath: d.path,
          repoRoot: options.repoRoot,
          dryRun: options.dryRun,
        });
      } else {
        // Back-compat path for test harnesses that inject a minimal
        // directive runner. Fall back to `runners.build` with the legacy
        // shape but still honor the status-aware ok detection.
        result = await runners.build({
          directivePath: d.path,
          repoRoot: options.repoRoot,
          dryRun: options.dryRun,
        });
      }
      // Audit P1 (round 4): the "accept anything that isn't explicitly
      // build_failed" fallback clause also silently accepted
      // status: 'awaiting_approval' — unfinished work that still needs a
      // human review step. Archiving those directives as "complete" via
      // completeDirective() was permanently removing them from the
      // approval queue with no trace that approval never actually
      // happened.
      //
      // Audit P1 (round 8): the round-4 fix overcorrected — it flipped
      // `awaiting_approval` to ok:false, which then triggered the
      // failure path that archives the directive out of approved/. A
      // directive that finished its run and is waiting for a human
      // reviewer got filed as "failed" and removed from the queue. Use
      // three states instead of two: SUCCESS_STATUSES complete the
      // directive; PENDING_STATUSES keep it in approved/ as-is
      // (awaiting_approval, pending, in_progress, needs_review); any
      // other non-success counts as permanent failure and archives.
      const SUCCESS_STATUSES = new Set(['success', 'applied', 'build_complete', 'completed']);
      const PENDING_STATUSES = new Set([
        'awaiting_approval', 'pending', 'in_progress', 'needs_review', 'queued',
      ]);
      if (result === null || result === undefined) {
        // Runners that return nothing are treated as success (legacy
        // contract — tests rely on `runners.build` mock returning void).
        ok = true;
      } else if (result.ok === true && !result.error) {
        ok = true;
      } else if (typeof result.status === 'string' && SUCCESS_STATUSES.has(result.status) && !result.error) {
        ok = true;
      } else if (typeof result.status === 'string' && PENDING_STATUSES.has(result.status)) {
        // The directive did its job for this run and is waiting for
        // an external human/system action. Don't mark it failed and
        // don't archive it — operators will move it through approval
        // by hand or via the next phase that owns that state.
        ok = false;
        pendingExternalAction = true;
      } else {
        ok = false;
      }
      if (!ok && !pendingExternalAction) {
        errorMsg = (result && result.error)
          ? result.error
          : `runner returned non-success status: ${result && result.status ? result.status : 'unknown'}`;
      } else if (pendingExternalAction) {
        errorMsg = null;  // pending isn't an error
      }
    } catch (err) {
      ok = false;
      // Audit P2 (round 8): previously we collapsed err to its message
      // string here, which discarded err.code / err.status /
      // err.retryable — the exact fields the round-7 structured
      // retryability check needs. Attach the full error object (or a
      // shallow copy) onto the synthetic result so downstream logic
      // sees the same shape whether the runner returned a failed
      // result or threw. Permanent-vs-retryable classification now
      // works for exception paths too.
      errorMsg = err && err.message ? err.message : String(err);
      if (err && typeof err === 'object') {
        result = {
          ok: false,
          error: {
            message: errorMsg,
            code: err.code || null,
            status: typeof err.status === 'number' ? err.status : null,
            retryable: err.retryable === true,
          },
        };
      }
    }
    // Best-effort move out of the approved queue; swallow completion
    // errors so an inbox-write failure can't block the whole XO pipeline.
    //
    // Audit P2 (round 3): completeDirective signature is
    //   (directivePath, result, baseDir)
    // — not (directiveObject, options) like my round-2 fix incorrectly
    // coded. Pass the path + metadata + explicit base dir so the move
    // lands in the right .xoanon/directives tree instead of throwing
    // DIRECTIVE_NOT_FOUND on a stringified object.
    //
    // Audit P2 (round 5): completion failures used to be silently
    // swallowed, so a permissions error, disk-full condition, or a
    // rename race would leave the directive in the approved/ queue
    // forever (replaying on every XO run) with zero visibility. Capture
    // the error and attach it to the result so operators see which
    // directives failed to move to history.
    // Audit P2 (round 6): previously ANY execution failure moved the
    // directive out of `approved/` — including transient failures like
    // a network blip, ETIMEDOUT against the model provider, or a disk
    // I/O flake. The directive never got retried and the user's
    // approval work was wasted. Keep the directive in approved/ when
    // the error is clearly retryable.
    //
    // Audit P2 (round 7): earlier we classified retryability entirely via
    // regex over the error message, which was brittle — a provider-
    // specific message like "Anthropic API: request timed out (overloaded)"
    // didn't match any of our patterns and got archived as a permanent
    // failure. Extend detection to also consider:
    //   1. err.code (Node's standardized POSIX codes are exact matches)
    //   2. err.retryable (structured flag set by well-behaved callers)
    //   3. HTTP status codes 408/429/500-504 if present on err.status
    //   4. existing text-pattern heuristics as a fallback
    // This catches provider-specific shapes without us guessing every
    // error string upstream might emit.
    const RETRYABLE_CODES = new Set([
      'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
      'ENETUNREACH', 'EHOSTUNREACH', 'EAGAIN', 'EPIPE',
      'ENOSPC',   // disk full — retry after operator frees space
      'EBUSY',    // resource busy — retry later
    ]);
    const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
    const retryableErrorPatterns = [
      /ETIMEDOUT/i,
      /ECONNRESET/i,
      /ECONNREFUSED/i,
      /EAI_AGAIN/i,
      /ENETUNREACH/i,
      /EHOSTUNREACH/i,
      /EAGAIN/i,
      /ENOSPC/i,
      /rate[\s-]?limit/i,
      /temporar/i,        // covers "temporary failure", "temporarily unavailable"
      /\bretry/i,
      /overloaded/i,
      /service unavailable/i,
      /timed?\s+out/i,
    ];
    let looksRetryable = false;
    if (!ok) {
      const errObj = (typeof result === 'object' && result !== null) ? result : null;
      const errorCode = errObj && errObj.errorCode
        ? errObj.errorCode
        : (errObj && errObj.error && typeof errObj.error === 'object' ? errObj.error.code : null);
      const errorStatus = errObj && errObj.error && typeof errObj.error === 'object'
        ? errObj.error.status
        : null;
      const structuredRetryable = errObj && errObj.error && typeof errObj.error === 'object'
        ? errObj.error.retryable === true
        : (errObj ? errObj.retryable === true : false);
      if (structuredRetryable) {
        looksRetryable = true;
      } else if (typeof errorCode === 'string' && RETRYABLE_CODES.has(errorCode)) {
        looksRetryable = true;
      } else if (typeof errorStatus === 'number' && RETRYABLE_HTTP_STATUSES.has(errorStatus)) {
        looksRetryable = true;
      } else if (typeof errorMsg === 'string'
        && retryableErrorPatterns.some((re) => re.test(errorMsg))) {
        looksRetryable = true;
      }
    }

    let completionError = null;
    let keptInApproved = false;
    // Audit P1 (round 8): archive only on success or permanent failure.
    // Retryable failures stay in approved/ (as before), AND pending
    // external-action states (awaiting_approval, in_progress, etc.)
    // also stay in approved/ so the reviewer finds them where they
    // expect. `keptInApproved` is true for either reason.
    const shouldArchive = canComplete && !looksRetryable && !pendingExternalAction;
    if (shouldArchive) {
      try {
        api.completeDirective(
          d.path,
          { status: ok ? 'completed' : 'failed', error: errorMsg },
          directivesBaseDir,
        );
      } catch (completionErr) {
        completionError = completionErr && completionErr.message
          ? completionErr.message
          : String(completionErr);
      }
    } else if (canComplete) {
      keptInApproved = true;
    }
    results.push({
      path: d.path,
      ok,
      result,
      error: errorMsg,
      completionError,
      retryable: looksRetryable,
      keptInApproved,
      pendingExternalAction,
    });
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
    codexReasoning: options.codexReasoning,
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

  // Audit P1 (round 6): FUZZ auto-discovers every `.cjs`/`.js` under
  // `proving-ground/lib/` and hands it to fuzz_engine.fuzzModule, which
  // calls `require()` on the path. Adding a new module — or dropping a
  // file onto an attacker-controlled branch — immediately gets its
  // module-init code executed in the fuzz process. Restrict auto-
  // discovery to files tracked in git (same gate the benchmark phase
  // now enforces) so an untracked scratch module or rogue-commit file
  // cannot RCE the fuzzer on the operator's machine.
  //
  // Audit P1 (round 7): git-tracked only gates against *untracked*
  // attacker drops; it does NOT protect against a tracked file that
  // was ALTERED on the currently-checked-out branch. If an operator
  // pulls a hostile PR branch and runs XO, fuzz will happily require
  // any tracked `.cjs` — including one the attacker replaced with an
  // RCE payload. This is fundamentally the trust boundary of a code-
  // analysis tool that runs the code it analyzes, and closing it
  // further would require signed manifests or a pre-committed SHA-256
  // allowlist — either of which breaks day-to-day development. The
  // documented and accepted trust model is: DO NOT run the XO
  // pipeline on a branch you would not be willing to `require()`
  // every file from. The git-tracked gate still eliminates the
  // most common mistake (untracked scratch files); it is not meant
  // to defend against hostile branches.
  if (moduleFiles.length > 0) {
    const { spawnSync } = require('node:child_process');
    const repoCheck = spawnSync('git', ['ls-files', '--error-unmatch', '--', 'proving-ground/lib'], {
      cwd: options.repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (repoCheck.status !== 0) {
      return {
        skipped: true,
        reason: 'proving-ground/lib is not tracked by git — refusing to auto-require and fuzz untrusted modules',
        crashes: [],
        totalModules: 0,
      };
    }
    const trackedOutput = spawnSync('git', ['ls-files', '--', 'proving-ground/lib'], {
      cwd: options.repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const trackedTopLevelLib = new Set(
      String(trackedOutput.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((p) => {
          const normalized = p.replace(/\\/g, '/');
          if (!normalized.startsWith('proving-ground/lib/')) return false;
          return normalized.slice('proving-ground/lib/'.length).indexOf('/') === -1;
        })
        .map((p) => path.basename(p)),
    );
    moduleFiles = moduleFiles.filter((f) => {
      if (!trackedTopLevelLib.has(f)) return false;
      try {
        const st = fs.lstatSync(path.join(libDir, f));
        if (st.isSymbolicLink()) return false;
      } catch (_lstatErr) {
        return false;
      }
      return true;
    });
  }

  // Audit P3: the fuzz runner might be injected as async (Promise-returning)
  // for integration tests even though the production fuzz_engine.fuzzModule
  // is synchronous. Awaiting a non-Promise is a no-op, so this keeps both
  // shapes honest without regressing sync callers. Also: silent catch was
  // burying module-level failures (import errors, syntax errors), producing
  // false "no crashes" reports — surface them as synthetic crash entries
  // so operators can see that fuzzing itself failed for the module.
  const allCrashes = [];
  for (const file of moduleFiles) {
    try {
      const modResult = await runners.fuzz(path.join(libDir, file), {
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
    } catch (err) {
      allCrashes.push({
        module: file,
        fn: '<module-load>',
        error: err && err.message ? err.message : String(err),
        fingerprint: `fuzz-module-error:${file}`,
      });
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

  // Audit P1 (round 3): benchmark YAML files declare `entry_point.command`
  // strings that get shelled out when we run them. Auto-discovering every
  // tracked `benchmarks/*.yml` means any committed file becomes an RCE
  // channel against whatever environment the XO pipeline runs in. The
  // git-tracked gate alone is not enough — a PR that adds a new benchmark
  // gets auto-executed on the operator's next pipeline run.
  //
  // Make benchmark execution OPT-IN explicitly:
  //   - options.allowBenchmarkExec === true    -> run (still git-tracked)
  //   - overnight.yaml:benchmarks.auto_run=true -> run (still git-tracked)
  //   - otherwise                              -> skip with clear reason
  // This closes the auto-exec class entirely by default; operators who
  // actually want to run benchmarks from the pipeline must say so.
  if (benchFiles.length > 0 && options.allowBenchmarkExec !== true) {
    return {
      skipped: true,
      reason: 'benchmark auto-execution requires explicit opt-in (pass options.allowBenchmarkExec=true or invoke benchmark runner directly); refused by default so tracked benchmark files cannot auto-exec on every XO run',
      passed: 0,
      failed: 0,
      results: [],
      availableBenchFiles: benchFiles.length,
    };
  }
  if (benchFiles.length > 0) {
    const { spawnSync } = require('node:child_process');
    const gitCheck = spawnSync('git', ['ls-files', '--error-unmatch', '--', 'benchmarks'], {
      cwd: options.repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (gitCheck.status !== 0) {
      return {
        skipped: true,
        reason: 'benchmarks directory is not tracked by git — refusing to auto-execute benchmark entry_point commands from an untrusted source',
        passed: 0,
        failed: 0,
        results: [],
      };
    }
    const trackedList = spawnSync('git', ['ls-files', '--', 'benchmarks'], {
      cwd: options.repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Audit P2 (round 4): the previous gate collapsed each tracked entry
    // to `path.basename(p)`, so `benchmarks/nested/evil.yaml` being
    // tracked would authorize an untracked `benchmarks/evil.yaml` at the
    // top level (same basename, different file). An attacker with access
    // to add files to a subdirectory — or a stale file left behind during
    // a rename — could piggy-back on the legit tracked entry. Compare
    // full repo-relative paths instead, and restrict auto-discovery to
    // files directly under `benchmarks/` (no subdirectory traversal).
    const trackedTopLevelBenchmarks = new Set(
      String(trackedList.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        // Only keep entries that are direct children of `benchmarks/`,
        // i.e. no further path separator in the rest.
        .filter((p) => {
          const normalized = p.replace(/\\/g, '/');
          if (!normalized.startsWith('benchmarks/')) return false;
          return normalized.slice('benchmarks/'.length).indexOf('/') === -1;
        })
        .map((p) => path.basename(p)),
    );
    // Audit P2 (round 5): git-tracked symlinks can be committed and still
    // point outside the repo (or to privileged files). A committed
    // `benchmarks/evil.yaml -> /etc/passwd` would pass the tracked gate
    // and then get shelled by the benchmark runner's entry_point
    // command — bypassing the whole point of the auto-exec protection.
    // lstat() each surviving candidate and refuse any that is a
    // symbolic link; operators can commit real YAML files or opt out.
    const symlinkBlocked = [];
    const trackedFilteredByLstat = benchFiles.filter((f) => {
      if (!trackedTopLevelBenchmarks.has(f)) return false;
      try {
        const st = fs.lstatSync(path.join(benchDir, f));
        if (st.isSymbolicLink()) {
          symlinkBlocked.push(f);
          return false;
        }
      } catch (_lstatErr) {
        // If we can't lstat, be conservative and refuse.
        symlinkBlocked.push(f);
        return false;
      }
      return true;
    });
    const untracked = benchFiles.filter((f) => !trackedTopLevelBenchmarks.has(f));
    benchFiles = trackedFilteredByLstat;
    if (symlinkBlocked.length > 0) {
      results.push(...symlinkBlocked.map((file) => ({
        file,
        passed: 0,
        failed: 0,
        skipped: true,
        reason: 'benchmark file is a symlink — refused auto-execution (symlinks can point outside the repo)',
      })));
    }
    if (untracked.length > 0) {
      // Surface untracked refusals so operators can pinpoint exactly which
      // benchmark files were ignored instead of quietly missing them.
      results.push(...untracked.map((file) => ({
        file,
        passed: 0,
        failed: 0,
        skipped: true,
        reason: 'benchmark file not tracked by git — refused auto-execution',
      })));
    }
  }

  for (const file of benchFiles) {
    try {
      const text = fs.readFileSync(path.join(benchDir, file), 'utf8');
      const benchmark = YAML.parse(text);
      // Audit P3: phaseBenchmark called runners.benchmark without awaiting,
      // so any async injection (tests, future real runner) would short-
      // circuit before case results returned. Awaiting a sync return is
      // a no-op, so this keeps both shapes honest.
      const caseResults = await runners.benchmark(benchmark, { cwd: options.repoRoot });

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

  // Audit P2: runImproveLoop requires `benchmarkPath` and returns a
  // non-throwing `{ error: 'benchmarkPath is required' }` when it's
  // missing. Phases were calling the runner without that field so the
  // improve phase always reported a clean zero-work run even when real
  // optimization was needed. Pass the first tracked benchmark file
  // we can find; skip (with reason) when nothing suitable exists instead
  // of calling the runner into its no-op branch.
  const benchmarkPath = resolveBenchmarkPath(options.repoRoot, benchmarkResult);
  if (!benchmarkPath) {
    return {
      skipped: true,
      reason: 'no benchmark YAML available to drive the improve loop',
      improvements: 0,
      accepted: 0,
    };
  }

  // Run with Opus (deep optimization) + Sonnet (fast challenger) — not MiniMax.
  //
  // Audit P2 (round 3): runImproveLoop reads `cwd` from its options, not
  // `repoRoot`. Passing only `repoRoot` meant relative benchmark paths
  // were resolved against process.cwd() (wherever the user invoked xo
  // from) instead of the pipeline's repoRoot — a subtle mis-resolution
  // that would silently drive improve off the wrong benchmark contents.
  // Pass both so new and old option readers agree.
  const result = await runners.improve({
    cwd: options.repoRoot,
    repoRoot: options.repoRoot,
    benchmarkPath,
    dryRun: options.dryRun,
    rounds: options.maxPolishRounds || DEFAULT_MAX_POLISH_ROUNDS,
    modelConfig: { agents: ['opus', 'sonnet'] },
    codexReasoning: options.codexReasoning,
  });

  // Audit P2 (round 2): runImproveLoop returns non-throwing {error: ...}
  // objects for common failures (missing benchmarkPath, schema drift,
  // runner invocation errors). The earlier wrapper did
  // `result.improvements || 0` which silently mapped every such failure
  // to a clean zero-work run. Surface the error as a `failed: true`
  // result so operators see what actually happened.
  if (result && typeof result.error === 'string' && result.error.length > 0) {
    return {
      skipped: false,
      failed: true,
      error: result.error,
      improvements: 0,
      accepted: 0,
      rounds: (result && result.rounds) || 0,
      regressions: (result && result.regressions) || 0,
      neutrals: (result && result.neutrals) || 0,
      saturated: !!(result && result.saturated),
    };
  }

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
    codexReasoning: options.codexReasoning,
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
  // Audit P2 (round 8): summary only tracked benchmarksPassed, so a run
  // where all benchmarks failed looked identical to a run that skipped
  // benchmarks entirely. Track failures alongside passes so the report
  // can surface "5 passed / 3 failed" instead of hiding the regression.
  const benchmarksFailed = benchmarkResult.failed || 0;
  const improvementsAccepted = improveResult.accepted || improveResult.improvements || 0;

  // Detect diminishing returns: polish saturated or improve saturated
  const diminishingReturns = !!(polishResult.saturated || finalPolishResult.saturated || improveResult.saturated);

  // Audit P3 (round 4): phaseImprove (and any other phase) can return
  // `{ failed: true, error }` when the underlying runner signals a
  // contract violation. The previous summary reduced those to
  // improvementsAccepted: 0 and nothing else, so a broken run looked
  // indistinguishable from a no-op clean run. Collect every phase's
  // failure into a dedicated `phaseFailures` array so formatXoReport
  // can surface the errors front-and-center, and expose a top-level
  // `hasPhaseFailures` flag for automation to key off without having
  // to walk each sub-result.
  const phaseFailures = [];
  for (const [phaseName, phaseResult] of Object.entries(pr)) {
    if (!phaseResult || typeof phaseResult !== 'object') continue;
    if (phaseResult.failed === true || (phaseResult.error && phaseResult.skipped !== true)) {
      phaseFailures.push({
        phase: phaseName,
        error: phaseResult.error || 'phase reported failed without an error message',
      });
    }
    // Audit P2 (round 5): buildXoSummary only checked top-level
    // `failed`/`error`, so per-directive build failures stored in
    // `build.results[]` (with ok:false + error) were invisible in the
    // summary. Surface them as phase failures so operators see which
    // directives failed even when the overall phase didn't abort.
    if (phaseName === 'build' && Array.isArray(phaseResult.results)) {
      for (const directiveResult of phaseResult.results) {
        if (directiveResult && directiveResult.ok === false) {
          phaseFailures.push({
            phase: 'build',
            directive: directiveResult.path || '<unknown>',
            error: directiveResult.error || 'directive failed without an error message',
          });
        }
        if (directiveResult && directiveResult.completionError) {
          phaseFailures.push({
            phase: 'build',
            directive: directiveResult.path || '<unknown>',
            error: `directive could not be moved out of approved/: ${directiveResult.completionError}`,
          });
        }
      }
    }
  }
  const hasPhaseFailures = phaseFailures.length > 0;

  // Audit P1 (round 6): FUZZ / BENCHMARK measure the repo's state at the
  // moment they ran, but IMPROVE and FINAL POLISH execute AFTER those
  // phases and can mutate code. The summary's crash/benchmark counts
  // reflect the pre-mutation state; a pipeline report that says
  // "0 crashes, benchmarks passed" can be stale if the last two phases
  // actually landed changes. Expose a `needsRevalidation` flag so
  // automation (and formatXoReport) can tell operators that the verify
  // phases should be re-run to certify post-mutation state.
  const improveChangedCode = !!(improveResult
    && !improveResult.skipped
    && !improveResult.failed
    && !improveResult.dryRun
    && (
      (typeof improveResult.improvements === 'number' && improveResult.improvements > 0)
      || (typeof improveResult.accepted === 'number' && improveResult.accepted > 0)
    ));
  const finalPolishChangedCode = !!(finalPolishResult
    && !finalPolishResult.skipped
    && !finalPolishResult.failed
    && !finalPolishResult.dryRun
    && (
      (typeof finalPolishResult.landed === 'number' && finalPolishResult.landed > 0)
      || (typeof finalPolishResult.testsAdded === 'number' && finalPolishResult.testsAdded > 0)
    ));
  const needsRevalidation = improveChangedCode || finalPolishChangedCode;

  return {
    totalTests,
    totalCrashes,
    benchmarksPassed,
    benchmarksFailed,
    improvementsAccepted,
    polishRounds,
    diminishingReturns,
    phaseFailures,
    hasPhaseFailures,
    needsRevalidation,
    revalidationReasons: {
      improveChangedCode,
      finalPolishChangedCode,
    },
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
function formatXoReport(summary, extras = {}) {
  const s = (summary && typeof summary === 'object') ? summary : {};
  // Audit P3 (round 8): phaseWarnings (unknown --phases typos etc.)
  // were available on the runXoPipeline result but never rendered in
  // the operator-facing report. Accept them via a second arg so
  // callers can forward the top-level phaseWarnings into the report
  // and see typos at a glance.
  const phaseWarnings = Array.isArray(extras && extras.phaseWarnings)
    ? extras.phaseWarnings
    : [];

  const benchPassed = s.benchmarksPassed ?? 0;
  const benchFailed = s.benchmarksFailed ?? 0;
  const benchLabel = benchFailed > 0
    ? `${benchPassed} passed / ${benchFailed} failed`
    : `${benchPassed}`;
  const lines = [
    '=== XO Pipeline Report ===',
    '',
    `  Polish rounds:          ${s.polishRounds ?? 0}`,
    `  Tests added:            ${s.totalTests ?? 0}`,
    `  Fuzz crashes found:     ${s.totalCrashes ?? 0}`,
    `  Benchmarks:             ${benchLabel}`,
    `  Improvements accepted:  ${s.improvementsAccepted ?? 0}`,
    `  Diminishing returns:    ${s.diminishingReturns ? 'yes' : 'no'}`,
  ];
  if (Array.isArray(s.phaseFailures) && s.phaseFailures.length > 0) {
    lines.push('');
    lines.push(`  Phase failures:         ${s.phaseFailures.length}`);
    for (const failure of s.phaseFailures) {
      const prefix = failure.directive ? `${failure.phase} (${failure.directive})` : failure.phase;
      lines.push(`    - ${prefix}: ${failure.error}`);
    }
  }
  if (s.needsRevalidation) {
    const reasons = [];
    if (s.revalidationReasons && s.revalidationReasons.improveChangedCode) reasons.push('improve landed changes');
    if (s.revalidationReasons && s.revalidationReasons.finalPolishChangedCode) reasons.push('finalPolish landed changes');
    lines.push('');
    lines.push(`  ⚠ Needs revalidation:   yes (${reasons.join(', ')})`);
    lines.push('    fuzz/benchmark/polish counts above reflect pre-mutation state');
  }
  if (phaseWarnings.length > 0) {
    lines.push('');
    lines.push(`  ⚠ Phase warnings:       ${phaseWarnings.length}`);
    for (const warning of phaseWarnings) {
      const detail = warning.hint || warning.requested || 'unknown';
      lines.push(`    - ${detail}`);
    }
  }
  lines.push('');
  lines.push('==========================');

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
    // Audit P2 (round 3): the allowBenchmarkExec opt-in gate we added to
    // phaseBenchmark needs a callable path from the public entry point.
    // Thread it through opts so operators can reach the gate via
    // runXoPipeline({ allowBenchmarkExec: true }) without constructing
    // phase-level options manually.
    allowBenchmarkExec: options.allowBenchmarkExec === true,
    // Audit P1 (round 6): same threading for the new directive opt-in.
    allowDirectiveExec: options.allowDirectiveExec === true,
  };

  const phases = {};

  // Audit P2 (round 5): previously each `await phaseX(...)` could throw
  // a runner exception (network, disk, programming bug) and that
  // exception would unwind the WHOLE pipeline — no summary, no history,
  // no partial results. Wrap every phase in its own try/catch so a
  // failed runner becomes a `{ failed: true, error }` phase result that
  // buildXoSummary surfaces via phaseFailures while the remaining
  // phases continue. This preserves the "one broken phase doesn't
  // invalidate the others" invariant the pipeline promises.
  async function runPhaseSafely(phaseName, phaseFn, fallbackShape) {
    try {
      return await phaseFn();
    } catch (err) {
      return {
        skipped: false,
        failed: true,
        error: err && err.message ? err.message : String(err),
        errorCode: err && err.code ? err.code : null,
        ...fallbackShape,
      };
    }
  }

  // Phase 1: BUILD
  if (activePhases.includes('build')) {
    phases.build = await runPhaseSafely('build', () => phaseBuild(opts, runners), {});
  } else {
    phases.build = { skipped: true, reason: 'phase not selected' };
  }

  // Phase 2: POLISH
  if (activePhases.includes('polish')) {
    phases.polish = await runPhaseSafely('polish', () => phasePolish(opts, runners), {});
  } else {
    phases.polish = { skipped: true, reason: 'phase not selected' };
  }

  // Phase 3: FUZZ
  if (activePhases.includes('fuzz')) {
    phases.fuzz = await runPhaseSafely('fuzz', () => phaseFuzz(opts, runners), { crashes: [] });
  } else {
    phases.fuzz = { skipped: true, reason: 'phase not selected', crashes: [] };
  }

  // Phase 4: BENCHMARK
  if (activePhases.includes('benchmark')) {
    phases.benchmark = await runPhaseSafely(
      'benchmark',
      () => phaseBenchmark(opts, runners),
      { passed: 0, failed: 0, results: [] },
    );
  } else {
    phases.benchmark = { skipped: true, reason: 'phase not selected', passed: 0, failed: 0, results: [] };
  }

  // Phase 5: IMPROVE
  if (activePhases.includes('improve')) {
    phases.improve = await runPhaseSafely(
      'improve',
      () => phaseImprove(opts, runners, phases.benchmark),
      { improvements: 0, accepted: 0 },
    );
  } else {
    phases.improve = { skipped: true, reason: 'phase not selected' };
  }

  // Phase 6: FINAL POLISH
  if (activePhases.includes('finalPolish')) {
    phases.finalPolish = await runPhaseSafely('finalPolish', () => phaseFinalPolish(opts, runners), {});
  } else {
    phases.finalPolish = { skipped: true, reason: 'phase not selected' };
  }

  const summary = buildXoSummary(phases);

  // Audit P3 (round 7): surface phase-name warnings (unknown --phases
  // entries that parseXoCommand flagged) at the top level of the result
  // so callers can detect typos without walking into parseXoCommand's
  // output. Empty when all requested phases were known.
  const phaseWarnings = Array.isArray(options.phaseWarnings)
    ? options.phaseWarnings.slice()
    : [];

  return { phases, summary, phaseWarnings };
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
