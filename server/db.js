"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const config = require("./config");
const { START_RATING } = require("./elo");
const { LADDERS } = require("./ladders");

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(path.join(config.dataDir, "wikiguessr.sqlite"));
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
`);

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
function getUserRatings(userId) {
  const rows = stmts.getRatingsForUser.all(userId);
  const byMode = Object.fromEntries(rows.map((r) => [r.mode, r]));
  const out = {};
  for (const mode of LADDERS) out[mode] = byMode[mode] || getRating(userId, mode);
  return out;
}

const getLeaderboard = (mode, limit = 50) => stmts.leaderboard.all(mode, limit);

// Persist a ranked 1v1 result for a given mode and bump both players' ratings.
// `result` = { mode, a:{id}, b:{id}, aScore, bScore, outcome,
//              aRatingAfter, bRatingAfter, aDelta, bDelta }
const recordRankedMatch = db.transaction((result) => {
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

module.exports = {
  db,
  upsertOAuthUser,
  getUserById,
  getRating,
  getUserRatings,
  getLeaderboard,
  recordRankedMatch,
};
