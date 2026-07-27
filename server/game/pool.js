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
function pickRow(clue, minPop, used) {
  open();
  const col = clue === "text" ? "opening_text" : "image_url";
  const key = `${col}:${used.size}`;
  let stmt = stmtCache.get(key);
  if (!stmt) {
    const excl = used.size ? ` AND page_id NOT IN (${Array(used.size).fill("?").join(",")})` : "";
    stmt = db.prepare(
      `SELECT page_id, title, image_url, opening_text, freq_json FROM mysteries ` +
        `WHERE ${col} IS NOT NULL AND popularity >= ? AND rnd >= ?${excl} ORDER BY rnd LIMIT 1`
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
      .prepare("SELECT page_id, title, image_url, opening_text, freq_json FROM mysteries WHERE popularity >= ?")
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
function pickFromIndex(rows, used) {
  if (!rows || rows.length === 0) return null;
  for (let i = 0; i < 20; i++) {
    const row = rows[Math.floor(Math.random() * rows.length)];
    if (!used.has(row.page_id)) return row;
  }
  const start = Math.floor(Math.random() * rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[(start + i) % rows.length];
    if (!used.has(row.page_id)) return row;
  }
  return null;
}

// tier: "party" | "chaos"; clue: "image" | "text" ("mixed" is resolved upstream
// in rooms.js). `used` is the game's Set of page_ids so far.
async function fetchMystery(tier = "party", used = new Set(), clue = "image") {
  const tiers = config.tierMinPopularity;
  const minPop = tiers[tier] != null ? tiers[tier] : tiers.party;

  let row = null;
  if (tier === "party" && partyIndex) row = pickFromIndex(partyIndex[clue] || partyIndex.image, used);
  if (!row) row = pickRow(clue, minPop, used);
  // Tier exhausted (long game, or too strict a threshold)? Fall back to the
  // whole pool once rather than failing the round.
  if (!row && minPop > 0) row = pickRow(clue, 0, used);
  if (!row) throw new Error("No mystery available from the local pool");
  used.add(row.page_id);
  return rowToMystery(row);
}

// pickFromIndex is exported for tests: its probe-then-scan fallback is the one
// piece of non-obvious logic here, and it must never return an already-used page.
module.exports = { fetchMystery, warmPartyIndex, pickFromIndex };
