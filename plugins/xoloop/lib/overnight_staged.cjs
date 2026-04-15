const fs = require('node:fs');

const {
  createFingerprint,
  extractJsonObjectFromText,
  normalizeText,
  resolveRepoPath,
} = require('./baton_common.cjs');
const { validatePatchSetAgainstContent } = require('./overnight_patch_engine.cjs');
const { AdapterError } = require('./errors.cjs');

const DEFAULT_WINDOW_LINE_CAP = 120;

// Canonical non-code suffix list. Non-code files (docs, config, YAML) are
// allowed to land without a matching test_change, because there is no test to
// write for a README section or YAML key. Both the staged and legacy pipelines
// share this definition so the suffix list cannot drift between them.
const NON_CODE_SUFFIXES = ['.md', '.txt', '.rst', '.adoc', '.yaml', '.yml', '.toml', '.ini', '.json', '.markdown', '.mdx'];
function isNonCodePath(filePath) {
  const normalized = normalizeText(filePath).toLowerCase();
  return NON_CODE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => normalizeText(entry)).filter(Boolean)
    : [];
}

function normalizeProposalMode(value) {
  const mode = normalizeText(value).toLowerCase() || 'legacy';
  if (!['legacy', 'staged', 'planner-only', 'planner_only'].includes(mode)) {
    throw new AdapterError('PROPOSAL_MODE_INVALID', 'proposal_mode', 'proposal_mode must be legacy, staged, or planner-only', { fixHint: `Set proposal_mode to one of: legacy, staged, planner-only. Got: ${normalizeText(value) || '(empty)'}` });
  }
  // Accept both hyphen and underscore spellings; normalize to hyphen for internal use.
  return mode === 'planner_only' ? 'planner-only' : mode;
}

function normalizeAnchorType(value, fallback, allowed, fieldName) {
  const anchorType = normalizeText(value) || fallback;
  if (!allowed.includes(anchorType)) {
    throw new AdapterError('ANCHOR_TYPE_INVALID', fieldName, `${fieldName} must be one of ${allowed.join(', ')}`, { fixHint: `Set ${fieldName} to one of: ${allowed.join(', ')}. Got: ${normalizeText(value) || '(empty)'}` });
  }
  return anchorType;
}

function normalizePlannerTarget(value, fieldName, options = {}) {
  const required = options.required !== false;
  if (!required && (value === null || value === undefined)) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterError('PLANNER_TARGET_INVALID', fieldName, `${fieldName} must be an object`, { fixHint: `Pass a plain object with path, symbol, anchor_type, and anchor_text to ${fieldName}.` });
  }
  const target = {
    path: normalizeText(value.path),
    symbol: normalizeText(value.symbol),
    anchorType: normalizeAnchorType(
      value.anchor_type || value.anchorType,
      options.kind === 'test' ? 'test_name' : 'symbol',
      options.kind === 'test' ? ['test_name', 'line_contains'] : ['symbol', 'line_contains'],
      `${fieldName}.anchor_type`,
    ),
    anchorText: normalizeText(value.anchor_text || value.anchorText),
  };
  if (!target.path) {
    throw new AdapterError('PLANNER_TARGET_PATH_REQUIRED', fieldName, `${fieldName}.path is required`, { fixHint: `Add a non-empty path field to ${fieldName}.` });
  }
  if (options.kind !== 'test' && target.anchorType === 'symbol' && !target.symbol) {
    throw new AdapterError('PLANNER_TARGET_SYMBOL_REQUIRED', fieldName, `${fieldName}.symbol is required for source targets`, { fixHint: `Add a non-empty symbol field to ${fieldName} when anchor_type is symbol.` });
  }
  if (!target.anchorText) {
    target.anchorText = target.symbol || '';
  }
  if (!target.anchorText) {
    throw new AdapterError('PLANNER_TARGET_ANCHOR_TEXT_REQUIRED', fieldName, `${fieldName}.anchor_text is required`, { fixHint: `Add a non-empty anchor_text field to ${fieldName}.` });
  }
  return target;
}

