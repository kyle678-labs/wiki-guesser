"use strict";

// Daily puzzles: the day boundary, the deterministic pick, and the Wikidle
// round played end to end over HTTP.
//
// Built against a small synthetic pool rather than the real ~900 MB artifact,
// so this runs in CI and on a laptop with no dump.
//
// The assertions that matter most are the ones about what the client is NOT
// told. Wikidle is only a game while the answer and the unrevealed words stay
// on the server; if either ever leaks into a response, every other test here
// would still pass.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const dir = path.join(os.tmpdir(), "wg-daily-" + crypto.randomBytes(5).toString("hex"));
fs.mkdirSync(dir, { recursive: true });
const poolFile = path.join(dir, "mysteries.sqlite");

// Must be set before server/config is first required.
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = dir;
process.env.MYSTERY_DB = poolFile;
process.env.PRELOAD_PARTY = "false";

const helpers = require("./helpers");

// Must clear wikidle's MIN_TEXT_LEN (400 characters) and leave enough words to
// reveal one per guess, or buildPuzzle correctly refuses to serve the day.
const lead = (title) =>
  `${title} is a notable subject of considerable interest to many people around the world. ` +
  `It has been described at length in numerous published works and remains widely discussed. ` +
  `Scholars continue to examine its origins, its development over time, and the influence it ` +
  `has exerted on neighbouring fields of study throughout the modern period and beyond today. ` +
  `Further accounts record how it came to be regarded as a subject worth setting down at all.`;

before(() => {
  const db = new Database(poolFile);
  db.exec(`
    CREATE TABLE mysteries (
      page_id INTEGER PRIMARY KEY, title TEXT NOT NULL,
      image_name TEXT, image_url TEXT, opening_text TEXT, freq_json TEXT,
      incoming_links INTEGER NOT NULL DEFAULT 0, popularity REAL NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 1, categories INTEGER NOT NULL DEFAULT 0,
      rnd REAL NOT NULL
    );
    CREATE INDEX idx_img_rnd ON mysteries(rnd) WHERE image_url IS NOT NULL;
    CREATE INDEX idx_txt_rnd ON mysteries(rnd) WHERE opening_text IS NOT NULL;
  `);
  const ins = db.prepare(
    `INSERT INTO mysteries (page_id, title, image_url, opening_text, popularity, rnd)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  // Enough rows that two seeds landing on the same article is a coincidence
  // rather than the norm — with a handful of rows, "different games pick
  // different articles" would fail on pigeonholes alone.
  const titles = [
    "Polar Bear", "Eiffel Tower", "Espresso", "Tornado", "Bicycle", "Volcano", "Lighthouse", "Origami",
    "Hedgehog", "Accordion", "Glacier", "Windmill", "Kayak", "Meteorite", "Trombone", "Aqueduct",
    "Pineapple", "Submarine", "Telescope", "Avalanche", "Harpsichord", "Mangrove", "Zeppelin", "Obsidian",
  ];
  titles.forEach((t, i) => ins.run(i + 1, t, `https://example.invalid/${i}.jpg`, lead(t), 1.0, (i + 1) / (titles.length + 4)));
  // Titles the daily filter must never serve, however the seed lands.
  ins.run(90, "Nine Inch Nails discography", "https://example.invalid/d.jpg", lead("A discography"), 1.0, 0.91);
  ins.run(91, "List of tallest buildings", "https://example.invalid/l.jpg", lead("A list"), 1.0, 0.93);
  ins.run(92, "Mercury (disambiguation)", "https://example.invalid/m.jpg", lead("A disambiguation"), 1.0, 0.95);
  db.close();
});

after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* temp dir */ }
});

const { dayKey, msUntilReset, pickDaily, seedFor } = require("../server/game/daily");
const wikidle = require("../server/game/wikidle");

// ── The day boundary ─────────────────────────────────────────────────────────

test("the day is UTC, so every player is on the same puzzle at the same moment", () => {
  // 23:59 UTC and 00:01 UTC are different puzzles; local time never enters into
  // it, which is what keeps one leaderboard coherent.
  assert.equal(dayKey(Date.UTC(2026, 6, 30, 23, 59)), "2026-07-30");
  assert.equal(dayKey(Date.UTC(2026, 6, 31, 0, 1)), "2026-07-31");
  assert.equal(msUntilReset(Date.UTC(2026, 6, 30, 23, 59)), 60_000);
});

test("the day rolls over across a month and a year without arithmetic bugs", () => {
  const eoy = Date.UTC(2026, 11, 31, 23, 0);
  assert.equal(new Date(eoy + msUntilReset(eoy)).toISOString(), "2027-01-01T00:00:00.000Z");
  const eom = Date.UTC(2026, 1, 28, 23, 0); // 2026 is not a leap year
  assert.equal(new Date(eom + msUntilReset(eom)).toISOString(), "2026-03-01T00:00:00.000Z");
});

