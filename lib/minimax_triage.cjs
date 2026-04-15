'use strict';

/**
 * minimax_triage.cjs — Background triage loop that reads GitHub auto-report
 * issues, generates directives, and proposes fixes.
 *
 * Exports:
 *   fetchAutoReportIssues(options)        — reads issues labeled 'auto-report' via gh CLI
 *   parseIssueReport(issueBody)           — parses structured YAML from an issue body
 *   aggregateIssueReports(issues)         — groups parsed reports by errorCode
 *   generateTriageDirectives(aggregated, options) — scores and generates directive YAML files
 *   runTriageCycle(options)               — orchestrator: fetch → parse → aggregate → generate → fix
 *
 * Error codes (all AdapterError):
 *   TRIAGE_REPO_REQUIRED       — repo option missing
 *   TRIAGE_OUTPUT_DIR_REQUIRED  — outputDir option missing
 *   TRIAGE_PARSE_FAILED         — issue body not parseable
 *
 * Dependency injection:
 *   fetchFn     — replaces gh CLI spawn (tests)
 *   modelCaller — replaces real model calls (tests)
 *   runners     — replaces directive_runner execution (tests)
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const YAML = require('yaml');

const { AdapterError } = require('./errors.cjs');
const { writeYamlFile } = require('./overnight_yaml.cjs');
const { ensureDir } = require('./baton_common.cjs');

// ── Scoring (mirrors engine_signal_adapter) ────────────────────────

function classifySeverity(reasonCode) {
  const code = String(reasonCode || '').toUpperCase();
  if (code.startsWith('FATAL') || code.startsWith('CRASH') || code.startsWith('DATA_LOSS')) return 5;
  if (code.startsWith('AUTH') || code.startsWith('SECURITY') || code.startsWith('CORRUPT')) return 4;
  if (code.startsWith('TIMEOUT') || code.startsWith('VALIDATION') || code.startsWith('LIMIT')) return 3;
  if (code.startsWith('DEPRECAT') || code.startsWith('COMPAT')) return 2;
  if (code.startsWith('STYLE') || code.startsWith('LINT') || code.startsWith('FORMAT')) return 1;
  return 3;
}

function scoreEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return { score: 0, priority: 'low' };
  const severity = Number(evidence.severity) || classifySeverity(evidence.errorCode);
  const burnRate = evidence.burn_rate != null ? Number(evidence.burn_rate)
    : evidence.burnRate != null ? Number(evidence.burnRate)
    : Number(evidence.frequency) || 0;
  const affected = evidence.affected != null ? Number(evidence.affected) : Number((evidence.versions && evidence.versions.length) || 0);
  const confidence = Number(evidence.confidence) || 0;
  const score = severity * burnRate * Math.log1p(affected) * confidence;

  let priority;
  if (score >= 10) priority = 'critical';
  else if (score >= 5) priority = 'high';
  else if (score >= 1) priority = 'medium';
  else priority = 'low';

  return { score: Math.round(score * 1000) / 1000, priority };
}

// ── Default score threshold ────────────────────────────────────────

const DEFAULT_MIN_SCORE = 0.5;

// ── fetchAutoReportIssues ──────────────────────────────────────────

/**
 * Fetch GitHub issues labeled 'auto-report'.
 *
 * @param {{ repo: string, state?: string, limit?: number, fetchFn?: function }} options
 * @returns {object[]} array of issue objects
 */
