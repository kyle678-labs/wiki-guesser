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

  -- Daily puzzle results. Deliberately NOT joined to users: guests play the
  -- dailies too, and a daily board is a scoreboard for one day rather than a
  -- record attached to an account. The identity column holds the session
  -- identity id ("u12" for an account, "g_…" for a guest) and exists only to
  -- enforce one entry per player per day; the name is copied in, because the
  -- board has to keep reading correctly after that name changes, or after the
  -- account behind it is gone.
  --
  -- (No backticks in this comment on purpose — the whole schema is one
  -- template literal, and a stray one ends it mid-statement.)
  --
  -- Convention across every daily game: LOWER score is better, and a tie goes
  -- to whoever got there first — created_at, not a second measurement.
  --
  -- What a score COUNTS is the game's business, and the two kinds are stored in
  -- the same column on purpose: both are integers, both sort the same way, and
  -- a board only ever reads one game at a time. server/dailies.js publishes the
  -- format alongside the rows so nothing has to infer it from the number.
  --
  --   wikidle        guesses taken; 1 = first try
  --   tiles, match   milliseconds to solve
  --
  -- Wikidle is deliberately untimed: a word puzzle scored on the clock rewards
  -- typing speed as much as working the clue out. The picture games are the
  -- other case — they are puzzles you can always finish, so "how fast" is the
  -- only question left worth asking. The trade is that a timed puzzle can be
  -- scouted, and is.
  CREATE TABLE IF NOT EXISTS daily_scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    day         TEXT NOT NULL,              -- "YYYY-MM-DD", always UTC
    game        TEXT NOT NULL,              -- 'wikidle' | 'tiles' | 'match'
    identity    TEXT NOT NULL,
    name        TEXT NOT NULL,
    score       INTEGER NOT NULL,           -- guesses, or milliseconds — see above
    created_at  INTEGER NOT NULL,           -- also the tie-break
    UNIQUE(day, game, identity)
  );

  -- A chat message somebody reported, held as a work item for the moderation
  -- queue at /admin. Until this table existed a report went to the application
  -- log and nowhere else, which told an operator that something happened but
  -- gave them nothing to act on and no way to mark it dealt with.
  --
  -- Deliberately NOT joined to users, for the same reason daily_scores is not:
  -- guests both send and report messages, and a report has to keep reading
  -- correctly after a display name changes or the account behind it is deleted.
  -- The identity columns hold the session identity ("u12" or "g_..."); the
  -- *_user_id columns are the numeric account id where there is one, and NULL
  -- for a guest — which is also what says whether there is anything to ban.
  --
  -- The message text is copied in rather than referenced. Chat is never
  -- otherwise written to disk (see public/privacy.html), so this row IS the
  -- message, and the surrounding conversation is deliberately not captured.
  --
  -- UNIQUE is the one-report-per-person-per-message rule. Room.reportChat also
  -- refuses a duplicate in memory, but a room lives and dies with the process
  -- and this constraint does not.
  CREATE TABLE IF NOT EXISTS chat_reports (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        INTEGER NOT NULL,
    room_code         TEXT NOT NULL,
    ranked            INTEGER NOT NULL DEFAULT 0,
    is_private        INTEGER NOT NULL DEFAULT 0,
    message_id        TEXT NOT NULL,
    message_at        INTEGER NOT NULL,
    message_text      TEXT NOT NULL,
    author_identity   TEXT NOT NULL,
    author_user_id    INTEGER,
    author_name       TEXT NOT NULL,
    reporter_identity TEXT NOT NULL,
    reporter_user_id  INTEGER,
    reporter_name     TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open',   -- open | actioned | dismissed
    resolved_at       INTEGER,
    resolved_by       INTEGER,
    note              TEXT,
    UNIQUE(room_code, message_id, reporter_identity)
  );

  -- One row per banned account, keyed by the account: a ban is a current state
  -- rather than a history, so re-banning someone replaces their row instead of
  -- stacking. expires_at NULL is permanent; a row whose expiry has passed stays
  -- put until the retention sweep, so an operator can still see it happened.
  --
  -- Only accounts can be banned. A guest identity is a cookie — banning one
  -- would be theatre, since the next guest session is a fresh id. That is the
  -- honest limit of this feature and the admin UI says so where it applies.
  CREATE TABLE IF NOT EXISTS bans (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id),
    reason      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    created_by  INTEGER
  );

  -- Site notices: a short message an operator pins from /admin, shown to every
  -- visitor as a dismissible card in the corner of the page.
  --
  -- Deliberately not addressed to anyone. There is no recipient column and no
  -- read receipts: this is a notice board, not a messaging system, and the
  -- moment it grows a "to" it becomes something that needs a privacy policy
  -- entry and a deletion path. What is stored is a sentence somebody typed.
  --
  -- expires_at NULL means "until it is unpinned", which is a DELETE — there is
  -- no archive worth keeping of a message that said the server would be down on
  -- Tuesday.
  CREATE TABLE IF NOT EXISTS notices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message    TEXT NOT NULL,
    level      TEXT NOT NULL DEFAULT 'info',   -- info | warn
    created_at INTEGER NOT NULL,
    created_by INTEGER,
    expires_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_ratings_mode_rating ON ratings(mode, rating DESC);

  -- The queue is read newest-first within a status, and swept by age.
  CREATE INDEX IF NOT EXISTS idx_reports_queue ON chat_reports(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_age ON chat_reports(created_at);
  -- "What else has this player been reported for" is the question an operator
  -- asks before acting on any single report.
  CREATE INDEX IF NOT EXISTS idx_reports_author ON chat_reports(author_user_id);

  -- Exactly the shape the board is read in: one day, one game, best first,
  -- earliest solver ahead on a tie.
  CREATE INDEX IF NOT EXISTS idx_daily_board ON daily_scores(day, game, score, created_at);
  -- Account erasure has to find a player's rows by identity, and the retention
  -- sweep has to find every row older than a cutoff.
  CREATE INDEX IF NOT EXISTS idx_daily_identity ON daily_scores(identity);
  CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_scores(day);

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

// Wikidle shipped scoring by WORDS REVEALED with the solve time as the
// tie-break. It now scores by GUESSES TAKEN, and a tie goes to whoever solved
// it first. Rows written under the old rule have to be converted, or one day's
// board would sort two different measurements against each other and quietly
// rank a worse solve above a better one.
//
// The offset is hardcoded at 3 on purpose. Old score = START_WORDS(4) +
// wrongGuesses, and guesses = wrongGuesses + 1, so guesses = score - 3. A
// migration records what the data meant when it was written; if START_WORDS
// ever changes, this arithmetic must not follow it.
//
// Order matters: `ms` is a column of idx_daily_board, and SQLite refuses to
// DROP COLUMN while an index still references it. The CREATE at the end is what
// actually installs the new definition — the CREATE INDEX IF NOT EXISTS in the
// schema above is a no-op on a database that already has the old index.
if (hasColumn("daily_scores", "ms")) {
  db.exec(`
    DROP INDEX IF EXISTS idx_daily_board;
    UPDATE daily_scores SET score = score - 3 WHERE game = 'wikidle' AND score > 3;
    ALTER TABLE daily_scores DROP COLUMN ms;
    CREATE INDEX IF NOT EXISTS idx_daily_board ON daily_scores(day, game, score, created_at);
  `);
}

// The picture games shipped scoring by MOVES for the length of one branch and
// then changed to the clock. Nothing in production ever wrote a move count —
// they had not been released — so on the live database this matches nothing and
// is a no-op. It exists for the boxes that did run that build: a dev machine, a
// staging box, a reviewer's checkout.
//
// Deleted rather than converted, which the wikidle migration above could do and
// this cannot: a move count carries no information about how long it took, so
// there is nothing to convert it into. Left alone it would be far worse than
// wrong — 42 moves read as 42 milliseconds, which is a score no honest player
// can ever beat, sitting at the top of the board until the retention sweep
// removes it thirty days later.
//
// The threshold is what separates the two meanings. A solve is dozens of
// round trips to this server, so a real time is thousands of milliseconds;
// a move count is tens. Anything under a second is a move count.
{
  const legacy = db
    .prepare("DELETE FROM daily_scores WHERE game IN ('tiles', 'match') AND score < 1000")
    .run().changes;
  if (legacy) log.warn("daily_move_scores_dropped", { rows: legacy });
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
  // INSERT OR IGNORE, because the UNIQUE(day, game, identity) constraint IS the
  // one-attempt-per-day rule. Enforcing it in the schema rather than with a
  // read-then-write means two requests racing cannot both slip through.
  insertDailyScore: db.prepare(`
    INSERT OR IGNORE INTO daily_scores (day, game, identity, name, score, created_at)
    VALUES (@day, @game, @identity, @name, @score, @created_at)
  `),
  dailyBoard: db.prepare(`
    SELECT name, score, created_at
      FROM daily_scores
     WHERE day = @day AND game = @game
     ORDER BY score ASC, created_at ASC
     LIMIT @limit
  `),
  dailyEntry: db.prepare("SELECT * FROM daily_scores WHERE day = ? AND game = ? AND identity = ?"),
  dailyRank: db.prepare(`
    SELECT COUNT(*) AS ahead
      FROM daily_scores
     WHERE day = @day AND game = @game
       AND (score < @score OR (score = @score AND created_at < @created_at))
  `),
  deleteDailyForIdentity: db.prepare("DELETE FROM daily_scores WHERE identity = ?"),
  deleteDailyBefore: db.prepare("DELETE FROM daily_scores WHERE day < ?"),
  deleteRatings: db.prepare("DELETE FROM ratings WHERE user_id = ?"),
  deleteMatches: db.prepare("DELETE FROM matches WHERE a_user_id = ? OR b_user_id = ?"),
  deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
  findInactive: db.prepare("SELECT id, display_name, last_seen FROM users WHERE COALESCE(last_seen, created_at) < ?"),

  // ── Moderation ────────────────────────────────────────────────────────────
  insertReport: db.prepare(`
    INSERT OR IGNORE INTO chat_reports
      (created_at, room_code, ranked, is_private, message_id, message_at, message_text,
       author_identity, author_user_id, author_name,
       reporter_identity, reporter_user_id, reporter_name)
    VALUES
      (@created_at, @room_code, @ranked, @is_private, @message_id, @message_at, @message_text,
       @author_identity, @author_user_id, @author_name,
       @reporter_identity, @reporter_user_id, @reporter_name)
  `),
  // @status = 'all' selects everything; anything else filters. One statement
  // rather than two so the queue and the archive can never drift in shape.
  listReports: db.prepare(`
    SELECT * FROM chat_reports
     WHERE (@status = 'all' OR status = @status)
     ORDER BY created_at DESC, id DESC
     LIMIT @limit OFFSET @offset
  `),
  getReport: db.prepare("SELECT * FROM chat_reports WHERE id = ?"),
  // Only ever moves a report OUT of 'open'. Re-resolving one that is already
  // closed is a no-op rather than an error: two admins clicking at once should
  // agree on the first answer, not race to overwrite it.
  resolveReport: db.prepare(`
    UPDATE chat_reports
       SET status = @status, resolved_at = @resolved_at, resolved_by = @resolved_by, note = @note
     WHERE id = @id AND status = 'open'
  `),
  reportCounts: db.prepare("SELECT status, COUNT(*) AS n FROM chat_reports GROUP BY status"),
  // How often this account has been reported, and how much of that was upheld —
  // the context that separates one angry opponent from a pattern.
  reportsAgainst: db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'actioned' THEN 1 ELSE 0 END) AS actioned
      FROM chat_reports WHERE author_user_id = ?
  `),
  recentReportsAgainst: db.prepare(`
    SELECT * FROM chat_reports WHERE author_user_id = ? ORDER BY created_at DESC LIMIT ?
  `),
  deleteReportsBefore: db.prepare("DELETE FROM chat_reports WHERE created_at < ?"),
  deleteReportsForIdentity: db.prepare(
    "DELETE FROM chat_reports WHERE author_identity = ? OR reporter_identity = ?"
  ),

  upsertBan: db.prepare(`
    INSERT INTO bans (user_id, reason, created_at, expires_at, created_by)
    VALUES (@user_id, @reason, @created_at, @expires_at, @created_by)
    ON CONFLICT(user_id) DO UPDATE SET
      reason = @reason, created_at = @created_at, expires_at = @expires_at, created_by = @created_by
  `),
  getBan: db.prepare("SELECT * FROM bans WHERE user_id = ?"),
  deleteBan: db.prepare("DELETE FROM bans WHERE user_id = ?"),
  listBans: db.prepare(`
    SELECT b.*, u.display_name, u.avatar_url, a.display_name AS by_name
      FROM bans b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN users a ON a.id = b.created_by
     ORDER BY b.created_at DESC
     LIMIT ?
  `),
  // Expired long enough ago that the record has stopped being useful. A ban
  // still in force is never touched, whatever its age.
  deleteExpiredBansBefore: db.prepare(
    "DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at < ?"
  ),

  // ── Admin views ───────────────────────────────────────────────────────────
  countUsers: db.prepare("SELECT COUNT(*) AS n FROM users"),
  countUsersSince: db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?"),
  countActiveSince: db.prepare("SELECT COUNT(*) AS n FROM users WHERE COALESCE(last_seen, created_at) >= ?"),
  countMatches: db.prepare("SELECT COUNT(*) AS n FROM matches"),
  countMatchesSince: db.prepare("SELECT COUNT(*) AS n FROM matches WHERE created_at >= ?"),
  countBans: db.prepare("SELECT COUNT(*) AS n FROM bans WHERE expires_at IS NULL OR expires_at > ?"),
  dailyPlaysToday: db.prepare(
    "SELECT game, COUNT(*) AS n FROM daily_scores WHERE day = ? GROUP BY game"
  ),
  recentSignups: db.prepare(
    "SELECT id, display_name, avatar_url, provider, created_at, last_seen FROM users ORDER BY created_at DESC LIMIT ?"
  ),
  // ── Notices ───────────────────────────────────────────────────────────────
  insertNotice: db.prepare(`
    INSERT INTO notices (message, level, created_at, created_by, expires_at)
    VALUES (@message, @level, @created_at, @created_by, @expires_at)
  `),
  // Every notice, expired or not: the admin list has to show a lapsed one so it
  // can be told apart from one that was never pinned.
  allNotices: db.prepare("SELECT * FROM notices ORDER BY created_at DESC LIMIT ?"),
  deleteNotice: db.prepare("DELETE FROM notices WHERE id = ?"),
  deleteExpiredNoticesBefore: db.prepare(
    "DELETE FROM notices WHERE expires_at IS NOT NULL AND expires_at < ?"
  ),

  // Name search. The pattern is a bound parameter like everything else here —
  // ESCAPE is about LIKE's own wildcards, not about SQL injection, which
  // binding already rules out. Without it a search for "100%" matches every
  // player on the site.
  searchUsers: db.prepare(`
    SELECT id, display_name, avatar_url, provider, created_at, last_seen
      FROM users
     WHERE display_name LIKE @q ESCAPE '\\' OR id = @id
     ORDER BY COALESCE(last_seen, created_at) DESC, id DESC
     LIMIT @limit
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
  // Order matters: `ratings`, `matches` and `bans` all carry a foreign key onto
  // `users`, and foreign_keys is ON.
  const matches = stmts.deleteMatches.run(userId, userId).changes;
  const ratings = stmts.deleteRatings.run(userId).changes;
  // A ban is a fact about an account, so it goes when the account does. There
  // is nothing left to keep out: the next sign-in through the same provider
  // creates a new row with a new id, which is a real limit of banning by
  // account and is stated as such in the admin UI.
  const bans = stmts.deleteBan.run(userId).changes;
  // Daily results have no foreign key — guests earn them too — so nothing would
  // have cascaded here. They still carry a display name, which makes them the
  // player's data and squarely inside what the privacy policy promises to
  // erase. Matched on the identity string an account resolves to.
  const dailies = stmts.deleteDailyForIdentity.run(`u${userId}`).changes;
  // Same reasoning, and the same lack of a foreign key: a report holds a chat
  // message this player wrote and the display names of both sides. Erasure
  // means erasure, so their reports go with everything else — on either side of
  // the report, because a reporter's name is their data too.
  const reports = stmts.deleteReportsForIdentity.run(`u${userId}`, `u${userId}`).changes;
  const users = stmts.deleteUser.run(userId).changes;
  return { matches, ratings, bans, dailies, reports, deleted: users > 0 };
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

// ── Daily puzzles ────────────────────────────────────────────────────────────
// One result per player per day, and the UNIQUE constraint is what decides it
// rather than a read-then-write: a player finishing in two tabs at once gets
// one row either way, and it is the first — which is also the honest one, since
// the clock started when the server handed the puzzle out.

function recordDailyScore(entry) {
  const info = stmts.insertDailyScore.run({ ...entry, created_at: Date.now() });
  return info.changes > 0; // false: they had already finished this one today
}

const getDailyEntry = (day, game, identity) => stmts.dailyEntry.get(day, game, identity) || null;
const getDailyLeaderboard = (day, game, limit = 25) => stmts.dailyBoard.all({ day, game, limit });

// Where a result sits on the day's board, 1-based. Counted rather than found by
// scanning the board, so a player outside the visible top N still learns their
// placing.
//
// Ties are broken by created_at, which is what "fewest guesses, first to get
// there" means — so this has to be given the row's own timestamp, not the
// current time, or a player would rank behind everyone they actually beat.
const getDailyRank = (day, game, score, createdAt) =>
  stmts.dailyRank.get({ day, game, score, created_at: createdAt }).ahead + 1;

// A daily board is a scoreboard for one day, not a history. Keeping rows past
// their day serves nobody and quietly accumulates display names, so they are
// swept on the same schedule as dormant accounts. Keep this in step with the
// retention table in public/privacy.html.
function purgeOldDailyScores(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return stmts.deleteDailyBefore.run(cutoff).changes;
}

// ── Moderation ───────────────────────────────────────────────────────────────
// Everything the /admin dashboard reads and writes. Two tables, and the split
// between them is deliberate: a report is a message somebody complained about,
// a ban is a decision about an account. Resolving a report never bans anyone and
// banning somebody never closes a report — the operator does both, separately,
// because "this message was fine" and "this player is fine" are different
// findings and conflating them makes the queue lie.

const REPORT_STATUSES = ["open", "actioned", "dismissed"];

// Store a reported message. Returns false when this reporter has already
// reported this message, which the UNIQUE constraint decides rather than a
// read-then-write — two tabs racing produce one row either way.
function recordChatReport(r) {
  const info = stmts.insertReport.run({
    created_at: Date.now(),
    room_code: r.roomCode,
    ranked: r.ranked ? 1 : 0,
    is_private: r.isPrivate ? 1 : 0,
    message_id: r.messageId,
    message_at: r.messageAt,
    message_text: r.messageText,
    author_identity: r.authorIdentity,
    author_user_id: r.authorUserId || null,
    author_name: r.authorName,
    reporter_identity: r.reporterIdentity,
    reporter_user_id: r.reporterUserId || null,
    reporter_name: r.reporterName,
  });
  return info.changes > 0;
}

const listChatReports = ({ status = "open", limit = 50, offset = 0 } = {}) =>
  stmts.listReports.all({ status, limit, offset });

const getChatReport = (id) => stmts.getReport.get(id) || null;

// Close a report. Returns false if it was already closed — see the note on the
// statement for why that is an answer rather than an error.
function resolveChatReport({ id, status, note = null, adminId = null }) {
  if (!REPORT_STATUSES.includes(status) || status === "open") {
    throw new Error(`resolveChatReport: bad status ${status}`);
  }
  const info = stmts.resolveReport.run({
    id,
    status,
    note: note ? String(note).slice(0, 500) : null,
    resolved_at: Date.now(),
    resolved_by: adminId,
  });
  return info.changes > 0;
}

function reportCounts() {
  const out = { open: 0, actioned: 0, dismissed: 0 };
  for (const row of stmts.reportCounts.all()) out[row.status] = row.n;
  return out;
}

// A ban is only in force while it has not expired. Everything that asks "can
// this player play" goes through here, so there is one definition of active and
// an expired row cannot accidentally keep somebody out.
function activeBan(userId, now = Date.now()) {
  if (!userId) return null;
  const row = stmts.getBan.get(userId);
  if (!row) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  return { reason: row.reason || "", until: row.expires_at, at: row.created_at };
}

function banUser({ userId, reason = "", expiresAt = null, byUserId = null }) {
  stmts.upsertBan.run({
    user_id: userId,
    reason: String(reason || "").slice(0, 500),
    created_at: Date.now(),
    expires_at: expiresAt,
    created_by: byUserId,
  });
  return activeBan(userId);
}

const unbanUser = (userId) => stmts.deleteBan.run(userId).changes > 0;

const listBans = (limit = 100) =>
  stmts.listBans.all(limit).map((b) => ({
    userId: b.user_id,
    name: b.display_name,
    avatar: b.avatar_url,
    reason: b.reason,
    at: b.created_at,
    until: b.expires_at,
    byName: b.by_name || null,
    active: b.expires_at == null || b.expires_at > Date.now(),
  }));

// ── Site notices ─────────────────────────────────────────────────────────────
// Pinned from /admin, served to every visitor inside /api/config.
//
// CACHED IN FULL, and that is the whole point of the design. /api/config is
// fetched by every page load on the site, so an uncached read here would put a
// SQLite query on the event loop for every visitor — exactly the cost the
// leaderboard cache exists to avoid, reintroduced through a different door.
//
// The cache holds every row rather than only the live ones, and `activeNotices`
// filters by expiry on each READ — not when the cache is filled. That is what
// makes expiry exact to the millisecond with no TTL at all: a notice pinned for
// an hour stops being served on the hour, without anything having to write.
//
// This rests on one assumption, which is currently true and would be easy to
// break: `expires_at` is set at INSERT and never updated. There is no "edit the
// expiry" path, so a cached row's expiry is always the real one. If an edit is
// ever added it MUST call invalidateNotices(), or the site will keep serving a
// notice against a stale deadline.
//
// A lapsed row stays in the table for the admin list, and is swept later by the
// retention job.
const NOTICE_LEVELS = ["info", "warn"];
const NOTICE_MAX_LEN = 280;
// How many a visitor can be shown at once. A corner of the screen holding six
// cards is not a notice, it is a wall, and the newest is the one that matters.
const NOTICE_SHOWN = 3;
const NOTICE_LIST_LIMIT = 50;

let noticeCache = null;
const invalidateNotices = () => { noticeCache = null; };

function allNotices() {
  if (!noticeCache) noticeCache = stmts.allNotices.all(NOTICE_LIST_LIMIT);
  return noticeCache;
}

// What the site shows: unexpired, newest first, capped. Shaped for the browser
// here so /api/config never has to know the column names.
function activeNotices(now = Date.now()) {
  return allNotices()
    .filter((n) => n.expires_at == null || n.expires_at > now)
    .slice(0, NOTICE_SHOWN)
    .map((n) => ({ id: n.id, message: n.message, level: n.level }));
}

// The admin list: everything, with the expiry left in so a lapsed notice reads
// as lapsed rather than as missing.
const listNotices = () =>
  allNotices().map((n) => ({
    id: n.id,
    message: n.message,
    level: n.level,
    at: n.created_at,
    expiresAt: n.expires_at,
    active: n.expires_at == null || n.expires_at > Date.now(),
  }));

function createNotice({ message, level = "info", expiresAt = null, byUserId = null }) {
  // Same treatment chat and reports get: angle brackets stripped and a hard cap,
  // so nothing stored can carry markup even before the client escapes it.
  const text = String(message || "").replace(/[<>]/g, "").trim().slice(0, NOTICE_MAX_LEN);
  if (!text) throw new Error("createNotice: empty message");
  const info = stmts.insertNotice.run({
    message: text,
    level: NOTICE_LEVELS.includes(level) ? level : "info",
    created_at: Date.now(),
    created_by: byUserId,
    expires_at: expiresAt,
  });
  invalidateNotices();
  return info.lastInsertRowid;
}

function deleteNotice(id) {
  const changed = stmts.deleteNotice.run(id).changes > 0;
  if (changed) invalidateNotices();
  return changed;
}

// ── Admin views ──────────────────────────────────────────────────────────────

// The overview numbers. All counts, all indexed or over small tables, so this is
// cheap enough to poll — which matters, because a dashboard nobody leaves open
// is a dashboard nobody reads.
function adminStats({ day, now = Date.now() } = {}) {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const dailies = {};
  for (const row of stmts.dailyPlaysToday.all(day)) dailies[row.game] = row.n;
  return {
    accounts: stmts.countUsers.get().n,
    accountsNew7d: stmts.countUsersSince.get(now - WEEK).n,
    activeToday: stmts.countActiveSince.get(now - DAY).n,
    active7d: stmts.countActiveSince.get(now - WEEK).n,
    rankedMatches: stmts.countMatches.get().n,
    rankedMatches7d: stmts.countMatchesSince.get(now - WEEK).n,
    dailyPlaysToday: dailies,
    reports: reportCounts(),
    activeBans: stmts.countBans.get(now).n,
  };
}

const recentSignups = (limit = 10) => stmts.recentSignups.all(limit);

// Find a player to act on. An all-digits query is also tried as an id, because
// a report names an account id and pasting it in is the fastest route from
// "this row" to "this person".
function searchUsers(query, limit = 25) {
  const q = String(query || "").trim().slice(0, 60);
  if (!q) return [];
  const asId = /^\d+$/.test(q) ? parseInt(q, 10) : -1;
  const escaped = q.replace(/[\\%_]/g, "\\$&");
  return stmts.searchUsers.all({ q: `%${escaped}%`, id: asId, limit });
}

// Everything about one player, in one place: who they are, how they are rated,
// what they have been reported for, and whether they are currently banned.
function adminUserDetail(userId, { matchLimit = 10, reportLimit = 10 } = {}) {
  const user = stmts.getUser.get(userId);
  if (!user) return null;
  const against = stmts.reportsAgainst.get(userId) || { total: 0, actioned: 0 };
  return {
    id: user.id,
    name: user.display_name,
    avatar: user.avatar_url,
    provider: user.provider,
    createdAt: user.created_at,
    lastSeen: user.last_seen,
    chatEnabled: user.chat_enabled !== 0,
    ratings: stmts.getRatingsForUser.all(userId),
    matches: getRecentMatches(userId, matchLimit),
    ban: activeBan(userId),
    reportsAgainst: { total: against.total || 0, actioned: against.actioned || 0 },
    recentReports: stmts.recentReportsAgainst.all(userId, reportLimit),
  };
}

// ── Moderation retention ─────────────────────────────────────────────────────
// A report holds a chat message and two display names, and a ban holds a reason
// somebody wrote about a player. Neither is kept indefinitely. Swept alongside
// the daily boards — see runRetentionSweep in index.js — and kept in step with
// the retention table in public/privacy.html.
function purgeOldReports(days = 30) {
  return stmts.deleteReportsBefore.run(Date.now() - days * 24 * 60 * 60 * 1000).changes;
}

function purgeExpiredBans(days = 30) {
  return stmts.deleteExpiredBansBefore.run(Date.now() - days * 24 * 60 * 60 * 1000).changes;
}

// A notice that lapsed a month ago is clutter in the admin list and nothing
// else. Swept on the same schedule; one still showing is never touched.
function purgeExpiredNotices(days = 30) {
  const n = stmts.deleteExpiredNoticesBefore.run(Date.now() - days * 24 * 60 * 60 * 1000).changes;
  if (n) invalidateNotices();
  return n;
}

module.exports = {
  db,
  recordDailyScore,
  getDailyEntry,
  getDailyLeaderboard,
  getDailyRank,
  purgeOldDailyScores,
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
  // Moderation: the report queue, bans, and the admin dashboard's reads.
  REPORT_STATUSES,
  recordChatReport,
  listChatReports,
  getChatReport,
  resolveChatReport,
  reportCounts,
  activeBan,
  banUser,
  unbanUser,
  listBans,
  adminStats,
  recentSignups,
  searchUsers,
  adminUserDetail,
  purgeOldReports,
  purgeExpiredBans,
  // Site notices: pinned from /admin, served inside /api/config.
  NOTICE_LEVELS,
  NOTICE_MAX_LEN,
  activeNotices,
  listNotices,
  createNotice,
  deleteNotice,
  purgeExpiredNotices,
  // Exported for tests. The activity map is internal state that no query or
  // response reveals, so a leak in it is invisible from the outside — and
  // sweepTouched takes `now` as an argument precisely so a test can advance the
  // clock past the throttle window without mocking timers.
  sweepTouched,
  touchedSize: () => lastTouched.size,
};