// ── Deterministic selection ──────────────────────────────────────────────────

test("the same day and game always pick the same article", () => {
  const opts = { day: "2026-07-30", gameId: "wikidle", clue: "text", minPop: 1e-5, minTextLen: 100 };
  const a = pickDaily(opts);
  const b = pickDaily(opts);
  assert.ok(a && a.length === 1);
  assert.equal(a[0].page_id, b[0].page_id, "a puzzle nobody stored must still be reproducible");
});

test("different days, and different games on one day, diverge", () => {
  const base = { gameId: "wikidle", clue: "text", minPop: 1e-5, minTextLen: 100 };
  const days = new Set();
  for (let i = 1; i <= 8; i++) {
    days.add(pickDaily({ ...base, day: `2026-09-0${i}` })[0].page_id);
  }
  // Not a uniqueness guarantee — the fixture pool is tiny and collisions are
  // legitimate. This catches a seed that ignores the day entirely.
  assert.ok(days.size > 1, "consecutive days must not all resolve to one article");

  // Asserted on the seed rather than the article. Two games CAN legitimately
  // land on the same row — that is a pigeonhole, not a bug — but they must
  // never start from the same seed, which is the property actually at stake.
  const day = "2026-07-30";
  assert.notEqual(seedFor(day, "wikidle"), seedFor(day, "tiles"), "each game needs its own stream");
  assert.notEqual(seedFor("2026-07-30", "wikidle"), seedFor("2026-07-31", "wikidle"), "and each day its own");
});

test("a multi-article draw returns distinct articles", () => {
  const rows = pickDaily({ day: "2026-07-30", gameId: "match", clue: "image", minPop: 1e-5, count: 6 });
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((r) => r.page_id)).size, 6, "a matching grid cannot repeat an article");
});

test("titles that make a poor puzzle are never served", () => {
  // A 20-second round can afford "Nine Inch Nails discography". A whole day
  // cannot, so dailies filter harder than the live game.
  for (let i = 0; i < 60; i++) {
    const row = pickDaily({ day: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, gameId: `g${i}`, clue: "text", minPop: 1e-5, minTextLen: 100 });
    if (!row) continue;
    assert.doesNotMatch(row[0].title, /discography|^List of|\(disambiguation\)/i, `served "${row[0].title}"`);
  }
});

// ── Wikidle rules ────────────────────────────────────────────────────────────

test("the puzzle blanks its own answer out of the clue", () => {
  const p = wikidle.buildPuzzle("2026-07-30");
  assert.ok(p, "the fixture pool should yield a puzzle");
  const clue = p.words.join(" ").toLowerCase();
  for (const w of p.title.toLowerCase().split(/\s+/)) {
    if (w.length <= 2) continue;
    assert.ok(!clue.includes(w), `the clue contains "${w}" from the answer "${p.title}"`);
  }
});

test("a guess has to name the article, not merely gesture at it", () => {
  assert.equal(wikidle.isCorrect("Polar Bear", "Polar Bear"), true);
  assert.equal(wikidle.isCorrect("polar bear", "Polar Bear"), true, "case must not matter");
  assert.equal(wikidle.isCorrect("Polr Bear", "Polar Bear"), true, "a dropped character is still a solve");
  assert.equal(wikidle.isCorrect("bear", "Polar Bear"), false, "half the title is not the title");
  assert.equal(wikidle.isCorrect("", "Polar Bear"), false);
});

// ── The Wordle aids ──────────────────────────────────────────────────────────
// The shape and the letter marks are the two things that make an unbounded
// answer playable. Both are derived from the answer, so both are places a
// careless change could hand the whole thing over — the first test here is about
// what the shape does NOT say.

// One word per string, one character per letter: h(it), n(ear), m(iss), s(kip).
// Compact enough that a whole expectation reads as the row a player would see.
const marksOf = (guess, title) => wikidle.markGuess(guess, title).map((w) => w.map((c) => c.mark[0]).join(""));

test("the shape gives the answer's size and not one letter of it", () => {
  const shape = wikidle.shapeOf("Polar Bear");
  assert.deepEqual(shape, [
    [null, null, null, null, null],
    [null, null, null, null],
  ], "two words of five and four, and nothing else");

  // Punctuation is structure rather than answer: it was never hidden, so it is
  // shown outright and a player reads the title's real shape.
  assert.deepEqual(wikidle.shapeOf("Jack-in-the-box"), [
    [null, null, null, null, "-", null, null, "-", null, null, null, "-", null, null, null],
  ]);
});