function fetchAutoReportIssues(options = {}) {
  const { repo, state = 'open', limit = 100, fetchFn } = options;

  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    throw new AdapterError(
      'TRIAGE_REPO_REQUIRED', 'repo',
      'repo is required',
      { fixHint: 'Pass options.repo (e.g. "owner/my-project").' },
    );
  }

  // Dependency-injection path (tests)
  if (typeof fetchFn === 'function') {
    return fetchFn({ repo, state, limit, labels: 'auto-report' });
  }

  // Real path: call `gh issue list` via spawnSync
  const args = [
    'issue', 'list',
    '--repo', repo,
    '--label', 'auto-report',
    '--state', state,
    '--limit', String(limit),
    '--json', 'number,title,body,labels,state,createdAt,url',
  ];

  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new AdapterError(
        'TRIAGE_CLI_NOT_FOUND', 'gh',
        'gh command not found — install GitHub CLI',
        { fixHint: 'Install the GitHub CLI: https://cli.github.com/', cause: result.error },
      );
    }
    throw new AdapterError(
      'TRIAGE_FETCH_FAILED', 'gh',
      `gh spawn error: ${result.error.message}`,
      { fixHint: 'Check that gh is installed and authenticated.', cause: result.error },
    );
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new AdapterError(
      'TRIAGE_FETCH_FAILED', 'gh',
      `gh exited ${result.status}: ${stderr}`,
      { fixHint: 'Run `gh auth status` to verify authentication.' },
    );
  }

  const stdout = (result.stdout || '').trim();
  if (!stdout) return [];

  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    throw new AdapterError(
      'TRIAGE_FETCH_FAILED', 'gh',
      `Failed to parse gh output as JSON: ${e.message}`,
      { fixHint: 'Unexpected response from gh — check your query.', cause: e },
    );
  }
}

// ── parseIssueReport ───────────────────────────────────────────────

/**
 * Parse structured YAML from an issue body into a report object.
 * Expected format in the body:
 *
 * ```yaml
 * errorCode: TIMEOUT_EXCEEDED
 * frequency: 42
 * versions:
 *   - 1.2.0
 *   - 1.3.0
 * stack: |
 *   Error: timed out ...
 * inputShape: { users: 1000 }
 * ```
 *
 * @param {string} issueBody
 * @returns {{ errorCode: string, frequency: number, versions: string[], stack: string, inputShape: object|null }}
 */
function parseIssueReport(issueBody) {
  if (!issueBody || typeof issueBody !== 'string') {
    throw new AdapterError(
      'TRIAGE_PARSE_FAILED', 'issueBody',
      'issue body is required and must be a non-empty string',
      { fixHint: 'Pass the issue body string to parseIssueReport.' },
    );
  }

  // Extract YAML from fenced code block or treat entire body as YAML
  let yamlContent = issueBody;
  const fenceMatch = issueBody.match(/```ya?ml\s*\n([\s\S]*?)```/i);
  if (fenceMatch) {
    yamlContent = fenceMatch[1];
  }

  let parsed;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (e) {
    throw new AdapterError(
      'TRIAGE_PARSE_FAILED', 'issueBody',
      `failed to parse YAML from issue body: ${e.message}`,
      { fixHint: 'Ensure the issue body contains valid YAML (optionally in a ```yaml fence).', cause: e },
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdapterError(
      'TRIAGE_PARSE_FAILED', 'issueBody',
      'parsed YAML must be a key/value object',
      { fixHint: 'The issue body YAML must be a mapping, not a scalar or array.' },
    );
  }

  if (!parsed.errorCode || typeof parsed.errorCode !== 'string') {
    throw new AdapterError(
      'TRIAGE_PARSE_FAILED', 'errorCode',
      'errorCode is required in the issue report YAML',
      { fixHint: 'Add an errorCode field to the issue body YAML.' },
    );
  }

  return {
    errorCode: String(parsed.errorCode),
    frequency: Number(parsed.frequency) || 1,
    versions: Array.isArray(parsed.versions) ? parsed.versions.map(String) : [],
    stack: String(parsed.stack || ''),
    inputShape: (parsed.inputShape && typeof parsed.inputShape === 'object') ? parsed.inputShape : null,
  };
}

// ── aggregateIssueReports ──────────────────────────────────────────

/**
 * Group parsed reports by errorCode, compute aggregate frequency,
 * collect affected versions, compute confidence.
 *
 * @param {{ number: number, title: string, body: string, _report?: object }[]} issues
 * @returns {{ errorCode: string, totalFrequency: number, versions: string[], confidence: number, issueNumbers: number[], sampleStacks: string[] }[]}
 */
function aggregateIssueReports(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return [];

  const buckets = new Map();

  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    const report = issue._report;
    if (!report || typeof report !== 'object') continue;

    const code = report.errorCode;
    if (!code) continue;

    if (!buckets.has(code)) {
      buckets.set(code, {
        errorCode: code,
        totalFrequency: 0,
        versions: new Set(),
        issueNumbers: [],
        sampleStacks: [],
      });
    }

    const bucket = buckets.get(code);
    bucket.totalFrequency += (report.frequency || 1);
    bucket.issueNumbers.push(issue.number || 0);

    if (Array.isArray(report.versions)) {
      for (const v of report.versions) bucket.versions.add(v);
    }

    if (report.stack && bucket.sampleStacks.length < 3) {
      bucket.sampleStacks.push(report.stack);
    }
  }

  const totalIssues = issues.filter((i) => i && i._report).length;
  const result = [];

  for (const bucket of buckets.values()) {
    result.push({
      errorCode: bucket.errorCode,
      totalFrequency: bucket.totalFrequency,
      versions: [...bucket.versions],
      confidence: Math.min(1, bucket.issueNumbers.length / Math.max(1, totalIssues)),
      issueNumbers: bucket.issueNumbers,
      sampleStacks: bucket.sampleStacks,
    });
  }

  return result.sort((a, b) => b.totalFrequency - a.totalFrequency);
}

