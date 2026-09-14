'use strict';

// GET /stats returns what the site's BOOT window reads (src/api/mockData.js
// in the frontend documents the shape; VideoTV.jsx renders it):
//
//   { "marketCap": 4189702,        -> "Market Cap" panel, formatted with a "$"
//     "ketDistributed": 826.7,     -> "Total $NVDA Distributed" panel, NVDA token amount
//     "totalHolders": 12879 }
//
// The remaining fields are aliases and extras for sites built from the other
// templates in this lineage (`nvdaRewarded`/`rewarded` = USD figure, `price`,
// `holders`), so any of those frontends works against this API unchanged.
// A field that cannot be sourced is null, never 0 — the site renders a null
// as "—", but would render a 0 as a real number.

const express = require('express');
const config = require('../config');
const { getMarketData } = require('../services/marketdata');
const { getTokenInfo } = require('../services/holders');
const { getRewards } = require('../services/rewards');
const { getCurveMarket } = require('../services/curvemarket');
const { getQuotePrice } = require('../services/quoteprice');
const { getRewardPrice, getReward2Price } = require('../services/rewardprice');
const { getBurns } = require('../services/burns');
const { getCreatorFees } = require('../services/creatorfees');

const router = express.Router();

/**
 * Pure: what the burned BABYINU is worth at the CURRENT price.
 *
 * Deliberately distinct from `burnQuoteSpent`, which is what the buybacks
 * actually cost in NVDA. The two answer different questions and drift apart as
 * the price moves; conflating them would let the site claim a burn was worth
 * more (or less) than was ever spent on it.
 */
function burnedUsd(burns, priceUsd) {
  if (typeof burns.totalBurned !== 'number' || typeof priceUsd !== 'number') return null;
  return burns.totalBurned * priceUsd;
}

/** Pure: burned tokens as a share of what was minted, in percent. */
function burnedPctOfSupply(burns, token) {
  if (typeof burns.totalBurned !== 'number') return null;
  if (token.totalSupply == null || token.decimals == null) return null;
  const minted = Number(BigInt(token.totalSupply)) / 10 ** token.decimals;
  // The explorer reports CIRCULATING supply, which a burn has already reduced —
  // so the denominator is what remains plus what we destroyed.
  const original = minted + burns.totalBurned;
  if (!(original > 0)) return null;
  return (burns.totalBurned / original) * 100;
}

/**
 * Pure: USD value of what holders were PAID.
 *
 * Priced with the REWARD token's own price. The amount is denominated in
 * Artificial Inu, so valuing it at NVDA's price - a tokenized stock worth a few
 * hundred dollars - overstates the payout by orders of magnitude.
 */
function rewardedUsd(rewards, rewardPrice) {
  if (typeof rewards.totalRewarded !== 'number' || typeof rewardPrice.priceUsd !== 'number') return null;
  return rewards.totalRewarded * rewardPrice.priceUsd;
}

/**
 * Pure: market cap computed from the bonding-curve price and the token's
 * total supply, for the window before the token graduates to a real pool.
 * Needs both halves — a price with no supply (or vice versa) is null.
 */
function curveMarketCap(curve, token) {
  if (typeof curve.priceUsd !== 'number') return null;
  if (token.totalSupply == null || token.decimals == null) return null;
  return (Number(BigInt(token.totalSupply)) / 10 ** token.decimals) * curve.priceUsd;
}

/**
 * Pure: the configured supply as Blockscout would report it (a wei string plus
 * decimals), or null when TOKEN_TOTAL_SUPPLY is not set.
 */
function supplyFallback({ tokenTotalSupply, tokenDecimals }) {
  if (tokenTotalSupply == null || !Number.isFinite(tokenTotalSupply) || tokenTotalSupply <= 0) return null;
  const decimals = Number.isFinite(tokenDecimals) ? tokenDecimals : 18;
  return {
    totalSupply: (BigInt(Math.round(tokenTotalSupply)) * 10n ** BigInt(decimals)).toString(),
    decimals,
  };
}

/**
 * Pure: fill in supply/decimals from the fallback when the explorer could not
 * provide them, so the bonding-curve market cap survives a Blockscout outage
 * (its Cloudflare front intermittently refuses API calls). Explorer values
 * always win when present.
 */
function withSupplyFallback(token, fallback) {
  if (!fallback) return token;
  return {
    ...token,
    totalSupply: token.totalSupply ?? fallback.totalSupply,
    decimals: token.decimals ?? fallback.decimals,
  };
}

