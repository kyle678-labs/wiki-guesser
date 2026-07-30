"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

// Env before requiring the DB (config reads it at require time).
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = helpers.tempDataDir();

const {
  upsertOAuthUser,
  getRating,
  getUserRatings,
  recordRankedMatch,
  getLeaderboard,
  touchSeen,
  sweepTouched,
  touchedSize,
} = require("../server/db");
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

test("the leaderboard is cached, and a new result invalidates it", () => {
  const e = upsertOAuthUser({ provider: "test", providerId: "e", displayName: "Eve" });
  const f = upsertOAuthUser({ provider: "test", providerId: "f", displayName: "Fay" });
  const mode = ladderKey("image", "party");

  playRanked(mode, e, f);
  const first = getLeaderboard(mode, 10);
  // Same array instance ⇒ served from cache rather than re-queried. This is
  // what keeps the landing page off the event loop under traffic.
  assert.equal(getLeaderboard(mode, 10), first, "a repeat read is cached");

  const eRatingBefore = first.find((r) => r.id === e.id).rating;

  // Recording a match must drop the cache, or the ladder would show stale
  // ratings for up to the TTL — the failure a pure time-based cache would have.
  playRanked(mode, f, e);
  const second = getLeaderboard(mode, 10);
  assert.notEqual(second, first, "a new result invalidates the cache");
  assert.notEqual(
    second.find((r) => r.id === e.id).rating,
    eRatingBefore,
    "the fresh read reflects the rating that just changed"
  );
});

// ── Activity map ─────────────────────────────────────────────────────────────
// touchSeen throttles last_seen writes through an in-memory map, which used to
// keep one entry per user the process had EVER seen. Nothing about that is
// visible from a query or a response, so it has to be measured directly.

test("the activity map drops entries the throttle window has expired", () => {
  const before = touchedSize();
  const users = [];
  for (let i = 0; i < 25; i++) {
    users.push(upsertOAuthUser({ provider: "sweep", providerId: `sweep-${i}`, displayName: `Sweep ${i}` }));
  }
  for (const u of users) touchSeen(u.id);
  assert.equal(touchedSize(), before + 25, "each user should hold one entry while it is fresh");

  // A sweep at the current time must keep everything: these entries are all
  // doing their job, and evicting them would restore the write-per-page-view
  // amplification the throttle exists to prevent.
  sweepTouched(Date.now());
  assert.equal(touchedSize(), before + 25, "fresh entries must survive a sweep");

  // Advance past the throttle window. Now they can never suppress a write
  // again, so they are pure overhead and must go.
  sweepTouched(Date.now() + 60 * 60 * 1000 + 1);
  assert.equal(touchedSize(), 0, "expired entries must be released");
});

test("a swept user is touched again rather than being silently skipped", () => {
  const u = upsertOAuthUser({ provider: "sweep", providerId: "sweep-revisit", displayName: "Revisit" });
  touchSeen(u.id);
  sweepTouched(Date.now() + 60 * 60 * 1000 + 1);
  assert.equal(touchedSize(), 0);

  // The point of the map is throttling, not correctness: losing an entry must
  // cost an extra write, never a missed one. A user whose entry was swept has
  // to be re-registered on their next visit or the inactivity purge would
  // eventually delete an active account.
  touchSeen(u.id);
  assert.equal(touchedSize(), 1, "a returning user re-enters the map");
});