function parsePlannerResponse(text) {
  const payload = JSON.parse(extractJsonObjectFromText(text, 'Planner response'));
  const decision = normalizeText(payload.decision).toLowerCase();
  if (!['propose', 'no_safe_change'].includes(decision)) {
    throw new AdapterError('PLANNER_DECISION_INVALID', 'decision', 'decision must be propose or no_safe_change', { fixHint: 'Set decision to one of: propose, no_safe_change.' });
  }
  const plan = {
    decision,
    changeSummary: normalizeText(payload.change_summary || payload.changeSummary),
    sourceTarget: null,
    testTarget: null,
    whyBounded: normalizeText(payload.why_bounded || payload.whyBounded),
    invariantsPreserved: normalizeStringList(payload.invariants_preserved || payload.invariantsPreserved),
    expectedTestKind: normalizeText(payload.expected_test_kind || payload.expectedTestKind),
  };
  if (decision === 'no_safe_change') {
    if (!plan.changeSummary) {
      plan.changeSummary = 'No safe bounded change was identified.';
    }
    return plan;
  }
  if (!plan.changeSummary) {
    throw new AdapterError('PLANNER_CHANGE_SUMMARY_REQUIRED', 'change_summary', 'change_summary is required', { fixHint: 'Add a non-empty change_summary to the planner response.' });
  }
  if (!plan.whyBounded) {
    throw new AdapterError('PLANNER_WHY_BOUNDED_REQUIRED', 'why_bounded', 'why_bounded is required', { fixHint: 'Add a non-empty why_bounded to the planner response.' });
  }
  if (!plan.expectedTestKind) {
    throw new AdapterError('PLANNER_EXPECTED_TEST_KIND_REQUIRED', 'expected_test_kind', 'expected_test_kind is required', { fixHint: 'Add a non-empty expected_test_kind to the planner response.' });
  }
  plan.sourceTarget = normalizePlannerTarget(payload.source_target || payload.sourceTarget, 'source_target', { kind: 'source' });
  plan.testTarget = normalizePlannerTarget(payload.test_target || payload.testTarget, 'test_target', { kind: 'test' });
  return plan;
}

function buildCandidateFingerprint(objectiveHash, surfaceId, plan) {
  // Guard against circular plans — only forward serialisable primitives
  const safePlan = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {};
  const seen = new WeakSet();
  const safeTarget = (t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    if (seen.has(t)) return { path: '[Circular]' };
    seen.add(t);
    return { path: normalizeText(t.path), symbol: normalizeText(t.symbol), anchorText: normalizeText(t.anchorText) };
  };
  return createFingerprint({
    objectiveHash,
    surfaceId,
    sourceTarget: safeTarget(safePlan.sourceTarget),
    testTarget: safeTarget(safePlan.testTarget),
  });
}

function buildSourceTargetKey(target) {
  if (!target) {
    return '';
  }
  return `${normalizeText(target.path)}::${normalizeText(target.symbol || target.anchorText)}`;
}

function buildWindowFingerprint(sourceWindow, testWindow) {
  // Guard against circular references by stripping them before hashing.
  // Non-object values (strings, numbers, null) are passed through as-is so
  // that callers passing raw string excerpts still get distinct fingerprints.
  const circularSeen = new WeakSet();
  const safeValue = (v) => {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (Array.isArray(v)) return '[Array]';
    if (circularSeen.has(v)) return { path: '[Circular]' };
    circularSeen.add(v);
    return {
      path: normalizeText(v.path),
      startLine: typeof v.startLine === 'number' ? v.startLine : null,
      endLine: typeof v.endLine === 'number' ? v.endLine : null,
      excerpt: typeof v.excerpt === 'string' ? v.excerpt : '',
    };
  };
  return createFingerprint({
    sourceWindow: safeValue(sourceWindow),
    testWindow: safeValue(testWindow),
  });
}

function truncateList(list, limit) {
  return Array.isArray(list) ? list.slice(0, limit) : [];
}

