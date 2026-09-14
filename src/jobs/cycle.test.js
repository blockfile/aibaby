'use strict';

process.env.DRY_RUN = 'true';
// The split cases below were written for three legs of a claim; the own-token
// leg has its own cases at the bottom of this file.
process.env.OWN_TOKEN_PCT = '0';
process.env.BUYBACK_HOLD_PCT = '0';
process.env.REWARD_PCT = '65';
process.env.BURN_PCT = '25';
process.env.GAS_PCT = '10';

const test = require('node:test');
const assert = require('node:assert');
const { splitClaim, summarizeReward, isFeeRecipientOk, feeRecipientWarning } = require('./cycle');

test('65/25/10 leaves no dev cut', () => {
  const { rewardQuote, burnQuote, gasQuote, devQuote } = splitClaim(1);
  assert.strictEqual(rewardQuote, 0.65);
  assert.strictEqual(burnQuote, 0.25);
  assert.strictEqual(gasQuote, 0.1);
  assert.strictEqual(devQuote, 0, 'the dev cut is only what the other three leave');
});

test('the four legs always re-add to the claim', () => {
  for (const claimed of [0.000001, 0.5, 3.7, 1234.56789]) {
    const { rewardQuote, burnQuote, gasQuote, devQuote } = splitClaim(claimed);
    assert.ok(
      Math.abs(rewardQuote + burnQuote + gasQuote + devQuote - claimed) < 1e-9,
      `legs must sum for ${claimed}`
    );
  }
});

test('splitting nothing yields nothing on every leg', () => {
  assert.deepStrictEqual(splitClaim(0), { rewardQuote: 0, ownTokenQuote: 0, buybackHoldQuote: 0, burnQuote: 0, gasQuote: 0, devQuote: 0 });
});

test('a dev cut appears only when the three configured legs leave one', () => {
  process.env.REWARD_PCT = '60';
  process.env.BURN_PCT = '20';
  process.env.GAS_PCT = '10';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
  const { splitClaim: split } = require('./cycle');

  const { rewardQuote, burnQuote, gasQuote, devQuote } = split(10);
  assert.strictEqual(rewardQuote, 6);
  assert.strictEqual(burnQuote, 2);
  assert.strictEqual(gasQuote, 1);
  assert.strictEqual(devQuote, 1);

  process.env.REWARD_PCT = '65';
  process.env.BURN_PCT = '25';
  process.env.GAS_PCT = '10';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
});

test('an all-to-holders split leaves nothing to burn or swap', () => {
  process.env.REWARD_PCT = '100';
  process.env.BURN_PCT = '0';
  process.env.GAS_PCT = '0';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
  const { splitClaim: split } = require('./cycle');
  assert.deepStrictEqual(split(5), { rewardQuote: 5, ownTokenQuote: 0, buybackHoldQuote: 0, burnQuote: 0, gasQuote: 0, devQuote: 0 });

  process.env.REWARD_PCT = '65';
  process.env.BURN_PCT = '25';
  process.env.GAS_PCT = '10';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
});

test('the fee-recipient check is case-insensitive', () => {
  const launch = { creatorFeeRecipient: '0xABCDEF0000000000000000000000000000000001' };
  assert.strictEqual(isFeeRecipientOk(launch, '0xabcdef0000000000000000000000000000000001'), true);
});

test('a mismatched fee recipient produces a warning naming both addresses', () => {
  const launch = { creatorFeeRecipient: '0x1111111111111111111111111111111111111111' };
  const warning = feeRecipientWarning(launch, '0x2222222222222222222222222222222222222222');
  assert.match(warning, /0x1111111111111111111111111111111111111111/);
  assert.match(warning, /0x2222222222222222222222222222222222222222/);
});

test('the mismatch warning mentions the pons toggle that causes it', () => {
  // The overwhelmingly likely cause is someone switching on pons's
  // holder-fee-sharing, which reassigns creatorFeeRecipient to a distributor.
  // An operator reading this line at 3am should not have to go and find that out.
  const launch = { creatorFeeRecipient: '0x1111111111111111111111111111111111111111' };
  assert.match(feeRecipientWarning(launch, '0x2222222222222222222222222222222222222222'), /distributor|holders/i);
});

