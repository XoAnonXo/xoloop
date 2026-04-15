/**
 * AdapterError — structured error type for the xoanonxoloop engine.
 *
 * Purpose: make rejection reasons machine-readable so the proposer model gets
 * `{ code, field, fixHint }` on its next repair attempt instead of an interpolated
 * English prose string. The next-attempt prompt can then act on distinct JSON
 * fields without regexing error text.
 *
 * Usage:
 *   throw new AdapterError('MISSING_API_KEY', 'MINIMAX_API_KEY',
 *     'environment variable not set',
 *     { fixHint: 'Export MINIMAX_API_KEY before running the engine.' });
 *
 * Consumers can read:
 *   err.code      -> 'MISSING_API_KEY'   (stable identifier for test matchers)
 *   err.field     -> 'MINIMAX_API_KEY'   (what field/env-var is affected)
 *   err.fixHint   -> '...'               (one-line actionable repair instruction)
 *   err.cause     -> underlying Error    (preserved chain)
 *   err.message   -> '[MISSING_API_KEY] MINIMAX_API_KEY: environment variable not set'
 *
 * Backwards compatibility: AdapterError extends Error, so every existing
 * `catch (e) { e.message }` caller still works unchanged.
 */

class _AdapterError extends Error {
  constructor(code, field, message, options = {}) {
    const prefix = code ? `[${code}]` : '[ADAPTER_ERROR]';
    const fieldPart = field ? ` ${field}:` : '';
    super(`${prefix}${fieldPart} ${message}`.trim(), options && options.cause ? { cause: options.cause } : undefined);
    this.name = 'AdapterError';
    this.code = code || 'ADAPTER_ERROR';
    this.field = field || null;
    this.fixHint = (options && options.fixHint) || null;
  }

  /**
   * Serializable view for ledger/manifest persistence and repair prompts.
   * The engine persists this shape so the next attempt sees distinct JSON keys.
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      field: this.field,
      message: this.message,
      fixHint: this.fixHint,
    };
  }
}

/**
 * Extract the structured fields from any thrown value. Returns null if the
 * value is not an AdapterError (and has no AdapterError in its cause chain).
 * Callers use this to decide whether to include structured fields in a
 * repair prompt or fall back to the legacy string path.
 */
function extractStructuredError(err) {
  let current = err;
  let depth = 0;
  while (current && depth < 10) {
    if (current.name === 'AdapterError' && typeof current.code === 'string') {
      return {
        code: current.code,
        field: current.field || null,
        message: current.message || '',
        fixHint: current.fixHint || null,
      };
    }
    current = current.cause ? current.cause : null;
    depth += 1;
  }
  return null;
}

// Guard: allow AdapterError(...) without `new` — ES6 classes normally reject
// bare calls, so we wrap with a Proxy that forwards to `new`.
const AdapterError = new Proxy(_AdapterError, {
  apply(Target, _thisArg, args) {
    return new Target(...args);
  },
});

module.exports = {
  AdapterError,
  extractStructuredError,
};
