'use strict';

// One reward cycle:
//
//   sweep pending fees into the escrow   (best-effort — may need pons's operator)
//   claimToken(NVDA)                     -> NVDA in the wallet
//     -> GAS_PCT:    sell for native ETH, so the bot can pay its own gas
//     -> REWARD_PCT: airdrop pro-rata to BABYINU holders
//     -> BURN_PCT:   buy BABYINU with it and burn what was bought. ZERO by
//                    default here — the leg is built and tested but this
//                    deployment does not fund it, so it skips every cycle.
//     -> remainder:  the dev cut — forwarded to DEV_PAYOUT_ADDRESS if one is
//                    set, otherwise left in the wallet. At the default
//                    90/0/10 it is zero.
//
// The gas leg runs FIRST because the airdrop that follows sends one
// transaction per holder: topping up before spending is what stops a cycle
// running dry halfway through paying people.
//
// The REWARD leg never swaps: fees arrive already denominated in NVDA, which is
// what holders are paid. The BUYBACK leg is the only thing in this bot that
// trades, which is why slippage, quoting and venue dispatch live entirely in
// evm/buyback.js and touch nothing else.
//
// Each step is recorded as it completes; a thrown step fails the cycle without
// crashing the process.

const { formatEther, parseUnits } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { getLaunch, describePhase } = require('../evm/launch');
const { sweepFees } = require('../evm/sweep');
const { claimQuoteFromEscrow } = require('../evm/escrow');
const { getDecimals, getTokenSupplyRaw } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { buyReward, rewardLegOne, rewardLegTwo, ownTokenLeg } = require('../evm/rewardswap');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');
const { toUnitString } = require('../evm/units');
const { sendDevPayout, describeOutcome: describeDevPayout } = require('../evm/devpayout');
const { buybackAndBurn, describeOutcome: describeBuyback } = require('../evm/buyback');
const { swapQuoteForGas, describeOutcome: describeGasSwap } = require('../evm/gasswap');
const { provider } = require('../evm/provider');

/**
 * Split a claim four ways. Pure, so the invariant that the legs re-add to the
 * claim is directly testable.
 *
 * The dev cut is the REMAINDER rather than its own percentage, so the four can
 * never disagree with the claim: at the default 90/0/10 it is exactly zero, and
 * it only appears when REWARD_PCT + BURN_PCT + GAS_PCT total under 100.
 */
function splitClaim(claimedQuote) {
  // Round to 9 places and normalise negative zero. At a split that consumes the
  // whole claim the remainder lands on -1.1e-16, which toFixed renders as
  // "-0.000000000" and `+` turns into -0: a value that fails a strict
  // comparison with 0 and prints as "-0" in the cycle log.
  const round = (n) => {
    const r = +n.toFixed(9);
    return r === 0 ? 0 : r;
  };
  const rewardQuote = round(claimedQuote * (config.rewardPct / 100));
  const ownTokenQuote = round(claimedQuote * (config.ownTokenPct / 100));
  const buybackHoldQuote = round(claimedQuote * (config.buybackHoldPct / 100));
  const burnQuote = round(claimedQuote * (config.burnPct / 100));
  const gasQuote = round(claimedQuote * (config.gasPct / 100));
  // The dev leg is the remainder, so it absorbs the rounding of the other
  // three and can land just below zero -- a live cycle logged "-1e-9 to dev".
  // Config already refuses a split whose three legs exceed 100, so a negative
  // here is float error and nothing else. Clamp it: today the payout is skipped
  // when DEV_PAYOUT_ADDRESS is unset, but a negative amount reaching parseUnits
  // would throw, and the first person to set that address would be the one to
  // find out.
  const devQuote = Math.max(0, round(claimedQuote - rewardQuote - ownTokenQuote - buybackHoldQuote - burnQuote - gasQuote));
  return { rewardQuote, ownTokenQuote, buybackHoldQuote, burnQuote, gasQuote, devQuote };
}

/**
 * Is this wallet the address the launch actually pays creator fees to? Only
 * that address may sweep OR claim, so a mismatch means the cycle can never
 * collect anything — silently, with no error anywhere.
 * Case-insensitive: the factory returns EIP-55 checksummed addresses.
 */
