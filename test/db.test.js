"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

// Env before requiring the DB (config reads it at require time).
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = helpers.tempDataDir();

const { upsertOAuthUser, getRating, getUserRatings, recordRankedMatch, getLeaderboard } = require("../server/db");
const { updatePair } = require("../server/elo");
const { ladderKey } = require("../server/ladders");

function playRanked(mode, winner, loser) {
  const rw = getRating(winner.id, mode);
  const rl = getRating(loser.id, mode);
  const res = updatePair(
    { rating: rw.rating, gamesPlayed: rw.games_played },
    { rating: rl.rating, gamesPlayed: rl.games_played },
    1
  );
  recordRankedMatch({
    mode,
    a: { id: winner.id },
    b: { id: loser.id },
    aScore: 100,
    bScore: 50,
    outcome: 1,
    aRatingAfter: res.aRating,
    bRatingAfter: res.bRating,
    aDelta: res.aDelta,
    bDelta: res.bDelta,
  });
}

test("ratings and records are tracked per ladder (clue × tier) independently", () => {
  const a = upsertOAuthUser({ provider: "test", providerId: "a", displayName: "Ana" });
  const b = upsertOAuthUser({ provider: "test", providerId: "b", displayName: "Ben" });

  const imageParty = ladderKey("image", "party");
  playRanked(imageParty, a, b); // Ana wins an image·party game

  const ana = getUserRatings(a.id);
  const ben = getUserRatings(b.id);
  assert.ok(ana[imageParty].rating > 1000, "winner's image·party rating rises");
  assert.ok(ben[imageParty].rating < 1000, "loser's image·party rating falls");
  assert.equal(ana[imageParty].wins, 1);
  assert.equal(ben[imageParty].losses, 1);
  // A different clue is untouched…
  assert.equal(ana[ladderKey("text", "party")].rating, 1000, "text·party ladder unaffected");
  // …and so is the SAME clue on a different tier (the point of per-tier ladders).
  assert.equal(ana[ladderKey("image", "chaos")].rating, 1000, "image·chaos is its own ladder");
  assert.equal(ana[ladderKey("image", "chaos")].games_played, 0);
});

test("leaderboard is per ladder and only lists players with games", () => {
  const c = upsertOAuthUser({ provider: "test", providerId: "c", displayName: "Cid" });
  const d = upsertOAuthUser({ provider: "test", providerId: "d", displayName: "Dot" });

  playRanked(ladderKey("mixed", "chaos"), c, d); // only a mixed·chaos game

  const board = getLeaderboard(ladderKey("mixed", "chaos"), 10);
  assert.ok(board.some((r) => r.id === c.id), "Cid appears on the mixed·chaos board");
  assert.equal(board[0].id, c.id, "winner ranks first");

  // Same clue, different tier → separate, empty board.
  const mixedParty = getLeaderboard(ladderKey("mixed", "party"), 10);
  assert.ok(!mixedParty.some((r) => r.id === c.id), "absent from mixed·party (no games there)");
});
