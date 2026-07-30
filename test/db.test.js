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

  const imageChaos = ladderKey("image", "chaos");
  playRanked(imageChaos, a, b); // Ana wins an image·chaos game

  const ana = getUserRatings(a.id);
  const ben = getUserRatings(b.id);
  assert.ok(ana[imageChaos].rating > 1000, "winner's image·chaos rating rises");
  assert.ok(ben[imageChaos].rating < 1000, "loser's image·chaos rating falls");
  assert.equal(ana[imageChaos].wins, 1);
  assert.equal(ben[imageChaos].losses, 1);
  // A different clue on the same tier is untouched…
  assert.equal(ana[ladderKey("text", "chaos")].rating, 1000, "text·chaos ladder unaffected");
  assert.equal(ana[ladderKey("text", "chaos")].games_played, 0);
  // …and so is the SAME clue on a different tier. Asserted through getRating
  // rather than getUserRatings because party is no longer a ranked tier, so it
  // is absent from the latter unless a row exists — the storage key is still
  // composite, which is what this line is actually about.
  assert.equal(getRating(a.id, ladderKey("image", "party")).rating, 1000, "image·party is its own key");
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

// ── Retired ladders ──────────────────────────────────────────────────────────

test("a rating earned on a ladder that is no longer ranked stays visible", () => {
  const c = upsertOAuthUser({ provider: "test", providerId: "retired", displayName: "Cass" });
  const d = upsertOAuthUser({ provider: "test", providerId: "retired2", displayName: "Dee" });

  // Ranked narrowed after launch, so rows like this can exist from before the
  // change. The record must not vanish from the player's own profile just
  // because the ladder was withdrawn - it happened, and it is still in the
  // table. The queue guard in rooms.js is what stops anyone adding to it.
  const retired = ladderKey("mixed", "party");
  playRanked(retired, c, d);

  const cass = getUserRatings(c.id);
  assert.ok(cass[retired], "a stored rating on a retired ladder is still reported");
  assert.ok(cass[retired].rating > 1000, "with the value that was actually earned");
  assert.equal(cass[retired].wins, 1);

  // But retired ladders are never invented for someone who never played one -
  // that would put dead ladders on every profile forever.
  const fresh = upsertOAuthUser({ provider: "test", providerId: "fresh", displayName: "Eve" });
  assert.equal(getUserRatings(fresh.id)[retired], undefined, "no default is fabricated");
  assert.ok(getUserRatings(fresh.id)[ladderKey("image", "chaos")], "current ranked ladders still default in");
});
