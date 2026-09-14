'use strict';

// Total NVDA paid to holders — summed from this project's own airdrop ledger.
//
// This previously read Pons's fee-distributor API, which was the right source
// while Pons did the distributing. This launch keeps creator fees with the bot,
// so there IS no distributor: the bot claims and airdrops, and its records are
// the only authority on what holders have actually been paid.
//
// `getDistributedTotal` counts only payouts carrying a real on-chain
// transaction hash, so simulated DRY_RUN rows are never included — publishing
// those would show visitors a headline number backed by transactions that do
// not exist.
//
// Null (not 0) before launch: the site hides a null tile, but would render a
// zero as a real "nothing has been paid yet" claim. Once the token is live, a
// real zero means no cycle has paid out yet and is served as 0.

const config = require('./../config');
const repo = require('../db/repository');
const { cached } = require('./cache');

const EMPTY = { totalRewarded: null, totalRewarded2: null, totalRewardedOwn: null };

async function fetchRewards() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing to sum
  // One total PER REWARD ASSET. The ledger stores reward_token on every payout
  // row, so each leg is its own sum — adding NVDA to AI would be a number that
  // means nothing, and reporting only the first would hide half of what holders
  // were paid.
  const [leg1, leg2, own] = await Promise.all([
    repo.getDistributedTotal(config.rewardTokenAddress),
    config.reward2TokenAddress ? repo.getDistributedTotal(config.reward2TokenAddress) : null,
    // BABYAI bought back and airdropped. Summed from the airdrop ledger, which is
    // the right source: the burn ledger is a different set of steps entirely, so a
    // buyback-to-DISTRIBUTE can never inflate totalBurned, nor a burn this.
    config.ownTokenPct > 0 ? repo.getDistributedTotal(config.tokenAddress) : null,
  ]);
  return {
    totalRewarded: leg1.totalUi ?? 0,
    // Null, not 0, when there is no second leg configured at all: the site hides
    // a null tile but renders a 0 as "nothing has been paid", which is a claim.
    totalRewarded2: leg2 ? leg2.totalUi ?? 0 : null,
    // Null when OWN_TOKEN_PCT is 0, so a page hides the tile rather than showing
    // "0 BABYAI paid" for a leg that is switched off.
    totalRewardedOwn: own ? own.totalUi ?? 0 : null,
  };
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getRewards = cached(config.rewardsTtlMs, fetchRewards);

module.exports = { getRewards, fetchRewards, EMPTY };
