'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { AdapterError } = require('./errors.cjs');

const LIVE_AGENTIC_MODES = Object.freeze([
  'build',
  'polish',
  'autoresearch',
  'audit',
  'overnight',
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMode(mode) {
  const normalized = normalizeText(mode).toLowerCase();
  if (!LIVE_AGENTIC_MODES.includes(normalized)) {
    throw new AdapterError(
      'LIVE_AGENT_MODE_UNSUPPORTED',
      'mode',
      `Unsupported live-agentic mode: ${mode}`,
      { fixHint: `Use one of: ${LIVE_AGENTIC_MODES.join(', ')}.` },
    );
  }
  return normalized;
}

function languageFromContext(input) {
  const direct = normalizeText(input.language || (input.context && input.context.language));
  if (direct) return direct;
  const surface = input.surface || (input.context && input.context.surface);
  if (surface && normalizeText(surface.language)) return normalizeText(surface.language);
  if (surface && Array.isArray(surface.languageHints)) {
    return normalizeText(surface.languageHints[0]) || null;
  }
  if (surface && Array.isArray(surface.language_hints)) {
    return normalizeText(surface.language_hints[0]) || null;
  }
  return null;
}

function appendEvidence(evidencePath, entry) {
  if (!evidencePath) return;
  const resolved = path.resolve(evidencePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(resolved, `${JSON.stringify(entry)}\n`);
}

function readLiveAgentEvidence(evidencePath) {
  if (!evidencePath || !fs.existsSync(evidencePath)) return [];
  return fs.readFileSync(evidencePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function summarizeLiveAgentEvidence(entries, options = {}) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const allowTestEvidence = options.allowTestEvidence === true;
  const requiredModes = Array.isArray(options.requiredModes) && options.requiredModes.length > 0
    ? options.requiredModes.map(normalizeMode)
    : LIVE_AGENTIC_MODES.slice();
  const byMode = {};
  const byLanguageMode = {};
  for (const mode of requiredModes) {
    byMode[mode] = {
      calls: 0,
      roles: [],
      verified: false,
    };
  }
  for (const entry of safeEntries) {
    if (!entry || entry.ok !== true) continue;
    if (entry.evidenceKind !== 'production-live' && !allowTestEvidence) continue;
    const mode = normalizeText(entry.mode).toLowerCase();
    if (!byMode[mode]) continue;
    const language = normalizeText(entry.language);
    if (!language) continue;
    byLanguageMode[`${language}/${mode}`] = true;
    byMode[mode].calls += 1;
    if (entry.role && !byMode[mode].roles.includes(entry.role)) {
      byMode[mode].roles.push(entry.role);
    }
    byMode[mode].verified = true;
  }
  const missing = requiredModes.filter((mode) => !byMode[mode].verified);
  return {
    complete: missing.length === 0,
    requiredModes,
    verifiedModes: requiredModes.filter((mode) => byMode[mode].verified),
    missing,
    byMode,
    byLanguageMode,
  };
}

function createLiveAgentProvider(options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const evidencePath = safeOptions.evidencePath || null;
  const command = normalizeText(safeOptions.command);
  const providerName = normalizeText(safeOptions.provider) || (safeOptions.command ? 'external-command' : 'injected');
  const evidenceKind = normalizeText(safeOptions.evidenceKind)
    || (safeOptions.production === true || command ? 'production-live' : 'test-provider');
  const cwd = safeOptions.cwd || process.cwd();
  const handler = typeof safeOptions.handler === 'function' ? safeOptions.handler : null;
  if (!handler && !command) {
    throw new AdapterError(
      'LIVE_AGENT_PROVIDER_REQUIRED',
      'handler',
      'createLiveAgentProvider requires either handler or command',
      { fixHint: 'Pass a handler for tests or command for a subagent/API adapter.' },
    );
  }

  async function call(input = {}) {
    const mode = normalizeMode(input.mode);
    const role = normalizeText(input.role) || mode;
    const startedAt = Date.now();
    const payload = {
      mode,
      role,
      language: languageFromContext(input),
      requestKind: normalizeText(input.requestKind) || role,
      systemPrompt: input.systemPrompt || (input.prompt && input.prompt.systemPrompt) || '',
      userPrompt: input.userPrompt || (input.prompt && input.prompt.userPrompt) || '',
      context: input.context || null,
      schema: input.schema || null,
    };
    let response;
    if (handler) {
      response = await handler(payload);
    } else {
      const result = spawnSync('bash', ['-lc', command], {
        cwd,
        encoding: 'utf8',
        input: `${JSON.stringify(payload)}\n`,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
        timeout: Number(safeOptions.timeoutMs) || 600000,
      });
      if (result.status !== 0) {
        throw new AdapterError(
          'LIVE_AGENT_COMMAND_FAILED',
          'command',
          `live agent command exited ${result.status}: ${String(result.stderr || '').slice(-1000)}`,
          { fixHint: 'Check the live agent command and make sure it returns JSON with a text field.' },
        );
      }
      response = JSON.parse(result.stdout);
    }
    if (!response || typeof response.text !== 'string') {
      throw new AdapterError(
        'LIVE_AGENT_RESPONSE_INVALID',
        'response.text',
        'live agent provider must return { text: string }',
        { fixHint: 'Return the exact model text in response.text.' },
      );
    }
    const entry = {
      timestamp: new Date().toISOString(),
      provider: providerName,
      evidenceKind,
      mode,
      language: payload.language,
      role,
      requestKind: payload.requestKind,
      ok: true,
      elapsedMs: Date.now() - startedAt,
    };
    appendEvidence(evidencePath, entry);
    return {
      provider: providerName,
      model: response.model || providerName,
      text: response.text,
      reasoning: response.reasoning || '',
      usage: response.usage || {},
      elapsedMs: entry.elapsedMs,
      liveAgentic: true,
      liveAgentEvidence: entry,
      raw: response,
    };
  }

  return {
    provider: providerName,
    evidencePath,
    call,
  };
}

function makeProposalLoader(liveAgentProvider, mode) {
  if (!liveAgentProvider || typeof liveAgentProvider.call !== 'function') return null;
  return async function liveAgentProposalLoader(ctx = {}) {
    return liveAgentProvider.call({
      mode,
      role: ctx.requestKind || 'proposal',
      requestKind: ctx.requestKind || 'proposal',
      language: languageFromContext(ctx),
      prompt: ctx.prompt,
      context: {
        surface: ctx.surface || null,
        objective: ctx.objective || null,
        errorMessage: ctx.errorMessage || null,
        priorText: ctx.priorText || null,
      },
      schema: { type: 'json_object' },
    });
  };
}

module.exports = {
  LIVE_AGENTIC_MODES,
  createLiveAgentProvider,
  makeProposalLoader,
  readLiveAgentEvidence,
  summarizeLiveAgentEvidence,
};
