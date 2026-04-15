'use strict';

const { spawn } = require('node:child_process');

const { extractJsonObjectFromText, normalizeText } = require('./baton_common.cjs');
const { AdapterError } = require('./errors.cjs');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_RETRY_DELAY_MS = 3000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-5';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.7-highspeed';

// ── Hard ceilings (audit P1/P2 fixes) ────────────────────────────────
// Response-body cap: prevent OOM from an untrusted provider returning multi-GB bodies.
// Default 8MB; caller may raise via options.maxResponseBytes up to the hard ceiling.
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES_CEILING = 64 * 1024 * 1024;
// Retry-budget caps: prevent a caller from requesting years of retries.
const MAX_ATTEMPTS_CEILING = 10;
const MAX_RETRY_DELAY_MS_CEILING = 60000;
const MAX_TOTAL_RETRY_MS = 300000;
// Embedded-text cap in error messages (so logs don't balloon with provider bodies).
const ERROR_MESSAGE_EMBED_CAP_BYTES = 1024;
// Grace period after SIGTERM before SIGKILL on external-command timeout.
const EXTERNAL_COMMAND_KILL_GRACE_MS = 2000;

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function buildMessages(options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  if (Array.isArray(safeOptions.messages) && safeOptions.messages.length > 0) {
    return safeOptions.messages.map((message) => ({
      role: normalizeText(message.role) || 'user',
      content: message.content,
    }));
  }
  const messages = [];
  if (normalizeText(safeOptions.systemPrompt)) {
    messages.push({ role: 'system', content: safeOptions.systemPrompt });
  }
  if (normalizeText(safeOptions.userPrompt)) {
    messages.push({ role: 'user', content: safeOptions.userPrompt });
  }
  return messages;
}

