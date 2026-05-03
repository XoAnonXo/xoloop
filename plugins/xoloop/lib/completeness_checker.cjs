'use strict';

const {
  EVIDENCE_LEVEL,
  LIVE_AGENTIC_MODES,
  STATUS,
  SUPPORTED_LANGUAGES,
  USER_FACING_MODES,
  XO_MODES,
  buildLanguageParityMatrix,
  compareToReference,
} = require('./language_parity.cjs');
const { summarizeLiveAgentEvidence } = require('./live_agent_provider.cjs');

function summarizeCompleteness(options = {}) {
  const matrix = buildLanguageParityMatrix(options.capabilities);
  const comparisons = compareToReference(matrix);
  const liveEvidenceSummary = options.liveAgenticEvidence
    ? summarizeLiveAgentEvidence(options.liveAgenticEvidence, { allowTestEvidence: options.allowTestEvidence === true })
    : null;
  const requiredCells = SUPPORTED_LANGUAGES.length * XO_MODES.length;
  const fullCells = comparisons.filter((entry) => entry.fullParity).length;
  const incomplete = comparisons.filter((entry) => !entry.fullParity);
  const userModeRequired = comparisons.filter((entry) => USER_FACING_MODES.includes(entry.mode));
  const userModeFull = userModeRequired.filter((entry) => entry.fullParity);
  const userModeIncomplete = userModeRequired.filter((entry) => !entry.fullParity);
  const liveAgenticRequired = comparisons.filter((entry) => LIVE_AGENTIC_MODES.includes(entry.mode));
  const liveAgenticVerified = liveAgenticRequired.filter((entry) => {
    if (!entry.fullParity) return false;
    if (entry.evidenceLevel === EVIDENCE_LEVEL.LIVE_AGENTIC) return true;
    return Boolean(liveEvidenceSummary && (
      liveEvidenceSummary.byLanguageMode[`${entry.language}/${entry.mode}`]
    ));
  });
  const liveAgenticIncomplete = liveAgenticRequired.filter(
    (entry) => !entry.fullParity || !liveAgenticVerified.includes(entry),
  );
  const byLanguage = {};
  const byMode = {};

  for (const language of SUPPORTED_LANGUAGES) {
    const entries = comparisons.filter((entry) => entry.language === language);
    byLanguage[language] = {
      full: entries.filter((entry) => entry.fullParity).length,
      required: XO_MODES.length,
      complete: entries.every((entry) => entry.fullParity),
      userModeFull: entries.filter((entry) => USER_FACING_MODES.includes(entry.mode) && entry.fullParity).length,
      userModeRequired: USER_FACING_MODES.length,
      userModeComplete: entries
        .filter((entry) => USER_FACING_MODES.includes(entry.mode))
        .every((entry) => entry.fullParity),
      liveAgenticFull: entries.filter(
        (entry) => LIVE_AGENTIC_MODES.includes(entry.mode)
          && entry.fullParity
          && liveAgenticVerified.includes(entry),
      ).length,
      liveAgenticRequired: LIVE_AGENTIC_MODES.length,
      liveAgenticComplete: entries
        .filter((entry) => LIVE_AGENTIC_MODES.includes(entry.mode))
        .every((entry) => entry.fullParity && liveAgenticVerified.includes(entry)),
    };
  }

  for (const mode of XO_MODES) {
    const entries = comparisons.filter((entry) => entry.mode === mode);
    byMode[mode] = {
      full: entries.filter((entry) => entry.fullParity).length,
      required: SUPPORTED_LANGUAGES.length,
      complete: entries.every((entry) => entry.fullParity),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    complete: fullCells === requiredCells,
    adapterComplete: fullCells === requiredCells,
    userModeComplete: userModeFull.length === userModeRequired.length,
    liveAgenticComplete: liveAgenticVerified.length === liveAgenticRequired.length,
    score: {
      fullCells,
      requiredCells,
      percent: requiredCells === 0 ? 100 : Number(((fullCells / requiredCells) * 100).toFixed(2)),
    },
    userModeScore: {
      fullCells: userModeFull.length,
      requiredCells: userModeRequired.length,
      percent: userModeRequired.length === 0
        ? 100
        : Number(((userModeFull.length / userModeRequired.length) * 100).toFixed(2)),
    },
    liveAgenticScore: {
      fullCells: liveAgenticVerified.length,
      requiredCells: liveAgenticRequired.length,
      percent: liveAgenticRequired.length === 0
        ? 100
        : Number(((liveAgenticVerified.length / liveAgenticRequired.length) * 100).toFixed(2)),
    },
    languages: SUPPORTED_LANGUAGES.slice(),
    modes: XO_MODES.slice(),
    userFacingModes: USER_FACING_MODES.slice(),
    liveAgenticModes: LIVE_AGENTIC_MODES.slice(),
    liveAgenticEvidence: liveEvidenceSummary,
    statusValues: Object.values(STATUS),
    byLanguage,
    byMode,
    matrix,
    incomplete,
    userModeIncomplete,
    liveAgenticIncomplete,
  };
}

function statusIcon(status, fullParity) {
  if (fullParity) return 'FULL';
  return String(status || STATUS.MISSING).toUpperCase();
}

function formatCompletenessReport(summary) {
  const safeSummary = summary || summarizeCompleteness();
  const lines = [];
  lines.push('=== XOLoop Language Completeness ===');
  lines.push(`Adapter complete: ${safeSummary.adapterComplete ? 'yes' : 'no'}`);
  lines.push(`Adapter score: ${safeSummary.score.fullCells}/${safeSummary.score.requiredCells} (${safeSummary.score.percent}%)`);
  lines.push(`11-mode complete: ${safeSummary.userModeComplete ? 'yes' : 'no'}`);
  lines.push(`11-mode score: ${safeSummary.userModeScore.fullCells}/${safeSummary.userModeScore.requiredCells} (${safeSummary.userModeScore.percent}%)`);
  lines.push(`Live-agentic complete: ${safeSummary.liveAgenticComplete ? 'yes' : 'no'}`);
  lines.push(`Live-agentic score: ${safeSummary.liveAgenticScore.fullCells}/${safeSummary.liveAgenticScore.requiredCells} (${safeSummary.liveAgenticScore.percent}%)`);
  lines.push('');
  lines.push(['Language'.padEnd(12), ...safeSummary.modes.map((mode) => mode.padEnd(12))].join(' '));
  for (const language of safeSummary.languages) {
    const cells = safeSummary.modes.map((mode) => {
      const cell = safeSummary.matrix[language][mode];
      const fullParity = cell.status === STATUS.FULL;
      return statusIcon(cell.status, fullParity).padEnd(12);
    });
    lines.push([language.padEnd(12), ...cells].join(' '));
  }
  if (safeSummary.incomplete.length > 0) {
    lines.push('');
    lines.push('Incomplete cells:');
    for (const entry of safeSummary.incomplete) {
      const reasons = entry.missing && entry.missing.length > 0
        ? entry.missing.join('; ')
        : entry.blockedReason || 'missing full parity evidence';
      lines.push(`- ${entry.language}/${entry.mode}: ${entry.status} — ${reasons}`);
    }
  }
  if (safeSummary.liveAgenticIncomplete.length > 0) {
    lines.push('');
    lines.push('Live-agentic cells needing subagent/API proof:');
    for (const entry of safeSummary.liveAgenticIncomplete) {
      const reason = entry.fullParity
        ? `only ${entry.evidenceLevel} evidence recorded`
        : (entry.missing && entry.missing.length > 0 ? entry.missing.join('; ') : 'missing full parity evidence');
      lines.push(`- ${entry.language}/${entry.mode}: ${reason}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  formatCompletenessReport,
  summarizeCompleteness,
};
