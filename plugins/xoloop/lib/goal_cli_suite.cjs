'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob, goalBaseDir } = require('./goal_manifest.cjs');
const { scanCliRepo } = require('./goal_cli_scan.cjs');

const DEFAULT_CLI_OBLIGATIONS = [
  'case_present',
  'surface_coverage',
  'exit_code',
  'stdout_contract',
  'stderr_contract',
  'filesystem_effects',
  'deterministic',
  'generated_cases',
  'performance_budget',
];

function sanitizeId(id) {
  return String(id || 'case').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableCopy);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableCopy(value[key]);
  return out;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function loadCaseFile(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`cli-suite case must be an object: ${filePath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
    throw new Error(`cli-suite case must contain string id: ${filePath}`);
  }
  return {
    ...parsed,
    id: parsed.id.trim(),
    args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
    stdin: parsed.stdin == null ? '' : String(parsed.stdin),
    env: parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env) ? parsed.env : {},
    expected_exit_code: Number.isInteger(parsed.expected_exit_code) ? parsed.expected_exit_code : 0,
    expected_stdout: typeof parsed.expected_stdout === 'string' ? parsed.expected_stdout : null,
    expected_stderr: typeof parsed.expected_stderr === 'string' ? parsed.expected_stderr : null,
    expect_stdout_includes: Array.isArray(parsed.expect_stdout_includes) ? parsed.expect_stdout_includes.map(String) : [],
    expect_stderr_includes: Array.isArray(parsed.expect_stderr_includes) ? parsed.expect_stderr_includes.map(String) : [],
    expected_files: Array.isArray(parsed.expected_files) ? parsed.expected_files : [],
    allow_writes: Array.isArray(parsed.allow_writes) ? parsed.allow_writes.map(String) : [],
    performance_budgets: parsed.performance_budgets && typeof parsed.performance_budgets === 'object' && !Array.isArray(parsed.performance_budgets)
      ? parsed.performance_budgets
      : {},
    repeat: Number.isFinite(parsed.repeat) && parsed.repeat > 0 ? Math.floor(parsed.repeat) : null,
  };
}

function copyPath(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'target', 'dist', 'build'].includes(entry.name)) continue;
      copyPath(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, stat.mode);
  } catch (_err) {
    // Best effort; permissions are verified through behavior, not chmod metadata.
  }
}

function writeCaseFiles(workspace, files) {
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) continue;
    const rel = typeof file.path === 'string' ? file.path : file.target;
    if (typeof rel !== 'string' || rel.includes('..')) continue;
    const dest = path.resolve(workspace, rel);
    if (typeof file.content === 'string') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.content, 'utf8');
    } else if (typeof file.source === 'string') {
      copyPath(path.resolve(file.source), dest);
    }
  }
}

function prepareWorkspace(goal, cwd, testCase) {
  if (testCase.isolated === false) return { workspace: cwd, cleanup: () => {} };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `xoloop-cli-${sanitizeId(testCase.id)}-`));
  for (const rel of goal.artifacts.paths || []) {
    const src = path.resolve(cwd, rel);
    const dest = path.resolve(workspace, rel);
    copyPath(src, dest);
  }
  writeCaseFiles(workspace, testCase.files);
  return {
    workspace,
    cleanup: () => {
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
    },
  };
}

function snapshotTree(root) {
  const out = {};
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const buffer = fs.readFileSync(absolute);
        out[rel] = { sha256: sha256(buffer), bytes: buffer.length };
      }
    }
  }
  walk(root);
  return out;
}

function diffSnapshots(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  for (const rel of Object.keys(after).sort()) {
    if (!before[rel]) created.push(rel);
    else if (before[rel].sha256 !== after[rel].sha256) modified.push(rel);
  }
  for (const rel of Object.keys(before).sort()) {
    if (!after[rel]) deleted.push(rel);
  }
  return { created, modified, deleted };
}

function matchesPattern(rel, pattern) {
  if (pattern === rel) return true;
  if (pattern.endsWith('/**')) return rel.startsWith(pattern.slice(0, -3));
  if (pattern.endsWith('*')) return rel.startsWith(pattern.slice(0, -1));
  return false;
}

function isAllowedWrite(rel, allowWrites, expectedFiles) {
  const allowed = [...allowWrites, ...expectedFiles.map((file) => file.path).filter(Boolean)];
  return allowed.some((pattern) => matchesPattern(rel, pattern));
}

function buildCommand(goal, testCase) {
  const base = testCase.command || goal.verify.command || goal.interface.command;
  if (!testCase.args || testCase.args.length === 0) return base;
  return `${base} ${testCase.args.map(shellQuote).join(' ')}`;
}

function goalDir(goalPath) {
  return goalBaseDir(goalPath);
}

function artifactPath(goalPath, dirName, testCase, suffix = '.json') {
  return path.join(goalDir(goalPath), dirName, `${sanitizeId(testCase.id)}${suffix}`);
}

function writeCaseTrace(goalPath, testCase, execution, extra = {}) {
  writeJson(artifactPath(goalPath, 'traces', testCase), {
    case: testCase,
    command: extra.command,
    exit_code: execution.result.exitCode,
    stdout_tail: String(execution.result.stdout || '').slice(-4000),
    stderr_tail: String(execution.result.stderr || '').slice(-4000),
    metrics: execution.result.metrics,
    fs_diff: execution.fsDiff,
    ...extra,
  });
}

function writeActual(goalPath, testCase, execution) {
  writeJson(artifactPath(goalPath, 'actual', testCase), {
    exit_code: execution.result.exitCode,
    stdout: execution.result.stdout,
    stderr: execution.result.stderr,
    fs_diff: execution.fsDiff,
    metrics: execution.result.metrics,
  });
}

async function executeCase(goal, cwd, testCase) {
  const prepared = prepareWorkspace(goal, cwd, testCase);
  const before = snapshotTree(prepared.workspace);
  const result = await runCliCommand(buildCommand(goal, testCase), testCase.stdin, {
    cwd: prepared.workspace,
    env: testCase.env,
    timeoutMs: testCase.timeout_ms || goal.interface.timeout_ms,
    maxBuffer: testCase.max_buffer || 32 * 1024 * 1024,
  });
  const after = snapshotTree(prepared.workspace);
  return {
    result,
    workspace: prepared.workspace,
    cleanup: prepared.cleanup,
    fsDiff: diffSnapshots(before, after),
    after,
  };
}

function addPass(state, id, testCase, extra = {}) {
  state.verifications.push({ id, status: 'pass', case_id: testCase.id, ...extra });
}

function addGap(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'gap', case_id: testCase.id, message, ...extra });
}

function addFailure(state, id, testCase, message, result, extra = {}) {
  state.verifications.push({ id, status: 'fail', case_id: testCase.id, message, ...extra });
  if (!state.counterexample) {
    state.counterexample = {
      case_id: testCase.id,
      obligation: id,
      message,
      command: buildCommand(extra.goal || { verify: {}, interface: {} }, testCase),
      exit_code: result && result.exitCode,
      stdout_tail: result ? String(result.stdout || '').slice(-2000) : '',
      stderr_tail: result ? String(result.stderr || '').slice(-2000) : '',
      ...extra,
    };
    delete state.counterexample.goal;
  }
}

function writeDiff(goalPath, testCase, obligation, payload) {
  const filePath = artifactPath(goalPath, 'diffs', testCase, `-${sanitizeId(obligation)}.json`);
  writeJson(filePath, payload);
  return filePath;
}

function includesAll(text, needles) {
  return needles.every((needle) => String(text).includes(needle));
}

function regexMatches(text, pattern) {
  try {
    return new RegExp(pattern).test(String(text));
  } catch (_err) {
    return false;
  }
}

function parseJsonMaybe(text) {
  try {
    return { ok: true, value: JSON.parse(String(text || '')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function schemaMatches(value, schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return true;
  if (schema.type && schema.type !== typeof value && !(schema.type === 'array' && Array.isArray(value))) return false;
  if (schema.required && Array.isArray(schema.required)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
    }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && !schemaMatches(value[key], child)) return false;
    }
  }
  return true;
}

function checkOutputContracts(state, goal, goalPath, testCase, result) {
  const stdoutChecks = [];
  if (testCase.expected_stdout !== null) stdoutChecks.push(String(result.stdout) === testCase.expected_stdout);
  if (testCase.expect_stdout_includes.length > 0) stdoutChecks.push(includesAll(result.stdout, testCase.expect_stdout_includes));
  if (typeof testCase.stdout_regex === 'string') stdoutChecks.push(regexMatches(result.stdout, testCase.stdout_regex));
  if (testCase.stdout_json || testCase.stdout_json_schema || (goal.verify.properties || []).includes('stdout_json')) {
    const parsed = parseJsonMaybe(result.stdout);
    stdoutChecks.push(parsed.ok);
    if (parsed.ok && testCase.stdout_json_schema) stdoutChecks.push(schemaMatches(parsed.value, testCase.stdout_json_schema));
  }
  if (stdoutChecks.length === 0) addGap(state, 'stdout_contract', testCase, 'no stdout oracle declared');
  else if (stdoutChecks.every(Boolean)) addPass(state, 'stdout_contract', testCase);
  else {
    const diff_path = writeDiff(goalPath, testCase, 'stdout_contract', {
      expected_stdout: testCase.expected_stdout,
      expect_stdout_includes: testCase.expect_stdout_includes,
      stdout_regex: testCase.stdout_regex,
      stdout_json_schema: testCase.stdout_json_schema,
      actual_stdout: result.stdout,
    });
    addFailure(state, 'stdout_contract', testCase, 'stdout contract failed', result, { diff_path, goal });
  }

  const stderrChecks = [];
  if (testCase.expected_stderr !== null) stderrChecks.push(String(result.stderr) === testCase.expected_stderr);
  if (testCase.expect_stderr_includes.length > 0) stderrChecks.push(includesAll(result.stderr, testCase.expect_stderr_includes));
  if (typeof testCase.stderr_regex === 'string') stderrChecks.push(regexMatches(result.stderr, testCase.stderr_regex));
  if ((goal.verify.properties || []).includes('no_unexpected_stderr') || testCase.no_stderr) stderrChecks.push(String(result.stderr || '') === '');
  if ((goal.verify.properties || []).includes('no_stacktrace') || testCase.no_stacktrace) stderrChecks.push(!/(Traceback|panic:|Exception|UnhandledPromiseRejection|stack trace)/i.test(String(result.stderr || '')));
  if (stderrChecks.length === 0) addGap(state, 'stderr_contract', testCase, 'no stderr oracle declared');
  else if (stderrChecks.every(Boolean)) addPass(state, 'stderr_contract', testCase);
  else {
    const diff_path = writeDiff(goalPath, testCase, 'stderr_contract', {
      expected_stderr: testCase.expected_stderr,
      expect_stderr_includes: testCase.expect_stderr_includes,
      stderr_regex: testCase.stderr_regex,
      actual_stderr: result.stderr,
    });
    addFailure(state, 'stderr_contract', testCase, 'stderr contract failed', result, { diff_path, goal });
  }
}

function checkExpectedFiles(state, testCase, execution) {
  const failures = [];
  for (const file of testCase.expected_files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string') continue;
    const meta = execution.after[file.path];
    if (!meta) {
      failures.push({ path: file.path, message: 'missing expected file' });
      continue;
    }
    const absolute = path.resolve(execution.workspace, file.path);
    const text = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
    if (typeof file.content === 'string' && text !== file.content) failures.push({ path: file.path, message: 'content mismatch' });
    if (typeof file.includes === 'string' && !text.includes(file.includes)) failures.push({ path: file.path, message: 'include mismatch' });
    if (typeof file.sha256 === 'string' && meta.sha256 !== file.sha256) failures.push({ path: file.path, message: 'sha256 mismatch' });
  }
  const unexpected = [
    ...execution.fsDiff.created,
    ...execution.fsDiff.modified,
    ...execution.fsDiff.deleted,
  ].filter((rel) => !isAllowedWrite(rel, testCase.allow_writes, testCase.expected_files));
  if (failures.length > 0 || (testCase.forbid_writes_outside !== false && unexpected.length > 0)) {
    return { pass: false, failures, unexpected, fsDiff: execution.fsDiff };
  }
  return { pass: true, fsDiff: execution.fsDiff };
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function aggregateMetrics(samples) {
  const byName = {};
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value)) continue;
      if (!byName[key]) byName[key] = [];
      byName[key].push(value);
    }
  }
  const out = {};
  for (const [key, values] of Object.entries(byName)) {
    const sorted = values.sort((a, b) => a - b);
    out[key] = sorted[Math.floor(sorted.length / 2)];
    out[`${key}_p95`] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
  return out;
}

function checkPerformance(state, testCase, samples, result) {
  const budgets = testCase.performance_budgets || {};
  const failures = [];
  for (const [name, budget] of Object.entries(budgets)) {
    const value = median(samples.map((sample) => sample[name]));
    if (!Number.isFinite(value)) {
      failures.push({ name, message: 'metric missing' });
      continue;
    }
    const max = Number.isFinite(budget) ? budget : (budget && Number.isFinite(budget.lte) ? budget.lte : null);
    if (Number.isFinite(max) && value > max) failures.push({ name, value, lte: max });
  }
  if (Object.keys(budgets).length === 0) addGap(state, 'performance_budget', testCase, 'no performance budget declared');
  else if (failures.length === 0) addPass(state, 'performance_budget', testCase);
  else addFailure(state, 'performance_budget', testCase, 'performance budget failed', result, { failures });
}

async function verifyOneCase(goal, goalPath, cwd, testCase) {
  const state = { verifications: [], counterexample: null, metrics: [] };
  addPass(state, 'case_present', testCase);
  const repeat = testCase.repeat || goal.metrics.repeat || 1;
  const executions = [];
  try {
    for (let i = 0; i < repeat; i += 1) {
      executions.push(await executeCase(goal, cwd, testCase));
      state.metrics.push(executions[i].result.metrics);
    }
    const first = executions[0];
    const result = first.result;
    writeActual(goalPath, testCase, first);
    writeCaseTrace(goalPath, testCase, first, { command: buildCommand(goal, testCase) });
    if (result.exitCode === testCase.expected_exit_code) addPass(state, 'exit_code', testCase, { exit_code: result.exitCode });
    else addFailure(state, 'exit_code', testCase, `expected exit ${testCase.expected_exit_code}, got ${result.exitCode}`, result, { goal });
    checkOutputContracts(state, goal, goalPath, testCase, result);

    const fsCheck = checkExpectedFiles(state, testCase, first);
    if (fsCheck.pass) addPass(state, 'filesystem_effects', testCase, { fs_diff: fsCheck.fsDiff });
    else {
      const diff_path = writeDiff(goalPath, testCase, 'filesystem_effects', fsCheck);
      addFailure(state, 'filesystem_effects', testCase, 'filesystem side effects changed or escaped allowed paths', result, { ...fsCheck, diff_path, goal });
    }

    if ((goal.verify.properties || []).includes('deterministic') || testCase.deterministic) {
      const second = await executeCase(goal, cwd, testCase);
      executions.push(second);
      state.metrics.push(second.result.metrics);
      const same = second.result.exitCode === result.exitCode &&
        String(second.result.stdout) === String(result.stdout) &&
        String(second.result.stderr) === String(result.stderr) &&
        JSON.stringify(second.fsDiff) === JSON.stringify(first.fsDiff);
      if (same) addPass(state, 'deterministic', testCase);
      else addFailure(state, 'deterministic', testCase, 'same CLI case produced different observable output or filesystem effects', second.result, { goal });
    }

    if ((goal.verify.properties || []).includes('differential_reference') || testCase.reference_command || goal.verify.reference_command) {
      const referenceCase = {
        ...testCase,
        command: testCase.reference_command || goal.verify.reference_command,
      };
      if (!referenceCase.command) {
        addGap(state, 'differential_reference', testCase, 'reference command missing');
      } else {
        const reference = await executeCase(goal, cwd, referenceCase);
        executions.push(reference);
        const same = reference.result.exitCode === result.exitCode &&
          String(reference.result.stdout) === String(result.stdout) &&
          String(reference.result.stderr) === String(result.stderr) &&
          JSON.stringify(reference.fsDiff) === JSON.stringify(first.fsDiff);
        if (same) addPass(state, 'differential_reference', testCase);
        else addFailure(state, 'differential_reference', testCase, 'CLI behavior differed from reference command', result, {
          reference_exit_code: reference.result.exitCode,
          reference_stdout_tail: String(reference.result.stdout || '').slice(-2000),
          reference_stderr_tail: String(reference.result.stderr || '').slice(-2000),
          goal,
        });
      }
    }

    checkPerformance(state, testCase, state.metrics, result);
  } finally {
    for (const execution of executions) {
      if (testCase.keep_workspace !== true && execution && typeof execution.cleanup === 'function') execution.cleanup();
    }
  }
  return state;
}

function makePrng(seed) {
  let x = (Number(seed) >>> 0) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length) % values.length];
}

function randomText(random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_- \n\t{}[],:."';
  const length = Math.floor(random() * 80);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

function generatedCasesFromSeed(baseCase, fuzz) {
  const runs = Number.isFinite(fuzz && fuzz.runs) && fuzz.runs > 0 ? Math.floor(fuzz.runs) : 0;
  if (runs <= 0) return [];
  const random = makePrng(fuzz.seed || 12345);
  const argPool = Array.isArray(fuzz.arg_values) && fuzz.arg_values.length > 0 ? fuzz.arg_values.map(String) : [];
  const envPool = fuzz.env && typeof fuzz.env === 'object' && !Array.isArray(fuzz.env) ? fuzz.env : {};
  const out = [];
  for (let i = 0; i < runs; i += 1) {
    const generated = stableCopy(baseCase);
    generated.id = `${baseCase.id}-gen-${i}`;
    generated.generated_from = baseCase.id;
    generated.repeat = 1;
    if ((fuzz.mutate || []).includes('stdin') || fuzz.generator === 'stdin-text') generated.stdin = randomText(random);
    if (Array.isArray(fuzz.stdin_values) && fuzz.stdin_values.length > 0) generated.stdin = String(pick(random, fuzz.stdin_values));
    if ((fuzz.mutate || []).includes('args') && argPool.length > 0) {
      const count = Math.floor(random() * Math.min(4, argPool.length + 1));
      generated.args = Array.from({ length: count }, () => pick(random, argPool));
    }
    if ((fuzz.mutate || []).includes('env')) {
      generated.env = { ...(generated.env || {}) };
      for (const [key, values] of Object.entries(envPool)) {
        const choices = Array.isArray(values) ? values.map(String) : [String(values)];
        generated.env[key] = pick(random, choices);
      }
    }
    if (fuzz.property === 'no_crash') {
      delete generated.expected_stdout;
      delete generated.expected_stderr;
      generated.expect_stdout_includes = [];
      generated.expect_stderr_includes = [];
      generated.expected_files = [];
      generated.allow_writes = generated.allow_writes || [];
      generated.performance_budgets = generated.performance_budgets || {};
    }
    out.push(generated);
  }
  return out;
}

function buildGeneratedCases(goal, cases) {
  const fuzz = goal.verify.fuzz || {};
  if (!Number.isFinite(fuzz.runs) || fuzz.runs <= 0) return [];
  const baseCases = cases.filter((testCase) => testCase.fuzz !== false);
  const selected = baseCases.length > 0 ? baseCases : cases;
  const generated = [];
  for (const baseCase of selected) generated.push(...generatedCasesFromSeed(baseCase, fuzz));
  return generated.slice(0, Math.max(0, Math.floor(fuzz.runs)));
}

function writeCorpusCase(goalPath, testCase, counterexample) {
  const filePath = artifactPath(goalPath, 'corpus', testCase);
  writeJson(filePath, {
    case: testCase,
    counterexample,
  });
  return filePath;
}

function surfaceCoverage(goal, cases) {
  const discovered = ((goal.verify.scan && goal.verify.scan.commands) || []).map((command) => command.id).sort();
  if (discovered.length === 0) return { status: 'pass', message: 'no scanned commands declared' };
  const covered = new Set(cases.map((testCase) => testCase.command_id).filter(Boolean));
  const missing = discovered.filter((id) => !covered.has(id));
  if (missing.length === 0) return { status: 'pass', discovered, missing };
  return { status: 'gap', discovered, missing, message: 'not all discovered CLI commands have cases' };
}

async function runCliSuiteVerification(goal, goalPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const caseFiles = expandSimpleJsonGlob(goalPath, goal.verify.cases, cwd);
  const cases = caseFiles.map(loadCaseFile);
  const generatedCases = options.caseId ? [] : buildGeneratedCases(goal, cases);
  const allCases = [...cases, ...generatedCases];
  const selectedCases = options.caseId ? allCases.filter((testCase) => testCase.id === options.caseId) : allCases;
  if (selectedCases.length === 0) {
    return {
      status: 'fail',
      verifications: [{ id: 'case_selection', status: 'fail', message: `No cases matched ${options.caseId || goal.verify.cases}` }],
      metrics: {},
      counterexample: { obligation: 'case_selection', message: `No cases matched ${options.caseId || goal.verify.cases}` },
    };
  }
  const verifications = [];
  const metrics = [];
  let counterexample = null;
  const coverage = surfaceCoverage(goal, cases);
  verifications.push({ id: 'surface_coverage', status: coverage.status, message: coverage.message, missing: coverage.missing || [] });
  if (generatedCases.length > 0) verifications.push({ id: 'generated_cases', status: 'pass', generated: generatedCases.length });
  else if (Number.isFinite(goal.verify.fuzz && goal.verify.fuzz.runs) && goal.verify.fuzz.runs > 0) verifications.push({ id: 'generated_cases', status: 'gap', message: 'fuzz configured but no generated cases were produced' });
  else if ((goal.verify.properties || []).includes('generated_cases')) verifications.push({ id: 'generated_cases', status: 'gap', message: 'no generated CLI cases configured' });
  for (const testCase of selectedCases) {
    const result = await verifyOneCase(goal, goalPath, cwd, testCase);
    verifications.push(...result.verifications);
    metrics.push(...result.metrics);
    if (result.counterexample && !counterexample) {
      counterexample = result.counterexample;
      if (testCase.generated_from) counterexample.corpus_path = writeCorpusCase(goalPath, testCase, counterexample);
    }
  }
  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: aggregateMetrics(metrics),
    counterexample,
  };
}

function writeCliSuiteAssets(goalDir, options = {}) {
  for (const dir of ['cases', 'fixtures', 'expected', 'actual', 'diffs', 'traces', 'corpus']) {
    fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  }
  writeJson(path.join(goalDir, 'cases', 'help.json'), {
    id: 'help',
    command_id: 'manual',
    command: options.target || 'node ./cli.js',
    args: ['--help'],
    stdin: '',
    expected_exit_code: 0,
    expect_stdout_includes: [],
    expected_stderr: '',
    allow_writes: [],
    performance_budgets: {
      wall_time_ms: { lte: 2000 },
    },
  });
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# CLI verification goal',
    '',
    'Generated by `xoloop-verify create --kind cli-suite`.',
    '',
    'Each case may declare command, args, stdin, env, fixtures, output',
    'contracts, expected files, allowed writes, reference commands, and',
    'performance budgets. Cases run in isolated workspaces by default.',
    '',
  ].join('\n'), 'utf8');
}

function buildCliSuiteGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'cli-suite';
  const scan = options.scan || scanCliRepo(cwd);
  const target = options.target || (scan.commands[0] && scan.commands[0].command) || 'node ./cli.js';
  const artifacts = scan.artifact_paths.length > 0 ? scan.artifact_paths : [];
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve CLI behavior across args, stdin, env, files, exit codes, side effects, and performance while optimizing.',
    interface: {
      type: 'cli',
      command: target,
      stdin: 'text',
      stdout: 'text',
      timeout_ms: 10000,
    },
    artifacts: {
      paths: artifacts,
    },
    verify: {
      kind: 'cli-suite',
      command: target,
      cases: 'cases/*.json',
      reference_command: '',
      properties: DEFAULT_CLI_OBLIGATIONS,
      scan,
      isolation: 'copy-artifacts',
      block_on_gaps: true,
      fuzz: {
        generator: 'stdin-text',
        seed: 12345,
        runs: 0,
        mutate: ['stdin'],
        property: 'no_crash',
      },
    },
    metrics: {
      repeat: 3,
      targets: [
        { name: 'wall_time_ms', direction: 'minimize', threshold: 0.03 },
        { name: 'peak_memory_mb', direction: 'minimize', threshold: 0.03 },
        { name: 'complexity_score', direction: 'minimize', threshold: 0.05 },
      ],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0.02,
      accept_if_any_target_improves: true,
    },
  };
}

module.exports = {
  DEFAULT_CLI_OBLIGATIONS,
  buildCliSuiteGoal,
  runCliSuiteVerification,
  scanCliRepo,
  writeCliSuiteAssets,
};
