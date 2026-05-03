const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  createFingerprint,
  normalizeText,
  resolveRepoPath,
} = require('./baton_common.cjs');
const { readYamlFile, writeYamlFile } = require('./overnight_yaml.cjs');
const { DEFAULT_WINDOW_LINE_CAP, normalizeProposalMode } = require('./overnight_staged.cjs');

const DEFAULT_REPORT_DIR = 'proving-ground/reports/overnight';
const DEFAULT_BRANCH_PREFIX = 'codex/overnight';
const DEFAULT_ATTEMPT_LIMIT = 1;
const DEFAULT_REPAIR_TURNS = 1;

function normalizeStagedDefaults(value = {}) {
  const document = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    maxSourceFiles: Math.max(1, Number(document.max_source_files || document.maxSourceFiles) || 1),
    maxTestFiles: Math.max(1, Number(document.max_test_files || document.maxTestFiles) || 1),
    maxCodeBlocks: Math.max(1, Number(document.max_code_blocks || document.maxCodeBlocks) || 1),
    maxTestBlocks: Math.max(1, Number(document.max_test_blocks || document.maxTestBlocks) || 1),
    windowLineCap: Math.max(20, Number(document.window_line_cap || document.windowLineCap) || DEFAULT_WINDOW_LINE_CAP),
  };
}

function normalizeStringList(value, fieldName, options = {}) {
  const required = options.required === true;
  const list = Array.isArray(value)
    ? value.map((entry) => normalizeText(entry)).filter(Boolean)
    : [];
  if (required && list.length === 0) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('ADAPTER_LIST_REQUIRED', fieldName, `${fieldName} must contain at least one entry`, { fixHint: `Add at least one non-empty string entry to ${fieldName} in overnight.yaml.` });
  }
  return list;
}

function normalizeRisk(value, fieldName) {
  const risk = normalizeText(value).toLowerCase() || 'guarded';
  if (!['safe', 'guarded', 'manual'].includes(risk)) {
    const { AdapterError } = require('./errors.cjs');
    const observed = normalizeText(value) || '(empty)';
    throw new AdapterError('SURFACE_RISK_INVALID', fieldName, `${fieldName} must be one of safe, guarded, or manual`, { fixHint: `Set ${fieldName} to one of: safe, guarded, manual. Got: ${observed}` });
  }
  return risk;
}

// Audit round-4 P1#1: accept BOTH legacy string commands (run via bash -lc)
// and structured argv-form `{argv: [cmd, ...args]}` entries.  The argv path
// is safer because spawnSync never interprets metacharacters specially.
//
// When options.disallowShell === true (surfaced from the adapter-level
// disallow_shell_validation flag), plain-string entries are rejected at load
// time with ADAPTER_SHELL_VALIDATION_DISALLOWED — callers who opt in are
// promised the engine will never spawn a shell for their validation plan.
function normalizeCommandList(value, fieldName, options = {}) {
  const disallowShell = options.disallowShell === true;
  const required = options.required === true;
  const list = Array.isArray(value) ? value : [];
  const out = [];
  list.forEach((entry, index) => {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed) return;
      if (disallowShell) {
        const { AdapterError } = require('./errors.cjs');
        throw new AdapterError(
          'ADAPTER_SHELL_VALIDATION_DISALLOWED',
          `${fieldName}[${index}]`,
          `${fieldName}[${index}] is a shell string but disallow_shell_validation is true`,
          { fixHint: `Convert ${fieldName}[${index}] to {argv: [cmd, ...args]} form or set disallow_shell_validation: false.` }
        );
      }
      out.push(trimmed);
      return;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.argv)) {
      const argv = entry.argv.map((token) => (typeof token === 'string' ? token : String(token || '')).trim()).filter(Boolean);
      if (argv.length === 0) {
        const { AdapterError } = require('./errors.cjs');
        throw new AdapterError(
          'ADAPTER_COMMAND_ARGV_EMPTY',
          `${fieldName}[${index}].argv`,
          `${fieldName}[${index}].argv must contain at least one non-empty string`,
          { fixHint: `Populate ${fieldName}[${index}].argv with the command and its arguments as separate strings.` }
        );
      }
      out.push({ argv });
      return;
    }
    // Silently skip null/undefined entries to preserve the previous filter(Boolean) semantics.
  });
  if (required && out.length === 0) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('ADAPTER_LIST_REQUIRED', fieldName, `${fieldName} must contain at least one entry`, { fixHint: `Add at least one non-empty string entry or {argv: [...]} object to ${fieldName} in overnight.yaml.` });
  }
  return out;
}

function safeStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects without a proper toString (e.g. Object.create(null)) would throw — return ''
  try { return String(value); } catch (_) { return ''; }
}

function globToRegex(pattern) {
  const escaped = safeStr(pattern)
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesPathPattern(filePath, pattern) {
  const normalizedPath = safeStr(filePath).split(path.sep).join('/');
  const normalizedPattern = safeStr(pattern).split(path.sep).join('/');
  if (!normalizedPattern) {
    return false;
  }
  if (!normalizedPattern.includes('*')) {
    return normalizedPath === normalizedPattern;
  }
  return globToRegex(normalizedPattern).test(normalizedPath);
}

function normalizeModelConfig(value = {}, fallbackProvider) {
  const document = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    provider: normalizeText(document.provider) || fallbackProvider,
    model: normalizeText(document.model),
    apiKeyEnv: normalizeText(document.api_key_env || document.apiKeyEnv),
    baseUrl: normalizeText(document.base_url || document.baseUrl),
    timeoutMs: Number.isFinite(Number(document.timeout_ms ?? document.timeoutMs))
      ? Math.max(1000, Number(document.timeout_ms ?? document.timeoutMs))
      : null,
    temperature: document.temperature != null && document.temperature !== ''
        && Number.isFinite(Number(document.temperature))
      ? Number(document.temperature)
      : null,
  };
}

function normalizeSurface(document, repoRoot, index, normalizerOptions = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('SURFACE_NOT_OBJECT', `surfaces[${index}]`, `surfaces[${index}] must be an object`, { fixHint: `Replace the non-object value at surfaces[${index}] in overnight.yaml with a plain object containing at least id, paths, test_paths, and invariants fields.` });
  }
  const id = normalizeText(document.id);
  if (!id) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('SURFACE_ID_REQUIRED', `surfaces[${index}].id`, `surfaces[${index}].id is required`, { fixHint: `Add a non-empty string id field to surfaces[${index}] in overnight.yaml. Each surface must have a unique, non-empty id that the engine and objective.yaml use to reference it.` });
  }
  const paths = normalizeStringList(document.paths, `surfaces[${index}].paths`, { required: true });
  const testPaths = normalizeStringList(document.test_paths || document.testPaths, `surfaces[${index}].test_paths`, { required: true });
  const invariants = normalizeStringList(document.invariants, `surfaces[${index}].invariants`, { required: true });
  const forbiddenPaths = normalizeStringList(document.forbidden_paths || document.forbiddenPaths, `surfaces[${index}].forbidden_paths`);
  const contextPatterns = normalizeStringList(document.context_patterns || document.contextPatterns, `surfaces[${index}].context_patterns`);
  const allowedDependencies = normalizeStringList(document.allowed_dependencies || document.allowedDependencies, `surfaces[${index}].allowed_dependencies`);
  const requiredTestKinds = normalizeStringList(document.required_test_kinds || document.requiredTestKinds, `surfaces[${index}].required_test_kinds`);
  const conflictsWith = normalizeStringList(document.conflicts_with || document.conflictsWith, `surfaces[${index}].conflicts_with`);
  const languageHints = normalizeStringList(document.language_hints || document.languageHints, `surfaces[${index}].language_hints`);
  const formattingHints = normalizeStringList(document.formatting_hints || document.formattingHints, `surfaces[${index}].formatting_hints`);
  const disallowShell = normalizerOptions.disallowShell === true;
  const quickValidation = normalizeCommandList(document.quick_validation || document.quickValidation, `surfaces[${index}].quick_validation`, { disallowShell });
  const fullValidation = normalizeCommandList(document.full_validation || document.fullValidation, `surfaces[${index}].full_validation`, { disallowShell });

  for (const filePath of paths.concat(testPaths).concat(forbiddenPaths).concat(contextPatterns)) {
    if (filePath.includes('*')) {
      continue;
    }
    resolveRepoPath(repoRoot, filePath);
  }

  const risk = normalizeRisk(document.risk, `surfaces[${index}].risk`);

  return {
    id,
    title: normalizeText(document.title) || id,
    description: normalizeText(document.description),
    paths,
    testPaths,
    invariants,
    risk,
    requiredTestKinds,
    conflictsWith,
    languageHints,
    formattingHints,
    contextPatterns,
    allowedDependencies,
    forbiddenPaths,
    quickValidation,
    fullValidation,
    fingerprint: createFingerprint({
      id,
      paths,
      testPaths,
      invariants,
      risk,
    }),
  };
}

