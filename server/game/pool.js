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
const { titleWords } = require("./scoring");
const { buildClue } = require("./extract");

let db = null;
const stmtCache = new Map();

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

// tier: "party" | "chaos"; clue: "image" | "text" ("mixed" is resolved upstream
// in rooms.js). `used` is the game's Set of page_ids so far.
async function fetchMystery(tier = "party", used = new Set(), clue = "image") {
  const tiers = config.tierMinPopularity;
  const minPop = tiers[tier] != null ? tiers[tier] : tiers.party;
  let row = pickRow(clue, minPop, used);
  // Tier exhausted (long game, or too strict a threshold)? Fall back to the
  // whole pool once rather than failing the round.
  if (!row && minPop > 0) row = pickRow(clue, 0, used);
  if (!row) throw new Error("No mystery available from the local pool");
  used.add(row.page_id);
  return rowToMystery(row);
}

module.exports = { fetchMystery };