test('a matching fee recipient produces no warning at all', () => {
  const launch = { creatorFeeRecipient: '0xabc0000000000000000000000000000000000001' };
  assert.strictEqual(feeRecipientWarning(launch, '0xABC0000000000000000000000000000000000001'), null);
});

test('an unset fee recipient is a mismatch, not a pass', () => {
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: '' }, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk({}, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk(null, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: '0xabc' }, ''), false);
});

test('"nobody was eligible" completes and is not recorded as a failure', () => {
  const out = summarizeReward({ skipped: false, recipients: 0, sent: 0, failed: 0 });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /no eligible holders/);
});

test('"the airdrop reached nobody" is a failure, and says why', () => {
  const out = summarizeReward({ skipped: false, recipients: 40, sent: 0, failed: 40 });
  assert.strictEqual(out.status, 'failed');
  assert.match(out.error, /0 of 40/);
});

test('a partial airdrop completes but records the failures', () => {
  const out = summarizeReward({ skipped: false, recipients: 10, sent: 7, failed: 3 });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /7/);
  assert.match(out.note, /3 failed/);
});

test('a fully delivered airdrop is clean', () => {
  const out = summarizeReward({ skipped: false, recipients: 10, sent: 10, failed: 0 });
  assert.strictEqual(out.status, 'complete');
  assert.strictEqual(out.error, undefined);
});

test('a skipped reward leg completes and carries its reason', () => {
  const out = summarizeReward({ skipped: true, reason: 'reward share of this claim is zero' });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /zero/);
});

test('recording the fee-recipient check makes it readable without a cycle', () => {
  // The flag used to be set only inside runCycle, so between cycles the most
  // important operational signal reported null — on a quiet token, for hours.
  const { recordFeeRecipientCheck, getFeeRecipientCheck } = require('./cycle');

  const warning = recordFeeRecipientCheck(
    { creatorFeeRecipient: '0xAAA0000000000000000000000000000000000001' },
    '0xaaa0000000000000000000000000000000000001'
  );
  assert.strictEqual(warning, null, 'a matching recipient produces no warning');

  const check = getFeeRecipientCheck();
  assert.strictEqual(check.ok, true);
  assert.strictEqual(check.actual, '0xAAA0000000000000000000000000000000000001');
  assert.ok(typeof check.at === 'string');
});

test('a mismatch is recorded as ok:false with the address actually paid', () => {
  const { recordFeeRecipientCheck, getFeeRecipientCheck } = require('./cycle');
  const warning = recordFeeRecipientCheck(
    { creatorFeeRecipient: '0xdistributor' },
    '0xus'
  );
  assert.match(warning, /MISMATCH/);
  const check = getFeeRecipientCheck();
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.actual, '0xdistributor');
  assert.strictEqual(check.expected, '0xus');
});

test('the dev leg never goes negative on rounding', () => {
  // A live cycle logged "-1e-9 to dev": the remainder absorbs the rounding of
  // the other three legs and can dip below zero. Harmless while the payout is
  // skipped, but parseUnits would throw on it the day DEV_PAYOUT_ADDRESS is set.
  const { splitClaim } = require('./cycle');
  for (const claim of [0.7167010553398622, 1.0221684558296817, 0.7297212717303938, 4.033175952467068]) {
    const s = splitClaim(claim);
    assert.ok(s.devQuote >= 0, `dev leg went negative on ${claim}: ${s.devQuote}`);
    assert.ok(Object.is(s.devQuote, 0) || s.devQuote > 0, 'must not be -0 either');
  }
});


// ── Two reward assets ───────────────────────────────────────────────────────
//
// REWARD_PCT decides how much of a claim reaches holders; REWARD2_SHARE_PCT
// decides what it reaches them AS. At 90/0/10 with a 50% share, a 100 NVDA
// claim pays 45 NVDA, the AI that 45 NVDA buys, and 10 for gas.

test('the holders share divides between the two assets and always re-adds', () => {
  const { splitRewardQuote } = require('./cycle');
  assert.deepStrictEqual(splitRewardQuote(90, 50), { first: 45, second: 45 });
  assert.deepStrictEqual(splitRewardQuote(90, 0), { first: 90, second: 0 });
  assert.deepStrictEqual(splitRewardQuote(90, 100), { first: 0, second: 90 });
  assert.deepStrictEqual(splitRewardQuote(0, 50), { first: 0, second: 0 });
});

