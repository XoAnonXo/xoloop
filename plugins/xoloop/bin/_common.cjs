'use strict';

/**
 * Shared helpers for all xoloop-* CLI wrappers.
 *
 * All wrappers must:
 *   - resolve the plugin lib/ directory via $CLAUDE_PLUGIN_ROOT or relative fallback
 *   - detect missing overnight.yaml and delegate to xoloop-init first
 *   - enforce the dirty-overlap gate (locked D.1) for write-capable modes
 *   - per-repo lock for write modes, per-worktree for read modes (locked D.5)
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function pluginRoot() {
  // Prefer env var set by Claude Code when plugin is activated.
  if (process.env.CLAUDE_PLUGIN_ROOT && fs.existsSync(process.env.CLAUDE_PLUGIN_ROOT)) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  // Fallback: this file lives at <root>/bin/_common.cjs
  return path.resolve(__dirname, '..');
}

function libPath(relative) {
  return path.join(pluginRoot(), 'lib', relative);
}

function requireLib(relative) {
  const resolved = libPath(relative);
  if (!fs.existsSync(resolved)) {
    console.error(`[xoloop] framework not bundled at ${resolved}`);
    console.error('[xoloop] run: node $CLAUDE_PLUGIN_ROOT/scripts/bundle-framework.cjs');
    process.exit(1);
  }
  return require(resolved);
}

function pluginDataDir() {
  // Per locked B.3 — bulky artifacts go in ${CLAUDE_PLUGIN_DATA}.
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  // Fallback for standalone invocation.
  const homeDir = require('node:os').homedir();
  return path.join(homeDir, '.xoloop');
}

function repoArtifactDir(cwd) {
  // Per locked B.3 — human-visible config + summaries go in .xoloop/ in-repo.
  return path.join(cwd || process.cwd(), '.xoloop');
}

function ensureConfig(cwd) {
  // Per locked B.1 — if overnight.yaml missing, delegate to xoloop-init.
  const adapterPath = path.join(cwd, 'overnight.yaml');
  if (fs.existsSync(adapterPath)) return { bootstrapped: false };
  console.log('[xoloop] No overnight.yaml found — running xoloop-init first.');
  const initPath = path.join(__dirname, 'xoloop-init.cjs');
  const result = spawnSync('node', [initPath, '--dir', cwd], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('[xoloop] xoloop-init failed; cannot proceed.');
    process.exit(result.status || 1);
  }
  return { bootstrapped: true };
}

function gitStatus(cwd) {
  const r = spawnSync('git', ['status', '--porcelain=v1'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return { isRepo: false, dirty: false, changes: [] };
  const changes = r.stdout.split('\n').filter(Boolean);
  return { isRepo: true, dirty: changes.length > 0, changes };
}

function surfaceOverlapsDirty(surfacePath, dirtyChanges) {
  if (!surfacePath) return false;
  const surfaceAbs = path.resolve(surfacePath);
  return dirtyChanges.some((line) => {
    // Format: "XY filename" where XY is two-char status code
    const filename = line.slice(3).trim();
    const abs = path.resolve(filename);
    return abs === surfaceAbs || abs.startsWith(surfaceAbs + path.sep);
  });
}

function enforceDirtyOverlapGate(cwd, surfacePath, allowDirty) {
  // Locked D.1 — worktree every write mode. If dirty overlaps the surface,
  // refuse unless --allow-dirty explicitly passed (user snapshot approval).
  const { isRepo, dirty, changes } = gitStatus(cwd);
  if (!isRepo) return; // not a git repo, nothing to protect
  if (!dirty) return;
  if (!surfaceOverlapsDirty(surfacePath, changes)) return;
  if (allowDirty) {
    console.warn('[xoloop] dirty changes overlap surface; proceeding per --allow-dirty.');
    return;
  }
  console.error('[xoloop] REFUSED: dirty changes overlap the requested surface.');
  console.error('[xoloop] Re-run with --allow-dirty to snapshot them into the worktree,');
  console.error('[xoloop] or commit/stash them first.');
  process.exit(2);
}

function isFirstInvocationInRepo(cwd) {
  // Locked D.7 — first run per repo should be dry-run by default.
  const marker = path.join(repoArtifactDir(cwd), '.first-run-complete');
  return !fs.existsSync(marker);
}

function markFirstInvocationComplete(cwd) {
  const dir = repoArtifactDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.first-run-complete'), String(Date.now()));
}

function parseFlag(argv, flag, defaultValue) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return defaultValue;
  if (idx + 1 >= argv.length || argv[idx + 1].startsWith('--')) {
    return true; // boolean flag
  }
  return argv[idx + 1];
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

// EXTRA API-key path: build a proposalLoader that shells out to an
// external command instead of calling the Anthropic/OpenAI API directly.
// Unlocks CI / headless use without ANTHROPIC_API_KEY. Not used by the
// default Claude Code subagent path (which goes through
// bin/xoloop-apply-proposal.cjs instead of the engine's internal loop).
//
// Contract for the external command:
//   - stdin: JSON { systemPrompt, userPrompt, requestKind, surface, objective }
//   - stdout: JSON { text: "..." } — where "text" is the model response
//     that the engine's parser (parsePlannerResponse / parseProposal /
//     parseEditor) will then validate
//   - non-zero exit => treated as a call-level failure; engine records
//     planner-call-failed via the round-post-rebuild error-code
//     classifier
function buildExternalProposalLoader(command, cwd) {
  const { spawnSync } = require('node:child_process');
  return async function externalProposalLoader(ctx) {
    const stdinPayload = JSON.stringify({
      systemPrompt: ctx.prompt && ctx.prompt.systemPrompt,
      userPrompt: ctx.prompt && ctx.prompt.userPrompt,
      requestKind: ctx.requestKind || 'proposal',
      surface: ctx.surface || null,
      objective: ctx.objective || null,
      errorMessage: ctx.errorMessage || null,
      priorText: ctx.priorText || null,
    });
    const result = spawnSync('bash', ['-lc', command], {
      cwd,
      encoding: 'utf8',
      input: stdinPayload,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 600000,
    });
    if (result.status !== 0) {
      const err = new Error(
        `external proposer exited ${result.status} — stderr tail: ${String(result.stderr || '').slice(-1000)}`
      );
      err.code = 'MODEL_EXTERNAL_COMMAND_FAILED';
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (parseErr) {
      const err = new Error(
        `external proposer returned non-JSON stdout: ${parseErr.message}`
      );
      err.code = 'MODEL_EXTERNAL_COMMAND_INVALID_JSON';
      throw err;
    }
    if (!parsed || typeof parsed.text !== 'string') {
      const err = new Error(
        'external proposer JSON must contain a string "text" field'
      );
      err.code = 'MODEL_EXTERNAL_COMMAND_INVALID_JSON';
      throw err;
    }
    return { text: parsed.text };
  };
}

module.exports = {
  pluginRoot,
  libPath,
  requireLib,
  pluginDataDir,
  repoArtifactDir,
  ensureConfig,
  gitStatus,
  surfaceOverlapsDirty,
  enforceDirtyOverlapGate,
  isFirstInvocationInRepo,
  markFirstInvocationComplete,
  parseFlag,
  hasFlag,
  buildExternalProposalLoader,
};
