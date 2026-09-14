'use strict';

// GET /token — token identity, fetched once on load.
//
// The Cat-template site's App.jsx reads only `lore` from this (the Origin Log
// paragraphs, see src/lore.js); its ticker, supply and contract address are
// hardcoded in its src/site.js. The identity fields are still served so a
// frontend built from the other templates in this lineage — which do read
// `ticker` — works against this API unchanged.

const express = require('express');
const config = require('../config');
const { lore } = require('../lore');

const router = express.Router();

/** Pure: the token identity the site reads. */
function buildToken({ name, symbol, tokenAddress, rewardSymbol = 'NVDA' }) {
  return {
    name,
    ticker: `$${symbol}`,
    symbol,
    contractAddress: tokenAddress ?? null, // null until launch — the site shows a dash
    chain: 'Robinhood Chain',
    lore: lore({ symbol, rewardSymbol }),
  };
}

router.get('/token', (req, res) => {
  res.json(
    buildToken({
      name: config.tokenName,
      symbol: config.tokenSymbol,
      tokenAddress: config.tokenAddress,
      rewardSymbol: config.rewardSymbol || 'NVDA',
    })
  );
});

module.exports = { router, buildToken };
