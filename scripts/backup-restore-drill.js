"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Backup restore drill.
//
// A DLM snapshot of the data volume is crash-consistent, not quiesced: it
// captures every block at one instant, with the app mid-write and SQLite's WAL
// part-written. That is the same situation as pulling the power cord. This drill
// answers the only question that matters about a backup nobody has restored:
//
//     Does the player database come back intact from a snapshot taken while
//     ranked matches were actively being written?
//
// Two scenarios, because they are NOT the same and only one of them is what AWS
// actually does:
//
//   crash-consistent  The writers are SIGKILLed mid-transaction and the files
//                     are then read exactly as they lie. No clean close, no
//                     checkpoint, no cleanup. This is the faithful model of an
//                     EBS snapshot: one instant, all files together.
//
//   file-copy         The files are copied one at a time WHILE writers run, the
//                     way `cp -r`, rsync or `aws s3 cp` of a live data directory
//                     would. A checkpoint landing between the .sqlite and the
//                     -wal copy yields an old database paired with a reset WAL —
//                     a pairing a volume snapshot can never produce. Included to
//                     put a number on why you must not back this up file by file.
//
// Writers run in SEPARATE PROCESSES: better-sqlite3 is synchronous, so a
// single-process test would only ever capture the gaps between transactions and
// would prove nothing.
//
// Every restored copy is checked four ways — SQLite's integrity check, foreign
// keys, and two invariants that hold only if transactions are all-or-nothing.
// recordRankedMatch writes two rating upserts and one match row in ONE
// transaction, so games_played must equal the matches a player appears in, and
// W+L+D must equal games_played. integrity_check cannot see a torn transaction;
// those two can. Match ids are also checked for gaps, which would mean a
// committed transaction was lost while a later one survived.
//
// Usage:
//   node scripts/backup-restore-drill.js [--rounds 12] [--writers 3]
// ────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { fork } = require("child_process");
const Database = require("better-sqlite3");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};

const ROUNDS = arg("rounds", 12);
const WRITERS = arg("writers", 3);
const DB_NAME = "wiki-guesser.sqlite";

// ── Writer child ─────────────────────────────────────────────────────────────
// Drives the app's real ranked-write path in a tight loop. Expects to be killed.
if (process.argv.includes("--writer")) {
  const { db, recordRankedMatch, upsertOAuthUser } = require("../server/db");
  const { LADDERS } = require("../server/ladders");

  // The app is single-process and so never contends with itself; this drill
  // deliberately runs several writers against one file, which without a busy
  // timeout means an immediate SQLITE_BUSY. Startup (schema creation and the
  // player upserts below) sits outside the retry loop further down, so an
  // unguarded busy there would kill the writer before it ever reported ready.
  db.pragma("busy_timeout = 10000");

  const tag = process.argv[process.argv.indexOf("--writer") + 1];
  const players = [];
  for (let i = 0; i < 8; i++) {
    players.push(
      upsertOAuthUser({ provider: "drill", providerId: `${tag}-p${i}`, displayName: `Drill ${tag}-${i}` })
    );
  }

  if (process.send) process.send("ready");

  const once = () => {
    const a = players[Math.floor(Math.random() * players.length)];
    let b = players[Math.floor(Math.random() * players.length)];
    while (b.id === a.id) b = players[Math.floor(Math.random() * players.length)];
    try {
      recordRankedMatch({
        mode: LADDERS[Math.floor(Math.random() * LADDERS.length)],
        a: { id: a.id },
        b: { id: b.id },
        aScore: Math.floor(Math.random() * 500),
        bScore: Math.floor(Math.random() * 500),
        outcome: [0, 0.5, 1][Math.floor(Math.random() * 3)],
        aRatingAfter: 1000 + Math.floor(Math.random() * 800),
        bRatingAfter: 1000 + Math.floor(Math.random() * 800),
        aDelta: Math.floor(Math.random() * 40) - 20,
        bDelta: Math.floor(Math.random() * 40) - 20,
      });
    } catch (err) {
      // Contention is expected; the app itself treats a failed rating write as
      // survivable. Anything else is a genuine fault.
      if (!/SQLITE_BUSY|database is locked/i.test(String(err))) throw err;
    }
  };

  // Batches of synchronous transactions with a yield between them. A fully
  // unbounded loop would never return to the event loop, so the "ready" message
  // above would never flush and the parent would wait forever. At 25 synchronous
  // commits per tick the process is still inside a transaction for essentially
  // all of its wall clock, which is what makes the kill land mid-write.
  const pump = () => {
    for (let i = 0; i < 25; i++) once();
    setImmediate(pump);
  };
  pump();
  return;
}

