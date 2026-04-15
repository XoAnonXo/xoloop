'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { writeYamlFile } = require('./overnight_yaml.cjs');
const { AdapterError } = require('./errors.cjs');

// ── Classification keyword sets ────────────────────────────────────

const BUG_KEYWORDS = ['bug', 'error', 'crash', 'fail', 'broken', 'fix', 'issue', 'wrong', 'unexpected'];
const FEATURE_KEYWORDS = ['feature', 'add', 'support', 'request', 'would be nice', 'enhancement', 'implement', 'allow'];
const QUESTION_KEYWORDS = ['how', 'question', 'help', 'documentation', 'example'];

// ── Internal helpers ───────────────────────────────────────────────

/**
 * Count how many keywords from `keywords` appear in `text` (case-insensitive).
 */
function countKeywordHits(text, keywords) {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits += 1;
  }
  return hits;
}

/**
 * Extract words from a string (lowercased, >= 3 chars, no stopwords).
 */
function extractWords(text) {
  const stopwords = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
    'has', 'have', 'not', 'but', 'can', 'all', 'will', 'its', 'into',
    'when', 'than', 'been', 'also', 'does', 'should', 'would', 'could',
  ]);
  return (text || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopwords.has(w));
}

// ── Exported API ───────────────────────────────────────────────────

/**
 * Fetch open issues from a GitHub repository using the `gh` CLI.
 *
 * options.fetchFn — injectable override; when provided, called instead of
 * spawning `gh`. Must return a JSON-parseable array of issue objects.
 */
function fetchGitHubIssues(options = {}) {
  const { owner, repo, state, labels, limit, cwd, fetchFn } = options;

  if (!owner || typeof owner !== 'string' || !owner.trim()) {
    throw new AdapterError(
      'GITHUB_OWNER_REQUIRED', 'owner',
      'owner is required',
      { fixHint: 'Pass options.owner (e.g. "my-org").' },
    );
  }
  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    throw new AdapterError(
      'GITHUB_REPO_REQUIRED', 'repo',
      'repo is required',
      { fixHint: 'Pass options.repo (e.g. "my-project").' },
    );
  }

  // ── Dependency-injection path (tests) ─────────────────────────
  if (typeof fetchFn === 'function') {
    return fetchFn({ owner, repo, state, labels, limit });
  }

  // ── Real path: call `gh api` via spawnSync ────────────────────
  const args = ['api', `repos/${owner}/${repo}/issues`, '--paginate'];

  if (state) {
    args.push('-f', `state=${state}`);
  }
  if (labels) {
    args.push('-f', `labels=${labels}`);
  }
  if (limit) {
    args.push('-f', `per_page=${limit}`);
  }

  const result = spawnSync('gh', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new AdapterError(
        'GITHUB_CLI_NOT_FOUND', 'gh',
        'gh command not found — install GitHub CLI',
        { fixHint: 'Install the GitHub CLI: https://cli.github.com/', cause: result.error },
      );
    }
    throw new AdapterError(
      'GITHUB_API_FAILED', 'gh',
      `gh spawn error: ${result.error.message}`,
      { fixHint: 'Check that gh is installed and authenticated.', cause: result.error },
    );
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new AdapterError(
      'GITHUB_API_FAILED', 'gh',
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
      'GITHUB_API_FAILED', 'gh',
      `Failed to parse gh output as JSON: ${e.message}`,
      { fixHint: 'Unexpected response from gh api — check your query.', cause: e },
    );
  }
}

/**
 * Classify a single issue as bug / feature / question / other.
 * Uses keyword matching on title + body (no LLM for v1).
 */
function classifyIssue(issue) {
  if (!issue || typeof issue !== 'object') {
    return { type: 'other', confidence: 0 };
  }

  const text = `${issue.title || ''} ${issue.body || ''}`;
  const bugHits = countKeywordHits(text, BUG_KEYWORDS);
  const featureHits = countKeywordHits(text, FEATURE_KEYWORDS);
  const questionHits = countKeywordHits(text, QUESTION_KEYWORDS);

  const maxHits = Math.max(bugHits, featureHits, questionHits);
  if (maxHits === 0) {
    return { type: 'other', confidence: 0 };
  }

  // Normalise confidence: hits / total-keywords-in-category, capped at 1.
  let type;
  let pool;
  if (bugHits >= featureHits && bugHits >= questionHits) {
    type = 'bug';
    pool = BUG_KEYWORDS.length;
  } else if (featureHits >= questionHits) {
    type = 'feature';
    pool = FEATURE_KEYWORDS.length;
  } else {
    type = 'question';
    pool = QUESTION_KEYWORDS.length;
  }

  const confidence = Math.min(1, maxHits / pool);
  return { type, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * Group related issues by shared title keywords.
 * Returns array of { issues: [...], commonTheme, type }.
 */
function groupRelatedIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return [];

  // Build a keyword-to-issues index.
  const keywordIndex = new Map();
  for (const issue of issues) {
    const words = extractWords(issue.title || '');
    const unique = [...new Set(words)];
    for (const word of unique) {
      if (!keywordIndex.has(word)) keywordIndex.set(word, []);
      keywordIndex.get(word).push(issue);
    }
  }

  // Find keywords shared by >= 2 issues, sorted by cluster size desc.
  const clusters = [];
  const assigned = new Set();

  const sorted = [...keywordIndex.entries()]
    .filter(([, items]) => items.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [keyword, items] of sorted) {
    // Only include issues not yet assigned to a larger cluster.
    const unassigned = items.filter((i) => !assigned.has(i));
    if (unassigned.length < 2) continue;

    for (const i of unassigned) assigned.add(i);

    // Majority classification decides group type.
    const typeCounts = { bug: 0, feature: 0, question: 0, other: 0 };
    for (const i of unassigned) {
      const { type } = classifyIssue(i);
      typeCounts[type] += 1;
    }
    const groupType = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])[0][0];

    clusters.push({
      issues: unassigned,
      commonTheme: keyword,
      type: groupType,
    });
  }

  // Remaining un-grouped issues go into singleton groups.
  for (const issue of issues) {
    if (!assigned.has(issue)) {
      const { type } = classifyIssue(issue);
      clusters.push({
        issues: [issue],
        commonTheme: (issue.title || 'untitled').toLowerCase().slice(0, 40),
        type,
      });
    }
  }

  return clusters;
}