function normalizeAdapterDocument(document, options = {}) {
  const safeDoc = document && typeof document === 'object' && !Array.isArray(document) ? document : {};
  const repoRoot = path.resolve((options && options.repoRoot) || process.cwd());
  const repo = safeDoc.repo && typeof safeDoc.repo === 'object' && !Array.isArray(safeDoc.repo) ? safeDoc.repo : {};
  const defaults = safeDoc.defaults && typeof safeDoc.defaults === 'object' && !Array.isArray(safeDoc.defaults) ? safeDoc.defaults : {};
  const surfaces = Array.isArray(safeDoc.surfaces) ? safeDoc.surfaces : [];
  if (surfaces.length === 0) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('SURFACES_EMPTY', 'surfaces', 'surfaces must contain at least one surface', { fixHint: 'Declare at least one surface under the top-level surfaces: list in overnight.yaml. Each surface needs an id, paths, test_paths, and invariants.' });
  }

  // Audit round-4 P1#1: adapter-level disallow_shell_validation flag.  When
  // set, every validation entry MUST be an argv-form object — any string entry
  // throws ADAPTER_SHELL_VALIDATION_DISALLOWED at adapter-load time, long
  // before the engine is ready to spawn anything.  Back-compat default: false.
  const disallowShell = safeDoc.disallow_shell_validation === true
    || safeDoc.disallowShellValidation === true;

  const normalizedSurfaces = surfaces.map((surface, index) => normalizeSurface(surface, repoRoot, index, { disallowShell }));
  const ids = new Set();
  normalizedSurfaces.forEach((surface) => {
    if (ids.has(surface.id)) {
      const { AdapterError } = require('./errors.cjs');
      throw new AdapterError('SURFACE_ID_DUPLICATE', `surfaces.${surface.id}`, `surface id must be unique: ${surface.id}`, { fixHint: `Remove or rename one of the duplicate surfaces with id "${surface.id}" in overnight.yaml. Each surface must have a unique id.` });
    }
    ids.add(surface.id);
  });

  return {
    schemaVersion: normalizeText(safeDoc.schema_version || safeDoc.schemaVersion) || '1.0.0',
    repoRoot,
    disallowShellValidation: disallowShell,
    repo: {
      name: normalizeText(repo.name) || path.basename(repoRoot),
      setup: normalizeText(repo.setup),
      baselineValidation: normalizeCommandList(repo.baseline_validation || repo.baselineValidation, 'repo.baseline_validation', { required: true, disallowShell }),
      finalValidation: normalizeCommandList(repo.final_validation || repo.finalValidation, 'repo.final_validation', { required: true, disallowShell }),
    },
    surfaces: normalizedSurfaces,
    manualOnlyPaths: normalizeStringList(safeDoc.manual_only_paths || safeDoc.manualOnlyPaths, 'manual_only_paths'),
    sharedPaths: normalizeStringList(safeDoc.shared_paths || safeDoc.sharedPaths, 'shared_paths'),
    defaults: {
      reportDir: normalizeText(defaults.report_dir || defaults.reportDir) || DEFAULT_REPORT_DIR,
      branchPrefix: normalizeText(defaults.branch_prefix || defaults.branchPrefix) || DEFAULT_BRANCH_PREFIX,
      attemptLimit: Math.max(1, Number.isFinite(Number(defaults.attempt_limit ?? defaults.attemptLimit)) ? Number(defaults.attempt_limit ?? defaults.attemptLimit) : DEFAULT_ATTEMPT_LIMIT),
      repairTurns: Math.max(0, Number.isFinite(Number(defaults.repair_turns ?? defaults.repairTurns)) ? Number(defaults.repair_turns ?? defaults.repairTurns) : DEFAULT_REPAIR_TURNS),
      proposalMode: normalizeProposalMode(defaults.proposal_mode || defaults.proposalMode || 'legacy'),
      staged: normalizeStagedDefaults(defaults.staged),
      proposer: normalizeModelConfig(defaults.proposer, 'minimax'),
      audit: normalizeModelConfig(defaults.audit, 'auto'),
    },
  };
}

