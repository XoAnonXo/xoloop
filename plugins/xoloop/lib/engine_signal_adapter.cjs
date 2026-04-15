'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readJsonIfExists, ensureDir } = require('./baton_common.cjs');
const { writeYamlFile } = require('./overnight_yaml.cjs');
const { AdapterError } = require('./errors.cjs');

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Map a reason code prefix to a 1-5 severity level.
 * Unknown codes default to 3 (moderate).
 */
function classifySeverity(reasonCode) {
  const code = String(reasonCode || '').toUpperCase();
  if (code.startsWith('FATAL') || code.startsWith('CRASH') || code.startsWith('DATA_LOSS')) {
    return 5;
  }
  if (code.startsWith('AUTH') || code.startsWith('SECURITY') || code.startsWith('CORRUPT')) {
    return 4;
  }
  if (code.startsWith('TIMEOUT') || code.startsWith('VALIDATION') || code.startsWith('LIMIT')) {
    return 3;
  }
  if (code.startsWith('DEPRECAT') || code.startsWith('COMPAT')) {
    return 2;
  }
  if (code.startsWith('STYLE') || code.startsWith('LINT') || code.startsWith('FORMAT')) {
    return 1;
  }
  return 3;
}

/**
 * Compute a percentile from a sorted array.
 * Uses linear interpolation for fractional indices.
 */
function computePercentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const fraction = rank - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

// ── Exported API ────────────────────────────────────────────────────

/**
 * Walk batchDir/surfaces/<surface>/attempts/<attempt>/report.json.
 * Return array of parsed reports. Skip corrupt files gracefully.
 */
