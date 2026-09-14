'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildStats, supplyFallback, withSupplyFallback } = require('./stats');

// The 5th argument is the REWARD token's price - what holders are paid in -
// not the quote asset's. They are different tokens and differ by orders of
// magnitude, so the distinction is the whole point.
const build = (market, token, rewards = {}, curve = {}, rewardPrice = {}, supply = null) =>
  buildStats({
    market, token, rewards, curve, rewardPrice,
    quote: rewardPrice, symbol: 'BABYINU', tokenAddress: '0xabc', supply,
  });

// Blockscout-shaped supply: 1B tokens at 18 decimals.
const SUPPLY = { totalSupply: '1000000000000000000000000000', decimals: 18 };

// ── supply fallback (Blockscout unreachable) ────────────────────────────────

test('supplyFallback turns the configured whole-token supply into the explorer\'s wei shape', () => {
  assert.deepStrictEqual(supplyFallback({ tokenTotalSupply: 1_000_000_000, tokenDecimals: 18 }), SUPPLY);
  assert.deepStrictEqual(supplyFallback({ tokenTotalSupply: 5, tokenDecimals: 0 }), { totalSupply: '5', decimals: 0 });
});

test('supplyFallback is null when not configured or nonsense', () => {
  assert.strictEqual(supplyFallback({ tokenTotalSupply: null, tokenDecimals: 18 }), null);
  assert.strictEqual(supplyFallback({ tokenTotalSupply: 0, tokenDecimals: 18 }), null);
  assert.strictEqual(supplyFallback({ tokenTotalSupply: NaN, tokenDecimals: 18 }), null);
});

test('with Blockscout down, the curve market cap is computed from the configured supply', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 0.00001 }, {}, SUPPLY).marketCap, 10_000);
  assert.strictEqual(build({}, {}, {}, { priceUsd: 0.00001 }).marketCap, null); // no fallback configured
});

test('explorer supply wins over the configured fallback', () => {
  const explorer = { totalSupply: '2000000000000000000000000000', decimals: 18 }; // 2B
  assert.deepStrictEqual(withSupplyFallback(explorer, SUPPLY), explorer);
  assert.strictEqual(build({}, explorer, {}, { priceUsd: 0.00001 }, {}, SUPPLY).marketCap, 20_000);
});

test('the fallback fills only the missing halves and leaves holders alone', () => {
  const out = withSupplyFallback({ holders: 7, totalSupply: null, decimals: null }, SUPPLY);
  assert.deepStrictEqual(out, { holders: 7, ...SUPPLY });
});

test('returns the fields the site\'s BOOT window reads', () => {
  const out = build({ marketCap: 4_206_900 }, { holders: 6942 }, { totalRewarded: 826.7 }, {}, { priceUsd: 259.4 });
  assert.strictEqual(out.marketCap, 4_206_900);
  assert.strictEqual(out.ketDistributed, 826.7); // "Total $NVDA Distributed" — token amount, no "$"
  assert.strictEqual(out.totalHolders, 6942);
  // aliases for the other frontend templates
  assert.strictEqual(out.holders, 6942);
  assert.strictEqual(out.totalRewarded, 826.7);
  assert.strictEqual(out.nvdaRewarded, 826.7 * 259.4);
});

test('ketDistributed and totalHolders are null (never 0) when unsourced, and keep a real 0', () => {
  assert.strictEqual(build({}, {}).ketDistributed, null);
  assert.strictEqual(build({}, {}).totalHolders, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }).ketDistributed, 0);
});

test('`rewarded` is the generic alias of nvdaRewarded, null when missing', () => {
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 486.91 });
  assert.strictEqual(out.rewarded, out.nvdaRewarded);
  assert.strictEqual(build({}, {}).rewarded, null);
});

test('falls back to the explorer market cap when DexScreener has none', () => {
  const out = build({ marketCap: null }, { circulatingMarketCap: 555 });
  assert.strictEqual(out.marketCap, 555);
});

test('prefers DexScreener over the explorer fallback', () => {
  const out = build({ marketCap: 1 }, { circulatingMarketCap: 999 });
  assert.strictEqual(out.marketCap, 1);
});

