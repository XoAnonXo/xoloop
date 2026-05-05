'use strict';

const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');

function sampleProcessTreeRssMb(pid) {
  try {
    const tree = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (tree.status !== 0) {
      const single = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const kb = parseInt(String(single.stdout || '').trim(), 10);
      return Number.isFinite(kb) && kb > 0 ? kb / 1024 : 0;
    }
    const rows = String(tree.stdout || '').split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map((value) => parseInt(value, 10)))
      .filter((row) => row.length === 3 && row.every(Number.isFinite))
      .map(([childPid, parentPid, rssKb]) => ({ pid: childPid, ppid: parentPid, rssKb }));
    const childrenByParent = new Map();
    for (const row of rows) {
      if (!childrenByParent.has(row.ppid)) childrenByParent.set(row.ppid, []);
      childrenByParent.get(row.ppid).push(row.pid);
    }
    const wanted = new Set([pid]);
    const stack = [pid];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const child of childrenByParent.get(current) || []) {
        if (wanted.has(child)) continue;
        wanted.add(child);
        stack.push(child);
      }
    }
    const kb = rows.filter((row) => wanted.has(row.pid)).reduce((sum, row) => sum + Math.max(0, row.rssKb), 0);
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : 0;
  } catch (_err) {
    return 0;
  }
}

function runCliCommand(command, input, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const maxBuffer = Number.isFinite(options.maxBuffer) && options.maxBuffer > 0 ? options.maxBuffer : 10 * 1024 * 1024;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let peakMemoryMb = 0;

    const childEnv = { ...process.env, ...(options.env || {}) };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_CHANNEL_FD;

    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const sampler = setInterval(() => {
      peakMemoryMb = Math.max(peakMemoryMb, sampleProcessTreeRssMb(child.pid));
    }, 20);

    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_err) { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > maxBuffer) {
        stdout = stdout.slice(0, maxBuffer);
        try { child.kill('SIGKILL'); } catch (_err) { /* already gone */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > maxBuffer) {
        stderr = stderr.slice(0, maxBuffer);
        try { child.kill('SIGKILL'); } catch (_err) { /* already gone */ }
      }
    });
    child.on('error', (err) => {
      clearInterval(sampler);
      clearTimeout(timeout);
      resolve({
        exitCode: 127,
        signal: null,
        stdout,
        stderr: stderr || err.message,
        timedOut,
        metrics: {
          wall_time_ms: Date.now() - startedAt,
          peak_memory_mb: peakMemoryMb,
        },
      });
    });
    child.on('close', (code, signal) => {
      clearInterval(sampler);
      clearTimeout(timeout);
      peakMemoryMb = Math.max(peakMemoryMb, sampleProcessTreeRssMb(child.pid));
      resolve({
        exitCode: typeof code === 'number' ? code : (timedOut ? 124 : 1),
        signal,
        stdout,
        stderr,
        timedOut,
        metrics: {
          wall_time_ms: Date.now() - startedAt,
          peak_memory_mb: peakMemoryMb,
        },
      });
    });

    child.stdin.end(String(input == null ? '' : input), 'utf8');
  });
}

module.exports = {
  runCliCommand,
};
