const {
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_MODEL,
  callModel,
  resolveModelConfig,
} = require('./model_router.cjs');
const { normalizeText } = require('./baton_common.cjs');

const DEFAULT_MINIMAX_API_KEY_ENV = 'MINIMAX_API_KEY';

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveMinimaxConfig(overrides = {}, env = process.env) {
  const safeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  // Audit P3#8: normalize env before any attribute access. The `= process.env`
  // default only fires when env is undefined; passing null previously threw a raw
  // TypeError at `env.MINIMAX_BASE_URL`. Falling back to process.env on null/non-
  // object input preserves the default behavior and matches the normalization
  // pattern already used inside resolveModelConfig.
  const safeEnv = (env && typeof env === 'object') ? env : process.env;
  const providerConfig = resolveModelConfig({
    ...safeOverrides,
    provider: 'minimax',
    apiKeyEnv: normalizeText(safeOverrides.apiKeyEnv) || DEFAULT_MINIMAX_API_KEY_ENV,
    baseUrl: normalizeText(safeOverrides.baseUrl) || normalizeText(safeEnv.MINIMAX_BASE_URL) || DEFAULT_MINIMAX_BASE_URL,
    model: normalizeText(safeOverrides.model) || normalizeText(safeEnv.MINIMAX_MODEL) || DEFAULT_MINIMAX_MODEL,
    timeoutMs: Math.max(1000, normalizeNumber(safeOverrides.timeoutMs, 120000)),
    temperature: normalizeNumber(safeOverrides.temperature, 1),
  }, safeEnv);
  return {
    ...providerConfig,
    reasoningSplit: safeOverrides.reasoningSplit !== false,
  };
}

function buildMinimaxRequest(options) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const config = resolveMinimaxConfig(safeOptions, safeOptions.env);
  const messages = Array.isArray(safeOptions.messages) && safeOptions.messages.length > 0
    ? safeOptions.messages.map((message) => ({
      role: normalizeText(message.role) || 'user',
      content: message.content,
    }))
    : [
      normalizeText(safeOptions.systemPrompt) ? { role: 'system', content: safeOptions.systemPrompt } : null,
      normalizeText(safeOptions.userPrompt) ? { role: 'user', content: safeOptions.userPrompt } : null,
    ].filter(Boolean);
  if (messages.length === 0) {
    const { AdapterError } = require('./errors.cjs');
    throw new AdapterError(
      'MINIMAX_MESSAGES_REQUIRED',
      'messages',
      'MiniMax request must include messages or systemPrompt/userPrompt',
      { fixHint: 'Provide at least one message via options.messages, or set options.systemPrompt / options.userPrompt.' },
    );
  }
  const request = {
    model: config.model,
    messages,
    temperature: config.temperature,
  };
  const maxCompletionTokens = normalizeNumber(safeOptions.maxCompletionTokens, null);
  if (Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0) {
    request.max_completion_tokens = Math.round(maxCompletionTokens);
  }
  if (config.reasoningSplit) {
    request.extra_body = { reasoning_split: true };
  }
  return request;
}

async function callMinimaxChat(options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const config = resolveMinimaxConfig(safeOptions, safeOptions.env);
  return callModel({
    ...safeOptions,
    ...config,
    provider: 'minimax',
  });
}

module.exports = {
  DEFAULT_MINIMAX_API_KEY_ENV,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_MODEL,
  buildMinimaxRequest,
  callMinimaxChat,
  resolveMinimaxConfig,
};
