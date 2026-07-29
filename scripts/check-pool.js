#!/usr/bin/env node
"use strict";

// Preflight for the mystery pool, to be run before uploading it to S3.
//
// The failure this exists to prevent is a quiet one. A pool built before the
// categories feature landed has no `categories` column, and the app degrades
// around that gracefully in every place except the one that matters: the picker
// shows no counts (categoryCounts() catches and returns null), unfiltered rounds
// work perfectly, boot is clean, /healthz is green — and every category-filtered
// private round throws "no such column: categories". You would find out from a
// player, days later, on the newest feature in the game.
//
// Since the pool is ~908 MB, the upload is a ten-minute commitment. Ten seconds
// of checking first is the trade.
//
//   node scripts/check-pool.js [path-to-pool.sqlite]

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const { CATEGORIES } = require("../server/game/categories");
const config = require("../server/config");

const file = path.resolve(process.argv[2] || config.mysteryDb);

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}

if (!fs.existsSync(file)) {
  console.error(`✗ No pool at ${file}`);
  console.error("  Build one with: node scripts/build-mysteries.js --cirrus <…> --props <…>");
  process.exit(1);
}

const sizeMb = Math.round(fs.statSync(file).size / 1e6);
const db = new Database(file, { readonly: true });

// ── Shape ────────────────────────────────────────────────────────────────────
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all()
  .map((r) => r.name);

if (!tables.includes("mysteries")) {
  console.error(`✗ ${file} has no 'mysteries' table (found: ${tables.join(", ") || "nothing"}).`);
  console.error("  This is not a mystery pool — check the path.");
  process.exit(1);
}

const columns = db
  .prepare("PRAGMA table_info(mysteries)")
  .all()
  .map((c) => c.name);

const rows = db.prepare("SELECT COUNT(*) AS c FROM mysteries").get().c;
if (rows === 0) fail("The pool is empty — 0 rows in `mysteries`.");

// ── Categories ───────────────────────────────────────────────────────────────
// The whole reason this script exists.
const hasCategories = columns.includes("categories");
if (!hasCategories) {
  fail(
    "No `categories` column — this pool predates the categories feature.\n" +
      "    Every category-filtered private round WILL fail against it, silently,\n" +
      "    while the rest of the game looks healthy. Rebuild with\n" +
      "    scripts/build-mysteries.js and upload that instead."
  );
}

// The 24 partial indexes (12 categories × image/text). Without them a filtered
// pick degrades from an index walk into a full scan, which blocks the event loop
// for every room on the box — a performance cliff, not a correctness bug, so it
// is reported separately from the column being missing outright.
if (hasCategories) {
  const indexes = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name)
  );
  const missing = [];
  for (const c of CATEGORIES) {
    for (const clue of ["img", "txt"]) {
      const name = `idx_cat_${c}_${clue}`;
      if (!indexes.has(name)) missing.push(name);
    }
  }
  if (missing.length) {
    fail(
      `${missing.length} of ${CATEGORIES.length * 2} category indexes are missing ` +
        `(e.g. ${missing.slice(0, 3).join(", ")}).\n` +
        "    Filtered picks will full-scan and stall the event loop for every room."
    );
  }

  const classified = db.prepare("SELECT COUNT(*) AS c FROM mysteries WHERE categories > 0").get().c;
  notes.push(`${classified.toLocaleString()} of ${rows.toLocaleString()} rows classified (${Math.round((classified / rows) * 100)}%)`);
}

// ── Tiers ────────────────────────────────────────────────────────────────────
// A party tier that has collapsed to almost nothing means a mis-set
// PARTY_MIN_POP at build time, and shows up in play as the same articles
// repeating within a single game.
const party = db.prepare("SELECT COUNT(*) AS c FROM mysteries WHERE popularity >= ?").get(config.tierMinPopularity.party).c;
const chaos = db.prepare("SELECT COUNT(*) AS c FROM mysteries WHERE popularity >= ?").get(config.tierMinPopularity.chaos).c;
notes.push(`party tier: ${party.toLocaleString()} · chaos tier: ${chaos.toLocaleString()}`);
if (party < 1000) fail(`Party tier holds only ${party} articles — far too thin to play. Check PARTY_MIN_POP.`);

// Both clue modes have to be servable, or one of the three game modes is dead.
const withImage = db.prepare("SELECT COUNT(*) AS c FROM mysteries WHERE image_url IS NOT NULL").get().c;
const withText = db.prepare("SELECT COUNT(*) AS c FROM mysteries WHERE opening_text IS NOT NULL").get().c;
notes.push(`with an image: ${withImage.toLocaleString()} · with an extract: ${withText.toLocaleString()}`);
if (withImage === 0) fail("No rows have an image_url — picture rounds cannot be served.");
if (withText === 0) fail("No rows have opening_text — description rounds cannot be served.");

db.close();

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`Pool: ${file}`);
console.log(`      ${sizeMb} MB · ${rows.toLocaleString()} rows`);
for (const n of notes) console.log(`      ${n}`);
console.log("");

if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length > 1 ? "s" : ""} — do NOT upload this pool:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

console.log("✓ Pool looks good — safe to upload.");
