#!/usr/bin/env node
"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Print the accounts on this box, newest first, so you can find the id to put
// in ADMIN_USER_IDS.
//
// This exists because of a genuine chicken-and-egg: admin is granted by account
// id, the id is assigned by the database on first sign-in, and there is no page
// that shows it to you — /admin is the page that would, and you cannot reach it
// yet. So: sign in with Google or Discord once, run this, and paste the number.
//
//   npm run accounts
//   npm run accounts -- alice        # filter by display name
//
// Read-only. It opens the same database the server uses, which is safe while
// the server is running — SQLite in WAL mode takes concurrent readers — but it
// does mean this has to be run ON the box, which is the point. Admin is granted
// by someone with a shell and the env file, not through the web.
// ────────────────────────────────────────────────────────────────────────────

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

require("dotenv").config();

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");
const file = path.join(dataDir, "wiki-guesser.sqlite");

if (!fs.existsSync(file)) {
  console.error(`No database at ${file}.`);
  console.error("Start the server once (npm start), sign in, then run this again.");
  process.exit(1);
}

// readonly, so this can never be the thing that corrupts a live database.
const db = new Database(file, { readonly: true, fileMustExist: true });

const filter = process.argv[2];
const rows = filter
  ? db
      .prepare(
        `SELECT id, display_name, provider, created_at, last_seen FROM users
          WHERE display_name LIKE ? ESCAPE '\\' ORDER BY id DESC`
      )
      .all(`%${filter.replace(/[\\%_]/g, "\\$&")}%`)
  : db.prepare("SELECT id, display_name, provider, created_at, last_seen FROM users ORDER BY id DESC LIMIT 50").all();

// Which ids already have admin, so a second run after editing .env confirms the
// change landed rather than leaving you to compare two lists by eye.
const admins = new Set(
  String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isInteger)
);

// Banned accounts, so this doubles as the way out if the dashboard is ever the
// thing that is broken. Guarded: the table does not exist on a database from
// before this feature.
let banned = new Set();
try {
  banned = new Set(db.prepare("SELECT user_id FROM bans").all().map((b) => b.user_id));
} catch { /* pre-moderation database */ }

if (!rows.length) {
  console.log(filter ? `No accounts matching "${filter}".` : "No accounts yet — sign in once, then run this again.");
  process.exit(0);
}

const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
const pad = (s, n) => String(s).padEnd(n);

console.log(`${pad("ID", 6)}${pad("NAME", 28)}${pad("VIA", 10)}${pad("JOINED", 12)}${pad("SEEN", 12)}FLAGS`);
for (const u of rows) {
  const flags = [admins.has(u.id) && "admin", banned.has(u.id) && "banned"].filter(Boolean).join(" ");
  console.log(
    pad(u.id, 6) + pad(String(u.display_name).slice(0, 26), 28) + pad(u.provider, 10) +
      pad(date(u.created_at), 12) + pad(date(u.last_seen), 12) + flags
  );
}

console.log(
  `\n${rows.length} account${rows.length === 1 ? "" : "s"}. Grant admin by putting the ID in your .env:\n` +
    `  ADMIN_USER_IDS=${rows[0].id}\n` +
    `then restart the server. Unset or empty means /admin does not exist at all.`
);

db.close();