test('a dead upstream yields nulls, never zeros', () => {
  const out = build({}, {});
  assert.strictEqual(out.marketCap, null);
  assert.strictEqual(out.holders, null);
  assert.strictEqual(out.nvdaRewarded, null);
  assert.strictEqual(out.price, null);
});

test('a real zero market cap is preserved, not treated as missing', () => {
  const out = build({ marketCap: 0 }, { circulatingMarketCap: 999 });
  assert.strictEqual(out.marketCap, 0);
});

test('includes the total NVDA rewarded from the distributor service', () => {
  const out = build({}, {}, { totalRewarded: 826.5 });
  assert.strictEqual(out.totalRewarded, 826.5);
});

test('a dead rewards upstream yields null, and a real zero is preserved', () => {
  assert.strictEqual(build({}, {}).totalRewarded, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }).totalRewarded, 0);
});

test('pre-graduation: priceUsd falls back to the curve price', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1.6929e-5 }).priceUsd, 1.6929e-5);
});

test('a live DexScreener price wins over the curve price', () => {
  assert.strictEqual(build({ priceUsd: 2 }, {}, {}, { priceUsd: 1 }).priceUsd, 2);
});

test('`price` mirrors priceUsd — the name the site\'s normalizer reads', () => {
  assert.strictEqual(build({ priceUsd: 2 }, {}).price, 2);
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1 }).price, 1);
});

test('pre-graduation: market cap is computed from curve price × explorer supply', () => {
  const out = build({}, SUPPLY, {}, { priceUsd: 0.00001 });
  assert.strictEqual(out.marketCap, 10_000); // 1e9 tokens × $0.00001
});

test('curve market cap loses to DexScreener and the explorer figure', () => {
  assert.strictEqual(build({ marketCap: 5 }, SUPPLY, {}, { priceUsd: 1 }).marketCap, 5);
  assert.strictEqual(build({}, { ...SUPPLY, circulatingMarketCap: 7 }, {}, { priceUsd: 1 }).marketCap, 7);
});

test('totalRewardedUsd values the AI paid out at the AI/USD price', () => {
  // The amount is denominated in the REWARD token. Pricing it at NVDA's - a
  // tokenized stock worth hundreds - overstated the payout by orders of
  // magnitude, and pricing it at the quote token matched no ledger rows at all,
  // so the site read a flat $0.00 after a cycle that paid 66 holders.
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 0.0013 });
  assert.strictEqual(out.totalRewardedUsd, 11 * 0.0013);
});

test('`nvdaRewarded` — the tile the site formats as dollars — is the USD figure', () => {
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 0.0013 });
  assert.strictEqual(out.nvdaRewarded, out.totalRewardedUsd);
});

test('totalRewardedUsd needs both legs, and a real zero stays 0', () => {
  assert.strictEqual(build({}, {}, { totalRewarded: 11 }).totalRewardedUsd, null);
  assert.strictEqual(build({}, {}, {}, {}, { priceUsd: 0.0013 }).totalRewardedUsd, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }, {}, { priceUsd: 0.0013 }).totalRewardedUsd, 0);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }, {}, { priceUsd: 0.0013 }).nvdaRewarded, 0);
});

test('curve market cap needs both a price and the supply — else null', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1 }).marketCap, null);
  assert.strictEqual(build({}, { totalSupply: '10', decimals: null }, {}, { priceUsd: 1 }).marketCap, null);
  assert.strictEqual(build({}, SUPPLY, {}, {}).marketCap, null);
});

// ── buyback + burn ─────────────────────────────────────────────────────────

test('exposes the burned total the site renders', () => {
  const out = buildStats({
    market: { priceUsd: 0.00002 },
    token: {},
    burns: { totalBurned: 12345.6, burnQuoteSpent: 2.5, burns: 3 },
    symbol: 'BABYINU',
  });
  assert.strictEqual(out.totalBurned, 12345.6);
  assert.strictEqual(out.burns, 3);
});