function extractSourceSymbols(content) {
  const lines = String(content || '').split('\n');
  const symbols = [];
  const patterns = [
    { kind: 'function', regex: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/ },
    { kind: 'constant', regex: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/ },
    { kind: 'class', regex: /^\s*class\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: 'export', regex: /^\s*(?:module\.exports\.|exports\.)([A-Za-z_$][\w$]*)\s*=/ },
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (!match) {
        continue;
      }
      symbols.push({
        kind: pattern.kind,
        symbol: match[1],
        anchorText: line.trim(),
      });
      break;
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const entry of symbols) {
    const key = `${entry.kind}:${entry.symbol}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function extractTestAnchors(content) {
  const lines = String(content || '').split('\n');
  const anchors = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:test|it|describe)\s*\(\s*(['"`])(.+?)\1/);
    if (!match) {
      continue;
    }
    anchors.push({
      anchorType: 'test_name',
      anchorText: match[2],
      rawLine: line.trim(),
    });
  }
  return anchors;
}

/**
 * Extract Markdown headings as candidate targets. Each `#` / `##` / `###`
 * heading becomes a symbol the planner can aim at. The anchor text is the
 * full raw heading line so the editor's SEARCH block can match it exactly.
 *
 * Used by mineSurfaceCandidates for docs-portability-style surfaces that
 * point at .md files — without this, the planner has no way to select a
 * target in a doc and returns no_safe_change on every attempt (as burst1/2
 * both demonstrated with 0% plan rate on docs-portability).
 */
function extractMarkdownHeadings(content) {
  const lines = String(content || '').split('\n');
  const headings = [];
  let fenced = false;
  for (const line of lines) {
    // Skip anything inside a fenced code block — ```lang ... ```
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].trim();
    if (!text) continue;
    headings.push({
      kind: `heading-h${level}`,
      symbol: text,
      anchorText: line.trim(),
      level,
    });
  }
  return headings;
}

function isMarkdownPath(relativePath) {
  return /\.(md|markdown|mdx)$/i.test(relativePath || '');
}

function buildRepeatedConstantOpportunities(sourceFiles) {
  const constantMap = new Map();
  for (const file of sourceFiles) {
    const lines = String(file.content || '').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*const\s+([A-Z][A-Z0-9_]{2,})\s*=/);
      if (!match) {
        continue;
      }
      const name = match[1];
      if (!constantMap.has(name)) {
        constantMap.set(name, new Set());
      }
      constantMap.get(name).add(file.path);
    }
  }
  return Array.from(constantMap.entries())
    .filter(([, paths]) => paths.size > 1)
    .map(([name, paths]) => `Repeated constant ${name} appears in ${Array.from(paths).join(', ')}`);
}

function buildHeuristicOpportunities(sourceTargets, testTargets, repeatedConstants) {
  const opportunities = [];
  opportunities.push(...repeatedConstants);
  for (const target of sourceTargets) {
    if (/(parse|validate|selector|flag|hint|error|watch|risk|policy|recipe|mirror|model|stream)/i.test(target.symbol || target.anchorText)) {
      opportunities.push(`Bounded candidate around ${target.symbol || target.anchorText} in ${target.path}`);
    }
  }
  for (const target of testTargets) {
    if (/(invalid|error|reject|panic|warning|selector|policy|recipe|mirror|model)/i.test(target.anchorText)) {
      opportunities.push(`Existing regression anchor "${target.anchorText}" in ${target.path}`);
    }
  }
  return truncateList(Array.from(new Set(opportunities)), 24);
}

