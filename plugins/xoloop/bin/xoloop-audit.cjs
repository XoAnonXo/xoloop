#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  requireLib,
  ensureConfig,
  enforceDirtyOverlapGate,
  parseFlag,
  hasFlag,
} = require('./_common.cjs');

const { runAuditFixLoop, summarizeBySeverity } = requireLib('audit_runner.cjs');
const { callAuditorWithCodex } = requireLib('audit_caller_codex.cjs');
const { callFixerWithOpus } = requireLib('audit_caller_opus.cjs');
const { applyChangeSet, rollbackAppliedChangeSet } = requireLib('change_set_engine.cjs');

function printFindings(findings, maxPerSeverity = 10) {
  if (!Array.isArray(findings) || findings.length === 0) return;
  const bySev = { P1: [], P2: [], P3: [], low: [] };
  for (const f of findings) {
    if (bySev[f.severity]) bySev[f.severity].push(f);
  }
  for (const sev of ['P1', 'P2', 'P3', 'low']) {
    if (bySev[sev].length === 0) continue;
    console.log(`\n[${sev}] ${bySev[sev].length} finding${bySev[sev].length === 1 ? '' : 's'}:`);
    for (const f of bySev[sev].slice(0, maxPerSeverity)) {
      const loc = `${f.file || 'n/a'}${f.line ? ':' + f.line : ''}`;
      console.log(`  - ${loc} -- ${(f.issue || '').slice(0, 160)}`);
    }
    if (bySev[sev].length > maxPerSeverity) {
      console.log(`  ... and ${bySev[sev].length - maxPerSeverity} more`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log('Usage: xoloop-audit --target <path> [--severity-floor P2] [--max-rounds 10] [--read-only] [--proposal-only] [--allow-dirty]');
    console.log('');
    console.log('Modes:');
    console.log('  --read-only      Run codex audit only, skip Opus fixer');
    console.log('  --proposal-only  Run codex + Opus, show proposal, do NOT apply');
    console.log('  (default)        Full loop: codex audit -> Opus fix -> apply -> re-audit');
    process.exit(0);
  }

  const cwd = process.cwd();
  const target = parseFlag(argv, '--target', null);
  const severityFloor = parseFlag(argv, '--severity-floor', 'P2');
  const maxRounds = Number(parseFlag(argv, '--max-rounds', 10));
  const readOnly = hasFlag(argv, '--read-only');
  const proposalOnly = hasFlag(argv, '--proposal-only');
  const allowDirty = hasFlag(argv, '--allow-dirty');
  // Default to 15min — codex at high reasoning against a full framework
  // directory regularly exceeds the audit_caller default of 5min and fails
  // with CODEX_AUDIT_SPAWN_ERROR: ETIMEDOUT.
  const codexTimeoutMs = Number(parseFlag(argv, '--codex-timeout-ms', 900000));
  // Optional shell command run after each applied round to validate that
  // the fix didn't break functionality. Non-zero exit triggers automatic
  // changeSet rollback per audit_runner's runValidation contract.
  const validateCommand = parseFlag(argv, '--validate', null);
  const validateTimeoutMs = Number(parseFlag(argv, '--validate-timeout-ms', 600000));

  if (!target) {
    console.error('[xoloop-audit] --target is required.');
    process.exit(1);
  }

  ensureConfig(cwd);
  if (!readOnly && !proposalOnly) enforceDirtyOverlapGate(cwd, target, allowDirty);

  const targetAbs = path.resolve(target);
  const targetObj = {
    cwd,
    files: [targetAbs],
    description: `Audit ${target} for correctness and security issues.`,
  };

  // Read-only short-circuit: runAuditFixLoop always requires callFixer
  // (audit_runner fails closed on missing caller). For read-only audits
  // we bypass the loop and call codex directly so users can see findings
  // without paying for Opus inference.
  let result;
  if (readOnly) {
    const audit = await callAuditorWithCodex({
      target: targetObj,
      history: [],
      timeoutMs: codexTimeoutMs,
    });
    result = {
      rounds: 1,
      converged: !audit.findings || audit.findings.length === 0,
      reason: 'read-only',
      finalAudit: audit,
      history: [{ round: 1, audit, fix: null, status: 'read-only' }],
    };
  } else {
    // Wrap codex caller to thread the configured timeout through every round.
    const callAuditor = async (input) => callAuditorWithCodex({
      ...input,
      timeoutMs: codexTimeoutMs,
    });
    const loopOptions = {
      target: targetObj,
      callAuditor,
      callFixer: callFixerWithOpus,
      severityFloor,
      maxRounds,
    };
    if (!proposalOnly) {
      // Wire apply + rollback from change_set_engine. The engine enforces
      // realpath canonicalization, path-scope allowlist, verificationManifest
      // TOCTOU, atomic temp+rename, and snapshot rollback.
      loopOptions.applyChangeSet = async (changeSet) => {
        return applyChangeSet(changeSet, {
          cwd,
          allowedPaths: [targetAbs],
        });
      };
      loopOptions.rollbackChangeSet = async (handle) => {
        return rollbackAppliedChangeSet(handle);
      };
      // Wire test validation between rounds. If the user passed --validate,
      // run that shell command after each apply; a non-zero exit auto-
      // rollbacks the changeSet via audit_runner's runValidation contract.
      if (validateCommand) {
        loopOptions.runValidation = async ({ round }) => {
          const t0 = Date.now();
          const result = spawnSync('bash', ['-lc', validateCommand], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 32 * 1024 * 1024,
            timeout: validateTimeoutMs,
          });
          const elapsedMs = Date.now() - t0;
          const exitCode = result.status === null ? 1 : result.status;
          const passed = exitCode === 0;
          console.log(`[xoloop-audit] round ${round} validation: ${passed ? 'PASS' : 'FAIL'} (${elapsedMs}ms)`);
          if (!passed) {
            const tail = (result.stdout + '\n' + result.stderr).slice(-2000);
            console.log('[xoloop-audit] validation output tail:\n' + tail);
          }
          return { passed, exitCode, elapsedMs };
        };
      }
    }
    result = await runAuditFixLoop(loopOptions);
  }

  const findings = (result.finalAudit && result.finalAudit.findings) || [];
  const counts = summarizeBySeverity(findings);

  console.log('\n=== Audit Summary ===');
  console.log(`Rounds:     ${result.rounds}`);
  console.log(`Converged:  ${result.converged}`);
  if (result.reason) console.log(`Reason:     ${result.reason}`);
  console.log(`Total findings (last round): ${findings.length}`);
  console.log(`  P1=${counts.P1}  P2=${counts.P2}  P3=${counts.P3}  low=${counts.low}`);

  printFindings(findings);

  if (result.fix && Array.isArray(result.fix.changeSet) && result.fix.changeSet.length > 0) {
    console.log(`\n=== Fix proposal (${result.fix.changeSet.length} operation${result.fix.changeSet.length === 1 ? '' : 's'}) ===`);
    for (const op of result.fix.changeSet.slice(0, 20)) {
      console.log(`  [${op.kind || 'unknown'}] ${op.path || op.file || 'n/a'}`);
    }
    if (result.fix.changeSet.length > 20) {
      console.log(`  ... and ${result.fix.changeSet.length - 20} more`);
    }
  }

  // Round history (how many fixes landed per round)
  if (Array.isArray(result.history) && result.history.length > 0) {
    console.log('\n=== Round history ===');
    for (const h of result.history) {
      const fixNote = h.status === 'fixed' && h.fix && Array.isArray(h.fix.changeSet)
        ? ` (applied ${h.fix.changeSet.length} ops)`
        : '';
      console.log(`  Round ${h.round}: ${h.status}${fixNote}`);
    }
  }

  process.exit(result.error || (!result.converged && result.reason === 'validation-failed') ? 1 : 0);
}

main().catch((err) => {
  console.error('[xoloop-audit] Fatal:', err.message || err);
  if (err.code) console.error('  code:', err.code);
  if (err.fixHint) console.error('  hint:', err.fixHint);
  process.exit(1);
});
