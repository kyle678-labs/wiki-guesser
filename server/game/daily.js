"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Daily puzzles: the shared machinery, with no game rules in it.
//
// Two jobs. Decide what "today" is, and turn (today, game) into the same
// articles for every player without storing a schedule anywhere.
// ────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const log = require("../log");
const { openPool } = require("./pool");

// ── The day ──────────────────────────────────────────────────────────────────
// Puzzles roll over at midnight UTC, not at each player's local midnight.
//
// The trade is deliberate. Local midnight reads more naturally to one player,
// but it makes a shared leaderboard incoherent — two people would hold "today's"
// best time on different puzzles — and it moves the clock into the client,
// which is the one input a scoreboard must never trust. One global day, one race.
function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD, always UTC
}

// Milliseconds until the next puzzle, so the page can show a countdown rather
// than leaving a player to work out when it flips.
function msUntilReset(now = Date.now()) {
  const d = new Date(now);
  // Day + 1 through Date.UTC rather than adding 86_400_000, so month and year
  // rollover are the calendar's problem rather than arithmetic we got right.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

// ── Deterministic selection ──────────────────────────────────────────────────
// Every player must get the same puzzle, and no row anywhere should have to say
// so. The day and the game id hash into a seed; the seed drives a PRNG; the
// PRNG produces the same `rnd` probes pool.js already uses for random picks. So
// this is the existing indexed lookup with a fixed input rather than a new query
// path — and because the pool is opened read-only and never changes under a
// running process, the same seed yields the same article forever.

function seedFor(day, gameId) {
  // SHA-256 rather than a hand-rolled string hash. Consecutive days differ by
  // one character, and a weak mixer would land them next to each other in the
  // pool — "yesterday but slightly later" is exactly the failure a daily puzzle
  // cannot have. Computed once per game per day, so the cost is irrelevant.
  return crypto.createHash("sha256").update(`${day}:${gameId}`).digest().readUInt32LE(0);
}

// mulberry32. Small and fast, but the only property that actually matters is
// that it is exactly reproducible from a 32-bit seed on every Node version.
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Titles that make a poor puzzle. The pool is built for a 20-second round where
// "Yes discography" is a fair enough target; a whole day's puzzle is not the
// same thing, so dailies filter harder than the live game does.
const TITLE_EXCLUDE = ["%discography%", "%filmography%", "List of %", "%(disambiguation)%"];

const stmtCache = new Map();

function pickStatement(col, needsText) {
  const key = `${col}:${needsText}`;
  let stmt = stmtCache.get(key);
  if (stmt) return stmt;
  const excl = TITLE_EXCLUDE.map(() => "title NOT LIKE ?").join(" AND ");
  stmt = openPool().prepare(
    `SELECT page_id, title, image_url, opening_text
       FROM mysteries
      WHERE ${col} IS NOT NULL
        AND popularity >= ?
        ${needsText ? "AND length(opening_text) >= ?" : ""}
        AND ${excl}
        AND rnd >= ?
      ORDER BY rnd LIMIT 1`
  );
  stmtCache.set(key, stmt);
  return stmt;
}

// `count` distinct articles for one (day, game), drawn deterministically.
//
// Returns null rather than throwing when there is no pool on disk — tests run
// without one, and a box whose S3 fetch failed should serve a site with no
// dailies rather than no site.
function pickDaily({ day, gameId, clue = "image", minPop, count = 1, minTextLen = 0 }) {
  const col = clue === "text" ? "opening_text" : "image_url";
  const needsText = minTextLen > 0;

  let stmt;
  try {
    stmt = pickStatement(col, needsText);
  } catch (err) {
    log.warn("daily_pool_unavailable", { gameId, day, err });
    return null;
  }

  const next = rng(seedFor(day, gameId));
  const rows = [];
  const seen = new Set();

  // Each draw walks the rnd index from a seeded probe. A collision with an
  // article already drawn today just re-probes; `attempts` only bounds the
  // degenerate case where the filtered set is smaller than `count`.
  const attempts = count * 20 + 20;
  for (let i = 0; i < attempts && rows.length < count; i++) {
    const args = needsText ? [minPop, minTextLen, ...TITLE_EXCLUDE] : [minPop, ...TITLE_EXCLUDE];
    const r = next();
    // Wrap to the start of the index when the probe lands past the last match,
    // which is the same fallback pool.js uses for its random picks.
    const row = stmt.get(...args, r) || stmt.get(...args, 0);
    if (!row || seen.has(row.page_id)) continue;
    seen.add(row.page_id);
    rows.push(row);
  }

  if (rows.length < count) {
    log.warn("daily_pick_short", { gameId, day, wanted: count, got: rows.length });
    return rows.length ? rows : null;
  }
  return rows;
}

// ── Deterministic shuffles ───────────────────────────────────────────────────
// The picture games need more than an article: they need a scramble, and it has
// to be the same scramble for everyone. Fisher-Yates over a caller-supplied
// `next()` rather than Math.random, so the shuffle comes out of the same seeded
// stream as the rest of the day and nothing has to be stored to reproduce it.
function shuffle(items, next) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Fewest swaps that sorts a permutation: n minus its number of cycles. Every
// cycle of length k needs k-1 swaps, and the cycles partition the array.
//
// This is what "par" means in both picture games — the score a player who never
// wastes a move would post. Worth stating rather than leaving implicit: without
// it a board of move counts is a number with nothing to compare it against.
function swapsToSort(perm) {
  const seen = new Array(perm.length).fill(false);
  let cycles = 0;
  for (let i = 0; i < perm.length; i++) {
    if (seen[i]) continue;
    cycles++;
    for (let j = i; !seen[j]; j = perm[j]) seen[j] = true;
  }
  return perm.length - cycles;
}

// ── Per-day caching ──────────────────────────────────────────────────────────
// A day's puzzle is built once and reused until the key changes. Keyed by day
// as well as game so the entry replaces itself at rollover rather than needing
// a timer to invalidate it — and so a request that arrives a millisecond after
// midnight builds the new puzzle instead of serving the old one.
const dayCache = new Map(); // `${gameId}:${day}` -> built puzzle

function cachedForDay(gameId, day, build) {
  const key = `${gameId}:${day}`;
  if (dayCache.has(key)) return dayCache.get(key);
  const built = build();
  dayCache.set(key, built);
  // Yesterday's entries are dead weight the moment the day turns. The map only
  // grows on a cache miss, so this sweeps exactly when something was added.
  for (const k of dayCache.keys()) if (!k.endsWith(`:${day}`)) dayCache.delete(k);
  return built;
}

module.exports = { dayKey, msUntilReset, seedFor, rng, pickDaily, cachedForDay, shuffle, swapsToSort };