test('what the burns COST is kept separate from what they are worth now', () => {
  // burnQuoteSpent is NVDA actually spent; totalBurnedUsd is today's market
  // value of the destroyed tokens. Conflating them would let the site claim a
  // burn was worth more than was ever spent on it.
  const out = buildStats({
    market: { priceUsd: 2 },
    token: {},
    burns: { totalBurned: 100, burnQuoteSpent: 1.5, burns: 1 },
    symbol: 'BABYINU',
  });
  assert.strictEqual(out.burnQuoteSpent, 1.5, 'cost, in NVDA');
  assert.strictEqual(out.totalBurnedUsd, 200, 'current value, in USD');
});

test('burn figures are null (never 0) when nothing has been burned yet', () => {
  const out = buildStats({ market: {}, token: {}, symbol: 'BABYINU' });
  assert.strictEqual(out.totalBurned, null);
  assert.strictEqual(out.totalBurnedUsd, null);
  assert.strictEqual(out.burnedPctOfSupply, null);
});

test('a real zero burn total is preserved, not treated as missing', () => {
  const out = buildStats({
    market: { priceUsd: 2 },
    token: {},
    burns: { totalBurned: 0, burnQuoteSpent: 0, burns: 0 },
    symbol: 'BABYINU',
  });
  assert.strictEqual(out.totalBurned, 0);
  assert.strictEqual(out.totalBurnedUsd, 0);
});

test('burned share of supply is over the unchanged totalSupply', () => {
  // Burns go to 0x…dEaD, so totalSupply still includes them: 100 of 1000 is 10%.
  // Adding the burned tokens back on top would report 9.09%.
  const out = buildStats({
    market: {},
    token: { totalSupply: (1000n * 10n ** 18n).toString(), decimals: 18 },
    burns: { totalBurned: 100, burnQuoteSpent: 1, burns: 1 },
    symbol: 'BABYINU',
  });
  assert.ok(Math.abs(out.burnedPctOfSupply - 10) < 1e-9);
});

test('burned share needs the supply — without it, null rather than a wrong number', () => {
  const out = buildStats({
    market: {},
    token: {},
    burns: { totalBurned: 100, burnQuoteSpent: 1, burns: 1 },
    symbol: 'BABYINU',
  });
  assert.strictEqual(out.burnedPctOfSupply, null);
});

test('the reward total is served as TOKENS and its USD value separately', () => {
  // The site labels this card "TOTAL $NVDA DISTRIBUTED" and resolves it from
  // rewardDistributed first. Serving only `totalDistributed` — a USD figure —
  // put dollars under an NVDA label, overstating the token count by NVDA's
  // price, which is hundreds of dollars.
  const out = buildStats({
    market: {},
    token: {},
    rewards: { totalRewarded: 12.5 },
    rewardPrice: { priceUsd: 180 },
    symbol: 'BABYINU',
    tokenAddress: '0xtoken',
  });
  assert.strictEqual(out.rewardDistributed, 12.5, 'the NVDA amount, for the $NVDA label');
  assert.strictEqual(out.rewardUsd, 2250, 'and its USD value, for the subtitle');
});

// ── which pool prices the token ──────────────────────────────────────────
const { parsePairs } = require('../services/marketdata');

const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const BABYINU = '0xc6e8c393d46b685c2fb2177f759f2b16eb7a7d54';
const pair = (quote, price, mcap, liq) => ({
  chainId: 'robinhood',
  baseToken: { address: BABYINU },
  quoteToken: { address: quote },
  priceUsd: String(price),
  marketCap: mcap,
  liquidity: { usd: liq },
});

test('the launch pair prices the token, however deep another pool is', () => {
  // Live, on the sibling NEKO launch: DexScreener returned 16 NEKO pairs. The deepest was a NEKO/ETH pool
  // with $35.8M liquidity quoting $3.22 — 4,800x the real price — which put the
  // site's market cap at $3.2 BILLION against a true ~$676K. Pons launched NEKO
  // paired with NVDA; that pool is the market, and depth alone cannot say so.
  const out = parsePairs(
    { pairs: [pair('0x0000000000000000000000000000000000000000', 3.22, 3_229_256_427, 35_825_285), pair(NVDA, 0.0006732, 676_040, 71_729)] },
    BABYINU,
    'robinhood'
  );
  assert.strictEqual(out.marketCap, 676_040, 'the NVDA pair wins on identity, not depth');
  assert.strictEqual(out.priceUsd, 0.0006732);
});

