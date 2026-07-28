"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Offline mystery source. Drop-in replacement for game/wikipedia.js's
// fetchMystery(): same signature, same returned shape, but every round is a
// local SQLite read from the pool built by scripts/build-mysteries.js — zero
// Wikipedia API calls at runtime.
// ────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const Database = require("better-sqlite3");
const config = require("../config");
const log = require("../log");
const { titleWords } = require("./scoring");
const { buildClue } = require("./extract");
const { CATEGORIES, BIT, maskFor } = require("./categories");

let db = null;
const stmtCache = new Map();

// ── Party-tier in-memory index ───────────────────────────────────────────────
// pickRow walks the `rnd` index until it finds a row clearing the tier's
// popularity floor. For chaos that floor equals the pool's own floor, so the
// first row almost always matches (~2.6 ms measured). For party the floor
// admits roughly 1 row in 80, so SQLite scans far more index entries — measured
// at 7.9 ms p50 and 33 ms p99 against the lean pool.
//
// Every one of those milliseconds blocks the whole event loop, for every room,
// because better-sqlite3 is synchronous. The party tier is only ~5.4k rows
// (~21 MB of heap), so holding it in memory turns the app's single most
// expensive recurring operation into an array index.
//
// Chaos is deliberately NOT cached: it is the entire ~436k-row pool, it would
// not fit in the box's memory budget, and it is already fast.
let partyIndex = null; // { image: [...rows], text: [...rows] } once loaded

// Guard against a misconfigured PARTY_MIN_POP pulling the whole pool into RAM.
const PARTY_PRELOAD_MAX_ROWS = parseInt(process.env.PARTY_PRELOAD_MAX_ROWS, 10) || 50000;
const PRELOAD_ENABLED = process.env.PRELOAD_PARTY !== "false";