function isFeeRecipientOk(launch, address) {
  const want = String(address || '').toLowerCase();
  const got = String((launch && launch.creatorFeeRecipient) || '').toLowerCase();
  return want !== '' && got !== '' && want === got;
}

/** The operator-facing warning for a mismatch, or null when it is fine. */
function feeRecipientWarning(launch, address) {
  if (isFeeRecipientOk(launch, address)) return null;
  const got = (launch && launch.creatorFeeRecipient) || '(unset)';
  return (
    `creatorFeeRecipient MISMATCH: the launch pays creator fees to ${got}, ` +
    `but this bot's wallet is ${address || '(unset)'}. This cycle cannot claim — ` +
    'only the creatorFeeRecipient may sweep or claim. The usual cause is that ' +
    "pons's \"route creator fees to holders\" toggle was switched on, which " +
    'reassigns the recipient to a fee distributor contract and leaves this bot ' +
    'with nothing. Switch it back off, or point WALLET_PRIVATE_KEY at the ' +
    'recipient the launch actually names.'
  );
}

// Last observed result of the check above, so the operator API can report it
// without making a chain call of its own. null until something has looked.
let lastFeeRecipientCheck = null;
function getFeeRecipientCheck() {
  return lastFeeRecipientCheck;
}

/**
 * Record the fee-recipient verdict from a launch record someone has already
 * read. Returns the warning, or null when it is fine.
 *
 * Called by the CYCLE and also by every scheduler poll. The poll already
 * fetches the launch record to price what is claimable, so re-using it makes
 * the single most important operational flag as fresh as the poll interval
 * instead of only as fresh as the last cycle — which, on a quiet token, could
 * be hours of reporting `null` about the one thing worth knowing.
 */
function recordFeeRecipientCheck(launch, address) {
  const warning = feeRecipientWarning(launch, address);
  lastFeeRecipientCheck = {
    ok: warning === null,
    expected: address,
    actual: (launch && launch.creatorFeeRecipient) || null,
    at: new Date().toISOString(),
  };
  return warning;
}

/**
 * How a cycle finishes, given what the reward leg actually did. Pure, so both
 * the "airdrop reached nobody" and the "nobody was eligible" cases are directly
 * testable — they look identical in `sent` (0) and must not be recorded
 * identically. One is a quiet no-op; the other means the NVDA is stranded.
 */
/** Pure: "NVDA + AI" for a cycle's legs — for log lines and failure notes. */
function legNames(reward) {
  return (reward.legs || []).map((l) => l.symbol).join(' + ');
}

function summarizeReward(reward) {
  if (reward.skipped) {
    return { status: 'complete', note: `reward leg skipped: ${reward.reason}` };
  }
  if (!(reward.recipients > 0)) {
    return { status: 'complete', note: 'no eligible holders — nothing to airdrop' };
  }
  if (!(reward.sent > 0)) {
    return {
      status: 'failed',
      note: `airdrop reached 0 of ${reward.recipients} recipients`,
      error:
        `airdrop delivered nothing: 0 of ${reward.recipients} recipients received ` +
        `${legNames(reward) || 'a reward'} (${reward.failed} failed). Likely causes: the wallet ` +
        'is out of ETH for gas, a reward token is paused, or DISPERSE_ADDRESS points at ' +
        'something that is not an ERC-20 disperser. What this cycle claimed is still in the wallet.',
    };
  }
  const assets = legNames(reward);
  const suffix = assets ? ` (${assets})` : '';
  if (reward.failed > 0) {
    return { status: 'complete', note: `airdrop sent ${reward.sent}, ${reward.failed} failed${suffix}` };
  }
  return { status: 'complete', note: `airdrop sent ${reward.sent}${suffix}` };
}

/**
 * Buy BABYINU with `quoteAmount` of NVDA and keep it. Never throws: a failed
 * buy is reported, recorded as a failed step, and leaves the NVDA in the wallet.
 *
 * Uses the same launch-token buy as the own-token leg (buyReward with the
 * launch leg), so it gets the phase dispatch, the retries, the dry-run
 * simulation and the balance-delta measurement for free.
 */
async function buyBackAndHold({ launch, quoteAmount }) {
  if (!(quoteAmount > 0)) return { skipped: true, bought: false, reason: 'buyback-hold share of this claim is zero' };
  try {
    const r = await buyReward({ quoteAmount, reward: ownTokenLeg(), launch });
    if (r.skipped) return { ...r, bought: false };
    return { ...r, bought: !!r.bought };
  } catch (err) {
    return { bought: false, skipped: false, quoteSpent: 0, tokensBought: 0, error: err.shortMessage || err.message };
  }
}

