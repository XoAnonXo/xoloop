'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');

const GOAL_SCHEMA_VERSION = 0.1;

function parseGoalText(text, absolutePath) {
  try {
    return JSON.parse(text);
  } catch (_jsonErr) {
    try {
      // Optional compatibility with hand-written YAML manifests when the
      // plugin environment provides the yaml package. Generated manifests are
      // JSON-compatible YAML so the kernel has no hard runtime dependency.
      // eslint-disable-next-line global-require
      return require('yaml').parse(text);
    } catch (yamlErr) {
      throw new AdapterError(
        'GOAL_MANIFEST_PARSE_FAILED',
        'goalPath',
        `Failed to parse goal manifest as JSON-compatible YAML: ${absolutePath}`,
        { fixHint: yamlErr.message },
      );
    }
  }
}

function readGoalFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  const document = parseGoalText(text, absolutePath);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new AdapterError('GOAL_MANIFEST_NOT_OBJECT', 'goalPath', `Goal manifest must be an object: ${absolutePath}`);
  }
  return { absolutePath, text, document };
}

function writeGoalFile(filePath, payload) {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return absolutePath;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalizeVersion(version) {
  if (version === GOAL_SCHEMA_VERSION || version === String(GOAL_SCHEMA_VERSION)) return GOAL_SCHEMA_VERSION;
  throw new AdapterError(
    'GOAL_SCHEMA_UNSUPPORTED',
    'version',
    `Unsupported goal manifest version: ${version}`,
    { fixHint: `Set version to ${GOAL_SCHEMA_VERSION}.` },
  );
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      fieldName,
      `${fieldName} must be a non-empty string`,
      { fixHint: `Set ${fieldName} to a non-empty string.` },
    );
  }
  return value.trim();
}

function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      fieldName,
      `${fieldName} must be an array`,
      { fixHint: `Set ${fieldName} to an array of strings.` },
    );
  }
  return value.map((item, index) => requireString(item, `${fieldName}[${index}]`));
}

function normalizeCommandExpectation(value, fieldName) {
  if (value === undefined) return [];
  return normalizeStringArray(value, fieldName);
}

function normalizeCommandSuite(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'verify.commands',
      'verify.commands must be a non-empty array for command-suite goals',
      { fixHint: 'Add commands like { id: "syntax", command: "node -c file.cjs" }.' },
    );
  }
  return commands.map((command, index) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new AdapterError('GOAL_SCHEMA_INVALID', `verify.commands[${index}]`, 'command check must be an object');
    }
    return {
      id: requireString(command.id, `verify.commands[${index}].id`),
      command: requireString(command.command, `verify.commands[${index}].command`),
      expect_exit_code: Number.isInteger(command.expect_exit_code) ? command.expect_exit_code : 0,
      expect_stdout_includes: normalizeCommandExpectation(command.expect_stdout_includes, `verify.commands[${index}].expect_stdout_includes`),
      expect_stderr_includes: normalizeCommandExpectation(command.expect_stderr_includes, `verify.commands[${index}].expect_stderr_includes`),
      timeout_ms: Number.isFinite(command.timeout_ms) && command.timeout_ms > 0 ? Math.floor(command.timeout_ms) : 10000,
    };
  });
}

function normalizeGoalDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'document',
      'Goal manifest must be a YAML mapping',
      { fixHint: 'Rewrite the goal manifest so its top level is a key/value mapping.' },
    );
  }

  const goalId = requireString(document.goal_id, 'goal_id');
  const iface = document.interface;
  if (!iface || typeof iface !== 'object' || Array.isArray(iface)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'interface',
      'interface must be an object',
      { fixHint: 'Add interface: { type: cli, command: "...", stdin: json, stdout: text }.' },
    );
  }
  const verify = document.verify;
  if (!verify || typeof verify !== 'object' || Array.isArray(verify)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'verify',
      'verify must be an object',
      { fixHint: 'Add verify.golden_cases and verification properties.' },
    );
  }
  const metrics = document.metrics && typeof document.metrics === 'object' && !Array.isArray(document.metrics)
    ? document.metrics
    : {};
  const acceptance = document.acceptance && typeof document.acceptance === 'object' && !Array.isArray(document.acceptance)
    ? document.acceptance
    : {};
  const artifacts = document.artifacts && typeof document.artifacts === 'object' && !Array.isArray(document.artifacts)
    ? document.artifacts
    : {};

  const verifyKind = typeof verify.kind === 'string' ? verify.kind.trim() : 'json-canonicalizer';
  const normalizedVerify = verifyKind === 'command-suite'
    ? {
        kind: verifyKind,
        commands: normalizeCommandSuite(verify.commands),
      }
    : {
        kind: verifyKind,
        golden_cases: requireString(verify.golden_cases, 'verify.golden_cases'),
        benchmark_cases: typeof verify.benchmark_cases === 'string' ? verify.benchmark_cases.trim() : '',
        fuzz: verify.fuzz && typeof verify.fuzz === 'object' && !Array.isArray(verify.fuzz)
          ? {
              generator: typeof verify.fuzz.generator === 'string' ? verify.fuzz.generator.trim() : 'json-subset',
              seed: Number.isFinite(verify.fuzz.seed) ? Math.floor(verify.fuzz.seed) : 12345,
              runs: Number.isFinite(verify.fuzz.runs) && verify.fuzz.runs >= 0 ? Math.floor(verify.fuzz.runs) : 0,
            }
          : { generator: 'json-subset', seed: 12345, runs: 0 },
        properties: Array.isArray(verify.properties) ? normalizeStringArray(verify.properties, 'verify.properties') : [],
      };

  const normalized = {
    version: normalizeVersion(document.version),
    goal_id: goalId,
    objective: typeof document.objective === 'string' ? document.objective.trim() : '',
    interface: {
      type: requireString(iface.type, 'interface.type'),
      command: requireString(iface.command, 'interface.command'),
      stdin: typeof iface.stdin === 'string' ? iface.stdin.trim() : 'text',
      stdout: typeof iface.stdout === 'string' ? iface.stdout.trim() : 'text',
      timeout_ms: Number.isFinite(iface.timeout_ms) && iface.timeout_ms > 0 ? Math.floor(iface.timeout_ms) : 10000,
    },
    artifacts: {
      paths: Array.isArray(artifacts.paths) ? normalizeStringArray(artifacts.paths, 'artifacts.paths') : [],
    },
    verify: {
      ...normalizedVerify,
    },
    metrics: {
      repeat: Number.isFinite(metrics.repeat) && metrics.repeat > 0 ? Math.floor(metrics.repeat) : 1,
      targets: Array.isArray(metrics.targets) ? metrics.targets.map((target, index) => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
          throw new AdapterError('GOAL_SCHEMA_INVALID', `metrics.targets[${index}]`, 'metric target must be an object');
        }
        return {
          name: requireString(target.name, `metrics.targets[${index}].name`),
          direction: target.direction === 'maximize' ? 'maximize' : 'minimize',
          threshold: Number.isFinite(target.threshold) && target.threshold >= 0 ? target.threshold : 0,
        };
      }) : [],
    },
    acceptance: {
      require_all_verifications: acceptance.require_all_verifications !== false,
      max_metric_regression: Number.isFinite(acceptance.max_metric_regression) && acceptance.max_metric_regression >= 0
        ? acceptance.max_metric_regression
        : 0,
      accept_if_any_target_improves: acceptance.accept_if_any_target_improves !== false,
    },
  };

  if (!['cli', 'command-suite'].includes(normalized.interface.type)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'interface.type',
      `Unsupported interface type: ${normalized.interface.type}`,
      { fixHint: 'v0 supports interface.type: cli or command-suite.' },
    );
  }
  if (!['json-canonicalizer', 'command-suite'].includes(normalized.verify.kind)) {
    throw new AdapterError(
      'GOAL_SCHEMA_INVALID',
      'verify.kind',
      `Unsupported verify kind: ${normalized.verify.kind}`,
      { fixHint: 'v0 supports verify.kind: json-canonicalizer or command-suite.' },
    );
  }

  return normalized;
}

function manifestHash(goal) {
  return `sha256:${sha256Hex(stableStringify(goal))}`;
}

function artifactHash(goal, cwd) {
  const repoRoot = path.resolve(cwd || process.cwd());
  const paths = Array.isArray(goal.artifacts && goal.artifacts.paths) ? goal.artifacts.paths.slice().sort() : [];
  const entries = [];
  for (const rel of paths) {
    const absolute = path.resolve(repoRoot, rel);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch (_err) {
      entries.push({ path: rel, missing: true });
      continue;
    }
    if (!stat.isFile()) {
      entries.push({ path: rel, non_file: true });
      continue;
    }
    const buffer = fs.readFileSync(absolute);
    entries.push({
      path: rel,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
    });
  }
  return `sha256:${sha256Hex(stableStringify(entries))}`;
}

function goalBaseDir(goalPath) {
  return path.dirname(path.resolve(goalPath));
}

function evidencePathForGoal(goalPath) {
  return path.join(goalBaseDir(goalPath), 'evidence.jsonl');
}

function expandSimpleJsonGlob(goalPath, pattern, cwd) {
  const rawPattern = requireString(pattern, 'glob');
  const baseDir = goalBaseDir(goalPath);
  const repoRoot = path.resolve(cwd || process.cwd());
  let absolutePattern = path.isAbsolute(rawPattern) ? rawPattern : path.resolve(baseDir, rawPattern);
  if (!fs.existsSync(absolutePattern.replace(/\*\.json$/, '')) && !path.isAbsolute(rawPattern)) {
    absolutePattern = path.resolve(repoRoot, rawPattern);
  }
  if (!absolutePattern.endsWith('*.json')) {
    const filePath = absolutePattern;
    return fs.existsSync(filePath) ? [filePath] : [];
  }
  const dir = absolutePattern.slice(0, -'*.json'.length);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

function loadGoalManifest(goalPath) {
  const read = readGoalFile(goalPath);
  const goal = normalizeGoalDocument(read.document);
  return {
    goalPath: read.absolutePath,
    goal,
    manifest_hash: manifestHash(goal),
  };
}

function writeGoalManifest(goalPath, goal) {
  const normalized = normalizeGoalDocument(goal);
  fs.mkdirSync(path.dirname(path.resolve(goalPath)), { recursive: true });
  writeGoalFile(goalPath, normalized);
  return {
    goalPath: path.resolve(goalPath),
    goal: normalized,
    manifest_hash: manifestHash(normalized),
  };
}

module.exports = {
  GOAL_SCHEMA_VERSION,
  artifactHash,
  evidencePathForGoal,
  expandSimpleJsonGlob,
  goalBaseDir,
  loadGoalManifest,
  manifestHash,
  normalizeGoalDocument,
  stableStringify,
  writeGoalManifest,
};
