"use strict";

// Classic Elo rating. New players start at START_RATING.
const START_RATING = 1000;

// Provisional players (few games) move faster; settled players move slower.
function kFactor(gamesPlayed, rating) {
  if (gamesPlayed < 10) return 40;
  if (rating >= 2100) return 16;
  return 24;
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// outcome: 1 = A wins, 0 = B wins, 0.5 = draw.
// Returns the new ratings and the delta applied to A.
function updatePair(a, b, outcome) {
  const expA = expectedScore(a.rating, b.rating);
  const expB = 1 - expA;
  const kA = kFactor(a.gamesPlayed, a.rating);
  const kB = kFactor(b.gamesPlayed, b.rating);
  const deltaA = Math.round(kA * (outcome - expA));
  const deltaB = Math.round(kB * (1 - outcome - expB));
  return {
    aRating: a.rating + deltaA,
    bRating: b.rating + deltaB,
    aDelta: deltaA,
    bDelta: deltaB,
  };
}

// Named rank tiers for display.
const TIERS = [
  { min: 0, name: "Bronze", icon: "🥉" },
  { min: 900, name: "Silver", icon: "🥈" },
  { min: 1100, name: "Gold", icon: "🥇" },
  { min: 1300, name: "Platinum", icon: "💠" },
  { min: 1500, name: "Diamond", icon: "💎" },
  { min: 1750, name: "Master", icon: "🔮" },
  { min: 2000, name: "Grandmaster", icon: "👑" },
];

function tierFor(rating) {
  let t = TIERS[0];
  for (const tier of TIERS) if (rating >= tier.min) t = tier;
  return t;
}

module.exports = { START_RATING, expectedScore, updatePair, tierFor, TIERS };
