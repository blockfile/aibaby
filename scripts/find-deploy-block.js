'use strict';

// Find HOLDER_INDEX_FROM_BLOCK — the block the token was created in — from the
// chain itself. Read-only: no wallet, no transactions.
//
//   node scripts/find-deploy-block.js                # uses TOKEN_ADDRESS from .env
//   node scripts/find-deploy-block.js 0xTOKEN        # or an explicit token
//
// Why not the explorer: Blockscout sits behind a Cloudflare challenge that
// intermittently refuses API calls outright, which is exactly when you need
// this at launch.
//
// How: a pons token mints its entire supply in the transaction that creates
// it, and a mint is a Transfer event FROM the zero address. The supply is fixed
// after that, so the earliest such event is the creation block. This walks
// backwards from the latest block in getLogs windows and stops at the first
// window with no mint once one has been seen.
//
// A start block a little EARLY is harmless — the index just reads a few empty
// blocks. A start block LATE misses the mint, the balances stop adding up to
// totalSupply, and the index refuses itself and falls back to the explorer.

const { JsonRpcProvider, id, zeroPadValue, getAddress } = require('ethers');
const config = require('../src/config');

const TRANSFER = id('Transfer(address,address,uint256)');
const FROM_ZERO = zeroPadValue('0x', 32);

// This chain makes roughly four blocks a second, so a token only days old is
// millions of blocks back. Start with the widest window an RPC here is known to
// serve (the public one allows 50,000 blocks per getLogs) and halve on a range
// refusal, down to HOLDER_INDEX_CHUNK — the size the holder index itself uses,
// so it always fits whatever RPC the bot is configured with.
const WIDEST = 50_000;

async function findDeployBlock({ provider, token, floor, log = () => {} }) {
  const latest = await provider.getBlockNumber();
  let chunk = WIDEST;
  let earliest = null;
  let calls = 0;
  let to = latest;

  while (to >= 0) {
    const from = Math.max(0, to - chunk + 1);
    let logs;
    try {
      logs = await provider.getLogs({ address: token, topics: [TRANSFER, FROM_ZERO], fromBlock: from, toBlock: to });
    } catch (err) {
      if (chunk > floor) {
        chunk = Math.max(floor, Math.floor(chunk / 2)); // refused: retry this window smaller
        continue;
      }
      throw err;
    }
    calls += 1;
    if (calls % 10 === 0) log(`  …searched back to block ${from} (${calls} calls, window ${chunk})`);

    if (logs.length) {
      earliest = logs.reduce((min, l) => Math.min(min, l.blockNumber), earliest ?? Infinity);
    } else if (earliest !== null) {
      break; // this whole window predates the token
    }
    if (from === 0) break;
    to = from - 1;
  }
  return { earliest, latest, calls };
}

async function main() {
  const raw = process.argv[2] || config.tokenAddress;
  if (!raw) {
    console.error('No token: pass it as an argument or set TOKEN_ADDRESS in .env');
    process.exit(1);
  }
  const token = getAddress(raw);
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
  const floor = Math.max(1_000, Math.min(Number(config.holderIndexChunk) || 9_000, WIDEST));

  if ((await provider.getCode(token)) === '0x') {
    console.error(`${token} has no contract code on chain ${config.chainId} — wrong address or wrong chain`);
    process.exit(1);
  }

  console.log(`token ${token}\nsearching back from the latest block…`);
  const { earliest, calls } = await findDeployBlock({ provider, token, floor, log: (m) => console.log(m) });

  if (earliest === null) {
    console.error('No mint found. The token may not mint from the zero address, or the RPC does not serve these logs.');
    process.exit(1);
  }

  const block = await provider.getBlock(earliest);
  console.log(`\ncreated in block ${earliest} (${new Date(block.timestamp * 1000).toISOString()}), found in ${calls} calls`);
  console.log(`\nput this in .env:\n  HOLDER_INDEX_FROM_BLOCK=${earliest}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('find-deploy-block failed:', err.shortMessage || err.message);
    process.exit(1);
  });
}

module.exports = { findDeployBlock };
