'use strict';

// Buy a REWARD token with claimed quote.
//
// Artificial Cat pays holders TWO assets: NVDA, which the fees already arrive
// in and which therefore needs no swap at all, and AI, which has to be bought
// first. Both go through here — the leg being paid is passed in, so the same
// code serves the asset that needs a DEX and the one that does not, and adding
// a third asset is a descriptor rather than a new path.
//
// It routes through V4Buyer rather than the UniversalRouter, for the same
// reason the buyback does: the router cannot settle an ERC-20 input into a
// HOOKED v4 pool. Verified on this pool with the wallet funded and Permit2
// approved -- both SETTLE and SETTLE_ALL revert with empty data, while V4Buyer
// returns 89,152 AI for 100 NVDA. That is now confirmed on two unrelated hooks
// (pons's V2MemeHook and Doppler's), so treat it as the rule on this chain, not
// a quirk of one pool.

const { formatUnits } = require('ethers');
const config = require('../config');
const { buildPoolKey, poolIdOf, isZeroForOne, quoteExactInSingle } = require('./pool');
const { buyViaV4Buyer } = require('./v4buyer');
const { erc20, getDecimals } = require('./erc20');
const { provider, wallet } = require('./provider');
const { toUnitString } = require('./units');
const { parseUnits } = require('ethers');

/**
 * A reward leg: which asset to pay, and how to buy it if it is not the quote.
 * Leg one is whatever REWARD_TOKEN_ADDRESS names — on this launch the quote
 * asset itself, so its pool fields are never used.
 */
function rewardLegOne() {
  return {
    leg: 1,
    tokenAddress: config.rewardTokenAddress,
    decimals: config.rewardDecimals,
    symbol: config.rewardSymbol,
    poolFee: config.rewardPoolFee,
    poolTickSpacing: config.rewardPoolTickSpacing,
    poolHooks: config.rewardPoolHooks,
    slippageBps: config.rewardSlippageBps,
  };
}

/** Leg two: AI, bought with part of the holders' share through the v4 pool. */
function rewardLegTwo() {
  return {
    leg: 2,
    tokenAddress: config.reward2TokenAddress,
    decimals: config.reward2Decimals,
    symbol: config.reward2Symbol,
    poolFee: config.reward2PoolFee,
    poolTickSpacing: config.reward2PoolTickSpacing,
    poolHooks: config.reward2PoolHooks,
    slippageBps: config.reward2SlippageBps,
  };
}

/** The pool that buys this leg. Configured, not derived — it is an ordinary
 *  Uniswap pool with no launch record to read it from. */
function rewardPoolKey(reward = rewardLegOne()) {
  return buildPoolKey({
    token: reward.tokenAddress,
    quoteToken: config.quoteTokenAddress,
    fee: reward.poolFee,
    tickSpacing: reward.poolTickSpacing,
    hooks: reward.poolHooks,
  });
}

/** Pure: the smaller of what we want to spend and what we actually hold. */
function clampToBalance(wanted, held) {
  return wanted <= held ? wanted : held;
}

/**
 * Swap `quoteAmount` of NVDA for this leg's reward token, into this wallet.
 *
 * @param {{quoteAmount: number, reward?: object}} args `reward` defaults to leg one.
 * @returns {Promise<{bought: boolean, tokensBought: number, signature: string|null,
 *                    quoteSpent: number, error?: string}>}
 */
