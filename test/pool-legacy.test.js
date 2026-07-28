"use strict";

// Behaviour against a pool built BEFORE categories existed — no `categories`
// column at all.
//
// This is the real upgrade path: the code ships, the box reboots, and the 900 MB
// artifact on the data volume is still the old one until someone rebuilds and
// re-uploads it. The failure that matters is not "categories don't work" — it is
// that categoryCounts() is called from /api/config on every single page load, so
// an unhandled SQLITE_ERROR there takes the whole site down over a picker that
// could perfectly well have rendered without counts.
//
// Lives in its own file because pool.js caches its database handle at module
// scope; a second pool needs a second process.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const Database = require("better-sqlite3");

const dir = path.join(os.tmpdir(), "wg-pool-legacy-" + crypto.randomBytes(5).toString("hex"));
fs.mkdirSync(dir, { recursive: true });
const poolFile = path.join(dir, "mysteries.sqlite");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = dir;
process.env.MYSTERY_DB = poolFile;

before(() => {
  const db = new Database(poolFile);
  db.exec(`
    CREATE TABLE mysteries (
      page_id INTEGER PRIMARY KEY, title TEXT NOT NULL,
      image_name TEXT, image_url TEXT, opening_text TEXT, freq_json TEXT,
      incoming_links INTEGER NOT NULL DEFAULT 0, popularity REAL NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 1, rnd REAL NOT NULL
    );
    CREATE INDEX idx_img_rnd ON mysteries(rnd) WHERE image_url IS NOT NULL;
    CREATE INDEX idx_txt_rnd ON mysteries(rnd) WHERE opening_text IS NOT NULL;
  `);
  const ins = db.prepare(
    "INSERT INTO mysteries (page_id, title, image_url, opening_text, popularity, rnd) VALUES (?,?,?,?,?,?)"
  );
  for (let i = 1; i <= 30; i++) {
    ins.run(i, `Legacy ${i}`, `https://example.invalid/${i}.jpg`, `A description of Legacy ${i}, long enough to use.`, 1.0, i / 100);
  }
  db.close();
});

after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* temp dir */ }
});

const { fetchMystery, categoryCounts, warmCategoryCounts, warmPartyIndex } = require("../server/game/pool");

test("category counts degrade to null instead of throwing", () => {
  assert.equal(categoryCounts(), null);
  assert.equal(warmCategoryCounts(), null);
});

test("the party preload degrades instead of throwing", () => {
  // It selects the categories column too, so it fails the same way — and must
  // leave the SQLite path working rather than take the process down.
  assert.doesNotThrow(() => warmPartyIndex());
});

test("unfiltered rounds still work on an old pool", async () => {
  for (let i = 0; i < 10; i++) {
    const m = await fetchMystery("chaos", new Set(), "image", []);
    assert.match(m.title, /^Legacy /);
  }
});

test("/api/config still serves, with counts simply absent", async () => {
  const { buildServer } = require("../server/app");
  const { server, io, manager } = buildServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const body = await new Promise((resolve, reject) => {
      http
        .get({ host: "localhost", port, path: "/api/config", agent: false, headers: { Connection: "close" } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
        })
        .on("error", reject);
    });

    assert.equal(body.status, 200, "an old pool must not turn every page load into a 500");
    assert.equal(body.json.categoryCounts, null, "counts are absent…");
    assert.ok(Array.isArray(body.json.categories) && body.json.categories.length, "…but the category list still ships");
  } finally {
    manager.shutdown();
    await new Promise((r) => io.close(r));
  }
});
