"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// migrate-ratings-to-tiers.js — one-off migration for the ranked-ladder change.
//
// Ratings/matches used to be keyed by a bare clue ("image" | "text" | "mixed").
// Ladders are now (clue × tier), keyed "image:chaos" etc. This moves every
// legacy bare-clue row into a tier (default: chaos), in both the `ratings` and
// `matches` tables.
//
//   node scripts/migrate-ratings-to-tiers.js            # apply, into chaos
//   node scripts/migrate-ratings-to-tiers.js --tier party
//   node scripts/migrate-ratings-to-tiers.js --dry-run  # preview only
//   node scripts/migrate-ratings-to-tiers.js --no-backup
//
// Safe to run more than once: after migration no bare rows remain, so a second
// run is a no-op. A timestamped .bak copy of the DB is made before applying.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const config = require("../server/config");
const { db } = require("../server/db");
const { MODES } = require("../server/modes");
const { ladderKey } = require("../server/ladders");
const { normalizeTier } = require("../server/tiers");

const dbPath = path.join(config.dataDir, "wikiguessr.sqlite");

// Legacy rows are the ones whose `mode` has no ":" — new ladder keys all do.
function runMigration({ tier = "chaos", dryRun = false, backup = true, log = console.log } = {}) {
  const targetTier = normalizeTier(tier);

  const bareRatings = db.prepare("SELECT user_id, mode FROM ratings WHERE mode NOT LIKE '%:%'").all();
  const findTarget = db.prepare("SELECT 1 FROM ratings WHERE user_id = ? AND mode = ?");

  const plan = [];
  const conflicts = [];
  for (const r of bareRatings) {
    if (!MODES.includes(r.mode)) continue; // unknown bare mode — leave it untouched
    const to = ladderKey(r.mode, targetTier);
    if (findTarget.get(r.user_id, to)) conflicts.push({ user_id: r.user_id, from: r.mode, to });
    else plan.push({ user_id: r.user_id, from: r.mode, to });
  }

  const bareMatchModes = db
    .prepare("SELECT mode, COUNT(*) c FROM matches WHERE mode NOT LIKE '%:%' GROUP BY mode")
    .all()
    .filter((m) => MODES.includes(m.mode));
  const matchesToMove = bareMatchModes.reduce((n, m) => n + m.c, 0);

  log(`Target tier: ${targetTier}`);
  log(`Ratings to migrate: ${plan.length}` + (conflicts.length ? `  (skipping ${conflicts.length} conflict(s))` : ""));
  log(`Matches to migrate: ${matchesToMove}`);
  for (const c of conflicts) {
    log(`  ⚠ conflict: user ${c.user_id} "${c.from}" — "${c.to}" already exists; leaving the legacy row in place`);
  }

  if (dryRun) {
    log("\nDry run — no changes written.");
    return { migratedRatings: 0, migratedMatches: 0, conflicts, dryRun: true, plan };
  }
  if (plan.length === 0 && matchesToMove === 0) {
    log("\nNothing to migrate — already up to date.");
    return { migratedRatings: 0, migratedMatches: 0, conflicts, dryRun: false, plan };
  }

  if (backup) {
    // Flush the WAL into the main file so the plain copy is complete.
    db.pragma("wal_checkpoint(TRUNCATE)");
    const bak = `${dbPath}.bak-${Date.now()}`;
    fs.copyFileSync(dbPath, bak);
    log(`\nBackup written: ${bak}`);
  }

  const apply = db.transaction(() => {
    const updRating = db.prepare("UPDATE ratings SET mode = ? WHERE user_id = ? AND mode = ?");
    for (const p of plan) updRating.run(p.to, p.user_id, p.from);
    let matchRows = 0;
    const updMatch = db.prepare("UPDATE matches SET mode = ? WHERE mode = ?");
    for (const m of bareMatchModes) matchRows += updMatch.run(ladderKey(m.mode, targetTier), m.mode).changes;
    return matchRows;
  });
  const migratedMatches = apply();

  log(`\nMigrated ${plan.length} rating row(s) and ${migratedMatches} match row(s) into "${targetTier}".`);
  return { migratedRatings: plan.length, migratedMatches, conflicts, dryRun: false, plan };
}

// CLI
if (require.main === module) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const next = process.argv[i + 1];
    return next && !next.startsWith("--") ? next : true;
  };
  const summary = runMigration({
    tier: typeof arg("tier") === "string" ? arg("tier") : "chaos",
    dryRun: Boolean(arg("dry-run")),
    backup: !arg("no-backup"),
  });
  db.close();
  if (summary.conflicts.length) process.exitCode = 0; // reported, not an error
}

module.exports = { runMigration };