/**
 * Pure: merge the five upstreams into the response body.
 *
 * Market cap prefers DexScreener (live pool pricing, exists only after the
 * token graduates), then Blockscout's circulating_market_cap (populated only
 * once the explorer has an exchange rate), then the bonding-curve computation
 * — so the tile shows a real number at every stage of the token's life.
 */
function buildStats({
  market,
  token: explorerToken,
  rewards = {},
  burns = {},
  curve = {},
  quote = {},
  rewardPrice = {},
  reward2Price = {},
  creatorFees = {},
  symbol,
  tokenAddress,
  supply = null,
  reward2Symbol = 'AI',
  reward2TokenAddress = null,
  rewardSymbol = 'NVDA',
  rewardTokenAddress = null,
  ownTokenAddress = null,
}) {
  const token = withSupplyFallback(explorerToken, supply);
  const priceUsd = market.priceUsd ?? curve.priceUsd ?? null;
  const totalRewarded = rewards.totalRewarded ?? null; // NVDA token amount
  const totalRewardedUsd = rewardedUsd(rewards, rewardPrice);
  // Leg two: the AI bought with half the holders' share and airdropped. Its own
  // amount and its own price — valuing an AI amount at NVDA's price would
  // overstate it by three orders of magnitude.
  const totalRewarded2 = rewards.totalRewarded2 ?? null;
  const totalRewarded2Usd = rewardedUsd({ totalRewarded: totalRewarded2 }, reward2Price);
  // Leg three: BABYINU itself, bought back and handed to holders. Valued at the
  // token's own live price (the pool after graduation, the curve before).
  const totalRewardedOwn = rewards.totalRewardedOwn ?? null;
  const totalRewardedOwnUsd =
    typeof totalRewardedOwn === 'number' && typeof priceUsd === 'number' ? totalRewardedOwn * priceUsd : null;
  // Null only when NO leg is priced; a priced leg plus an unpriced one is the
  // priced leg, never null — one unlisted asset must not blank the others.
  const sumUsd = (...xs) =>
    xs.some((x) => typeof x === 'number') ? xs.reduce((n, x) => n + (typeof x === 'number' ? x : 0), 0) : null;
  const holders = token.holders ?? null;
  const marketCap = market.marketCap ?? token.circulatingMarketCap ?? curveMarketCap(curve, token);
  return {
    marketCap,
    // ── This project's site: goodsht-meme6, src/api/stats.js ─────────────
    // Its normalise() reads marketCap, aiDistributed and nvdaDistributed, prints
    // all three through formatUsd — as DOLLARS — and throws
    // MALFORMED_STATS_PAYLOAD unless all three survive Number(). So in THIS API
    // every `<asset>Distributed` is a USD figure, `<asset>DistributedTokens` is
    // the token count, and `<asset>DistributedUsd` repeats the dollars under an
    // unambiguous name.
    //
    // This deliberately differs from the Cat fork, whose site read
    // nvdaDistributed as a token count. Serving tokens here would have shown
    // "$30" for 30 NVDA (~220x low) and "$19.0K" for 19,000 AI (~3.3x high).
    //
    // The keys are always present, null when unsourced: Number(undefined) is NaN
    // and would fail the whole panel, while Number(null) is 0 and renders.
    // Amounts come from the bot's own ledger, which counts only payouts with a
    // real transaction hash, so no tile can ever show a DRY_RUN.
    marketCapUsd: marketCap,
    // The END of each fallback chain in the site's normalise(), served with the
    // same value. It writes Number(raw.marketCap ?? raw.market_cap ?? raw.mcap),
    // and ?? treats null as missing: with only marketCap present, an unknown
    // (null) value fell through to an ABSENT alternate, Number(undefined) is NaN,
    // and the whole panel read UPLINK FAILED — before launch, and on any cold
    // start before a price loads. Present-but-null survives the chain as null,
    // which Number() turns into 0.
    market_cap: marketCap,
    mcap: marketCap,
    ai_distributed: totalRewarded2Usd,
    nvda_distributed: totalRewardedUsd,
    nvdaDistributed: totalRewardedUsd,
    nvdaDistributedUsd: totalRewardedUsd,
    nvdaDistributedTokens: totalRewarded,
    // ── The SECOND reward asset (AI) ─────────────────────────────────────
    // `totalRewarded2` mirrors `totalRewarded` below, for a caller that reads the
    // legs positionally rather than by ticker (token counts).
    totalRewarded2,
    totalRewarded2Usd,
    [`${reward2Symbol.toLowerCase()}Distributed`]: totalRewarded2Usd,
    [`${reward2Symbol.toLowerCase()}DistributedUsd`]: totalRewarded2Usd,
    [`${reward2Symbol.toLowerCase()}DistributedTokens`]: totalRewarded2,
    // ── The THIRD asset: the project's own token, bought back for holders ──
    // Under its own ticker (`babyinuDistributed`) and a positional name
    // (`ownTokenDistributed`) for a page that does not know the ticker. Same
    // rule: *Distributed is dollars, *DistributedTokens is the count.
    ownTokenDistributed: totalRewardedOwnUsd,
    ownTokenDistributedUsd: totalRewardedOwnUsd,
    ownTokenDistributedTokens: totalRewardedOwn,
    [`${String(symbol || 'token').toLowerCase()}Distributed`]: totalRewardedOwnUsd,
    [`${String(symbol || 'token').toLowerCase()}DistributedUsd`]: totalRewardedOwnUsd,
    [`${String(symbol || 'token').toLowerCase()}DistributedTokens`]: totalRewardedOwn,
    // Everything holders were paid, in dollars, across all three assets — the
    // one figure that is comparable between them.
    distributedUsdTotal: sumUsd(totalRewardedUsd, totalRewarded2Usd, totalRewardedOwnUsd),
    // The whole set, for a page that would rather loop than hardcode tickers.
    rewardAssets: [
      { symbol: rewardSymbol, tokenAddress: rewardTokenAddress, amount: totalRewarded, amountUsd: totalRewardedUsd },
      { symbol: reward2Symbol, tokenAddress: reward2TokenAddress, amount: totalRewarded2, amountUsd: totalRewarded2Usd },
      ...(ownTokenAddress
        ? [{ symbol, tokenAddress: ownTokenAddress, amount: totalRewardedOwn, amountUsd: totalRewardedOwnUsd }]
        : []),
    ].filter((a) => a.symbol),
    // The Neko-template site (tokenmeme15) reads these two first and falls back
    // to the camelCase names; serving both means a frontend rename cannot break it.
    market_cap_usd: marketCap,
    total_distributed_usd: totalRewardedUsd,
    holders,
    totalHolders: holders, // the name both site templates read
    totalRewarded,
    // "Total $NVDA Distributed" panel — the site shows this without a "$", so
    // it is the NVDA token amount, not USD. (Field name inherited from the
    // template's original token.)
    ketDistributed: totalRewarded,
    totalRewardedUsd,
    // USD figure under the names the other frontend templates read
    // (`raw.<asset>Rewarded ?? raw.<asset>_rewarded ?? raw.rewarded`).
    nvdaRewarded: totalRewardedUsd,
    rewarded: totalRewardedUsd,
    // The Neko-template site labels its card "TOTAL $NVDA DISTRIBUTED" and
    // resolves it from `rewardDistributed` FIRST, falling back to
    // `totalDistributed` — which is USD. Without this pair it put dollars under
    // an NVDA label, overstating the token count by NVDA's price. Tokens here,
    // dollars in rewardUsd, which is what its subtitle reads.
    rewardDistributed: totalRewarded,
    rewardUsd: totalRewardedUsd,
    // The space-inu site reads `totalDistributed` and renders it through
    // compactCurrency with a "$" prefix, so it wants the USD figure — not the
    // NVDA token amount that `totalRewarded` carries.
    totalDistributed: totalRewardedUsd,
    // ── Buyback + burn ──────────────────────────────────────────────────────
    // BABYINU tokens destroyed. The headline number for the burn tile.
    totalBurned: burns.totalBurned ?? null,
    // What those buybacks cost, in NVDA — what was actually spent.
    burnQuoteSpent: burns.burnQuoteSpent ?? null,
    // What the burned tokens are worth at today's price — a different figure
    // from what they cost, and it moves with the market.
    totalBurnedUsd: burnedUsd(burns, priceUsd),
    burnedPctOfSupply: burnedPctOfSupply(burns, token),
    burns: burns.burns ?? null,

    // ── Creator fees EARNED ─────────────────────────────────────────────────
    // What the launch has swept in total, before the split takes its share for
    // gas. Deliberately its own pair of fields rather than folded into the
    // rewarded total: that one is what holders were actually PAID, with a
    // transaction hash behind every row of the feed, and this one is larger.
    // Showing this under that label would be a claim anyone could disprove by
    // adding up /rewards.
    feesEarned: creatorFees.feesEarned ?? null,
    feesEarnedUsd:
      typeof creatorFees.feesEarned === 'number' && typeof quote.priceUsd === 'number'
        ? creatorFees.feesEarned * quote.priceUsd
        : null,
    // How many times pons has swept fees into the escrow.
    sweeps: creatorFees.sweeps ?? null,

    priceUsd,
    price: priceUsd,
    liquidityUsd: market.liquidityUsd ?? null,
    symbol,
    tokenAddress: tokenAddress ?? null,
    updatedAt: new Date().toISOString(),
  };
}