// ── Parent ───────────────────────────────────────────────────────────────────
// Never opens the live database itself — holding a connection would checkpoint
// on close and quietly clean up the very state under test.

const root = path.join(os.tmpdir(), "wg-restore-drill-" + crypto.randomBytes(5).toString("hex"));
fs.mkdirSync(root, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Started one at a time, each awaited before the next: they all run the schema
// bootstrap and the same player upserts, and doing that concurrently is pure
// contention for no benefit. The interesting concurrency is the write loop,
// which begins as soon as a writer reports ready.
async function spawnWriters(dataDir, n) {
  const kids = [];
  for (let i = 0; i < n; i++) {
    const kid = fork(__filename, ["--writer", String(i)], {
      env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: "test", LOG_LEVEL: "silent" },
      // stderr inherited: a writer that dies during startup must be visible.
      // Swallowing it turned a crash into a parent that waited for "ready"
      // forever, which is a much worse failure than a loud one.
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      serialization: "json",
    });
    kids.push(kid);
    await ready(kid);
  }
  return kids;
}

// Resolves on "ready", rejects if the child dies first — never hangs.
const ready = (kid) =>
  new Promise((res, rej) => {
    const onExit = (code, signal) =>
      rej(new Error(`writer exited during startup (code=${code} signal=${signal}) — see stderr above`));
    kid.once("exit", onExit);
    kid.once("message", (m) => {
      kid.off("exit", onExit);
      res(m);
    });
  });

const killAll = (kids) =>
  Promise.all(
    kids.map(
      (k) =>
        new Promise((res) => {
          k.once("exit", res);
          k.kill("SIGKILL"); // no cleanup, no clean close — this is the crash
        })
    )
  );

// Open a database exactly as a recovering app would, and interrogate it.
function verify(file) {
  const out = { ok: true, failures: [], matches: 0 };
  if (!fs.existsSync(file)) {
    return { ...out, ok: false, failures: ["no database file"] };
  }
  let db;
  try {
    db = new Database(file); // read-write: opening is what replays the WAL
  } catch (err) {
    return { ...out, ok: false, failures: [`open failed: ${err.message}`] };
  }
  try {
    // A malformed image makes SQLite THROW rather than return a report, so this
    // whole block has to be able to fail as a result, not as a crash.
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") { out.ok = false; out.failures.push(`integrity_check: ${integrity}`); }

    const fk = db.pragma("foreign_key_check");
    if (fk.length) { out.ok = false; out.failures.push(`foreign_key_check: ${fk.length} violation(s)`); }

    const agg = db.prepare("SELECT COUNT(*) n, COALESCE(MAX(id),0) hi FROM matches").get();
    out.matches = agg.n;

    // A hole means a committed transaction vanished while a LATER one survived.
    // Tail truncation is normal durability loss; a hole would not be.
    if (agg.hi !== agg.n) {
      out.ok = false;
      out.failures.push(`match id gap: ${agg.n} rows but max id ${agg.hi}`);
    }

    // Transaction atomicity — the check integrity_check cannot make.
    //
    // Written as two grouped scans rather than the obvious correlated subquery:
    // `(SELECT COUNT(*) ... WHERE a_user_id = r.user_id OR b_user_id = r.user_id)`
    // re-scans matches once per rating row and the OR defeats both indexes, which
    // made this the drill's bottleneck at tens of thousands of rows.
    const drift = db
      .prepare(
        `WITH per AS (
           SELECT user_id, mode, SUM(c) AS actual FROM (
             SELECT a_user_id AS user_id, mode, COUNT(*) AS c FROM matches GROUP BY a_user_id, mode
             UNION ALL
             SELECT b_user_id AS user_id, mode, COUNT(*) AS c FROM matches GROUP BY b_user_id, mode
           ) GROUP BY user_id, mode
         )
         SELECT r.user_id, r.mode, r.games_played, COALESCE(p.actual, 0) AS actual
           FROM ratings r
           LEFT JOIN per p ON p.user_id = r.user_id AND p.mode = r.mode
          WHERE r.games_played != COALESCE(p.actual, 0)`
      )
      .all();
    if (drift.length) {
      const d = drift[0];
      out.ok = false;
      out.failures.push(
        `torn transaction: ${drift.length} rating row(s) disagree with matches ` +
          `(e.g. user ${d.user_id}/${d.mode}: games_played=${d.games_played}, matches=${d.actual})`
      );
    }

    const wld = db.prepare("SELECT COUNT(*) n FROM ratings WHERE wins+losses+draws != games_played").get().n;
    if (wld) { out.ok = false; out.failures.push(`${wld} rating row(s) where W+L+D != games_played`); }
  } catch (err) {
    out.ok = false;
    out.failures.push(`${err.code || "error"}: ${err.message}`);
  } finally {
    try { db.close(); } catch { /* already unusable */ }
  }
  return out;
}

