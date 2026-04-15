const fs = require('node:fs');
const path = require('node:path');

const {
  buildStarterAdapter,
  loadOvernightAdapter,
} = require('./overnight_adapter.cjs');
const { loadOvernightObjective } = require('./overnight_objective.cjs');
const { writeYamlFile } = require('./overnight_yaml.cjs');
const { AdapterError } = require('./errors.cjs');

async function initOvernightEngine(options = {}) {
  const repoRoot = path.resolve(options.cwd || process.cwd());
  const adapterPath = path.resolve(repoRoot, options.adapterPath || 'overnight.yaml');
  const objectivePath = path.resolve(repoRoot, options.objectivePath || 'objective.yaml');
  if (!options.force && (fs.existsSync(adapterPath) || fs.existsSync(objectivePath))) {
    throw new AdapterError(
      'INIT_WOULD_OVERWRITE',
      'adapterPath',
      'overnight init refused to overwrite existing files. Use --force to replace them.',
      { fixHint: 'Pass --force to initOvernightEngine to overwrite existing overnight.yaml / objective.yaml.' }
    );
  }
  const starterAdapter = buildStarterAdapter(repoRoot);
  const starterObjective = {
    goal: 'Define the first safe overnight objective for this repo.',
    allowed_surfaces: ['core'],
    success: [
      'Describe the exact safe outcome you want before turning the engine loose.',
    ],
    required_tests: [
      'regression',
    ],
    stop_conditions: [
      'Would require touching a manual-only path.',
    ],
    evidence: [],
    priority: 'medium',
  };
  writeYamlFile(adapterPath, starterAdapter);
  writeYamlFile(objectivePath, starterObjective);
  return {
    adapterPath,
    objectivePath,
  };
}

function validateOvernightAdapter(options = {}) {
  const adapter = loadOvernightAdapter(options.adapterPath, {
    repoRoot: options.cwd || process.cwd(),
  });
  const objective = options.objectivePath
    ? loadOvernightObjective(options.objectivePath, adapter, {
        repoRoot: options.cwd || process.cwd(),
      })
    : null;
  return {
    adapter: {
      sourcePath: adapter.sourcePath,
      surfaceCount: adapter.surfaces.length,
      manualOnlyPaths: adapter.manualOnlyPaths.length,
      sharedPaths: adapter.sharedPaths.length,
      proposalMode: adapter.defaults.proposalMode,
      staged: adapter.defaults.staged,
    },
    objective: objective
      ? {
          sourcePath: objective.sourcePath,
          allowedSurfaces: objective.allowedSurfaces,
          priority: objective.priority,
        }
      : null,
  };
}

module.exports = {
  initOvernightEngine,
  validateOvernightAdapter,
};
