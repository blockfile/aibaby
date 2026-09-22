# Swap for $ABI — frontend handoff

**For:** the developer of the Artificial Baby Inu site (`goodsht-meme6`, branch `swap`).
**Backend:** live at `https://api.artificialbabyinu.com/swap` once deployed (see "Status" at the end).

The site's "Swap for $ABI" section and `src/api/swap.js` already call the right
endpoints. The backend now answers them for real, using Relay to route a native
coin on another chain straight into $ABI on Robinhood Chain in **one wallet
signature**. This document lists what the site must change to go from demo to
real swaps.

## 1. Environment (Netlify → Site configuration → Environment variables)

```
VITE_SWAP_ENABLED=true
VITE_SWAP_USE_MOCK=false
VITE_SWAP_API_URL=https://api.artificialbabyinu.com/swap
```

No trailing slash on the URL (a trailing slash produced `//status` 404s in a
previous project). `VITE_SWAP_API_KEY` is not needed — leave it empty. These
are baked in at build time: redeploy with "Clear cache and deploy site".

## 2. What people can pay with

Exactly six coins, all native (one signature each). **Remove USDC and USDT** —
a token needs an approve transaction first, which this flow does not do.

| symbol | chain (what the site sends as `fromChain`) | wallet |
| --- | --- | --- |
| ETH | `ethereum` | EVM |
| ETH | `base` | EVM |
| ETH | `arbitrum` | EVM |
| ETH | `optimism` | EVM |
| BNB | `bsc` | EVM |
| SOL | `solana` | Solana (Phantom / Solflare) |

`GET /tokens` returns this list. Update the fallback `payTokens` in
`src/config/swap.js` to the same six so the demo and the real list match.

Each EVM coin in `/tokens` carries a `wallet` object ready for
`wallet_addEthereumChain` (see change 4). **`normaliseToken` in
`src/api/swap.js` currently drops it — keep `wallet` and `vm`:**

```js
// in normaliseToken's return object
vm: pick(raw, 'vm') || (chain === 'solana' ? 'svm' : 'evm'),
wallet: pick(raw, 'wallet') || null,
```

## 3. The API, with real responses

### `POST /quote`
What the site already sends:
```json
{ "fromToken": "ETH", "fromChain": "base", "amount": "0.01", "slippage": 1, "toToken": "ABI", "toChain": "robinhood" }
```
Answer (price only — no wallet needed, nothing signable):
```json
{
  "quoteId": "3f9c0d2a8b7e41c6a5d0e912",
  "toAmount": "126451.927",
  "toAmountUsd": 26.58,
  "fromAmountUsd": 27.44,
  "rate": 12645192.7,
  "priceImpactPct": 0.91,
  "fee": { "usd": 0.1777, "token": "USD" },
  "minReceived": 125187.4,
  "route": ["Relay"],
  "etaSeconds": 1,
  "expiresAt": "2026-09-22T14:05:31.000Z"
}
```
- A `quoteId` is valid for **60 seconds**. The site's 15s refresh keeps it fresh.
- `slippage` accepts 0.1–5 (%). The site's 0.5 / 1 / 3 options are fine.
- Minimum swap is **$10**.

### `POST /execute` — the one change to the request body
Today the site sends `{ quoteId, wallet }`. **For SOL it must also send
`recipient`** (see change 3):
```json
{ "quoteId": "3f9c…", "wallet": "0xBuyer…", "recipient": "0xReceiver…" }
```
Answer for an EVM coin:
```json
{
  "trackingId": "0x179008362934…c3aad",
  "tx": { "to": "0x4cd00e387622c35bddb9b4c962c136462338bc31", "data": "0x49290c1c…", "value": "10000000000000000", "gas": 32713, "chainId": 8453 },
  "recipient": "0xBuyer…",
  "quote": { "toAmount": "126451.927", "minReceived": 125187.4, "…": "same shape as /quote" }
}
```
Answer for SOL:
```json
{ "trackingId": "0x17900836332d…cf948", "solanaTx": "AQAAAA…base64…", "lastValidBlockHeight": 312345678, "recipient": "0xReceiver…", "quote": { "…": "…" } }
```
`quote` is the fresh price for the real wallet. Show `quote.toAmount` on the
confirm screen if you want the most accurate figure.