// Opened lazily on first fetch, so requiring this module (e.g. in tests that
// inject their own fetchMystery) never touches the filesystem.
function open() {
  if (db) return db;
  if (!fs.existsSync(config.mysteryDb)) {
    throw new Error(
      `Mystery pool not found at ${config.mysteryDb}.\n` +
        `Build it once with:\n` +
        `  node scripts/build-mysteries.js --cirrus <…-cirrussearch-content.json.gz> --props <…-page_props.sql.gz>`
    );
  }
  db = new Database(config.mysteryDb, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

// Random row matching the clue type + link threshold, excluding this game's
// already-used page_ids. Statements are cached per (column, exclusion size)
// since the NOT IN list length varies round to round.
//
// Fast random pick: every row has a random rnd ∈ [0,1) with a partial index
// per clue. We start at a random rnd and take the first indexed row that also
// clears the tier's popularity threshold — SQLite walks ~1/selectivity rows, not
// the whole set (no ORDER BY RANDOM full scan). If we started past the last
// match, wrap to 0.
// `mask` is a category bitmask; 0 means no category filter.
//
// The mask is inlined into the SQL rather than bound, so each category gets its
// own prepared statement and therefore its own query plan matched to that
// category's selectivity. Safe because the mask is computed from an allowlist
// (see categories.js) and can only ever be an integer — it never contains user
// text.
//
// Worth knowing before "simplifying" this to a bound `?`: that also works.
// Measured on a 200k-row pool where the target category was 0.2% of rows, both
// forms chose the same partial index and ran within 3% of each other. The
// inlined form is kept for the per-category plan, not because binding is broken.
function pickRow(clue, minPop, used, mask = 0) {
  open();
  const col = clue === "text" ? "opening_text" : "image_url";
  const key = `${col}:${used.size}:${mask}`;
  let stmt = stmtCache.get(key);
  if (!stmt) {
    const excl = used.size ? ` AND page_id NOT IN (${Array(used.size).fill("?").join(",")})` : "";
    const cat = mask ? ` AND (categories & ${mask}) != 0` : "";
    stmt = db.prepare(
      `SELECT page_id, title, image_url, opening_text, freq_json FROM mysteries ` +
        `WHERE ${col} IS NOT NULL${cat} AND popularity >= ? AND rnd >= ?${excl} ORDER BY rnd LIMIT 1`
    );
    stmtCache.set(key, stmt);
  }
  const r = Math.random();
  return stmt.get(minPop, r, ...used) || stmt.get(minPop, 0, ...used);
}

// Reconstruct the exact object game/wikipedia.js produced, so rooms.js and the
// scorer are unchanged. freq_json → the Map<stem, count> scoreGuess() expects.
function rowToMystery(row) {
  const title = row.title;
  const freq = row.freq_json ? new Map(Object.entries(JSON.parse(row.freq_json))) : new Map();
  const clue = row.opening_text ? buildClue(row.opening_text, title, 2) : { full: "", blanked: "" };
  return {
    title,
    words: titleWords(title),
    img: row.image_url || null,
    desc: "",
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")),
    extract: clue.blanked, // shown as the clue (title blanked) in text mode
    extractFull: clue.full, // revealed after the round
    freq, // server-only
  };
}

// Load the party tier into memory. Costs ~1.2 s and ~21 MB, so it is done once
// at startup rather than lazily — paying it on the first party round would
// stall the event loop mid-game for over a second.
//
// Safe to call more than once, and safe to call when there is no pool on disk:
// it reports the failure and leaves the SQLite path in place.
function warmPartyIndex() {
  if (!PRELOAD_ENABLED || partyIndex) return partyIndex;
  try {
    open();
    const minPop = config.tierMinPopularity.party;
    const n = db.prepare("SELECT COUNT(*) AS n FROM mysteries WHERE popularity >= ?").get(minPop).n;
    if (n > PARTY_PRELOAD_MAX_ROWS) {
      log.warn("party_preload_skipped", { rows: n, max: PARTY_PRELOAD_MAX_ROWS });
      return null;
    }
    const started = Date.now();
    const rows = db
      .prepare("SELECT page_id, title, image_url, opening_text, freq_json, categories FROM mysteries WHERE popularity >= ?")
      .all(minPop);
    partyIndex = {
      image: rows.filter((r) => r.image_url != null),
      text: rows.filter((r) => r.opening_text != null),
    };
    log.info("party_preloaded", {
      rows: rows.length,
      image: partyIndex.image.length,
      text: partyIndex.text.length,
      ms: Date.now() - started,
      heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    });
  } catch (err) {
    // Not fatal: every party pick just falls through to the SQLite path.
    log.warn("party_preload_failed", { err });
    partyIndex = null;
  }
  return partyIndex;
}

// Uniform random pick excluding this game's already-used pages. `used` holds at
// most one entry per round, so a random probe succeeds almost immediately; the
// scan is only there to stay correct in the degenerate case.
function pickFromIndex(rows, used, mask = 0) {
  if (!rows || rows.length === 0) return null;
  const usable = (row) => !used.has(row.page_id) && (!mask || (row.categories & mask) !== 0);
  for (let i = 0; i < 20; i++) {
    const row = rows[Math.floor(Math.random() * rows.length)];
    if (usable(row)) return row;
  }
  // A narrow category can make the random probes miss every time, so the scan
  // below is the real path rather than a formality. It is a walk over ~5k
  // in-memory rows, which is still far cheaper than going back to SQLite.
  const start = Math.floor(Math.random() * rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[(start + i) % rows.length];
    if (usable(row)) return row;
  }
  return null;
}

// tier: "party" | "chaos"; clue: "image" | "text" ("mixed" is resolved upstream
// in rooms.js). `used` is the game's Set of page_ids so far.
// `categories` is an array of category keys; empty (the default) means anything.
async function fetchMystery(tier = "party", used = new Set(), clue = "image", categories = []) {
  const tiers = config.tierMinPopularity;
  const minPop = tiers[tier] != null ? tiers[tier] : tiers.party;
  const mask = maskFor(categories);

  let row = null;
  if (tier === "party" && partyIndex) row = pickFromIndex(partyIndex[clue] || partyIndex.image, used, mask);
  if (!row) row = pickRow(clue, minPop, used, mask);
  // Tier exhausted (a long game on a narrow category, or too strict a
  // threshold)? Drop the popularity floor before dropping the category — the
  // players explicitly asked for animals, so a more obscure animal is a much
  // better answer than a famous something-else.
  if (!row && minPop > 0) row = pickRow(clue, 0, used, mask);
  // Only if the category itself is exhausted do we widen it, rather than fail
  // the round outright.
  if (!row && mask) row = pickRow(clue, 0, used, 0);
  if (!row) throw new Error("No mystery available from the local pool");
  used.add(row.page_id);
  return rowToMystery(row);
}

// ── Category counts ──────────────────────────────────────────────────────────
// How many articles each category actually offers, per tier and clue. The
// private-room picker shows these, because "Animals" meaning 3,000 articles in
// chaos and 90 in party is the difference between a good game and seeing the
// same otter four times — and it is what makes the nudge toward chaos concrete
// rather than a vague warning.
//
// Computed with ONE grouped scan rather than 72 COUNT queries. Distinct mask
// values number in the hundreds, so folding them into per-category totals in JS
// is trivial next to re-scanning the pool per category. Cached forever: the pool
// is opened read-only and cannot change under a running process.
let countsCache = null;

function categoryCounts() {
  if (countsCache) return countsCache;
  try {
    return buildCategoryCounts();
  } catch (err) {
    // Everything here is best-effort. Two real cases reach this: no pool on disk
    // (tests, or a box whose S3 fetch failed), and a pool built BEFORE categories
    // existed, where the query fails on the missing column. This is called from
    // /api/config, so letting either escape would take down every page load over
    // a picker that can perfectly well render without counts.
    log.warn("category_counts_unavailable", { err });
    countsCache = null;
    return null;
  }
}

function buildCategoryCounts() {
  open();
  const started = Date.now();
  const party = config.tierMinPopularity.party;
  const chaos = config.tierMinPopularity.chaos;

  const rows = db
    .prepare(
      `SELECT categories,
              SUM(image_url IS NOT NULL)                                        AS img_chaos,
              SUM(image_url IS NOT NULL AND popularity >= @party)               AS img_party,
              SUM(opening_text IS NOT NULL)                                     AS txt_chaos,
              SUM(opening_text IS NOT NULL AND popularity >= @party)            AS txt_party,
              SUM(image_url IS NOT NULL OR opening_text IS NOT NULL)            AS mix_chaos,
              SUM((image_url IS NOT NULL OR opening_text IS NOT NULL)
                  AND popularity >= @party)                                     AS mix_party
         FROM mysteries
        WHERE popularity >= @chaos
        GROUP BY categories`
    )
    .all({ party, chaos });

  const blank = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const out = {
    party: { image: blank(), text: blank(), mixed: blank() },
    chaos: { image: blank(), text: blank(), mixed: blank() },
  };
  for (const r of rows) {
    if (!r.categories) continue; // unclassified: only ever served unfiltered
    for (const c of CATEGORIES) {
      if ((r.categories & BIT[c]) === 0) continue;
      out.party.image[c] += r.img_party;
      out.party.text[c] += r.txt_party;
      out.party.mixed[c] += r.mix_party;
      out.chaos.image[c] += r.img_chaos;
      out.chaos.text[c] += r.txt_chaos;
      out.chaos.mixed[c] += r.mix_chaos;
    }
  }

  log.info("category_counts_built", { maskGroups: rows.length, ms: Date.now() - started });
  countsCache = out;
  return out;
}

// Pay the scan at boot, alongside the party preload, rather than on the first
// player who opens the picker mid-game.
function warmCategoryCounts() {
  try {
    return categoryCounts();
  } catch (err) {
    log.warn("category_counts_failed", { err });
    return null;
  }
}

// pickFromIndex is exported for tests: its probe-then-scan fallback is the one
// piece of non-obvious logic here, and it must never return an already-used page.
module.exports = { fetchMystery, warmPartyIndex, pickFromIndex, categoryCounts, warmCategoryCounts };
