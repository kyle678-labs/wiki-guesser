"use strict";

// The profile panel and self-service account deletion, plus the inactivity
// sweep that backs the retention promise in public/privacy.html.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

// Env before requiring the DB (config reads it at require time).
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = helpers.tempDataDir();

const {
  db,
  upsertOAuthUser,
  getRating,
  getUserRatings,
  recordRankedMatch,
  getRecentMatches,
  deleteAccount,
  purgeInactiveAccounts,
  touchSeen,
} = require("../server/db");
const { updatePair } = require("../server/elo");
const { ladderKey } = require("../server/ladders");

const MODE = ladderKey("image", "chaos");
let seq = 0;
const newUser = (name) => upsertOAuthUser({ provider: "test", providerId: `${name}-${seq++}`, displayName: name });

// Play one ranked game, `a` winning unless `outcome` says otherwise.
function playRanked(winner, loser, { mode = MODE, outcome = 1, aScore = 100, bScore = 50 } = {}) {
  const rw = getRating(winner.id, mode);
  const rl = getRating(loser.id, mode);
  const res = updatePair(
    { rating: rw.rating, gamesPlayed: rw.games_played },
    { rating: rl.rating, gamesPlayed: rl.games_played },
    outcome
  );
  recordRankedMatch({
    mode,
    a: { id: winner.id },
    b: { id: loser.id },
    aScore,
    bScore,
    outcome,
    aRatingAfter: res.aRating,
    bRatingAfter: res.bRating,
    aDelta: res.aDelta,
    bDelta: res.bDelta,
  });
}

test("match history is reported from the viewer's side, whichever slot they were in", () => {
  const ana = newUser("Ana");
  const ben = newUser("Ben");

  playRanked(ana, ben, { aScore: 120, bScore: 80 }); // Ana is slot A and wins
  playRanked(ben, ana, { aScore: 140, bScore: 60 }); // Ana is slot B and loses

  const [latest, earlier] = getRecentMatches(ana.id, 10);

  // The row stores A and B in room order; the profile must un-swap both.
  assert.equal(earlier.result, "win");
  assert.equal(earlier.opponent, "Ben");
  assert.equal(earlier.myScore, 120);
  assert.equal(earlier.theirScore, 80);
  assert.ok(earlier.delta > 0, "a win shows a positive delta");

  assert.equal(latest.result, "loss");
  assert.equal(latest.opponent, "Ben");
  assert.equal(latest.myScore, 60, "the viewer's score, not slot A's");
  assert.equal(latest.theirScore, 140);
  assert.ok(latest.delta < 0, "a loss shows a negative delta");
});

test("a draw reads as a draw from both sides", () => {
  const cid = newUser("Cid");
  const dot = newUser("Dot");
  playRanked(cid, dot, { outcome: 0.5, aScore: 90, bScore: 90 });

  assert.equal(getRecentMatches(cid.id, 10)[0].result, "draw");
  assert.equal(getRecentMatches(dot.id, 10)[0].result, "draw");
});

test("history is capped at the requested limit, newest first", () => {
  const eve = newUser("Eve");
  const fay = newUser("Fay");
  for (let i = 0; i < 14; i++) playRanked(eve, fay, { aScore: 100 + i, bScore: 10 });

  const rows = getRecentMatches(eve.id, 10);
  assert.equal(rows.length, 10, "limit is honoured");
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].id >= rows[i].id, "ordered newest first");
  }
});

test("deleting an account erases the profile, every rating, and every match", () => {
  const gus = newUser("Gus");
  const hal = newUser("Hal");
  playRanked(gus, hal);
  playRanked(gus, hal, { mode: ladderKey("text", "chaos") });

  assert.equal(getRecentMatches(gus.id, 10).length, 2);
  const res = deleteAccount(gus.id);

  assert.equal(res.deleted, true);
  assert.equal(res.matches, 2, "both match rows removed");
  assert.equal(res.ratings, 2, "both ladder ratings removed");
  assert.equal(db.prepare("SELECT * FROM users WHERE id = ?").get(gus.id), undefined, "profile row gone");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ratings WHERE user_id = ?").get(gus.id).n, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM matches WHERE a_user_id = ? OR b_user_id = ?").get(gus.id, gus.id).n,
    0
  );
});

