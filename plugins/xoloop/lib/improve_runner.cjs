'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AdapterError } = require('./errors.cjs');
const { loadBenchmark } = require('./benchmark_loader.cjs');
const { runBenchmarkSuite } = require('./benchmark_runner.cjs');
const { detectHotspots } = require('./hotspot_detector.cjs');
const { applyOperationSet, rollbackOperationSet, normalizeOperationSet } = require('./operation_ir.cjs');
const { validateImprovement } = require('./improvement_validator.cjs');
const { extractJsonObjectFromText } = require('./baton_common.cjs');

const LANGUAGE_BY_EXTENSION = new Map([
  ['.cjs', 'javascript'],
  ['.mjs', 'javascript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.py', 'python'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.rb', 'ruby'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.cs', 'csharp'],
  ['.swift', 'swift'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hh', 'cpp'],
]);

// ---------------------------------------------------------------------------
// parseImproveOptions
// ---------------------------------------------------------------------------

/**
 * Parse CLI-style argv into a structured options object for IMPROVE mode.
 *
 * @param {string[]} argv
 * @returns {{
 *   benchmarkPath: string|undefined,
 *   rounds: number,
 *   significanceThreshold: number,
 *   dryRun: boolean,
 *   cwd: string|undefined,
 *   targetPaths: string[],
 *   model: string|undefined,
 * }}
 */
function parseImproveOptions(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const opts = {
    benchmarkPath: undefined,
    rounds: Infinity,
    significanceThreshold: 0.05,
    dryRun: false,
    cwd: undefined,
    targetPaths: [],
    model: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--benchmark' && i + 1 < args.length) {
      opts.benchmarkPath = args[++i];
    } else if (arg === '--rounds' && i + 1 < args.length) {
      const parsedRounds = parseInt(args[++i], 10);
      opts.rounds = Number.isFinite(parsedRounds) && parsedRounds > 0 ? parsedRounds : Infinity;
    } else if (arg === '--significance-threshold' && i + 1 < args.length) {
      const parsedThreshold = parseFloat(args[++i]);
      opts.significanceThreshold = Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : 0.05;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--cwd' && i + 1 < args.length) {
      opts.cwd = args[++i];
    } else if (arg === '--target' && i + 1 < args.length) {
      opts.targetPaths.push(args[++i]);
    } else if (arg === '--model' && i + 1 < args.length) {
      opts.model = args[++i];
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// buildImproveSummary
// ---------------------------------------------------------------------------

/**
 * Build an aggregate summary from an array of per-round result objects.
 *
 * @param {Array<{ improvements: number, regressions: number, neutrals: number, saturated: boolean }>} roundResults
 * @returns {{ rounds: number, improvements: number, regressions: number, neutrals: number, saturated: boolean }}
 */
function buildImproveSummary(roundResults) {
  const results = Array.isArray(roundResults) ? roundResults : [];

  const rounds = results.length;
  let improvements = 0;
  let regressions = 0;
  let neutrals = 0;
  let saturated = false;

  for (const r of results) {
    if (r == null) continue;
    improvements += Number(r.improvements) || 0;
    regressions += Number(r.regressions) || 0;
    neutrals += Number(r.neutrals) || 0;
  }

  const lastRound = results.length > 0 ? results[results.length - 1] : null;
  if (lastRound != null && lastRound.saturated) {
    saturated = true;
  }

  return { rounds, improvements, regressions, neutrals, saturated };
}

// ---------------------------------------------------------------------------
// buildOptimizationPrompt
// ---------------------------------------------------------------------------

/**
 * Build the system + user prompt for the optimization model call.
 *
 * @param {{ hotspots: object[], sourceFiles: Array<{path: string, content: string}>, benchmark: object, round: number, priorAttempts: string[] }} ctx
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildOptimizationPrompt(ctx) {
  const { hotspots, sourceFiles, benchmark, round, priorAttempts } = ctx || {};

  const systemPrompt = [
    'You are a performance optimization engineer. Your job is to make code faster, leaner, or more efficient while preserving EXACTLY the same input→output behavior.',
    '',
    'Rules:',
    '1. Return JSON only — an object with "explanation" (string) and "operations" (array).',
    '2. Each operation is: { "op": "replace_exact", "path": "<file>", "search": "<exact text>", "replace": "<new text>" }',
    '3. The search text must appear EXACTLY ONCE in the target file.',
    '4. The benchmark contract is SACRED — same inputs must produce same outputs.',
    '5. Optimize for: wall time, CPU time, memory, or code simplicity.',
    '6. Make ONE bounded optimization per round. Do not rewrite entire files.',
    '7. If no optimization is possible, return { "explanation": "no optimization found", "operations": [] }.',
  ].join('\n');

  const sourceSection = (sourceFiles || []).map(f =>
    `## File: ${f.path}\n\`\`\`${detectSourceLanguage(f.path)}\n${f.content}\n\`\`\``
  ).join('\n\n');

  const hotspotSection = (hotspots || []).length > 0
    ? `## Detected Hotspots\n${JSON.stringify(hotspots, null, 2)}`
    : '## No hotspots detected — look for general optimization opportunities.';

  const benchmarkSection = benchmark
    ? `## Benchmark Contract (DO NOT violate)\n${JSON.stringify({ benchmark: benchmark.benchmark, cases: (benchmark.cases || []).map(c => ({ id: c.id, bounds: c.bounds })) }, null, 2)}`
    : '';

  const priorSection = (priorAttempts || []).length > 0
    ? `## Prior Attempts (avoid repeating)\n${priorAttempts.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    : '';

  const userPrompt = [
    `Round ${round || 1} optimization request.`,
    '',
    sourceSection,
    '',
    hotspotSection,
    '',
    benchmarkSection,
    '',
    priorSection,
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// parseModelResponse
// ---------------------------------------------------------------------------

/**
 * Parse the model's response text into validated operation_ir operations.
 *
 * @param {string} responseText
 * @returns {{ explanation: string, operations: Array<{ op: string, path: string, search: string, replace: string }> }}
 */
function parseModelResponse(responseText) {
  if (typeof responseText !== 'string' || !responseText.trim()) {
    throw new AdapterError('IMPROVE_RESPONSE_PARSE_FAILED', 'responseText', 'Empty or non-string response from model', {
      fixHint: 'The model must return JSON with "explanation" and "operations" fields.',
    });
  }

  let jsonText;
  try {
    jsonText = extractJsonObjectFromText(responseText, 'Optimization response');
  } catch (_e) {
    throw new AdapterError('IMPROVE_RESPONSE_PARSE_FAILED', 'responseText', 'No JSON object found in model response', {
      fixHint: 'The model must return a JSON object with "explanation" and "operations" array.',
    });
  }

  const parsed = JSON.parse(jsonText);
  const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : 'no explanation provided';
  const operations = Array.isArray(parsed.operations) ? parsed.operations : [];

  return { explanation, operations };
}

// ---------------------------------------------------------------------------
// extractTargetPaths
// ---------------------------------------------------------------------------

/**
 * Extract source file paths from benchmark entry_point commands.
 *
 * @param {object} benchmark — parsed benchmark object
 * @param {string} cwd — working directory
 * @returns {string[]} — deduplicated array of source file paths
 */
function extractTargetPaths(benchmark, cwd) {
  const paths = new Set();
  const requirePattern = /require\(['"]([^'"]+)['"]\)/g;
  const fileTokenPattern = /(?:^|\s)([^\s'"()]+?\.(?:cjs|mjs|js|jsx|ts|tsx|py|rs|go|rb|java|kt|kts|cs|swift|c|h|cc|cpp|cxx|hpp|hh))(?:\s|$)/g;
  const pythonModulePattern = /(?:^|\s)(?:python3?|uv\s+run\s+python|python\s+-m)\s+(?:-m\s+)?([A-Za-z_][\w.]*)(?:\s|$)/g;
  const rubyRequirePattern = /(?:require|require_relative)\s+['"]([^'"]+)['"]/g;
  const dotnetProjectPattern = /(?:^|\s)([^\s'"()]+?\.(?:csproj|sln))(?:\s|$)/g;
  const javaMainClassPattern = /(?:^|\s)-Dexec\.mainClass=([A-Za-z_][\w.]*)/g;

  for (const c of (benchmark.cases || [])) {
    const command = c.entry_point && c.entry_point.command;
    if (typeof command !== 'string') continue;
    requirePattern.lastIndex = 0;
    let match;
    while ((match = requirePattern.exec(command)) !== null) {
      const reqPath = match[1];
      if (reqPath.startsWith('./') || reqPath.startsWith('../')) {
        const resolved = path.resolve(cwd, reqPath);
        if (fs.existsSync(resolved)) paths.add(resolved);
      }
    }

    fileTokenPattern.lastIndex = 0;
    while ((match = fileTokenPattern.exec(command)) !== null) {
      addExistingPathCandidate(paths, cwd, match[1]);
    }

    pythonModulePattern.lastIndex = 0;
    while ((match = pythonModulePattern.exec(command)) !== null) {
      addPythonModuleCandidate(paths, cwd, match[1]);
    }

    rubyRequirePattern.lastIndex = 0;
    while ((match = rubyRequirePattern.exec(command)) !== null) {
      addRubyRequireCandidate(paths, cwd, match[1]);
    }

    dotnetProjectPattern.lastIndex = 0;
    while ((match = dotnetProjectPattern.exec(command)) !== null) {
      addDotnetProjectSources(paths, cwd, match[1]);
    }

    javaMainClassPattern.lastIndex = 0;
    while ((match = javaMainClassPattern.exec(command)) !== null) {
      addJavaClassCandidate(paths, cwd, match[1]);
    }
  }

  return [...paths];
}

function addJavaClassCandidate(paths, cwd, className) {
  const rel = className.replace(/\./g, path.sep) + '.java';
  for (const sourceRoot of ['src/main/java', 'src/test/java']) {
    const candidate = path.join(cwd, sourceRoot, rel);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      paths.add(candidate);
    }
  }
}

function addDotnetProjectSources(paths, cwd, projectPath) {
  const resolved = path.resolve(cwd, projectPath);
  const root = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? resolved
    : path.dirname(resolved);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    if (entry.endsWith('.cs')) addExistingPathCandidate(paths, root, entry);
  }
}

function detectSourceLanguage(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(ext) || '';
}

function addExistingPathCandidate(paths, cwd, candidate) {
  if (!candidate || typeof candidate !== 'string') return;
  const cleaned = candidate.replace(/^['"]|['"]$/g, '');
  const resolved = path.resolve(cwd, cleaned);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    paths.add(resolved);
  }
}

function addPythonModuleCandidate(paths, cwd, moduleName) {
  if (!moduleName || typeof moduleName !== 'string') return;
  const modulePath = moduleName.replace(/\./g, path.sep);
  for (const candidate of [`${modulePath}.py`, path.join(modulePath, '__init__.py')]) {
    addExistingPathCandidate(paths, cwd, candidate);
  }
}

function addRubyRequireCandidate(paths, cwd, requirePath) {
  if (!requirePath || typeof requirePath !== 'string') return;
  const candidates = [];
  if (requirePath.startsWith('./') || requirePath.startsWith('../')) {
    candidates.push(requirePath.endsWith('.rb') ? requirePath : `${requirePath}.rb`);
  } else {
    candidates.push(path.join('lib', requirePath.endsWith('.rb') ? requirePath : `${requirePath}.rb`));
  }
  for (const candidate of candidates) addExistingPathCandidate(paths, cwd, candidate);
}

// ---------------------------------------------------------------------------
// runImproveLoop
// ---------------------------------------------------------------------------

/**
 * Run the improve loop: load benchmark, run champion baseline, then iterate
 * with model-proposed optimizations evaluated as challengers.
 *
 * @param {{
 *   benchmarkPath: string,
 *   rounds?: number,
 *   dryRun?: boolean,
 *   significanceThreshold?: number,
 *   cwd?: string,
 *   targetPaths?: string[],
 *   modelCaller?: function,
 *   modelConfig?: object,
 *   saturationWindow?: number,
 * }} options
 * @returns {Promise<{ rounds: number, improvements: number, regressions: number, neutrals: number, saturated: boolean, error?: string }>}
 */
async function runImproveLoop(options) {
  if (options != null && (typeof options !== 'object' || Array.isArray(options))) {
    return {
      rounds: 0, improvements: 0, regressions: 0, neutrals: 0, saturated: false,
      error: 'INVALID_OPTIONS: expected object, got ' + (Array.isArray(options) ? 'array' : typeof options),
    };
  }

  const {
    benchmarkPath,
    rounds: maxRounds = Infinity,
    dryRun = false,
    cwd: optCwd,
    targetPaths: explicitTargets,
    modelCaller,
    modelConfig,
    saturationWindow = 3,
  } = options || {};

  const cwd = optCwd || process.cwd();
  const callModelFn = typeof modelCaller === 'function' ? modelCaller : null;

  // ── Step 1: Load benchmark ──────────────────────────────────────────
  if (!benchmarkPath || typeof benchmarkPath !== 'string' || benchmarkPath.trim().length === 0) {
    return { rounds: 0, improvements: 0, regressions: 0, neutrals: 0, saturated: false, error: 'benchmarkPath is required' };
  }

  let benchmark;
  try {
    benchmark = loadBenchmark(path.resolve(cwd, benchmarkPath));
  } catch (err) {
    return { rounds: 0, improvements: 0, regressions: 0, neutrals: 0, saturated: false, error: `Failed to load benchmark: ${err.message}` };
  }

  // ── Step 2: Determine target files ──────────────────────────────────
  const targetPaths = Array.isArray(explicitTargets) && explicitTargets.length > 0
    ? explicitTargets.map(p => path.resolve(cwd, p))
    : extractTargetPaths(benchmark, cwd);

  if (targetPaths.length === 0) {
    return { rounds: 0, improvements: 0, regressions: 0, neutrals: 0, saturated: false, error: 'No target files found in benchmark entry_points or --target flags' };
  }

  // ── Step 3: Run champion baseline ───────────────────────────────────
  let championResults;
  try {
    championResults = runBenchmarkSuite(benchmark, { cwd });
  } catch (err) {
    return { rounds: 0, improvements: 0, regressions: 0, neutrals: 0, saturated: false, error: `Champion baseline failed: ${err.message}` };
  }

  const championArray = Array.isArray(championResults) ? championResults : Object.values(championResults);
  const championViolations = championArray.filter(r => r && r.verdict === 'BENCHMARK_VIOLATION');
  if (championViolations.length > 0) {
    return { rounds: 0, improvements: 0, regressions: 0, neutrals: 0, saturated: false, error: `Champion baseline has ${championViolations.length} violations — fix before optimizing` };
  }

  // ── Dry run: return after baseline ──────────────────────────────────
  if (dryRun) {
    return { rounds: 1, improvements: 0, regressions: 0, neutrals: 0, saturated: false };
  }

  // ── Step 4: Lazy-load model caller ──────────────────────────────────
  let resolvedModelCaller = callModelFn;
  if (!resolvedModelCaller) {
    try {
      const { callModel } = require('./model_router.cjs');
      resolvedModelCaller = callModel;
    } catch (_e) {
      return { rounds: 0, improvements: 0, regressions: 0, neutrals: 0, saturated: false, error: 'model_router not available' };
    }
  }

  // ── Step 5: Optimization loop ───────────────────────────────────────
  const roundResults = [];
  const priorAttempts = [];
  let consecutiveNonImprovements = 0;
  const roundLimit = Number.isFinite(maxRounds) ? maxRounds : Infinity;

  for (let round = 0; round < roundLimit; round++) {
    let roundResult = { improvements: 0, regressions: 0, neutrals: 0, saturated: false };

    try {
      // 5a. Read source files
      const sourceFiles = [];
      for (const tp of targetPaths) {
        if (fs.existsSync(tp)) {
          sourceFiles.push({ path: path.relative(cwd, tp), content: fs.readFileSync(tp, 'utf8') });
        }
      }

      // 5b. Detect hotspots
      const allHotspots = [];
      for (const sf of sourceFiles) {
        const spots = detectHotspots(sf.content, { language: detectSourceLanguage(sf.path) });
        for (const spot of spots) {
          allHotspots.push({ ...spot, file: sf.path });
        }
      }

      // 5c. Build prompt
      const prompt = buildOptimizationPrompt({
        hotspots: allHotspots,
        sourceFiles,
        benchmark,
        round: round + 1,
        priorAttempts,
      });

      // 5d. Call model
      const modelResponse = await resolvedModelCaller({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        ...(modelConfig || {}),
      });

      const responseText = typeof modelResponse === 'string'
        ? modelResponse
        : (modelResponse && typeof modelResponse.text === 'string' ? modelResponse.text : JSON.stringify(modelResponse));

      // 5e. Parse response
      const { explanation, operations } = parseModelResponse(responseText);

      if (operations.length === 0) {
        priorAttempts.push(`Round ${round + 1}: no optimization proposed`);
        roundResult.neutrals = 1;
        consecutiveNonImprovements++;
      } else {
        // 5f. Normalize and apply operations
        const normalizedOps = normalizeOperationSet(operations);
        const rollbackHandle = applyOperationSet(normalizedOps, { cwd });

        // 5g. Run challenger benchmark
        let challengerResults;
        try {
          challengerResults = runBenchmarkSuite(benchmark, { cwd });
        } catch (benchErr) {
          rollbackOperationSet(rollbackHandle);
          priorAttempts.push(`Round ${round + 1}: benchmark execution failed after patch — ${benchErr.message}`);
          roundResult.neutrals = 1;
          consecutiveNonImprovements++;
          roundResults.push(roundResult);
          continue;
        }

        const challengerArray = Array.isArray(challengerResults) ? challengerResults : Object.values(challengerResults);
        const challengerViolations = challengerArray.filter(r => r && r.verdict === 'BENCHMARK_VIOLATION');

        if (challengerViolations.length > 0) {
          // Benchmark violated — rollback
          rollbackOperationSet(rollbackHandle);
          priorAttempts.push(`Round ${round + 1}: ${explanation} — REJECTED (${challengerViolations.length} benchmark violations)`);
          roundResult.regressions = 1;
          consecutiveNonImprovements++;
        } else {
          // 5h. Compare champion vs challenger
          const championMetrics = championArray.map(r => r && r.metrics).filter(Boolean);
          const challengerMetrics = challengerArray.map(r => r && r.metrics).filter(Boolean);

          const validation = validateImprovement(championMetrics, challengerMetrics, ['wallTimeMs', 'cpuTimeMs', 'peakMemoryMb']);

          if (validation.verdict === 'IMPROVEMENT') {
            // Keep changes — update champion baseline
            priorAttempts.push(`Round ${round + 1}: ${explanation} — ACCEPTED (${validation.reason})`);
            roundResult.improvements = 1;
            consecutiveNonImprovements = 0;
            // Update champion for next round comparison
            try {
              const updatedResults = runBenchmarkSuite(benchmark, { cwd });
              const updatedArray = Array.isArray(updatedResults) ? updatedResults : Object.values(updatedResults);
              championArray.length = 0;
              championArray.push(...updatedArray);
            } catch (_e) {
              // If re-baseline fails, keep old champion — still valid
            }
          } else {
            // Neutral or regression — rollback
            rollbackOperationSet(rollbackHandle);
            const label = validation.verdict === 'REGRESSION' ? 'REGRESSION' : 'NEUTRAL';
            priorAttempts.push(`Round ${round + 1}: ${explanation} — ${label} (${validation.reason})`);
            if (validation.verdict === 'REGRESSION') {
              roundResult.regressions = 1;
            } else {
              roundResult.neutrals = 1;
            }
            consecutiveNonImprovements++;
          }
        }
      }
    } catch (err) {
      // Any unhandled error in the round — record as neutral, continue
      priorAttempts.push(`Round ${round + 1}: error — ${err.message}`);
      roundResult.neutrals = 1;
      consecutiveNonImprovements++;
    }

    // Saturation check
    if (consecutiveNonImprovements >= saturationWindow) {
      roundResult.saturated = true;
    }

    roundResults.push(roundResult);

    if (roundResult.saturated) break;
  }

  return buildImproveSummary(roundResults);
}

module.exports = {
  parseImproveOptions,
  buildImproveSummary,
  buildOptimizationPrompt,
  parseModelResponse,
  detectSourceLanguage,
  extractTargetPaths,
  runImproveLoop,
};
