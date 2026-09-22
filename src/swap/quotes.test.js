'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const q = require('./quotes');
const { findAsset, assetByKey, ASSETS, publicToken } = require('./assets');

const ABI = '0x657bd0541f2e8f89bdb85bcd91589695ca24b85a';
const DEST = { chainId: 4663, address: ABI, decimals: 18, explorer: 'https://rh-scan.com/tx/' };
const BASE_ETH = assetByKey('eth-8453');
const SOL = assetByKey('sol');
// Captured live from api.relay.link on 2026-09-22 for this exact token.
const EVM_FIXTURE = require('./fixtures/relay-quote-base-eth.json');
const SOL_FIXTURE = require('./fixtures/relay-quote-solana-sol.json');
const EVM_USER = '0x1111111111111111111111111111111111111111';
const SOL_USER = 'CbPkzKxEowdmx3yZdBJ8u2K7kF2iSKqWW4bP2yKqvD3Q';
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── The allowlist ────────────────────────────────────────────────────────────

test('exactly the six native coins are payable', () => {
  assert.deepStrictEqual(ASSETS.map((a) => a.key), ['eth-1', 'eth-8453', 'eth-42161', 'eth-10', 'bnb-56', 'sol']);
  assert.ok(ASSETS.every((a) => a.currency === '0x0000000000000000000000000000000000000000' || a.key === 'sol'));
});

test('a coin is found by what the site sends: symbol + chain slug, any case', () => {
  assert.strictEqual(findAsset('eth', 'BASE').key, 'eth-8453');
  assert.strictEqual(findAsset('SOL', 'solana').key, 'sol');
  assert.strictEqual(findAsset('USDC', 'ethereum'), null, 'no stablecoins');
  assert.strictEqual(findAsset('ETH', 'robinhood'), null, 'not the destination chain');
});

test('EVM coins carry what wallet_addEthereumChain needs; SOL does not', () => {
  const arb = publicToken(assetByKey('eth-42161'));
  assert.strictEqual(arb.wallet.chainId, '0xa4b1');
  assert.ok(arb.wallet.rpcUrls[0].startsWith('https://'));
  assert.deepStrictEqual(arb.wallet.nativeCurrency, { name: 'Ethereum', symbol: 'ETH', decimals: 18 });
  const sol = publicToken(SOL);
  assert.strictEqual(sol.wallet, undefined);
  assert.strictEqual(sol.chainId, null, "Relay's Solana id is internal, not a wallet chain id");
});

// ── Amounts ──────────────────────────────────────────────────────────────────

test('amounts convert to base units exactly, with no float drift', () => {
  assert.strictEqual(q.toBaseUnits('0.1', 18), '100000000000000000');
  assert.strictEqual(q.toBaseUnits('0.3', 9), '300000000');
  // 0.1 + 0.2 style drift would show up here as ...0000004.
  assert.strictEqual(q.toBaseUnits('1.000000000000000001', 18), '1000000000000000001');
  assert.strictEqual(q.toBaseUnits('.5', 9), '500000000');
});

test('bad amounts are refused with a readable message', () => {
  for (const bad of ['', '.', 'abc', '-1', '1e18', '0', '0.000', '1.0000000001']) {
    assert.throws(() => q.toBaseUnits(bad, 9), q.SwapInputError, `should refuse "${bad}"`);
  }
});

test('slippage goes to Relay in basis points and is bounded', () => {
  assert.strictEqual(q.slippageBps(0.5), '50');
  assert.strictEqual(q.slippageBps(1), '100');
  assert.strictEqual(q.slippageBps(3), '300');
  assert.strictEqual(q.slippageBps(undefined), '100', 'unset is 1%, not 0%');
  assert.throws(() => q.slippageBps(0), q.SwapInputError);
  assert.throws(() => q.slippageBps(50), q.SwapInputError);
});

// ── The Relay request ────────────────────────────────────────────────────────

