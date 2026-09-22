'use strict';

// The /swap routes end to end, against a fake Relay that answers with real
// responses captured for this token on 2026-09-22.

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { Transaction } = require('@solana/web3.js');
const config = require('../config');
const { createSwapRouter } = require('./swap');
const { RelayError } = require('../swap/relay');

const ABI = '0x657bd0541f2e8f89bdb85bcd91589695ca24b85a';
const EVM_FIXTURE = require('../swap/fixtures/relay-quote-base-eth.json');
const SOL_FIXTURE = require('../swap/fixtures/relay-quote-solana-sol.json');
const EVM_USER = '0x1111111111111111111111111111111111111111';
const SOL_USER = 'CbPkzKxEowdmx3yZdBJ8u2K7kF2iSKqWW4bP2yKqvD3Q';
const REQ_ID = EVM_FIXTURE.steps[0].requestId;
const clone = (o) => JSON.parse(JSON.stringify(o));

const CFG = { ...config, tokenAddress: ABI, tokenSymbol: 'ABI', chainId: 4663, swapEnabled: true, minSwapUsd: 10 };

/** A fake Relay: answers by origin chain, records every call. */
function fakeRelay({ quote, status } = {}) {
  const calls = [];
  return {
    calls,
    fetchQuote: async (body) => {
      calls.push(body);
      if (quote) return quote(body);
      return clone(body.originChainId === 792703809 ? SOL_FIXTURE : EVM_FIXTURE);
    },
    fetchStatus: async (id) => (status ? status(id) : { status: 'waiting' }),
  };
}

