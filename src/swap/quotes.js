'use strict';

// The rules of a swap, as pure functions: what we ask Relay for, how its answer
// is shaped for the site, and what an answer must look like before any of it
// is handed to a wallet. No network here — relay.js is the transport — so
// every rule is testable against captured responses.
//
// Ported from ponsy (D:\projects\ponsy, src/quote.js), where the same flow
// shipped. The comments carry the incidents behind each check.

const { isAddress } = require('ethers');
const { SOLANA_CHAIN_ID } = require('./assets');

// Placeholders for a PRICE-ONLY quote, which needs a user but commits nobody:
// neither address has a key anyone holds. Never used for anything signable —
// execute always re-quotes with the buyer's real wallet.
const PRICE_ONLY_EVM = '0x' + 'dead'.repeat(10);
const PRICE_ONLY_SVM = '11111111111111111111111111111111';

// Base58 excludes 0, O, I and l so addresses cannot be misread; 32-44 chars.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SLIPPAGE_MIN = 0.1;
const SLIPPAGE_MAX = 5;
const SLIPPAGE_DEFAULT = 1;

class SwapInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Pure: decimal string -> integer base-unit string, without floating point. */
function toBaseUnits(amount, decimals) {
  const s = String(amount ?? '').trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    throw new SwapInputError(`amount must be a number, got: ${String(amount).slice(0, 24)}`);
  }
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > decimals) throw new SwapInputError(`amount has more than ${decimals} decimal places`);
  const units = (whole + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  if (BigInt(units) <= 0n) throw new SwapInputError('amount must be greater than zero');
  return units;
}

/** Pure: slippage percent -> Relay basis points (string). 1% -> "100". */
function slippageBps(pct) {
  const n = pct === undefined || pct === null || pct === '' ? SLIPPAGE_DEFAULT : Number(pct);
  if (!Number.isFinite(n) || n < SLIPPAGE_MIN || n > SLIPPAGE_MAX) {
    throw new SwapInputError(`slippage must be between ${SLIPPAGE_MIN}% and ${SLIPPAGE_MAX}%`);
  }
  return String(Math.round(n * 100));
}

const isEvmAddress = (v) => typeof v === 'string' && isAddress(v) && !/^0x0{40}$/i.test(v);
const isSolanaAddress = (v) => typeof v === 'string' && BASE58_RE.test(v);

/**
 * Pure: who pays and who receives, for a quote that can be signed.
 *
 * EVM coins deliver to the paying wallet. A Solana wallet has no Robinhood
 * address, so SOL needs an explicit 0x recipient — refused rather than
 * defaulted, because a default would send the tokens somewhere the buyer
 * never chose.
 */
function parties(asset, { wallet, recipient }) {
  // Re-stringified defensively: Express turns ?user[0]=x into an array, and a
  // non-string that slipped through once became an all-zero Solana key.
  const w = typeof wallet === 'string' ? wallet.trim() : '';
  if (asset.vm === 'svm') {
    if (!isSolanaAddress(w)) throw new SwapInputError('connect a Solana wallet to pay with SOL');
    const r = typeof recipient === 'string' ? recipient.trim() : '';
    if (!isEvmAddress(r)) throw new SwapInputError('enter the 0x address that should receive the tokens');
    return { user: w, recipient: r };
  }
  if (!isEvmAddress(w)) throw new SwapInputError(`connect an EVM wallet to pay with ${asset.symbol}`);
  return { user: w, recipient: w };
}

/** Pure: the Relay /quote body. Destination comes from `dest`, never a request. */
function buildRelayBody({ asset, dest, amount, slippage, user, recipient }) {
  const priceOnly = !user;
  const payer = user || (asset.vm === 'svm' ? PRICE_ONLY_SVM : PRICE_ONLY_EVM);
  return {
    user: payer,
    recipient: recipient || (priceOnly ? PRICE_ONLY_EVM : payer),
    originChainId: asset.chainId,
    destinationChainId: dest.chainId,
    originCurrency: asset.currency,
    destinationCurrency: dest.address,
    amount: toBaseUnits(amount, asset.decimals),
    tradeType: 'EXACT_INPUT',
    slippageTolerance: slippageBps(slippage),
  };
}

const finite = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Pure: whole tokens from a raw integer string. */
function fromRaw(raw, decimals) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  return Number(v / scale) + Number(v % scale) / Number(scale);
}

/**
 * Pure: the minimum trade, checked on Relay's own dollar figure.
 *
 * Fails closed — a quote with no USD value is refused, not waved through,
 * because "unknown" is exactly when a dust trade would slip past.
 */
function checkMinimum(relay, minUsd) {
  const usd = finite(relay?.details?.currencyIn?.amountUsd);
  if (usd === null) throw new SwapInputError('could not price this amount — try again', 422);
  if (usd < minUsd) throw new SwapInputError(`minimum swap is $${minUsd} (this is $${usd.toFixed(2)})`, 422);
  return usd;
}