test("deleting an account leaves the opponent's standing intact", () => {
  const ivy = newUser("Ivy");
  const jon = newUser("Jon");
  playRanked(jon, ivy); // Jon wins

  const jonBefore = getUserRatings(jon.id)[MODE];
  deleteAccount(ivy.id);
  const jonAfter = getUserRatings(jon.id)[MODE];

  // Ratings live in their own table and are never recomputed from `matches`, so
  // the opponent's ladder position survives — only the shared match row goes.
  assert.equal(jonAfter.rating, jonBefore.rating, "rating unchanged");
  assert.equal(jonAfter.wins, jonBefore.wins, "win count unchanged");
  assert.equal(getRecentMatches(jon.id, 10).length, 0, "the shared match row is gone from both histories");
});

test("the inactivity sweep deletes dormant accounts and spares active ones", () => {
  const old = newUser("Rip");
  const active = newUser("Nia");
  playRanked(old, active);

  const threeYearsAgo = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
  db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(threeYearsAgo, old.id);
  touchSeen(active.id);

  const res = purgeInactiveAccounts(24);

  assert.ok(res.accounts >= 1, "the dormant account was swept");
  assert.equal(db.prepare("SELECT * FROM users WHERE id = ?").get(old.id), undefined, "dormant account deleted");
  assert.ok(db.prepare("SELECT * FROM users WHERE id = ?").get(active.id), "active account kept");
});

test("the sweep is idempotent — a second run finds nothing", () => {
  purgeInactiveAccounts(24);
  assert.equal(purgeInactiveAccounts(24).accounts, 0, "nothing left to purge");
});

// ── HTTP surface ─────────────────────────────────────────────────────────────
// The endpoints behind the profile panel. Guests reach both — they have a
// session but no account — so each has to answer sensibly for them too.
test("the profile endpoint refuses anonymous callers and tells guests they have no account", async () => {
  const ctx = await helpers.startTestServer();
  try {
    const anon = await helpers.get(ctx.port, "/api/profile");
    assert.equal(anon.status, 401, "no session at all → 401");

    const guest = await helpers.guestSession(ctx.port, "Wanderer");
    const res = await helpers.get(ctx.port, "/api/profile", guest.cookie);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.guest, true);
    assert.deepEqual(body.matches, [], "guests have no recorded games");
  } finally {
    await ctx.close();
  }
});

test("account deletion rejects guests and unconfirmed requests", async () => {
  const ctx = await helpers.startTestServer();
  try {
    const anon = await helpers.postJson(ctx.port, "/api/account/delete", { confirm: "DELETE" });
    assert.equal(anon.status, 401, "not signed in");

    const guest = await helpers.guestSession(ctx.port, "Nomad");
    const asGuest = await helpers.postJson(ctx.port, "/api/account/delete", { confirm: "DELETE" }, guest.cookie);
    assert.equal(asGuest.status, 400, "a guest session holds no account to delete");
    assert.match(JSON.parse(asGuest.body).error, /guest/i);
  } finally {
    await ctx.close();
  }
});

test("signing in resets the inactivity clock", () => {
  const kim = newUser("Kim");
  db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(0, kim.id);

  // touchSeen throttles to one write per user per hour, but a user it has never
  // seen in this process must always write — otherwise a returning player could
  // be swept while actively playing.
  touchSeen(kim.id);

  assert.equal(purgeInactiveAccounts(24).accounts, 0, "the touched account is no longer dormant");
  assert.ok(db.prepare("SELECT * FROM users WHERE id = ?").get(kim.id), "still there");
});
