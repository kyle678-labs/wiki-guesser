"use strict";

// The two picture dailies — Wikitile and Wikimatch — played end to end.
//
// Built against a small synthetic pool rather than the real ~900 MB artifact,
// so this runs in CI and on a laptop with no dump.
//
// Both games are scored in moves, which puts the weight of these tests in two
// places. First, that the server is the thing counting: a solve has to cost as
// many requests as it costs moves, and an illegal move has to cost neither.
// Second, that Wikimatch's answer — which caption belongs to which picture —
// never reaches the browser, because the moment it does the game is a click.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const dir = path.join(os.tmpdir(), "wg-picture-dailies-" + crypto.randomBytes(5).toString("hex"));
fs.mkdirSync(dir, { recursive: true });
const poolFile = path.join(dir, "mysteries.sqlite");

// Must be set before server/config is first required.
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = dir;
process.env.MYSTERY_DB = poolFile;
process.env.PRELOAD_PARTY = "false";

const helpers = require("./helpers");

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
  // Wikimatch draws nine distinct articles in one go, so the fixture pool has to
  // be comfortably larger than that or a short draw would look like a bug here.
  const titles = [
    "Polar Bear", "Eiffel Tower", "Espresso", "Tornado", "Bicycle", "Volcano", "Lighthouse", "Origami",
    "Hedgehog", "Accordion", "Glacier", "Windmill", "Kayak", "Meteorite", "Trombone", "Aqueduct",
    "Pineapple", "Submarine", "Telescope", "Avalanche", "Harpsichord", "Mangrove", "Zeppelin", "Obsidian",
  ];
  // The leads are long enough to clear Wikidle's own floor as well, so the hub
  // test below can assert that all three games are actually playable rather
  // than that two of them are.
  const lead = (title) =>
    `${title} is a notable subject of considerable interest to many people around the world. ` +
    `It has been described at length in numerous published works and remains widely discussed. ` +
    `Scholars continue to examine its origins, its development over time, and the influence it ` +
    `has exerted on neighbouring fields of study throughout the modern period and beyond today. ` +
    `Further accounts record how it came to be regarded as a subject worth setting down at all.`;
  titles.forEach((t, i) =>
    ins.run(i + 1, t, `https://example.invalid/${i}.jpg`, lead(t), 1.0, (i + 1) / (titles.length + 4))
  );
  db.close();
});

after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* temp dir */ }
});

const tiles = require("../server/game/tiles");
const match = require("../server/game/match");
const { swapsToSort, shuffle, rng } = require("../server/game/daily");

// ── Shared machinery ─────────────────────────────────────────────────────────

test("a seeded shuffle is a permutation, and the same one every time", () => {
  const items = [...Array(12).keys()];
  const a = shuffle(items, rng(1234));
  const b = shuffle(items, rng(1234));
  assert.deepEqual(a, b, "one seed, one shuffle — the whole point of a daily");
  assert.deepEqual([...a].sort((x, y) => x - y), items, "nothing lost and nothing duplicated");
  assert.deepEqual(items, [...Array(12).keys()], "the caller's array is not shuffled underneath it");
});

test("par is the number of swaps that actually sorts the arrangement", () => {
  assert.equal(swapsToSort([0, 1, 2]), 0, "already sorted");
  assert.equal(swapsToSort([1, 0, 2]), 1, "one transposition");
  assert.equal(swapsToSort([1, 2, 0]), 2, "a 3-cycle costs two");
  assert.equal(swapsToSort([1, 0, 3, 2]), 2, "two disjoint transpositions");
});

// ── Wikitile ─────────────────────────────────────────────────────────────────

test("the scramble is the same board for everyone, and a different one tomorrow", () => {
  const a = tiles.scrambleFor("2026-07-30");
  const b = tiles.scrambleFor("2026-07-30");
  assert.deepEqual(a, b, "nobody stores the board, so it has to be reproducible");
  assert.notDeepEqual(a, tiles.scrambleFor("2026-07-31"), "a new day is a new scramble");
});

test("no tile starts already finished, and most start away from home", () => {
  for (let d = 1; d <= 28; d++) {
    const day = `2026-08-${String(d).padStart(2, "0")}`;
    const { slots, rot } = tiles.scrambleFor(day);
    let home = 0;
    for (let i = 0; i < tiles.TILES; i++) {
      assert.ok(!(slots[i] === i && rot[i] === 0), `${day}: tile ${i} is done before the player starts`);
      if (slots[i] === i) home++;
    }
    assert.ok(home <= tiles.MAX_SETTLED, `${day}: ${home} tiles begin in place`);
  }
});

