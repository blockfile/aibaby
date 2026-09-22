'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { fetchQuote, fetchStatus, RelayError } = require('./relay');

const CFG = { relayUrl: 'https://relay.test', relayApiKey: null };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

test('a quote is POSTed as JSON to /quote', async () => {
  const f = fakeFetch(reply(200, { steps: [] }));
  await fetchQuote({ amount: '1' }, { fetchImpl: f, cfg: CFG });
  assert.strictEqual(f.calls[0].url, 'https://relay.test/quote');
  assert.strictEqual(f.calls[0].init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(f.calls[0].init.body), { amount: '1' });
  assert.ok(!('x-api-key' in f.calls[0].init.headers), 'no key header without a key');
});

test('RELAY_API_KEY is sent as x-api-key', async () => {
  const f = fakeFetch(reply(200, {}));
  await fetchQuote({}, { fetchImpl: f, cfg: { ...CFG, relayApiKey: 'k' } });
  assert.strictEqual(f.calls[0].init.headers['x-api-key'], 'k');
});

test('a route Relay cannot do is a 422 carrying Relay’s words and code', async () => {
  const f = fakeFetch(reply(400, { errorCode: 'AMOUNT_TOO_LOW', message: 'Swap output amount is too small to cover fees required to execute swap' }));
  await assert.rejects(fetchQuote({}, { fetchImpl: f, cfg: CFG }), (e) => e instanceof RelayError && e.status === 422 && e.code === 'AMOUNT_TOO_LOW' && /too small/.test(e.message));
});

test('Relay’s SERVER_ERROR hiccup is retried once, and succeeds when Relay recovers', async () => {
  // Measured live: the identical Ethereum quote failed with this, then worked.
  const f = fakeFetch(reply(400, { errorCode: 'SERVER_ERROR', message: 'processing response error' }), reply(200, { ok: 1 }));
  const out = await fetchQuote({}, { fetchImpl: f, cfg: CFG, retryDelayMs: 0 });
  assert.deepStrictEqual(out, { ok: 1 });
  assert.strictEqual(f.calls.length, 2);
});

test('a SERVER_ERROR that persists is a 503 "try again", never "no route"', async () => {
  const f = fakeFetch(reply(400, { errorCode: 'SERVER_ERROR', message: 'processing response error' }));
  await assert.rejects(fetchQuote({}, { fetchImpl: f, cfg: CFG, retryDelayMs: 0 }), (e) => e.status === 503 && /temporary/.test(e.message));
  assert.strictEqual(f.calls.length, 2, 'retried exactly once');
});

test('a real refusal is not retried', async () => {
  const f = fakeFetch(reply(400, { errorCode: 'NO_SWAP_ROUTES_FOUND', message: 'no routes' }));
  await assert.rejects(fetchQuote({}, { fetchImpl: f, cfg: CFG, retryDelayMs: 0 }), (e) => e.status === 422);
  assert.strictEqual(f.calls.length, 1);
});

test('rate limiting is a 429, a timeout a 504, an outage a 502', async () => {
  await assert.rejects(fetchQuote({}, { fetchImpl: fakeFetch(reply(429, {})), cfg: CFG }), (e) => e.status === 429);
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(fetchQuote({}, { fetchImpl: fakeFetch(abort), cfg: CFG }), (e) => e.status === 504);
  await assert.rejects(fetchQuote({}, { fetchImpl: fakeFetch(reply(500, {})), cfg: CFG }), (e) => e.status === 502);
});

test('a 2xx that is not JSON is a fault, never an empty answer', async () => {
  const f = fakeFetch({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await assert.rejects(fetchQuote({}, { fetchImpl: f, cfg: CFG }), /not JSON/);
});

test('status reads the v3 intents endpoint by request id', async () => {
  const f = fakeFetch(reply(200, { status: 'waiting' }));
  const out = await fetchStatus('0xabc', { fetchImpl: f, cfg: CFG });
  assert.strictEqual(f.calls[0].url, 'https://relay.test/intents/status/v3?requestId=0xabc');
  assert.deepStrictEqual(out, { status: 'waiting' });
});
