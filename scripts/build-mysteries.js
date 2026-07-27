"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// build-mysteries.js — one-time offline builder for the local mystery pool.
//
// Reads two Wikimedia dumps and writes a compact SQLite table the game can draw
// rounds from with ZERO live Wikipedia API calls:
//
//   1. CirrusSearch content dump   (…-cirrussearch-content.json.gz)
//        → title, opening_text (clean lead sentences), incoming_links, popularity
//   2. page_props SQL dump         (…-page_props.sql.gz)
//        → page_image_free (the lead-image filename PageImages picked)
//
// The image link is built OFFLINE from the filename via the upload.wikimedia.org
// MD5-path scheme, so we never hit the API for it.
//
// Usage:
//   node scripts/build-mysteries.js \
//     --cirrus path/to/enwiki-YYYYMMDD-cirrussearch-content.json.gz \
//     --props  path/to/enwiki-YYYYMMDD-page_props.sql.gz \
//     --out    data/mysteries.sqlite \
//     [--max-pool <minPopularity>]   # popularity floor; default = chaos tier
//
// --max-pool drops articles below a popularity floor to keep the DB lean (and
// the build fast). The default is the chaos-tier threshold, so party & chaos are
// unchanged and only the rarely-served obscure long tail is dropped; pass
// --max-pool 0 to keep every article (the full ~11GB build).
//
// Both dumps are streamed (gunzip on the fly) — nothing is decompressed to disk,
// so the ~40 GB cirrus dump never becomes ~180 GB on your drive.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const readline = require("readline");
const Database = require("better-sqlite3");
// Reuse the game's own frequency logic so stored freq keys (stemmed, stopword-
// filtered) match exactly what scoreGuess() looks up at runtime.
const { textFreq } = require("../server/game/scoring");
// For the --max-pool default (the chaos-tier popularity floor).
const config = require("../server/config");

// ── Tunables ─────────────────────────────────────────────────────────────────
const MAX_TITLE_WORDS = 3; // keep short, guessable titles (chaos mode uses 2; bump/drop to taste)
const OPENING_MIN = 40; // min chars of opening_text to count as a usable "description" clue
const TITLE_RE = /^[a-zA-ZÀ-ɏ' -]+$/; // letters/spaces/apostrophes/hyphens only (mirrors server/game/wikipedia.js)
const THUMB_WIDTH = 500; // thumbnail width. MUST be an allowed Wikimedia bucket
// (120/250/500/1280/… — arbitrary widths 400 with "use thumbnail sizes listed").
const TOP_FREQ = 60; // keep the N most-frequent article stems for scoring (the rest never score meaningfully)
const COMMIT_EVERY = 50_000; // rows per transaction chunk

// ── Args ─────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CIRRUS = arg("cirrus");
const PROPS = arg("props");
const OUT = path.resolve(arg("out", path.join(__dirname, "..", "data", "mysteries.sqlite")));
// Popularity floor: drop articles below it so the pool (and DB size) stays lean.
// Default = the chaos-tier threshold, so party & chaos are unchanged and only
// the rarely-served obscure long tail is dropped. Pass --max-pool 0 to keep
// every article (the full ~11GB build).
const POOL_FLOOR = parseFloat(arg("max-pool", String(config.tierMinPopularity.chaos))) || 0;

if (!CIRRUS || !PROPS) {
  console.error("Usage: node scripts/build-mysteries.js --cirrus <cirrus.json.gz> --props <page_props.sql.gz> [--out data/mysteries.sqlite] [--max-pool <minPopularity>]");
  process.exit(1);
}
for (const [label, p] of [["cirrus", CIRRUS], ["props", PROPS]]) {
  if (!fs.existsSync(p)) {
    console.error(`--${label} file not found: ${p}`);
    process.exit(1);
  }
}

// ── DB setup ─────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true }); // fresh build each run — this DB is fully derived
const db = new Database(OUT);
// This is a rebuildable, derived artifact, so trade durability for build speed.
db.pragma("journal_mode = OFF");
db.pragma("synchronous = OFF");

db.exec(`
  -- page_id -> lead image filename, from the page_props dump. Dropped after the build.
  CREATE TABLE page_images (
    page_id INTEGER PRIMARY KEY,
    name    TEXT NOT NULL
  );

  -- The final pool the game draws from. Keyed by Wikipedia's page_id.
  CREATE TABLE mysteries (
    page_id        INTEGER PRIMARY KEY,
    title          TEXT NOT NULL,
    image_name     TEXT,          -- raw Commons filename (build other thumb sizes from this)
    image_url      TEXT,          -- ${THUMB_WIDTH}px thumbnail; NULL if the article has no free lead image
    opening_text   TEXT,          -- clean lead sentences; NULL if too short
    freq_json      TEXT,          -- {stem: count} top-${TOP_FREQ} of the full article, for scoreGuess()
    incoming_links INTEGER NOT NULL DEFAULT 0,
    popularity     REAL NOT NULL DEFAULT 0,
    word_count     INTEGER NOT NULL,
    rnd            REAL NOT NULL   -- random [0,1) per row → fast random picks (see pool.js)
  );
`);

// ── Image URL construction (offline, no API) ─────────────────────────────────
// Wikimedia lays files out at commons/<h0>/<h0h1>/<name>, where <h0h1> is the
// first two hex chars of md5(name-with-underscores). Thumbs live under /thumb/.
// Free (page_image_free) images are Commons-hosted, so we target /commons/.
function md5Path(file) {
  const h = crypto.createHash("md5").update(file).digest("hex");
  return { h0: h[0], h01: h.slice(0, 2) };
}
function thumbUrl(name, width = THUMB_WIDTH) {
  const file = String(name).replace(/ /g, "_"); // md5 is over the underscored form
  const { h0, h01 } = md5Path(file);
  const enc = encodeURIComponent(file);
  // Non-raster originals are rendered to a raster thumb with a type-specific name.
  let thumbName = `${width}px-${enc}`;
  if (/\.svg$/i.test(file)) thumbName = `${width}px-${enc}.png`;
  else if (/\.(pdf|djvu|tiff?)$/i.test(file)) thumbName = `page1-${width}px-${enc}.jpg`;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${h0}/${h01}/${enc}/${thumbName}`;
}
// If you'd rather store the full-size original (bigger, but no thumb edge cases):
//   const { h0, h01 } = md5Path(file);
//   return `https://upload.wikimedia.org/wikipedia/commons/${h0}/${h01}/${encodeURIComponent(file)}`;

// ── Streaming helper ─────────────────────────────────────────────────────────
function eachLine(gzPath, onLine) {
  return new Promise((resolve, reject) => {
    const raw = fs.createReadStream(gzPath);
    const gunzip = zlib.createGunzip();
    raw.on("error", reject);
    gunzip.on("error", reject);
    const rl = readline.createInterface({ input: raw.pipe(gunzip), crlfDelay: Infinity });
    rl.on("line", (line) => {
      try {
        onLine(line);
      } catch (err) {
        rl.close();
        reject(err);
      }
    });
    rl.on("close", resolve);
  });
}

// ── Phase 1: page_props → page_images ────────────────────────────────────────
// The dump is a series of `INSERT INTO \`page_props\` VALUES (...),(...);` lines.
// We don't fully parse the SQL — we anchor on the literal 'page_image_free'
// property and pull (page_id, filename) tuples out of each INSERT with a regex.
// The value group tolerates MySQL escapes (\' \\ etc.) so filenames with
// apostrophes survive.
const IMAGE_TUPLE = /\((\d+),'page_image_free','((?:[^'\\]|\\.)*)'/g;

