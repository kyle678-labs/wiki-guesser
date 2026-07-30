"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const config = require("./config");
const log = require("./log");
const { START_RATING } = require("./elo");
const { LADDERS } = require("./ladders");

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(path.join(config.dataDir, "wiki-guesser.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider      TEXT NOT NULL,              -- 'google' | 'discord'
    provider_id   TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    avatar_url    TEXT,
    created_at    INTEGER NOT NULL,
    UNIQUE(provider, provider_id)
  );

  -- One rating row per (user, mode). Rows are created lazily on first ranked game.
  CREATE TABLE IF NOT EXISTS ratings (
    user_id       INTEGER NOT NULL REFERENCES users(id),
    mode          TEXT NOT NULL,              -- 'image' | 'text' | 'mixed'
    rating        INTEGER NOT NULL DEFAULT ${START_RATING},
    games_played  INTEGER NOT NULL DEFAULT 0,
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    draws         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, mode)
  );

  CREATE TABLE IF NOT EXISTS matches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mode          TEXT NOT NULL,
    a_user_id     INTEGER NOT NULL REFERENCES users(id),
    b_user_id     INTEGER NOT NULL REFERENCES users(id),
    a_score       INTEGER NOT NULL,
    b_score       INTEGER NOT NULL,
    a_rating_after INTEGER NOT NULL,
    b_rating_after INTEGER NOT NULL,
    a_delta       INTEGER NOT NULL,
    b_delta       INTEGER NOT NULL,
    outcome       REAL NOT NULL,              -- 1 = A win, 0.5 draw, 0 = B win
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ratings_mode_rating ON ratings(mode, rating DESC);

  -- Both sides are queried: the profile page pulls a player's own history, and
  -- account deletion has to find every match they appear in.
  CREATE INDEX IF NOT EXISTS idx_matches_a ON matches(a_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_matches_b ON matches(b_user_id, created_at DESC);
`);

// ── Migrations ───────────────────────────────────────────────────────────────
// The schema above uses CREATE TABLE IF NOT EXISTS, which does nothing to a
// table that already exists — so anything added after the first deploy has to
// arrive as an explicit ALTER. SQLite has no "ADD COLUMN IF NOT EXISTS".
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// Whether this player wants to see room chat. Stored per account so it follows
// them across devices and games rather than living in one browser's storage.
// Guests get the same setting on their session (see auth.js) — they have no
// account row to hang it on, which is the point of guest play.
if (!hasColumn("users", "chat_enabled")) {
  db.exec("ALTER TABLE users ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 1");
}

if (!hasColumn("users", "last_seen")) {
  db.exec("ALTER TABLE users ADD COLUMN last_seen INTEGER");
  // Existing rows would otherwise read as inactive-since-the-epoch and be swept
  // up by the very first inactivity purge. Their signup date is the best
  // evidence of activity we have retrospectively.
  db.exec("UPDATE users SET last_seen = created_at WHERE last_seen IS NULL");
}

const stmts = {
  findUser: db.prepare("SELECT * FROM users WHERE provider = ? AND provider_id = ?"),
  getUser: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser: db.prepare(`
    INSERT INTO users (provider, provider_id, display_name, avatar_url, created_at)
    VALUES (@provider, @provider_id, @display_name, @avatar_url, @created_at)
  `),
  touchUser: db.prepare("UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?"),
  getRating: db.prepare("SELECT * FROM ratings WHERE user_id = ? AND mode = ?"),
  getRatingsForUser: db.prepare("SELECT * FROM ratings WHERE user_id = ?"),
  upsertRating: db.prepare(`
    INSERT INTO ratings (user_id, mode, rating, games_played, wins, losses, draws)
    VALUES (@user_id, @mode, @rating, 1, @win, @loss, @draw)
    ON CONFLICT(user_id, mode) DO UPDATE SET
      rating = @rating,
      games_played = games_played + 1,
      wins = wins + @win,
      losses = losses + @loss,
      draws = draws + @draw
  `),
  insertMatch: db.prepare(`
    INSERT INTO matches
      (mode, a_user_id, b_user_id, a_score, b_score, a_rating_after, b_rating_after,
       a_delta, b_delta, outcome, created_at)
    VALUES
      (@mode, @a_user_id, @b_user_id, @a_score, @b_score, @a_rating_after, @b_rating_after,
       @a_delta, @b_delta, @outcome, @created_at)
  `),
  leaderboard: db.prepare(`
    SELECT u.id, u.display_name, u.avatar_url,
           r.rating, r.games_played, r.wins, r.losses, r.draws
      FROM ratings r
      JOIN users u ON u.id = r.user_id
     WHERE r.mode = ? AND r.games_played > 0
     ORDER BY r.rating DESC, r.wins DESC
     LIMIT ?
  `),
  touchSeen: db.prepare("UPDATE users SET last_seen = @now WHERE id = @id"),
  setChatEnabled: db.prepare("UPDATE users SET chat_enabled = @on WHERE id = @id"),
  // A match row stores the two players as A and B in the order the room happened
  // to hold them, so every per-player figure has to be un-swapped against the
  // viewer. Doing it in SQL keeps the caller from having to know that.
  recentMatches: db.prepare(`
    SELECT m.id, m.mode, m.created_at,
           CASE WHEN m.a_user_id = @uid THEN m.a_score        ELSE m.b_score        END AS my_score,
           CASE WHEN m.a_user_id = @uid THEN m.b_score        ELSE m.a_score        END AS their_score,
           CASE WHEN m.a_user_id = @uid THEN m.a_delta        ELSE m.b_delta        END AS my_delta,
           CASE WHEN m.a_user_id = @uid THEN m.a_rating_after ELSE m.b_rating_after END AS my_rating_after,
           CASE WHEN m.a_user_id = @uid THEN m.outcome        ELSE 1 - m.outcome    END AS my_outcome,
           o.display_name AS opponent_name,
           o.avatar_url   AS opponent_avatar
      FROM matches m
      JOIN users o ON o.id = CASE WHEN m.a_user_id = @uid THEN m.b_user_id ELSE m.a_user_id END
     WHERE m.a_user_id = @uid OR m.b_user_id = @uid
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT @limit
  `),
  deleteRatings: db.prepare("DELETE FROM ratings WHERE user_id = ?"),
  deleteMatches: db.prepare("DELETE FROM matches WHERE a_user_id = ? OR b_user_id = ?"),
  deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
  findInactive: db.prepare("SELECT id, display_name, last_seen FROM users WHERE COALESCE(last_seen, created_at) < ?"),
};

// Find-or-create a user from an OAuth profile.
function upsertOAuthUser({ provider, providerId, displayName, avatarUrl }) {
  const existing = stmts.findUser.get(provider, providerId);
  if (existing) {
    if (existing.display_name !== displayName || existing.avatar_url !== avatarUrl) {
      stmts.touchUser.run(displayName, avatarUrl || null, existing.id);
    }
    return stmts.getUser.get(existing.id);
  }
  const info = stmts.insertUser.run({
    provider,
    provider_id: providerId,
    display_name: displayName,
    avatar_url: avatarUrl || null,
    created_at: Date.now(),
  });
  return stmts.getUser.get(info.lastInsertRowid);
}

const getUserById = (id) => stmts.getUser.get(id);

// Rating row for a user+mode, or a default (unplayed) shape.
function getRating(userId, mode) {
  return (
    stmts.getRating.get(userId, mode) || {
      user_id: userId,
      mode,
      rating: START_RATING,
      games_played: 0,
      wins: 0,
      losses: 0,
      draws: 0,
    }
  );
}

// Every ladder (clue × tier) for a user, filling in defaults for unplayed ones.
//
// Two sources, and the second one matters more than it looks. Ranked narrowed
// after launch (see server/ladders.js), so a rating can legitimately exist on a
// ladder that is no longer rankable. Building this purely from LADDERS would
// make such a rating disappear from the player's own profile — the record would
// still be in the database, just invisible, which is the worst of both. Keep
// showing what was earned; the queue guard is what stops anyone adding to it.
function getUserRatings(userId) {
  const rows = stmts.getRatingsForUser.all(userId);
  const byMode = Object.fromEntries(rows.map((r) => [r.mode, r]));
  const out = {};
  // Every current ranked ladder, so an unplayed one still has a starting
  // rating for matchmaking to pair on.
  for (const mode of LADDERS) out[mode] = byMode[mode] || getRating(userId, mode);
  // Plus anything actually stored on a retired ladder. Never defaults: an
  // unplayed retired ladder is not a thing worth inventing a 1000 for.
  for (const [mode, row] of Object.entries(byMode)) if (!(mode in out)) out[mode] = row;
  return out;
}

// The leaderboard is rendered on the landing page, so this query scales with
// total visitors rather than with concurrent players — a traffic spike would
// otherwise put one synchronous SQLite read on the event loop per page view.
//
// Cached with a short TTL *and* invalidated on write, so it never actually
// serves a stale ladder: recordRankedMatch is the only thing that changes
// ratings, and it clears the cache. The TTL is just a backstop for out-of-band
// writes (e.g. scripts/migrate-ratings-to-tiers.js against a live database).
const LEADERBOARD_TTL_MS = parseInt(process.env.LEADERBOARD_TTL_MS, 10) || 30000;
const leaderboardCache = new Map(); // "mode:limit" -> { at, rows }

function getLeaderboard(mode, limit = 50) {
  const key = `${mode}:${limit}`;
  const hit = leaderboardCache.get(key);
  if (hit && Date.now() - hit.at < LEADERBOARD_TTL_MS) return hit.rows;
  // Callers only ever map over this, never mutate it, so the array is shared.
  const rows = stmts.leaderboard.all(mode, limit);
  leaderboardCache.set(key, { at: Date.now(), rows });
  return rows;
}

// Persist a ranked 1v1 result for a given mode and bump both players' ratings.
// `result` = { mode, a:{id}, b:{id}, aScore, bScore, outcome,
//              aRatingAfter, bRatingAfter, aDelta, bDelta }
const recordRankedMatchTx = db.transaction((result) => {
  const o = result.outcome; // from A's perspective: 1 A-win, 0 B-win, 0.5 draw
  stmts.upsertRating.run({
    user_id: result.a.id,
    mode: result.mode,
    rating: result.aRatingAfter,
    win: o === 1 ? 1 : 0,
    loss: o === 0 ? 1 : 0,
    draw: o === 0.5 ? 1 : 0,
  });
  stmts.upsertRating.run({
    user_id: result.b.id,
    mode: result.mode,
    rating: result.bRatingAfter,
    win: o === 0 ? 1 : 0,
    loss: o === 1 ? 1 : 0,
    draw: o === 0.5 ? 1 : 0,
  });
  stmts.insertMatch.run({
    mode: result.mode,
    a_user_id: result.a.id,
    b_user_id: result.b.id,
    a_score: result.aScore,
    b_score: result.bScore,
    a_rating_after: result.aRatingAfter,
    b_rating_after: result.bRatingAfter,
    a_delta: result.aDelta,
    b_delta: result.bDelta,
    outcome: result.outcome,
    created_at: Date.now(),
  });
});

// Ratings just moved, so any cached ladder is now wrong. Clearing here is what
// lets getLeaderboard cache aggressively without ever showing a stale result.
function recordRankedMatch(result) {
  recordRankedMatchTx(result);
  leaderboardCache.clear();
}

// ── Activity tracking ────────────────────────────────────────────────────────
// last_seen is what the inactivity purge measures against, so it has to be
// touched on ordinary use — but the natural call site (resolving an identity)
// runs on every page load and every socket connect, and a write per page view
// is write amplification for a field whose resolution only needs to be "this
// month". Throttle in memory: one write per user per hour, at most.
const TOUCH_THROTTLE_MS = 60 * 60 * 1000;
const lastTouched = new Map(); // userId -> ms

// Once an entry is older than the throttle window it can never suppress a write
// again — it is pure overhead, and nothing removed it, so the map grew with
// every distinct player the process had ever seen and only ever shrank when
// somebody deleted their account.
//
// Swept on write rather than on a timer: the map only grows on activity, so the
// cleanup happens exactly when it is needed and an idle server does no work at
// all. Deleting from a Map while iterating it is well-defined.
//
// BOTH guards are load-bearing. Size alone is not enough: a map that is large
// but entirely fresh — which is simply what a busy server looks like — sweeps,
// deletes nothing, and then sweeps again on the very next call, turning every
// page load into an O(n) walk. That is a worse problem than the leak, and it
// arrives precisely under the load where it hurts. The interval caps the scan
// at once per five minutes however busy things get.
//
// Note what this does NOT do: it never evicts a fresh entry. The map still
// holds one entry per user active in the last hour, because those are the ones
// doing their job. Bounding it to the live working set is the whole fix.
const TOUCH_SWEEP_AT = parseInt(process.env.TOUCH_SWEEP_AT, 10) || 10000;
const TOUCH_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweptAt = 0;

function sweepTouched(now) {
  for (const [id, at] of lastTouched) {
    if (now - at >= TOUCH_THROTTLE_MS) lastTouched.delete(id);
  }
  lastSweptAt = now;
}

function touchSeen(userId) {
  const now = Date.now();
  const prev = lastTouched.get(userId);
  if (prev && now - prev < TOUCH_THROTTLE_MS) return;
  if (lastTouched.size >= TOUCH_SWEEP_AT && now - lastSweptAt >= TOUCH_SWEEP_INTERVAL_MS) {
    sweepTouched(now);
  }
  lastTouched.set(userId, now);
  try {
    stmts.touchSeen.run({ id: userId, now });
  } catch (err) {
    // Never let bookkeeping break a sign-in or a socket handshake.
    log.warn("touch_seen_failed", { userId, err });
  }
}

// Persist a player's "show me chat" preference. SQLite has no boolean type, so
// it is stored as 0/1 and read back through a !== 0 comparison everywhere.
function setChatEnabled(userId, enabled) {
  stmts.setChatEnabled.run({ id: userId, on: enabled ? 1 : 0 });
}

// ── Profile ──────────────────────────────────────────────────────────────────
// The player's own recent ranked games, newest first. Casual and private games
// are not recorded at all, so this is the complete history that exists.
function getRecentMatches(userId, limit = 10) {
  return stmts.recentMatches.all({ uid: userId, limit }).map((m) => ({
    id: m.id,
    mode: m.mode,
    at: m.created_at,
    myScore: m.my_score,
    theirScore: m.their_score,
    delta: m.my_delta,
    ratingAfter: m.my_rating_after,
    result: m.my_outcome === 1 ? "win" : m.my_outcome === 0 ? "loss" : "draw",
    opponent: m.opponent_name,
    opponentAvatar: m.opponent_avatar,
  }));
}

// ── Erasure ──────────────────────────────────────────────────────────────────
// Everything we hold about one account, gone in one transaction: the profile
// row, every ladder rating, and every match they played.
//
// Deleting the match rows removes them from the OPPONENT's history too. That is
// the deliberate choice — a match row names both players, so keeping it would
// mean retaining a deleted user's game record against their request. Nobody's
// standing changes as a result: ratings and win/loss counters live in `ratings`
// and are never recomputed from `matches`.
//
// Sessions are not touched here. deserializeUser resolves a missing user to
// `false`, so any session still pointing at this id simply stops being signed
// in — there is no orphaned-session state to clean up.
const deleteAccountTx = db.transaction((userId) => {
  // Order matters: `ratings` and `matches` both carry a foreign key onto
  // `users`, and foreign_keys is ON.
  const matches = stmts.deleteMatches.run(userId, userId).changes;
  const ratings = stmts.deleteRatings.run(userId).changes;
  const users = stmts.deleteUser.run(userId).changes;
  return { matches, ratings, deleted: users > 0 };
});

function deleteAccount(userId) {
  const res = deleteAccountTx(userId);
  lastTouched.delete(userId);
  // Their rows may have been on a ladder we're caching.
  leaderboardCache.clear();
  return res;
}

// Erase accounts dormant longer than `months`. Returns what it removed so the
// caller can log it — a job that silently deletes user data is not one you want
// running unattended.
function purgeInactiveAccounts(months = 24) {
  const cutoff = Date.now() - months * 30.44 * 24 * 60 * 60 * 1000;
  const stale = stmts.findInactive.all(cutoff);
  let matches = 0;
  for (const u of stale) {
    matches += deleteAccount(u.id).matches;
  }
  return { accounts: stale.length, matches, cutoff };
}

module.exports = {
  db,
  upsertOAuthUser,
  getUserById,
  getRating,
  getUserRatings,
  getLeaderboard,
  recordRankedMatch,
  touchSeen,
  setChatEnabled,
  getRecentMatches,
  deleteAccount,
  purgeInactiveAccounts,
  // Exported for tests. The activity map is internal state that no query or
  // response reveals, so a leak in it is invisible from the outside — and
  // sweepTouched takes `now` as an argument precisely so a test can advance the
  // clock past the throttle window without mocking timers.
  sweepTouched,
  touchedSize: () => lastTouched.size,
};
