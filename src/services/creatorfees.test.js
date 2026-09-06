'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { parseCreatorFees, EMPTY } = require('./creatorfees');

// The shape pons actually returns, captured live from
// GET /api/pons-v2-market/{token}/creator-fees
const LIVE = {
  token: '0xc6E8C393d46B685C2Fb2177F759F2b16eB7A7D54',
  feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  recipient: '0x7b7D7C7695Ae09Dbc5196b301eEB196DF6711A67',
  quoteAsset: { address: '0xd060…', symbol: 'NVDA', decimals: 18, isNative: false },
  earnedForToken: '246642441851139767167',
  claimableForWallet: '1231406684135538862',
  sweepCount: 187,
  nothingToClaim: false,
};

test('the swept total is read in whole tokens, not wei', () => {
  const out = parseCreatorFees(LIVE);
  assert.ok(Math.abs(out.feesEarned - 246.642441851) < 1e-6, `got ${out.feesEarned}`);
  assert.strictEqual(out.sweeps, 187);
});

test('decimals come from the payload, never assumed', () => {
  // Every tokenized stock here is 18, but the field exists because the quote
  // asset is configurable — and a 6-decimal quote read as 18 would report a
  // trillionth of the real figure, which looks like "nothing earned yet".
  const out = parseCreatorFees({ ...LIVE, quoteAsset: { ...LIVE.quoteAsset, decimals: 6 }, earnedForToken: '246642441' });
  assert.ok(Math.abs(out.feesEarned - 246.642441) < 1e-6, `got ${out.feesEarned}`);
});

test('the recipient rides along, so the site can cross-check who gets paid', () => {
  // An independent second opinion on feeRecipientOk, from pons rather than from
  // our own read of the factory.
  assert.strictEqual(parseCreatorFees(LIVE).recipient, '0x7b7D7C7695Ae09Dbc5196b301eEB196DF6711A67');
});

test('a malformed answer is null, never zero', () => {
  // The site hides a null tile but renders a 0 as a real claim — "0 NVDA ever
  // earned" is a much worse thing to say than nothing at all.
  for (const bad of [null, undefined, {}, { earnedForToken: 'not-a-number' }, 'nope']) {
    const out = parseCreatorFees(bad);
    assert.strictEqual(out.feesEarned, null, `expected null for ${JSON.stringify(bad)}`);
    assert.strictEqual(out.sweeps, null);
  }
});

test('a genuine zero before the first sweep is reported as zero', () => {
  // Distinct from malformed: pons answering "nothing swept yet" is real news.
  const out = parseCreatorFees({ ...LIVE, earnedForToken: '0', sweepCount: 0 });
  assert.strictEqual(out.feesEarned, 0);
  assert.strictEqual(out.sweeps, 0);
});

test('EMPTY is all nulls, so a failed fetch degrades the same way', () => {
  assert.deepStrictEqual(EMPTY, { feesEarned: null, sweeps: null, recipient: null });
});
