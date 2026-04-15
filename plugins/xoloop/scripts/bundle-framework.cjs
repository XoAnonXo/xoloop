#!/usr/bin/env node
/**
 * bundle-framework.cjs — populate xoloop-plugin/lib/ from proving-ground/lib/.
 *
 * Per locked Block C (Option 1): the plugin ships self-contained. Claude Code
 * copies the plugin directory to a cache on install and cannot rely on files
 * outside the plugin tree. This script syncs the framework code into the
 * plugin bundle.
 *
 * Source of truth stays in /Users/mac/xoanonxoLoop/proving-ground/lib.
 * Run this script whenever framework code changes and before packaging a
 * plugin release.
 *
 * Usage:
 *   node scripts/bundle-framework.cjs [--source <path>] [--verify]
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function parseArgs(argv) {
  const options = { source: null, verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source' && argv[i + 1]) {
      options.source = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--verify') {
      options.verify = true;
    }
  }
  return options;
}

function resolveSource(sourceOverride) {
  if (sourceOverride) {
    const abs = path.resolve(sourceOverride);
    if (!fs.existsSync(abs)) {
      throw new Error(`source directory not found: ${abs}`);
    }
    return abs;
  }
  // Default: plugin at <repo>/xoloop-plugin, source at <repo>/proving-ground/lib
  const pluginRoot = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(pluginRoot, '..');
  const defaultSource = path.join(repoRoot, 'proving-ground', 'lib');
  if (!fs.existsSync(defaultSource)) {
    throw new Error(`default source not found at ${defaultSource}; pass --source`);
  }
  return defaultSource;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyDirectory(sourceDir, destDir, stats) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destPath, stats);
    } else if (entry.isFile()) {
      // Only bundle .cjs / .js / .json / .yaml / .md — never test files or fixtures.
      const ext = path.extname(entry.name);
      if (!['.cjs', '.js', '.json', '.yaml', '.yml', '.md'].includes(ext)) continue;
      if (/\.test\./.test(entry.name)) continue;
      if (/\.spec\./.test(entry.name)) continue;
      const sourceHash = sha256File(sourcePath);
      let skip = false;
      if (fs.existsSync(destPath)) {
        const destHash = sha256File(destPath);
        if (destHash === sourceHash) {
          stats.unchanged += 1;
          skip = true;
        }
      }
      if (!skip) {
        fs.copyFileSync(sourcePath, destPath);
        stats.copied += 1;
      }
    }
  }
}

function cleanStaleFiles(sourceDir, destDir, stats) {
  if (!fs.existsSync(destDir)) return;
  const entries = fs.readdirSync(destDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      cleanStaleFiles(sourcePath, destPath, stats);
    } else if (entry.isFile()) {
      if (!fs.existsSync(sourcePath)) {
        fs.unlinkSync(destPath);
        stats.deleted += 1;
      }
    }
  }
}

function verify(sourceDir, destDir) {
  const diffs = [];
  function walk(relativeDir) {
    const srcFull = path.join(sourceDir, relativeDir);
    const destFull = path.join(destDir, relativeDir);
    if (!fs.existsSync(srcFull)) return;
    const entries = fs.readdirSync(srcFull, { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.join(relativeDir, entry.name);
      const srcPath = path.join(sourceDir, rel);
      const destPath = path.join(destDir, rel);
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!['.cjs', '.js', '.json', '.yaml', '.yml', '.md'].includes(ext)) continue;
        if (/\.test\./.test(entry.name)) continue;
        if (/\.spec\./.test(entry.name)) continue;
        if (!fs.existsSync(destPath)) {
          diffs.push({ rel, reason: 'missing in bundle' });
          continue;
        }
        if (sha256File(srcPath) !== sha256File(destPath)) {
          diffs.push({ rel, reason: 'hash mismatch' });
        }
      }
    }
  }
  walk('.');
  return diffs;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = resolveSource(options.source);
  const pluginRoot = path.resolve(__dirname, '..');
  const dest = path.join(pluginRoot, 'lib');

  if (options.verify) {
    console.log(`[bundle] verifying ${source} against ${dest}`);
    const diffs = verify(source, dest);
    if (diffs.length === 0) {
      console.log('[bundle] OK — bundle matches source.');
      process.exit(0);
    }
    console.error(`[bundle] FAILED — ${diffs.length} discrepanc${diffs.length === 1 ? 'y' : 'ies'}:`);
    for (const d of diffs) console.error(`  ${d.rel}: ${d.reason}`);
    process.exit(1);
  }

  console.log(`[bundle] source: ${source}`);
  console.log(`[bundle] dest:   ${dest}`);
  const stats = { copied: 0, unchanged: 0, deleted: 0 };
  copyDirectory(source, dest, stats);
  cleanStaleFiles(source, dest, stats);
  console.log(`[bundle] copied=${stats.copied} unchanged=${stats.unchanged} deleted=${stats.deleted}`);
  console.log('[bundle] done.');
}

main();