test("a guess comes back marked letter by letter", () => {
  assert.deepEqual(marksOf("Polar Bear", "Polar Bear"), ["hhhhh", "hhhh"], "the solve is all hits");
  // S is not in the answer at all; the rest of "olar" sits where it belongs.
  assert.deepEqual(marksOf("Solar Beam", "Polar Bear"), ["mhhhh", "hhhm"]);
  // One word against two: nothing can be in position, but every letter is in
  // the answer somewhere, which is exactly the nudge the puzzle owed a player.
  assert.deepEqual(marksOf("bear", "Polar Bear"), ["nnnn"]);
  assert.deepEqual(marksOf("Zurich", "Zürich"), ["hhhhhh"], "an accent the player can't type is still a hit");
});

test("marks never report more of a letter than the answer holds", () => {
  // "Bee" has two E's. Both are placed, so the two spare ones in the guess are
  // misses — a pool shared between the passes is the only thing that gets this
  // right, and getting it wrong would over-promise on every repeated letter.
  assert.deepEqual(marksOf("eeee", "Bee"), ["mhhm"]);
  // "Banana" holds three A's, at positions 1, 3 and 5. Seven A's asks for more
  // than that: three come back placed and the other four come back as nothing,
  // rather than the whole row lighting up.
  assert.deepEqual(marksOf("aaaaaaa", "Banana"), ["mhmhmhm"]);
  assert.deepEqual(marksOf("aaa", "Banana"), ["nhn"], "one placed, two accounted for elsewhere");
});

test("punctuation in a guess is shown, not judged", () => {
  const marks = wikidle.markGuess("jack-o", "Jack Rabbit");
  assert.deepEqual(marks[0].map((c) => c.mark), ["hit", "hit", "hit", "hit", "skip", "miss"]);
});

test("correctly placed letters accumulate across guesses", () => {
  // Neither guess names it; between them they place every letter of the first
  // word and the B of the second, and none of what they missed leaks.
  const shape = wikidle.revealedShape("Polar Bear", [{ text: "Polar Cub" }, { text: "solar Bump" }]);
  assert.deepEqual(shape, [
    ["P", "o", "l", "a", "r"],
    ["B", null, null, null],
  ]);
  assert.deepEqual(
    wikidle.revealedShape("Polar Bear", []),
    wikidle.shapeOf("Polar Bear"),
    "no guesses, nothing revealed"
  );
});

// ── The round, over HTTP ─────────────────────────────────────────────────────

let srv;
before(async () => { srv = await helpers.startTestServer(); });
after(async () => { await srv.close(); });

const answerToday = () => wikidle.puzzleFor().title;

test("the daily refuses anyone without an identity", async () => {
  const res = await helpers.get(srv.port, "/api/daily/wikidle");
  assert.equal(res.status, 401);
});

test("a round reveals a word per wrong guess and never ships the answer early", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Solver");

  let st = JSON.parse((await helpers.get(srv.port, "/api/daily/wikidle", cookie)).body);
  assert.equal(st.revealed, wikidle.START_WORDS);
  assert.equal(st.words.length, wikidle.START_WORDS, "only the earned words are sent");
  assert.equal(st.answer, null, "the answer must not be in the page before it is over");
  assert.equal(st.done, false);

  const wrong = await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: "definitely not it" }, cookie);
  st = JSON.parse(wrong.body);
  assert.equal(st.revealed, wikidle.START_WORDS + 1, "a wrong guess buys exactly one word");
  assert.equal(st.words.length, wikidle.START_WORDS + 1);
  assert.equal(st.answer, null);
  assert.equal(st.guesses.length, 1);
  assert.equal(st.guesses[0].correct, false);
});

test("solving records a score, reveals the answer, and closes the round", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Winner");
  await helpers.get(srv.port, "/api/daily/wikidle", cookie); // starts the clock

  const res = await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: answerToday() }, cookie);
  const st = JSON.parse(res.body);
  assert.equal(st.won, true);
  assert.equal(st.done, true);
  // Scored in guesses, not words and not seconds: solved first try is a 1.
  assert.equal(st.score, 1, "a first-try solve is one guess");
  assert.equal(st.answer, answerToday(), "now it can be shown");
  assert.equal(st.ms, undefined, "the daily is not timed");

  const board = JSON.parse((await helpers.get(srv.port, "/api/daily/wikidle/leaderboard", cookie)).body);
  assert.ok(board.me, "a player who finished gets their own placing back");
  assert.equal(board.me.score, 1);
  assert.ok(board.leaderboard.some((r) => r.name === board.me.name), "and appears on the board itself");
});