test('the destination is always the launch token on Robinhood Chain', () => {
  const body = q.buildRelayBody({ asset: BASE_ETH, dest: DEST, amount: '0.01', slippage: 1 });
  assert.strictEqual(body.destinationChainId, 4663);
  assert.strictEqual(body.destinationCurrency, ABI);
  assert.strictEqual(body.originChainId, 8453);
  assert.strictEqual(body.tradeType, 'EXACT_INPUT');
  assert.strictEqual(body.amount, '10000000000000000');
  assert.strictEqual(body.slippageTolerance, '100');
});

test('a price-only quote uses keyless placeholders, never a real address', () => {
  const evm = q.buildRelayBody({ asset: BASE_ETH, dest: DEST, amount: '0.01' });
  assert.strictEqual(evm.user, q.PRICE_ONLY_EVM);
  const sol = q.buildRelayBody({ asset: SOL, dest: DEST, amount: '0.2' });
  assert.strictEqual(sol.user, q.PRICE_ONLY_SVM);
  assert.strictEqual(sol.recipient, q.PRICE_ONLY_EVM, 'a Solana quote still needs a 0x recipient');
});

test('EVM coins deliver to the paying wallet; SOL needs its own 0x recipient', () => {
  assert.deepStrictEqual(q.parties(BASE_ETH, { wallet: EVM_USER }), { user: EVM_USER, recipient: EVM_USER });
  assert.deepStrictEqual(q.parties(SOL, { wallet: SOL_USER, recipient: EVM_USER }), { user: SOL_USER, recipient: EVM_USER });
  assert.throws(() => q.parties(SOL, { wallet: SOL_USER }), /0x address/);
  assert.throws(() => q.parties(SOL, { wallet: SOL_USER, recipient: '0x0000000000000000000000000000000000000000' }), /0x address/);
  assert.throws(() => q.parties(BASE_ETH, { wallet: SOL_USER }), /EVM wallet/);
  assert.throws(() => q.parties(SOL, { wallet: EVM_USER, recipient: EVM_USER }), /Solana wallet/);
  assert.throws(() => q.parties(BASE_ETH, { wallet: [EVM_USER] }), /EVM wallet/, 'an array is not an address');
});

// ── The minimum ──────────────────────────────────────────────────────────────

test('the minimum is checked on Relay’s dollar figure, and fails closed', () => {
  assert.ok(q.checkMinimum(EVM_FIXTURE, 10) > 10);
  assert.throws(() => q.checkMinimum(EVM_FIXTURE, 1000), (e) => e.status === 422 && /minimum swap is \$1000/.test(e.message));
  const noUsd = clone(EVM_FIXTURE);
  delete noUsd.details.currencyIn.amountUsd;
  assert.throws(() => q.checkMinimum(noUsd, 10), (e) => e.status === 422, 'unknown value is refused, not waved through');
});

// ── The quote the site shows ─────────────────────────────────────────────────

test('a Relay quote becomes the site’s Quote', () => {
  const out = q.shapeQuote(EVM_FIXTURE, { quoteId: 'abc', expiresAt: '2026-09-22T12:00:00.000Z', dest: DEST });
  assert.strictEqual(out.quoteId, 'abc');
  assert.ok(Number(out.toAmount) > 100000, 'the ABI amount, as a decimal string');
  assert.ok(out.priceImpactPct > 0 && out.priceImpactPct < 10, 'impact as a positive size, not Relay’s signed string');
  assert.ok(out.minReceived > 0 && out.minReceived < Number(out.toAmount), 'minimum after slippage');
  assert.ok(out.fee.usd > 0, 'relayer fee in dollars');
  assert.deepStrictEqual(out.route, ['Relay']);
  assert.strictEqual(out.expiresAt, '2026-09-22T12:00:00.000Z');
});

// ── What may reach a wallet ──────────────────────────────────────────────────

test('the captured Base deposit becomes one EVM transaction, gas as a number', () => {
  const ex = q.executableFrom(EVM_FIXTURE, { asset: BASE_ETH, dest: DEST, user: EVM_USER, recipient: EVM_USER });
  assert.strictEqual(ex.kind, 'evm');
  assert.strictEqual(ex.tx.chainId, 8453);
  assert.strictEqual(typeof ex.tx.gas, 'number', 'Relay sends "32713" — a string — and it must arrive as a number');
  assert.strictEqual(ex.tx.value, '10000000000000000');
  assert.ok(!('maxFeePerGas' in ex.tx) && !('maxPriorityFeePerGas' in ex.tx), 'the wallet prices gas itself');
  assert.match(ex.requestId, /^0x[0-9a-f]{64}$/);
});

