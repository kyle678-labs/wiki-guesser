"use strict";

// A ranked ladder is one (clue × topic-tier) pair — e.g. "image:chaos". Ratings
// are keyed by this composite so each pair is rated independently.
//
// ── Why ranked is narrower than the game ─────────────────────────────────────
// Casual and private rooms offer every clue and both tiers. RANKED does not,
// and the reason is population rather than taste:
//
//   • Every ladder splits the same players. 3 clues × 2 tiers was six queues,
//     and a rating ladder is only meaningful if there is somebody close to you
//     waiting in it. Six thin queues produce long waits and lopsided pairings;
//     two give the same players a real chance of a close match.
//   • The party tier is a ~5k-article pool. Over a rated season that is small
//     enough that repeats decide games, which makes the rating a measure of
//     what you have already seen rather than how well you play.
//   • Combined (`mixed`) picks picture or description per round at random, so
//     two players on that ladder are not being measured on the same skill —
//     and the variance lands in the Elo rather than in the scoreboard.
//
// Casual and private rooms are unaffected: mixed and party remain fully
// playable there, which is where experimenting with them belongs.
const { MODE_LABELS, normalizeMode } = require("./modes");
const { TIER_LABELS, normalizeTier } = require("./tiers");

const ladderKey = (clue, tier) => `${normalizeMode(clue)}:${normalizeTier(tier)}`;

// The clue types and tiers a ranked match may use. Everything ranked derives
// from these two lists — the queue guard, /api/config, the leaderboard and the
// per-ladder ratings on an identity — so widening ranked later is an edit here
// and nowhere else.
const RANKED_MODES = ["image", "text"];
const RANKED_TIERS = ["chaos"];

// There is exactly one ranked tier, so a client need not choose. Exported as
// the source of truth rather than letting the browser hardcode "chaos".
const DEFAULT_RANKED_TIER = RANKED_TIERS[0];

// LADDERS is the ranked set, because a ladder IS a ranked thing: casual and
// private games are never recorded, so no other (clue, tier) pair ever holds a
// rating. Anything reading this — identity ratings, getUserRatings, the backup
// drill — wants exactly these.
const LADDERS = [];
for (const clue of RANKED_MODES) for (const tier of RANKED_TIERS) LADDERS.push(ladderKey(clue, tier));

function parseLadder(key) {
  const [clue, tier] = String(key || "").split(":");
  return { clue: normalizeMode(clue), tier: normalizeTier(tier) };
}

// Human label, e.g. "Pictures · Total chaos".
function ladderLabel(key) {
  const { clue, tier } = parseLadder(key);
  return `${MODE_LABELS[clue] || clue} · ${TIER_LABELS[tier] || tier}`;
}

module.exports = {
  ladderKey,
  LADDERS,
  RANKED_MODES,
  RANKED_TIERS,
  DEFAULT_RANKED_TIER,
  parseLadder,
  ladderLabel,
};