// ── generateTriageDirectives ───────────────────────────────────────

/**
 * Score aggregated reports and generate directive YAML files for those
 * above the threshold.
 *
 * @param {object[]} aggregated — output of aggregateIssueReports
 * @param {{ outputDir: string, dryRun?: boolean, minScore?: number }} options
 * @returns {{ generated: string[], skipped: object[] }}
 */
function generateTriageDirectives(aggregated, options = {}) {
  const { outputDir, dryRun = false, minScore = DEFAULT_MIN_SCORE } = options;

  if (!outputDir || typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new AdapterError(
      'TRIAGE_OUTPUT_DIR_REQUIRED', 'outputDir',
      'outputDir is required',
      { fixHint: 'Pass options.outputDir for directive YAML output.' },
    );
  }

  if (!Array.isArray(aggregated) || aggregated.length === 0) {
    return { generated: [], skipped: [] };
  }

  const resolvedOutput = path.resolve(outputDir);
  if (!dryRun) {
    ensureDir(resolvedOutput);
  }

  const generated = [];
  const skipped = [];

  for (const agg of aggregated) {
    const severity = classifySeverity(agg.errorCode);
    const evidence = {
      errorCode: agg.errorCode,
      severity,
      frequency: agg.totalFrequency,
      burn_rate: agg.totalFrequency,
      affected: agg.versions.length,
      versions: agg.versions,
      confidence: agg.confidence,
    };

    const { score, priority } = scoreEvidence(evidence);

    if (score < minScore) {
      skipped.push({
        errorCode: agg.errorCode,
        score,
        priority,
        reason: `score ${score} < minScore ${minScore}`,
      });
      continue;
    }

    // Map priority to P-level
    const priorityMap = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };
    const pLevel = priorityMap[priority] || 'P3';

    // Map severity to directive type
    let directiveType, action;
    if (severity >= 4) { directiveType = 'bug'; action = 'polish'; }
    else if (severity >= 2) { directiveType = 'performance'; action = 'improve'; }
    else { directiveType = 'feature'; action = 'build'; }

    // Build type-appropriate evidence block
    let typedEvidence;
    if (directiveType === 'bug') {
      typedEvidence = {
        error_message: agg.errorCode,
        stack_trace: (agg.sampleStacks && agg.sampleStacks[0]) || '',
        repro_steps: [`Observed ${agg.totalFrequency} time(s) across ${agg.issueNumbers.length} issue(s)`],
        affected_versions: agg.versions || [],
      };
    } else if (directiveType === 'performance') {
      typedEvidence = {
        metric: 'error_frequency',
        current_value: agg.totalFrequency,
        target_value: 0,
        unit: 'occurrences',
        measurement_tool: 'minimax_triage',
      };
    } else {
      typedEvidence = {
        user_request: agg.errorCode,
        use_case: `Address ${agg.errorCode} across ${agg.issueNumbers.length} issue(s)`,
        acceptance_criteria: [`Resolve ${agg.errorCode}`],
      };
    }

    const directive = {
      directive: directiveType,
      version: 1,
      source: 'minimax_triage',
      generated: new Date().toISOString(),
      evidence: typedEvidence,
      action,
      target_surface: 'auto-report',
      priority: pLevel,
      reason: `${agg.errorCode} — ${agg.totalFrequency} occurrence(s) across ${agg.issueNumbers.length} issue(s), severity ${severity}, score ${score}`,
    };

    const fileName = `triage-${agg.errorCode.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.yaml`;
    const filePath = path.join(resolvedOutput, fileName);

    if (!dryRun) {
      writeYamlFile(filePath, directive);
    }

    generated.push(filePath);
  }

  return { generated, skipped };
}

