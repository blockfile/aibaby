'use strict';

// Total BABYINU bought back and burned, from this bot's own ledger.
//
// Same source and same rules as the rewards total: the bot is the only thing
// performing these burns, so its records are the authority, and only burns
// carrying a real on-chain transaction hash are counted — a DRY_RUN burn is
// recorded with a fabricated signature and must never reach a visitor.
//
// `quoteSpent` is what the burns actually COST, in NVDA. That is a different
// question from what the burned tokens are worth today, and both are served so
// the site can show either without doing arithmetic the backend already has the
// inputs for.
//
// Null (not 0) before launch: the site hides a null tile, but would render a
// zero as a real "nothing has been burned" claim. Once live, a real zero means
// no cycle has burned yet and is served as 0.

const config = require('./../config');
const repo = require('../db/repository');
const { cached } = require('./cache');

const EMPTY = {
  totalBurned: null,
  burnQuoteSpent: null,
  burns: null,
  totalBoughtBack: null,
  boughtBackQuoteSpent: null,
  buybacksHeld: null,
};

/**
 * Pure: everything permanently out of circulation, however it got there.
 *
 * Two mechanisms, one outcome — nobody can ever spend either:
 *
 *   burn(uint256)        reduces totalSupply
 *   transfer to 0x…dEaD  leaves totalSupply alone, but sends the tokens to an
 *                        address with no private key
 *
 * This chain counts both as burned, so `totalBurned` is the sum. They stay
 * separately reportable because they are not interchangeable to anyone
 * checking: an explorer reads totalSupply, which moves for the first and not
 * the second, and publishing the split is what gives that gap an answer.
 *
 * Preferred over our own ledger, which counts only buyback steps this bot
 * wrote — a burn done by hand is invisible to it, and the dead-address send was
 * exactly that. The ledger figure is still published, so the two can be
 * compared and a cycle that burned without recording it can be noticed.
 */
function pickBurnedSupply({ mintedSupply, supplyReduced, deadBalance, ledgerBurned }) {
  const has = (v) => typeof v === 'number' && Number.isFinite(v);
  const onChain = has(supplyReduced) || has(deadBalance)
    ? (has(supplyReduced) ? supplyReduced : 0) + (has(deadBalance) ? deadBalance : 0)
    : null;
  const totalBurned = onChain !== null ? onChain : has(ledgerBurned) ? ledgerBurned : null;

  return {
    totalBurned,
    burnedBySupplyReduction: has(supplyReduced) ? supplyReduced : null,
    burnedToDeadAddress: has(deadBalance) ? deadBalance : null,
    // What this bot's own cycles account for. The gap against totalBurned is
    // the burns that happened outside a cycle.
    totalBurnedByBot: has(ledgerBurned) ? ledgerBurned : null,
    burnedPctOfSupply:
      totalBurned !== null && has(mintedSupply) && mintedSupply > 0
        ? (totalBurned / mintedSupply) * 100
        : null,
  };
}

async function fetchBurns() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing to sum
  const [burned, held, state] = await Promise.all([
    repo.getBurnTotal(),
    repo.getBuybackHoldTotal(),
    // Written by the bot each poll — the API makes no chain calls of its own.
    repo.getDistributionState().catch(() => null),
  ]);
  const supply = pickBurnedSupply({
    mintedSupply: config.tokenTotalSupply,
    supplyReduced: state ? state.supplyReduced : null,
    deadBalance: state ? state.deadBalance : null,
    ledgerBurned: burned.tokensBurned ?? 0,
  });
  return {
    ...supply,
    burnQuoteSpent: burned.quoteSpent ?? 0,
    burns: burned.burns ?? 0,
    circulatingSupply: state && typeof state.circulatingSupply === 'number' ? state.circulatingSupply : null,
    // Bought back and KEPT (BUYBACK_HOLD_PCT) — a separate figure from the
    // burn: these tokens still exist, so supply has not dropped by them.
    totalBoughtBack: held.tokensBoughtBack ?? 0,
    boughtBackQuoteSpent: held.quoteSpent ?? 0,
    buybacksHeld: held.buybacks ?? 0,
  };
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getBurns = cached(config.rewardsTtlMs, fetchBurns);

module.exports = { getBurns, fetchBurns, pickBurnedSupply, EMPTY };