async function buyReward({ quoteAmount, reward = rewardLegOne() }) {
  const base = { bought: false, tokensBought: 0, signature: null, quoteSpent: 0 };
  if (!(quoteAmount > 0)) return { ...base, skipped: true, reason: 'reward share of this claim is zero' };

  // When holders are paid the SAME asset the fees arrive in, there is nothing
  // to buy: the claim is already denominated in the reward token. Skipping the
  // swap is not an optimisation, it is the correct behaviour - routing NVDA
  // through a NVDA/NVDA pool is meaningless, and a real swap would cost the
  // holders a fee and slippage for no gain.
  //
  // The rest of the cycle is unchanged, so one codebase serves both shapes:
  // pay the quote asset directly, or buy a third token with it first.
  if (reward.tokenAddress.toLowerCase() === config.quoteTokenAddress.toLowerCase()) {
    const raw = parseUnits(toUnitString(quoteAmount, reward.decimals), reward.decimals);
    return {
      bought: raw > 0n,
      boughtRaw: raw,
      tokensBought: quoteAmount,
      quoteSpent: quoteAmount,
      signature: null,
      direct: true,
    };
  }

  if (config.dryRun) {
    // Roughly the live rate, so a rehearsal's numbers are the right order of
    // magnitude rather than invented. Every chain call below is skipped: a dry
    // run must never need an RPC, and this one would fail having already
    // "claimed" the escrow.
    // Measured 2026-09-12: NVDA ~$221, AI ~$0.30, so 1 NVDA is roughly 730 AI.
    const tokens = +(quoteAmount * 730).toFixed(9);
    const boughtRaw = parseUnits(toUnitString(tokens, reward.decimals), reward.decimals);
    return {
      bought: boughtRaw > 0n,
      boughtRaw,
      tokensBought: tokens,
      quoteSpent: quoteAmount,
      signature: `rewardswap_${Date.now().toString(36)}`,
    };
  }

  const wantRaw = parseUnits(toUnitString(quoteAmount, config.quoteDecimals), config.quoteDecimals);
  const held = await erc20(config.quoteTokenAddress, provider).balanceOf(wallet.address);
  const spendRaw = clampToBalance(wantRaw, held);
  if (spendRaw <= 0n) {
    return { ...base, skipped: true, reason: 'the wallet holds no NVDA to buy rewards with' };
  }
  if (spendRaw < wantRaw) {
    console.log(
      `[reward-swap] wallet holds ${formatUnits(held, config.quoteDecimals)} NVDA but the share is ` +
        `${quoteAmount} — spending what is there (rounding dust)`
    );
  }

  const poolKey = rewardPoolKey(reward);
  const zeroForOne = isZeroForOne(poolKey, config.quoteTokenAddress);
  const quoted = await quoteExactInSingle({ poolKey, zeroForOne, amountIn: spendRaw });
  if (quoted <= 0n) {
    throw new Error(
      `the ${reward.symbol} pool quoted zero for ${reward.tokenAddress} — check REWARD${reward.leg === 2 ? '2' : ''}_POOL_FEE/TICK_SPACING/HOOKS: a wrong key names an empty pool, not this one`
    );
  }

  // A floor, not a target. The quote is advisory — the hook takes its cut
  // after the swap — so this only refuses a fill far worse than quoted.
  const minOut = (quoted * BigInt(10000 - Math.round(reward.slippageBps))) / 10000n;

  const before = await erc20(reward.tokenAddress, provider).balanceOf(wallet.address);
  const tx = await buyViaV4Buyer({ poolKey, zeroForOne, amountIn: spendRaw, amountOutMinimum: minOut });
  await tx.wait();
  const after = await erc20(reward.tokenAddress, provider).balanceOf(wallet.address);

  // Measured, not quoted: what we can actually hand to holders is the balance
  // delta. Airdropping a quoted figure would overrun the wallet by the hook's fee.
  const decimals = config.dryRun ? reward.decimals : await getDecimals(reward.tokenAddress);
  const boughtRaw = after > before ? after - before : 0n;

  console.log(
    `[tx] bought ${formatUnits(boughtRaw, decimals)} ${reward.symbol} ` +
      `for ${formatUnits(spendRaw, config.quoteDecimals)} ${config.quoteSymbol}: ${tx.hash}`
  );

  return {
    bought: boughtRaw > 0n,
    boughtRaw,
    tokensBought: Number(formatUnits(boughtRaw, decimals)),
    quoteSpent: Number(formatUnits(spendRaw, config.quoteDecimals)),
    signature: tx.hash,
  };
}

module.exports = { buyReward, rewardPoolKey, rewardLegOne, rewardLegTwo, clampToBalance, poolIdOf };
