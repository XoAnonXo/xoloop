'use strict';

/**
 * autoresearch_tournament.cjs — Champion vs Challenger tournament for
 * AutoReason subjective judging.
 *
 * Per SPEC v2: AB synthesis is explicitly killed. Tournament runs only
 * between A (unchanged champion) and B (research-proposed challenger).
 * If B loses, the research agent spawns a fresh Challenger C with the
 * judges' critique as context — not a synthesized hybrid.
 *
 * The council is heterogeneous and blind: three judges with different
 * weight biases (architect / pragmatist / hacker) score both candidates
 * on the 1-5 anchored rubric without knowing which is the incumbent.
 *
 * This module orchestrates the round. LLM access is injected via the
 * callJudge dependency so tests can run with deterministic mock judges.
 */

const { AdapterError } = require('./errors.cjs');
const {
  aggregateBallots,
  hasAbsoluteVeto,
  isContested,
} = require('./autoresearch_rubric.cjs');
const { buildJudgeInputPacket } = require('./autoresearch_naked_ast.cjs');

const JUDGE_ROLES = Object.freeze([
  Object.freeze({
    id: 'architect',
    description: 'Weighs structural correctness and patterns that scale in large codebases.',
  }),
  Object.freeze({
    id: 'pragmatist',
    description: 'Weighs simplicity and cost efficiency above elegance.',
  }),
  Object.freeze({
    id: 'hacker',
    description: 'Weighs brevity and whether the code actually works end-to-end.',
  }),
]);

const CANDIDATE_LABELS = Object.freeze(['A', 'B']);
const TWO_CONSECUTIVE_WINS = 2;

function assertCandidate(candidate, label) {
  if (!candidate || typeof candidate !== 'object') {
    throw new AdapterError(
      'TOURNAMENT_CANDIDATE_REQUIRED',
      label,
      `Tournament candidate ${label} must be an object with a changeSet or content field`,
      { fixHint: 'Pass both champion and challenger as proposal-shaped objects.' },
    );
  }
}

function buildJudgeSystemPrompt(role) {
  if (!role || !role.id) {
    throw new AdapterError(
      'TOURNAMENT_ROLE_REQUIRED',
      'role',
      'buildJudgeSystemPrompt requires a judge role with an id',
      { fixHint: 'Pass one of the JUDGE_ROLES entries.' },
    );
  }
  return [
    'You are a blind judge on the AutoReason council.',
    `Your role is ${role.id}. ${role.description}`,
    'You will see two naked code candidates labeled A and B.',
    'You do NOT know which one is the incumbent — judge strictly on the code.',
    'Do NOT score correctness; the objective gate already proved both candidates pass tests.',
    'Return JSON only with keys candidateA and candidateB, each an object with simplicity, cost, maintainability, readability, rationale.',
    'Each score must be an integer 1-5 following the anchored rubric supplied in the user message.',
  ].join(' ');
}

function safeJsonStringify(value, indent) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) {
        return '[Circular]';
      }
      seen.add(val);
    }
    if (typeof val === 'function') {
      return '[Function]';
    }
    return val;
  }, indent);
}

function buildJudgeUserPrompt(candidateA, candidateB, rubricInstructions) {
  const packetA = buildJudgeInputPacket(candidateA);
  const packetB = buildJudgeInputPacket(candidateB);
  return safeJsonStringify({
    rubric: rubricInstructions,
    candidates: {
      A: packetA.naked,
      B: packetB.naked,
    },
    returnShape: {
      candidateA: {
        simplicity: 'integer 1-5',
        cost: 'integer 1-5',
        maintainability: 'integer 1-5',
        readability: 'integer 1-5',
        rationale: 'short sentence citing naked AST evidence',
      },
      candidateB: {
        simplicity: 'integer 1-5',
        cost: 'integer 1-5',
        maintainability: 'integer 1-5',
        readability: 'integer 1-5',
        rationale: 'short sentence citing naked AST evidence',
      },
    },
  }, null, 2);
}

function pickWinner(options) {
  const safe = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const champion = safe.champion;
  const challenger = safe.challenger;
  if (!challenger || typeof challenger !== 'object') {
    return 'champion';
  }
  if (challenger.veto === true) {
    return 'champion';
  }
  if (!champion || typeof champion !== 'object'
      || !champion.aggregate || !champion.aggregate.composite
      || !challenger.aggregate || !challenger.aggregate.composite) {
    return 'champion';
  }
  const championMean = Number(champion.aggregate.composite.mean);
  const challengerMean = Number(challenger.aggregate.composite.mean);
  if (!Number.isFinite(championMean) || !Number.isFinite(challengerMean)) {
    return 'champion';
  }
  if (challengerMean > championMean) {
    return 'challenger';
  }
  return 'champion';
}