/** Pure: a Relay quote in the site's Quote shape. */
function shapeQuote(relay, { quoteId, expiresAt, dest }) {
  const d = relay.details || {};
  const out = d.currencyOut || {};
  const outDecimals = out.currency?.decimals ?? dest.decimals;
  const impact = finite(d.totalImpact?.percent);
  const fee = finite(relay.fees?.relayer?.amountUsd); // already includes relayer gas
  return {
    quoteId,
    toAmount: String(out.amountFormatted ?? ''),
    toAmountUsd: finite(out.amountUsd),
    fromAmountUsd: finite(d.currencyIn?.amountUsd),
    rate: finite(d.rate),
    // Relay reports impact as a signed percent ("-2.51"); the site shows a size.
    priceImpactPct: impact === null ? null : Math.abs(impact),
    fee: { usd: fee, token: 'USD' },
    minReceived: fromRaw(out.minimumAmount, outDecimals),
    route: ['Relay'],
    etaSeconds: finite(d.timeEstimate),
    expiresAt,
  };
}

/** Pure: Relay's gas limit as a number, or undefined. Never a string, never 0. */
function parseGasLimit(value) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Pure: the one transaction a buyer may sign, or a throw.
 *
 * Checked before anything reaches a wallet, because a wallet shows a hex blob
 * a buyer cannot read. Exactly one step with id `deposit`, one item, on the
 * coin's own chain, from the buyer's own wallet, and a quote that still
 * delivers the launch token on Robinhood Chain to the chosen recipient.
 *
 * @returns {{ kind: 'evm', tx: object } | { kind: 'svm', instructions: object[], requestId: string }}
 */
function executableFrom(relay, { asset, dest, user, recipient }) {
  const fail = (why) => {
    const err = new Error(`refusing to hand this swap to a wallet: ${why}`);
    err.status = 502;
    throw err;
  };
  const steps = Array.isArray(relay?.steps) ? relay.steps : fail('no steps');
  if (steps.length !== 1) fail(`expected one step, got ${steps.length} (${steps.map((s) => s.id).join('+')})`);
  const step = steps[0];
  if (step.id !== 'deposit') fail(`expected a deposit, got "${step.id}"`);
  if (!Array.isArray(step.items) || step.items.length !== 1) fail('expected one transaction');
  const requestId = step.requestId || relay.requestId;
  if (!requestId) fail('no request id to track');

  const out = relay.details?.currencyOut?.currency || {};
  if (Number(out.chainId) !== Number(dest.chainId) || !sameAddress(out.address, dest.address)) {
    fail('it does not deliver the token on Robinhood Chain');
  }
  if (relay.details?.recipient && !sameAddress(relay.details.recipient, recipient)) {
    fail('it delivers to a different address');
  }

  const data = step.items[0].data || {};
  if (asset.vm === 'svm') {
    if (!Array.isArray(data.instructions) || data.instructions.length === 0) fail('no Solana instructions');
    return { kind: 'svm', instructions: data.instructions, requestId };
  }

  if (Number(data.chainId) !== asset.chainId) fail(`it is on chain ${data.chainId}, not ${asset.chainId}`);
  if (!sameAddress(data.from, user)) fail('it is not from the connected wallet');
  if (!isAddress(data.to || '')) fail('no destination contract');
  const gas = parseGasLimit(data.gas);
  return {
    kind: 'evm',
    requestId,
    // Gas is always forwarded, as a number: without it MetaMask on Base once
    // picked a 140M limit that Infura rejects. Fee-price fields are NOT
    // forwarded — the wallet prices gas for the chain it is actually on.
    tx: {
      to: data.to,
      data: data.data || '0x',
      value: String(data.value ?? '0'),
      ...(gas ? { gas } : {}),
      chainId: asset.chainId,
    },
  };
}

// Relay intent status -> the site's four steps. Unknown values stay pending:
// a swap that is merely slow must never be reported as failed.
const STATUS_MAP = {
  waiting: { status: 'pending', step: 1 },
  unknown: { status: 'pending', step: 1 },
  pending: { status: 'bridging', step: 2 },
  delayed: { status: 'bridging', step: 2, message: 'taking longer than usual — still in progress' },
  submitted: { status: 'delivering', step: 3 },
  success: { status: 'done', step: 3 },
  failure: { status: 'failed', step: 1, message: 'the swap failed — Relay did not take your funds' },
  refund: { status: 'failed', step: 1, message: 'refunded to your wallet on the source chain' },
  refunded: { status: 'failed', step: 1, message: 'refunded to your wallet on the source chain' },
};

/** Pure: a Relay status response in the site's Status shape. */
function shapeStatus(relayStatus, { asset, dest, reportedTxHash }) {
  const s = relayStatus || {};
  const m = STATUS_MAP[String(s.status || '').toLowerCase()] || STATUS_MAP.waiting;
  const inHash = (Array.isArray(s.inTxHashes) && s.inTxHashes[0]) || reportedTxHash || null;
  const outHash = (Array.isArray(s.txHashes) && s.txHashes[0]) || null;
  return {
    status: m.status,
    step: m.step,
    txHash: inHash,
    // The explorer of the chain the buyer PAID on — linking the deposit to the
    // destination explorer shows "transaction not found".
    explorerUrl: inHash && asset ? `${asset.explorer}${inHash}` : null,
    destTxHash: outHash,
    destExplorerUrl: outHash ? `${dest.explorer}${outHash}` : null,
    message: m.message || null,
  };
}

module.exports = {
  SwapInputError,
  PRICE_ONLY_EVM, PRICE_ONLY_SVM, SOLANA_CHAIN_ID,
  toBaseUnits, slippageBps, parties, buildRelayBody, checkMinimum,
  shapeQuote, parseGasLimit, executableFrom, shapeStatus, fromRaw,
  isEvmAddress, isSolanaAddress,
};
