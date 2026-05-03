const fs = require('node:fs');
const path = require('node:path');

const { writeYamlFile } = require('./overnight_yaml.cjs');
const { loadOvernightAdapter } = require('./overnight_adapter.cjs');
const { loadOvernightObjective } = require('./overnight_objective.cjs');
const { AdapterError } = require('./errors.cjs');

/**
 * Detect the project type by scanning for well-known manifest files.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {{ type: string, setup: string, validation: string[], languageHints: string[] }}
 */
function detectProjectType(repoRoot) {
  if (repoRoot == null || typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new AdapterError('MISSING_REPO_ROOT', 'repoRoot', 'repoRoot must be a non-empty string', { fixHint: 'Pass an absolute path to the repository root.' });
  }
  const hasFile = (name) => fs.existsSync(path.join(repoRoot, name));

  if (hasFile('package.json')) {
    return {
      type: 'node',
      setup: 'npm install',
      validation: ['npm test'],
      languageHints: ['javascript'],
    };
  }

  if (hasFile('pyproject.toml') || hasFile('requirements.txt')) {
    return {
      type: 'python',
      setup: 'python -m pip install -e .',
      validation: ['pytest -q'],
      languageHints: ['python'],
    };
  }

  if (hasFile('go.mod')) {
    return {
      type: 'go',
      setup: 'go mod download',
      validation: ['go test ./...'],
      languageHints: ['go'],
    };
  }

  if (hasFile('Cargo.toml')) {
    return {
      type: 'rust',
      setup: 'cargo build',
      validation: ['cargo test'],
      languageHints: ['rust'],
    };
  }

  if (hasFile('Gemfile') || fs.readdirSync(repoRoot).some((entry) => entry.endsWith('.gemspec'))) {
    return {
      type: 'ruby',
      setup: 'bundle install',
      validation: ['bundle exec rspec'],
      languageHints: ['ruby'],
    };
  }

  if (hasFile('pom.xml')) {
    return {
      type: 'java',
      setup: 'mvn -q -DskipTests dependency:resolve',
      validation: ['mvn test'],
      languageHints: ['java'],
    };
  }

  if (hasFile('build.gradle') || hasFile('settings.gradle') || hasFile('build.gradle.kts') || hasFile('settings.gradle.kts')) {
    const usesKotlinDsl = hasFile('build.gradle.kts') || hasFile('settings.gradle.kts');
    const gradle = hasFile('gradlew') ? './gradlew' : 'gradle';
    return {
      type: usesKotlinDsl ? 'kotlin' : 'java',
      setup: `${gradle} dependencies`,
      validation: [`${gradle} test`],
      languageHints: usesKotlinDsl ? ['kotlin', 'java'] : ['java'],
    };
  }

  if (fs.readdirSync(repoRoot).some((entry) => /\.(csproj|sln)$/i.test(entry))) {
    return {
      type: 'csharp',
      setup: 'dotnet restore',
      validation: ['dotnet build', 'dotnet test'],
      languageHints: ['csharp'],
    };
  }

  if (hasFile('Package.swift')) {
    return {
      type: 'swift',
      setup: 'swift package resolve',
      validation: ['swift test'],
      languageHints: ['swift'],
    };
  }

  if (fs.readdirSync(repoRoot).some((entry) => /\.(xcodeproj|xcworkspace)$/i.test(entry))) {
    return {
      type: 'swift',
      setup: 'xcodebuild -list',
      validation: ['xcodebuild test'],
      languageHints: ['swift'],
    };
  }

  if (hasFile('CMakeLists.txt')) {
    return {
      type: 'cpp',
      setup: 'cmake -S . -B build',
      validation: ['cmake --build build', 'ctest --test-dir build --output-on-failure'],
      languageHints: ['c', 'cpp'],
    };
  }

  if (hasFile('meson.build')) {
    return {
      type: 'cpp',
      setup: 'meson setup build',
      validation: ['meson test -C build'],
      languageHints: ['c', 'cpp'],
    };
  }

  if (hasFile('BUILD.bazel')) {
    return {
      type: 'cpp',
      setup: 'bazel fetch //...',
      validation: ['bazel test //...'],
      languageHints: ['c', 'cpp'],
    };
  }

  if (hasFile('Makefile')) {
    return {
      type: 'cpp',
      setup: 'make',
      validation: ['make test'],
      languageHints: ['c', 'cpp'],
    };
  }

  return {
    type: 'unknown',
    setup: 'echo "No setup detected — replace this with your build command"',
    validation: ['echo "No validation detected — replace this with your test command"'],
    languageHints: [],
  };
}

/**
 * Scan src/ subdirectories and test directories to detect surfaces.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {{ type: string }} projectType - Result from detectProjectType.
 * @returns {Array<{ id: string, title: string, paths: string[], testPaths: string[], invariants: string[], risk: string }>}
 */
