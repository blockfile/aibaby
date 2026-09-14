'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { findDeployBlock } = require('./find-deploy-block');

// A fake RPC: the token was created (minted) at `mintBlock`, the chain is at
// `latest`, and getLogs refuses any window wider than `maxRange` the way
// QuickNode refuses anything over 10,000 blocks.
function fakeProvider({ latest, mintBlock, maxRange = Infinity }) {
  const seen = [];
  return {
    seen,
    getBlockNumber: async () => latest,
    getLogs: async ({ fromBlock, toBlock }) => {
      const width = toBlock - fromBlock + 1;
      seen.push(width);
      if (width > maxRange) throw new Error(`eth_getLogs is limited to a ${maxRange} range`);
      return mintBlock !== null && mintBlock >= fromBlock && mintBlock <= toBlock ? [{ blockNumber: mintBlock }] : [];
    },
  };
}

test('finds the creation block far back in the chain', async () => {
  const provider = fakeProvider({ latest: 1_600_000, mintBlock: 123_456 });
  const { earliest } = await findDeployBlock({ provider, token: '0xabc', floor: 9_000 });
  assert.strictEqual(earliest, 123_456);
});

test('narrows the window when the RPC refuses a wide range, and still finds it', async () => {
  // A 10,000-block RPC: the 50,000 opening window is refused and halved until
  // it fits, rather than failing the whole lookup.
  const provider = fakeProvider({ latest: 400_000, mintBlock: 250_123, maxRange: 10_000 });
  const { earliest } = await findDeployBlock({ provider, token: '0xabc', floor: 9_000 });
  assert.strictEqual(earliest, 250_123);
  assert.ok(provider.seen.some((w) => w > 10_000), 'it tried wide first');
  assert.ok(provider.seen.every((w, i) => i === 0 || w <= 50_000), 'never wider than the opening window');
});

test('a token created minutes ago is found in the first window', async () => {
  // The real launch-day case: one call.
  const provider = fakeProvider({ latest: 62_000_000, mintBlock: 61_999_900 });
  const { earliest, calls } = await findDeployBlock({ provider, token: '0xabc', floor: 9_000 });
  assert.strictEqual(earliest, 61_999_900);
  assert.ok(calls <= 2, `expected one or two calls, took ${calls}`);
});

test('no mint anywhere is reported as null, not a made-up block', async () => {
  const provider = fakeProvider({ latest: 120_000, mintBlock: null });
  const { earliest } = await findDeployBlock({ provider, token: '0xabc', floor: 9_000 });
  assert.strictEqual(earliest, null);
});

test('below the floor, a refusal is a real error and is thrown', async () => {
  const provider = fakeProvider({ latest: 100_000, mintBlock: 50_000, maxRange: 500 });
  await assert.rejects(findDeployBlock({ provider, token: '0xabc', floor: 9_000 }), /limited to a 500 range/);
});
