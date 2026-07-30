"use strict";

// The daily_scores migration, run against a database shaped the way the first
// release actually left it.
//
// This one earns its own file because it is the only code here that rewrites
// rows that already exist in production. Wikidle shipped scoring by words
// revealed with a solve time as the tie-break; it now scores by guesses taken,
// first solver wins. A row written under the old rule and read under the new
// one is not merely stale — a 7 meant "seven words", roughly a four-guess
// solve, and left alone it would rank below someone who genuinely took seven
// guesses. Silently wrong, on a board people can see.
//
// db.js runs its migrations at require time, so the fixture has to be in place
// before the require — which is why this cannot live in daily.test.js.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const dir = path.join(os.tmpdir(), "wg-migrate-" + crypto.randomBytes(5).toString("hex"));
fs.mkdirSync(dir, { recursive: true });

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = dir;

// The v1.2.0 shape, verbatim: a timed ms column, and a board index that names
// it — which is what stops a naive DROP COLUMN from working.
const OLD_ROWS = [
  // identity, old score (words revealed), expected new score (guesses)
  ["u1", "Ada", 4, 1], // solved first try
  ["u2", "Brin", 7, 4], // three misses then a hit
  ["g_x", "Cass", 40, 37], // ran the article out
];

before(() => {
  const db = new Database(path.join(dir, "wiki-guesser.sqlite"));
  db.exec(`
    CREATE TABLE daily_scores (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      day         TEXT NOT NULL,
      game        TEXT NOT NULL,
      identity    TEXT NOT NULL,
      name        TEXT NOT NULL,
      score       INTEGER NOT NULL,
      ms          INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(day, game, identity)
    );
    CREATE INDEX idx_daily_board ON daily_scores(day, game, score, ms);
  `);
  const ins = db.prepare(
    `INSERT INTO daily_scores (day, game, identity, name, score, ms, created_at)
     VALUES ('2026-07-30', 'wikidle', ?, ?, ?, ?, ?)`
  );
  OLD_ROWS.forEach(([id, name, oldScore], i) => ins.run(id, name, oldScore, 12_345, 1_700_000_000_000 + i));

  // Picture-game rows from the branch where those two scored by MOVES, before
  // they moved to the clock. Never released, so production has none — these
  // stand in for the dev and staging boxes that did run that build.
  const pic = db.prepare(
    `INSERT INTO daily_scores (day, game, identity, name, score, ms, created_at)
     VALUES ('2026-07-30', ?, ?, ?, ?, 0, 1700000000000)`
  );
  pic.run("tiles", "u9", "MoveScored", 42); // 42 moves, would read as 42ms
  pic.run("match", "u10", "AlsoMoveScored", 7);
  // A genuine time, written after the change. It must survive.
  pic.run("tiles", "u11", "TimeScored", 18_984);
  db.close();
});

after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* temp dir */ }
});

// Requiring this is what runs the migration.
const { db, getDailyLeaderboard, getDailyRank } = require("../server/db");

test("the timed column is gone", () => {
  const cols = db.prepare("PRAGMA table_info(daily_scores)").all().map((c) => c.name);
  assert.ok(!cols.includes("ms"), `ms survived: ${cols.join(", ")}`);
  assert.ok(cols.includes("score") && cols.includes("created_at"));
});

test("the board index is rebuilt on created_at rather than the dropped column", () => {
  // Not cosmetic. SQLite refuses to DROP COLUMN while an index references it,
  // so if the migration ever stops dropping this index first, the whole thing
  // throws at boot — and CREATE INDEX IF NOT EXISTS would not have fixed the
  // definition anyway, because the old index already existed.
  const cols = db.prepare("PRAGMA index_info(idx_daily_board)").all().map((c) => c.name);
  assert.deepEqual(cols, ["day", "game", "score", "created_at"]);
});

test("existing scores are converted from words revealed to guesses taken", () => {
  const rows = db.prepare("SELECT name, score FROM daily_scores ORDER BY id").all();
  const got = Object.fromEntries(rows.map((r) => [r.name, r.score]));
  for (const [, name, , expected] of OLD_ROWS) {
    assert.equal(got[name], expected, `${name} should convert to ${expected} guesses`);
  }
});

test("the converted board still sorts best-first, earliest-first on a tie", () => {
  const board = getDailyLeaderboard("2026-07-30", "wikidle", 10);
  assert.deepEqual(board.map((r) => r.name), ["Ada", "Brin", "Cass"]);
  // Ranks are derived from the same ordering, so a player outside the visible
  // board gets a placing consistent with what everyone else can see.
  assert.equal(getDailyRank("2026-07-30", "wikidle", board[0].score, board[0].created_at), 1);
  assert.equal(getDailyRank("2026-07-30", "wikidle", board[2].score, board[2].created_at), 3);
});

test("picture-game move scores are dropped, and real times are kept", () => {
  const names = db
    .prepare("SELECT name FROM daily_scores WHERE game IN ('tiles', 'match') ORDER BY name")
    .all()
    .map((r) => r.name);
  // A move count read as milliseconds is a sub-second solve — a score nobody
  // can beat, parked at the top of the board for the thirty days until the
  // retention sweep gets to it. There is nothing to convert it into, so it goes.
  assert.deepEqual(names, ["TimeScored"], `move-scored rows survived: ${names.join(", ")}`);
});

test("re-running the migration is a no-op", () => {
  // hasColumn("daily_scores", "ms") is now false, so a second boot must not
  // subtract 3 all over again. Cheap to assert, and the failure mode — scores
  // drifting down on every restart — would be invisible until someone noticed
  // a 1 had become a -2.
  const before = db.prepare("SELECT score FROM daily_scores ORDER BY id").all().map((r) => r.score);
  delete require.cache[require.resolve("../server/db")];
  require("../server/db");
  const after = db.prepare("SELECT score FROM daily_scores ORDER BY id").all().map((r) => r.score);
  assert.deepEqual(after, before, "a restart must not re-apply the conversion");
});