function scanBatchReports(batchDir) {
  if (!batchDir || typeof batchDir !== 'string' || !batchDir.trim()) {
    throw new AdapterError(
      'SIGNAL_BATCH_DIR_REQUIRED',
      'batchDir',
      'batchDir is required',
      { fixHint: 'Pass a non-empty string path to scanBatchReports.' },
    );
  }
  const resolved = path.resolve(batchDir);
  if (!fs.existsSync(resolved)) {
    throw new AdapterError(
      'SIGNAL_BATCH_DIR_NOT_FOUND',
      'batchDir',
      `Batch directory not found: ${resolved}`,
      { fixHint: 'Ensure the batch directory exists before scanning.' },
    );
  }
  const surfacesDir = path.join(resolved, 'surfaces');
  if (!fs.existsSync(surfacesDir)) {
    return [];
  }

  const reports = [];
  let surfaceEntries;
  try {
    surfaceEntries = fs.readdirSync(surfacesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const surfaceEntry of surfaceEntries) {
    if (!surfaceEntry.isDirectory()) continue;
    const attemptsDir = path.join(surfacesDir, surfaceEntry.name, 'attempts');
    if (!fs.existsSync(attemptsDir)) continue;

    let attemptEntries;
    try {
      attemptEntries = fs.readdirSync(attemptsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const attemptEntry of attemptEntries) {
      if (!attemptEntry.isDirectory()) continue;
      const reportPath = path.join(attemptsDir, attemptEntry.name, 'report.json');
      const data = readJsonIfExists(reportPath, null);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        data._surface = surfaceEntry.name;
        data._attempt = attemptEntry.name;
        data._reportPath = reportPath;
        reports.push(data);
      }
    }
  }

  return reports;
}

/**
 * Group reports by reasonCode, count frequency, track affected surfaces.
 * Return array of { errorCode, frequency, affectedSurfaces, sampleMessages, confidence }.
 */
function aggregateErrors(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return [];

  const buckets = new Map();

  for (const report of reports) {
    if (!report || typeof report !== 'object') continue; // skip corrupt/null entries
    const errors = Array.isArray(report.errors) ? report.errors : [];
    for (const err of errors) {
      if (!err || typeof err !== 'object') continue; // skip corrupt error entries
      const code = String(err.reasonCode || err.code || 'UNKNOWN');
      if (!buckets.has(code)) {
        buckets.set(code, {
          errorCode: code,
          frequency: 0,
          affectedSurfaces: new Set(),
          sampleMessages: [],
        });
      }
      const bucket = buckets.get(code);
      bucket.frequency += 1;
      if (report._surface) {
        bucket.affectedSurfaces.add(report._surface);
      }
      const msg = String(err.message || err.detail || '');
      if (msg && bucket.sampleMessages.length < 5) {
        bucket.sampleMessages.push(msg);
      }
    }
  }

  const totalReports = reports.length;
  const result = [];
  for (const bucket of buckets.values()) {
    result.push({
      errorCode: bucket.errorCode,
      frequency: bucket.frequency,
      affectedSurfaces: [...bucket.affectedSurfaces],
      sampleMessages: bucket.sampleMessages,
      confidence: Math.min(1, bucket.frequency / Math.max(1, totalReports)),
    });
  }

  return result.sort((a, b) => b.frequency - a.frequency);
}

/**
 * Compute p50/p95/p99 from timing data, detect trends.
 * Return { function, p50_ms, p95_ms, p99_ms, trend, confidence }.
 */
function aggregateLatency(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    return { function: 'unknown', p50_ms: 0, p95_ms: 0, p99_ms: 0, trend: 'stable', confidence: 0 };
  }

  const durations = [];
  const timestamps = [];

  for (const report of reports) {
    if (!report || typeof report !== 'object') continue; // skip corrupt/null entries
    const timing = report.timing || report.duration || {};
    let ms;
    if (typeof timing === 'number') {
      ms = timing;
    } else if (timing && typeof timing === 'object') {
      ms = timing.duration_ms ?? timing.elapsed_ms ?? timing.ms ?? null;
    }
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
      durations.push(ms);
      const ts = report.timestamp || report.created_at || report.ts || null;
      if (ts) timestamps.push({ ts: new Date(ts).getTime(), ms });
    }
  }

  if (durations.length === 0) {
    return { function: 'unknown', p50_ms: 0, p95_ms: 0, p99_ms: 0, trend: 'stable', confidence: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = computePercentile(sorted, 50);
  const p95 = computePercentile(sorted, 95);
  const p99 = computePercentile(sorted, 99);

  // Trend detection: compare first half vs second half medians
  let trend = 'stable';
  if (sorted.length >= 4) {
    const half = Math.floor(sorted.length / 2);
    timestamps.sort((a, b) => a.ts - b.ts);
    if (timestamps.length >= 4) {
      const firstHalf = timestamps.slice(0, half).map((t) => t.ms);
      const secondHalf = timestamps.slice(half).map((t) => t.ms);
      const firstMedian = computePercentile([...firstHalf].sort((a, b) => a - b), 50);
      const secondMedian = computePercentile([...secondHalf].sort((a, b) => a - b), 50);
      const delta = secondMedian - firstMedian;
      const threshold = firstMedian * 0.15;
      if (delta > threshold) trend = 'increasing';
      else if (delta < -threshold) trend = 'decreasing';
    }
  }

  const fnName = reports[0]._surface || reports[0].function || 'unknown';
  const confidence = Math.min(1, durations.length / 100);

  return {
    function: fnName,
    p50_ms: Math.round(p50 * 100) / 100,
    p95_ms: Math.round(p95 * 100) / 100,
    p99_ms: Math.round(p99 * 100) / 100,
    trend,
    confidence,
  };
}

/**
 * priority = severity * burn_rate * log1p(affected) * confidence.
 * Return { score, priority }.
 */
function scoreDirective(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { score: 0, priority: 'low' };
  }
  const severity = Number(evidence.severity) || classifySeverity(evidence.errorCode);
  const burnRate = evidence.burn_rate != null ? Number(evidence.burn_rate)
    : evidence.burnRate != null ? Number(evidence.burnRate)
    : Number(evidence.frequency) || 0;
  const affected = evidence.affected != null ? Number(evidence.affected)
    : Number((evidence.affectedSurfaces && evidence.affectedSurfaces.length)) || 0;
  const confidence = Number(evidence.confidence) || 0;

  const score = severity * burnRate * Math.log1p(affected) * confidence;
  let priority;
  if (score >= 10) priority = 'critical';
  else if (score >= 5) priority = 'high';
  else if (score >= 1) priority = 'medium';
  else priority = 'low';

  return { score: Math.round(score * 1000) / 1000, priority };
}

/**
 * Minimum sample (>100), minimum days (>3), confidence (>0.70).
 * Return { eligible, reasons }.
 */
