'use strict';

// What a buyer can pay with, and what they always receive.
//
// A static allowlist on purpose. Every coin here was quoted live into ABI
// through Relay before it was added, and a request can only NAME one of these
// by symbol + chain — never pass an address or chain id of its own. The
// destination is not a request field at all: it comes from config, so no
// request can point a swap at a different token.
//
// Native coins only. Each one is a single deposit transaction; a token such as
// USDC needs an approve first, which the site's one-signature flow does not do.

const config = require('../config');

/** Relay's id for Solana. */
const SOLANA_CHAIN_ID = 792703809;
const EVM_NATIVE = '0x0000000000000000000000000000000000000000';
const SOL_NATIVE = '11111111111111111111111111111111';

// `wallet` is what wallet_addEthereumChain needs when a buyer's wallet does not
// know the chain yet (Arbitrum and Optimism are the usual misses).
const ASSETS = [
  {
    key: 'eth-1', symbol: 'ETH', name: 'Ethereum', chain: 'ethereum', chainLabel: 'Ethereum',
    chainId: 1, vm: 'evm', currency: EVM_NATIVE, decimals: 18,
    explorer: 'https://etherscan.io/tx/',
    wallet: { chainName: 'Ethereum', rpcUrls: ['https://ethereum-rpc.publicnode.com'], blockExplorerUrls: ['https://etherscan.io'] },
  },
  {
    key: 'eth-8453', symbol: 'ETH', name: 'Ethereum', chain: 'base', chainLabel: 'Base',
    chainId: 8453, vm: 'evm', currency: EVM_NATIVE, decimals: 18,
    explorer: 'https://basescan.org/tx/',
    wallet: { chainName: 'Base', rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  },
  {
    key: 'eth-42161', symbol: 'ETH', name: 'Ethereum', chain: 'arbitrum', chainLabel: 'Arbitrum',
    chainId: 42161, vm: 'evm', currency: EVM_NATIVE, decimals: 18,
    explorer: 'https://arbiscan.io/tx/',
    wallet: { chainName: 'Arbitrum One', rpcUrls: ['https://arb1.arbitrum.io/rpc'], blockExplorerUrls: ['https://arbiscan.io'] },
  },
  {
    key: 'eth-10', symbol: 'ETH', name: 'Ethereum', chain: 'optimism', chainLabel: 'Optimism',
    chainId: 10, vm: 'evm', currency: EVM_NATIVE, decimals: 18,
    explorer: 'https://optimistic.etherscan.io/tx/',
    wallet: { chainName: 'OP Mainnet', rpcUrls: ['https://mainnet.optimism.io'], blockExplorerUrls: ['https://optimistic.etherscan.io'] },
  },
  {
    key: 'bnb-56', symbol: 'BNB', name: 'BNB', chain: 'bsc', chainLabel: 'BNB Chain',
    chainId: 56, vm: 'evm', currency: EVM_NATIVE, decimals: 18,
    explorer: 'https://bscscan.com/tx/',
    wallet: { chainName: 'BNB Smart Chain', rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] },
  },
  {
    key: 'sol', symbol: 'SOL', name: 'Solana', chain: 'solana', chainLabel: 'Solana',
    chainId: SOLANA_CHAIN_ID, vm: 'svm', currency: SOL_NATIVE, decimals: 9,
    explorer: 'https://solscan.io/tx/',
  },
];

/** Pure: the coin a request names, or null. Case-insensitive on both fields. */
function findAsset(symbol, chain) {
  const s = String(symbol || '').trim().toUpperCase();
  const c = String(chain || '').trim().toLowerCase();
  return ASSETS.find((a) => a.symbol === s && a.chain === c) || null;
}

/** Pure: a coin by its key (what a stored quote and a tracked swap remember). */
function assetByKey(key) {
  return ASSETS.find((a) => a.key === key) || null;
}

/** What every swap delivers: the launch token on Robinhood Chain. */
function destination(cfg = config) {
  return {
    symbol: cfg.tokenSymbol,
    chain: 'robinhood',
    chainLabel: 'Robinhood Chain',
    chainId: cfg.chainId,
    address: cfg.tokenAddress,
    decimals: cfg.tokenDecimals,
    explorer: cfg.explorerTxBase,
  };
}

/** Pure: a coin as GET /swap/tokens serves it — the site's Token shape. */
function publicToken(a) {
  return {
    symbol: a.symbol,
    name: a.name,
    chain: a.chain,
    chainId: a.vm === 'evm' ? a.chainId : null,
    chainLabel: a.chainLabel,
    decimals: a.decimals,
    address: null, // native coin
    vm: a.vm,
    explorer: a.explorer,
    ...(a.wallet ? { wallet: { chainId: `0x${a.chainId.toString(16)}`, ...a.wallet, nativeCurrency: { name: a.name, symbol: a.symbol, decimals: a.decimals } } } : {}),
  };
}

module.exports = {
  ASSETS, SOLANA_CHAIN_ID, EVM_NATIVE, SOL_NATIVE,
  findAsset, assetByKey, destination, publicToken,
};