function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item.text === 'string') {
        return item.text;
      }
      if (item && typeof item.output_text === 'string') {
        return item.output_text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractReasoningText(details) {
  if (!Array.isArray(details)) {
    return '';
  }
  return details
    .map((detail) => (detail && typeof detail.text === 'string' ? detail.text : ''))
    .filter(Boolean)
    .join('\n');
}

function wantsStructuredOutput(options = {}) {
  return Boolean(options.schema);
}

// ── Secret redaction (audit P1#3) ────────────────────────────────────
// Replace key-shaped tokens before embedding provider bodies into error messages
// so a malicious provider cannot echo Authorization headers, env-var secrets, or
// AWS credentials back into logs via the error chain.
//
// Patterns covered:
//   sk-XXXX… / pk-XXXX…  — OpenAI/Stripe-style prefixed keys
//   Bearer <token>        — HTTP authorization header echoes
//   eyJ…                  — JWT bodies
//   AKIA[0-9A-Z]{16}      — AWS access-key IDs
//   "<kw>": "<value>"     — api_key/secret/password/token/etc JSON fields
//   <kw>=<value>          — env-style KEY=VALUE pairs
const SECRET_TOKEN_PATTERNS = /sk-[A-Za-z0-9_\-]{20,}|pk-[A-Za-z0-9_\-]{20,}|Bearer\s+\S+|eyJ[A-Za-z0-9_\-.]{20,}|AKIA[0-9A-Z]{16}/g;
const SECRET_KEYWORDS_RE = /(api[_-]?key|secret|bearer|authorization|password|token)/i;
// Key:value inside JSON-ish bodies ("api_key": "…" / "api-key":"…").
const SECRET_JSON_FIELD_RE = /(["']?)(api[_-]?key|secret|bearer|authorization|password|token)\1\s*[:=]\s*(["'])((?:(?!\3).){1,256})\3/gi;
// KEY=VALUE in env-style strings (MINIMAX_API_KEY=xyz, AUTHORIZATION=Bearer xyz…).
const SECRET_ENV_KV_RE = /([A-Z][A-Z0-9_]*(?:API[_-]?KEY|SECRET|BEARER|AUTHORIZATION|PASSWORD|TOKEN)[A-Z0-9_]*)\s*=\s*(\S+)/gi;

function redactSecrets(raw) {
  if (raw === null || raw === undefined) return '';
  let text;
  try {
    text = typeof raw === 'string' ? raw : String(raw);
  } catch (_) {
    return '';
  }
  return text
    .replace(SECRET_JSON_FIELD_RE, (_match, q1, key, q3) => `${q1}${key}${q1}: ${q3}[REDACTED]${q3}`)
    .replace(SECRET_ENV_KV_RE, (_match, key) => `${key}=[REDACTED]`)
    .replace(SECRET_TOKEN_PATTERNS, '[REDACTED]')
    // Also zap any bare keyword-prefixed token not caught above (defensive).
    .replace(/(api[_-]?key|secret|bearer|authorization|password|token)\s*[:=]\s*([^\s,}"']+)/gi, (_m, kw) => `${kw}=[REDACTED]`);
}

function redactAndCap(raw, maxLen = ERROR_MESSAGE_EMBED_CAP_BYTES) {
  const redacted = redactSecrets(raw).replace(/[\x00-\x1f]/g, ' ');
  if (redacted.length <= maxLen) {
    return redacted;
  }
  return `${redacted.slice(0, maxLen)}...`;
}

// Back-compat name for the snippet helper used inside maybeParseStructured. Same
// behavior as redactAndCap with a shorter default so inline snippets stay terse.
function redactSnippet(raw, maxLen = 80) {
  return redactAndCap(raw, maxLen);
}

// Audit P2#6: truncation detection. Providers signal "response was cut off mid-way
// because we hit the token limit" via finish_reason='length' (OpenAI/MiniMax) or
// stop_reason='max_tokens' (Anthropic). Treating these as normal completions hands
// partial JSON/code to downstream code, which is unsafe. Default behavior throws
// MODEL_RESPONSE_TRUNCATED; callers opt into partial responses via acceptTruncated:true.
const TRUNCATION_SIGNALS = Object.freeze(['length', 'max_tokens', 'max-tokens']);

function detectTruncation({ finishReason, stopReason } = {}) {
  const signals = [finishReason, stopReason].filter((v) => typeof v === 'string');
  for (const raw of signals) {
    const norm = String(raw).trim().toLowerCase();
    if (TRUNCATION_SIGNALS.includes(norm)) {
      return { truncated: true, reason: raw };
    }
  }
  return { truncated: false, reason: null };
}

function enforceTruncationPolicy(result, options = {}) {
  // result already has finishReason populated by the provider adapters.
  const finishReason = result && typeof result.finishReason === 'string' ? result.finishReason : null;
  // The raw response may also expose stop_reason (Anthropic) or choices[0].finish_reason (OpenAI).
  const raw = result && result.raw;
  let altStopReason = null;
  if (raw && typeof raw === 'object') {
    if (typeof raw.stop_reason === 'string') {
      altStopReason = raw.stop_reason;
    } else if (Array.isArray(raw.choices) && raw.choices[0] && typeof raw.choices[0].finish_reason === 'string') {
      altStopReason = raw.choices[0].finish_reason;
    }
  }
  const verdict = detectTruncation({ finishReason, stopReason: altStopReason });
  if (!verdict.truncated) {
    return result;
  }
  if (options.acceptTruncated === true) {
    return { ...result, truncated: true, truncationReason: verdict.reason };
  }
  throw new AdapterError(
    'MODEL_RESPONSE_TRUNCATED',
    'finish_reason',
    `Model response was truncated before completion (finish_reason='${verdict.reason}'). Partial output is unsafe for downstream JSON/code consumers.`,
    {
      fixHint: 'Raise maxTokens/maxCompletionTokens, or pass options.acceptTruncated=true to accept partial output and handle result.truncated in the caller.',
      context: { reason: verdict.reason },
    },
  );
}

function validateSchemaShape(parsed, schema, options = {}) {
  if (!schema || typeof schema !== 'object') {
    return;
  }
  // Only validate if the schema type is json_object (the repo convention).
  if (schema.type === 'json_object') {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AdapterError(
        'MODEL_SCHEMA_MISMATCH',
        'response.structured',
        'Model response failed schema.type=json_object validation — payload must be a plain object (not array, null, or primitive).',
        {
          fixHint: 'Instruct the model to return a JSON object. When using OpenAI-compatible providers, response_format={type:"json_object"} is set automatically when options.schema is supplied.',
        },
      );
    }
  }
  if (Array.isArray(schema.required)) {
    const missing = schema.required.filter((key) => !Object.prototype.hasOwnProperty.call(parsed, key));
    if (missing.length > 0) {
      throw new AdapterError(
        'MODEL_SCHEMA_MISMATCH',
        'response.structured',
        `Model response missing required field(s): ${missing.join(', ')}`,
        {
          fixHint: `Ensure every key listed in options.schema.required is present on the returned object. Missing: ${missing.join(', ')}.`,
          context: { missing, required: schema.required, source: options.source || 'model-response' },
        },
      );
    }
  }
}

function maybeParseStructured(text, options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  if (!wantsStructuredOutput(safeOptions)) {
    return null;
  }
  let parsed;
  try {
    const jsonText = extractJsonObjectFromText(text, 'Model response');
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const snippet = redactSnippet(text);
    // extractJsonObjectFromText already prefixes its errors with "Model response", so we
    // append the snippet without re-labeling to avoid double-prefixing.
    const baseMessage = err && err.message ? err.message : 'Model response JSON parse failed';
    throw new AdapterError(
      'MODEL_RESPONSE_JSON_PARSE_FAILED',
      'response.text',
      `${baseMessage} (snippet: ${snippet})`,
      { fixHint: 'Ensure the model returns valid JSON when schema is set. Use response_format or instruct the model explicitly.', cause: err },
    );
  }
  validateSchemaShape(parsed, safeOptions.schema, { source: 'model-response' });
  return parsed;
}

function resolveProviderAlias(value) {
  const provider = normalizeText(value).toLowerCase() || 'minimax';
  if (provider === 'openai-compatible' || provider === 'openai_compatible') {
    return 'openai-compatible';
  }
  if (provider === 'external' || provider === 'external-command') {
    return 'external-command';
  }
  return provider;
}

function resolveModelConfig(overrides = {}, env = process.env) {
  const safeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  const safeEnv = env && typeof env === 'object' ? env : {};
  const provider = resolveProviderAlias(safeOverrides.provider);
  const apiKeyEnvDefaults = {
    minimax: 'MINIMAX_API_KEY',
    openai: 'OPENAI_API_KEY',
    'openai-compatible': 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  };
  const baseUrlDefaults = {
    minimax: DEFAULT_MINIMAX_BASE_URL,
    openai: DEFAULT_OPENAI_BASE_URL,
    'openai-compatible': normalizeText(safeEnv.OPENAI_BASE_URL) || DEFAULT_OPENAI_BASE_URL,
    anthropic: DEFAULT_ANTHROPIC_BASE_URL,
  };
  const modelDefaults = {
    minimax: DEFAULT_MINIMAX_MODEL,
    openai: DEFAULT_OPENAI_MODEL,
    'openai-compatible': DEFAULT_OPENAI_MODEL,
    anthropic: DEFAULT_ANTHROPIC_MODEL,
  };
  const apiKeyEnv = normalizeText(safeOverrides.apiKeyEnv) || apiKeyEnvDefaults[provider] || '';
  // Retry-budget caps (audit P2#5): quietly clamp caller-supplied maxAttempts and
  // retryDelayMs so a caller cannot request years of retries. The total wall-clock
  // budget is enforced separately in callModel via MAX_TOTAL_RETRY_MS.
  const rawMaxAttempts = Math.max(1, Math.round(normalizeNumber(safeOverrides.maxAttempts, 1)));
  const rawRetryDelayMs = Math.max(0, Math.round(normalizeNumber(safeOverrides.retryDelayMs, DEFAULT_RETRY_DELAY_MS)));
  // Response-body cap (audit P1#1): clamp caller-supplied maxResponseBytes so a
  // caller cannot disable the OOM ceiling. 8MB default, 64MB hard ceiling.
  const rawMaxResponseBytes = normalizeNumber(safeOverrides.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const maxResponseBytes = Math.min(
    MAX_RESPONSE_BYTES_CEILING,
    Math.max(1024, Math.round(Number.isFinite(rawMaxResponseBytes) ? rawMaxResponseBytes : DEFAULT_MAX_RESPONSE_BYTES)),
  );
  return {
    provider,
    apiKeyEnv,
    apiKey: normalizeText(safeOverrides.apiKey) || normalizeText(apiKeyEnv ? safeEnv[apiKeyEnv] : ''),
    baseUrl: stripTrailingSlash(normalizeText(safeOverrides.baseUrl) || baseUrlDefaults[provider] || ''),
    model: normalizeText(safeOverrides.model) || modelDefaults[provider] || '',
    timeoutMs: Math.max(1000, normalizeNumber(safeOverrides.timeoutMs, DEFAULT_TIMEOUT_MS)),
    temperature: normalizeNumber(safeOverrides.temperature, 0.2),
    maxAttempts: Math.min(MAX_ATTEMPTS_CEILING, rawMaxAttempts),
    retryDelayMs: Math.min(MAX_RETRY_DELAY_MS_CEILING, rawRetryDelayMs),
    maxResponseBytes,
    reasoningSplit: safeOverrides.reasoningSplit !== false,
    maxTokens: Number.isFinite(Number(safeOverrides.maxTokens)) ? Math.max(1, Math.round(Number(safeOverrides.maxTokens))) : null,
    maxCompletionTokens: Number.isFinite(Number(safeOverrides.maxCompletionTokens))
      ? Math.max(1, Math.round(Number(safeOverrides.maxCompletionTokens)))
      : null,
    command: normalizeText(safeOverrides.command),
    headers: safeOverrides.headers && typeof safeOverrides.headers === 'object' ? { ...safeOverrides.headers } : {},
  };
}

// Read the HTTP body with a hard byte ceiling (audit P1#1). An untrusted provider
// can return a multi-GB body and OOM the engine; this helper enforces a cap by
// streaming via response.body when available and aborting once the cap is reached.
// Pre-checks content-length when present so a huge body is rejected before the first
// byte is read. Falls back to response.text() when no streaming body is exposed
// (e.g. legacy/mocked fetch responses) — in that case the cap applies post-read.
async function readBodyBounded(response, maxBytes) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.round(maxBytes) : DEFAULT_MAX_RESPONSE_BYTES;
  // Check content-length if present — reject early.
  const headers = response && response.headers;
  if (headers && typeof headers.get === 'function') {
    const cl = Number(headers.get('content-length'));
    if (Number.isFinite(cl) && cl > cap) {
      const err = new AdapterError(
        'MODEL_RESPONSE_TOO_LARGE',
        'response.body',
        `Model response content-length ${cl} exceeds maxResponseBytes=${cap}`,
        {
          fixHint: `Raise options.maxResponseBytes (current ${cap}, hard ceiling ${MAX_RESPONSE_BYTES_CEILING}) only if the provider is trusted, otherwise instruct the model to return shorter output.`,
          context: { maxBytes: cap, contentLength: cl },
        },
      );
      throw err;
    }
  }
  // Prefer streaming so we can abort early on oversize bodies.
  const bodyStream = response && response.body;
  if (bodyStream && typeof bodyStream.getReader === 'function') {
    const reader = bodyStream.getReader();
    const chunks = [];
    let total = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          total += value.byteLength;
          if (total > cap) {
            try { reader.cancel(); } catch (_) { /* ignore */ }
            throw new AdapterError(
              'MODEL_RESPONSE_TOO_LARGE',
              'response.body',
              `Model response body exceeded maxResponseBytes=${cap} (read so far: ${total})`,
              {
                fixHint: `Raise options.maxResponseBytes (current ${cap}, hard ceiling ${MAX_RESPONSE_BYTES_CEILING}) only if the provider is trusted, otherwise instruct the model to return shorter output.`,
                context: { maxBytes: cap, bytesRead: total },
              },
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (_) { /* ignore */ }
    }
    // Concatenate chunks into a single buffer and decode as UTF-8.
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
  }
  // Fallback path: no streaming body exposed — read via text() but still enforce
  // the cap post-read. This guards against mocked test responses and legacy
  // fetch polyfills that do not expose response.body as a ReadableStream.
  let text = '';
  try {
    text = typeof response.text === 'function' ? await response.text() : '';
  } catch (_) {
    text = '';
  }
  if (text && typeof text === 'string' && Buffer.byteLength(text, 'utf8') > cap) {
    throw new AdapterError(
      'MODEL_RESPONSE_TOO_LARGE',
      'response.body',
      `Model response body exceeded maxResponseBytes=${cap} (read: ${Buffer.byteLength(text, 'utf8')})`,
      {
        fixHint: `Raise options.maxResponseBytes (current ${cap}, hard ceiling ${MAX_RESPONSE_BYTES_CEILING}) only if the provider is trusted, otherwise instruct the model to return shorter output.`,
        context: { maxBytes: cap, bytesRead: Buffer.byteLength(text, 'utf8') },
      },
    );
  }
  return text;
}

async function postJson(url, payload, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AdapterError(
      'FETCH_UNAVAILABLE',
      'fetch',
      'Fetch is not available in this Node runtime.',
      { fixHint: 'Upgrade to Node 18+ (global fetch) or pass options.fetchImpl with a fetch-compatible implementation.' },
    );
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  const maxResponseBytes = Number.isFinite(options.maxResponseBytes) && options.maxResponseBytes > 0
    ? options.maxResponseBytes
    : DEFAULT_MAX_RESPONSE_BYTES;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    let text = '';
    try {
      text = await readBodyBounded(response, maxResponseBytes);
    } catch (err) {
      if (err instanceof AdapterError && err.code === 'MODEL_RESPONSE_TOO_LARGE') {
        throw err;
      }
      text = '';
    }
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      // Audit P1#3: redact any secret-shaped tokens the provider may have echoed
      // back (Authorization header, env-var keys, AWS creds) before embedding the
      // body into the error message. Cap the embedded text at 1KB so logs don't
      // balloon. Preserve the raw structured body on error.context.rawResponse so
      // callers can still inspect the full response.
      const rawDetails = parsed || text || `HTTP ${response.status}`;
      const serializedDetails = typeof rawDetails === 'string'
        ? rawDetails
        : (() => { try { return JSON.stringify(rawDetails); } catch (_) { return String(rawDetails); } })();
      const safeDetails = redactAndCap(serializedDetails, ERROR_MESSAGE_EMBED_CAP_BYTES);
      throw new AdapterError(
        'MODEL_HTTP_ERROR',
        'response.status',
        `Model request failed with HTTP ${response.status}: ${safeDetails}`,
        {
          fixHint: `Check the model provider API status and credentials. HTTP status: ${response.status}.`,
          context: { status: response.status, rawResponse: parsed || text || null },
        },
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new AdapterError(
        'MODEL_RESPONSE_INVALID_JSON',
        'response.body',
        'Model response was not valid JSON.',
        {
          fixHint: 'Verify the model provider endpoint returns JSON. Check baseUrl and model configuration.',
          context: { rawResponse: text || null },
        },
      );
    }
    return parsed;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new AdapterError(
        'MODEL_REQUEST_TIMEOUT',
        'timeoutMs',
        `Model request timed out after ${options.timeoutMs}ms`,
        { fixHint: `Increase options.timeoutMs (currently ${options.timeoutMs}ms) or reduce prompt size.` },
      );
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function callMinimaxProvider(config, options = {}) {
  if (!config.apiKey) {
    throw new AdapterError(
      'MISSING_API_KEY',
      config.apiKeyEnv || 'MINIMAX_API_KEY',
      `MiniMax API key not found. Set ${config.apiKeyEnv || 'MINIMAX_API_KEY'} before running the engine.`,
      { fixHint: `Export ${config.apiKeyEnv || 'MINIMAX_API_KEY'} before running the engine.` },
    );
  }
  const messages = buildMessages(options);
  if (messages.length === 0) {
    throw new AdapterError(
      'MINIMAX_MESSAGES_REQUIRED',
      'messages',
      'MiniMax request must include messages or systemPrompt/userPrompt',
      { fixHint: 'Provide at least one message via options.messages, or set options.systemPrompt / options.userPrompt.' },
    );
  }
  const payload = {
    model: config.model || DEFAULT_MINIMAX_MODEL,
    messages,
    temperature: config.temperature,
  };
  if (config.maxCompletionTokens) {
    payload.max_completion_tokens = config.maxCompletionTokens;
  }
  if (config.reasoningSplit) {
    payload.extra_body = { reasoning_split: true };
  }
  const startedAt = Date.now();
  const response = await postJson(`${config.baseUrl}/chat/completions`, payload, {
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    fetchImpl: options.fetchImpl,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...config.headers,
    },
  });
  const choice = Array.isArray(response.choices) ? response.choices[0] : null;
  const message = choice && choice.message ? choice.message : {};
  const text = extractContentText(message.content);
  const result = {
    provider: 'minimax',
    model: normalizeText(response.model) || config.model || DEFAULT_MINIMAX_MODEL,
    text,
    structured: maybeParseStructured(text, options),
    reasoning: extractReasoningText(message.reasoning_details),
    finishReason: normalizeText(choice && choice.finish_reason) || null,
    usage: response.usage || {},
    elapsedMs: Date.now() - startedAt,
    raw: response,
  };
  return enforceTruncationPolicy(result, options);
}

async function callOpenAiCompatibleProvider(config, options = {}) {
  if (!config.apiKey) {
    throw new AdapterError(
      'MISSING_API_KEY',
      config.apiKeyEnv || 'OPENAI_API_KEY',
      `OpenAI-compatible API key not found. Set ${config.apiKeyEnv || 'OPENAI_API_KEY'} before running the engine.`,
      { fixHint: `Export ${config.apiKeyEnv || 'OPENAI_API_KEY'} before running the engine.` },
    );
  }
  const messages = buildMessages(options);
  if (messages.length === 0) {
    throw new AdapterError(
      'OPENAI_MESSAGES_REQUIRED',
      'messages',
      'OpenAI-compatible request must include messages or systemPrompt/userPrompt',
      { fixHint: 'Provide at least one message via options.messages, or set options.systemPrompt / options.userPrompt.' },
    );
  }
  const payload = {
    model: config.model || DEFAULT_OPENAI_MODEL,
    messages,
    temperature: config.temperature,
  };
  if (config.maxCompletionTokens) {
    payload.max_completion_tokens = config.maxCompletionTokens;
  } else if (config.maxTokens) {
    payload.max_tokens = config.maxTokens;
  }
  if (wantsStructuredOutput(options)) {
    payload.response_format = { type: 'json_object' };
  }
  const startedAt = Date.now();
  const response = await postJson(`${config.baseUrl}/chat/completions`, payload, {
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    fetchImpl: options.fetchImpl,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...config.headers,
    },
  });
  const choice = Array.isArray(response.choices) ? response.choices[0] : null;
  const message = choice && choice.message ? choice.message : {};
  const text = extractContentText(message.content);
  const result = {
    provider: config.provider,
    model: normalizeText(response.model) || config.model || DEFAULT_OPENAI_MODEL,
    text,
    structured: maybeParseStructured(text, options),
    reasoning: extractReasoningText(message.reasoning_details),
    finishReason: normalizeText(choice && choice.finish_reason) || null,
    usage: response.usage || {},
    elapsedMs: Date.now() - startedAt,
    raw: response,
  };
  return enforceTruncationPolicy(result, options);
}

async function callAnthropicProvider(config, options = {}) {
  if (!config.apiKey) {
    throw new AdapterError(
      'MISSING_API_KEY',
      config.apiKeyEnv || 'ANTHROPIC_API_KEY',
      `Anthropic API key not found. Set ${config.apiKeyEnv || 'ANTHROPIC_API_KEY'} before running the engine.`,
      { fixHint: `Export ${config.apiKeyEnv || 'ANTHROPIC_API_KEY'} before running the engine.` },
    );
  }
  const messages = buildMessages(options);
  if (messages.length === 0) {
    throw new AdapterError(
      'ANTHROPIC_MESSAGES_REQUIRED',
      'messages',
      'Anthropic request must include messages or systemPrompt/userPrompt',
      { fixHint: 'Provide at least one message via options.messages, or set options.systemPrompt / options.userPrompt.' },
    );
  }
  const systemParts = messages.filter((message) => message.role === 'system').map((message) => extractContentText(message.content)).filter(Boolean);
  const promptMessages = messages.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: extractContentText(message.content),
  }));
  const payload = {
    model: config.model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: config.maxTokens || config.maxCompletionTokens || 1200,
    temperature: config.temperature,
    messages: promptMessages,
  };
  if (systemParts.length > 0) {
    payload.system = systemParts.join('\n\n');
  }
  const startedAt = Date.now();
  const response = await postJson(`${config.baseUrl}/messages`, payload, {
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    fetchImpl: options.fetchImpl,
    headers: {
      'anthropic-version': '2023-06-01',
      'x-api-key': config.apiKey,
      ...config.headers,
    },
  });
  const text = Array.isArray(response.content)
    ? response.content
      .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim()
    : '';
  const result = {
    provider: 'anthropic',
    model: normalizeText(response.model) || config.model || DEFAULT_ANTHROPIC_MODEL,
    text,
    structured: maybeParseStructured(text, options),
    reasoning: '',
    finishReason: normalizeText(response.stop_reason) || null,
    usage: response.usage || {},
    elapsedMs: Date.now() - startedAt,
    raw: response,
  };
  return enforceTruncationPolicy(result, options);
}

// Audit P2#4: async spawn with detached process group so SIGTERM-ignoring adapters
// can be force-killed. Collects stdout/stderr with the same 16MB maxBuffer that
// spawnSync used, enforces the config.timeoutMs wall-clock budget, and on timeout
// sends SIGTERM to the whole group, waits EXTERNAL_COMMAND_KILL_GRACE_MS, then
// SIGKILLs. Returns {status, stdout, stderr, error, timedOut} — the same shape the
// legacy spawnSync branch produced, so the consumer code below stays unchanged.
function spawnExternalCommand(config, options = {}, payload) {
  const maxBuffer = 16 * 1024 * 1024;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('bash', ['-lc', config.command], {
        cwd: options.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: '', error: err, timedOut: false });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowErr = null;
    let timedOut = false;
    let spawnErr = null;
    let settled = false;

    const cleanup = () => {
      try { clearTimeout(timeoutId); } catch (_) { /* ignore */ }
      try { clearTimeout(killTimeout); } catch (_) { /* ignore */ }
    };

    const settle = (payloadOut) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payloadOut);
    };

    const killTree = (signal) => {
      if (!child || typeof child.pid !== 'number') return;
      try {
        // Negative PID targets the whole process group (detached:true made us group leader).
        process.kill(-child.pid, signal);
      } catch (_) {
        try { child.kill(signal); } catch (__) { /* already dead */ }
      }
    };

    let killTimeout = null;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      // Grace period before escalating to SIGKILL for adapters that trap SIGTERM.
      killTimeout = setTimeout(() => {
        killTree('SIGKILL');
      }, EXTERNAL_COMMAND_KILL_GRACE_MS);
    }, Math.max(1, config.timeoutMs || DEFAULT_TIMEOUT_MS));

    child.on('error', (err) => {
      spawnErr = err;
      settle({ status: null, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), error: err, timedOut });
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        if (!overflowErr) {
          overflowErr = new Error(`stdout exceeded maxBuffer=${maxBuffer} bytes`);
          overflowErr.code = 'ENOBUFS';
        }
        killTree('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        if (!overflowErr) {
          overflowErr = new Error(`stderr exceeded maxBuffer=${maxBuffer} bytes`);
          overflowErr.code = 'ENOBUFS';
        }
        killTree('SIGTERM');
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on('close', (code, signal) => {
      settle({
        status: typeof code === 'number' ? code : null,
        signal: signal || null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error: spawnErr || overflowErr || null,
        timedOut,
      });
    });
    // Write payload + close stdin so the child exits when it's done consuming.
    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      // Write errors surface via the 'error' listener above.
    }
  });
}

