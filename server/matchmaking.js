"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Rating-aware pairing for the ranked queues.
//
// The rule is MUTUAL acceptance. Every waiting player has a search window that
// starts tight and widens the longer they wait; a pair is only made when each
// player falls inside the other's window. One-sided acceptance — "whoever has
// waited longest takes whoever turns up" — would let a player who has been in
// the queue for two minutes drag a freshly-arrived opponent into a lopsided
// game that opponent never agreed to, and on a small ladder that is precisely
// the game that makes someone stop queuing.
//
// This module is pure: it is handed queue entries and a clock, and returns an
// index pair. Everything about sockets, rooms and timers lives in rooms.js.
// ────────────────────────────────────────────────────────────────────────────

const config = require("./config");

// How wide `entry` is currently willing to search, in rating points.
function searchWindow(entry, now, opts = config.matchmaking) {
  const waitedSec = Math.max(0, (now - entry.enqueuedAt) / 1000);
  const grown = opts.startWindow + opts.growthPerSec * waitedSec;
  const provisional = entry.provisional ? opts.provisionalBonus : 0;
  return Math.min(opts.maxWindow, grown + provisional);
}

// Would `a` accept `b`? Deliberately one-directional — callers check both ways.
function accepts(a, b, now, opts = config.matchmaking) {
  return Math.abs(a.rating - b.rating) <= searchWindow(a, now, opts);
}

// The closest mutually-acceptable pair, as { i, j, gap }, or null if no two
// players in the queue will currently have each other.
//
// The scan is exhaustive O(n²). That is the right choice here rather than a
// concession: a ladder queue holds a handful of players, and comparing every
// pair finds the globally tightest match instead of whichever adequate one a
// single sweep happened to reach first. Sorting and walking neighbours would be
// faster and worse — adjacent players are not necessarily mutually acceptable,
// because a long-waiting player's window can be much wider than a new arrival's.
function findPair(entries, now, opts = config.matchmaking) {
  let best = null;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const gap = Math.abs(a.rating - b.rating);
      if (best && gap >= best.gap) continue; // can't improve on what we have
      if (!accepts(a, b, now, opts) || !accepts(b, a, now, opts)) continue;
      best = { i, j, gap };
    }
  }
  return best;
}

// Everything a waiting client needs to render an honest "still searching" state.
function queueStatus(entry, now, opts = config.matchmaking) {
  return {
    waitedMs: Math.max(0, now - entry.enqueuedAt),
    window: Math.round(searchWindow(entry, now, opts)),
    rating: entry.rating,
    provisional: Boolean(entry.provisional),
  };
}

module.exports = { searchWindow, accepts, findPair, queueStatus };
