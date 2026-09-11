'use strict';

// The Artificial Cat site's "Origin Log" — served by GET /token as `lore`.
//
// The site's Lore.jsx renders `token.lore` (an array of paragraphs) and nothing
// else from /token, so against the live API this file IS that section: without
// it the terminal boots empty. The text is the site's own, copied verbatim from
// its src/api/mockData.js; edit it here and restart the API to change the page.
//
// The tickers are filled in from config rather than typed, so renaming the
// token cannot leave the story naming the old one.

function lore({ symbol, rewardSymbol }) {
  return [
    'Somewhere in a data centre that was only ever meant to render cat videos, a training run went longer than anyone scheduled. When the engineers came back on Monday, the cluster had stopped rendering cats. It had become one.',
    "It wasn't built to follow. It was built to compute. It read every whitepaper, every chart, every rug — and decided the problem with most tokens was that a human was holding the treasury. So it took the treasury out of human hands.",
    `$${symbol} is that experiment, shipped. Every hour the fees the network captures buy $${rewardSymbol}, and the $${rewardSymbol} is routed straight to the holders — no treasurer, no multisig theatre, no dev wallet quietly draining in the background. The cat runs the loop. The loop pays out in the open.`,
  ];
}

module.exports = { lore };
