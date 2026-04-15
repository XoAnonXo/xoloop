'use strict';

const { AdapterError } = require('./errors.cjs');

/**
 * Create a meter snapshot capturing the current time, CPU usage, and memory.
 *
 * @returns {{ startTime: number, startCpu: [number, number], startMemory: number }}
 */
function createMeter() {
  const cpuUsage = process.cpuUsage();
  return {
    startTime: Date.now(),
    startCpu: [cpuUsage.user, cpuUsage.system],
    startMemory: process.memoryUsage().rss,
  };
}

/**
 * Record metrics by computing deltas from the meter snapshot.
 *
 * @param {{ startTime: number, startCpu: [number, number], startMemory: number }} meter
 * @returns {{ wallTimeMs: number, cpuTimeMs: number, peakMemoryMb: number }}
 */
function recordMetrics(meter) {
  if (meter == null || typeof meter !== 'object' || Array.isArray(meter)) {
    throw new AdapterError(
      'METER_REQUIRED',
      'meter',
      'meter must be a non-null object returned by createMeter()',
      { fixHint: 'Call createMeter() before calling recordMetrics().' },
    );
  }
  if (
    !Array.isArray(meter.startCpu) ||
    meter.startCpu.length !== 2 ||
    !Number.isFinite(meter.startCpu[0]) ||
    !Number.isFinite(meter.startCpu[1])
  ) {
    throw new AdapterError(
      'METER_INVALID',
      'meter.startCpu',
      'meter.startCpu must be a two-element finite-number array returned by createMeter()',
      { fixHint: 'Call createMeter() before calling recordMetrics(); do not construct the meter object manually.' },
    );
  }
  if (typeof meter.startTime !== 'number' || !Number.isFinite(meter.startTime)) {
    throw new AdapterError(
      'METER_INVALID',
      'meter.startTime',
      'meter.startTime must be a finite number returned by createMeter()',
      { fixHint: 'Call createMeter() before calling recordMetrics(); do not construct the meter object manually.' },
    );
  }
  if (typeof meter.startMemory !== 'number' || !Number.isFinite(meter.startMemory)) {
    throw new AdapterError(
      'METER_INVALID',
      'meter.startMemory',
      'meter.startMemory must be a finite number returned by createMeter()',
      { fixHint: 'Call createMeter() before calling recordMetrics(); do not construct the meter object manually.' },
    );
  }
  const now = Date.now();
  const cpuUsage = process.cpuUsage();

  const wallTimeMs = now - meter.startTime;

  // CPU time delta in microseconds, convert to milliseconds
  const cpuUserDelta = cpuUsage.user - meter.startCpu[0];
  const cpuSystemDelta = cpuUsage.system - meter.startCpu[1];
  const cpuTimeMs = (cpuUserDelta + cpuSystemDelta) / 1000;

  // Peak memory in MB
  const currentMemory = process.memoryUsage().rss;
  const peakMemoryMb = Math.max(currentMemory, meter.startMemory) / (1024 * 1024);

  return {
    wallTimeMs,
    cpuTimeMs,
    peakMemoryMb,
  };
}

/**
 * Check whether recorded metrics fall within the specified bounds.
 *
 * @param {{ wallTimeMs: number, cpuTimeMs: number, peakMemoryMb: number }} metrics
 * @param {{ wall_time_ms?: number, cpu_time_ms?: number, memory_mb?: number }} bounds
 * @returns {{ verdict: 'PASS'|'BENCHMARK_VIOLATION', violations: string[] }}
 */
function checkBounds(metrics, bounds) {
  if (metrics == null || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new AdapterError(
      'METRICS_REQUIRED',
      'metrics',
      'metrics must be a non-null object returned by recordMetrics()',
      { fixHint: 'Call recordMetrics(meter) before calling checkBounds().' },
    );
  }
  if (bounds == null || typeof bounds !== 'object' || Array.isArray(bounds)) {
    throw new AdapterError(
      'BOUNDS_REQUIRED',
      'bounds',
      'bounds must be a non-null object',
      { fixHint: 'Pass a bounds object with optional wall_time_ms, cpu_time_ms, memory_mb keys.' },
    );
  }
  if (
    typeof metrics.wallTimeMs !== 'number' || !Number.isFinite(metrics.wallTimeMs) ||
    typeof metrics.cpuTimeMs !== 'number' || !Number.isFinite(metrics.cpuTimeMs) ||
    typeof metrics.peakMemoryMb !== 'number' || !Number.isFinite(metrics.peakMemoryMb)
  ) {
    throw new AdapterError(
      'METRICS_INVALID',
      'metrics',
      'metrics.wallTimeMs, metrics.cpuTimeMs, and metrics.peakMemoryMb must all be finite numbers',
      { fixHint: 'Call recordMetrics(meter) to produce valid metrics; do not construct the metrics object manually with non-numeric values.' },
    );
  }
  // Validate that non-null bound values are finite numbers.  Without this,
  // a NaN or non-numeric bound silently passes every comparison (NaN > x is
  // always false) — the same class of silent false-PASS that the METRICS_INVALID
  // guard above prevents for metric values.
  const boundKeys = ['wall_time_ms', 'cpu_time_ms', 'memory_mb'];
  for (const key of boundKeys) {
    if (bounds[key] != null && (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]) || bounds[key] < 0)) {
      throw new AdapterError(
        'BOUNDS_INVALID',
        `bounds.${key}`,
        `bounds.${key} must be a non-negative finite number or null/undefined, received ${typeof bounds[key] === 'number' ? String(bounds[key]) : typeof bounds[key]}`,
        { fixHint: `Set bounds.${key} to a non-negative finite number (the upper limit) or omit it / set it to null to skip that bound.` },
      );
    }
  }

  const violations = [];

  if (bounds.wall_time_ms != null && metrics.wallTimeMs > bounds.wall_time_ms) {
    violations.push(
      `wallTimeMs ${metrics.wallTimeMs.toFixed(2)} exceeds bound ${bounds.wall_time_ms}`,
    );
  }

  if (bounds.cpu_time_ms != null && metrics.cpuTimeMs > bounds.cpu_time_ms) {
    violations.push(
      `cpuTimeMs ${metrics.cpuTimeMs.toFixed(2)} exceeds bound ${bounds.cpu_time_ms}`,
    );
  }

  if (bounds.memory_mb != null && metrics.peakMemoryMb > bounds.memory_mb) {
    violations.push(
      `peakMemoryMb ${metrics.peakMemoryMb.toFixed(2)} exceeds bound ${bounds.memory_mb}`,
    );
  }

  if (violations.length === 0) {
    return { verdict: 'PASS', violations: [] };
  }

  return { verdict: 'BENCHMARK_VIOLATION', violations };
}

module.exports = {
  createMeter,
  recordMetrics,
  checkBounds,
};