test('the liquidity floor still applies within the launch pair', () => {
  // A dust NVDA pool is no more trustworthy than a dust ETH one.
  const out = parsePairs({ pairs: [pair(NVDA, 0.5, 500_000_000, 3.32)] }, BABYINU, 'robinhood');
  assert.strictEqual(out.marketCap, null, 'below MIN_PAIR_LIQUIDITY_USD is no answer at all');
});

test('with no launch pair listed, the deepest real pool is still used', () => {
  // Before the NVDA pair is indexed there may be nothing else to go on, and a
  // deep pool is better than nothing — this is only a preference, not a filter.
  const out = parsePairs(
    { pairs: [pair('0x0000000000000000000000000000000000000000', 0.0006776, 677_601, 4_920)] },
    BABYINU,
    'robinhood'
  );
  assert.strictEqual(out.marketCap, 677_601);
});

// ── creator fees earned, beside what reached holders ─────────────────────

test('fees EARNED is served alongside what was DISTRIBUTED, never instead of it', () => {
  // Two different claims about two different numbers. `totalRewarded` is what
  // the bot paid holders, every row backed by a transaction hash. `feesEarned`
  // is what the launch has swept in total, before the split takes its share.
  // The second is the larger and the more flattering; it is only worth showing
  // because it is labelled as itself.
  const out = buildStats({
    market: {},
    token: {},
    rewards: { totalRewarded: 34.15 },
    creatorFees: { feesEarned: 246.642441851, sweeps: 187 },
    quote: { priceUsd: 231.6 },
    rewardPrice: { priceUsd: 231.6 },
    symbol: 'BABYINU',
    tokenAddress: '0xtoken',
  });
  assert.ok(Math.abs(out.feesEarned - 246.642441851) < 1e-6, `got ${out.feesEarned}`);
  assert.strictEqual(out.sweeps, 187);
  assert.ok(Math.abs(out.feesEarnedUsd - 246.642441851 * 231.6) < 1e-3);
  assert.strictEqual(out.rewardDistributed, 34.15, 'and the distributed figure is untouched');
});

test('fees earned with no price gives a null USD, not a zero', () => {
  const out = buildStats({
    market: {}, token: {}, rewards: {},
    creatorFees: { feesEarned: 246.64, sweeps: 187 },
    quote: {}, symbol: 'BABYINU', tokenAddress: '0xtoken',
  });
  assert.strictEqual(out.feesEarned, 246.64);
  assert.strictEqual(out.feesEarnedUsd, null);
});

test('no creator-fee data at all leaves the tile hidden rather than zeroed', () => {
  const out = buildStats({ market: {}, token: {}, rewards: {}, symbol: 'BABYINU', tokenAddress: '0xtoken' });
  assert.strictEqual(out.feesEarned, null);
  assert.strictEqual(out.sweeps, null);
  assert.strictEqual(out.feesEarnedUsd, null);
});

// ── The Cat-template site (BullTismClone3) ─────────────────────────────────
//
// Its src/api/stats.js reads exactly four fields, and CatStats.jsx renders
// anything that is not a number as "—": marketCapUsd, nvdaDistributed (a
// TOKEN amount — the panel appends "$NVDA"), nvdaDistributedUsd (the "≈ $…
// routed to holders" footnote) and totalHolders. Only the last existed under
// that name, so against the live API three of the four tiles were dashes.

test('the token count and its dollar value are both served, under explicit names', () => {
  const out = build({ marketCap: 4_812_400 }, { holders: 18_742 }, { totalRewarded: 1284.62 }, {}, { priceUsd: 170 });
  assert.strictEqual(out.marketCapUsd, 4_812_400);
  assert.strictEqual(out.nvdaDistributedTokens, 1284.62);
  assert.strictEqual(out.nvdaDistributedUsd, 1284.62 * 170);
  assert.strictEqual(out.totalHolders, 18_742);
});

