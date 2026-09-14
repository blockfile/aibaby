'use strict';

// Buy through our own V4Buyer contract instead of the UniversalRouter.
//
// The UniversalRouter cannot swap INTO a pons pool whose quote asset is an
// ERC-20. Verified against the live chain, with the wallet funded and Permit2
// fully approved: NVDA -> BABYINU reverts with empty data at every size, in
// both directions, under every action ordering, while the same router happily
// does NVDA -> ETH on a hookless pool and ETH -> memecoin on the same pons
// hook. The V4Quoter executes the failing swap, hook included, and returns a
// price -- so the pool is fine and the fault is in the router's settlement.
//
// V4Buyer talks to the PoolManager directly: unlock, swap, settle exactly what
// the swap consumed, take the output. No Permit2 and no aggregator.

const { Contract } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { erc20 } = require('./erc20');
const { sendTx } = require('./send');

const V4_BUYER_ABI = [
  'function buy((address,address,uint24,int24,address) key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, address recipient) returns (uint256)',
];

/** The buyer PULLS the input with transferFrom, so it needs an allowance. */
async function ensureBuyerAllowance({ tokenAddress, needed }) {
  const token = erc20(tokenAddress, provider);
  const allowance = await token.allowance(wallet.address, config.v4BuyerAddress);
  if (allowance >= needed) return false;
  console.log(`[buyback] approving ${tokenAddress} to the v4 buyer ${config.v4BuyerAddress}`);
  const { MaxUint256 } = require('ethers');
  const tx = await sendTx(() => erc20(tokenAddress, wallet).approve(config.v4BuyerAddress, MaxUint256));
  await tx.wait();
  return true;
}

/**
 * Swap `amountIn` of the quote asset for the memecoin, delivered to this wallet.
 *
 * @returns {Promise<import('ethers').TransactionResponse>}
 */
// Ethers sends the node's gas ESTIMATE as the limit, with no headroom. For a
// swap through a HOOKED v4 pool that is not enough: the hook's work varies with
// pool state, so an estimate taken one block earlier can fall short, an inner
// call runs out of gas, and the whole swap reverts with EMPTY revert data while
// gas remains — which reads like a broken pool and is not one.
//
// Seen live: the same call, same amount, same pool reverted having burned
// 432,130 of a 445,846 limit, while the successful swap 19 minutes earlier used
// 410,501 of 448,736. Replayed as an eth_call (which is not gas-constrained) it
// succeeded, and the pool quoted normally throughout.
//
// So estimate, then add half again with a floor. Unused gas is refunded and this
// chain prices gas at ~0.1 gwei, so the headroom costs nothing measurable; the
// swap failing costs holders their whole reward leg for that cycle.
const GAS_BUFFER_NUM = 3n;
const GAS_BUFFER_DEN = 2n;
const GAS_FLOOR = 600_000n;

/** Pure: an estimate -> the limit to send, never below the floor. */
function withGasHeadroom(estimate) {
  const padded = (BigInt(estimate) * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
  return padded > GAS_FLOOR ? padded : GAS_FLOOR;
}

async function buyViaV4Buyer({ poolKey, zeroForOne, amountIn, amountOutMinimum }) {
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  await ensureBuyerAllowance({ tokenAddress: currencyIn, needed: amountIn });

  const buyer = new Contract(config.v4BuyerAddress, V4_BUYER_ABI, wallet);
  const args = [
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    zeroForOne,
    amountIn,
    amountOutMinimum,
    wallet.address,
  ];

  // A failing estimate is a real signal (no liquidity, minOut unreachable) and
  // should surface as an error here rather than as a mined, reverted transaction.
  let gasLimit;
  try {
    gasLimit = withGasHeadroom(await buyer.buy.estimateGas(...args));
  } catch (err) {
    throw new Error(
      `the v4 swap would revert before sending (${err.shortMessage || err.message}) — ` +
        'nothing was sent, so the claim stays in the wallet'
    );
  }

  return sendTx(() => buyer.buy(...args, { gasLimit }));
}

module.exports = { buyViaV4Buyer, ensureBuyerAllowance, withGasHeadroom, V4_BUYER_ABI };