function unescapeSql(s) {
  return s
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

async function loadImages() {
  const insert = db.prepare("INSERT OR IGNORE INTO page_images (page_id, name) VALUES (?, ?)");
  let n = 0;
  db.exec("BEGIN");
  await eachLine(PROPS, (line) => {
    if (!line.startsWith("INSERT INTO")) return;
    let m;
    IMAGE_TUPLE.lastIndex = 0;
    while ((m = IMAGE_TUPLE.exec(line))) {
      insert.run(Number(m[1]), unescapeSql(m[2]));
      if (++n % COMMIT_EVERY === 0) {
        db.exec("COMMIT");
        db.exec("BEGIN");
        process.stdout.write(`\r  page_props: ${n.toLocaleString()} images`);
      }
    }
  });
  db.exec("COMMIT");
  console.log(`\r  page_props: ${n.toLocaleString()} lead images indexed          `);
  return n;
}

// ── Phase 2: cirrus → mysteries ──────────────────────────────────────────────
// The cirrus content dump is Elasticsearch bulk format: alternating lines, a
// header carrying the _id (== page_id) then the document itself. We keep the
// _id from the header and apply it to the following doc.
function cleanTitle(title) {
  return String(title).replace(/\s*\(.*?\)\s*/g, " ").trim(); // drop "(disambiguator)" bits
}

async function buildMysteries() {
  const findImage = db.prepare("SELECT name FROM page_images WHERE page_id = ?");
  const insert = db.prepare(`
    INSERT OR IGNORE INTO mysteries
      (page_id, title, image_name, image_url, opening_text, freq_json, incoming_links, popularity, word_count, rnd)
    VALUES (@page_id, @title, @image_name, @image_url, @opening_text, @freq_json, @incoming_links, @popularity, @word_count, @rnd)
  `);

  let pendingId = null;
  let seen = 0;
  let kept = 0;
  db.exec("BEGIN");

  await eachLine(CIRRUS, (line) => {
    // Header line: grab the page_id, wait for the doc on the next line.
    if (line.startsWith('{"index"')) {
      const header = JSON.parse(line);
      pendingId = header.index && header.index._id != null ? Number(header.index._id) : null;
      return;
    }
    const id = pendingId;
    pendingId = null;
    if (id == null) return;

    const doc = JSON.parse(line);
    if (doc.namespace !== 0) return; // articles only — no talk/category/template pages
    if (++seen % COMMIT_EVERY === 0) {
      db.exec("COMMIT");
      db.exec("BEGIN");
      process.stdout.write(`\r  cirrus: ${seen.toLocaleString()} articles scanned, ${kept.toLocaleString()} kept`);
    }

    // Popularity floor first — this is the cheapest possible reject and skips the
    // (expensive) freq computation for everything below the floor.
    const popularity = Number(doc.popularity_score) || 0;
    if (popularity < POOL_FLOOR) return;

    const title = cleanTitle(doc.title || "");
    if (!title) return;
    if (/^(list|index) of\b/i.test(title)) return; // list/index pages aren't guessable
    const words = title.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > MAX_TITLE_WORDS) return;
    if (!TITLE_RE.test(title)) return; // no digits/punctuation-heavy titles

    const opening = (doc.opening_text || "").trim();
    const usableText = opening.length >= OPENING_MIN ? opening : null;

    const imgRow = findImage.get(id);
    const imageName = imgRow ? imgRow.name : null;
    const imageUrl = imageName ? thumbUrl(imageName) : null;

    // Must be playable in at least one mode: has an image OR has usable text.
    if (!imageUrl && !usableText) return;

    // Article-hit frequency table for the scorer, from the full plaintext (cirrus
    // `text`), falling back to the opening if absent. Keep only the top stems.
    const freq = textFreq(doc.text || opening || "");
    let freqJson = null;
    if (freq.size) {
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_FREQ);
      freqJson = JSON.stringify(Object.fromEntries(top));
    }

    insert.run({
      page_id: id,
      title,
      image_name: imageName,
      image_url: imageUrl,
      opening_text: usableText,
      freq_json: freqJson,
      incoming_links: Number(doc.incoming_links) || 0,
      popularity,
      word_count: words.length,
      rnd: Math.random(),
    });
    kept++;
  });

  db.exec("COMMIT");
  console.log(`\r  cirrus: ${seen.toLocaleString()} articles scanned, ${kept.toLocaleString()} kept          `);
  return kept;
}

