const {
  extractJsonObjectFromText,
  normalizeText,
} = require('./baton_common.cjs');
const { callModel } = require('./model_router.cjs');

function resolveAuditProvider(config = {}, env = process.env) {
  const explicit = normalizeText(config.provider).toLowerCase() || 'auto';
  if (['synthetic', 'openai', 'anthropic', 'none', 'deferred', 'openai-compatible', 'external-command'].includes(explicit)) {
    return explicit;
  }
  if (normalizeText(env.OPENAI_API_KEY)) {
    return 'openai';
  }
  if (normalizeText(env.ANTHROPIC_API_KEY)) {
    return 'anthropic';
  }
  return 'none';
}

function buildAuditSystemPrompt() {
  return [
    'You are the independent overnight code audit gate.',
    'Return JSON only.',
    'You are not proposing new code.',
    'Only judge whether the attempted change should be accepted or rejected.',
    'Reject if the change violates invariants, weakens the proof, lacks test coverage for the claimed change, or is low-value churn.',
    'Accept only if the change is bounded, useful, validated, and consistent with the stated invariants.',
  ].join(' ');
}

function buildAuditUserPrompt(packet) {
  return JSON.stringify({
    packet,
    returnShape: {
      verdict: 'accept | reject',
      confidence: 0.75,
      blockers: ['concrete blockers'],
      evidence: ['concrete reasons'],
    },
  }, null, 2);
}

function parseAuditDecision(text) {
  const payload = JSON.parse(extractJsonObjectFromText(text, 'Audit response'));
  const verdict = normalizeText(payload.verdict).toLowerCase();
  if (!['accept', 'reject'].includes(verdict)) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError('AUDIT_VERDICT_INVALID', 'verdict', `Invalid audit verdict: ${payload.verdict}`, { fixHint: 'The audit model must return verdict "accept" or "reject".' });
  }
  const rawConfidence = Number(payload.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0;
  return {
    verdict,
    confidence,
    blockers: Array.isArray(payload.blockers)
      ? payload.blockers.map((entry) => normalizeText(entry)).filter(Boolean)
      : [],
    evidence: Array.isArray(payload.evidence)
      ? payload.evidence.map((entry) => normalizeText(entry)).filter(Boolean)
      : [],
  };
}

async function runAuditGate(options = {}) {
  const packet = options.packet || {};
  if (options.syntheticDecision) {
    return {
      ...options.syntheticDecision,
      provider: 'synthetic',
      model: 'synthetic-audit-gate',
    };
  }
  if (typeof options.reviewLoader === 'function') {
    return options.reviewLoader(options);
  }
  const provider = resolveAuditProvider(options.config, options.env);
  if (provider === 'none') {
    return {
      verdict: 'reject',
      confidence: 1,
      blockers: ['No heterogeneous audit provider is configured.'],
      evidence: [],
      provider: 'none',
      model: null,
    };
  }
  if (provider === 'deferred') {
    return {
      verdict: 'deferred',
      confidence: 1,
      blockers: ['Deferred to Codex review.'],
      evidence: ['Local validation passed and this attempt is waiting for a live Codex audit.'],
      provider: 'deferred',
      model: null,
    };
  }

  const response = await callModel({
    ...(options.config || {}),
    provider,
    mode: 'audit',
    schema: { type: 'json_object' },
    systemPrompt: buildAuditSystemPrompt(),
    userPrompt: buildAuditUserPrompt(packet),
    fetchImpl: options.fetchFn,
  });
  return {
    ...parseAuditDecision(response.text),
    provider: response.provider,
    model: response.model,
  };
}

module.exports = {
  buildAuditSystemPrompt,
  buildAuditUserPrompt,
  parseAuditDecision,
  resolveAuditProvider,
  runAuditGate,
};
