'use strict';

// The site's "Origin Log" — served by GET /token as `lore` (an array of
// paragraphs), for a frontend built from the Cat template, whose Lore.jsx
// renders `token.lore` and nothing else from that endpoint.
//
// EMPTY ON PURPOSE. This project was cloned from Artificial Cat, whose story is
// about a cat ("the cluster had stopped rendering cats. It had become one").
// Serving that on the Artificial Baby Inu site would be worse than serving
// nothing: an empty array renders an empty terminal, a wrong story renders as
// true. Put this project's own paragraphs here when the site has them, and
// restart the API.
//
// The ticker and reward assets are passed in so the copy can name them rather
// than hardcode them — a rename then cannot leave the story stale.

// eslint-disable-next-line no-unused-vars
function lore({ symbol, rewardSymbol }) {
  return [];
}

module.exports = { lore };
