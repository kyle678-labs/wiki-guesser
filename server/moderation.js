"use strict";

// ────────────────────────────────────────────────────────────────────────────
// What a ban means at the edges of the app.
//
// The decision itself lives in the database (see `bans` in db.js) and is
// resolved once, onto the identity, by accountIdentity in auth.js. This module
// is only the two things every enforcement point needs and neither of them
// should write twice: how long is left, and what the player is told.
//
// A separate module because the two callers — the Socket.IO handshake and the
// daily puzzle routes — have no business requiring each other, and a wording
// copied into both is a wording that ends up differing.
// ────────────────────────────────────────────────────────────────────────────

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Round UP, always. "0 hours left" on a ban that is still in force reads as a
// bug, and a player told to come back in an hour who finds it lifted early is
// pleasantly surprised rather than lied to.
function remainingLabel(until, now = Date.now()) {
  const left = until - now;
  if (left <= 0) return "shortly";
  if (left < HOUR) return `in ${Math.max(1, Math.ceil(left / MINUTE))} min`;
  if (left < DAY) return `in ${Math.ceil(left / HOUR)} hour${Math.ceil(left / HOUR) === 1 ? "" : "s"}`;
  const days = Math.ceil(left / DAY);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

// The one sentence a banned player sees, wherever they hit the wall.
//
// The reason is included when there is one. Not because we owe an argument, but
// because "you are suspended" with no cause is the kind of message that
// generates a support conversation instead of ending one — and whoever typed
// the reason meant it to be read.
function banMessage(ban, now = Date.now()) {
  if (!ban) return "";
  const when = ban.until == null ? "This is permanent." : `It lifts ${remainingLabel(ban.until, now)}.`;
  const why = ban.reason ? ` Reason: ${ban.reason}` : "";
  return `Your account is suspended. ${when}${why}`;
}

module.exports = { banMessage, remainingLabel };
