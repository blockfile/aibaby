'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../config');

test('when the reward IS the quote asset, there is nothing to buy', async () => {
  // Baby Artificial Inu pays holders NVDA, the same asset creator fees arrive in.
  // Routing that through a NVDA/NVDA swap would be meaningless and would cost
  // holders a pool fee and slippage for nothing. The buy leg turns itself off.
  assert.strictEqual(
    config.rewardTokenAddress.toLowerCase(),
    config.quoteTokenAddress.toLowerCase(),
    'this project is configured to pay the quote asset directly'
  );

  const { buyReward } = require('./rewardswap');
  const out = await buyReward({ quoteAmount: 6.5 });
  assert.strictEqual(out.direct, true, 'no swap was performed');
  assert.strictEqual(out.tokensBought, 6.5, 'the claim is handed over untouched');
  assert.strictEqual(out.quoteSpent, 6.5);
  assert.strictEqual(out.signature, null, 'no transaction, so no hash to record');
  assert.ok(out.bought, 'and it still counts as delivered, so the airdrop runs');
});

test('a zero share still short-circuits before anything else', async () => {
  const { buyReward } = require('./rewardswap');
  const out = await buyReward({ quoteAmount: 0 });
  assert.strictEqual(out.skipped, true);
  assert.match(out.reason, /zero/);
});

// ── Gas headroom on the hooked-pool swap ────────────────────────────────────
//
// Cycle 29 reverted with EMPTY revert data having burned 432,130 of a 445,846
// gas limit, while the identical swap 19 minutes earlier used 410,501 of
// 448,736 and succeeded. Replayed as an eth_call it worked, and the pool quoted
// normally — so the pool was fine and the limit was not. Ethers sends the node's
// estimate as the limit with no headroom, and a hooked v4 swap's cost moves with
// pool state between the estimate and inclusion.

test('the swap gas limit carries headroom over the estimate', () => {
  const { withGasHeadroom } = require('./v4buyer');
  // Half again, so the live 445,846 estimate would have been sent as 668,769 —
  // comfortably over the 432,130 the reverting path actually needed.
  assert.strictEqual(withGasHeadroom(445_846n), 668_769n);
  assert.ok(withGasHeadroom(445_846n) > 432_130n, 'covers the path that ran out');
  // Accepts a plain number too, which is what estimateGas returns in some paths.
  assert.strictEqual(withGasHeadroom(400_000), 600_000n);
});

test('a tiny estimate is floored, not trusted', () => {
  const { withGasHeadroom } = require('./v4buyer');
  assert.strictEqual(withGasHeadroom(1n), 600_000n);
  assert.strictEqual(withGasHeadroom(0n), 600_000n);
});