test('the captured Solana deposit yields its instructions', () => {
  const ex = q.executableFrom(SOL_FIXTURE, { asset: SOL, dest: DEST, user: SOL_USER, recipient: EVM_USER });
  assert.strictEqual(ex.kind, 'svm');
  assert.ok(ex.instructions.length >= 1);
});

test('anything but one deposit, on the right chain, from the buyer, to ABI, is refused', () => {
  const opts = { asset: BASE_ETH, dest: DEST, user: EVM_USER, recipient: EVM_USER };
  const cases = {
    'an approve step first': (r) => r.steps.unshift({ ...r.steps[0], id: 'approve' }),
    'a step that is not a deposit': (r) => { r.steps[0].id = 'swap'; },
    'two transactions in the step': (r) => r.steps[0].items.push(r.steps[0].items[0]),
    'another origin chain': (r) => { r.steps[0].items[0].data.chainId = 1; },
    'another sender': (r) => { r.steps[0].items[0].data.from = '0x2222222222222222222222222222222222222222'; },
    'another token delivered': (r) => { r.details.currencyOut.currency.address = '0x2222222222222222222222222222222222222222'; },
    'another destination chain': (r) => { r.details.currencyOut.currency.chainId = 8453; },
    'another recipient': (r) => { r.details.recipient = '0x2222222222222222222222222222222222222222'; },
    'no steps at all': (r) => { delete r.steps; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const r = clone(EVM_FIXTURE);
    mutate(r);
    assert.throws(() => q.executableFrom(r, opts), (e) => e.status === 502 && /refusing/.test(e.message), name);
  }
});

test('an unusable gas value is dropped, never forwarded as 0 or text', () => {
  assert.strictEqual(q.parseGasLimit('32713'), 32713);
  assert.strictEqual(q.parseGasLimit(32713), 32713);
  assert.strictEqual(q.parseGasLimit('0'), undefined);
  assert.strictEqual(q.parseGasLimit('abc'), undefined);
  assert.strictEqual(q.parseGasLimit(null), undefined);
});

// ── Status ───────────────────────────────────────────────────────────────────

test('Relay statuses map onto the site’s four steps', () => {
  const s = (status, extra = {}) => q.shapeStatus({ status, ...extra }, { asset: BASE_ETH, dest: DEST });
  assert.deepStrictEqual([s('waiting').status, s('pending').status, s('submitted').status, s('success').status], ['pending', 'bridging', 'delivering', 'done']);
  assert.strictEqual(s('failure').status, 'failed');
  assert.match(s('refund').message, /refunded/);
  assert.match(s('refunded').message, /refunded/);
});

test('a status Relay has never used before stays pending, never failed', () => {
  assert.strictEqual(q.shapeStatus({ status: 'something-new' }, { asset: BASE_ETH, dest: DEST }).status, 'pending');
  assert.strictEqual(q.shapeStatus({}, { asset: BASE_ETH, dest: DEST }).status, 'pending');
});

test('the deposit links to the chain paid on; the delivery to Robinhood', () => {
  const st = q.shapeStatus({ status: 'success', inTxHashes: ['0xin'], txHashes: ['0xout'] }, { asset: BASE_ETH, dest: DEST });
  assert.strictEqual(st.explorerUrl, 'https://basescan.org/tx/0xin');
  assert.strictEqual(st.destExplorerUrl, 'https://rh-scan.com/tx/0xout');
  const early = q.shapeStatus({ status: 'waiting' }, { asset: BASE_ETH, dest: DEST, reportedTxHash: '0xmine' });
  assert.strictEqual(early.explorerUrl, 'https://basescan.org/tx/0xmine', 'the hash the buyer reported, before Relay indexes it');
});
