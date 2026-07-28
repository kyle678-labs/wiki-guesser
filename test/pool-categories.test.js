"use strict";

// Category filtering in the offline pool.
//
// Built against a small synthetic pool rather than the real 900 MB artifact, so
// this runs in CI and on a laptop with no dump. The row shapes and indexes match
// what scripts/build-mysteries.js produces.
//
// The query-plan test is the important one. A category filter that falls back to
// a table scan still returns correct rows, so nothing about the failure is
// visible from the results — but because better-sqlite3 is synchronous, the scan
// would block the event loop for every room on the box. The only way to catch
// that regression is to assert the plan.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const { CATEGORIES, BIT } = require("../server/game/categories");

const dir = path.join(os.tmpdir(), "wg-pool-cat-" + crypto.randomBytes(5).toString("hex"));
fs.mkdirSync(dir, { recursive: true });
const poolFile = path.join(dir, "mysteries.sqlite");

// Must be set before server/config is first required.
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = dir;
process.env.MYSTERY_DB = poolFile;
// Exercise the SQLite path; the in-memory party index is covered separately.
process.env.PRELOAD_PARTY = "false";

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
  for (const c of CATEGORIES) {
    db.exec(
      `CREATE INDEX idx_cat_${c}_img ON mysteries(rnd) WHERE (categories & ${BIT[c]}) != 0 AND image_url IS NOT NULL;
       CREATE INDEX idx_cat_${c}_txt ON mysteries(rnd) WHERE (categories & ${BIT[c]}) != 0 AND opening_text IS NOT NULL;`
    );
  }

  const ins = db.prepare(
    `INSERT INTO mysteries (page_id, title, image_url, opening_text, popularity, categories, rnd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let id = 1;
  const add = (title, cats, pop = 1.0) =>
    ins.run(id, title, `https://example.invalid/${id}.jpg`, `A description of ${title} that is comfortably long enough.`, pop, cats, (id++ % 100) / 100);

  for (let i = 0; i < 20; i++) add(`Otter ${i}`, BIT.nature);
  for (let i = 0; i < 20; i++) add(`Film ${i}`, BIT.film);
  for (let i = 0; i < 5; i++) add(`Footballer ${i}`, BIT.people | BIT.sport);
  // Unclassified: only ever served when no category filter is applied.
  for (let i = 0; i < 20; i++) add(`Concept ${i}`, 0);
  // A category present in chaos but NOT at the party floor, to exercise the
  // widening. Popularity sits between the two thresholds; anything below the
  // chaos floor would have been dropped by the builder and never reach the pool.
  for (let i = 0; i < 3; i++) add(`Obscure game ${i}`, BIT.games, 1e-6);
  db.close();
});

after(() => {
  // Windows can still hold the pool file for a moment after close, and a
  // tidy-up failure must not be reported as a test failure.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* temp dir */ }
});

const { fetchMystery, pickFromIndex, categoryCounts } = require("../server/game/pool");

// ── Filtering ────────────────────────────────────────────────────────────────

test("a category filter only ever returns articles in that category", async () => {
  for (let i = 0; i < 30; i++) {
    const m = await fetchMystery("chaos", new Set(), "image", ["nature"]);
    assert.match(m.title, /^Otter /, `got "${m.title}" while filtering on nature`);
  }
});

test("several categories are an OR, not an AND", async () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const m = await fetchMystery("chaos", new Set(), "image", ["nature", "film"]);
    assert.match(m.title, /^(Otter|Film) /, `got "${m.title}"`);
    seen.add(m.title.split(" ")[0]);
  }
  assert.deepEqual([...seen].sort(), ["Film", "Otter"], "both categories must actually appear");
});

test("an article in two categories is found by either", async () => {
  for (const cat of ["people", "sport"]) {
    const m = await fetchMystery("chaos", new Set(), "image", [cat]);
    assert.match(m.title, /^Footballer /, `filtering on ${cat}`);
  }
});

test("no category filter draws from everything, including unclassified articles", async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const m = await fetchMystery("chaos", new Set(), "image", []);
    seen.add(m.title.split(" ")[0]);
  }
  assert.ok(seen.has("Concept"), "unclassified articles must still be playable when unfiltered");
});