function checkEligibility(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { eligible: false, reasons: ['evidence is required'] };
  }
  const reasons = [];

  const sampleSize = evidence.sampleSize != null ? Number(evidence.sampleSize)
    : Number(evidence.frequency) || 0;
  if (sampleSize <= 100) {
    reasons.push(`sample size ${sampleSize} <= 100`);
  }

  const days = evidence.days != null ? Number(evidence.days)
    : Number(evidence.observationDays) || 0;
  if (days <= 3) {
    reasons.push(`observation days ${days} <= 3`);
  }

  const confidence = Number(evidence.confidence) || 0;
  if (confidence <= 0.70) {
    reasons.push(`confidence ${confidence} <= 0.70`);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

/**
 * Orchestrator: scan -> aggregate -> score -> filter -> write YAML.
 * Return { generated: string[], skipped: [] }.
 */
function generateDirectives(batchDir, outputDir, options = {}) {
  if (!batchDir || typeof batchDir !== 'string' || !batchDir.trim()) {
    throw new AdapterError(
      'SIGNAL_BATCH_DIR_REQUIRED',
      'batchDir',
      'batchDir is required',
      { fixHint: 'Pass a non-empty string path to generateDirectives.' },
    );
  }
  if (!outputDir || typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new AdapterError(
      'SIGNAL_OUTPUT_DIR_REQUIRED',
      'outputDir',
      'outputDir is required',
      { fixHint: 'Pass a non-empty string path to generateDirectives.' },
    );
  }

  const reports = scanBatchReports(batchDir);
  const errorAggregations = aggregateErrors(reports);
  const latency = aggregateLatency(reports);

  const generated = [];
  const skipped = [];

  const resolvedOutput = path.resolve(outputDir);
  ensureDir(resolvedOutput);

  const minScore = Number(options.minScore) || 0;
  const dryRun = options.dryRun === true;

  for (const agg of errorAggregations) {
    const evidence = {
      errorCode: agg.errorCode,
      severity: classifySeverity(agg.errorCode),
      frequency: agg.frequency,
      burn_rate: agg.frequency,
      affected: agg.affectedSurfaces.length,
      affectedSurfaces: agg.affectedSurfaces,
      confidence: agg.confidence,
      sampleSize: agg.frequency,
      days: Number(options.observationDays) || 1,
      sampleMessages: agg.sampleMessages,
    };

    const { score, priority } = scoreDirective(evidence);
    const { eligible, reasons } = checkEligibility(evidence);

    if (!eligible || score < minScore) {
      skipped.push({
        errorCode: agg.errorCode,
        score,
        priority,
        reasons: eligible ? [`score ${score} < minScore ${minScore}`] : reasons,
      });
      continue;
    }

    // Map internal priority string to directive_loader P-level enum
    const priorityMap = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };
    const pLevel = priorityMap[priority] || 'P3';

    // Map severity to directive type: sev 4-5 → bug, sev 2-3 → performance, sev 1 → feature
    const sev = evidence.severity;
    let directiveType, action;
    if (sev >= 4) { directiveType = 'bug'; action = 'polish'; }
    else if (sev >= 2) { directiveType = 'performance'; action = 'improve'; }
    else { directiveType = 'feature'; action = 'build'; }

    // Build the evidence block matching directive_loader's type-specific schema
    let typedEvidence;
    if (directiveType === 'bug') {
      typedEvidence = {
        error_message: (agg.sampleMessages[0] || agg.errorCode),
        stack_trace: '',
        repro_steps: [`Trigger ${agg.errorCode} (observed ${agg.frequency} times across ${agg.affectedSurfaces.length} surface(s))`],
        affected_versions: [],
      };
    } else if (directiveType === 'performance') {
      typedEvidence = {
        metric: 'p95_latency_ms',
        current_value: latency.p95_ms,
        target_value: Math.round(latency.p95_ms * 0.5 * 100) / 100,
        unit: 'ms',
        measurement_tool: 'engine_signal_adapter',
      };
    } else {
      typedEvidence = {
        user_request: (agg.sampleMessages[0] || agg.errorCode),
        use_case: `Address ${agg.errorCode} across ${agg.affectedSurfaces.length} surface(s)`,
        acceptance_criteria: [`Resolve ${agg.errorCode}`],
      };
    }

    const directive = {
      directive: directiveType,
      version: 1,
      source: 'engine_signal_adapter',
      generated: new Date().toISOString(),
      evidence: typedEvidence,
      action,
      target_surface: agg.affectedSurfaces[0] || 'unknown',
      priority: pLevel,
      reason: `${agg.errorCode} observed ${agg.frequency} time(s) across ${agg.affectedSurfaces.length} surface(s) — severity ${sev}, score ${score}`,
    };

    const baseSlug = `directive-${agg.errorCode.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    let fileName = `${baseSlug}.yaml`;
    let filePath = path.join(resolvedOutput, fileName);
    // Deduplicate: if a prior error code mapped to the same slug, append a counter
    // so we don't silently overwrite the first directive with the second.
    let collision = 1;
    while (generated.includes(filePath)) {
      collision += 1;
      fileName = `${baseSlug}-${collision}.yaml`;
      filePath = path.join(resolvedOutput, fileName);
    }

    if (!dryRun) {
      writeYamlFile(filePath, directive);
    }

    generated.push(filePath);
  }

  return { generated, skipped };
}

module.exports = {
  scanBatchReports,
  aggregateErrors,
  aggregateLatency,
  scoreDirective,
  checkEligibility,
  generateDirectives,
  // internals exposed for testing
  classifySeverity,
  computePercentile,
};