// ── Finalize ─────────────────────────────────────────────────────────────────
function finalize() {
  console.log("  finalizing…");
  db.exec("DROP TABLE page_images;"); // only needed during the join
  // Partial indexes on the random column: pool.js walks rnd ascending from a
  // random point and takes the first row passing the tier's popularity
  // threshold, so a pick scans ~1/selectivity rows instead of sorting the whole
  // set. idx_links is kept for offline analysis (tiers filter on popularity).
  db.exec(`
    CREATE INDEX idx_links   ON mysteries(incoming_links DESC);
    CREATE INDEX idx_img_rnd ON mysteries(rnd) WHERE image_url IS NOT NULL;
    CREATE INDEX idx_txt_rnd ON mysteries(rnd) WHERE opening_text IS NOT NULL;
  `);
  db.exec("VACUUM;");

  const total = db.prepare("SELECT COUNT(*) c FROM mysteries").get().c;
  const withImg = db.prepare("SELECT COUNT(*) c FROM mysteries WHERE image_url IS NOT NULL").get().c;
  const withText = db.prepare("SELECT COUNT(*) c FROM mysteries WHERE opening_text IS NOT NULL").get().c;
  console.log(`\n  Pool: ${total.toLocaleString()} mysteries  (${withImg.toLocaleString()} with image, ${withText.toLocaleString()} with text)`);

  // Suggested guessability tiers by popularity percentile (the metric pool.js
  // filters on). Computed with one streaming scan + an in-place numeric sort.
  const pops = new Float64Array(total);
  let pi = 0;
  for (const r of db.prepare("SELECT popularity FROM mysteries").iterate()) pops[pi++] = r.popularity || 0;
  pops.sort(); // ascending
  console.log("  Popularity tiers (set PARTY_MIN_POP / CHAOS_MIN_POP):");
  for (const f of [0.001, 0.01, 0.05, 0.1, 0.2]) {
    const v = pops[Math.min(total - 1, Math.floor(total * (1 - f)))];
    console.log(`    top ${(f * 100).toFixed(1).padStart(4)}% (~${Math.floor(total * f).toLocaleString()} articles): popularity ≥ ${v.toExponential(3)}`);
  }
  console.log(`\n  Wrote ${OUT}`);
}

(async () => {
  const t0 = Date.now();
  console.log(`Building mystery pool → ${OUT}`);
  console.log(
    POOL_FLOOR > 0
      ? `  --max-pool: keeping articles with popularity ≥ ${POOL_FLOOR.toExponential(3)} (lean build)\n`
      : `  --max-pool 0: keeping ALL articles (full build)\n`
  );
  await loadImages();
  await buildMysteries();
  finalize();
  db.close();
  console.log(`  Done in ${Math.round((Date.now() - t0) / 1000)}s`);
})().catch((err) => {
  console.error("\nBuild failed:", err);
  db.close();
  process.exit(1);
});
