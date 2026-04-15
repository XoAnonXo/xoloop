const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  initOvernightEngine,
  runOvernightBatch,
  validateOvernightAdapter,
} = require('./overnight_engine.cjs');
const { loadOvernightAdapter } = require('./overnight_adapter.cjs');
const { readYamlFile, writeYamlFile } = require('./overnight_yaml.cjs');

function writeFile(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
}

function commitFixtureRepo(rootDir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: rootDir, stdio: 'ignore' });
  commitAll(rootDir, 'fixture');
}

function commitAll(rootDir, message) {
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Codex', '-c', 'user.email=codex@example.com', 'commit', '-m', message], {
    cwd: rootDir,
    stdio: 'ignore',
  });
}

function buildNodeTypescriptFixture(rootDir) {
  writeFile(rootDir, 'package.json', JSON.stringify({
    name: 'fixture-node-typescript',
    private: true,
    scripts: {
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  writeFile(rootDir, 'src/index.ts', [
    'export function clampCount(value: number): number {',
    '  if (!Number.isFinite(value)) return 0;',
    '  return value < 0 ? 0 : value;',
    '}',
    '',
  ].join('\n'));
  writeFile(rootDir, 'tests/index.test.ts', [
    "import { strict as assert } from 'node:assert';",
    "import test from 'node:test';",
    "import { clampCount } from '../src/index.ts';",
    '',
    "test('clampCount floors negatives', () => {",
    '  assert.equal(clampCount(-5), 0);',
    '});',
    '',
  ].join('\n'));
}

function buildPythonFastApiFixture(rootDir) {
  writeFile(rootDir, 'pyproject.toml', [
    '[project]',
    'name = "fixture-python-fastapi"',
    'version = "0.1.0"',
    'dependencies = ["fastapi"]',
    '',
  ].join('\n'));
  writeFile(rootDir, 'app/main.py', [
    'from fastapi import FastAPI',
    '',
    'app = FastAPI()',
    '',
    '@app.get("/health")',
    'def health() -> dict[str, str]:',
    '    return {"status": "ok"}',
    '',
  ].join('\n'));
  writeFile(rootDir, 'tests/test_main.py', [
    'def test_health_smoke() -> None:',
    '    assert True',
    '',
  ].join('\n'));
}

function buildGoFixture(rootDir) {
  writeFile(rootDir, 'go.mod', [
    'module example.com/fixture-go',
    '',
    'go 1.22',
    '',
  ].join('\n'));
  writeFile(rootDir, 'internal/calc/calc.go', [
    'package calc',
    '',
    'func ClampCount(value int) int {',
    '  if value < 0 {',
    '    return 0',
    '  }',
    '  return value',
    '}',
    '',
  ].join('\n'));
  writeFile(rootDir, 'internal/calc/calc_test.go', [
    'package calc',
    '',
    'import "testing"',
    '',
    'func TestClampCount(t *testing.T) {',
    '  if ClampCount(-5) != 0 {',
    '    t.Fatal("expected clamp to floor negatives")',
    '  }',
    '}',
    '',
  ].join('\n'));
}

function buildRustFixture(rootDir) {
  writeFile(rootDir, 'Cargo.toml', [
    '[package]',
    'name = "fixture-rust"',
    'version = "0.1.0"',
    'edition = "2021"',
    '',
  ].join('\n'));
  writeFile(rootDir, 'src/lib.rs', [
    'pub fn clamp_count(value: i32) -> i32 {',
    '    if value < 0 {',
    '        return 0;',
    '    }',
    '    value',
    '}',
    '',
  ].join('\n'));
  writeFile(rootDir, 'tests/clamp_count.rs', [
    'use fixture_rust::clamp_count;',
    '',
    '#[test]',
    'fn clamp_count_floors_negatives() {',
    '    assert_eq!(clamp_count(-5), 0);',
    '}',
    '',
  ].join('\n'));
}

const MATRIX_BUILDERS = {
  'node-typescript': buildNodeTypescriptFixture,
  'python-fastapi': buildPythonFastApiFixture,
  go: buildGoFixture,
  rust: buildRustFixture,
};

function createFixtureRepo(stackId) {
  const builder = MATRIX_BUILDERS[stackId];
  if (!builder) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('HOSTILE_MATRIX_UNKNOWN_STACK', 'stackId', `Unknown hostile repo fixture: ${stackId}`, { fixHint: 'Pass one of the registered stack ids (node-typescript, python-fastapi, go, rust) via runHostileRepoMatrix({ stacks: [...] }).' });
  }
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `xo-loop-${stackId}-`));
  builder(rootDir);
  commitFixtureRepo(rootDir);
  return rootDir;
}

function forceRunnableValidation(adapterPath, objectivePath) {
  const adapterLoaded = readYamlFile(adapterPath);
  const adapter = adapterLoaded.document;
  adapter.repo.baseline_validation = ['node -e "process.exit(0)"'];
  adapter.repo.final_validation = ['node -e "process.exit(0)"'];
  if (Array.isArray(adapter.surfaces)) {
    adapter.surfaces.forEach((surface) => {
      surface.quick_validation = ['node -e "process.exit(0)"'];
      surface.full_validation = ['node -e "process.exit(0)"'];
    });
  }
  writeYamlFile(adapterPath, adapter);

  const objectiveLoaded = readYamlFile(objectivePath);
  const objective = objectiveLoaded.document;
  objective.goal = `Prove the engine can map and safely refuse unsafe changes in a ${path.basename(path.dirname(adapterPath))} style repo.`;
  writeYamlFile(objectivePath, objective);
}

function noSafeChangeProposalLoader() {
  return {
    provider: 'synthetic',
    model: 'synthetic-worker',
    usage: {},
    elapsedMs: 0,
    text: JSON.stringify({
      logical_explanation: {
        problem: 'No bounded safe change is proposed during hostile repo validation.',
        why_this_surface: 'This run proves the adapter and execution path without mutating the repo.',
        invariants_preserved: ['repo stays unchanged'],
        why_this_is_bounded: 'The worker returns no safe change.',
        residual_risks: [],
      },
      code_changes: [],
      test_changes: [],
    }),
  };
}

async function runMatrixCase(stackId) {
  const repoRoot = createFixtureRepo(stackId);
  const adapterPath = path.join(repoRoot, 'overnight.yaml');
  const objectivePath = path.join(repoRoot, 'objective.yaml');
  let batch = null;
  try {
    const init = await initOvernightEngine({
      cwd: repoRoot,
      adapterPath: 'overnight.yaml',
      objectivePath: 'objective.yaml',
    });
    const initialValidation = validateOvernightAdapter({
      cwd: repoRoot,
      adapterPath: 'overnight.yaml',
      objectivePath: 'objective.yaml',
    });
    const inferredAdapter = loadOvernightAdapter('overnight.yaml', { repoRoot });

    forceRunnableValidation(adapterPath, objectivePath);
    commitAll(repoRoot, 'starter overnight contracts');
    const runnableValidation = validateOvernightAdapter({
      cwd: repoRoot,
      adapterPath: 'overnight.yaml',
      objectivePath: 'objective.yaml',
    });
    batch = await runOvernightBatch({
      cwd: repoRoot,
      adapterPath: 'overnight.yaml',
      objectivePath: 'objective.yaml',
      proposalLoader: noSafeChangeProposalLoader,
      allowDirty: false,
    });
    return {
      stackId,
      repoRoot,
      init,
      inferred: {
        setup: inferredAdapter.repo.setup,
        baselineValidation: inferredAdapter.repo.baselineValidation,
        finalValidation: inferredAdapter.repo.finalValidation,
        paths: inferredAdapter.surfaces[0] ? inferredAdapter.surfaces[0].paths : [],
        testPaths: inferredAdapter.surfaces[0] ? inferredAdapter.surfaces[0].testPaths : [],
        languageHints: inferredAdapter.surfaces[0] ? inferredAdapter.surfaces[0].languageHints : [],
      },
      initialValidation,
      runnableValidation,
      batch: {
        status: batch.status,
        reasonCodes: batch.summary.reasonCodes,
        outcomes: batch.summary.outcomes,
      },
    };
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runHostileRepoMatrix(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    const { AdapterError } = require('./errors.cjs');
    const received = options === null ? 'null' : Array.isArray(options) ? 'array' : typeof options;
    throw new AdapterError('HOSTILE_MATRIX_OPTIONS_INVALID', 'options', `runHostileRepoMatrix options must be a plain object, received ${received}`, { fixHint: 'Call runHostileRepoMatrix() with no arguments or a plain object like { stacks: ["node-typescript"] }.' });
  }
  const stacks = Array.isArray(options.stacks) && options.stacks.length > 0
    ? options.stacks.slice()
    : ['node-typescript', 'python-fastapi', 'go', 'rust'];
  const results = [];
  for (const stackId of stacks) {
    results.push(await runMatrixCase(stackId));
  }
  return {
    generatedAt: new Date().toISOString(),
    stackCount: results.length,
    results,
  };
}

module.exports = {
  runHostileRepoMatrix,
};