/** Pure: one line describing what the buyback-hold did. */
function describeHold(r) {
  if (r.skipped) return `buyback-hold skipped: ${r.reason}`;
  if (r.bought) {
    return `buyback-hold bought ${r.tokensBought} ${config.tokenSymbol} for ${r.quoteSpent} ${config.quoteSymbol} and KEPT it`;
  }
  return `buyback-hold FAILED (${r.error || 'bought nothing'}) — the NVDA stays in the wallet, NOT auto-retried`;
}

/**
 * Pure: divide the holders' share between the two reward assets.
 *
 * The second leg takes its percentage and the FIRST takes the remainder, so the
 * two always re-add to the share exactly. The other way round leaves a rounding
 * step of every claim unspent in the wallet, cycle after cycle.
 */
function splitRewardQuote(rewardQuote, sharePct = config.reward2SharePct) {
  const round = (n) => {
    const r = +n.toFixed(9);
    return r === 0 ? 0 : r;
  };
  const second = round(rewardQuote * (sharePct / 100));
  return { first: round(rewardQuote - second), second };
}

/**
 * The legs to pay this cycle: [{reward, quoteAmount}], zero-value legs dropped.
 *
 * Leg one is the quote asset and needs no swap; leg two is bought. A share of 0,
 * or no second token configured, gives exactly the single-asset cycle this
 * project ran before — the second reward is a default, not a new code path.
 */
function rewardLegPlan(rewardQuote, sharePct = config.reward2SharePct, ownTokenQuote = 0) {
  const { first, second } = splitRewardQuote(rewardQuote, sharePct);
  const plan = [{ reward: rewardLegOne(), quoteAmount: first }];
  if (sharePct > 0 && config.reward2TokenAddress) {
    plan.push({ reward: rewardLegTwo(), quoteAmount: second });
  }
  // Leg three: BABYINU, bought back with its OWN share of the claim. Planned last,
  // after the two reward assets, so a slow or failing buy on the launch venue can
  // never delay NVDA or AI reaching holders.
  if (ownTokenQuote > 0) {
    plan.push({ reward: ownTokenLeg(), quoteAmount: ownTokenQuote });
  }
  return plan.filter((leg) => leg.quoteAmount > 0);
}

/** Pure: a leg's result row, zeroed, filled in as the leg progresses. */
function legResult(reward, quoteAmount) {
  return {
    leg: reward.leg,
    symbol: reward.symbol,
    tokenAddress: reward.tokenAddress,
    quoteAmount,
    bought: 0,
    quoteSpent: 0,
    recipients: 0,
    sent: 0,
    failed: 0,
  };
}

/**
 * Pay every eligible holder, in each configured reward asset.
 *
 * The holder snapshot is taken ONCE and both legs allocate against it, so the
 * two payouts reach the same holders in the same proportions — and the expensive
 * part, deriving the holder list, is not paid for twice.
 *
 * A leg that delivers nothing does not stop the next one: they are separate
 * assets out of separate pools, and a dead AI pool must not cost holders the
 * NVDA they were already owed.
 */
