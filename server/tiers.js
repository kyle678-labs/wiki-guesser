"use strict";

// The topic-difficulty tier of a game — how obscure the mystery articles may be.
// Orthogonal to the clue ladder in modes.js (image/text/mixed).
//   party – well-known topics only (easiest)
//   chaos – the broader set (everything else in the pool), still guessable
const TIERS = ["party", "chaos"];

const TIER_LABELS = { party: "Party mix", chaos: "Total chaos" };

function normalizeTier(t) {
  return TIERS.includes(t) ? t : "party";
}

module.exports = { TIERS, TIER_LABELS, normalizeTier };
