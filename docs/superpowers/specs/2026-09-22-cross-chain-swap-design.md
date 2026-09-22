# Buy $ABI from any chain — design

**Date:** 2026-09-22
**Repos:** `aibaby-api` (backend, `blockfile/aibaby`) and `D:\goodsht-meme6` (site, branch `swap`, not pushed)
**Reference:** `D:\projects\ponsy` branch `swap-quote-api` (Relay integration, proven live) and `D:\newponsy\Meme4` branch `swap-exec` (browser signing)

## Goal

A visitor on artificialbabyinu.com pays with a native coin on another chain and
receives $ABI on Robinhood Chain in one wallet signature, with no manual
bridging. The site's "Swap for $ABI" section already exists; it needs a real
backend and two frontend fixes.

## Decisions

| Question | Decision |
| --- | --- |
| Pay coins | Native only: ETH on Ethereum (1), Base (8453), Arbitrum (42161), Optimism (10); BNB (56); SOL (Relay chain id 792703809). One signature each. No USDC/USDT. |
| Team fee | None. No Relay `appFees`. |
| SOL buyers' destination | A 0x address, auto-filled from Phantom's built-in Ethereum account or a connected MetaMask, editable, required. |
| Architecture | Routes in the existing public API process (`server.js`), under `/swap`. No new process, port or domain. |
| Provider | Relay (`https://api.relay.link`), which routes straight into ABI. |

### Verified before design (2026-09-22, price-only Relay quotes)

| Pay | In | Out | Impact | Steps |
| --- | --- | --- | --- | --- |
| Base ETH | 0.02 ETH ($54.97) | 248,588 ABI ($53.70) | 2.32% | `deposit` |
| Ethereum ETH | 0.02 ETH ($54.97) | 248,489 ABI ($53.67) | 2.36% | `deposit` |
| Solana SOL | 0.3 SOL ($35.16) | 157,754 ABI ($34.07) | 3.10% | `deposit` |

ABI (`0x657bd0541f2e8f89bdb85bcd91589695ca24b85a`) has graduated to a
NVDA-quoted pons v4 pool; Relay's solver reaches it anyway. NVDA itself is
`UNSUPPORTED_CURRENCY` on Relay, which does not matter here.

## Backend (`aibaby-api`)

Everything lives in the **public API process only**. It holds no wallet key and
signs nothing; the buyer's wallet signs. The bot process is untouched.

### Units

| File | One job | Depends on |
| --- | --- | --- |
| `src/swap/assets.js` | The six pay coins as a static allowlist, keyed (`eth-1`, `eth-8453`, `eth-42161`, `eth-10`, `bnb-56`, `sol`): symbol, name, chain slug (`ethereum`, `base`, `arbitrum`, `optimism`, `bsc`, `solana` — what the site sends as `fromChain`), Relay chain id, currency id (`0x000…0` for EVM native, `11111111111111111111111111111111` for SOL), decimals, `vm` (`evm`/`svm`), tx explorer prefix. Plus `DESTINATION` = ABI on chain 4663, from config, never from a request. | config |
| `src/swap/relay.js` | HTTP to Relay: `POST /quote` and the intents status endpoint. 12s timeout. `RELAY_API_KEY` sent as `x-api-key` when set. Relay `errorCode`/`message` rethrown as a typed error; a 2xx body that does not parse throws. | fetch |
| `src/swap/quotes.js` | Pure: human amount → base units without floating point; build the Relay body; shape a Relay quote into the site's `Quote`; validate an executable Relay response; map Relay status to the site's `Status`. | assets |
| `src/swap/solana.js` | Pure-ish: Relay Solana instructions + a recent blockhash → unsigned **legacy** transaction, base64. Ported from ponsy (legacy works because every account is named explicitly; proven with 0.05 SOL → PONSY). Blockhash fetched from `SOLANA_RPC_URL`, cached 10s. | `@solana/web3.js` |
| `src/swap/store.js` | In-memory maps with TTL: `quoteId → {request, createdAt}` (60s) and `trackingId → {originKey, txHash}` (1h). A restart forgets them; the site re-quotes. | — |
| `src/routes/swap.js` | The Express router, mounted at `/swap` with `express.json()` scoped to it. | all of the above |