function mineSurfaceCandidates(adapter, surface, repoRoot = (adapter && adapter.repoRoot)) {
  if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
    return { sourceTargets: [], testTargets: [], opportunities: [] };
  }
  const safeRepoRoot = repoRoot || (adapter && adapter.repoRoot) || process.cwd();
  const surfacePaths = Array.isArray(surface.paths) ? surface.paths : [];
  const surfaceTestPaths = Array.isArray(surface.testPaths) ? surface.testPaths : [];
  const sourceTargets = [];
  const testTargets = [];
  const sourceFiles = [];

  for (const relativePath of surfacePaths) {
    if (relativePath.includes('*')) {
      continue;
    }
    const resolved = resolveRepoPath(safeRepoRoot, relativePath);
    const content = fs.readFileSync(resolved.absolutePath, 'utf8');
    sourceFiles.push({ path: relativePath, content });
    if (isMarkdownPath(relativePath)) {
      // Docs surfaces: mine headings instead of code symbols. Use the heading
      // line as an anchor_text (exact text) so the staged editor can build a
      // SEARCH block that targets the section. line_contains anchor type keeps
      // the planner honest about non-symbol targets.
      for (const heading of truncateList(extractMarkdownHeadings(content), 12)) {
        sourceTargets.push({
          path: relativePath,
          symbol: heading.symbol,
          anchorType: 'line_contains',
          anchorText: heading.anchorText,
        });
      }
      continue;
    }
    for (const symbol of truncateList(extractSourceSymbols(content), 8)) {
      sourceTargets.push({
        path: relativePath,
        symbol: symbol.symbol,
        anchorType: 'symbol',
        anchorText: symbol.anchorText,
      });
    }
  }

  for (const relativePath of surfaceTestPaths) {
    if (relativePath.includes('*')) {
      continue;
    }
    const resolved = resolveRepoPath(safeRepoRoot, relativePath);
    const content = fs.readFileSync(resolved.absolutePath, 'utf8');
    for (const anchor of truncateList(extractTestAnchors(content), 8)) {
      testTargets.push({
        path: relativePath,
        anchorType: anchor.anchorType,
        anchorText: anchor.anchorText,
      });
    }
  }

  const repeatedConstants = buildRepeatedConstantOpportunities(sourceFiles);
  return {
    sourceTargets: truncateList(sourceTargets, 30),
    testTargets: truncateList(testTargets, 24),
    opportunities: buildHeuristicOpportunities(sourceTargets, testTargets, repeatedConstants),
  };
}

function buildPlannerPrompt(options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const ctx = safeOptions.context && typeof safeOptions.context === 'object' ? safeOptions.context : {};
  const ctxSurface = ctx.surface && typeof ctx.surface === 'object' ? ctx.surface : {};
  return {
    systemPrompt: [
      'You are the staged overnight planner.',
      'Return JSON only.',
      'Pick one bounded change candidate or return no_safe_change.',
      'Do not write patches.',
      'Choose exactly one source target and one test target for propose.',
      'Only choose files from the provided candidate list.',
      'If the change would need more than one source file or one test file, return no_safe_change.',
      'Do not repeat ideas listed in no_retry_ideas or anchor_failures.',
      'Do not pick a source_target whose (path, symbol) pair appears in already_explored_targets; those have already been proposed in prior batches and duplicate work is rejected downstream.',
    ].join(' '),
    userPrompt: JSON.stringify({
      objective: ctx.objective,
      surface: {
        id: ctxSurface.id,
        title: ctxSurface.title,
        invariants: ctxSurface.invariants,
        paths: ctxSurface.paths,
        testPaths: ctxSurface.testPaths,
        requiredTestKinds: ctxSurface.requiredTestKinds,
      },
      candidates: safeOptions.candidates,
      no_retry_ideas: safeOptions.noRetryIdeas,
      anchor_failures: safeOptions.anchorFailures,
      already_explored_targets: safeOptions.exploredTargets || [],
      return_shape: {
        decision: 'propose | no_safe_change',
        change_summary: 'one bounded change idea',
        source_target: {
          path: 'relative/path',
          symbol: 'named symbol',
          anchor_type: 'symbol',
          anchor_text: 'exact line or symbol anchor',
        },
        test_target: {
          path: 'relative/path',
          anchor_type: 'test_name',
          anchor_text: 'exact test name or test anchor',
        },
        why_bounded: 'why this fits one source file and one test file',
        invariants_preserved: ['which invariants stay true'],
        expected_test_kind: 'regression | integration | contract',
      },
    }, null, 2),
  };
}