/**
 * Score a group for directive priority.
 * Factors: total thumbs-up reactions, issue count, type severity.
 */
function scoreGroup(group) {
  if (!group || typeof group !== 'object' || !Array.isArray(group.issues)) {
    return { score: 0, priority: 'low' };
  }

  const typeSeverity = { bug: 3, feature: 2, question: 1, other: 1 };
  const severity = typeSeverity[group.type] || 1;

  let totalReactions = 0;
  for (const issue of group.issues) {
    const reactions = issue.reactions || {};
    totalReactions += Number(reactions['+1']) || 0;
  }

  const issueCount = group.issues.length;
  const score = severity * Math.log1p(totalReactions) * Math.log1p(issueCount);

  let priority;
  if (score >= 8) priority = 'critical';
  else if (score >= 4) priority = 'high';
  else if (score >= 1) priority = 'medium';
  else priority = 'low';

  return { score: Math.round(score * 1000) / 1000, priority };
}

/**
 * Orchestrator: fetch -> classify -> group -> score -> write YAML directives.
 *
 * options: { owner, repo, outputDir, minThumbsUp, minIssues, cwd, fetchFn, dryRun }
 */
function generateIssueDirectives(options = {}) {
  const { owner, repo, outputDir, minThumbsUp, minIssues, cwd, fetchFn, dryRun } = options;

  if (!owner || typeof owner !== 'string' || !owner.trim()) {
    throw new AdapterError(
      'GITHUB_OWNER_REQUIRED', 'owner',
      'owner is required',
      { fixHint: 'Pass options.owner (e.g. "my-org").' },
    );
  }
  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    throw new AdapterError(
      'GITHUB_REPO_REQUIRED', 'repo',
      'repo is required',
      { fixHint: 'Pass options.repo (e.g. "my-project").' },
    );
  }
  if (!outputDir || typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new AdapterError(
      'GITHUB_OUTPUT_DIR_REQUIRED', 'outputDir',
      'outputDir is required',
      { fixHint: 'Pass options.outputDir for directive YAML output.' },
    );
  }

  // 1. Fetch
  const issues = fetchGitHubIssues({ owner, repo, state: 'open', cwd, fetchFn });

  // 2. Classify each issue (attach classification).
  const classified = issues.map((issue) => ({
    ...issue,
    _classification: classifyIssue(issue),
  }));

  // 3. Group
  const groups = groupRelatedIssues(classified);

  // 4. Score + filter
  const resolvedOutput = path.resolve(outputDir);
  if (!dryRun) {
    fs.mkdirSync(resolvedOutput, { recursive: true });
  }

  const minUp = Number(minThumbsUp) || 0;
  const minCount = Number(minIssues) || 1;

  const generated = [];
  const skipped = [];

  for (const group of groups) {
    const { score, priority } = scoreGroup(group);

    let totalThumbsUp = 0;
    for (const issue of group.issues) {
      const reactions = issue.reactions || {};
      totalThumbsUp += Number(reactions['+1']) || 0;
    }

    if (group.issues.length < minCount || totalThumbsUp < minUp) {
      skipped.push({
        commonTheme: group.commonTheme,
        type: group.type,
        issueCount: group.issues.length,
        totalThumbsUp,
        score,
        priority,
        reason: group.issues.length < minCount
          ? `issueCount ${group.issues.length} < minIssues ${minCount}`
          : `totalThumbsUp ${totalThumbsUp} < minThumbsUp ${minUp}`,
      });
      continue;
    }

    const directive = {
      kind: 'github-issue-directive',
      type: group.type,
      commonTheme: group.commonTheme,
      issueCount: group.issues.length,
      totalThumbsUp,
      score,
      priority,
      issues: group.issues.map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url || i.url || null,
        type: (i._classification || classifyIssue(i)).type,
      })),
      generatedAt: new Date().toISOString(),
    };

    const slug = group.commonTheme.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const fileName = `gh-directive-${slug || 'untitled'}.yaml`;
    const filePath = path.join(resolvedOutput, fileName);

    if (!dryRun) {
      writeYamlFile(filePath, directive);
    }

    generated.push(filePath);
  }

  return { generated, skipped };
}

module.exports = {
  fetchGitHubIssues,
  classifyIssue,
  groupRelatedIssues,
  generateIssueDirectives,
  // internals exposed for testing
  scoreGroup,
  countKeywordHits,
  extractWords,
};
