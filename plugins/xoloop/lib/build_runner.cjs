'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AdapterError } = require('./errors.cjs');

const COMMAND_ALIASES = {
  run: 'build',
  promote: 'approve',
};

const VALUE_FLAGS = {
  '--adapter': 'adapterPath',
  '--reason': 'reason',
  '--feedback': 'feedback',
  '--repo-root': 'repoRoot',
};

function normalizeBuildCommandName(command) {
  return COMMAND_ALIASES[command] || command;
}

function repoRootFor(cmd) {
  return cmd.repoRoot || process.cwd();
}

function reportsDirFor(cmd) {
  return path.join(repoRootFor(cmd), 'reports', 'features');
}

function parseBuildCommand(argv) {
  if (!Array.isArray(argv)) {
    throw new AdapterError(
      'INVALID_ARGV',
      'argv',
      'argv must be an array of strings',
      { fixHint: 'Pass the result of process.argv.slice(2) or an equivalent string array.' }
    );
  }
  const badIndex = argv.findIndex((el) => typeof el !== 'string');
  if (badIndex !== -1) {
    throw new AdapterError(
      'INVALID_ARGV',
      `argv[${badIndex}]`,
      `argv elements must all be strings; argv[${badIndex}] is ${typeof argv[badIndex]}`,
      { fixHint: 'Ensure every element of the argv array is a string before calling parseBuildCommand.' }
    );
  }
  const tokens = argv.slice();
  const result = {
    command: null,
    featurePath: null,
    featureId: null,
    reason: null,
    feedback: null,
    adapterPath: 'overnight.yaml',
    repoRoot: null,
  };

  // First positional arg is the subcommand
  if (tokens.length > 0 && !tokens[0].startsWith('--')) {
    result.command = normalizeBuildCommandName(tokens.shift());
  }

  // Second positional arg depends on subcommand
  if (tokens.length > 0 && !tokens[0].startsWith('--')) {
    const positional = tokens.shift();
    if (result.command === 'build') {
      result.featurePath = positional;
    } else {
      result.featureId = positional;
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const field = VALUE_FLAGS[tokens[i]];
    if (field && i + 1 < tokens.length) {
      result[field] = tokens[++i];
    }
  }

  return result;
}

function formatReviewBundle(bundle) {
  if (bundle == null || typeof bundle !== 'object') {
    throw new AdapterError(
      'INVALID_BUNDLE',
      'bundle',
      'bundle must be a non-null object',
      { fixHint: 'Pass the review bundle object returned by reviewFeature().' }
    );
  }
  const lines = [];

  lines.push(`Feature: ${bundle.featureId || '(unknown)'}`);
  lines.push(`Status:  ${bundle.status || '(unknown)'}`);
  lines.push('');

  const allOps = [
    ...((bundle.proposal && bundle.proposal.operations) || []),
    ...((bundle.proposal && bundle.proposal.testOperations) || []),
  ];
  lines.push(allOps.length > 0 ? 'Files:' : 'Files: (none)');
  for (const op of allOps) {
    if (op.path) lines.push(`  ${op.op || 'unknown'}: ${op.path}`);
  }
  lines.push('');

  // Delta summary
  if (bundle.delta) {
    lines.push('Delta:');
    const red = bundle.delta.red || {};
    const green = bundle.delta.green || {};
    lines.push(`  Red:   ${red.failed || 0} failed, ${red.passed || 0} passed (${red.total ?? (red.failed || 0) + (red.passed || 0)} total)`);
    lines.push(`  Green: ${green.passed || 0} passed, ${green.failed || 0} failed (${green.total ?? (green.passed || 0) + (green.failed || 0)} total)`);
    lines.push(`  OK: ${bundle.delta.ok === true ? 'yes' : 'no'}`);
    lines.push('');
  }

  // Acceptance criteria
  const acceptance = bundle.acceptance || [];
  if (acceptance.length > 0) {
    lines.push('Acceptance Criteria:');
    for (const criterion of acceptance) {
      lines.push(`  - ${criterion}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function runBuildCommand(cmd) {
  if (cmd == null || typeof cmd !== 'object') {
    throw new AdapterError(
      'INVALID_CMD',
      'cmd',
      'cmd must be a non-null object',
      { fixHint: 'Pass the parsed command object returned by parseBuildCommand().' }
    );
  }
  if (!cmd.command) {
    return { error: 'No command specified' };
  }

  const handler = BUILD_HANDLERS[cmd.command];
  if (!handler) {
    return { error: `Unknown command: ${cmd.command}. Available: run/build, review, promote/approve, reject, revise, list` };
  }
  return handler(cmd);
}

async function handleBuild(cmd) {
  const featurePath = cmd.featurePath;
  if (!featurePath) {
    return { error: 'Feature path is required for build command' };
  }

  const repoRoot = repoRootFor(cmd);
  const resolvedPath = path.resolve(repoRoot, featurePath);

  if (!fs.existsSync(resolvedPath)) {
    return { error: `Feature file not found: ${resolvedPath}` };
  }

  // Delegate to the build pipeline
  try {
    const { runBuildPipeline } = require('./build_pipeline.cjs');
    const result = await runBuildPipeline({
      featurePath: cmd.featurePath,
      adapterPath: cmd.adapterPath,
      repoRoot,
    });
    return result;
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

async function handleReview(cmd) {
  if (!cmd.featureId) {
    return { error: 'Feature ID is required for review command' };
  }

  try {
    const { reviewFeature } = require('./feature_checkpoint.cjs');
    return reviewFeature(cmd.featureId, {
      reportsDir: reportsDirFor(cmd),
    });
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

async function handleApprove(cmd) {
  if (!cmd.featureId) {
    return { error: 'Feature ID is required for approve command' };
  }

  try {
    const { approveFeature } = require('./feature_checkpoint.cjs');
    const repoRoot = repoRootFor(cmd);
    const approveResult = approveFeature(cmd.featureId, {
      reportsDir: reportsDirFor(cmd),
      repoRoot,
      adapterPath: cmd.adapterPath,
    });

    // After approval, trigger harden
    try {
      const { loadFeature } = require('./feature_loader.cjs');
      const { triggerHarden } = require('./harden_trigger.cjs');
      const { loadOvernightAdapter } = require('./overnight_adapter.cjs');

      const adapter = loadOvernightAdapter(cmd.adapterPath, { repoRoot });
      const feature = loadFeature(`feature.${cmd.featureId}.yaml`, adapter, { repoRoot });
      triggerHarden(feature, { repoRoot });
    } catch (_hardenErr) {
      // Harden trigger is best-effort after approval
    }

    return approveResult;
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

async function handleReject(cmd) {
  if (!cmd.featureId) {
    return { error: 'Feature ID is required for reject command' };
  }

  try {
    const { rejectFeature } = require('./feature_checkpoint.cjs');
    return rejectFeature(cmd.featureId, cmd.reason, {
      reportsDir: reportsDirFor(cmd),
    });
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

async function handleRevise(cmd) {
  if (!cmd.featureId) {
    return { error: 'Feature ID is required for revise command' };
  }

  try {
    const { reviseFeature } = require('./feature_checkpoint.cjs');
    return reviseFeature(cmd.featureId, cmd.feedback, {
      reportsDir: reportsDirFor(cmd),
    });
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

async function handleList(cmd) {
  try {
    const { listPendingFeatures } = require('./feature_checkpoint.cjs');
    const features = listPendingFeatures(reportsDirFor(cmd));
    return { features, count: features.length };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

const BUILD_HANDLERS = {
  build: handleBuild,
  review: handleReview,
  approve: handleApprove,
  reject: handleReject,
  revise: handleRevise,
  list: handleList,
};

module.exports = {
  parseBuildCommand,
  formatReviewBundle,
  runBuildCommand,
};
