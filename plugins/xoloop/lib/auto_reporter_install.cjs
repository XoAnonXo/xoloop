'use strict';

/**
 * auto_reporter_install — zero-friction opt-in flow for xoanon init
 * and global error handler that silently captures AdapterErrors.
 *
 * During `xoanon init`, the user sees a consent prompt. If they opt in,
 * saveConsentConfig persists { analytics: { enabled, level, repo, consented_at } }
 * to .xoanon/config.json. installGlobalHandler then attaches process-level
 * handlers that capture AdapterErrors silently via the reporter SDK.
 *
 * Privacy: only error codes, timing, and sanitized stacks are captured.
 * Source code, API keys, and private data are NEVER transmitted.
 */

const fs = require('node:fs');
const path = require('node:path');
const { AdapterError } = require('./errors.cjs');

// ── Consent prompt ─────────────────────────────────────────────────

const CONSENT_TEXT = [
  'xoanonxoloop improves itself from real usage.',
  '',
  'Opt in to send anonymous error reports (error codes, timing, stack traces — never source code, API keys, or private data) to GitHub where AI agents fix issues automatically.',
  '',
  'Fixes are merged when the Council of AI Oracles agrees.',
].join('\n');

/**
 * Returns the consent text string shown during init.
 */
function buildConsentPrompt() {
  return CONSENT_TEXT;
}

// ── Config persistence ─────────────────────────────────────────────

/**
 * Validate the common options shape used by save/load.
 */
function validateOptions(options, caller) {
  if (options === null || (options !== undefined && typeof options !== 'object')) {
    throw new AdapterError(
      'CONSENT_INVALID_OPTIONS',
      'options',
      `${caller}: options must be a non-null object`,
      { fixHint: `Pass a plain object: ${caller}({ baseDir: "/path" }).` },
    );
  }
  const opts = options || {};
  if (!opts.baseDir || typeof opts.baseDir !== 'string') {
    throw new AdapterError(
      'CONSENT_BASE_DIR_REQUIRED',
      'baseDir',
      `${caller}: baseDir is required and must be a non-empty string`,
      { fixHint: `Pass options.baseDir as an absolute path: ${caller}({ baseDir: "/path" }).` },
    );
  }
  return opts;
}

/**
 * Writes { analytics: { enabled, level, repo, consented_at } }
 * to .xoanon/config.json.
 *
 * @param {boolean} consent - Whether the user opted in.
 * @param {{ baseDir: string, repo?: string }} options
 */
function saveConsentConfig(consent, options) {
  const opts = validateOptions(options, 'saveConsentConfig');
  const configDir = path.join(opts.baseDir, '.xoanon');
  const configPath = path.join(configDir, 'config.json');

  const analytics = {
    enabled: consent === true,
    level: consent === true ? 2 : 0,
    repo: opts.repo || null,
    consented_at: consent === true ? new Date().toISOString() : null,
  };

  // Read existing config if present, then merge analytics into it
  let existing = {};
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      existing = JSON.parse(raw);
    }
  } catch (_) {
    // Ignore parse errors — overwrite with fresh config
    existing = {};
  }

  existing.analytics = analytics;

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  } catch (cause) {
    throw new AdapterError(
      'CONSENT_CONFIG_WRITE_FAILED',
      'configPath',
      `Failed to write consent config: ${cause.message}`,
      { fixHint: `Ensure ${configDir} is writable.`, cause },
    );
  }

  return analytics;
}

/**
 * Reads .xoanon/config.json and returns the analytics section,
 * or null if not found or unparseable.
 *
 * @param {{ baseDir: string }} options
 * @returns {{ enabled: boolean, level: number, repo: string|null, consented_at: string|null }|null}
 */
function loadConsentConfig(options) {
  const opts = validateOptions(options, 'loadConsentConfig');
  const configPath = path.join(opts.baseDir, '.xoanon', 'config.json');

  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.analytics === 'object' && parsed.analytics !== null) {
      return parsed.analytics;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// ── Consent check ──────────────────────────────────────────────────

/**
 * Checks if config.analytics.enabled === true.
 *
 * @param {object|null} config - The full config object (or analytics section).
 * @returns {boolean}
 */
function isConsentGiven(config) {
  if (!config || typeof config !== 'object') return false;
  // Support both full config shape and direct analytics object
  if (config.analytics && typeof config.analytics === 'object') {
    return config.analytics.enabled === true;
  }
  // Direct analytics object
  return config.enabled === true;
}

// ── Global error handler ───────────────────────────────────────────

/**
 * Installs process.on('uncaughtException') and process.on('unhandledRejection')
 * handlers that capture AdapterErrors silently.
 *
 * Options:
 *   reporter — an object with a report(error) method (e.g. from error_reporter.install)
 *   onError  — optional callback for testing; called with (type, error) after capture
 *
 * Returns { uninstall } to remove the handlers.
 */
function installGlobalHandler(options) {
  const opts = (options && typeof options === 'object') ? options : {};
  const reporter = opts.reporter;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;

  function isAdapterError(err) {
    return err && err.name === 'AdapterError' && typeof err.code === 'string';
  }

  function uncaughtHandler(err) {
    if (isAdapterError(err)) {
      if (reporter && typeof reporter.report === 'function') {
        reporter.report(err);
      }
      if (onError) onError('uncaughtException', err);
    }
    // Re-throw to let the process exit — do NOT swallow uncaughtExceptions
    throw err;
  }

  function rejectionHandler(reason) {
    if (isAdapterError(reason)) {
      if (reporter && typeof reporter.report === 'function') {
        reporter.report(reason);
      }
      if (onError) onError('unhandledRejection', reason);
    }
    // Unhandled rejections: do not re-throw (Node handles exit behavior)
  }

  process.on('uncaughtException', uncaughtHandler);
  process.on('unhandledRejection', rejectionHandler);

  return {
    uninstall() {
      process.removeListener('uncaughtException', uncaughtHandler);
      process.removeListener('unhandledRejection', rejectionHandler);
    },
    /** @internal — exposed for unit tests to call handlers directly */
    _handlers: { uncaughtHandler, rejectionHandler },
  };
}

// ── Exports ────────────────────────────────────────────────────────

module.exports = {
  buildConsentPrompt,
  saveConsentConfig,
  loadConsentConfig,
  installGlobalHandler,
  isConsentGiven,
};
