'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildToken } = require('./token');

test('ticker carries the "$" the site displays; symbol does not', () => {
  const out = buildToken({ name: 'Artificial Baby Inu', symbol: 'BABYAI', tokenAddress: '0xabc' });
  assert.strictEqual(out.ticker, '$BABYAI');
  assert.strictEqual(out.symbol, 'BABYAI');
  assert.strictEqual(out.name, 'Artificial Baby Inu');
  assert.strictEqual(out.contractAddress, '0xabc');
  assert.strictEqual(out.chain, 'Robinhood Chain');
});

test('pre-launch the contract address is null, not an empty string', () => {
  assert.strictEqual(buildToken({ name: 'Artificial Baby Inu', symbol: 'BABYAI', tokenAddress: null }).contractAddress, null);
});

// The Cat-template site's Lore.jsx reads `token?.lore ?? []` — the ONLY
// field it takes from /token.

test('lore keeps its shape, so a Cat-template site renders rather than crashes', () => {
  const out = buildToken({ name: 'Artificial Baby Inu', symbol: 'BABYAI', tokenAddress: null });
  assert.ok(Array.isArray(out.lore), 'lore must stay an array');
});

test('lore is empty until this project has its own story — never the cat one it was cloned with', () => {
  // A wrong story renders as true; an empty one renders as an empty terminal.
  const out = buildToken({ name: 'Artificial Baby Inu', symbol: 'BABYAI', tokenAddress: null });
  assert.deepStrictEqual(out.lore, []);
});