async function runRewardLegs(cycleId, { launch, quoteAmount, ownTokenQuote = 0 }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  // MIN_HOLD is a whole-token figure; scale it by the TOKEN's own decimals
  // rather than assuming 18, or the eligibility threshold is wrong by orders of
  // magnitude on any token that is not 18-decimal — in whichever direction
  // makes the airdrop include everybody or nobody.
  //
  // DRY_RUN must simulate EVERY chain call, so it takes the configured value:
  // reading decimals() from the node is the one call that would otherwise make
  // a dry run need a live RPC, and it would die here having already "claimed".
  const tokenDecimals = config.dryRun ? config.tokenDecimals : await getDecimals(launch.token);
  const minHoldRaw = (BigInt(Math.trunc(config.minHold)) * 10n ** BigInt(tokenDecimals)).toString();

  const exclude = await buildExcludeSet(launch);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: launch.token, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);

  const capPct = config.rewardCapPct > 0 ? config.rewardCapPct : null;
  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(launch.token)).toString();

  const plan = rewardLegPlan(quoteAmount, config.reward2SharePct, ownTokenQuote);
  if (plan.length === 0) {
    const reason = 'reward share of this claim is zero';
    return { recipients: 0, sent: 0, failed: 0, skipped: true, reason, eligibleHolders: holders.length, totalHolders, legs: [] };
  }
  log(`paying ${plan.map((l) => `${l.quoteAmount} ${config.quoteSymbol} as ${l.reward.symbol}`).join(' + ')}`);

  const legs = [];
  for (const { reward, quoteAmount: legQuote } of plan) {
    // BUY THE REWARD FIRST — a cycle cannot distribute what it has not bought.
    // The amount airdropped is what the swap ACTUALLY returned, never the quoted
    // figure: the pool's hook takes its cut after the swap, so distributing a
    // quote would allocate more than the wallet holds and revert the last batch.
    // For the quote asset itself this hands the claim back untouched, no swap.
    const buy = await buyReward({ quoteAmount: legQuote, reward, launch });
    await repo.addStep({
      cycleId,
      name: 'reward-swap',
      status: buy.bought ? 'ok' : buy.skipped ? 'skipped' : 'failed',
      signature: buy.signature,
      detail: {
        leg: reward.leg,
        symbol: reward.symbol,
        quoteSpent: buy.quoteSpent,
        tokensBought: buy.tokensBought,
        rewardToken: reward.tokenAddress,
        direct: buy.direct === true,
        ...(buy.reason ? { reason: buy.reason } : {}),
      },
    });
    if (!buy.bought) {
      const reason = buy.reason || 'swap returned nothing';
      log(`${reward.symbol}: nothing to distribute (${reason})`);
      legs.push({ ...legResult(reward, legQuote), skipped: true, reason });
      continue;
    }
    log(
      buy.direct
        ? `${reward.symbol}: ${buy.tokensBought} claimed directly, no swap needed`
        : `${reward.symbol}: bought ${buy.tokensBought} for ${buy.quoteSpent} ${config.quoteSymbol}`
    );

    // The airdrop is denominated in THIS leg's token base units.
    const allocations = computeWeightedAllocations(holders, buy.boughtRaw.toString(), {
      capPct,
      supplyRaw,
      clusters: config.clusters,
    });

    const air = await airdropToken({ rewardToken: reward.tokenAddress, allocations, cycleId });
    await repo.addStep({
      cycleId,
      name: 'airdrop',
      status: air.failed ? 'failed' : 'ok',
      detail: {
        leg: reward.leg,
        symbol: reward.symbol,
        token: reward.tokenAddress,
        quoteAmount: legQuote,
        rewardAmount: buy.tokensBought,
        recipients: allocations.length,
        sent: air.sent,
        failed: air.failed,
      },
    });
    log(`airdrop ${reward.symbol} sent=${air.sent} failed=${air.failed}`);

    legs.push({
      ...legResult(reward, legQuote),
      bought: buy.tokensBought,
      quoteSpent: buy.quoteSpent,
      recipients: allocations.length,
      sent: air.sent,
      failed: air.failed,
    });
  }

  const paid = legs.filter((l) => !l.skipped);
  return {
    // Both legs pay the SAME holders, so this is how many holders were reached.
    // Summing across legs would report twice the holder count.
    recipients: paid.length ? Math.max(...paid.map((l) => l.recipients)) : 0,
    // Transfers, which IS a sum: each leg is its own set of payout transactions.
    sent: legs.reduce((n, l) => n + l.sent, 0),
    failed: legs.reduce((n, l) => n + l.failed, 0),
    skipped: paid.length === 0,
    ...(paid.length === 0 ? { reason: legs.map((l) => `${l.symbol}: ${l.reason}`).join('; ') } : {}),
    eligibleHolders: holders.length,
    totalHolders,
    quoteSpent: legs.reduce((n, l) => n + l.quoteSpent, 0),
    // Deliberately no single "rewardBought": the legs are different assets, and
    // adding NVDA to AI would be a number that means nothing.
    legs,
  };
}

