#!/usr/bin/env node
/**
 * xoloop-finalize.cjs — turn a noisy autoresearch session into clean,
 * independent branches. Inspired by pi-autoresearch/autoresearch-finalize.
 *
 * Reads `.xoloop/session.jsonl`, filters to entries with outcome='keep',
 * groups them by non-overlapping file sets, and proposes one independent
 * branch per group. Each branch:
 *   - starts from the pre-session merge-base
 *   - contains only commits that touch files inside the group
 *   - has a summary commit message with the kept proposals' rationales
 *     and any metric improvements
 *
 * Why non-overlapping? Branches that share files can't be merged
 * independently without conflicts. Grouping by disjoint file sets gives
 * operators a reviewable sequence where each branch is a self-contained
 * PR.
 *
 * Usage:
 *   xoloop-finalize [--dry-run] [--base-ref main] [--branch-prefix xoloop/]
 *                   [--ledger <path>] [--repo-root <path>]
 *
 * Modes:
 *   --dry-run (default when called from a skill) — print the proposed
 *     grouping, don't touch git. Ensure humans approve before branching.
 *   (default)                                    — actually create branches.
 */

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
      const setJ = new Set(kept[j].filesTouched || []);
      const hasOverlap = [...setJ].some((f) => setI.has(f));
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
  // Create branch off baseSha
  const createResult = git(['checkout', '-b', branchName, baseSha], repoRoot);
  if (!createResult.ok) {
    return { ok: false, error: `failed to create branch ${branchName}: ${createResult.stderr}` };
  }
  // Cherry-pick commits from HEAD that touch any of this group's files.
  // We cherry-pick onto the new branch; conflicts abort.
  const fileSet = new Set(summary.files);
  const baseCommits = listCommitsSinceBase(repoRoot, baseSha);
  const picked = [];
  for (const sha of baseCommits) {
    if (!commitTouchesAny(repoRoot, sha, fileSet)) continue;
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
  return { ok: true, branchName, baseSha, pickedCount: picked.length };
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
