'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { Transaction } = require('@solana/web3.js');
const { buildSolanaTransaction, createBlockhashProvider, decodeData } = require('./solana');

// Captured live from api.relay.link on 2026-09-22: 0.2 SOL -> ABI.
const FIXTURE = require('./fixtures/relay-quote-solana-sol.json');
const INSTRUCTIONS = FIXTURE.steps[0].items[0].data.instructions;
const PAYER = 'CbPkzKxEowdmx3yZdBJ8u2K7kF2iSKqWW4bP2yKqvD3Q';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

test('Relay’s instructions become an unsigned legacy transaction the wallet can read back', () => {
  const b64 = buildSolanaTransaction({ instructions: INSTRUCTIONS, feePayer: PAYER, blockhash: BLOCKHASH });
  const tx = Transaction.from(Buffer.from(b64, 'base64'));
  assert.strictEqual(tx.feePayer.toBase58(), PAYER);
  assert.strictEqual(tx.recentBlockhash, BLOCKHASH);
  assert.strictEqual(tx.instructions.length, INSTRUCTIONS.length);
  assert.ok(tx.signatures.every((s) => s.signature === null), 'nothing is signed here — this process holds no key');
});

test('account order is kept exactly as Relay gave it', () => {
  const b64 = buildSolanaTransaction({ instructions: INSTRUCTIONS, feePayer: PAYER, blockhash: BLOCKHASH });
  const tx = Transaction.from(Buffer.from(b64, 'base64'));
  const got = tx.instructions[0].keys.map((k) => k.pubkey.toBase58());
  // Compiling a message de-duplicates keys; the program still sees them in order.
  const want = INSTRUCTIONS[0].keys.map((k) => k.pubkey);
  assert.deepStrictEqual(got, want);
});

test('a payer that is not a signer is refused before any wallet is asked', () => {
  const other = '11111111111111111111111111111112';
  assert.throws(() => buildSolanaTransaction({ instructions: INSTRUCTIONS, feePayer: other, blockhash: BLOCKHASH }), /not a signer/);
});

test('malformed instruction data is refused, but empty data is legal', () => {
  assert.strictEqual(decodeData('').length, 0);
  assert.throws(() => decodeData('abc'), /even-length/);
  assert.throws(() => decodeData(12), /even-length/);
  assert.throws(() => decodeData(null), /even-length/);
});

test('the blockhash is shared briefly, and concurrent callers join one request', async () => {
  let calls = 0;
  let t = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ result: { value: { blockhash: `h${calls}`, lastValidBlockHeight: 1 } } }) };
  };
  const p = createBlockhashProvider({ rpcUrl: 'http://x', ttlMs: 1000, now: () => t, fetchImpl });
  const [a, b] = await Promise.all([p.get(), p.get()]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(a.blockhash, 'h1');
  assert.strictEqual(b.blockhash, 'h1');
  t = 1500;
  assert.strictEqual((await p.get()).blockhash, 'h2', 'refreshed after the ttl');
});