### Endpoints (the contract the site's `src/api/swap.js` already calls)

**`GET /swap/tokens`** → `{ tokens: [Token] }` — the six coins
(`symbol, name, chain, chainId, chainLabel, decimals, address, explorer`).

**`POST /swap/quote`** `{ fromToken, fromChain, amount, slippage, fromAddress? }`
- Resolves the coin from the allowlist by `fromToken` + `fromChain`; anything else → 400.
- Asks Relay for a **price-only** quote (placeholder user, as in ponsy) with
  `tradeType: EXACT_INPUT`, `destinationChainId: 4663`,
  `destinationCurrency: ABI`, and `slippageTolerance` in basis points.
- Refuses below `MIN_SWAP_USD` (default 10) using Relay's `currencyIn.amountUsd`;
  a missing USD value refuses too (fails closed).
- Stores the request under a random `quoteId` for 60s.
- Returns `{ quoteId, toAmount, rate, priceImpactPct, fee: { usd }, minReceived, route, etaSeconds, expiresAt }`.
  Fee = Relay `fees.relayer.amountUsd` (which already includes relayer gas).
- Identical price-only quotes are cached 5s, because every visitor shares the
  server's IP and anonymous Relay allows about 5 quotes per window.

**`POST /swap/execute`** `{ quoteId, wallet, recipient? }`
- Unknown or expired `quoteId` → 410 "quote expired".
- `wallet` must be a 0x address for EVM coins, a base58 key for SOL.
- Recipient: EVM coins deliver to `wallet`; SOL requires `recipient`, a valid
  non-zero 0x address, else 400.
- Fresh Relay quote with the real `user` and `recipient`, then **validation
  before anything reaches a wallet**: exactly one step, id `deposit`, one item;
  EVM item `chainId` equals the coin's chain and `from` equals `wallet`; the
  quote's destination is chain 4663 and currency ABI. Anything else → 502 and
  nothing is returned to sign.
- EVM → `tx: { to, data, value, gas (number), chainId }`. Relay's `gas` may be
  a JSON string; it is converted to a number and always forwarded (dropping it
  made MetaMask on Base pick a 140M limit that Infura rejects). `maxFeePerGas`
  and `maxPriorityFeePerGas` are never forwarded.
- SOL → `solanaTx` (base64 unsigned legacy transaction, built now so its
  blockhash is fresh).
- `trackingId` = Relay's `requestId`; the coin is remembered for explorer links.

**`GET /swap/status/:trackingId`** → `{ status, step, txHash, explorerUrl, destTxHash, destExplorerUrl, message }`

