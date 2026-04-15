'use strict';

/**
 * autoresearch_naked_ast.cjs — strip comments, docstrings, and persuasive prose
 * from a proposal before the AutoReason council sees it.
 *
 * Per AutoReason SPEC v2 (Gemini's critique): LLM judges are biased toward
 * verbose JSDoc, ceremonial error handling, and enterprise-pattern bloat.
 * Judging the naked AST removes that bias so judges score what the code
 * DOES, not how it is dressed.
 *
 * Pipeline:
 *   stripComments → stripBlankLines → stripTrailingWhitespace
 *
 * For proposal objects: extractCodeOnly discards hypothesis/why/rationale
 * fields so the judge cannot anchor on the proposer's sales pitch.
 */

const { AdapterError } = require('./errors.cjs');

const PROSE_KEYS_TO_STRIP = Object.freeze([
  'hypothesis',
  'hypothesisId',
  'why',
  'rationale',
  'summary',
  'expectedImpact',
  'validationNotes',
]);

function stripComments(source) {
  if (source === null || source === undefined) {
    return '';
  }
  if (typeof source !== 'string') {
    throw new AdapterError(
      'NAKED_AST_SOURCE_MUST_BE_STRING',
      'source',
      'stripComments requires a string source',
      { fixHint: 'Pass the source code as a string.' },
    );
  }
  const length = source.length;
  let output = '';
  let index = 0;
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const newlineIndex = source.indexOf('\n', index);
      if (newlineIndex === -1) {
        break;
      }
      index = newlineIndex;
      continue;
    }
    if (char === '/' && next === '*') {
      const closeIndex = source.indexOf('*/', index + 2);
      if (closeIndex === -1) {
        break;
      }
      index = closeIndex + 2;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      const quote = char;
      output += char;
      index += 1;
      while (index < length) {
        const current = source[index];
        output += current;
        if (current === '\\' && index + 1 < length) {
          output += source[index + 1];
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function stripBlankLines(source) {
  if (!source) {
    return '';
  }
  return String(source)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

function stripTrailingWhitespace(source) {
  if (!source) {
    return '';
  }
  return String(source)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

function nakedizeCode(source) {
  return stripBlankLines(stripTrailingWhitespace(stripComments(source)));
}

function extractCodeOnly(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    throw new AdapterError(
      'NAKED_AST_PROPOSAL_REQUIRED',
      'proposal',
      'extractCodeOnly requires a proposal object',
      { fixHint: 'Pass the proposal object whose code fields should be nakedized.' },
    );
  }
  const changeSet = Array.isArray(proposal.changeSet) ? proposal.changeSet : [];
  const nakedChangeSet = changeSet.map((change) => {
    const copy = { kind: change.kind, path: change.path };
    if (typeof change.match === 'string') {
      copy.match = nakedizeCode(change.match);
    }
    if (typeof change.replace === 'string') {
      copy.replace = nakedizeCode(change.replace);
    }
    if (typeof change.anchor === 'string') {
      copy.anchor = nakedizeCode(change.anchor);
    }
    if (typeof change.text === 'string') {
      copy.text = nakedizeCode(change.text);
    }
    return copy;
  });
  const result = {
    changeSet: nakedChangeSet,
    targetFiles: Array.isArray(proposal.targetFiles) ? proposal.targetFiles.slice() : [],
  };
  return result;
}

function buildJudgeInputPacket(proposal) {
  return {
    naked: extractCodeOnly(proposal),
    stripped: PROSE_KEYS_TO_STRIP.filter((key) => Object.prototype.hasOwnProperty.call(proposal, key)),
  };
}

module.exports = {
  PROSE_KEYS_TO_STRIP,
  buildJudgeInputPacket,
  extractCodeOnly,
  nakedizeCode,
  stripBlankLines,
  stripComments,
  stripTrailingWhitespace,
};