function detectSurfaces(repoRoot, projectType) {
  if (repoRoot == null || typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new AdapterError('MISSING_REPO_ROOT', 'repoRoot', 'repoRoot must be a non-empty string', { fixHint: 'Pass an absolute path to the repository root.' });
  }
  if (projectType == null || typeof projectType !== 'object' || Array.isArray(projectType)) {
    throw new AdapterError('INVALID_PROJECT_TYPE', 'projectType', 'projectType must be a non-null object returned by detectProjectType', { fixHint: 'Call detectProjectType(repoRoot) and pass the result as the second argument.' });
  }
  const srcDir = path.join(repoRoot, 'src');
  let subdirs = [];

  if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    subdirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  // Also check for monorepo patterns: packages/, apps/, lib/
  if (subdirs.length === 0) {
    for (const altRoot of ['packages', 'apps', 'lib']) {
      const altDir = path.join(repoRoot, altRoot);
      if (fs.existsSync(altDir) && fs.statSync(altDir).isDirectory()) {
        const altEntries = fs.readdirSync(altDir, { withFileTypes: true });
        const altSubdirs = altEntries
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, root: altRoot }));
        if (altSubdirs.length > 0) {
          return altSubdirs.map(({ name, root }) => ({
            id: name,
            title: name.charAt(0).toUpperCase() + name.slice(1),
            paths: [`${root}/${name}/**`],
            testPaths: [`${root}/${name}/tests/**`, `${root}/${name}/__tests__/**`],
            invariants: ['must maintain existing behavior'],
            risk: 'guarded',
          }));
        }
      }
    }
  }

  if (subdirs.length === 0) {
    // Add a docs surface if README.md or docs/ exist
    const docsFiles = [];
    if (fs.existsSync(path.join(repoRoot, 'README.md'))) docsFiles.push('README.md');
    if (fs.existsSync(path.join(repoRoot, 'docs')) && fs.statSync(path.join(repoRoot, 'docs')).isDirectory()) {
      docsFiles.push('docs/**');
    }
    const surfaces = [
      {
        id: 'core',
        title: 'Core',
        paths: ['src/**'],
        testPaths: ['tests/**'],
        invariants: ['must maintain existing behavior'],
        risk: 'guarded',
      },
    ];
    if (docsFiles.length > 0) {
      surfaces.push({
        id: 'docs',
        title: 'Documentation',
        paths: docsFiles,
        testPaths: ['tests/**'],
        invariants: ['doc claims must match code behavior'],
        risk: 'guarded',
      });
    }
    return surfaces;
  }

  if (projectType.type === 'java' || projectType.type === 'kotlin') {
    const sourceRoot = projectType.type === 'kotlin' && fs.existsSync(path.join(repoRoot, 'src/main/kotlin'))
      ? 'src/main/kotlin'
      : 'src/main/java';
    const testRoot = projectType.type === 'kotlin' && fs.existsSync(path.join(repoRoot, 'src/test/kotlin'))
      ? 'src/test/kotlin'
      : 'src/test/java';
    if (fs.existsSync(path.join(repoRoot, sourceRoot))) {
      return [{
        id: projectType.type,
        title: projectType.type === 'kotlin' ? 'Kotlin' : 'Java',
        paths: [`${sourceRoot}/**`],
        testPaths: fs.existsSync(path.join(repoRoot, testRoot)) ? [`${testRoot}/**`] : ['src/test/**'],
        invariants: ['must maintain public API behavior', 'must keep native JVM tests green'],
        risk: 'guarded',
      }];
    }
  }

  return subdirs.map((name) => {
    const testPaths = [];
    const testDirCandidates = ['tests', 'test', '__tests__'];
    for (const testDir of testDirCandidates) {
      const candidate = path.join(repoRoot, testDir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        testPaths.push(`${testDir}/${name}/**`);
      }
    }
    if (testPaths.length === 0) {
      testPaths.push(`tests/${name}/**`);
    }

    return {
      id: name,
      title: name.charAt(0).toUpperCase() + name.slice(1),
      paths: [`src/${name}/**`],
      testPaths,
      invariants: ['must maintain existing behavior'],
      risk: 'guarded',
    };
  });
}

/**
 * Generate a full overnight.yaml-compatible adapter object.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {object} The adapter document ready for writeYamlFile.
 */