function copyShape(fromDir, toDir, shape) {
  fs.mkdirSync(toDir, { recursive: true });
  const copy = (suffix, optional = false) => {
    const src = path.join(fromDir, DB_NAME + suffix);
    if (!fs.existsSync(src)) return false;
    try {
      fs.copyFileSync(src, path.join(toDir, DB_NAME + suffix));
      return true;
    } catch (err) {
      // Windows keeps the -shm memory-mapped and exclusively locked while a
      // process has the database open, so it cannot be copied from here. EBS has
      // no such problem (it captures blocks beneath the filesystem) and SQLite
      // rebuilds the -shm from the WAL on recovery, so its absence changes
      // nothing about what is being tested.
      if (optional && (err.code === "EBUSY" || err.code === "EPERM")) return false;
      throw err;
    }
  };
  copy("");
  if (shape !== "db-only") copy("-wal", true);
  if (shape === "volume") copy("-shm", true);
  return path.join(toDir, DB_NAME);
}

const results = {
  "crash-consistent": [],
  "crash db-only": [],
  "file-copy": [],
};

(async () => {
  console.log("Backup restore drill");
  console.log("─".repeat(74));
  console.log(`  ${ROUNDS} rounds x ${WRITERS} writer processes, ${os.platform()}/${process.arch}, node ${process.versions.node}`);
  console.log(`  better-sqlite3 ${require("../node_modules/better-sqlite3/package.json").version}`);
  console.log("");

  let pragmasShown = false;
  let totalMatches = 0;

  for (let r = 0; r < ROUNDS; r++) {
    process.stdout.write(`\r  round ${r + 1}/${ROUNDS}…`);

    // ── Scenario A: crash-consistent (the EBS model) ──────────────────────────
    const crashDir = path.join(root, `r${r}-crash`);
    fs.mkdirSync(crashDir, { recursive: true });
    let kids = await spawnWriters(crashDir, WRITERS);
    // Long enough to build an uncheckpointed WAL and be mid-transaction.
    await wait(250 + Math.random() * 350);
    await killAll(kids);

    if (!pragmasShown && fs.existsSync(path.join(crashDir, DB_NAME))) {
      const d = new Database(path.join(crashDir, DB_NAME));
      console.log(`\r  journal_mode=${d.pragma("journal_mode", { simple: true })}  ` +
        `synchronous=${d.pragma("synchronous", { simple: true })} (0=OFF 1=NORMAL 2=FULL)` + " ".repeat(12));
      d.close();
      pragmasShown = true;
      // That open recovered the WAL, so re-run the round for a pristine sample.
      r--;
      continue;
    }

    // db-only first: reading the full set would recover the WAL and rewrite the
    // .sqlite, which would make the db-only sample artificially healthy.
    const dbOnly = verify(copyShape(crashDir, path.join(root, `r${r}-dbonly`), "db-only"));

    const crash = verify(path.join(crashDir, DB_NAME));
    results["crash-consistent"].push(crash);
    totalMatches += crash.matches;

    // The honest measure for a WAL-less copy is not integrity but COMPLETENESS.
    // A checkpoint writes a transactionally consistent prefix into the .sqlite,
    // so the main file alone is usually valid — just old. It only corrupts if
    // the copy happens to catch a checkpoint mid-flight. Comparing against the
    // fully recovered database from the same instant is what exposes the loss.
    dbOnly.lost = Math.max(0, crash.matches - dbOnly.matches);
    dbOnly.lostPct = crash.matches ? (dbOnly.lost / crash.matches) * 100 : 0;
    results["crash db-only"].push(dbOnly);

    // ── Scenario B: file-by-file copy of a LIVE database ──────────────────────
    const liveDir = path.join(root, `r${r}-live`);
    fs.mkdirSync(liveDir, { recursive: true });
    kids = await spawnWriters(liveDir, WRITERS);
    await wait(250 + Math.random() * 300);
    const copied = copyShape(liveDir, path.join(root, `r${r}-filecopy`), "volume"); // while running
    await killAll(kids);
    const fc = verify(copied);
    // Baseline: the same database recovered in place, i.e. what a volume
    // snapshot at the same moment would have preserved.
    const baseline = verify(path.join(liveDir, DB_NAME));
    fc.lost = Math.max(0, baseline.matches - fc.matches);
    fc.lostPct = baseline.matches ? (fc.lost / baseline.matches) * 100 : 0;
    results["file-copy"].push(fc);
  }

  process.stdout.write("\r" + " ".repeat(60) + "\r");

  console.log(`  ${totalMatches.toLocaleString()} ranked matches recovered across ${ROUNDS} crash rounds`);
  console.log("");
  console.log("  scenario           intact    corrupt   matches lost (worst / mean)");
  console.log("  " + "─".repeat(66));

  const line = (label, rs) => {
    const good = rs.filter((x) => x.ok).length;
    const corrupt = rs.length - good;
    const losses = rs.filter((x) => x.lostPct != null).map((x) => x.lostPct);
    const worst = losses.length ? Math.max(...losses) : null;
    const mean = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null;
    const lossCol = worst == null ? "—" : `${worst.toFixed(1)}% / ${mean.toFixed(1)}%`;
    console.log(
      `  ${label.padEnd(19)}${String(good + "/" + rs.length).padEnd(10)}${String(corrupt).padEnd(10)}${lossCol}`
    );
    const bad = rs.find((x) => !x.ok);
    if (bad) console.log(`                     ↳ e.g. ${bad.failures[0]}`);
    return good === rs.length;
  };

  const crashOk = line("crash-consistent", results["crash-consistent"]);
  line("crash db-only", results["crash db-only"]);
  line("file-copy", results["file-copy"]);

  console.log("");
  console.log("  crash-consistent models the EBS snapshot and MUST be 100% intact");
  console.log("  with no loss column — it captures every file at one instant.");
  console.log("");
  console.log("  The other two are the ways a hand-rolled backup goes wrong. Note");
  console.log("  that they usually pass an integrity check: a WAL checkpoint leaves");
  console.log("  a transactionally CONSISTENT prefix in the .sqlite, so the damage");
  console.log("  is normally silent data loss rather than a corrupt file. Corruption");
  console.log("  only appears when the copy catches a checkpoint mid-flight. That is");
  console.log("  precisely what makes this failure mode dangerous: it looks fine.");
  console.log("");

  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }

  if (!crashOk) {
    console.log("  RESULT: FAIL — the EBS-equivalent restore did not come back clean.");
    process.exit(1);
  }
  console.log("  RESULT: PASS — every crash-consistent restore came back intact.");
  process.exit(0);
})();