| Relay | Site status | Step |
| --- | --- | --- |
| waiting / unknown | `pending` | 1 |
| pending, depositing | `bridging` | 2 |
| submitted on destination | `delivering` | 3 |
| success | `done` | 3 |
| failure | `failed` ("swap failed — funds were not taken" or Relay's message) | — |
| refund | `failed` ("refunded to your wallet on the source chain") | — |

`explorerUrl` points at the **origin** chain (ponsy lesson); `destExplorerUrl`
at `rh-scan.com`. Relay's exact status vocabulary is confirmed against live
responses during implementation; unknown values map to `pending`, never to
`failed`.

**`POST /swap/status/:trackingId`** `{ txHash }` — remembers the hash the user
broadcast, so status has an explorer link before Relay indexes the deposit.

### Errors

| Situation | HTTP | Site shows |
| --- | --- | --- |
| `NO_SWAP_ROUTES_FOUND`, `SWAP_IMPACT_TOO_HIGH`, amount too small/large | 422 `{ message }` | "No route" + reason |
| Relay 429 | 429 | "Too many requests" |
| Relay slower than 12s | 504 | retry |
| Bad input | 400 `{ message }` | the message |
| Quote expired | 410 `{ message }` | "Quote expired, refresh" |
| Relay response fails validation | 502 `{ message }` | error, nothing to sign |

### Config (new env, all optional)

| Key | Default | Purpose |
| --- | --- | --- |
| `SWAP_ENABLED` | `true` | `false` answers 404 on every `/swap` route |
| `RELAY_URL` | `https://api.relay.link` | |
| `RELAY_API_KEY` | — | raises Relay's limit from ~5/window to 50/min; recommended before launch |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | blockhash for SOL transactions |
| `MIN_SWAP_USD` | `10` | minimum trade, fails closed |

`CORS_ORIGINS` already allows the site; the `cors` middleware already permits
POST with a JSON body.

## Frontend (`D:\goodsht-meme6`, branch `swap`, committed locally, not pushed)

The swap window already runs quote → execute → switch chain → send → report hash
→ poll status. Changes:

1. **Point at the API.** `VITE_SWAP_API_URL=https://api.artificialbabyinu.com/swap`,
   `VITE_SWAP_USE_MOCK=false` (in `.env.example` and the README; Netlify for the
   real build). `src/config/swap.js` fallback coins become the same six; USDC and
   USDT removed.
2. **SOL signing.** Add `@solana/web3.js`; `sendSolanaTx` rebuilds the transaction
   with `Transaction.from(base64)` and calls the provider's
   `signAndSendTransaction(tx)`. Phantom returns `{ signature }`, Solflare a bare
   string; both handled. The current code passes raw bytes, which Phantom rejects.
3. **Receive address for SOL.** When SOL is selected, a "RECEIVE $ABI AT" field:
   auto-filled from `window.phantom.ethereum` (silent `eth_accounts`, then
   `eth_requestAccounts` on click) or the connected MetaMask; editable; must be a
   non-zero 0x address; shown on the confirm screen; sent as `recipient`.
4. **Chain switching.** On error 4902, `wallet_addEthereumChain` with the chain's
   parameters (Arbitrum and Optimism are the likely misses), then switch again,
   then re-check `eth_chainId`.
5. **No double sends.** The confirm button locks on first click; a quote that has
   been broadcast is never executed again; a status poll that times out says
   "sent, still confirming", never "failed".
6. **Copy.** Swap section and the flywheel's "Head to the Pons launchpad" line:
   pay with ETH, BNB or SOL from any major chain.

## Testing

- **Unit:** assets allowlist, base-unit conversion (decimals 9 and 18, no float
  drift), Relay body (destination locked, slippage in bps, EXACT_INPUT), quote
  shaping, executable validation (wrong chain, wrong `from`, extra step,
  approve step, wrong destination all rejected), gas string → number,
  status mapping including unknown values, minimum fails closed.
- **Routes:** against a fake Relay using real responses captured live for ABI
  (Base ETH deposit, Solana SOL deposit, one error), covering every row of the
  error table and the 60s quote expiry.
- **Solana:** captured Relay instructions → a legacy transaction that
  deserialises with the expected fee payer and instruction count.
- **Live, before handover:** price quotes for all six coins; an `/execute` call
  with a real address that returns a valid unsigned transaction (not signed).
- **First real swap:** a small one done by the owner.

## Out of scope

Stablecoin pay tokens, a team fee, a hosted checkout, WalletConnect/multi-wallet
discovery, and any change to the bot, the split or the stats endpoints.

## Going live

1. `git pull && npm ci --omit=dev` on the API server (adds `@solana/web3.js`).
2. Set `RELAY_API_KEY` (recommended), `SOLANA_RPC_URL` if a private RPC is
   available, `MIN_SWAP_USD` if not 10.
3. `pm2 restart aibaby-api --update-env`. No nginx or domain change; the bot is
   not restarted.
4. Netlify: set `VITE_SWAP_API_URL` and `VITE_SWAP_USE_MOCK=false`, clear cache
   and redeploy.