function generateAdapter(repoRoot) {
  if (repoRoot == null || typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new AdapterError('MISSING_REPO_ROOT', 'repoRoot', 'repoRoot must be a non-empty string', { fixHint: 'Pass an absolute path to the repository root.' });
  }
  const projectType = detectProjectType(repoRoot);
  const detectedSurfaces = detectSurfaces(repoRoot, projectType);

  return {
    repo: {
      name: path.basename(repoRoot),
      setup: projectType.setup,
      baseline_validation: projectType.validation,
      final_validation: projectType.validation,
    },
    surfaces: detectedSurfaces.map((s) => ({
      id: s.id,
      title: s.title,
      description: `Auto-detected surface for ${s.id}`,
      paths: s.paths,
      test_paths: s.testPaths,
      invariants: s.invariants,
      risk: s.risk,
      required_test_kinds: ['regression'],
      context_patterns: [],
      allowed_dependencies: [],
      forbidden_paths: [],
      quick_validation: projectType.validation,
      full_validation: projectType.validation,
    })),
    manual_only_paths: [],
    shared_paths: [],
    defaults: {
      report_dir: 'reports/overnight',
      branch_prefix: 'codex/overnight',
      attempt_limit: 3,
      repair_turns: 2,
      proposal_mode: 'staged',
      proposer: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      audit: { provider: 'auto' },
    },
  };
}

/**
 * Generate a polish-focused objective referencing adapter surfaces.
 *
 * @param {{ surfaces: Array<{ id: string }> }} adapter - The adapter object from generateAdapter.
 * @returns {object} The objective document ready for writeYamlFile.
 */
function generateObjective(adapter) {
  if (adapter == null || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new AdapterError('MISSING_ADAPTER', 'adapter', 'adapter must be a non-null object returned by generateAdapter', { fixHint: 'Call generateAdapter(repoRoot) and pass the result to generateObjective.' });
  }
  if (!Array.isArray(adapter.surfaces)) {
    throw new AdapterError('INVALID_ADAPTER_SURFACES', 'adapter.surfaces', 'adapter.surfaces must be an array of surface objects', { fixHint: 'Call generateAdapter(repoRoot) and pass the result to generateObjective.' });
  }
  const surfaceIds = adapter.surfaces.map((s) => s.id);
  const projectType = (adapter.repo && adapter.repo.setup) || '';
  const isNode = projectType.includes('npm');
  const isJvm = projectType.includes('mvn') || projectType.includes('gradle');

  const success = [
    'every exported function has at least one regression test',
    isJvm
      ? 'every boundary function guards against nulls, invalid arguments, and illegal state'
      : 'every boundary function guards against null/undefined/wrong-type inputs',
    'no dead code — every export is reachable, every branch is exercised',
  ];
  if (isNode) {
    success.unshift('every public API throws structured errors with code, field, and fixHint');
  } else {
    success.unshift('every public API returns clear, actionable error messages');
  }

  return {
    goal: 'Raise the engineering bar: structured errors, regression test coverage for every public function, input validation on every boundary, no dead code.',
    allowed_surfaces: surfaceIds,
    success,
    required_tests: ['regression'],
    stop_conditions: ['would add a new feature beyond quality polish'],
    evidence: ['test suite is green and strictly growing'],
    priority: 'high',
  };
}

/**
 * Orchestrate the full init: generate adapter + objective, write them, validate, return summary.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {{ force?: boolean }} options
 * @returns {{ adapterPath: string, objectivePath: string, summary: string }}
 */
function runInit(repoRoot, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw new AdapterError('INVALID_OPTIONS', 'options', 'options must be a plain object or omitted', { fixHint: 'Pass an options object (e.g. { force: true }) or omit the argument.' });
  }
  const adapterObj = generateAdapter(repoRoot);
  const objectiveObj = generateObjective(adapterObj);

  const adapterPath = path.join(repoRoot, 'overnight.yaml');
  const objectivePath = path.join(repoRoot, 'objective.yaml');

  writeYamlFile(adapterPath, adapterObj);
  writeYamlFile(objectivePath, objectiveObj);

  // Validate both files through the real loaders
  const loadedAdapter = loadOvernightAdapter(adapterPath, { repoRoot });
  loadOvernightObjective(objectivePath, loadedAdapter, { repoRoot });

  const surfaceCount = adapterObj.surfaces.length;
  const setup = adapterObj.repo.setup;
  const projectTypeName = setup.includes('npm') ? 'node'
    : setup.includes('pip') ? 'python'
    : setup.includes('go mod') ? 'go'
    : setup.includes('cargo') ? 'rust'
    : setup.includes('bundle') ? 'ruby'
    : setup.includes('mvn') ? 'java'
    : setup.includes('gradle') ? 'jvm'
    : setup.includes('dotnet') ? 'csharp'
    : setup.includes('swift') || setup.includes('xcodebuild') ? 'swift'
    : setup.includes('cmake') || setup.includes('meson') || setup.includes('bazel') || setup === 'make' ? 'cpp'
    : 'unknown';
  const summary = `Initialized ${surfaceCount} surface(s) for ${projectTypeName} project. Wrote ${adapterPath} (overnight.yaml) and ${objectivePath} (objective.yaml).`;

  return {
    adapterPath,
    objectivePath,
    summary,
  };
}

module.exports = {
  detectProjectType,
  detectSurfaces,
  generateAdapter,
  generateObjective,
  runInit,
};