// ── runTriageCycle ─────────────────────────────────────────────────

/**
 * Orchestrator: fetch → parse → aggregate → generate directives → optionally run fixes.
 *
 * @param {{
 *   repo: string,
 *   outputDir: string,
 *   dryRun?: boolean,
 *   autoFix?: boolean,
 *   minScore?: number,
 *   fetchFn?: function,
 *   modelCaller?: function,
 *   runners?: object,
 * }} options
 * @returns {{ issuesProcessed: number, directivesGenerated: number, fixesProposed: number }}
 */
function runTriageCycle(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AdapterError(
      'TRIAGE_REPO_REQUIRED', 'repo',
      'options must be a non-null object',
      { fixHint: 'Pass an object with at least { repo, outputDir } to runTriageCycle.' },
    );
  }

  const {
    repo,
    outputDir,
    dryRun = false,
    autoFix = false,
    minScore = DEFAULT_MIN_SCORE,
    fetchFn,
    modelCaller,
    runners,
  } = options;

  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    throw new AdapterError(
      'TRIAGE_REPO_REQUIRED', 'repo',
      'repo is required',
      { fixHint: 'Pass options.repo (e.g. "owner/my-project").' },
    );
  }

  if (!outputDir || typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new AdapterError(
      'TRIAGE_OUTPUT_DIR_REQUIRED', 'outputDir',
      'outputDir is required',
      { fixHint: 'Pass options.outputDir for directive YAML output.' },
    );
  }

  // Step 1: Fetch issues
  const rawIssues = fetchAutoReportIssues({ repo, fetchFn });

  // Step 2: Parse each issue body
  const parsed = [];
  let parseFailures = 0;
  for (const issue of rawIssues) {
    try {
      const report = parseIssueReport(issue.body);
      parsed.push({ ...issue, _report: report });
    } catch {
      parseFailures += 1;
      parsed.push({ ...issue, _report: null });
    }
  }

  // Step 3: Aggregate
  const aggregated = aggregateIssueReports(parsed);

  // Step 4: Generate directives
  const { generated, skipped } = generateTriageDirectives(aggregated, {
    outputDir,
    dryRun,
    minScore,
  });

  // Step 5: If autoFix, run directive_runner on each generated directive
  let fixesProposed = 0;
  if (autoFix && generated.length > 0) {
    const runDirectiveFn = (runners && typeof runners.runDirective === 'function')
      ? runners.runDirective
      : null;

    if (runDirectiveFn) {
      for (const directivePath of generated) {
        try {
          runDirectiveFn({ directivePath, dryRun, modelCaller });
          fixesProposed += 1;
        } catch {
          // Runner failure does not abort the cycle
        }
      }
    }
  }

  return {
    issuesProcessed: rawIssues.length,
    directivesGenerated: generated.length,
    fixesProposed,
    parseFailures,
    skipped,
  };
}

module.exports = {
  fetchAutoReportIssues,
  parseIssueReport,
  aggregateIssueReports,
  generateTriageDirectives,
  runTriageCycle,
  // internals exposed for testing
  classifySeverity,
  scoreEvidence,
  DEFAULT_MIN_SCORE,
};