async function callExternalCommandProvider(config, options = {}) {
  if (!config.command) {
    throw new AdapterError(
      'MODEL_EXTERNAL_COMMAND_REQUIRED',
      'command',
      'External command provider requires command',
      { fixHint: 'Set options.command to the shell command that runs the external model adapter.' },
    );
  }
  const payload = {
    provider: config.provider,
    mode: normalizeText(options.mode) || 'proposal',
    messages: buildMessages(options),
    schema: options.schema || null,
    model: config.model || null,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    context: options.context || null,
  };
  const startedAt = Date.now();
  const result = await spawnExternalCommand(config, options, payload);
  if (result.timedOut) {
    throw new AdapterError(
      'MODEL_EXTERNAL_COMMAND_TIMEOUT',
      'timeoutMs',
      `External model command exceeded timeoutMs=${config.timeoutMs}ms and was killed (SIGTERM→SIGKILL escalation after ${EXTERNAL_COMMAND_KILL_GRACE_MS}ms grace).`,
      {
        fixHint: `Increase options.timeoutMs (currently ${config.timeoutMs}ms) or fix the adapter so it respects SIGTERM / completes sooner.`,
        context: { timeoutMs: config.timeoutMs, stderrSnippet: redactAndCap(result.stderr || '', 512) },
      },
    );
  }
  if (result.error) {
    throw new AdapterError(
      'MODEL_EXTERNAL_COMMAND_SPAWN_FAILED',
      'command',
      (result.error && result.error.message) || `External model command could not be spawned (${result.error && result.error.code || 'unknown'})`,
      {
        fixHint: 'Check the external command path exists and the process can be spawned. Common causes: ENOENT (command not found), EACCES (permission denied), ENOBUFS (stdout/stderr exceeded 16MB).',
        cause: result.error,
      },
    );
  }
  if (result.status !== 0) {
    // Audit P1#3: stderr may contain env-var echoes and API keys — redact before
    // embedding in the message. Preserve the raw stderr on context.rawResponse.
    const stderrText = normalizeText(result.stderr);
    const safeStderr = redactAndCap(stderrText, ERROR_MESSAGE_EMBED_CAP_BYTES);
    throw new AdapterError(
      'MODEL_EXTERNAL_COMMAND_FAILED',
      'command',
      safeStderr || `External model command failed with status ${result.status}`,
      {
        fixHint: 'Check the external command path and that it exits 0 on success. Inspect stderr for details.',
        context: { status: result.status, rawResponse: stderrText || null },
      },
    );
  }
  const text = normalizeText(result.stdout);
  const expectsJson = Boolean(options.schema) || (text.length > 0 && (text[0] === '{' || text[0] === '['));
  let parsed = null;
  let parseErr = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    parseErr = err;
    parsed = null;
  }
  // Audit P2#7: when schema was requested OR stdout clearly looks like JSON, a
  // parse failure must be a hard error — a truncated envelope should not be
  // silently treated as plain text and handed to downstream JSON/code consumers.
  if (parseErr && expectsJson) {
    throw new AdapterError(
      'MODEL_EXTERNAL_COMMAND_INVALID_JSON',
      'response.body',
      `External command stdout failed JSON.parse (${parseErr.message}). stdout snippet: ${redactAndCap(text, 200)}`,
      {
        fixHint: 'Ensure the adapter emits a valid JSON envelope on stdout when options.schema is supplied. Check for truncated output and UTF-8 encoding issues.',
        context: { rawResponse: text || null, source: options.schema ? 'schema-requested' : 'json-shaped-output' },
        cause: parseErr,
      },
    );
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
    // Audit P1#2: validate the envelope's `structured` field against the schema
    // instead of blindly trusting whatever the adapter injected. If the envelope
    // did not provide one, re-parse from parsed.text (original behavior) which
    // already applies schema validation via maybeParseStructured.
    let envelopeStructured = null;
    if (parsed.structured !== undefined && parsed.structured !== null) {
      validateSchemaShape(parsed.structured, options.schema, { source: 'external-command-envelope' });
      envelopeStructured = parsed.structured;
    } else {
      envelopeStructured = maybeParseStructured(parsed.text, options);
    }
    const shaped = {
      provider: 'external-command',
      model: normalizeText(parsed.model) || config.model || 'external-command',
      text: parsed.text,
      structured: envelopeStructured,
      reasoning: normalizeText(parsed.reasoning),
      finishReason: normalizeText(parsed.finishReason) || null,
      usage: parsed.usage || {},
      elapsedMs: Date.now() - startedAt,
      raw: parsed,
    };
    return enforceTruncationPolicy(shaped, options);
  }
  const shaped = {
    provider: 'external-command',
    model: config.model || 'external-command',
    text,
    structured: maybeParseStructured(text, options),
    reasoning: '',
    finishReason: null,
    usage: {},
    elapsedMs: Date.now() - startedAt,
    raw: parsed || text,
  };
  return enforceTruncationPolicy(shaped, options);
}