async function runRound(options) {
  if (!options || typeof options !== 'object') {
    throw new AdapterError(
      'TOURNAMENT_OPTIONS_REQUIRED',
      'options',
      'runRound requires an options object',
      { fixHint: 'Pass options with champion, challenger, and callJudge.' },
    );
  }
  const { champion, challenger, callJudge } = options;
  assertCandidate(champion, 'champion');
  assertCandidate(challenger, 'challenger');
  if (typeof callJudge !== 'function') {
    throw new AdapterError(
      'TOURNAMENT_CALL_JUDGE_REQUIRED',
      'callJudge',
      'runRound requires a callJudge function',
      { fixHint: 'Inject a callJudge function that takes { role, candidateA, candidateB } and returns ballots.' },
    );
  }
  const judgeRoles = Array.isArray(options.judgeRoles) && options.judgeRoles.length > 0
    ? options.judgeRoles
    : JUDGE_ROLES;

  const ballotPromises = judgeRoles.map((role) => Promise.resolve(callJudge({
    role,
    candidateA: champion,
    candidateB: challenger,
  })));
  const ballots = await Promise.all(ballotPromises);

  const championBallots = ballots.map((ballot) => ballot.candidateA);
  const challengerBallots = ballots.map((ballot) => ballot.candidateB);

  const championAggregate = aggregateBallots(championBallots);
  const challengerAggregate = aggregateBallots(challengerBallots);

  const challengerVeto = hasAbsoluteVeto(challengerBallots);
  const championContested = isContested(championBallots);
  const challengerContested = isContested(challengerBallots);

  const champion_result = {
    aggregate: championAggregate,
    ballots: championBallots,
    contested: championContested,
  };
  const challenger_result = {
    aggregate: challengerAggregate,
    ballots: challengerBallots,
    contested: challengerContested,
    veto: challengerVeto,
  };

  const winner = pickWinner({ champion: champion_result, challenger: challenger_result });

  return {
    winner,
    champion: champion_result,
    challenger: challenger_result,
    contested: championContested || challengerContested,
    judgeCount: judgeRoles.length,
  };
}

function hasConverged(history) {
  if (!Array.isArray(history) || history.length < TWO_CONSECUTIVE_WINS) {
    return false;
  }
  const tail = history.slice(-TWO_CONSECUTIVE_WINS);
  return tail.every((result) => result && result.winner === 'champion');
}

async function runTournament(options) {
  if (!options || typeof options !== 'object') {
    throw new AdapterError(
      'TOURNAMENT_OPTIONS_REQUIRED',
      'options',
      'runTournament requires an options object',
      { fixHint: 'Pass options with champion, challengerFactory, and callJudge.' },
    );
  }
  const { champion, callJudge } = options;
  assertCandidate(champion, 'champion');
  if (typeof callJudge !== 'function') {
    throw new AdapterError(
      'TOURNAMENT_CALL_JUDGE_REQUIRED',
      'callJudge',
      'runTournament requires a callJudge function',
      { fixHint: 'Inject a callJudge that returns { candidateA, candidateB } ballots.' },
    );
  }
  const challengerFactory = options.challengerFactory;
  if (typeof challengerFactory !== 'function') {
    throw new AdapterError(
      'TOURNAMENT_FACTORY_REQUIRED',
      'challengerFactory',
      'runTournament requires a challengerFactory that produces a new Challenger per round',
      { fixHint: 'Pass a challengerFactory function that takes ({ round, previousChampion, history }) and returns a challenger proposal.' },
    );
  }
  const maxRounds = Math.max(1, Math.floor(Number(options.maxRounds) || 5));
  const judgeRoles = options.judgeRoles;

  const history = [];
  let currentChampion = champion;

  for (let round = 1; round <= maxRounds; round += 1) {
    const challenger = await challengerFactory({
      round,
      previousChampion: currentChampion,
      history: history.slice(),
    });
    if (!challenger) {
      break;
    }
    const roundResult = await runRound({
      champion: currentChampion,
      challenger,
      callJudge,
      judgeRoles,
    });
    const enrichedResult = { ...roundResult, round };
    history.push(enrichedResult);
    if (enrichedResult.winner === 'challenger') {
      currentChampion = challenger;
    }
    if (hasConverged(history)) {
      break;
    }
  }

  return {
    finalChampion: currentChampion,
    history,
    converged: hasConverged(history),
    rounds: history.length,
  };
}

module.exports = {
  CANDIDATE_LABELS,
  JUDGE_ROLES,
  TWO_CONSECUTIVE_WINS,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  hasConverged,
  pickWinner,
  runRound,
  runTournament,
};