async function withServer(deps, fn) {
  let t = 1_000_000;
  const app = express();
  app.use('/swap', createSwapRouter({ blockhash: { get: async () => ({ blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 7 }) }, cfg: CFG, now: () => t, ...deps }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'internal error' })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/swap`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ call, advance: (ms) => { t += ms; } });
  } finally {
    server.close();
  }
}

const quoteBase = (extra = {}) => ({ fromToken: 'ETH', fromChain: 'base', amount: '0.01', slippage: 1, toToken: 'ABI', toChain: 'robinhood', ...extra });

test('GET /tokens lists the six coins and names the destination', async () => {
  await withServer({ relay: fakeRelay() }, async ({ call }) => {
    const { status, body } = await call('GET', '/tokens');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.tokens.length, 6);
    assert.deepStrictEqual(body.tokens.map((t) => `${t.symbol}/${t.chain}`), ['ETH/ethereum', 'ETH/base', 'ETH/arbitrum', 'ETH/optimism', 'BNB/bsc', 'SOL/solana']);
    assert.strictEqual(body.toToken.address, ABI);
    assert.strictEqual(body.toToken.chainId, 4663);
  });
});

test('POST /quote answers a price with a quoteId, and asks Relay for ABI only', async () => {
  const relay = fakeRelay();
  await withServer({ relay }, async ({ call }) => {
    const { status, body } = await call('POST', '/quote', quoteBase({ toToken: 'SOMETHING_ELSE', toChain: 'ethereum' }));
    assert.strictEqual(status, 200);
    assert.match(body.quoteId, /^[0-9a-f]{24}$/);
    assert.ok(Number(body.toAmount) > 0);
    assert.ok(body.expiresAt);
    assert.strictEqual(relay.calls[0].destinationCurrency, ABI, 'the request cannot redirect the destination');
    assert.strictEqual(relay.calls[0].destinationChainId, 4663);
    assert.strictEqual(relay.calls[0].slippageTolerance, '100');
  });
});

test('identical price quotes inside 5s share one Relay call', async () => {
  const relay = fakeRelay();
  await withServer({ relay }, async ({ call, advance }) => {
    await call('POST', '/quote', quoteBase());
    await call('POST', '/quote', quoteBase());
    assert.strictEqual(relay.calls.length, 1);
    advance(6000);
    await call('POST', '/quote', quoteBase());
    assert.strictEqual(relay.calls.length, 2);
  });
});

test('an unlisted coin, a bad amount and a dust amount are refused with a reason', async () => {
  await withServer({ relay: fakeRelay() }, async ({ call }) => {
    const usdc = await call('POST', '/quote', quoteBase({ fromToken: 'USDC', fromChain: 'ethereum' }));
    assert.strictEqual(usdc.status, 400);
    assert.match(usdc.body.message, /ETH .*BNB or SOL/);
    const bad = await call('POST', '/quote', quoteBase({ amount: 'lots' }));
    assert.strictEqual(bad.status, 400);
  });
  const tiny = fakeRelay({ quote: () => { const r = clone(EVM_FIXTURE); r.details.currencyIn.amountUsd = '2.10'; return r; } });
  await withServer({ relay: tiny }, async ({ call }) => {
    const res = await call('POST', '/quote', quoteBase());
    assert.strictEqual(res.status, 422);
    assert.match(res.body.message, /minimum swap is \$10/);
  });
});

test('Relay’s own refusals reach the buyer in Relay’s words', async () => {
  const relay = fakeRelay({ quote: () => { throw new RelayError('Swap output amount is too small to cover fees required to execute swap', { status: 422, code: 'AMOUNT_TOO_LOW' }); } });
  await withServer({ relay }, async ({ call }) => {
    const res = await call('POST', '/quote', quoteBase());
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'AMOUNT_TOO_LOW');
    assert.match(res.body.message, /too small/);
  });
});

test('POST /execute for ETH returns one transaction to sign, from the buyer’s wallet', async () => {
  const relay = fakeRelay();
  await withServer({ relay }, async ({ call }) => {
    const { body: quote } = await call('POST', '/quote', quoteBase());
    const { status, body } = await call('POST', '/execute', { quoteId: quote.quoteId, wallet: EVM_USER });
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.strictEqual(body.trackingId, REQ_ID);
    assert.strictEqual(body.tx.chainId, 8453);
    assert.strictEqual(typeof body.tx.gas, 'number');
    assert.strictEqual(body.recipient, EVM_USER);
    const executeCall = relay.calls[relay.calls.length - 1];
    assert.strictEqual(executeCall.user, EVM_USER, 're-quoted with the real wallet');
    assert.strictEqual(executeCall.recipient, EVM_USER);
  });
});

test('POST /execute for SOL needs a 0x recipient and returns an unsigned Solana transaction', async () => {
  await withServer({ relay: fakeRelay() }, async ({ call }) => {
    const { body: quote } = await call('POST', '/quote', quoteBase({ fromToken: 'SOL', fromChain: 'solana', amount: '0.2' }));
    const missing = await call('POST', '/execute', { quoteId: quote.quoteId, wallet: SOL_USER });
    assert.strictEqual(missing.status, 400);
    assert.match(missing.body.message, /0x address/);

    const { status, body } = await call('POST', '/execute', { quoteId: quote.quoteId, wallet: SOL_USER, recipient: EVM_USER });
    assert.strictEqual(status, 200, JSON.stringify(body));
    const tx = Transaction.from(Buffer.from(body.solanaTx, 'base64'));
    assert.strictEqual(tx.feePayer.toBase58(), SOL_USER);
    assert.strictEqual(body.recipient, EVM_USER);
    assert.strictEqual(body.lastValidBlockHeight, 7);
  });
});

test('a quote older than 60s cannot be executed', async () => {
  await withServer({ relay: fakeRelay() }, async ({ call, advance }) => {
    const { body: quote } = await call('POST', '/quote', quoteBase());
    advance(61_000);
    const res = await call('POST', '/execute', { quoteId: quote.quoteId, wallet: EVM_USER });
    assert.strictEqual(res.status, 410);
    assert.match(res.body.message, /expired/);
  });
});

test('a Relay answer that fails the checks is never handed to a wallet', async () => {
  let n = 0;
  const relay = fakeRelay({ quote: () => { n += 1; const r = clone(EVM_FIXTURE); if (n > 1) r.steps[0].items[0].data.from = '0x2222222222222222222222222222222222222222'; return r; } });
  await withServer({ relay }, async ({ call }) => {
    const { body: quote } = await call('POST', '/quote', quoteBase());
    const res = await call('POST', '/execute', { quoteId: quote.quoteId, wallet: EVM_USER });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.tx, undefined);
    assert.match(res.body.message, /refusing/);
  });
});

test('status maps Relay onto the site’s steps and links the reported deposit', async () => {
  const relay = fakeRelay({ status: () => ({ status: 'pending' }) });
  await withServer({ relay }, async ({ call }) => {
    const { body: quote } = await call('POST', '/quote', quoteBase());
    await call('POST', '/execute', { quoteId: quote.quoteId, wallet: EVM_USER });
    const hash = '0x' + 'ab'.repeat(32);
    await call('POST', `/status/${REQ_ID}`, { txHash: hash });
    const { status, body } = await call('GET', `/status/${REQ_ID}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'bridging');
    assert.strictEqual(body.step, 2);
    assert.strictEqual(body.explorerUrl, `https://basescan.org/tx/${hash}`);
  });
});

test('a malformed tracking id is refused without calling Relay', async () => {
  let called = false;
  const relay = fakeRelay({ status: () => { called = true; return {}; } });
  await withServer({ relay }, async ({ call }) => {
    const res = await call('GET', '/status/not-an-id');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(called, false);
  });
});

test('SWAP_ENABLED=false closes every route', async () => {
  const app = express();
  app.use('/swap', createSwapRouter({ relay: fakeRelay(), cfg: { ...CFG, swapEnabled: false }, blockhash: { get: async () => ({}) } }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/swap/tokens`);
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});
