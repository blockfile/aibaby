'use strict';

// Relay's Solana instructions -> an UNSIGNED transaction the buyer's wallet
// signs. Ported from ponsy (src/chain/solana.js), where 0.05 SOL -> PONSY went
// through end to end.
//
// A LEGACY transaction, deliberately. Relay describes a v0 transaction with an
// address lookup table, but every account is named explicitly in the
// instructions, so the table is a size optimisation, not a requirement — and
// skipping it saves an RPC round trip per swap.
//
// The server never signs. Serialising with requireAllSignatures:false is the
// whole point: this process holds no key.

const { PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const config = require('../config');

// `*` not `+`: zero-byte instruction data is legal (e.g. the ATA program's
// legacy Create). What must never happen is a missing field silently becoming
// empty — the typeof check in decodeData closes that.
const HEX_RE = /^[0-9a-fA-F]*$/;

function decodeData(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`instruction data must be an even-length hex string, got: ${String(hex).slice(0, 24)}`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Pure: an unsigned legacy transaction, base64.
 *
 * Account order is kept exactly as Relay gave it — programs index accounts by
 * position, so a reorder does not fail loudly, it moves funds elsewhere.
 */
function buildSolanaTransaction({ instructions, feePayer, blockhash }) {
  if (!Array.isArray(instructions) || instructions.length === 0) throw new Error('at least one instruction is required');
  if (!blockhash) throw new Error('a recent blockhash is required');
  const payer = new PublicKey(feePayer);

  const tx = new Transaction();
  for (const raw of instructions) {
    if (!Array.isArray(raw.keys)) throw new Error('instruction keys must be an array');
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(raw.programId),
        keys: raw.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: Boolean(k.isSigner), isWritable: Boolean(k.isWritable) })),
        data: decodeData(raw.data),
      })
    );
  }

  // Relay must name the payer as a signer. If it did not, the wallet would be
  // asked for a signature it has no reason to give, and the failure would only
  // show up after the buyer approved — as an opaque RPC rejection.
  const payerSigns = tx.instructions.some((ix) => ix.keys.some((k) => k.isSigner && k.pubkey.equals(payer)));
  if (!payerSigns) throw new Error(`fee payer ${payer.toBase58()} is not a signer in any instruction`);

  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/**
 * A shared, briefly cached blockhash. Not per-user state: every transaction in
 * the same few seconds can carry the same one, so a public RPC suffices.
 * Concurrent callers join one in-flight request.
 */
function createBlockhashProvider({ rpcUrl = config.solanaRpcUrl, ttlMs = 10_000, timeoutMs = 8_000, now = Date.now, fetchImpl = fetch } = {}) {
  let cached = null;
  let storedAt = 0;
  let inFlight = null;

  async function fetchOne() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
      const j = await res.json();
      if (j?.error) throw new Error(`Solana RPC: ${j.error.message ?? 'unknown'}`);
      const v = j?.result?.value;
      if (!v?.blockhash) throw new Error('Solana RPC returned no blockhash');
      return Object.freeze({ blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight ?? null });
    } finally {
      clearTimeout(timer);
    }
  }

  async function get() {
    if (cached && now() - storedAt < ttlMs) return cached;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          cached = await fetchOne();
          storedAt = now();
          return cached;
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  }

  return { get };
}

module.exports = { buildSolanaTransaction, createBlockhashProvider, decodeData };
