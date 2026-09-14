'use strict';

// The fee gauge: how close the tank is to firing, for the site's
// GET /distribution.
//
// The numbers are produced by the BOT — it is the process that can read the
// escrow, price NVDA and see the scheduler — and persisted to Mongo on every
// poll. This service only reads them back, so the public API needs no wallet
// key and no RPC of its own.
//
// The consequence worth knowing: the gauge is as fresh as the bot's last tick
// (POLL_SCHEDULE, default 5 minutes), not as fresh as the request. That is the
// right trade — a per-visitor chain read would mean an RPC call per browser.
//
// `asOf`, not `updatedAt`: the site picks its cache-busting marker from the
// first of lastDistributionId / lastDistributionAt / updatedAt, so a field
// named `updatedAt` that changes every poll would reset the gauge animation on
// every request before the first distribution ever lands.

const config = require('./../config');
const repo = require('../db/repository');
const { cached } = require('./cache');

const COLLECTING = 'collecting';
const DISTRIBUTING = 'distributing';

/** Pure: a stored state document -> the shape the site reads. */
function buildGauge(state, thresholdFallback) {
  const s = state || {};
  const status = s.status === DISTRIBUTING ? DISTRIBUTING : COLLECTING;
  return {
    // 0 rather than null: the site clamps with Math.max(0, …) and an empty
    // tank is a real reading, not a missing one.
    collectedUsd: typeof s.collectedUsd === 'number' ? s.collectedUsd : 0,
    thresholdUsd: typeof s.thresholdUsd === 'number' && s.thresholdUsd > 0 ? s.thresholdUsd : thresholdFallback,
    status,
    // Null until a cycle has actually paid out. The site treats a CHANGE here
    // as "a distribution landed" and resets the gauge, so it must stay stable
    // between distributions.
    lastDistributionId: s.lastDistributionId ?? null,
    lastDistributionAt: s.lastDistributionAt ?? null,
    // Extras the current site ignores, useful for debugging and for a richer
    // panel later.
    collectedQuote: typeof s.collectedQuote === 'number' ? s.collectedQuote : null,
    // Everything the pool has earned us, reachable or not, and the part of it
    // still waiting on pons's operator to sweep. collectedUsd deliberately
    // excludes that: it is what could trigger a distribution right now, and
    // counting locked fees there filled the bar to 100% and had the site
    // announcing "BUYING" while the bot was still waiting on a sweep.
    accruedUsd: typeof s.accruedUsd === 'number' ? s.accruedUsd : null,
    pendingSweepUsd: typeof s.pendingSweepUsd === 'number' ? s.pendingSweepUsd : null,
    priceUsd: typeof s.priceUsd === 'number' ? s.priceUsd : null,
    // The gate in the quote token's own unit (1 NVDA in token mode), and which
    // gate it is, so a page can label the bar "1 NVDA" rather than a dollar
    // figure that drifts with the price.
    thresholdQuote: typeof s.thresholdQuote === 'number' && s.thresholdQuote > 0 ? s.thresholdQuote : null,
    triggerMode: s.triggerMode ?? null,
    asOf: s.at ?? null,
  };
}

/** Pure: the dollar threshold to fall back on when the bot has not stored one. */
function thresholdFallback(state, cfg = config) {
  // Token mode fires on an amount, so its dollar threshold only exists at a
  // price. CLAIM_EVERY_USD is meaningless in that mode; use it only as a last
  // resort so the bar has SOME denominator rather than dividing by nothing.
  if (cfg.triggerMode === 'token' && state && typeof state.priceUsd === 'number' && state.priceUsd > 0) {
    return cfg.claimEveryTokens * state.priceUsd;
  }
  return cfg.claimEveryUsd;
}

async function fetchGauge() {
  const state = await repo.getDistributionState();
  return buildGauge(state, thresholdFallback(state));
}

// Short TTL: the site polls this often, and the underlying value only moves
// when the bot ticks anyway.
const getGauge = cached(10_000, fetchGauge);

module.exports = { getGauge, fetchGauge, buildGauge, thresholdFallback, COLLECTING, DISTRIBUTING };