test('an amount that does not halve cleanly leaves nothing behind', () => {
  // The first leg is the REMAINDER, not its own percentage, so the two always
  // sum to the share exactly. Computing both from percentages strands a
  // rounding step of every claim in the wallet, cycle after cycle.
  const { splitRewardQuote } = require('./cycle');
  for (const share of [1.111080251, 3.7 * 0.65, 0.000000003, 123.456789012]) {
    const { first, second } = splitRewardQuote(share, 50);
    assert.strictEqual(+(first + second).toFixed(9), +share.toFixed(9), `${share} re-adds`);
  }
});

test('a 45/45/10 plan pays NVDA directly and buys AI with the rest', () => {
  const { rewardLegPlan } = require('./cycle');
  const plan = rewardLegPlan(90, 50);
  assert.strictEqual(plan.length, 2);
  assert.deepStrictEqual(
    plan.map((l) => [l.reward.symbol, l.quoteAmount]),
    [['NVDA', 45], ['AI', 45]]
  );
  // Leg one IS the quote asset, so nothing is swapped for it.
  assert.strictEqual(plan[0].reward.tokenAddress, require('../config').quoteTokenAddress);
  assert.notStrictEqual(plan[1].reward.tokenAddress, require('../config').quoteTokenAddress);
});

test('a share of 0 gives exactly the single-asset cycle this ran before', () => {
  const { rewardLegPlan } = require('./cycle');
  const plan = rewardLegPlan(90, 0);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].reward.symbol, 'NVDA');
  assert.strictEqual(plan[0].quoteAmount, 90);
});

test('a zero-value leg is dropped rather than run for nothing', () => {
  // At a 100% share the NVDA leg is zero: running it would record a skipped
  // swap and an empty airdrop step every cycle for no reason.
  const { rewardLegPlan } = require('./cycle');
  assert.deepStrictEqual(rewardLegPlan(90, 100).map((l) => l.reward.symbol), ['AI']);
  assert.deepStrictEqual(rewardLegPlan(0, 50), []);
});

test('the cycle note names the assets paid, so a log line says which', () => {
  const { summarizeReward, legNames } = require('./cycle');
  const legs = [{ symbol: 'NVDA' }, { symbol: 'AI' }];
  assert.strictEqual(legNames({ legs }), 'NVDA + AI');
  const out = summarizeReward({ skipped: false, recipients: 10, sent: 20, failed: 0, legs });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /NVDA \+ AI/);
});

test('a total failure names the assets rather than hardcoding one', () => {
  const { summarizeReward } = require('./cycle');
  const out = summarizeReward({ skipped: false, recipients: 40, sent: 0, failed: 80, legs: [{ symbol: 'NVDA' }, { symbol: 'AI' }] });
  assert.strictEqual(out.status, 'failed');
  assert.match(out.error, /NVDA \+ AI/);
  assert.doesNotMatch(out.error, /received NVDA \(/, 'the old single-asset wording is gone');
});

test('every name scripts/recover.js imports from cycle.js actually exists', () => {
  // Renaming runRewardLeg -> runRewardLegs broke the recovery script silently:
  // nothing imports it in the test suite, and it is only ever run by hand, at
  // the one moment it is needed — after a cycle has already failed.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'recover.js'), 'utf8');
  const m = /const \{([^}]+)\} = require\('\.\.\/src\/jobs\/cycle'\)/.exec(src);
  assert.ok(m, 'recover.js still imports from jobs/cycle');
  const cycle = require('./cycle');
  for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.strictEqual(typeof cycle[name], 'function', `cycle.js must export ${name}`);
  }
});

// ── The own-token leg (OWN_TOKEN_PCT) ───────────────────────────────────────

function withSplit(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
  for (const m of ['../config', './cycle', '../evm/rewardswap']) delete require.cache[require.resolve(m)];
  try {
    return fn(require('./cycle'), require('../config'));
  } finally {
    Object.assign(process.env, saved);
    for (const m of ['../config', './cycle', '../evm/rewardswap']) delete require.cache[require.resolve(m)];
  }
}