function buildEditorPrompt(options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const ctx = safeOptions.context && typeof safeOptions.context === 'object' ? safeOptions.context : {};
  const ctxSurface = ctx.surface && typeof ctx.surface === 'object' ? ctx.surface : {};
  const plan = safeOptions.plan && typeof safeOptions.plan === 'object' ? safeOptions.plan : {};
  const sourceTarget = plan.sourceTarget && typeof plan.sourceTarget === 'object' ? plan.sourceTarget : {};
  const testTarget = plan.testTarget && typeof plan.testTarget === 'object' ? plan.testTarget : {};
  const windows = safeOptions.windows && typeof safeOptions.windows === 'object' ? safeOptions.windows : {};
  return {
    systemPrompt: [
      'You are the staged overnight editor.',
      'Return JSON only.',
      'Edit only inside the provided source_window and test_window.',
      'Do not change files, symbols, or test targets chosen by the planner.',
      'Use exactly one code patch block and one test patch block when making a source change.',
      'SEARCH and context must be copied from the provided windows.',
      'If no safe change fits inside the provided windows, return empty code_changes and test_changes.',
    ].join(' '),
    userPrompt: JSON.stringify({
      objective: ctx.objective,
      surface: {
        id: ctxSurface.id,
        title: ctxSurface.title,
        invariants: ctxSurface.invariants,
      },
      plan: safeOptions.plan,
      source_window: windows.sourceWindow,
      test_window: windows.testWindow,
      no_retry_ideas: safeOptions.noRetryIdeas,
      anchor_failures: safeOptions.anchorFailures,
      return_shape: {
        logical_explanation: {
          problem: 'what is being solved',
          why_this_surface: 'why the chosen surface is correct',
          invariants_preserved: ['which invariants stay true'],
          why_this_is_bounded: 'why the change stays small',
          residual_risks: ['remaining risks or empty list'],
        },
        code_changes: [
          {
            path: sourceTarget.path,
            search: 'exact current text from source_window',
            replace: 'new text',
            context_before: 'optional exact text before search',
            context_after: 'optional exact text after search',
          },
        ],
        test_changes: [
          {
            path: testTarget.path,
            search: 'exact current text from test_window',
            replace: 'new text',
            context_before: 'optional exact text before search',
            context_after: 'optional exact text after search',
          },
        ],
      },
    }, null, 2),
  };
}

function buildEditorRepairPrompt(options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const prompt = safeOptions.prompt && typeof safeOptions.prompt === 'object' ? safeOptions.prompt : {};
  const windows = safeOptions.windows && typeof safeOptions.windows === 'object' ? safeOptions.windows : {};
  return {
    systemPrompt: prompt.systemPrompt,
    userPrompt: JSON.stringify({
      task: 'Repair the staged editor response without changing the chosen files, symbols, or test target.',
      error: safeOptions.errorMessage,
      original_response: safeOptions.originalText,
      locked_plan: safeOptions.plan,
      source_window: windows.sourceWindow,
      test_window: windows.testWindow,
      reminder: 'Fix only malformed JSON, missing fields, or anchor mismatch inside the same chosen windows.',
      // Burst6 fix: 25/57 staged repairs died with "logical_explanation.problem is required"
      // because the repair prompt never told the model the response must include the full
      // proposal shape. The model stripped logical_explanation entirely when asked to "only
      // fix anchor mismatch". Explicit return_shape + required-keys reminder stops this.
      must_include_all_top_level_keys: ['logical_explanation', 'code_changes', 'test_changes'],
      must_include_logical_explanation_problem: 'Your response MUST include logical_explanation.problem as a non-empty string, even if you are only fixing an anchor. Restate the problem from the original_response if you are unsure.',
      return_shape: {
        logical_explanation: {
          problem: 'what is being solved (required, non-empty)',
          why_this_surface: 'why the chosen surface is correct',
          invariants_preserved: ['which invariants stay true'],
          why_this_is_bounded: 'why the change stays small',
          residual_risks: ['remaining risks or empty list'],
        },
        code_changes: [
          {
            path: 'relative/path',
            search: 'exact current text copied from source_window',
            replace: 'new text',
            context_before: 'optional exact text before search',
            context_after: 'optional exact text after search',
          },
        ],
        test_changes: [
          {
            path: 'relative/path',
            search: 'exact current text copied from test_window',
            replace: 'new text',
            context_before: 'optional exact text before search',
            context_after: 'optional exact text after search',
          },
        ],
      },
    }, null, 2),
  };
}