test("already-used pages are not served twice in one game", async () => {
  const used = new Set();
  const titles = new Set();
  for (let i = 0; i < 15; i++) {
    const m = await fetchMystery("chaos", used, "image", ["nature"]);
    assert.ok(!titles.has(m.title), `"${m.title}" was served twice`);
    titles.add(m.title);
  }
});

// ── Fallbacks ────────────────────────────────────────────────────────────────

test("a category thin at the party floor widens the tier before abandoning the category", async () => {
  // "Obscure game" exists only far below the party floor. The player asked for
  // games, so a more obscure game is a better answer than a famous non-game.
  for (let i = 0; i < 10; i++) {
    const m = await fetchMystery("party", new Set(), "image", ["games"]);
    assert.match(m.title, /^Obscure game /, `got "${m.title}"`);
  }
});

test("an exhausted category widens rather than failing the round", async () => {
  // Every game article already used: the round must still produce something.
  const probe = new Database(poolFile, { readonly: true });
  const gameIds = probe
    .prepare(`SELECT page_id FROM mysteries WHERE (categories & ${BIT.games}) != 0`)
    .all()
    .map((r) => r.page_id);
  probe.close();
  assert.ok(gameIds.length, "fixture sanity: there should be game rows to exhaust");

  const used = new Set(gameIds);
  const m = await fetchMystery("chaos", used, "image", ["games"]);
  assert.ok(m && m.title, "a round must never fail just because a category ran dry");
  assert.doesNotMatch(m.title, /^Obscure game /);
});

// ── The in-memory party index ────────────────────────────────────────────────

test("the in-memory index respects the mask and never repeats a used page", () => {
  const rows = [
    { page_id: 1, categories: BIT.nature },
    { page_id: 2, categories: BIT.film },
    { page_id: 3, categories: BIT.nature | BIT.people },
  ];
  for (let i = 0; i < 40; i++) {
    const r = pickFromIndex(rows, new Set(), BIT.nature);
    assert.ok(r.page_id === 1 || r.page_id === 3);
  }
  assert.equal(pickFromIndex(rows, new Set([1, 3]), BIT.nature), null, "no unused row left in that category");
  assert.equal(pickFromIndex(rows, new Set(), BIT.games), null, "category absent from the index");
});

// ── Query plan ───────────────────────────────────────────────────────────────

test("a category-filtered pick uses the partial index instead of scanning", () => {
  const db = new Database(poolFile, { readonly: true });
  try {
    const inlined = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT page_id FROM mysteries
          WHERE image_url IS NOT NULL AND (categories & ${BIT.nature}) != 0
            AND popularity >= ? AND rnd >= ? ORDER BY rnd LIMIT 1`
      )
      .all(0, 0) // popularity, rnd — EXPLAIN still binds the statement's params
      .map((r) => r.detail)
      .join(" | ");
    assert.match(inlined, /USING INDEX idx_cat_nature_img/, `planner chose: ${inlined}`);
    assert.doesNotMatch(inlined, /SCAN mysteries(?! USING)/, "must not be a table scan");
  } finally {
    db.close();
  }
});

// ── Counts ───────────────────────────────────────────────────────────────────

test("category counts report per tier and clue", () => {
  const counts = categoryCounts();
  assert.ok(counts, "a pool exists, so counts must be available");
  assert.equal(counts.chaos.image.nature, 20);
  assert.equal(counts.chaos.image.film, 20);
  assert.equal(counts.chaos.image.people, 5);
  assert.equal(counts.chaos.image.sport, 5, "a two-category article counts under both");
  // Obscure games sit below the party floor, so they vanish at that tier.
  assert.equal(counts.chaos.image.games, 3);
  assert.equal(counts.party.image.games, 0);
  // Unclassified articles belong to no category and so are counted nowhere.
  const total = CATEGORIES.reduce((n, c) => n + counts.chaos.image[c], 0);
  assert.equal(total, 20 + 20 + 5 + 5 + 3, "unclassified rows must not inflate any category");
});
