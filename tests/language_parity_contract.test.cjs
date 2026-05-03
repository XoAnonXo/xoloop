'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  STATUS,
  SUPPORTED_LANGUAGES,
  USER_FACING_MODES,
  XO_MODES,
  buildLanguageParityMatrix,
  compareToReference,
} = require('../plugins/xoloop/lib/language_parity.cjs');

test('parity contract covers every supported language and mode', () => {
  const matrix = buildLanguageParityMatrix();

  assert.deepEqual(Object.keys(matrix), SUPPORTED_LANGUAGES);
  for (const language of SUPPORTED_LANGUAGES) {
    assert.deepEqual(Object.keys(matrix[language]), XO_MODES);
  }
});

test('public release gate covers exactly 11 user-facing modes', () => {
  assert.equal(USER_FACING_MODES.length, 11);
  assert.equal(USER_FACING_MODES.includes('init'), false);
  assert.deepEqual(
    USER_FACING_MODES,
    ['build', 'simplify', 'polish', 'fuzz', 'benchmark', 'improve', 'autoresearch', 'audit', 'docs', 'overnight', 'finalize'],
  );

  const matrix = buildLanguageParityMatrix();
  for (const language of SUPPORTED_LANGUAGES) {
    for (const mode of USER_FACING_MODES) {
      assert.equal(matrix[language][mode].status, STATUS.FULL, `${language}/${mode}`);
      assert.ok(matrix[language][mode].evidence.length > 0, `${language}/${mode} needs evidence`);
    }
  }
});

test('each parity cell has normalized evidence and missing fields', () => {
  const matrix = buildLanguageParityMatrix();

  for (const language of SUPPORTED_LANGUAGES) {
    for (const mode of XO_MODES) {
      const cell = matrix[language][mode];
      assert.equal(cell.language, language);
      assert.equal(cell.mode, mode);
      assert.ok(Object.values(STATUS).includes(cell.status));
      assert.ok(Array.isArray(cell.evidence));
      assert.ok(Array.isArray(cell.missing));
      if (cell.status === STATUS.FULL) {
        assert.ok(cell.evidence.length > 0, `${language}/${mode} needs evidence`);
      }
    }
  }
});

test('JS reference cells are full for all modes', () => {
  const matrix = buildLanguageParityMatrix();

  for (const language of ['javascript', 'typescript']) {
    for (const mode of XO_MODES) {
      if (language === 'typescript' && mode === 'fuzz') continue;
      assert.equal(matrix[language][mode].status, STATUS.FULL, `${language}/${mode}`);
    }
  }
});

test('compareToReference marks every current cell as full parity', () => {
  const comparisons = compareToReference();

  const jsBenchmark = comparisons.find((entry) => entry.language === 'javascript' && entry.mode === 'benchmark');
  const jsFuzz = comparisons.find((entry) => entry.language === 'javascript' && entry.mode === 'fuzz');

  assert.equal(comparisons.every((entry) => entry.fullParity), true);
  assert.equal(jsBenchmark.fullParity, true);
  assert.equal(jsFuzz.fullParity, true);
});