function loadOvernightAdapter(adapterPath, options = {}) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const repoRoot = path.resolve(typeof safeOptions.repoRoot === 'string' ? safeOptions.repoRoot : process.cwd());
  const resolvedPath = path.resolve(repoRoot, typeof adapterPath === 'string' && adapterPath ? adapterPath : 'overnight.yaml');
  const loaded = readYamlFile(resolvedPath);
  const adapter = normalizeAdapterDocument(loaded.document, { repoRoot });
  const base = {
    ...adapter,
    sourcePath: resolvedPath,
  };

  if (options.mergeGenerated !== true) {
    return base;
  }

  const generatedSurfaces = loadGeneratedSurfaces(repoRoot);
  if (generatedSurfaces.length === 0) {
    return base;
  }

  const baseIds = new Set(base.surfaces.map((s) => s.id));
  for (const surface of generatedSurfaces) {
    if (baseIds.has(surface.id)) {
      const { AdapterError } = require('./errors.cjs');
      throw new AdapterError(
        'ADAPTER_SURFACE_ID_COLLISION',
        `surfaces.${surface.id}`,
        `surface id collision between base overnight.yaml and overnight.generated.yaml: ${surface.id}`,
        { fixHint: `Remove or rename the surface with id "${surface.id}" from overnight.generated.yaml — it already exists in overnight.yaml.` },
      );
    }
    baseIds.add(surface.id);
  }

  return {
    ...base,
    surfaces: base.surfaces.concat(generatedSurfaces),
  };
}

function registerGeneratedSurface(surface, options = {}) {
  const { AdapterError } = require('./errors.cjs');
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const generatedPath = path.join(repoRoot, 'overnight.generated.yaml');

  let existing;
  if (fs.existsSync(generatedPath)) {
    const loaded = readYamlFile(generatedPath);
    existing = loaded.document;
  } else {
    existing = { surfaces: [] };
  }

  if (!Array.isArray(existing.surfaces)) {
    existing.surfaces = [];
  }

  const surfaceId = surface && typeof surface === 'object' ? safeStr(surface.id) : '';
  if (!surfaceId) {
    throw new AdapterError(
      'SURFACE_ID_REQUIRED',
      'surface.id',
      'surface.id is required when registering a generated surface',
      { fixHint: 'Add a non-empty string id field to the surface object before calling registerGeneratedSurface.' },
    );
  }

  const duplicate = existing.surfaces.some((s) => s && safeStr(s.id) === surfaceId);
  if (duplicate) {
    throw new AdapterError(
      'GENERATED_SURFACE_DUPLICATE',
      `surfaces.${surfaceId}`,
      `surface id already exists in overnight.generated.yaml: ${surfaceId}`,
      { fixHint: `Remove or rename the surface with id "${surfaceId}" from overnight.generated.yaml before registering it again.` },
    );
  }

  existing.surfaces.push(surface);
  writeYamlFile(generatedPath, existing);
}

function loadGeneratedSurfaces(repoRoot) {
  const resolvedRoot = path.resolve(typeof repoRoot === 'string' && repoRoot ? repoRoot : process.cwd());
  const generatedPath = path.join(resolvedRoot, 'overnight.generated.yaml');

  if (!fs.existsSync(generatedPath)) {
    return [];
  }

  const loaded = readYamlFile(generatedPath);
  const rawSurfaces = Array.isArray(loaded.document.surfaces) ? loaded.document.surfaces : [];
  return rawSurfaces.map((surface, index) => normalizeSurface(surface, resolvedRoot, index));
}

function findSurface(adapter, surfaceId) {
  return Array.isArray(adapter && adapter.surfaces)
    ? adapter.surfaces.find((surface) => surface.id === surfaceId) || null
    : null;
}

