#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  requireLib,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const {
  readLedger,
  sessionLedgerPath,
} = requireLib('xoloop_session.cjs');

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    exitCode: result.status,
  };
}

function parseArgs(argv) {
  return {
    dryRun: hasFlag(argv, '--dry-run'),
    baseRef: parseFlag(argv, '--base-ref', 'main'),
    branchPrefix: parseFlag(argv, '--branch-prefix', 'xoloop/'),
    ledgerPath: parseFlag(argv, '--ledger', null),
    repoRoot: parseFlag(argv, '--repo-root', process.cwd()),
    allowDirty: hasFlag(argv, '--allow-dirty'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Grouping
// ─────────────────────────────────────────────────────────────────────
//
// Simple union-find over "files touched across ledger entries." Two
// entries whose file sets share any file end up in the same group;
// groups with disjoint file sets stay separate.

function buildGroups(ledger) {
  const kept = ledger.filter((e) => e && e.outcome === 'keep' && Array.isArray(e.filesTouched));
  const entryIndex = new Map();       // entry -> parent entry index
  function find(i) {
    if (entryIndex.get(i) === i) return i;
    const root = find(entryIndex.get(i));
    entryIndex.set(i, root);
    return root;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) entryIndex.set(ra, rb);
  }
  kept.forEach((_, i) => entryIndex.set(i, i));
  // O(n^2) pairwise overlap check — n is small (kept proposals per session).
  for (let i = 0; i < kept.length; i += 1) {
    for (let j = i + 1; j < kept.length; j += 1) {
      const setI = new Set(kept[i].filesTouched || []);
      const hasOverlap = (kept[j].filesTouched || []).some((f) => setI.has(f));
      if (hasOverlap) union(i, j);
    }
  }
  const groupsMap = new Map();
  kept.forEach((entry, i) => {
    const root = find(i);
    if (!groupsMap.has(root)) groupsMap.set(root, []);
    groupsMap.get(root).push(entry);
  });
  const groups = Array.from(groupsMap.values());
  // Sort groups by first-touched round so output is deterministic.
  groups.sort((a, b) => (a[0].round || 0) - (b[0].round || 0));
  return groups;
}

function summarizeGroup(group, index) {
  const allFiles = Array.from(new Set(group.flatMap((e) => e.filesTouched || []))).sort();
  const rationales = group
    .map((e) => (e.proposalSummary || e.rationale || '').trim())
    .filter(Boolean);
  const metricDeltas = group
    .map((e) => e.metric)
    .filter((m) => m && typeof m === 'object');
  return {
    groupIndex: index,
    roundRange: [group[0].round || null, group[group.length - 1].round || null],
    entryCount: group.length,
    files: allFiles,
    rationales,
    metricDeltas,
    branchName: null, // set by caller
  };
}

// ─────────────────────────────────────────────────────────────────────
// Branch creation
// ─────────────────────────────────────────────────────────────────────

function mergeBaseWithBase(repoRoot, baseRef) {
  const result = git(['merge-base', 'HEAD', baseRef], repoRoot);
  if (!result.ok) return null;
  return result.stdout.trim();
}

function listCommitsSinceBase(repoRoot, baseSha) {
  const result = git(['log', '--reverse', '--format=%H', `${baseSha}..HEAD`], repoRoot);
  if (!result.ok) return [];
  return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function commitTouchesAny(repoRoot, commitSha, fileSet) {
  const result = git(['show', '--name-only', '--format=', commitSha], repoRoot);
  if (!result.ok) return false;
  const files = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return files.some((f) => fileSet.has(f));
}

function createGroupBranch(repoRoot, baseSha, summary, dryRun) {
  const branchName = summary.branchName;
  if (dryRun) {
    return { ok: true, dryRun: true, branchName, baseSha };
  }
  // Audit P1 (round 5): list commits to replay BEFORE checking out the
  // new branch. Previously we did `git checkout -b <name> <baseSha>`
  // first, which moved HEAD to baseSha; the subsequent `baseSha..HEAD`
  // range became empty and every branch was created with no commits
  // replayed. Snapshot the pre-checkout HEAD commits first.
  const fileSet = new Set(summary.files);
  const baseCommits = listCommitsSinceBase(repoRoot, baseSha);
  const relevantCommits = baseCommits.filter((sha) => commitTouchesAny(repoRoot, sha, fileSet));

  // Audit P3 (round 5): whole-commit cherry-pick can bleed unrelated
  // files into the branch if a source commit touched both group
  // files AND orphan files. Detect mixed-scope commits and surface a
  // warning on the result so operators see which branches carry extra
  // file changes — they can choose to split manually or accept.
  const mixedScopeCommits = [];
  for (const sha of relevantCommits) {
    const commitFiles = commitFileList(repoRoot, sha);
    const overflow = commitFiles.filter((f) => !fileSet.has(f));
    if (overflow.length > 0) {
      mixedScopeCommits.push({ sha, overflow });
    }
  }

  // Create branch off baseSha.
  const createResult = git(['checkout', '-b', branchName, baseSha], repoRoot);
  if (!createResult.ok) {
    return { ok: false, error: `failed to create branch ${branchName}: ${createResult.stderr}` };
  }
  const picked = [];
  for (const sha of relevantCommits) {
    const pickResult = git(['cherry-pick', '--allow-empty', sha], repoRoot);
    if (!pickResult.ok) {
      git(['cherry-pick', '--abort'], repoRoot);
      git(['checkout', baseSha], repoRoot);
      return {
        ok: false,
        error: `cherry-pick of ${sha} failed: ${pickResult.stderr}`,
        branchName,
        pickedBeforeFailure: picked,
      };
    }
    picked.push(sha);
  }
  return {
    ok: true,
    branchName,
    baseSha,
    pickedCount: picked.length,
    mixedScopeCommits,
    mixedScopeWarning: mixedScopeCommits.length > 0
      ? `${mixedScopeCommits.length} cherry-picked commit(s) also touch files outside this group's file set. Review the branch diff to decide whether to accept or split further.`
      : null,
  };
}

function commitFileList(repoRoot, commitSha) {
  const result = git(['show', '--name-only', '--format=', commitSha], repoRoot);
  if (!result.ok) return [];
  return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage: xoloop-finalize [--dry-run] [--base-ref main]');
    console.log('                       [--branch-prefix xoloop/]');
    console.log('                       [--ledger <path>] [--repo-root <path>]');
    console.log('');
    console.log('Reads .xoloop/session.jsonl, groups kept entries by non-');
    console.log('overlapping file sets, and (unless --dry-run) creates one');
    console.log('independent branch per group starting from merge-base.');
    console.log('Default with no --dry-run flag: actually creates branches.');
    console.log('Default summary output: always printed to stdout (JSON).');
    process.exit(0);
  }

  const opts = parseArgs(argv);
  const cwd = path.resolve(opts.repoRoot);
  const ledger = opts.ledgerPath
    ? (() => {
      const raw = fs.readFileSync(path.resolve(opts.ledgerPath), 'utf8');
      return raw.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (_e) { return null; }
      }).filter(Boolean);
    })()
    : readLedger(cwd);

  const groups = buildGroups(ledger);
  const summaries = groups.map((group, i) => {
    const summary = summarizeGroup(group, i);
    const firstRound = summary.roundRange[0] != null ? summary.roundRange[0] : 'x';
    summary.branchName = `${opts.branchPrefix}group-${i + 1}-round-${firstRound}`;
    return summary;
  });

  const plan = {
    ledgerPath: opts.ledgerPath || sessionLedgerPath(cwd),
    keptEntries: ledger.filter((e) => e && e.outcome === 'keep').length,
    groupCount: groups.length,
    groups: summaries,
    dryRun: opts.dryRun,
    baseRef: opts.baseRef,
  };

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    process.exit(0);
  }

  // Audit P2 (round 5): dirty-worktree guard for the write path. Every
  // other plugin wrapper refuses to operate on a dirty tree unless
  // --allow-dirty is passed; finalize jumped straight to git mutation
  // without the check. If an operator had uncommitted edits, the
  // subsequent `git checkout -b` could silently carry those edits
  // across branches. Require a clean tree or explicit opt-in.
  if (!opts.allowDirty) {
    const statusResult = git(['status', '--porcelain=v1'], cwd);
    if (statusResult.ok && statusResult.stdout.trim().length > 0) {
      console.error('[xoloop-finalize] working tree is dirty — refusing to mutate git state.');
      console.error('[xoloop-finalize] commit/stash local edits first, or pass --allow-dirty to proceed anyway.');
      console.error('[xoloop-finalize] dirty files:');
      console.error(statusResult.stdout.split('\n').slice(0, 20).map((l) => '  ' + l).join('\n'));
      process.exit(1);
    }
  }

  // Execute the plan.
  const baseSha = mergeBaseWithBase(cwd, opts.baseRef);
  if (!baseSha) {
    console.error(`[xoloop-finalize] could not resolve merge-base with ${opts.baseRef}`);
    process.exit(1);
  }
  plan.baseSha = baseSha;
  const results = [];
  for (const summary of summaries) {
    const result = createGroupBranch(cwd, baseSha, summary, false);
    results.push({ ...summary, result });
    if (!result.ok) {
      process.stdout.write(JSON.stringify({
        ...plan,
        results,
        failed: true,
      }, null, 2) + '\n');
      process.exit(1);
    }
  }
  process.stdout.write(JSON.stringify({
    ...plan,
    results,
    failed: false,
  }, null, 2) + '\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('[xoloop-finalize] fatal:', err.message || err);
  process.exit(1);
});