// The moves a perfect player would make: put every tile home, then turn each one
// upright. Used below to prove par is reachable — a par nobody can hit would
// make every board on the leaderboard read as a failure.
function perfectTileMoves(st) {
  const slots = [...st.slots];
  const moves = [];
  for (let i = 0; i < slots.length; i++) {
    while (slots[i] !== i) {
      const j = slots.indexOf(i);
      moves.push({ type: "swap", a: i, b: j });
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
  }
  // Rotations come last, when every tile is home and its slot index and its own
  // index are therefore the same number. Rotation travels with the tile, so
  // turning them earlier would cost exactly the same.
  st.rot.forEach((r, tile) => {
    for (let n = 0; n < (4 - r) % 4; n++) moves.push({ type: "rotate", slot: tile });
  });
  return moves;
}

test("par is reachable: solving perfectly takes exactly par moves", () => {
  const puzzle = tiles.buildPuzzle("2026-07-30");
  assert.ok(puzzle, "the fixture pool should yield a puzzle");
  const st = tiles.freshState(puzzle);
  const moves = perfectTileMoves(st);
  assert.equal(moves.length, puzzle.par, "par has to be a score somebody can post");
  for (const m of moves) assert.ok(tiles.applyMove(st, m), `refused ${JSON.stringify(m)}`);
  assert.ok(tiles.isSolved(st), "and those moves have to actually solve it");
});

test("a player's board is a copy, not the shared puzzle", () => {
  const puzzle = tiles.buildPuzzle("2026-07-30");
  const mine = tiles.freshState(puzzle);
  tiles.applyMove(mine, { type: "swap", a: 0, b: 1 });
  // The puzzle object is cached for the whole day and handed to every player,
  // so a first move that reached it would scramble everyone else's board.
  assert.deepEqual(tiles.freshState(puzzle).slots, puzzle.start.slots);
  assert.notDeepEqual(mine.slots, puzzle.start.slots);
});

test("a malformed move changes nothing and is not counted", () => {
  const puzzle = tiles.buildPuzzle("2026-07-30");
  const st = tiles.freshState(puzzle);
  const before = { slots: [...st.slots], rot: [...st.rot] };

  for (const bad of [null, {}, { type: "rotate" }, { type: "rotate", slot: 16 }, { type: "rotate", slot: -1 },
                     { type: "swap", a: 0 }, { type: "swap", a: 0, b: 0 }, { type: "swap", a: 0, b: 99 },
                     { type: "teleport", a: 0, b: 1 }, { type: "rotate", slot: "0" }]) {
    assert.equal(tiles.applyMove(st, bad), false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual({ slots: st.slots, rot: st.rot }, before);
  assert.equal(st.moves, 0, "a rejected move must not cost one");
});

// ── Wikimatch ────────────────────────────────────────────────────────────────

test("every caption starts under the wrong picture", () => {
  for (let d = 1; d <= 28; d++) {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    const order = match.orderFor(day);
    assert.equal(order.length, match.COUNT);
    assert.deepEqual([...order].sort((a, b) => a - b), [...Array(match.COUNT).keys()], "a permutation");
    order.forEach((slot, title) =>
      assert.notEqual(slot, title, `${day}: caption ${title} is already right when the page loads`)
    );
  }
});

// The swaps a player who knew all nine would make.
function perfectMatchSwaps(puzzle) {
  const assign = [...Array(puzzle.count).keys()];
  const target = [];
  puzzle.order.forEach((slot, title) => (target[slot] = title));
  const swaps = [];
  for (let i = 0; i < assign.length; i++) {
    while (assign[i] !== target[i]) {
      const j = assign.indexOf(target[i]);
      swaps.push([i, j]);
      [assign[i], assign[j]] = [assign[j], assign[i]];
    }
  }
  return swaps;
}

test("par is reachable, and a swapped-back-and-forth solve is not free", () => {
  const puzzle = match.buildPuzzle("2026-07-30");
  assert.ok(puzzle, "the fixture pool should yield a puzzle");

  const st = match.freshState();
  assert.equal(match.isSolved(st, puzzle), false, "nothing is solved before a swap");

  const swaps = perfectMatchSwaps(puzzle);
  assert.equal(swaps.length, puzzle.par, "par has to be a score somebody can post");
  for (const [a, b] of swaps) assert.ok(match.applySwap(st, a, b));
  assert.ok(match.isSolved(st, puzzle));
  assert.equal(st.moves, puzzle.par);
});

test("a caption cannot be swapped with itself", () => {
  const st = match.freshState();
  assert.equal(match.applySwap(st, 2, 2), false);
  assert.equal(match.applySwap(st, 0, match.COUNT), false);
  assert.equal(match.applySwap(st, -1, 3), false);
  assert.equal(match.applySwap(st, 1.5, 3), false);
  assert.equal(st.moves, 0, "a rejected swap must not cost one");
});

// ── Over HTTP ────────────────────────────────────────────────────────────────

let srv;
before(async () => {
  // The picture dailies spend one request per move, and this file solves both
  // games several times over from one address. The budgets are what hardening
  // tests; here they would only make the suite flaky.
  srv = await helpers.startTestServer({ rateLimit: { api: 100000, dailyMoves: 100000 } });
});
after(async () => { await srv.close(); });

const getJson = async (path, cookie) => JSON.parse((await helpers.get(srv.port, path, cookie)).body);

test("both picture dailies refuse anyone without an identity", async () => {
  assert.equal((await helpers.get(srv.port, "/api/daily/tiles")).status, 401);
  assert.equal((await helpers.get(srv.port, "/api/daily/match")).status, 401);
});

test("the hub lists all three of today's puzzles", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Browser");
  const hub = await getJson("/api/daily", cookie);
  assert.deepEqual(hub.games.map((g) => g.id), ["wikidle", "tiles", "match"]);
  for (const g of hub.games) {
    assert.equal(g.available, true, `${g.id} should be playable against the fixture pool`);
    assert.equal(g.played, false, "a player who has not finished anything has played nothing");
    assert.ok(g.path && g.unit && g.unitOne, `${g.id} needs somewhere to go and a unit to be scored in`);
  }
});

test("the tile board arrives scrambled, without saying what the picture is", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Tiler");
  const st = await getJson("/api/daily/tiles", cookie);

  assert.equal(st.slots.length, tiles.TILES);
  assert.equal(st.grid, tiles.GRID);
  assert.equal(st.moves, 0);
  assert.ok(st.image, "the picture is the puzzle, so it does go out");
  assert.equal(st.answer, null, "what it is, does not — until it is solved");
  assert.equal(st.url, null);
  assert.ok(st.par > 0);
});

test("a rotate is one move, and the fourth brings the tile back", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Spinner");
  const before = await getJson("/api/daily/tiles", cookie);
  const tile = before.slots[0];

  let st = before;
  for (let i = 1; i <= 4; i++) {
    const res = await helpers.postJson(srv.port, "/api/daily/tiles/move", { type: "rotate", slot: 0 }, cookie);
    st = JSON.parse(res.body);
    assert.equal(st.moves, i, "one request, one move");
    assert.equal(st.rot[tile], (before.rot[tile] + i) % 4);
  }
  assert.deepEqual(st.slots, before.slots, "turning a tile does not move it");
});

