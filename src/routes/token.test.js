'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildToken } = require('./token');

test('ticker carries the "$" the site displays; symbol does not', () => {
  const out = buildToken({ name: 'Artificial Cat', symbol: 'ARTCAT', tokenAddress: '0xabc' });
  assert.strictEqual(out.ticker, '$ARTCAT');
  assert.strictEqual(out.symbol, 'ARTCAT');
  assert.strictEqual(out.name, 'Artificial Cat');
  assert.strictEqual(out.contractAddress, '0xabc');
  assert.strictEqual(out.chain, 'Robinhood Chain');
});

test('pre-launch the contract address is null, not an empty string', () => {
  assert.strictEqual(buildToken({ name: 'Artificial Cat', symbol: 'ARTCAT', tokenAddress: null }).contractAddress, null);
});

// The Artificial Cat site's Lore.jsx reads `token?.lore ?? []` — the ONLY
// field it takes from /token. Without it the live site boots the Origin Log
// terminal with nothing in it.

test('serves the Origin Log paragraphs the site renders from `lore`', () => {
  const out = buildToken({ name: 'Artificial Cat', symbol: 'ARTCAT', tokenAddress: null });
  assert.ok(Array.isArray(out.lore), 'lore must be an array');
  assert.strictEqual(out.lore.length, 3);
  for (const p of out.lore) assert.ok(typeof p === 'string' && p.length > 40, 'each entry is a paragraph');
  assert.match(out.lore.join(' '), /\$ARTCAT is that experiment/);
});

test('the lore names the ticker it is served with, so a rename cannot leave it stale', () => {
  const out = buildToken({ name: 'Artificial Cat', symbol: 'XYZ', tokenAddress: null });
  assert.match(out.lore.join(' '), /\$XYZ is that experiment/);
  assert.doesNotMatch(out.lore.join(' '), /\$ARTCAT/);
});
