const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ensureDir, normalizeText } = require('./baton_common.cjs');

function runGit(repoRoot, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    exitCode: result.status === null ? 1 : result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function assertGitOk(result, label) {
  if (!result || result.exitCode !== 0) {
    const { AdapterError } = require('./errors.cjs');
    const detail = result && (result.stderr || result.stdout || result.exitCode);
    throw new AdapterError('GIT_COMMAND_FAILED', label, `${label} failed: ${detail}`, {
      fixHint: 'Check that the git command arguments and working directory are valid.',
    });
  }
  return result;
}

function getHeadCommit(repoRoot) {
  const result = runGit(repoRoot, ['rev-parse', 'HEAD']);
  assertGitOk(result, 'git rev-parse HEAD');
  return normalizeText(result.stdout);
}

function gitStatus(repoRoot) {
  const result = runGit(repoRoot, ['status', '--porcelain']);
  assertGitOk(result, 'git status --porcelain');
  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function branchExists(repoRoot, branchName) {
  const result = runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
  return result.exitCode === 0;
}

function ensureBranchCheckedOut(worktreePath, branchName, startPoint) {
  const args = ['checkout', '-B', branchName, startPoint];
  const result = runGit(worktreePath, args);
  assertGitOk(result, `git ${args.join(' ')}`);
  return branchName;
}

function ensureSharedNodeModules(repoRoot, worktreePath) {
  const sourcePath = path.resolve(repoRoot, 'node_modules');
  if (!fs.existsSync(sourcePath)) {
    return {
      linked: false,
      targetPath: path.resolve(worktreePath, 'node_modules'),
      sourcePath,
      reason: 'missing-source',
    };
  }
  const targetPath = path.resolve(worktreePath, 'node_modules');
  if (fs.existsSync(targetPath)) {
    try {
      if (fs.realpathSync(targetPath) === fs.realpathSync(sourcePath)) {
        return {
          linked: false,
          targetPath,
          sourcePath,
          reason: 'already-linked',
        };
      }
    } catch {
      // Leave existing content alone if it cannot be resolved safely.
    }
    return {
      linked: false,
      targetPath,
      sourcePath,
      reason: 'present',
    };
  }
  fs.symlinkSync(sourcePath, targetPath, 'dir');
  return {
    linked: true,
    targetPath,
    sourcePath,
    reason: 'linked',
  };
}

function createWorktree(repoRoot, options) {
  const worktreePath = path.resolve(options.worktreePath);
  const branchName = normalizeText(options.branchName);
  const startPoint = normalizeText(options.startPoint) || 'HEAD';
  ensureDir(path.dirname(worktreePath));
  if (fs.existsSync(worktreePath)) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('WORKTREE_PATH_EXISTS', 'worktreePath', `Worktree path already exists: ${worktreePath}`, { fixHint: 'Remove or rename the existing worktree directory before retrying, or use prepareExistingWorktree to reuse it.' });
  }
  const args = ['worktree', 'add', '-b', branchName, worktreePath, startPoint];
  const result = runGit(repoRoot, args);
  assertGitOk(result, `git ${args.join(' ')}`);
  ensureSharedNodeModules(repoRoot, worktreePath);
  return {
    worktreePath,
    branchName,
    startPoint,
  };
}

function prepareExistingWorktree(repoRoot, worktreePath, options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const branchName = normalizeText(safeOptions.branchName);
  const startPoint = normalizeText(safeOptions.startPoint) || 'HEAD';
  if (!fs.existsSync(worktreePath)) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('WORKTREE_PATH_NOT_FOUND', 'worktreePath', `Worktree path not found: ${worktreePath}`, { fixHint: 'Verify the worktree path was created by createWorktree before calling prepareExistingWorktree.' });
  }
  const dirtyEntries = gitStatus(worktreePath);
  if (dirtyEntries.length > 0) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('WORKTREE_DIRTY', 'worktreePath', `Worktree is dirty and cannot be reused safely: ${worktreePath}`, { fixHint: 'Commit or stash all changes in the worktree before calling prepareExistingWorktree.' });
  }
  ensureBranchCheckedOut(worktreePath, branchName, startPoint);
  ensureSharedNodeModules(repoRoot, worktreePath);
  return {
    worktreePath,
    branchName,
    startPoint,
  };
}

function removeWorktree(repoRoot, worktreePath, options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  if (!fs.existsSync(worktreePath)) {
    return { skipped: true };
  }
  const args = ['worktree', 'remove'];
  if (safeOptions.force) {
    args.push('--force');
  }
  args.push(worktreePath);
  const result = runGit(repoRoot, args);
  assertGitOk(result, `git ${args.join(' ')}`);
  return {
    skipped: false,
    worktreePath,
  };
}

function deleteBranch(repoRoot, branchName, options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const args = ['branch', safeOptions.force ? '-D' : '-d', branchName];
  const result = runGit(repoRoot, args);
  if (result.exitCode !== 0) {
    return {
      deleted: false,
      error: result.stderr || result.stdout,
    };
  }
  return {
    deleted: true,
  };
}

module.exports = {
  branchExists,
  createWorktree,
  deleteBranch,
  ensureBranchCheckedOut,
  ensureSharedNodeModules,
  getHeadCommit,
  gitStatus,
  prepareExistingWorktree,
  removeWorktree,
  runGit,
};