test("a swap moves the tiles and their rotations together", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Swapper");
  const before = await getJson("/api/daily/tiles", cookie);

  const res = await helpers.postJson(srv.port, "/api/daily/tiles/move", { type: "swap", a: 0, b: 5 }, cookie);
  const st = JSON.parse(res.body);
  assert.equal(st.moves, 1);
  assert.equal(st.slots[0], before.slots[5]);
  assert.equal(st.slots[5], before.slots[0]);
  // Rotation is indexed by tile, not by slot: a tile carries its facing with it,
  // which is what a physical tile does and what par assumes.
  assert.deepEqual(st.rot, before.rot);
});

test("a move the server won't accept costs neither a move nor the round", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Fumbler");
  await getJson("/api/daily/tiles", cookie);

  const res = await helpers.postJson(srv.port, "/api/daily/tiles/move", { type: "swap", a: 0, b: 0 }, cookie);
  assert.equal(res.status, 400);
  const st = await getJson("/api/daily/tiles", cookie);
  assert.equal(st.moves, 0);
  assert.equal(st.done, false);
});

test("solving the tiles scores the moves the server counted, and closes the round", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Finisher");
  const start = await getJson("/api/daily/tiles", cookie);

  // Two wasted moves first, so a score that merely echoed par would pass and a
  // score that counted requests would not.
  const tile = start.slots[0];
  const waste = [{ type: "rotate", slot: 0 }, { type: "rotate", slot: 0 }];
  const moves = [...waste, ...perfectTileMoves({ slots: start.slots, rot: start.rot })];

  let st = null;
  for (const m of moves) {
    const res = await helpers.postJson(srv.port, "/api/daily/tiles/move", m, cookie);
    assert.equal(res.status, 200, `refused ${JSON.stringify(m)}`);
    st = JSON.parse(res.body);
  }
  // perfectTileMoves was handed the ORIGINAL board, so the two wasted turns are
  // still on that one tile and have to be turned back out — two more moves.
  for (let n = 0; n < 4 && !st.done; n++) {
    const slot = st.slots.indexOf(tile);
    const res = await helpers.postJson(srv.port, "/api/daily/tiles/move", { type: "rotate", slot }, cookie);
    st = JSON.parse(res.body);
  }

  assert.equal(st.done, true);
  assert.ok(st.score > start.par, "wasted moves have to show up in the score");
  assert.equal(st.score, st.moves, "the score is what the server counted");
  assert.ok(st.answer, "now it can say what the picture was");
  assert.match(st.url, /^https:\/\/en\.wikipedia\.org\/wiki\//);

  const again = await helpers.postJson(srv.port, "/api/daily/tiles/move", { type: "rotate", slot: 0 }, cookie);
  assert.equal(again.status, 409, "the round is over");

  const board = await getJson("/api/daily/tiles/leaderboard", cookie);
  assert.equal(board.unit, "moves");
  assert.ok(board.me, "a player who finished gets their own placing back");
  assert.equal(board.me.score, st.score);
});