test('marketCapUsd follows the same fallback chain as marketCap', () => {
  // Pre-graduation there is no DexScreener pair; the cap comes off the curve.
  const out = build({}, SUPPLY, {}, { priceUsd: 0.00001 });
  assert.strictEqual(out.marketCapUsd, 10_000);
  assert.strictEqual(out.marketCapUsd, out.marketCap);
});

test('unsourced figures are null, so the site shows "—" rather than a fake 0', () => {
  const out = build({}, {});
  assert.strictEqual(out.marketCapUsd, null);
  assert.strictEqual(out.nvdaDistributed, null);
  assert.strictEqual(out.nvdaDistributedUsd, null);
});

test('a real zero paid out stays 0 — the tile reads "0 $NVDA", not "—"', () => {
  const out = build({}, {}, { totalRewarded: 0 }, {}, { priceUsd: 170 });
  assert.strictEqual(out.nvdaDistributed, 0);
  assert.strictEqual(out.nvdaDistributedUsd, 0);
});


// ── Two reward assets ───────────────────────────────────────────────────────
//
// Holders are paid NVDA and AI. The two differ in price by three orders of
// magnitude, so every figure has to travel with the asset it belongs to: one
// amount, one price, one ticker in the field name.

const twoAssets = (rewards, p1, p2) =>
  buildStats({
    market: {}, token: {}, rewards, curve: {}, quote: {},
    rewardPrice: p1, reward2Price: p2,
    symbol: 'BABYINU', tokenAddress: '0xabc',
    rewardSymbol: 'NVDA', rewardTokenAddress: '0xnvda',
    reward2Symbol: 'AI', reward2TokenAddress: '0xai',
  });