router.get('/stats', async (req, res, next) => {
  try {
    // Independent upstreams — one being down must not delay or fail the other,
    // so all settle and a rejection degrades to nulls for its own fields only.
    const [
      marketResult,
      tokenResult,
      rewardsResult,
      burnsResult,
      curveResult,
      quoteResult,
      rewardPriceResult,
      reward2PriceResult,
      feesResult,
    ] = await Promise.allSettled([
        getMarketData(),
        getTokenInfo(),
        getRewards(),
        getBurns(),
        getCurveMarket(),
        getQuotePrice(),
        getRewardPrice(),
        getReward2Price(),
        getCreatorFees(),
      ]);

    const market = marketResult.status === 'fulfilled' ? marketResult.value : {};
    const token = tokenResult.status === 'fulfilled' ? tokenResult.value : {};
    const rewards = rewardsResult.status === 'fulfilled' ? rewardsResult.value : {};
    const burns = burnsResult.status === 'fulfilled' ? burnsResult.value : {};
    const curve = curveResult.status === 'fulfilled' ? curveResult.value : {};
    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : {};
    const rewardPrice = rewardPriceResult.status === 'fulfilled' ? rewardPriceResult.value : {};
    const reward2Price = reward2PriceResult.status === 'fulfilled' ? reward2PriceResult.value : {};
    const creatorFees = feesResult.status === 'fulfilled' ? feesResult.value : {};

    if (marketResult.status === 'rejected') {
      console.warn('[aibaby] market data unavailable:', marketResult.reason?.message);
    }
    if (tokenResult.status === 'rejected') {
      console.warn('[aibaby] holder count unavailable:', tokenResult.reason?.message);
    }
    if (rewardsResult.status === 'rejected') {
      console.warn('[aibaby] rewards unavailable:', rewardsResult.reason?.message);
    }
    if (burnsResult.status === 'rejected') {
      console.warn('[aibaby] burn totals unavailable:', burnsResult.reason?.message);
    }
    if (curveResult.status === 'rejected') {
      console.warn('[aibaby] curve price unavailable:', curveResult.reason?.message);
    }
    if (quoteResult.status === 'rejected') {
      console.warn('[aibaby] NVDA price unavailable:', quoteResult.reason?.message);
    }
    if (rewardPriceResult.status === 'rejected') {
      console.warn('[aibaby] AI price unavailable:', rewardPriceResult.reason?.message);
    }
    if (reward2PriceResult.status === 'rejected') {
      console.warn(`[aibaby] ${config.reward2Symbol} price unavailable:`, reward2PriceResult.reason?.message);
    }
    if (feesResult.status === 'rejected') {
      console.warn('[aibaby] creator-fee total unavailable:', feesResult.reason?.message);
    }

    res.json(
      buildStats({
        market,
        token,
        rewards,
        burns,
        curve,
        quote,
        rewardPrice,
        creatorFees,
        symbol: config.tokenSymbol,
        tokenAddress: config.tokenAddress,
        supply: supplyFallback(config),
        reward2Price,
        rewardSymbol: config.rewardSymbol,
        rewardTokenAddress: config.rewardTokenAddress,
        reward2Symbol: config.reward2Symbol,
        reward2TokenAddress: config.reward2SharePct > 0 ? config.reward2TokenAddress : null,
        ownTokenAddress: config.ownTokenPct > 0 ? config.tokenAddress : null,
      })
    );
  } catch (err) {
    next(err);
  }
});

module.exports = { router, buildStats, supplyFallback, withSupplyFallback };