### `GET /status/{trackingId}`
```json
{ "status": "bridging", "step": 2, "txHash": "0xab…", "explorerUrl": "https://basescan.org/tx/0xab…", "destTxHash": null, "destExplorerUrl": null, "message": null }
```
`status` is one of `pending` (step 1) → `bridging` (2) → `delivering` (3) →
`done` (3), or `failed` with a `message` (including "refunded to your wallet on
the source chain"). `explorerUrl` is on the chain the buyer paid on;
`destExplorerUrl` is on rh-scan.com. `POST /status/{trackingId}` with
`{ txHash }` is already called by the site and is supported.

### Errors
Every error body is `{ "error": "...", "message": "...", "code": "..." }`.

| HTTP | When | Show |
| --- | --- | --- |
| 400 | bad input (e.g. no 0x recipient for SOL, unlisted coin) | `message` |
| 410 | quote older than 60s | "Quote expired" + refresh the quote, then let them confirm again |
| 422 | Relay can't do it: below $10, amount too small for fees, no route | `message` — it says why, e.g. "minimum swap is $10 (this is $2.74)" |
| 429 | rate limited | retry shortly |
| 502 | Relay's answer failed our safety checks | `message`; nothing was sent to the wallet |
| 503 | Relay's temporary problem (already retried once) | "try again" — the next auto-refresh usually works |
| 504 | Relay slower than 12s | retry |

`request()` in `src/api/swap.js` maps 404/422 to `NO_ROUTE`, and
`describeError` then ignores the message and always says "NO ROUTE FOR THIS
PAIR". **Show `err.message` for `NO_ROUTE`**, and map 400/410/503 to readable
text too, otherwise "minimum swap is $10" reads as "no route".

## 4. Changes to make

### Change 1 — SOL signing (currently broken)
`sendSolanaTx` in `src/hooks/useWallet.js` passes raw bytes to Phantom's
`signAndSendTransaction`, which expects a `Transaction` object, so every SOL
swap fails. Add the Solana library and rebuild the transaction first:

```bash
npm i @solana/web3.js
```
```js
import { Transaction } from '@solana/web3.js'
import { Buffer } from 'buffer' // Vite does not polyfill Buffer; npm i buffer

const sendSolanaTx = useCallback(async (b64) => {
  const p = solProvider()
  if (!p) throw new WalletError('NO_PROVIDER')
  try {
    const tx = Transaction.from(Buffer.from(b64, 'base64'))
    const res = await p.signAndSendTransaction(tx)
    // Phantom returns { signature }, Solflare returns the signature string.
    return typeof res === 'string' ? res : res?.signature
  } catch (err) {
    if (err?.code === 4001 || /rejected/i.test(err?.message || '')) throw new WalletError('REJECTED', 'You rejected the request in your wallet')
    throw new WalletError('FAILED', err?.message || 'Solana wallet request failed')
  }
}, [])
```
Sign as soon as `/execute` answers: the transaction carries a recent Solana
blockhash that expires after roughly 60–90 seconds. Never cache a `solanaTx`.

### Change 2 — gas must be hex in `eth_sendTransaction`
`tx.gas` arrives as a number (e.g. `32713`). `sendEvmTx` passes it through as a
number; wallets expect a hex quantity. Always send it — without a gas limit,
MetaMask on Base once picked 140M and the RPC rejected the transaction.

```js
const gas = tx.gas == null ? undefined : toHex(BigInt(tx.gas))
return await p.request({ method: 'eth_sendTransaction', params: [{ from: state.address, to: tx.to, data: tx.data, value, gas }] })
```
Do not add `maxFeePerGas` / `maxPriorityFeePerGas`; the wallet prices gas.

### Change 3 — "RECEIVE $ABI AT" for SOL buyers
$ABI lives on Robinhood Chain (EVM). A Solana wallet has no address there, so
when SOL is selected show a required field:

- **Auto-fill** from Phantom's built-in Ethereum account:
  `window.phantom?.ethereum?.request({ method: 'eth_accounts' })` (silent), or
  on a "USE MY PHANTOM ADDRESS" click, `eth_requestAccounts`. If MetaMask is
  connected, offer its address too.
- **Editable**: the buyer can paste any address.
- **Validate**: `/^0x[0-9a-fA-F]{40}$/` and not `0x000…000`. Disable the swap
  button until valid.
- **Show it on the confirm screen** ("ABI will arrive at 0x1234…abcd on
  Robinhood Chain") and send it as `recipient` in `executeSwap`:

```js
// src/api/swap.js — executeSwap
const j = await request('/execute', { method: 'POST', signal, body: { quoteId: quote.quoteId, wallet, recipient } })
```
EVM buyers receive at their own wallet; send no `recipient` for them.

### Change 4 — chain switching for Arbitrum and Optimism
`switchEvmChain` only calls `wallet_switchEthereumChain`. A wallet that has
never used the chain answers error **4902**; add it, then switch again, then
re-check:

```js
const switchEvmChain = useCallback(async (chainId, addParams) => {
  const p = evmProvider()
  if (!p) throw new WalletError('NO_PROVIDER')
  if (state.chainId === chainId) return
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chainId) }] })
  } catch (err) {
    if (err?.code !== 4902 || !addParams) throw mapEvmError(err)
    await p.request({ method: 'wallet_addEthereumChain', params: [addParams] }) // the token's `wallet` object from /tokens
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chainId) }] })
  }
  const now = fromHex(await p.request({ method: 'eth_chainId' }))
  if (now !== chainId) throw new WalletError('WRONG_CHAIN')
  set({ chainId: now })
}, [state.chainId])
```
In `SwapModal.jsx`: `await wallet.switchEvmChain(Number(chainId), from.wallet)`.

### Change 5 — never send twice
A double click, a re-render or a retry after the wallet already broadcast must
not start a second deposit. In `SwapModal.jsx`:

- Lock the confirm button on the first click (a `useRef` flag, not only state —
  state updates are async).
- Once a tx hash exists for a quote, never call `executeSwap` again for it; a
  retry after that point only resumes status polling with the same `trackingId`.
- Cap the status loop (e.g. 5 minutes). When it runs out, show "SENT — STILL
  CONFIRMING" with the explorer link, **not** "failed": the funds are in flight.

### Change 6 — copy
- Swap section: "pay with ETH, BNB or SOL from Ethereum, Base, Arbitrum,
  Optimism, BNB Chain or Solana".
- `src/data/content.js` flywheel line "Head to the Pons launchpad" → mention the
  swap.

## 5. Test before going live

1. `npm run dev` with the three env values above in `.env.local`.
2. The pay list shows the six coins; USDC/USDT are gone.
3. Quotes appear for each coin at ~$30 (e.g. 0.01 ETH, 0.05 BNB, 0.2 SOL); an
   amount under $10 shows "minimum swap is $10…".
4. SOL selected → the receive field appears, auto-fills from Phantom, and
   blocks the button when empty or invalid.
5. A real swap of about $10–15 with ETH on Base (cheapest gas), then one with
   SOL. Each should finish in under a minute with a Robinhood `destExplorerUrl`.
6. Double-click the confirm button: only one wallet prompt appears.

## Status

The backend endpoints are in `blockfile/aibaby` (`src/routes/swap.js`). Before
testing against production, confirm with the owner that the API server has
been updated: `curl -s https://api.artificialbabyinu.com/swap/tokens` should
list six coins.
