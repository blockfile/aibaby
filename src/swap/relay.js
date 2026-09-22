'use strict';

// Transport to Relay (https://api.relay.link): post a quote, read a status.
// All policy — which coin, which destination, what minimum — lives in
// quotes.js, so the rules are testable without a network stub.

const config = require('../config');

class RelayError extends Error {
  /**
   * @param {string} message what Relay said, or what went wrong reaching it
   * @param {{ status?: number, code?: string }} [opts] HTTP status to answer with
   */
  constructor(message, { status = 502, code = null, transient = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.transient = transient;
  }
}

// Relay's error codes that mean "this trade cannot be done as asked" — the
// buyer can change the amount or coin, so they are 422 with Relay's own words.
const NO_TRADE = new Set([
  'NO_SWAP_ROUTES_FOUND', 'SWAP_IMPACT_TOO_HIGH', 'AMOUNT_TOO_LOW', 'AMOUNT_TOO_HIGH',
  'INSUFFICIENT_LIQUIDITY', 'UNSUPPORTED_ROUTE', 'UNSUPPORTED_CURRENCY', 'INVALID_INPUT_CURRENCY',
]);

async function call(path, { method = 'GET', body, timeoutMs, fetchImpl, cfg }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${cfg.relayUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cfg.relayApiKey ? { 'x-api-key': cfg.relayApiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new RelayError('Relay took too long to answer — try again', { status: 504 });
    throw new RelayError(`could not reach Relay: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Tolerant parse on the error path: Relay's detail is a bonus, not a given.
    const j = await res.json().catch(() => ({}));
    if (res.status === 429) throw new RelayError('too many requests — try again in a moment', { status: 429, code: 'RATE_LIMITED' });
    const code = j.errorCode || null;
    // Relay answers its own hiccups as HTTP 400 SERVER_ERROR ("processing
    // response error"). Measured 2026-09-22: the identical request succeeded
    // seconds later. Reporting it as "no route" would tell the buyer a working
    // pair is broken, so it is marked transient and retried by the caller.
    if (code === 'SERVER_ERROR') {
      throw new RelayError('Relay had a temporary problem — try again', { status: 503, code, transient: true });
    }
    const status = res.status >= 500 ? 502 : code && NO_TRADE.has(code) ? 422 : res.status === 400 ? 422 : 502;
    throw new RelayError(j.message || code || `Relay HTTP ${res.status}`, { status, code });
  }
  // Strict parse on success: a 2xx with an unreadable body is a fault, never {}.
  try {
    return await res.json();
  } catch (err) {
    throw new RelayError(`Relay answered with something that is not JSON: ${err.message}`);
  }
}

/**
 * POST /quote. Returns Relay's raw response.
 *
 * A transient Relay error is retried once after a short pause — a quote is
 * read-only, so asking twice is harmless — and only then reported.
 */
async function fetchQuote(body, { timeoutMs = 12_000, fetchImpl = fetch, cfg = config, retryDelayMs = 600 } = {}) {
  try {
    return await call('/quote', { method: 'POST', body, timeoutMs, fetchImpl, cfg });
  } catch (err) {
    if (!err.transient) throw err;
    await new Promise((r) => setTimeout(r, retryDelayMs));
    return call('/quote', { method: 'POST', body, timeoutMs, fetchImpl, cfg });
  }
}

/** The intent's status by the requestId the quote carried. */
function fetchStatus(requestId, { timeoutMs = 10_000, fetchImpl = fetch, cfg = config } = {}) {
  return call(`/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { timeoutMs, fetchImpl, cfg });
}

module.exports = { fetchQuote, fetchStatus, RelayError, NO_TRADE };