function listTrackedFiles(repoRoot) {
  const safeCwd = typeof repoRoot === 'string' && repoRoot ? repoRoot : process.cwd();
  const output = execFileSync('git', ['ls-files'], {
    cwd: safeCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function resolvePatternMatches(adapter, patterns) {
  const safeAdapter = adapter && typeof adapter === 'object' && !Array.isArray(adapter) ? adapter : {};
  const files = listTrackedFiles(safeAdapter.repoRoot);
  const results = [];
  const seen = new Set();
  for (const pattern of normalizeStringList(patterns, 'patterns')) {
    for (const filePath of files) {
      if (!matchesPathPattern(filePath, pattern)) {
        continue;
      }
      if (seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      results.push(filePath);
    }
  }
  return results;
}

function isPathAllowedForSurface(adapter, surface, relativePath, options = {}) {
  if (!adapter || typeof adapter !== 'object') return false;
  if (!surface || typeof surface !== 'object') return false;
  const normalizedPath = safeStr(relativePath).split(path.sep).join('/');
  if (!normalizedPath) {
    return false;
  }
  const surfacePaths = Array.isArray(surface.paths) ? surface.paths : [];
  const surfaceTestPaths = Array.isArray(surface.testPaths) ? surface.testPaths : [];
  const sharedPaths = Array.isArray(adapter.sharedPaths) ? adapter.sharedPaths : [];
  const candidates = options.includeTests === false
    ? surfacePaths.concat(sharedPaths)
    : surfacePaths.concat(surfaceTestPaths).concat(sharedPaths);
  return candidates.some((pattern) => matchesPathPattern(normalizedPath, pattern));
}

function isManualOnlyPath(adapter, relativePath) {
  if (!adapter || typeof adapter !== 'object') return false;
  const manualOnlyPaths = Array.isArray(adapter.manualOnlyPaths) ? adapter.manualOnlyPaths : [];
  const normalizedPath = safeStr(relativePath).split(path.sep).join('/');
  return manualOnlyPaths.some((pattern) => matchesPathPattern(normalizedPath, pattern));
}

function isForbiddenPath(surface, relativePath) {
  if (!surface || typeof surface !== 'object') return false;
  const forbiddenPaths = Array.isArray(surface.forbiddenPaths) ? surface.forbiddenPaths : [];
  const normalizedPath = safeStr(relativePath).split(path.sep).join('/');
  return forbiddenPaths.some((pattern) => matchesPathPattern(normalizedPath, pattern));
}

function buildStarterAdapter(repoRoot) {
  const safeRoot = typeof repoRoot === 'string' && repoRoot ? repoRoot : process.cwd();
  const files = listTrackedFiles(safeRoot);
  const topDirs = Array.from(new Set(files.map((entry) => entry.split('/')[0]).filter(Boolean))).sort();
  const testDirs = topDirs.filter((entry) => /(^|[-_])(test|tests|spec|specs)$/i.test(entry) || /test/i.test(entry));
  const manifestPaths = {
    packageJson: path.join(safeRoot, 'package.json'),
    pyprojectToml: path.join(safeRoot, 'pyproject.toml'),
    cargoToml: path.join(safeRoot, 'Cargo.toml'),
    goMod: path.join(safeRoot, 'go.mod'),
    gemfile: path.join(safeRoot, 'Gemfile'),
    pomXml: path.join(safeRoot, 'pom.xml'),
    buildGradle: path.join(safeRoot, 'build.gradle'),
    buildGradleKts: path.join(safeRoot, 'build.gradle.kts'),
    settingsGradle: path.join(safeRoot, 'settings.gradle'),
    settingsGradleKts: path.join(safeRoot, 'settings.gradle.kts'),
    packageSwift: path.join(safeRoot, 'Package.swift'),
    cmakeLists: path.join(safeRoot, 'CMakeLists.txt'),
    makefile: path.join(safeRoot, 'Makefile'),
    mesonBuild: path.join(safeRoot, 'meson.build'),
    bazelBuild: path.join(safeRoot, 'BUILD.bazel'),
  };
  const requirementsFiles = files.filter((entry) => /^requirements[^/]*\.txt$/i.test(entry));
  const packageJson = fs.existsSync(manifestPaths.packageJson)
    ? JSON.parse(fs.readFileSync(manifestPaths.packageJson, 'utf8'))
    : null;
  const hasPyproject = fs.existsSync(manifestPaths.pyprojectToml);
  const hasCargo = fs.existsSync(manifestPaths.cargoToml);
  const hasGo = fs.existsSync(manifestPaths.goMod);
  const hasGemfile = fs.existsSync(manifestPaths.gemfile);
  const hasPom = fs.existsSync(manifestPaths.pomXml);
  const hasGradle = fs.existsSync(manifestPaths.buildGradle) || fs.existsSync(manifestPaths.buildGradleKts) || fs.existsSync(manifestPaths.settingsGradle) || fs.existsSync(manifestPaths.settingsGradleKts);
  const hasSwiftPackage = fs.existsSync(manifestPaths.packageSwift);
  const hasCmake = fs.existsSync(manifestPaths.cmakeLists);
  const hasMakefile = fs.existsSync(manifestPaths.makefile);
  const hasMeson = fs.existsSync(manifestPaths.mesonBuild);
  const hasBazel = fs.existsSync(manifestPaths.bazelBuild);
  const gemspecFiles = files.filter((entry) => /^[^/]+\.gemspec$/i.test(entry));
  const dotnetProjects = files.filter((entry) => /\.(csproj|sln)$/i.test(entry));
  const xcodeProjects = files.filter((entry) => /\.(xcodeproj|xcworkspace)$/i.test(entry));

  const fileExtensions = new Set(
    files
      .map((entry) => path.extname(entry).toLowerCase())
      .filter(Boolean),
  );
  const languageHints = [];
  if (packageJson || ['.js', '.cjs', '.mjs', '.ts', '.tsx'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('javascript', 'typescript');
  }
  if (hasPyproject || requirementsFiles.length > 0 || ['.py'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('python');
  }
  if (hasCargo || ['.rs'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('rust');
  }
  if (hasGo || ['.go'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('go');
  }
  if (hasGemfile || gemspecFiles.length > 0 || ['.rb'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('ruby');
  }
  if (hasPom || hasGradle || ['.java'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('java');
  }
  if (hasGradle || ['.kt', '.kts'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('kotlin');
  }
  if (dotnetProjects.length > 0 || ['.cs'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('csharp');
  }
  if (hasSwiftPackage || xcodeProjects.length > 0 || ['.swift'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('swift');
  }
  if (hasCmake || hasMakefile || hasMeson || hasBazel || ['.c', '.h'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('c');
  }
  if (hasCmake || hasMakefile || hasMeson || hasBazel || ['.cc', '.cpp', '.cxx', '.hpp', '.hh'].some((entry) => fileExtensions.has(entry))) {
    languageHints.push('cpp');
  }

  const sourceDirs = Array.from(new Set(
    files
      .filter((entry) => !entry.startsWith('.'))
      .filter((entry) => !/(^|\/)(__tests__|tests?|specs?)(\/|$)/i.test(entry))
      .map((entry) => entry.includes('/') ? entry.split('/')[0] : '')
      .filter(Boolean),
  )).sort();

  const likelySourceDirs = sourceDirs.filter((entry) => [
    'src',
    'lib',
    'app',
    'pkg',
    'internal',
    'cmd',
    'crates',
    'Sources',
    'Tests',
    'server',
    'client',
  ].includes(entry)).concat(sourceDirs.filter((entry) => ![
    'docs',
    'examples',
    'scripts',
    'test',
    'tests',
    'spec',
    'specs',
  ].includes(entry)));

  const uniqueSourceDirs = Array.from(new Set(likelySourceDirs)).slice(0, 6);
  const uniqueTestDirs = Array.from(new Set(
    files
      .filter((entry) => /(^|\/)(__tests__|tests?|specs?)(\/|$)/i.test(entry) || /\.(test|spec)\.[^.]+$/i.test(entry) || /_test\.go$/i.test(entry))
      .map((entry) => entry.includes('/') ? entry.split('/')[0] : '')
      .filter(Boolean),
  )).sort();

  const sourcePatterns = uniqueSourceDirs.map((entry) => `${entry}/**`);
  const explicitRootSources = files.filter((entry) => !entry.includes('/') && /\.(js|cjs|mjs|ts|tsx|py|go|rs|rb|java|kt|kts|cs|swift|c|h|cc|cpp|cxx|hpp|hh)$/i.test(entry));
  explicitRootSources.forEach((entry) => sourcePatterns.push(entry));

  const testPatterns = uniqueTestDirs.map((entry) => `${entry}/**`);
  files
    .filter((entry) => /\.(test|spec)\.[^.]+$/i.test(entry) || /_test\.(go|c|cc|cpp|cxx)$/i.test(entry) || /Tests?\.(cs|swift)$/i.test(entry))
    .forEach((entry) => {
      if (!testPatterns.includes(entry)) {
        testPatterns.push(entry);
      }
    });

  const contextPatterns = [
    packageJson ? 'package.json' : null,
    hasPyproject ? 'pyproject.toml' : null,
    hasCargo ? 'Cargo.toml' : null,
    hasGo ? 'go.mod' : null,
    hasGemfile ? 'Gemfile' : null,
    gemspecFiles[0] || null,
    hasPom ? 'pom.xml' : null,
    fs.existsSync(manifestPaths.buildGradle) ? 'build.gradle' : null,
    fs.existsSync(manifestPaths.buildGradleKts) ? 'build.gradle.kts' : null,
    fs.existsSync(manifestPaths.settingsGradle) ? 'settings.gradle' : null,
    fs.existsSync(manifestPaths.settingsGradleKts) ? 'settings.gradle.kts' : null,
    dotnetProjects[0] || null,
    hasSwiftPackage ? 'Package.swift' : null,
    xcodeProjects[0] || null,
    hasCmake ? 'CMakeLists.txt' : null,
    hasMakefile ? 'Makefile' : null,
    hasMeson ? 'meson.build' : null,
    hasBazel ? 'BUILD.bazel' : null,
  ].filter(Boolean);

  const manualOnlyPaths = [
    '.github/**',
    'infra/**',
    'migrations/**',
    'alembic/**',
    'terraform/**',
    'helm/**',
    'deploy/**',
  ].filter((pattern) => files.some((entry) => matchesPathPattern(entry, pattern)));

  const formattingHints = [];
  if (files.includes('package-lock.json') || files.includes('pnpm-lock.yaml') || files.includes('yarn.lock')) {
    formattingHints.push('respect-package-manager-lockfiles');
  }
  if (files.includes('.prettierrc') || files.includes('.prettierrc.json') || files.includes('prettier.config.js')) {
    formattingHints.push('prettier');
  }
  if (files.includes('ruff.toml') || files.includes('.ruff.toml')) {
    formattingHints.push('ruff');
  }
  if (files.includes('.golangci.yml') || files.includes('.golangci.yaml')) {
    formattingHints.push('golangci-lint');
  }
  if (files.includes('rustfmt.toml')) {
    formattingHints.push('rustfmt');
  }
  if (files.includes('.rubocop.yml') || files.includes('.rubocop.yaml')) {
    formattingHints.push('rubocop');
  }
  if (files.includes('.editorconfig')) {
    formattingHints.push('editorconfig');
  }
  if (files.includes('.clang-format')) {
    formattingHints.push('clang-format');
  }
  if (files.includes('gradlew')) {
    formattingHints.push('gradle-wrapper');
  }

  let setup = 'echo "Replace repo.setup with the real bootstrap command" >&2 && exit 1';
  let baselineValidation = ['echo "Replace repo.baseline_validation with a real command" >&2 && exit 1'];
  let finalValidation = ['echo "Replace repo.final_validation with a real command" >&2 && exit 1'];

  if (packageJson) {
    const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
    setup = files.includes('pnpm-lock.yaml')
      ? 'pnpm install --frozen-lockfile'
      : files.includes('yarn.lock')
        ? 'yarn install --frozen-lockfile'
        : 'npm install';
    const nodeValidation = scripts['test:unit']
      ? 'npm run test:unit'
      : scripts['test:ci']
        ? 'npm run test:ci'
        : scripts.test
          ? 'npm test'
          : null;
    if (nodeValidation) {
      baselineValidation = [nodeValidation];
      finalValidation = [nodeValidation];
    }
  } else if (hasPyproject || requirementsFiles.length > 0) {
    setup = hasPyproject
      ? 'python -m pip install -e .'
      : `python -m pip install -r ${requirementsFiles[0]}`;
    baselineValidation = ['pytest -q'];
    finalValidation = ['pytest -q'];
  } else if (hasCargo) {
    setup = 'cargo fetch';
    baselineValidation = ['cargo test'];
    finalValidation = ['cargo test'];
  } else if (hasGo) {
    setup = 'go mod download';
    baselineValidation = ['go test ./...'];
    finalValidation = ['go test ./...'];
  } else if (hasGemfile || gemspecFiles.length > 0) {
    setup = 'bundle install';
    if (uniqueTestDirs.includes('spec')) {
      baselineValidation = ['bundle exec rspec'];
      finalValidation = ['bundle exec rspec'];
    } else {
      baselineValidation = ['bundle exec rake test'];
      finalValidation = ['bundle exec rake test'];
    }
  } else if (hasPom) {
    setup = 'mvn -q -DskipTests dependency:resolve';
    baselineValidation = ['mvn test'];
    finalValidation = ['mvn test'];
  } else if (hasGradle) {
    setup = files.includes('gradlew') ? './gradlew dependencies' : 'gradle dependencies';
    const gradleCmd = files.includes('gradlew') ? './gradlew test' : 'gradle test';
    baselineValidation = [gradleCmd];
    finalValidation = [gradleCmd];
  } else if (dotnetProjects.length > 0) {
    setup = 'dotnet restore';
    baselineValidation = ['dotnet build', 'dotnet test'];
    finalValidation = ['dotnet build', 'dotnet test'];
  } else if (hasSwiftPackage) {
    setup = 'swift package resolve';
    baselineValidation = ['swift test'];
    finalValidation = ['swift test'];
  } else if (xcodeProjects.length > 0) {
    setup = 'xcodebuild -list';
    baselineValidation = ['xcodebuild test'];
    finalValidation = ['xcodebuild test'];
  } else if (hasCmake) {
    setup = 'cmake -S . -B build';
    baselineValidation = ['cmake --build build', 'ctest --test-dir build --output-on-failure'];
    finalValidation = ['cmake --build build', 'ctest --test-dir build --output-on-failure'];
  } else if (hasMeson) {
    setup = 'meson setup build';
    baselineValidation = ['meson test -C build'];
    finalValidation = ['meson test -C build'];
  } else if (hasBazel) {
    setup = 'bazel fetch //...';
    baselineValidation = ['bazel test //...'];
    finalValidation = ['bazel test //...'];
  } else if (hasMakefile) {
    setup = 'make';
    baselineValidation = ['make test'];
    finalValidation = ['make test'];
  }

  return {
    repo: {
      name: path.basename(safeRoot),
      setup,
      baseline_validation: baselineValidation,
      final_validation: finalValidation,
    },
    surfaces: [
      {
        id: 'core',
        title: 'Primary Mutable Surface',
        description: 'Starter surface inferred from the repo layout. Confirm the allowed paths, test proof, and invariants before the first live run.',
        paths: sourcePatterns.length > 0 ? sourcePatterns : ['src/**'],
        test_paths: testPatterns.length > 0 ? testPatterns : ['tests/**'],
        invariants: [
          'Keep behavior stable unless the objective explicitly calls for a behavior change.',
          'Do not cross into deployment, schema, or auth-critical paths without human review.',
        ],
        risk: 'guarded',
        required_test_kinds: [
          'regression',
        ],
        conflicts_with: [],
        language_hints: Array.from(new Set(languageHints)),
        formatting_hints: Array.from(new Set(formattingHints)),
        context_patterns: contextPatterns,
        allowed_dependencies: [],
        forbidden_paths: [],
      },
    ],
    manual_only_paths: manualOnlyPaths,
    shared_paths: [],
    defaults: {
      report_dir: DEFAULT_REPORT_DIR,
      branch_prefix: DEFAULT_BRANCH_PREFIX,
      attempt_limit: DEFAULT_ATTEMPT_LIMIT,
      repair_turns: DEFAULT_REPAIR_TURNS,
      proposal_mode: 'legacy',
      staged: {
        max_source_files: 1,
        max_test_files: 1,
        max_code_blocks: 1,
        max_test_blocks: 1,
        window_line_cap: DEFAULT_WINDOW_LINE_CAP,
      },
      proposer: {
        provider: 'minimax',
        model: 'MiniMax-M2.7-highspeed',
        api_key_env: 'MINIMAX_API_KEY',
      },
      audit: {
        provider: 'auto',
      },
      repo_scan_hint: {
        detected_stack: Array.from(new Set(languageHints)),
        needs_human_confirmation: true,
        top_level_dirs: topDirs,
        likely_source_dirs: uniqueSourceDirs,
        likely_test_dirs: uniqueTestDirs.length > 0 ? uniqueTestDirs : testDirs,
        detected_manifests: [
          packageJson ? 'package.json' : null,
          hasPyproject ? 'pyproject.toml' : null,
          requirementsFiles[0] || null,
          hasCargo ? 'Cargo.toml' : null,
          hasGo ? 'go.mod' : null,
          hasGemfile ? 'Gemfile' : null,
          gemspecFiles[0] || null,
          hasPom ? 'pom.xml' : null,
          fs.existsSync(manifestPaths.buildGradle) ? 'build.gradle' : null,
          fs.existsSync(manifestPaths.buildGradleKts) ? 'build.gradle.kts' : null,
          fs.existsSync(manifestPaths.settingsGradle) ? 'settings.gradle' : null,
          fs.existsSync(manifestPaths.settingsGradleKts) ? 'settings.gradle.kts' : null,
          dotnetProjects[0] || null,
          hasSwiftPackage ? 'Package.swift' : null,
          xcodeProjects[0] || null,
          hasCmake ? 'CMakeLists.txt' : null,
          hasMakefile ? 'Makefile' : null,
          hasMeson ? 'meson.build' : null,
          hasBazel ? 'BUILD.bazel' : null,
        ].filter(Boolean),
      },
    },
  };
}

module.exports = {
  buildStarterAdapter,
  findSurface,
  isForbiddenPath,
  isManualOnlyPath,
  isPathAllowedForSurface,
  listTrackedFiles,
  loadGeneratedSurfaces,
  loadOvernightAdapter,
  matchesPathPattern,
  normalizeAdapterDocument,
  normalizeCommandList,
  registerGeneratedSurface,
  resolvePatternMatches,
};