test('each reward asset is served under its own ticker, with its own price', () => {
  const out = twoAssets({ totalRewarded: 10, totalRewarded2: 7300 }, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.strictEqual(out.nvdaDistributedTokens, 10);
  assert.strictEqual(out.nvdaDistributedUsd, 2210);
  assert.strictEqual(out.aiDistributedTokens, 7300);
  assert.strictEqual(out.aiDistributedUsd, 2190);
});

test('valuing the AI leg at NVDA’s price is what these fields exist to prevent', () => {
  const out = twoAssets({ totalRewarded: 10, totalRewarded2: 7300 }, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.notStrictEqual(out.aiDistributedUsd, 7300 * 221, 'that would overstate it ~700x');
  assert.strictEqual(out.aiDistributedUsd, 7300 * 0.3);
});

test('distributedUsdTotal is what holders got across both assets', () => {
  const out = twoAssets({ totalRewarded: 10, totalRewarded2: 7300 }, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.strictEqual(out.distributedUsdTotal, 2210 + 2190);
});

test('one unpriced leg does not blank the other', () => {
  // A memecoin pair can genuinely go unlisted for a while. Reporting null for
  // the total then would hide the NVDA that demonstrably reached holders.
  const out = twoAssets({ totalRewarded: 10, totalRewarded2: 7300 }, { priceUsd: 221 }, {});
  assert.strictEqual(out.aiDistributedUsd, null);
  assert.strictEqual(out.distributedUsdTotal, 2210);
  assert.strictEqual(out.aiDistributedTokens, 7300, 'the token amount is still known');
  assert.strictEqual(out.aiDistributed, null, 'but its dollar value is not — never a guess');
});

test('with neither leg priced the dollar total is null, not zero', () => {
  const out = twoAssets({ totalRewarded: 10, totalRewarded2: 7300 }, {}, {});
  assert.strictEqual(out.distributedUsdTotal, null);
});

test('an unpaid second leg is null (the tile hides), a real zero stays 0', () => {
  assert.strictEqual(twoAssets({ totalRewarded: 1 }, { priceUsd: 1 }, { priceUsd: 1 }).aiDistributed, null);
  assert.strictEqual(twoAssets({ totalRewarded: 1, totalRewarded2: 0 }, { priceUsd: 1 }, { priceUsd: 1 }).aiDistributed, 0);
});

test('rewardAssets lists every asset, for a page that would rather loop', () => {
  const out = twoAssets({ totalRewarded: 10, totalRewarded2: 7300 }, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.deepStrictEqual(out.rewardAssets, [
    { symbol: 'NVDA', tokenAddress: '0xnvda', amount: 10, amountUsd: 2210 },
    { symbol: 'AI', tokenAddress: '0xai', amount: 7300, amountUsd: 2190 },
  ]);
});

test('totalRewarded2 mirrors totalRewarded, for positional readers', () => {
  const out = twoAssets({ totalRewarded: 10, totalRewarded2: 7300 }, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.strictEqual(out.totalRewarded, 10);
  assert.strictEqual(out.totalRewarded2, 7300);
  assert.strictEqual(out.totalRewarded2Usd, 2190);
});

// ── Three assets: the bought-back BABYINU leg ────────────────────────────────

const threeAssets = (rewards, price, p1, p2) =>
  buildStats({
    market: { priceUsd: price }, token: {}, rewards, curve: {}, quote: {},
    rewardPrice: p1, reward2Price: p2,
    symbol: 'BABYINU', tokenAddress: '0xbaby',
    rewardSymbol: 'NVDA', rewardTokenAddress: '0xnvda',
    reward2Symbol: 'AI', reward2TokenAddress: '0xai',
    ownTokenAddress: '0xbaby',
  });

test('the bought-back BABYINU is served under its ticker and a positional name', () => {
  const out = threeAssets({ totalRewarded: 10, totalRewarded2: 7300, totalRewardedOwn: 5_000_000 }, 0.00004, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.strictEqual(out.babyinuDistributedTokens, 5_000_000);
  assert.strictEqual(out.ownTokenDistributedTokens, 5_000_000);
  // 5,000,000 x 0.00004 is 200.00000000000003 in floating point.
  assert.ok(Math.abs(out.babyinuDistributedUsd - 200) < 1e-9);
  assert.ok(Math.abs(out.ownTokenDistributedUsd - 200) < 1e-9);
});

test('distributedUsdTotal adds all three assets, each at its own price', () => {
  const out = threeAssets({ totalRewarded: 10, totalRewarded2: 7300, totalRewardedOwn: 5_000_000 }, 0.00004, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.ok(Math.abs(out.distributedUsdTotal - (2210 + 2190 + 200)) < 1e-9);
  assert.deepStrictEqual(out.rewardAssets.map((a) => a.symbol), ['NVDA', 'AI', 'BABYINU']);
});

test('an unpriced BABYINU (no pool yet) keeps its amount and does not blank the total', () => {
  const out = threeAssets({ totalRewarded: 10, totalRewarded2: 7300, totalRewardedOwn: 5_000_000 }, null, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.strictEqual(out.babyinuDistributedTokens, 5_000_000);
  assert.strictEqual(out.babyinuDistributedUsd, null);
  assert.strictEqual(out.distributedUsdTotal, 2210 + 2190);
});

test('with OWN_TOKEN_PCT off the third asset is absent, not "0 paid"', () => {
  const out = buildStats({
    market: {}, token: {}, rewards: { totalRewarded: 1, totalRewarded2: 1, totalRewardedOwn: null },
    curve: {}, quote: {}, rewardPrice: { priceUsd: 1 }, reward2Price: { priceUsd: 1 },
    symbol: 'BABYINU', tokenAddress: '0xbaby', ownTokenAddress: null,
  });
  assert.strictEqual(out.ownTokenDistributed, null);
  assert.ok(!out.rewardAssets.some((a) => a.symbol === 'BABYINU'));
});

// ── This project's site: goodsht-meme6, src/api/stats.js ────────────────────
//
// Its normalise() reads marketCap, aiDistributed and nvdaDistributed, prints
// all three through formatUsd — as DOLLARS — and throws MALFORMED_STATS_PAYLOAD
// unless all three are finite numbers. These field names used to carry TOKEN
// counts (the Cat site's contract), which against this site would have shown
// "$30" for 30 NVDA (~220x low) and "$19.0K" for 19,000 AI (~3.3x high).

test('nvdaDistributed and aiDistributed are DOLLARS — what this site prints with a $', () => {
  const out = twoAssets({ totalRewarded: 30, totalRewarded2: 19_000 }, { priceUsd: 220 }, { priceUsd: 0.3 });
  assert.strictEqual(out.nvdaDistributed, 6600);
  assert.ok(Math.abs(out.aiDistributed - 5700) < 1e-9);
  // The same figures under the explicit names, so neither reading can drift.
  assert.strictEqual(out.nvdaDistributed, out.nvdaDistributedUsd);
  assert.strictEqual(out.aiDistributed, out.aiDistributedUsd);
});

test('the third asset follows the same rule: babyinuDistributed is dollars', () => {
  const out = threeAssets({ totalRewarded: 10, totalRewarded2: 7300, totalRewardedOwn: 5_000_000 }, 0.00004, { priceUsd: 221 }, { priceUsd: 0.3 });
  assert.ok(Math.abs(out.babyinuDistributed - 200) < 1e-9);
  assert.ok(Math.abs(out.ownTokenDistributed - 200) < 1e-9);
});

test("the site's own normalise() accepts the payload even when nothing is sourced", () => {
  // Mirrors goodsht-meme6/src/api/stats.js EXACTLY, fallback chains included.
  // An earlier version of this test called Number(out.aiDistributed) and passed
  // on null — but the site writes Number(raw.aiDistributed ?? raw.ai_distributed),
  // and ?? treats null as missing: it falls through to ai_distributed, which was
  // absent, so Number(undefined) is NaN and the WHOLE panel reads UPLINK FAILED —
  // before launch, and on any cold start before a price has loaded.
  const siteNormalise = (raw) => {
    const marketCap = Number(raw.marketCap ?? raw.market_cap ?? raw.mcap);
    const aiDistributed = Number(raw.aiDistributed ?? raw.ai_distributed);
    const nvdaDistributed = Number(raw.nvdaDistributed ?? raw.nvda_distributed);
    if (![marketCap, aiDistributed, nvdaDistributed].every(Number.isFinite)) throw new Error('MALFORMED_STATS_PAYLOAD');
    return { marketCap, aiDistributed, nvdaDistributed };
  };
  const json = (o) => JSON.parse(JSON.stringify(o)); // what the browser actually receives
  assert.doesNotThrow(() => siteNormalise(json(build({}, {}))), 'pre-launch: nothing sourced');
  // Live, with a reward asset whose price has not loaded yet.
  const unpriced = twoAssets({ totalRewarded: 30, totalRewarded2: 19000 }, { priceUsd: 220 }, {});
  assert.doesNotThrow(() => siteNormalise(json(unpriced)), 'one unpriced asset must not fail the panel');
  // And the real values still come through as dollars.
  const live = siteNormalise(json(twoAssets({ totalRewarded: 30, totalRewarded2: 19000 }, { priceUsd: 220 }, { priceUsd: 0.3 })));
  assert.strictEqual(live.nvdaDistributed, 6600);
  assert.ok(Math.abs(live.aiDistributed - 5700) < 1e-9);
});

// ── Bought back and KEPT (BUYBACK_HOLD_PCT) ─────────────────────────────────

test('kept BABYINU is served on its own, never as burned', () => {
  const out = buildStats({
    market: { priceUsd: 0.00004 }, token: {}, rewards: {}, curve: {}, quote: {},
    burns: { totalBurned: 0, totalBoughtBack: 5_000_000, boughtBackQuoteSpent: 3, buybacksHeld: 2 },
    symbol: 'BABYINU', tokenAddress: '0xbaby',
  });
  assert.strictEqual(out.totalBoughtBack, 5_000_000);
  assert.strictEqual(out.boughtBackQuoteSpent, 3);
  assert.strictEqual(out.buybacksHeld, 2);
  assert.ok(Math.abs(out.totalBoughtBackUsd - 200) < 1e-9);
  // A kept token still exists: it must not move the burn figures.
  assert.strictEqual(out.totalBurned, 0);
});

test('kept totals are null before there is anything to report, not a fake 0', () => {
  const out = buildStats({ market: {}, token: {}, rewards: {}, curve: {}, quote: {}, burns: {}, symbol: 'BABYINU', tokenAddress: null });
  assert.strictEqual(out.totalBoughtBack, null);
  assert.strictEqual(out.totalBoughtBackUsd, null);
});
