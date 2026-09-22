'use strict';

// Buy the launch token from any chain: the /swap routes behind the site's
// "Swap for $ABI" section. The contract is the one the site's src/api/swap.js
// already calls — tokens, quote, execute, status.
//
// This process only QUOTES and SHAPES transactions. The buyer's wallet signs
// every one; there is no key here, and nothing here can move funds.

const express = require('express');
const config = require('../config');
const relayModule = require('../swap/relay');
const { ASSETS, findAsset, assetByKey, destination, publicToken } = require('../swap/assets');
const q = require('../swap/quotes');
const { buildSolanaTransaction, createBlockhashProvider } = require('../swap/solana');
const { createStore } = require('../swap/store');

const QUOTE_TTL_MS = 60_000;
const TRACK_TTL_MS = 60 * 60_000;
// Every visitor's price quote comes from this server's one IP, and anonymous
// Relay allows about 5 per window. Identical price-only requests inside this
// window share one Relay call.
const PRICE_CACHE_MS = 5_000;
const REQUEST_ID_RE = /^0x[0-9a-fA-F]{64}$/;

const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

/**
 * @param {object} [deps] injectable for tests
 * @param {{ fetchQuote: Function, fetchStatus: Function }} [deps.relay]
 * @param {{ get: Function }} [deps.blockhash]
 * @param {object} [deps.cfg]
 * @param {() => number} [deps.now]
 */
function createSwapRouter({ relay = relayModule, blockhash, cfg = config, now = Date.now } = {}) {
  const router = express.Router();
  const bh = blockhash || createBlockhashProvider({ rpcUrl: cfg.solanaRpcUrl });
  const quotes = createStore({ ttlMs: QUOTE_TTL_MS, now });
  const tracked = createStore({ ttlMs: TRACK_TTL_MS, now });
  const priceCache = createStore({ ttlMs: PRICE_CACHE_MS, now, max: 500 });

  router.use(express.json({ limit: '10kb' }));

  if (!cfg.swapEnabled) {
    router.use((req, res) => res.status(404).json({ error: 'swap is disabled', message: 'swap is disabled' }));
    return router;
  }

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!cfg.tokenAddress) {
      return res.status(503).json({ error: 'swap is not configured', message: 'swap is not configured' });
    }
    return next();
  });

  router.get('/tokens', (req, res) => {
    res.json({ tokens: ASSETS.map(publicToken), toToken: destination(cfg) });
  });

  // Price-only: no wallet needed, nothing signable returned.
  router.post('/quote', async (req, res, next) => {
    try {
      const b = req.body || {};
      const asset = findAsset(str(b.fromToken ?? b.from_token), str(b.fromChain ?? b.from_chain));
      if (!asset) throw new q.SwapInputError('pay with ETH (Ethereum, Base, Arbitrum, Optimism), BNB or SOL');
      const dest = destination(cfg);
      const amount = str(b.amount);
      const slippage = b.slippage;
      const body = q.buildRelayBody({ asset, dest, amount, slippage });

      const cacheKey = `${asset.key}|${body.amount}|${body.slippageTolerance}`;
      let relayQuote = priceCache.get(cacheKey);
      if (!relayQuote) {
        relayQuote = await relay.fetchQuote(body, { cfg });
        priceCache.put(relayQuote, cacheKey);
      }
      q.checkMinimum(relayQuote, cfg.minSwapUsd);

      const { id, expiresAt } = quotes.put({ assetKey: asset.key, amount, slippage: Number(body.slippageTolerance) / 100 });
      res.json(q.shapeQuote(relayQuote, { quoteId: id, expiresAt: new Date(expiresAt).toISOString(), dest }));
    } catch (err) {
      next(err);
    }
  });

  // The buyer's real wallet: a fresh quote, checked, shaped for signing.
  router.post('/execute', async (req, res, next) => {
    try {
      const b = req.body || {};
      const stored = quotes.get(str(b.quoteId ?? b.quote_id));
      if (!stored) throw new q.SwapInputError('this quote has expired — refresh it and try again', 410);
      const asset = assetByKey(stored.assetKey);
      const dest = destination(cfg);
      const { user, recipient } = q.parties(asset, { wallet: str(b.wallet), recipient: str(b.recipient) });

      // The blockhash is fetched alongside Relay, not after it: two sequential
      // upstream calls once outran nginx's timeout. The no-op catch stops an
      // unused rejection from crashing Node; the real await below still throws.
      const hashPromise = asset.vm === 'svm' ? bh.get() : null;
      if (hashPromise) hashPromise.catch(() => {});

      const body = q.buildRelayBody({ asset, dest, amount: stored.amount, slippage: stored.slippage, user, recipient });
      const relayQuote = await relay.fetchQuote(body, { cfg });
      q.checkMinimum(relayQuote, cfg.minSwapUsd);
      const exec = q.executableFrom(relayQuote, { asset, dest, user, recipient });

      tracked.put({ assetKey: asset.key, recipient }, exec.requestId);
      const quote = q.shapeQuote(relayQuote, { quoteId: str(b.quoteId ?? b.quote_id), expiresAt: null, dest });

      if (exec.kind === 'svm') {
        const { blockhash, lastValidBlockHeight } = await hashPromise;
        const solanaTx = buildSolanaTransaction({ instructions: exec.instructions, feePayer: user, blockhash });
        return res.json({ trackingId: exec.requestId, solanaTx, lastValidBlockHeight, recipient, quote });
      }
      return res.json({ trackingId: exec.requestId, tx: exec.tx, recipient, quote });
    } catch (err) {
      next(err);
    }
  });

  router.get('/status/:id', async (req, res, next) => {
    try {
      const id = str(req.params.id);
      if (!REQUEST_ID_RE.test(id)) throw new q.SwapInputError('unknown swap id');
      const t = tracked.get(id); // null after a restart — status still works, minus the explorer link
      const relayStatus = await relay.fetchStatus(id, { cfg });
      res.json(q.shapeStatus(relayStatus, { asset: t ? assetByKey(t.assetKey) : null, dest: destination(cfg), reportedTxHash: t?.txHash }));
    } catch (err) {
      next(err);
    }
  });

  // Which hash the buyer broadcast, so status can link it before Relay sees it.
  router.post('/status/:id', (req, res) => {
    const id = str(req.params.id);
    const txHash = str(req.body?.txHash ?? req.body?.tx_hash);
    if (REQUEST_ID_RE.test(id) && /^[0-9a-zA-Z]{32,100}$/.test(txHash.replace(/^0x/, ''))) tracked.patch(id, { txHash });
    res.json({ ok: true });
  });

  // Errors a buyer can act on are answered with their own words; anything else
  // goes to the app's generic 500, which logs detail and answers in general.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof q.SwapInputError || err instanceof relayModule.RelayError || (err && err.status && err.status < 600 && /refusing/.test(err.message))) {
      if (err.status >= 500) console.warn(`[swap] ${req.method} ${req.path}: ${err.message}`);
      return res.status(err.status || 400).json({ error: err.message, message: err.message, code: err.code || null });
    }
    return next(err);
  });

  return router;
}

module.exports = { createSwapRouter };