async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (BABYINU) is required');

    const launch = await getLaunch();
    const phase = describePhase(launch);
    log(`phase=${phase}${launch.graduated ? ` pool=${String(launch.poolId).slice(0, 10)}…` : ` curve=${launch.curve}`}`);

    // Gas is NOT self-funding here: the dev cut is NVDA while gas is ETH, so
    // the wallet cannot refill itself from what it collects. Refuse to start
    // rather than emptying the escrow and then failing to pay anyone out.
    if (!config.dryRun) {
      const gasEth = Number(formatEther(await provider.getBalance(config.wallet.address)));
      if (gasEth < config.gasReserveEth) {
        throw new Error(
          `wallet ETH ${gasEth} is below GAS_RESERVE_ETH (${config.gasReserveEth}) — ` +
          'top up the wallet with ETH for gas; the fees stay safe in the escrow until then'
        );
      }
    }

    // The one thing that must not be wrong. Warn, never throw: an operator may
    // be mid-migration, and the cycle below still reports what it finds.
    const feeWarning = recordFeeRecipientCheck(launch, config.wallet.address);
    if (feeWarning) console.warn(`[cycle ${id}] ⚠️  ${feeWarning}`);

    // 1. Sweep pending fees into the escrow. Never fatal.
    const sweep = await sweepFees(launch);
    await repo.addStep({
      cycleId: id,
      name: 'sweep',
      status: sweep.swept ? 'ok' : 'skipped',
      signature: sweep.signature,
      detail: { phase, reason: sweep.reason },
    });
    if (sweep.skipped) log(`sweep skipped: ${sweep.reason}`);

    // 2. Claim the escrow, as NVDA.
    const claim = await claimQuoteFromEscrow();
    await repo.addStep({
      cycleId: id,
      name: 'claim',
      status: 'ok',
      signature: claim.signature,
      detail: { quoteClaimed: claim.quoteClaimed },
    });
    log(`claimed ${claim.quoteClaimed} NVDA`);

    const claimed = claim.quoteClaimed;
    if (!(claimed > 0)) {
      await repo.finishCycle(id, {
        status: 'skipped',
        phase,
        quote_claimed: 0,
        sweep_skipped: sweep.skipped ? 1 : 0,
        sweep_reason: sweep.reason,
        note: 'nothing claimed',
      });
      log('skipped: nothing to work with');
      return repo.getCycleWithSteps(id);
    }

    // 3. Split.
    const { rewardQuote, ownTokenQuote, buybackHoldQuote, burnQuote, gasQuote, devQuote } = splitClaim(claimed);
    log(
      `split: ${rewardQuote} to holders as NVDA+AI (${config.rewardPct}%), ` +
        `${ownTokenQuote} to buy ${config.tokenSymbol} for holders (${config.ownTokenPct}%), ` +
        `${buybackHoldQuote} to buy ${config.tokenSymbol} back and keep (${config.buybackHoldPct}%), ` +
        `${burnQuote} to buyback+burn (${config.burnPct}%), ` +
        `${gasQuote} to gas (${config.gasPct}%), ${devQuote} to dev (${config.devPct}%)`
    );

    // 3a. Gas first — the airdrop below sends one transaction per holder, so
    //     topping up beforehand is what stops a cycle running dry mid-payout.
    const gas = await swapQuoteForGas({ quoteAmount: gasQuote });
    await repo.addStep({
      cycleId: id,
      name: 'gas',
      status: gas.swapped ? 'ok' : gas.skipped ? 'skipped' : 'failed',
      signature: gas.signature,
      detail: {
        quoteSpent: gas.skipped ? 0 : gasQuote,
        ethReceived: gas.ethReceived,
        reason: gas.reason ?? null,
        error: gas.error ?? null,
      },
    });
    log(describeGasSwap(gas));

    // 4. Reward legs — pay the holders' share in each configured asset: NVDA
    //    straight through, and AI bought with its share of it first.
    let reward = { skipped: false, sent: 0, failed: 0, recipients: 0, eligibleHolders: 0, totalHolders: 0 };
    if (rewardQuote > 0 || ownTokenQuote > 0) {
      reward = { skipped: false, ...(await runRewardLegs(id, { launch, quoteAmount: rewardQuote, ownTokenQuote })) };
    } else {
      const reason = 'reward share of this claim is zero';
      reward = { ...reward, skipped: true, reason };
      await repo.addStep({ cycleId: id, name: 'reward', status: 'skipped', detail: { reason, rewardQuote, ownTokenQuote } });
      log(`reward leg skipped: ${reason}`);
    }

    // 4b. Buy BABYINU back and KEEP it. After the reward legs, so the holders'
    //     NVDA and AI never wait on a buy on the launch venue. Non-fatal for the
    //     same reason the burn is: holders are already paid, and a failed buy
    //     leaves its NVDA in the wallet. The tokens bought stay in the bot wallet,
    //     which the holder snapshot excludes, so they never take a share of a
    //     future reward.
    const hold = await buyBackAndHold({ launch, quoteAmount: buybackHoldQuote });
    await repo.addStep({
      cycleId: id,
      name: 'buyback-hold',
      status: hold.bought ? 'ok' : hold.skipped ? 'skipped' : 'failed',
      signature: hold.signature ?? null,
      detail: {
        symbol: config.tokenSymbol,
        quoteSpent: hold.quoteSpent ?? 0,
        tokensBought: hold.tokensBought ?? 0,
        venue: hold.venue ?? null,
        kept: true,
        reason: hold.reason ?? null,
        error: hold.error ?? null,
      },
    });
    log(describeHold(hold));

    // 5. Buy BABYINU with the burn share and destroy it. Non-fatal: the
    //    holders have already been paid, so a failed swap leaves the NVDA in
    //    the wallet to retry next cycle rather than losing the whole cycle.
    const buyback = await buybackAndBurn({ launch, quoteAmount: burnQuote });
    await repo.addStep({
      cycleId: id,
      name: 'buyback',
      status: buyback.burned ? 'ok' : buyback.skipped ? 'skipped' : 'failed',
      signature: buyback.burnSignature || buyback.buySignature,
      detail: {
        quoteSpent: buyback.skipped ? 0 : burnQuote,
        tokensBought: buyback.tokensBought,
        bought: buyback.bought,
        burned: buyback.burned,
        venue: buyback.venue ?? null,
        buySignature: buyback.buySignature,
        burnSignature: buyback.burnSignature,
        reason: buyback.reason ?? null,
        error: buyback.error ?? null,
      },
    });
    log(describeBuyback(buyback));

    // 6. Forward the dev cut to the cold address, if one is configured.
    //    Recorded as its own step, never as an airdrop: it is not a holder
    //    reward, and logging it as one would publish it in the public feed and
    //    inflate totalRewarded. Non-fatal — the holders have already been paid,
    //    and a failure here leaves the cut safe in the bot wallet.
    const devPayout = await sendDevPayout({ quoteAmount: devQuote });
    await repo.addStep({
      cycleId: id,
      name: 'dev',
      status: devPayout.sent ? 'ok' : devPayout.skipped ? 'skipped' : 'failed',
      signature: devPayout.signature,
      detail: {
        amount: devQuote,
        to: devPayout.to,
        reason: devPayout.reason ?? null,
        error: devPayout.error ?? null,
      },
    });
    log(describeDevPayout(devPayout));

    const outcome = summarizeReward(reward);
    await repo.finishCycle(id, {
      status: outcome.status,
      mode: 'reward',
      phase,
      quote_claimed: claimed,
      // Everything spent on holder payouts, whichever asset it became.
      quote_distributed: reward.skipped ? 0 : +(rewardQuote + ownTokenQuote).toFixed(9),
      quote_own_token: reward.skipped ? 0 : ownTokenQuote,
      quote_gas: gas.swapped ? gasQuote : 0,
      eth_received: gas.ethReceived,
      quote_burned: buyback.burned ? burnQuote : 0,
      tokens_burned: buyback.burned ? buyback.tokensBought : 0,
      quote_bought_back: hold.bought ? hold.quoteSpent : 0,
      tokens_bought_back: hold.bought ? hold.tokensBought : 0,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      sweep_skipped: sweep.skipped ? 1 : 0,
      sweep_reason: sweep.reason,
      note: outcome.note,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (outcome.status === 'complete') log(`complete — ${outcome.note}`);
    else console.warn(`[cycle ${id}] FAILED: ${outcome.error}`);
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = {
  runCycle,
  buyBackAndHold,
  describeHold,
  runRewardLegs,
  splitRewardQuote,
  rewardLegPlan,
  legNames,
  splitClaim,
  summarizeReward,
  isFeeRecipientOk,
  feeRecipientWarning,
  getFeeRecipientCheck,
  recordFeeRecipientCheck,
};
