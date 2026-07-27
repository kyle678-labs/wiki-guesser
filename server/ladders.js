"use strict";

// A ranked ladder is one (clue × topic-tier) pair — e.g. "image:chaos". Ratings
// are keyed by this composite so each difficulty tier is its own ladder, giving
// clue count × tier count = up to 9 independent ladders.
const { MODES, MODE_LABELS, normalizeMode } = require("./modes");
const { TIERS, TIER_LABELS, normalizeTier } = require("./tiers");

const ladderKey = (clue, tier) => `${normalizeMode(clue)}:${normalizeTier(tier)}`;

const LADDERS = [];
for (const clue of MODES) for (const tier of TIERS) LADDERS.push(ladderKey(clue, tier));

function parseLadder(key) {
  const [clue, tier] = String(key || "").split(":");
  return { clue: normalizeMode(clue), tier: normalizeTier(tier) };
}

// Human label, e.g. "Pictures · Total chaos".
function ladderLabel(key) {
  const { clue, tier } = parseLadder(key);
  return `${MODE_LABELS[clue] || clue} · ${TIER_LABELS[tier] || tier}`;
}

module.exports = { ladderKey, LADDERS, parseLadder, ladderLabel };
