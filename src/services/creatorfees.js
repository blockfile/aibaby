'use strict';

// Total creator fees this launch has EARNED, from pons.
//
//   GET {ponsApi}/api/pons-v2-market/{token}/creator-fees
//     -> { earnedForToken, claimableForWallet, sweepCount, recipient, quoteAsset }
//
// Distinct from `totalRewarded`, and the distinction is the point. That figure
// is what the bot has actually PAID to holders, summed from its own ledger with
// a transaction hash behind every row. This one is what the launch has earned in
// total, before the split takes its share for gas — a larger number, and a
// different claim.
//
// Serving both is what lets a site show the flywheel honestly: fees earned, and
// of that, what reached holders. Serving one under the other's label is how a
// number stops surviving scrutiny, and every payout here is on-chain and
// checkable.
//
// `earnedForToken` counts what has been SWEPT into the escrow across
// `sweepCount` sweeps. Fees still pending on the hook are not in it — post-
// graduation that can be a lot, since only pons's operator may sweep.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');

const EMPTY = { feesEarned: null, sweeps: null, recipient: null };

/** Pure: raw base units + decimals -> whole tokens, or null if unreadable. */
function toWhole(raw, decimals) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return null; // wei is an integer string; anything else is not ours to read
  const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
  return Number(BigInt(s)) / 10 ** d;
}

/**
 * Pure: pons's creator-fee payload -> the fields the site shows.
 *
 * Null rather than zero on anything malformed. The site hides a null tile but
 * renders a zero as a real number, and "0 NVDA ever earned" is a worse thing to
 * say than nothing at all. A genuine zero — nothing swept yet — is still zero.
 */
function parseCreatorFees(data) {
  if (!data || typeof data !== 'object') return EMPTY;
  const decimals = data.quoteAsset && data.quoteAsset.decimals;
  const feesEarned = toWhole(data.earnedForToken, decimals);
  const sweeps = Number.isFinite(Number(data.sweepCount)) && data.sweepCount !== null ? Number(data.sweepCount) : null;
  return {
    feesEarned,
    sweeps: feesEarned === null ? null : sweeps,
    // pons's own view of who the fees are paid to — an independent second
    // opinion on feeRecipientOk, which the bot otherwise only knows from its
    // own read of the factory.
    recipient: typeof data.recipient === 'string' ? data.recipient : null,
  };
}

async function fetchCreatorFees() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing swept anywhere
  const url = `${config.ponsApi}/api/pons-v2-market/${config.tokenAddress}/creator-fees`;
  return parseCreatorFees(await fetchJson(url, { headers: { accept: 'application/json' } }));
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getCreatorFees = cached(config.rewardsTtlMs, fetchCreatorFees);

module.exports = { getCreatorFees, fetchCreatorFees, parseCreatorFees, toWhole, EMPTY };
