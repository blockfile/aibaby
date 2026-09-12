'use strict';

// USD prices for the tokens holders are actually PAID in — one per reward leg.
//
// Distinct from quoteprice.js, and the distinction matters: holders are paid
// NVDA and AI, and valuing an AI amount at NVDA's price would overstate what
// they received by three orders of magnitude. Each leg is priced with its own
// asset's price, or not at all.
//
// Unlike NVDA, a memecoin's pair can genuinely be missing or unpriced, so this
// resolves to null rather than throwing. The site renders a null as "—", which
// is honest; a wrong number is not.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');
const { parsePairs } = require('./marketdata');

const EMPTY = { priceUsd: null };

async function fetchPriceFor(tokenAddress, { fetchFn = fetchJson } = {}) {
  if (!tokenAddress) return EMPTY;
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const data = await fetchFn(url, { headers: { accept: 'application/json' } });
  const market = parsePairs(data, tokenAddress, config.dexscreenerChainId);
  return { priceUsd: typeof market.priceUsd === 'number' ? market.priceUsd : null };
}

/** Leg one's asset (this launch: NVDA, the asset fees arrive in). */
async function fetchRewardPrice(opts = {}) {
  return fetchPriceFor(config.rewardTokenAddress, opts);
}

/** Leg two's asset (AI), bought with part of the holders' share. */
async function fetchReward2Price(opts = {}) {
  return fetchPriceFor(config.reward2TokenAddress, opts);
}

// Cached separately: two assets, two upstream reads, and one being unlisted
// must not blank the other.
const getRewardPrice = cached(config.marketTtlMs, fetchRewardPrice);
const getReward2Price = cached(config.marketTtlMs, fetchReward2Price);

module.exports = { getRewardPrice, getReward2Price, fetchRewardPrice, fetchReward2Price, fetchPriceFor, EMPTY };
