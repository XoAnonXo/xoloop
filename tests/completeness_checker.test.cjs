'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  summarizeCompleteness,
  formatCompletenessReport,
} = require('../plugins/xoloop/lib/completeness_checker.cjs');
const {
  EVIDENCE_LEVEL,
  STATUS,
  SUPPORTED_LANGUAGES,
  USER_FACING_MODES,
  XO_MODES,
} = require('../plugins/xoloop/lib/language_parity.cjs');

function cell(status = STATUS.FULL, missing = [], evidenceLevel = EVIDENCE_LEVEL.LOCAL) {
  return {
    status,
    evidence: status === STATUS.FULL ? ['test evidence'] : [],
    evidenceLevel,
    missing,
    blockedReason: null,
  };
}

function fullCapabilities() {
  return Object.fromEntries(
    SUPPORTED_LANGUAGES.map((language) => [
      language,
      Object.fromEntries(XO_MODES.map((mode) => [mode, cell()])),
    ]),
  );
}

test('summarizeCompleteness passes only when every language/mode is full', () => {
  const summary = summarizeCompleteness({ capabilities: fullCapabilities() });

  assert.equal(summary.complete, true);
  assert.equal(summary.adapterComplete, true);
  assert.equal(summary.userModeComplete, true);
  assert.equal(summary.liveAgenticComplete, false);
  assert.equal(summary.score.fullCells, SUPPORTED_LANGUAGES.length * XO_MODES.length);
  assert.equal(summary.userModeScore.fullCells, SUPPORTED_LANGUAGES.length * USER_FACING_MODES.length);
  assert.equal(summary.incomplete.length, 0);
  assert.equal(summary.liveAgenticIncomplete.length > 0, true);
});

test('summarizeCompleteness fails a single non-JS partial cell', () => {
  const capabilities = fullCapabilities();
  capabilities.python.fuzz = cell(STATUS.PARTIAL, ['missing Python fuzz harness']);

  const summary = summarizeCompleteness({ capabilities });

  assert.equal(summary.complete, false);
  assert.equal(summary.adapterComplete, false);
  assert.equal(summary.userModeComplete, false);
  assert.equal(summary.score.fullCells, (SUPPORTED_LANGUAGES.length * XO_MODES.length) - 1);
  assert.deepEqual(
    summary.incomplete.map((entry) => `${entry.language}/${entry.mode}:${entry.status}`),
    ['python/fuzz:partial'],
  );
});

test('current matrix reaches full local adapter language parity without claiming live-agentic proof', () => {
  const summary = summarizeCompleteness();

  assert.equal(summary.adapterComplete, true);
  assert.equal(summary.userModeComplete, true);
  assert.equal(summary.liveAgenticComplete, false);
  assert.equal(summary.incomplete.length, 0);
  assert.equal(summary.score.fullCells, summary.score.requiredCells);
  assert.equal(summary.userModeScore.fullCells, summary.userModeScore.requiredCells);
  assert.match(
    summary.liveAgenticIncomplete.map((entry) => `${entry.language}/${entry.mode}`).join('\n'),
    /java\/audit/,
  );
});

test('formatCompletenessReport includes score and incomplete reasons', () => {
  const capabilities = fullCapabilities();
  capabilities.go.docs = cell(STATUS.MISSING, ['missing Go docs adapter']);
  const report = formatCompletenessReport(summarizeCompleteness({ capabilities }));

  assert.match(report, /Adapter complete: no/);
  assert.match(report, /11-mode complete: no/);
  assert.match(report, /Live-agentic complete: no/);
  assert.match(report, /go\/docs: missing/);
  assert.match(report, /missing Go docs adapter/);
});

test('live-agentic evidence can be required separately from local adapter parity', () => {
  const capabilities = fullCapabilities();
  for (const language of SUPPORTED_LANGUAGES) {
    for (const mode of ['build', 'polish', 'autoresearch', 'audit', 'overnight']) {
      capabilities[language][mode] = cell(STATUS.FULL, [], EVIDENCE_LEVEL.LIVE_AGENTIC);
    }
  }

  const summary = summarizeCompleteness({ capabilities });

  assert.equal(summary.adapterComplete, true);
  assert.equal(summary.userModeComplete, true);
  assert.equal(summary.liveAgenticComplete, true);
  assert.equal(summary.liveAgenticIncomplete.length, 0);
});

test('language-less production live evidence is not enough for per-language live proof', () => {
  const summary = summarizeCompleteness({
    liveAgenticEvidence: ['build', 'polish', 'autoresearch', 'audit', 'overnight'].map((mode) => ({
      ok: true,
      evidenceKind: 'production-live',
      mode,
    })),
  });

  assert.equal(summary.liveAgenticComplete, false);
  assert.equal(summary.liveAgenticScore.fullCells, 0);
  assert.match(
    summary.liveAgenticIncomplete.map((entry) => `${entry.language}/${entry.mode}`).join('\n'),
    /javascript\/build/,
  );
});
