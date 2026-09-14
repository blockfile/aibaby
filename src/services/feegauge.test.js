'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { buildGauge, COLLECTING, DISTRIBUTING } = require('./feegauge');
const { finishedGauge } = require('../jobs/scheduler');

test('an empty tank reads as 0, not null — the site clamps and would show nothing', () => {
  const g = buildGauge(null, 100);
  assert.strictEqual(g.collectedUsd, 0);
  assert.strictEqual(g.thresholdUsd, 100);
  assert.strictEqual(g.status, COLLECTING);
});

test('a stored reading is served as-is', () => {
  const g = buildGauge(
    { collectedUsd: 80.42, thresholdUsd: 100, status: 'collecting', collectedQuote: 0.57, priceUsd: 141 },
    100
  );
  assert.strictEqual(g.collectedUsd, 80.42);
  assert.strictEqual(g.collectedQuote, 0.57);
  assert.strictEqual(g.priceUsd, 141);
});

test('the threshold falls back to config when the stored one is missing or nonsense', () => {
  assert.strictEqual(buildGauge({ collectedUsd: 5 }, 100).thresholdUsd, 100);
  assert.strictEqual(buildGauge({ thresholdUsd: 0 }, 100).thresholdUsd, 100);
  assert.strictEqual(buildGauge({ thresholdUsd: -5 }, 100).thresholdUsd, 100);
});

test('any unknown status collapses to collecting', () => {
  assert.strictEqual(buildGauge({ status: 'nonsense' }, 100).status, COLLECTING);
  assert.strictEqual(buildGauge({ status: 'distributing' }, 100).status, DISTRIBUTING);
});

test('the distribution marker is null until a payout lands, and STAYS null', () => {
  // The site resets its gauge animation whenever the marker changes. Before the
  // first distribution it must therefore be stable — which is why the response
  // carries `asOf` rather than `updatedAt`, a name the site would pick up as a
  // marker and see change on every single poll.
  const g = buildGauge({ collectedUsd: 10, at: '2026-08-30T10:00:00.000Z' }, 100);
  assert.strictEqual(g.lastDistributionId, null);
  assert.strictEqual(g.lastDistributionAt, null);
  assert.strictEqual(g.updatedAt, undefined, 'must not be named updatedAt');
  assert.strictEqual(g.asOf, '2026-08-30T10:00:00.000Z');
});

// ── what the bot writes when a cycle ends ─────────────────────────────────

test('a cycle that paid out empties the tank and moves the marker', () => {
  const g = finishedGauge({
    id: 7,
    status: 'complete',
    quote_distributed: 6.5,
    finished_at: '2026-08-30T10:05:00.000Z',
  });
  assert.strictEqual(g.collectedUsd, 0);
  assert.strictEqual(g.status, 'collecting');
  assert.strictEqual(g.lastDistributionId, '7');
  assert.strictEqual(g.lastDistributionAt, '2026-08-30T10:05:00.000Z');
});

test('a cycle that distributed NOTHING does not move the marker', () => {
  // Otherwise the site would play its "a distribution landed" animation for a
  // cycle that claimed nothing and paid nobody.
  for (const cycle of [
    { id: 8, status: 'skipped', quote_distributed: 0 },
    { id: 9, status: 'failed', quote_distributed: 0 },
    { id: 10, status: 'complete', quote_distributed: 0 },
  ]) {
    const g = finishedGauge(cycle);
    assert.strictEqual(g.lastDistributionId, undefined, `cycle ${cycle.id} must not mark a payout`);
    assert.strictEqual(g.status, 'collecting');
  }
});

test('in token mode the fallback threshold is the token amount at the stored price', () => {
  const { thresholdFallback } = require('./feegauge');
  const cfg = { triggerMode: 'token', claimEveryTokens: 1, claimEveryUsd: 100 };
  assert.strictEqual(thresholdFallback({ priceUsd: 221 }, cfg), 221);
  // No price stored: CLAIM_EVERY_USD only as a last-resort denominator.
  assert.strictEqual(thresholdFallback({}, cfg), 100);
});

test('the gauge serves the gate in NVDA and which gate it is', () => {
  const { buildGauge } = require('./feegauge');
  const g = buildGauge({ collectedUsd: 110, thresholdUsd: 221, thresholdQuote: 1, triggerMode: 'token', priceUsd: 221 }, 100);
  assert.strictEqual(g.thresholdUsd, 221);
  assert.strictEqual(g.thresholdQuote, 1);
  assert.strictEqual(g.triggerMode, 'token');
});
