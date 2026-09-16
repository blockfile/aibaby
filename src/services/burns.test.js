'use strict';

process.env.DRY_RUN = 'true';
process.env.TOKEN_ADDRESS = '0x50d0d0da00ffd195d2d1d2448617ad039855ad2b';

const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { EMPTY } = require('./burns');

let mongod;
let db;
let repo;
let fetchBurns;

// Lifecycle in before/after, NOT inline: a failed assertion mid-test would
// otherwise skip the teardown, leave mongod running, and hang the whole file
// until the runner's timeout.
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'aibaby_burns_test';
  for (const m of ['./../config', '../db/index', '../db/repository', './burns']) {
    delete require.cache[require.resolve(m)];
  }
  db = require('../db');
  repo = require('../db/repository');
  ({ fetchBurns } = require('./burns'));
  await db.connect();
});

test.after(async () => {
  if (db) await db.close();
  if (mongod) await mongod.stop();
});

const REAL_TX = `0x${'a'.repeat(64)}`;

test('pre-launch, the burn total is null rather than zero', () => {
  // The site hides a null tile but renders a 0 as a real "nothing burned" claim.
  assert.strictEqual(EMPTY.totalBurned, null);
  assert.strictEqual(EMPTY.burnQuoteSpent, null);
});

test('sums real burns and ignores simulated or unburned ones', async () => {
  const cycleId = await repo.createCycle({ dryRun: false });
  const buyback = ({ signature = REAL_TX, status = 'ok', ...detail }) =>
    repo.addStep({ cycleId, name: 'buyback', status, signature, detail });

  await buyback({ burned: true, tokensBought: 100, quoteSpent: 1 });
  await buyback({ burned: true, tokensBought: 50, quoteSpent: 0.5 });

  // A DRY_RUN burn: status 'ok' and burned true, but a fabricated signature.
  // Counting it would publish an invented burn to visitors.
  await buyback({ signature: 'burn_ka9f2x', burned: true, tokensBought: 9999, quoteSpent: 99 });

  // Bought but NOT burned — the tokens exist and totalSupply has not dropped,
  // so this must not be reported as a burn.
  await buyback({
    signature: `0x${'b'.repeat(64)}`,
    status: 'failed',
    burned: false,
    bought: true,
    tokensBought: 777,
    quoteSpent: 7,
  });

  const out = await fetchBurns();
  assert.strictEqual(out.totalBurned, 150, 'only the two real, burned buybacks count');
  assert.strictEqual(out.burnQuoteSpent, 1.5, 'and only what those two cost');
  assert.strictEqual(out.burns, 2);
});

// ── burned supply, derived from the token rather than our own ledger ──────

const { pickBurnedSupply } = require('./burns');

// Live figures from ASHIBA, 2026-09-08.
const LIVE = { mintedSupply: 1e9, supplyReduced: 1_641_149.103, deadBalance: 17_361_521.2, ledgerBurned: 1_641_149.103 };

test('burned counts BOTH routes — supply reduction and the dead address', () => {
  // Two mechanisms, one outcome: nobody can ever spend either. burn(uint256)
  // reduces totalSupply; a transfer to 0x…dEaD leaves supply alone but sends the
  // tokens somewhere with no key. This chain treats both as burned, so the
  // headline figure is the sum.
  const out = pickBurnedSupply(LIVE);
  assert.ok(Math.abs(out.totalBurned - 19_002_670.303) < 1e-6);
  assert.ok(Math.abs(out.burnedPctOfSupply - 1.9002670303) < 1e-9);
});

test('the two routes stay separately reportable', () => {
  // Because they are not interchangeable if anyone checks: totalSupply moves for
  // one and not the other, so an explorer will read 998.36M against a 981M
  // circulating figure. Publishing the split means that gap has an answer.
  const out = pickBurnedSupply(LIVE);
  assert.ok(Math.abs(out.burnedBySupplyReduction - 1_641_149.103) < 1e-6);
  assert.ok(Math.abs(out.burnedToDeadAddress - 17_361_521.2) < 1e-6);
});

test('the chain figure beats the ledger, because the ledger can be short', () => {
  // The ledger counts buyback steps this bot wrote. A burn done by hand — which
  // is exactly what the dead-address send was — is invisible to it.
  const out = pickBurnedSupply({ ...LIVE, ledgerBurned: 1_000_000 });
  assert.strictEqual(out.totalBurnedByBot, 1_000_000);
  assert.ok(out.totalBurned > out.totalBurnedByBot, 'and the total is not capped by it');
});

test('with no chain reading yet, the ledger still answers', () => {
  const out = pickBurnedSupply({ mintedSupply: 1e9, supplyReduced: null, deadBalance: null, ledgerBurned: 1_459_292.35 });
  assert.strictEqual(out.totalBurned, 1_459_292.35);
  assert.strictEqual(out.burnedToDeadAddress, null);
});

test('nothing burned yet is zero, not null', () => {
  const out = pickBurnedSupply({ mintedSupply: 1e9, supplyReduced: 0, deadBalance: 0, ledgerBurned: 0 });
  assert.strictEqual(out.totalBurned, 0);
  assert.strictEqual(out.burnedPctOfSupply, 0);
});

test('pre-launch, with nothing to divide by, the percentage is null not NaN', () => {
  const out = pickBurnedSupply({ mintedSupply: null, supplyReduced: null, deadBalance: null, ledgerBurned: null });
  assert.strictEqual(out.totalBurned, null);
  assert.strictEqual(out.burnedPctOfSupply, null);
});

// ── The chain figure and the kept-buyback figure travel together ─────────────
//
// This fork has a leg neither ashiba nor neko has: BABYINU bought and KEPT.
// Merging the chain-derived burn totals in must not drop it — they answer
// different questions, and dropping either blanks a tile on the site.

test('fetchBurns serves the chain totals and the kept-buyback totals at once', async () => {
  const cycleId = await repo.createCycle({ dryRun: false });
  await repo.addStep({
    cycleId, name: 'buyback-hold', status: 'ok', signature: `0x${'c'.repeat(64)}`,
    detail: { bought: true, tokensBought: 5_000_000, quoteSpent: 3 },
  });
  // What the bot writes each poll, read straight from the token.
  await repo.setDistributionState({ supplyReduced: 0, deadBalance: 44_478_742.09, circulatingSupply: 1e9 });

  const out = await fetchBurns();
  // Everything at 0x…dEaD counts, including a burn done by hand outside a cycle.
  assert.ok(Math.abs(out.totalBurned - 44_478_742.09) < 1e-6);
  assert.ok(Math.abs(out.burnedToDeadAddress - 44_478_742.09) < 1e-6);
  assert.strictEqual(out.burnedBySupplyReduction, 0, 'burn(uint256) is not how this fork burns');
  assert.ok(out.totalBurnedByBot < out.totalBurned, 'the bot accounts for only part of it');
  assert.strictEqual(out.circulatingSupply, 1e9);
  // And the kept leg is still reported, separately from any burn.
  assert.strictEqual(out.totalBoughtBack, 5_000_000);
  assert.strictEqual(out.boughtBackQuoteSpent, 3);
  assert.strictEqual(out.buybacksHeld, 1);
});