test('a claim splits four ways and re-adds exactly: 30 NVDA / 30 AI / 30 BABYINU / 10 gas', () => {
  withSplit({ REWARD_PCT: '60', OWN_TOKEN_PCT: '30', BUYBACK_HOLD_PCT: '0', BURN_PCT: '0', GAS_PCT: '10' }, ({ splitClaim, rewardLegPlan }, config) => {
    const s = splitClaim(100);
    assert.deepStrictEqual(s, { rewardQuote: 60, ownTokenQuote: 30, buybackHoldQuote: 0, burnQuote: 0, gasQuote: 10, devQuote: 0 });
    const plan = rewardLegPlan(s.rewardQuote, config.reward2SharePct, s.ownTokenQuote);
    assert.deepStrictEqual(plan.map((l) => [l.reward.symbol, l.quoteAmount]), [['NVDA', 30], ['AI', 30], [config.tokenSymbol, 30]]);
  });
});

test('the own-token leg is bought on the LAUNCH, not through a configured pool', () => {
  withSplit({ REWARD_PCT: '60', OWN_TOKEN_PCT: '30', BUYBACK_HOLD_PCT: '0', BURN_PCT: '0', GAS_PCT: '10' }, ({ rewardLegPlan }, config) => {
    const own = rewardLegPlan(60, 50, 30).find((l) => l.reward.kind === 'launch');
    assert.ok(own, 'a launch-kind leg is planned');
    assert.strictEqual(own.reward.tokenAddress, config.tokenAddress);
    assert.strictEqual(own.reward.leg, 3);
  });
});

test('it runs LAST, so a slow launch-venue buy can never delay NVDA or AI', () => {
  const { rewardLegPlan } = require('./cycle');
  const plan = rewardLegPlan(60, 50, 30);
  assert.strictEqual(plan[plan.length - 1].reward.kind, 'launch');
});

test('an awkward claim still re-adds across all four legs', () => {
  withSplit({ REWARD_PCT: '60', OWN_TOKEN_PCT: '30', BUYBACK_HOLD_PCT: '0', BURN_PCT: '0', GAS_PCT: '10' }, ({ splitClaim }) => {
    for (const claim of [1.3300426388432187, 1.2546905469948721, 3.7, 0.000000009]) {
      const s = splitClaim(claim);
      const sum = +(s.rewardQuote + s.ownTokenQuote + s.buybackHoldQuote + s.burnQuote + s.gasQuote + s.devQuote).toFixed(9);
      assert.ok(Math.abs(sum - +claim.toFixed(9)) <= 1e-9, `${claim} re-adds (${sum})`);
    }
  });
});

test('OWN_TOKEN_PCT=0 plans no own-token leg at all', () => {
  const { rewardLegPlan } = require('./cycle');
  assert.ok(!rewardLegPlan(60, 50, 0).some((l) => l.reward.kind === 'launch'));
});

// ── The kept buyback (BUYBACK_HOLD_PCT) ─────────────────────────────────────

test('the keep variant (BUYBACK_HOLD_PCT=30): 30 NVDA / 30 AI to holders, 30 BABYINU bought and kept', () => {
  withSplit({ REWARD_PCT: '60', OWN_TOKEN_PCT: '0', BUYBACK_HOLD_PCT: '30', BURN_PCT: '0', GAS_PCT: '10' }, ({ splitClaim, rewardLegPlan }, config) => {
    const s = splitClaim(100);
    assert.deepStrictEqual(s, { rewardQuote: 60, ownTokenQuote: 0, buybackHoldQuote: 30, burnQuote: 0, gasQuote: 10, devQuote: 0 });
    // Holders are paid exactly two assets: the kept buyback is NOT a reward leg.
    const plan = rewardLegPlan(s.rewardQuote, config.reward2SharePct, s.ownTokenQuote);
    assert.deepStrictEqual(plan.map((l) => [l.reward.symbol, l.quoteAmount]), [['NVDA', 30], ['AI', 30]]);
  });
});

test('a failed buy-and-keep is reported, never thrown — holders are already paid', async () => {
  const { describeHold } = require('./cycle');
  assert.match(describeHold({ bought: false, skipped: false, error: 'pool quoted zero' }), /FAILED \(pool quoted zero\).*stays in the wallet/);
  assert.match(describeHold({ skipped: true, reason: 'buyback-hold share of this claim is zero' }), /skipped/);
  assert.match(describeHold({ bought: true, tokensBought: 5, quoteSpent: 1 }), /KEPT/);
});