function isSourceBoundary(line) {
  const trimmed = String(line || '').trim();
  return /^(?:async\s+)?function\b/.test(trimmed)
    || /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(trimmed)
    || /^class\b/.test(trimmed)
    || /^(?:module\.exports|exports\.)/.test(trimmed);
}

function isTestBoundary(line) {
  return /^\s*(?:test|it|describe)\s*\(/.test(String(line || ''));
}

function isCommentLike(line) {
  const trimmed = String(line || '').trim();
  return trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function escapeRegExpChars(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAnchorLineIndex(lines, target, kind) {
  const anchorText = normalizeText(target.anchorText);
  const symbol = normalizeText(target.symbol);
  if (kind === 'test') {
    return lines.findIndex((line) => isTestBoundary(line) && line.includes(anchorText));
  }
  if (target.anchorType === 'line_contains' && anchorText) {
    return lines.findIndex((line) => line.includes(anchorText));
  }
  const escapedSymbol = escapeRegExpChars(symbol);
  const symbolPatterns = [
    new RegExp(`^\\s*(?:async\\s+)?function\\s+${escapedSymbol}\\s*\\(`),
    new RegExp(`^\\s*(?:const|let|var)\\s+${escapedSymbol}\\s*=`),
    new RegExp(`^\\s*class\\s+${escapedSymbol}\\b`),
    new RegExp(`^\\s*(?:module\\.exports\\.|exports\\.)${escapedSymbol}\\s*=`),
  ];
  const bySymbol = lines.findIndex((line) => symbolPatterns.some((pattern) => pattern.test(line)));
  if (bySymbol !== -1) {
    return bySymbol;
  }
  if (anchorText) {
    return lines.findIndex((line) => line.includes(anchorText));
  }
  return -1;
}

function buildWindowBounds(lines, anchorIndex, kind, lineCap) {
  const boundaryMatcher = kind === 'test' ? isTestBoundary : isSourceBoundary;
  let start = anchorIndex;
  while (start > 0 && isCommentLike(lines[start - 1])) {
    start -= 1;
  }
  let end = lines.length;
  for (let index = anchorIndex + 1; index < lines.length; index += 1) {
    if (boundaryMatcher(lines[index])) {
      end = index;
      break;
    }
  }
  if ((end - start) > lineCap) {
    end = Math.min(lines.length, start + lineCap);
  }
  return { start, end };
}

function buildTargetWindow(options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const repoRoot = safeOptions.repoRoot;
  const target = safeOptions.target;
  const kind = safeOptions.kind;
  const lineCap = Math.max(20, Number(safeOptions.lineCap) || DEFAULT_WINDOW_LINE_CAP);
  if (!target || typeof target !== 'object') {
    throw new AdapterError('ANCHOR_NOT_FOUND', 'target', 'buildTargetWindow requires a valid target object', { fixHint: 'Pass a target object with path and anchorText to buildTargetWindow.' });
  }
  const resolved = resolveRepoPath(repoRoot, target.path);
  const content = fs.readFileSync(resolved.absolutePath, 'utf8');
  const lines = content.split('\n');
  const anchorIndex = findAnchorLineIndex(lines, target, kind);
  if (anchorIndex === -1) {
    throw new AdapterError('ANCHOR_NOT_FOUND', target.path, `Could not locate ${kind} anchor in ${target.path}`, { fixHint: `The ${kind} anchor text "${target.anchorText}" was not found in ${target.path}. Pick a symbol or test name that exists in the file.` });
  }
  const bounds = buildWindowBounds(lines, anchorIndex, kind, lineCap);
  return {
    path: target.path,
    kind,
    symbol: target.symbol || null,
    anchorType: target.anchorType,
    anchorText: target.anchorText,
    startLine: bounds.start + 1,
    endLine: bounds.end,
    excerpt: lines.slice(bounds.start, bounds.end).join('\n'),
  };
}

function buildTargetWindows(options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const plan = safeOptions.plan && typeof safeOptions.plan === 'object' ? safeOptions.plan : {};
  const sourceWindow = buildTargetWindow({
    repoRoot: safeOptions.repoRoot,
    target: plan.sourceTarget,
    kind: 'source',
    lineCap: safeOptions.lineCap,
  });
  const testWindow = buildTargetWindow({
    repoRoot: safeOptions.repoRoot,
    target: plan.testTarget,
    kind: 'test',
    lineCap: safeOptions.lineCap,
  });
  return {
    sourceWindow,
    testWindow,
    windowFingerprint: buildWindowFingerprint(sourceWindow, testWindow),
  };
}

function listAnchorFailures(ledger, objectiveHash, surfaceId, sourceTarget) {
  if (!Array.isArray(ledger)) return [];
  const sourceKey = sourceTarget ? buildSourceTargetKey(sourceTarget) : null;
  return ledger
    .filter((entry) => entry && entry.objectiveHash === objectiveHash && entry.surfaceId === surfaceId)
    .filter((entry) => entry.failureKind && /anchor|window|schema/i.test(entry.failureKind))
    .filter((entry) => !sourceKey || buildSourceTargetKey(entry.sourceTarget) === sourceKey)
    .map((entry) => ({
      stage: entry.stage,
      failureKind: entry.failureKind,
      sourceTarget: entry.sourceTarget,
      testTarget: entry.testTarget,
      failedPath: entry.failedPath,
      failedSearchExcerpt: entry.failedSearchExcerpt,
      summary: entry.summary,
    }));
}

function shouldCoolSourceTarget(ledger, objectiveHash, surfaceId, sourceTarget) {
  if (!Array.isArray(ledger)) return false;
  const sourceKey = buildSourceTargetKey(sourceTarget);
  const count = ledger
    .filter((entry) => entry && entry.objectiveHash === objectiveHash && entry.surfaceId === surfaceId)
    .filter((entry) => buildSourceTargetKey(entry.sourceTarget) === sourceKey)
    .filter((entry) => ['invalid-target-window', 'anchor-preflight-failed', 'editor-schema-failed'].includes(entry.failureKind))
    .length;
  return count >= 2;
}

function validateStagedEditorProposal(options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const rawProposal = safeOptions.proposal;
  const plan = safeOptions.plan && typeof safeOptions.plan === 'object' ? safeOptions.plan : {};
  const windows = safeOptions.windows && typeof safeOptions.windows === 'object' ? safeOptions.windows : {};
  const staged = safeOptions.staged && typeof safeOptions.staged === 'object' ? safeOptions.staged : {};
  const safeRawProposal = rawProposal && typeof rawProposal === 'object' && !Array.isArray(rawProposal) ? rawProposal : {};
  const proposal = {
    codeChanges: Array.isArray(safeRawProposal.codeChanges) ? safeRawProposal.codeChanges : [],
    testChanges: Array.isArray(safeRawProposal.testChanges) ? safeRawProposal.testChanges : [],
  };
  const maxSourceFiles = Math.max(1, Number(staged.maxSourceFiles) || 1);
  const maxTestFiles = Math.max(1, Number(staged.maxTestFiles) || 1);
  const maxCodeBlocks = Math.max(1, Number(staged.maxCodeBlocks) || 1);
  const maxTestBlocks = Math.max(1, Number(staged.maxTestBlocks) || 1);

  if (proposal.codeChanges.length === 0 && proposal.testChanges.length === 0) {
    return {
      ok: false,
      reasonCode: 'no-safe-change',
      nextStep: 'No bounded safe change was identified inside the staged windows.',
      failureStage: 'editing',
      failureKind: 'no-safe-change',
      failedPath: null,
      failedSearchExcerpt: '',
    };
  }

  const sourcePaths = Array.from(new Set(proposal.codeChanges.map((entry) => normalizeText(entry.path)).filter(Boolean)));
  const testPaths = Array.from(new Set(proposal.testChanges.map((entry) => normalizeText(entry.path)).filter(Boolean)));

  if (sourcePaths.length > maxSourceFiles || testPaths.length > maxTestFiles || proposal.codeChanges.length > maxCodeBlocks || proposal.testChanges.length > maxTestBlocks) {
    return {
      ok: false,
      reasonCode: 'too-broad-for-staged-mode',
      nextStep: 'Shrink the staged edit to one source file, one test file, and one block each.',
      failureStage: 'editing',
      failureKind: 'too-broad-for-staged-mode',
      failedPath: sourcePaths[0] || testPaths[0] || null,
      failedSearchExcerpt: '',
    };
  }

  if (proposal.codeChanges.length > 0 && proposal.testChanges.length === 0) {
    // Allow non-code-only source changes (docs, YAML, config) to pass without
    // a matching test. This mirrors gateProposal's behavior in the legacy path.
    const nonCodeOnly = proposal.codeChanges.every((entry) => isNonCodePath(entry.path));
    if (!nonCodeOnly) {
      return {
        ok: false,
        reasonCode: 'missing-tests',
        nextStep: 'Add a matching test edit for the staged source change.',
        failureStage: 'editing',
        failureKind: 'missing-tests',
        failedPath: plan.sourceTarget ? plan.sourceTarget.path : null,
        failedSearchExcerpt: '',
      };
    }
  }

  const planSourceTarget = plan.sourceTarget && typeof plan.sourceTarget === 'object' ? plan.sourceTarget : {};
  const planTestTarget = plan.testTarget && typeof plan.testTarget === 'object' ? plan.testTarget : {};

  if (sourcePaths.some((entry) => entry !== planSourceTarget.path) || testPaths.some((entry) => entry !== planTestTarget.path)) {
    return {
      ok: false,
      reasonCode: 'anchor-preflight-failed',
      nextStep: 'Keep the editor proposal inside the chosen source and test targets.',
      failureStage: 'preflight',
      failureKind: 'anchor-preflight-failed',
      failedPath: sourcePaths.find((entry) => entry !== planSourceTarget.path) || testPaths.find((entry) => entry !== planTestTarget.path) || null,
      failedSearchExcerpt: '',
    };
  }

  const sourceWindow = windows.sourceWindow && typeof windows.sourceWindow === 'object' ? windows.sourceWindow : {};
  const testWindow = windows.testWindow && typeof windows.testWindow === 'object' ? windows.testWindow : {};
  const windowsByPath = {
    [planSourceTarget.path]: sourceWindow.excerpt,
    [planTestTarget.path]: testWindow.excerpt,
  };
  const allBlocks = proposal.codeChanges.concat(proposal.testChanges);
  for (const block of allBlocks) {
    try {
      validatePatchSetAgainstContent([block], windowsByPath);
    } catch (error) {
      return {
        ok: false,
        reasonCode: 'anchor-preflight-failed',
        nextStep: 'Repair the SEARCH anchor so it matches the staged window exactly.',
        failureStage: 'preflight',
        failureKind: 'anchor-preflight-failed',
        failedPath: block.path,
        failedSearchExcerpt: String(block.search || '').slice(0, 240),
        errorMessage: normalizeText(error && error.message ? error.message : error),
      };
    }
  }

  return {
    ok: true,
  };
}

module.exports = {
  DEFAULT_WINDOW_LINE_CAP,
  NON_CODE_SUFFIXES,
  buildCandidateFingerprint,
  buildEditorPrompt,
  buildEditorRepairPrompt,
  buildPlannerPrompt,
  buildSourceTargetKey,
  buildTargetWindow,
  buildTargetWindows,
  buildWindowFingerprint,
  isNonCodePath,
  listAnchorFailures,
  mineSurfaceCandidates,
  normalizeProposalMode,
  parsePlannerResponse,
  shouldCoolSourceTarget,
  validateStagedEditorProposal,
};