test("the matchup ships pictures and titles with nothing joining them", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Matcher");
  const st = await getJson("/api/daily/match", cookie);

  assert.equal(st.images.length, match.COUNT);
  assert.equal(st.titles.length, match.COUNT);
  assert.deepEqual(st.assign, [...Array(match.COUNT).keys()], "everyone starts from the same arrangement");
  // The pairing IS the answer. Anything that leaks the pool order — the draw's
  // page ids, the title order it was built from — hands it over wholesale.
  assert.equal(st.order, undefined);
  assert.equal(st.pageIds, undefined);
  assert.equal(st.urls, null, "nine article links would name the nine pictures");
});

test("solving the matchup scores the swaps the server counted", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Sorter");
  const start = await getJson("/api/daily/match", cookie);
  const puzzle = match.puzzleFor();

  // One wasted swap and its undo, so the score cannot merely be par.
  const swaps = [[0, 1], [0, 1], ...perfectMatchSwaps(puzzle)];
  let st = null;
  for (const [a, b] of swaps) {
    const res = await helpers.postJson(srv.port, "/api/daily/match/swap", { a, b }, cookie);
    assert.equal(res.status, 200);
    st = JSON.parse(res.body);
  }

  assert.equal(st.done, true);
  assert.equal(st.score, start.par + 2, "the two wasted swaps are on the scorecard");
  assert.equal(st.score, st.moves);
  assert.equal(st.urls.length, match.COUNT, "solved, so the captions can link out");
  // Solved means every caption is where it belongs.
  st.assign.forEach((title, slot) => assert.equal(puzzle.order[title], slot));

  const again = await helpers.postJson(srv.port, "/api/daily/match/swap", { a: 0, b: 1 }, cookie);
  assert.equal(again.status, 409);
});

test("each game keeps its own board", async () => {
  const { cookie } = await helpers.guestSession(srv.port, "Solo");
  const puzzle = match.puzzleFor();
  for (const [a, b] of perfectMatchSwaps(puzzle)) {
    await helpers.postJson(srv.port, "/api/daily/match/swap", { a, b }, cookie);
  }

  const mine = await getJson("/api/daily/match/leaderboard", cookie);
  assert.ok(mine.me, "the player is on the game they finished");
  assert.equal(mine.unit, "swaps");

  const other = await getJson("/api/daily/wikidle/leaderboard", cookie);
  assert.equal(other.me, null, "and not on one they never played");
  assert.equal(other.leaderboard.some((r) => r.name === mine.me.name), false);

  const hub = await getJson("/api/daily", cookie);
  assert.deepEqual(hub.games.map((g) => g.played), [false, false, true]);
});

test("a game nobody has heard of has no board", async () => {
  const res = await helpers.get(srv.port, "/api/daily/sudoku/leaderboard");
  assert.equal(res.status, 404);
});

// ── Budgets ──────────────────────────────────────────────────────────────────

test("move traffic has its own budget and does not spend the API's", async () => {
  // Its own server: spending a limiter's budget is destructive, so it must not
  // leak into the other tests here.
  const local = await helpers.startTestServer({ rateLimit: { windowMs: 60_000, api: 20, dailyMoves: 2 } });
  try {
    const { cookie } = await helpers.guestSession(local.port, "Masher");
    await helpers.get(local.port, "/api/daily/tiles", cookie);

    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = await helpers.postJson(local.port, "/api/daily/tiles/move", { type: "rotate", slot: 0 }, cookie);
      codes.push(res.status);
    }
    assert.deepEqual(codes, [200, 200, 429], "moves are throttled on their own budget");

    // The point of the split: a player who has just spent their move budget can
    // still load a page, and a hundred moves cannot lock them out of the API.
    assert.equal((await helpers.get(local.port, "/api/daily/tiles", cookie)).status, 200);
  } finally {
    await local.close();
  }
});