async function dispatchModelCall(config, options = {}) {
  if (config.provider === 'minimax') {
    return callMinimaxProvider(config, options);
  }
  if (config.provider === 'openai' || config.provider === 'openai-compatible') {
    return callOpenAiCompatibleProvider(config, options);
  }
  if (config.provider === 'anthropic') {
    return callAnthropicProvider(config, options);
  }
  if (config.provider === 'external-command') {
    return callExternalCommandProvider(config, options);
  }
  throw new AdapterError(
    'MODEL_PROVIDER_UNSUPPORTED',
    'provider',
    `Unsupported model provider: ${config.provider}`,
    { fixHint: 'Set options.provider to one of: minimax, openai, openai-compatible, anthropic, external-command.' },
  );
}

async function callModel(options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const config = resolveModelConfig(safeOptions, safeOptions.env);
  const attempts = [];
  let lastError = null;
  const retryStart = Date.now();
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const response = await dispatchModelCall(config, safeOptions);
      return {
        ...response,
        attempts,
      };
    } catch (error) {
      const message = normalizeText(error && error.message ? error.message : error) || 'Model call failed';
      attempts.push({ attempt, message });
      lastError = error;
      // Audit P2#5: enforce MAX_TOTAL_RETRY_MS wall-clock budget. If the cumulative
      // time across all retries exceeds the budget, throw MODEL_RETRY_BUDGET_EXCEEDED
      // early regardless of attempts left — a caller cannot stall the engine for years.
      const elapsed = Date.now() - retryStart;
      if (elapsed >= MAX_TOTAL_RETRY_MS) {
        const budgetErr = new AdapterError(
          'MODEL_RETRY_BUDGET_EXCEEDED',
          'retryBudget',
          `Model retry budget exceeded: ${elapsed}ms elapsed across ${attempts.length} attempt(s), hard ceiling ${MAX_TOTAL_RETRY_MS}ms`,
          {
            fixHint: `Lower options.maxAttempts (clamped to ${MAX_ATTEMPTS_CEILING}) or options.retryDelayMs (clamped to ${MAX_RETRY_DELAY_MS_CEILING}ms), or fix the underlying failure. Wall-clock budget: ${MAX_TOTAL_RETRY_MS}ms.`,
            context: { elapsedMs: elapsed, attempts: attempts.length, maxTotalMs: MAX_TOTAL_RETRY_MS },
            cause: lastError || undefined,
          },
        );
        const failure = new Error(budgetErr.message, { cause: budgetErr });
        failure.attempts = attempts;
        throw failure;
      }
      if (attempt < config.maxAttempts && config.retryDelayMs > 0) {
        const backoff = Math.min(config.retryDelayMs * attempt, MAX_RETRY_DELAY_MS_CEILING);
        // Also short-circuit if the delay itself would push us past the budget.
        const remaining = MAX_TOTAL_RETRY_MS - elapsed;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(backoff, remaining))));
      }
    }
  }
  const failure = new Error(
    normalizeText(lastError && lastError.message ? lastError.message : lastError) || 'Model call failed',
    lastError ? { cause: lastError } : undefined,
  );
  failure.attempts = attempts;
  throw failure;
}

module.exports = {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  MAX_ATTEMPTS_CEILING,
  MAX_RESPONSE_BYTES_CEILING,
  MAX_RETRY_DELAY_MS_CEILING,
  MAX_TOTAL_RETRY_MS,
  buildMessages,
  callModel,
  maybeParseStructured,
  redactSecrets,
  resolveModelConfig,
  validateSchemaShape,
};