test("a finished player cannot keep guessing, and gets one board entry", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Repeater");
  await helpers.get(srv.port, "/api/daily/wikidle", cookie);
  await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: answerToday() }, cookie);

  const again = await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: answerToday() }, cookie);
  assert.equal(again.status, 409, "the round is over; a second solve is not a second score");

  const board = JSON.parse((await helpers.get(srv.port, "/api/daily/wikidle/leaderboard", cookie)).body);
  const mine = board.leaderboard.filter((r) => r.name === board.me.name);
  assert.equal(mine.length, 1, "one entry per player per day");
});

test("the round ships the answer's shape, and fills it in as letters are placed", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Speller");
  const answer = answerToday();

  let st = JSON.parse((await helpers.get(srv.port, "/api/daily/wikidle", cookie)).body);
  const words = answer.split(/\s+/);
  assert.deepEqual(st.shape.map((w) => w.length), words.map((w) => w.length), "word count and lengths");
  assert.ok(st.shape.every((w) => w.every((c) => c === null)), "before a guess, no letter is given away");

  // First letter of the answer, then padding out of a letter the answer does not
  // contain — so exactly one slot can be earned and the assertion below is
  // about the mechanism rather than about which article today landed on.
  const filler = "qzxjkvw".split("").find((c) => !answer.toLowerCase().includes(c));
  assert.ok(filler, `no unused letter available for "${answer}"`);
  const probe = answer[0] + filler.repeat(6);

  st = JSON.parse((await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: probe }, cookie)).body);
  assert.equal(st.guesses[0].correct, false, "the probe must not accidentally name it");
  assert.equal(st.guesses[0].marks[0][0].mark, "hit");
  assert.ok(st.guesses[0].marks[0].slice(1).every((c) => c.mark === "miss"), "the filler is in nothing");

  assert.equal(st.shape[0][0], answer[0], "a placed letter stays on screen");
  const revealed = st.shape.flat().filter((c) => c !== null);
  assert.equal(revealed.length, 1, "and only the one that was earned");
  assert.equal(st.answer, null, "the rest of it is still the answer");
});

test("an empty guess is rejected without costing a word", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Empty");
  const before = JSON.parse((await helpers.get(srv.port, "/api/daily/wikidle", cookie)).body);
  const res = await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: "   " }, cookie);
  assert.equal(res.status, 400);
  const after = JSON.parse((await helpers.get(srv.port, "/api/daily/wikidle", cookie)).body);
  assert.equal(after.revealed, before.revealed, "a non-guess must not advance the puzzle");
});

test("the score is the number of guesses, counted by the server", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Counter");
  await helpers.get(srv.port, "/api/daily/wikidle", cookie);

  for (const wrong of ["nope", "still nope", "definitely not"]) {
    await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: wrong }, cookie);
  }
  const res = await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: answerToday() }, cookie);
  const st = JSON.parse(res.body);

  // Three misses and a hit is four guesses — not the seven words that were on
  // screen by then, and not however long the player spent looking at them.
  assert.equal(st.score, 4);
  assert.equal(st.guesses.length, 4);
  assert.equal(st.revealed, wikidle.START_WORDS + 3, "words still advance; they just aren't the score");
});

test("equal scores are ranked by who solved first", async () => {
  const early = await helpers.guestSession(srv.port, "Early");
  const late = await helpers.guestSession(srv.port, "Late");

  // Both solve first try, so both score 1 and the tie can only break on order.
  await helpers.get(srv.port, "/api/daily/wikidle", early.cookie);
  await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: answerToday() }, early.cookie);
  // created_at is a millisecond stamp; without a gap the two rows can share one
  // and the ordering would be down to rowid rather than to the rule under test.
  await new Promise((r) => setTimeout(r, 5));
  await helpers.get(srv.port, "/api/daily/wikidle", late.cookie);
  await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: answerToday() }, late.cookie);

  const board = JSON.parse((await helpers.get(srv.port, "/api/daily/wikidle/leaderboard", late.cookie)).body);
  const names = board.leaderboard.filter((r) => r.name.startsWith("Early") || r.name.startsWith("Late")).map((r) => r.name);
  assert.ok(names[0].startsWith("Early"), `first solver should lead, got ${JSON.stringify(names)}`);
  assert.ok(
    board.leaderboard.find((r) => r.name.startsWith("Early")).rank <
      board.leaderboard.find((r) => r.name.startsWith("Late")).rank
  );
});

test("the board reports no timing at all", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "NoClock");
  await helpers.get(srv.port, "/api/daily/wikidle", cookie);
  await helpers.postJson(srv.port, "/api/daily/wikidle/guess", { text: answerToday() }, cookie);

  const board = JSON.parse((await helpers.get(srv.port, "/api/daily/wikidle/leaderboard", cookie)).body);
  for (const row of board.leaderboard) {
    assert.equal(row.ms, undefined, "a timed field would invite the client to sort on it");
  }
  assert.equal(board.me.ms, undefined);
});
