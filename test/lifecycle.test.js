"use strict";

// Room and connection lifecycle: the states a room can be left in between games,
// and the ways an identity can hold more of the server than it should.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.REVEAL_SECONDS = "1";
process.env.GUESS_SECONDS = "2";
process.env.MATCH_START_MS = "200";
process.env.BOT_FILL_MIN_MS = "250";
process.env.BOT_FILL_MAX_MS = "350";
process.env.DATA_DIR = helpers.tempDataDir();

const { startTestServer, guestSession, connect, once, waitFor } = helpers;
const { titleWords, textFreq } = require("../server/game/scoring");

const MYSTERY = {
  title: "Polar Bear",
  words: titleWords("Polar Bear"),
  img: "http://example.test/img.png",
  desc: "a test topic",
  url: "http://example.test/wiki/Polar_Bear",
  extract: "_____ is a large white bear.",
  extractFull: "Polar Bear is a large white bear.",
  freq: textFreq("The polar bear is a large white bear of the Arctic. Bear bear ice seal."),
};

let ctx;
before(async () => {
  ctx = await startTestServer({
    roomOptions: { fetchMystery: async () => ({ ...MYSTERY, freq: new Map(MYSTERY.freq) }) },
    maxSocketsPerIdentity: 3,
  });
});
after(async () => { await ctx.close(); });

// Play a private room from lobby to game over. Resolves once both clients have
// seen game:over.
async function playAGame(sa, sb, code) {
  const over = Promise.all([once(sa, "game:over", 20000), once(sb, "game:over", 20000)]);
  sa.emit("room:start");
  // One round, both guess immediately so we don't wait out the timer.
  await Promise.all([once(sa, "round:start", 15000), once(sb, "round:start", 15000)]);
  sa.emit("guess:submit", { text: "polar bear" });
  sb.emit("guess:submit", { text: "ice" });
  return over;
}

test("a finished private room returns to the lobby so it can be replayed", async () => {
  const a = await guestSession(ctx.port, "Ada");
  const b = await guestSession(ctx.port, "Bo");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const joined = once(sa, "room:joined");
  sa.emit("room:create", { rounds: 1, mode: "party", clue: "image" });
  const { code } = await joined;
  sb.emit("room:join", { code });
  await once(sb, "room:joined");

  // The lobby is what carries the Start button and the invite link on the
  // client, so a room stuck in "done" is a room nobody can start again.
  const backToLobby = waitFor(sa, "room:state", (s) => s.phase === "lobby" && s.round === 0, 20000);
  await playAGame(sa, sb, code);
  const state = await backToLobby;

  assert.equal(state.phase, "lobby", "private room parks in the lobby after game over");
  assert.equal(ctx.manager.rooms.get(code).phase, "lobby");

  // And it genuinely replays, rather than merely reporting the right phase.
  const secondRound = once(sa, "round:start", 15000);
  sa.emit("room:start");
  const r = await secondRound;
  assert.equal(r.round, 1, "a second game starts from round 1");
  assert.equal(ctx.manager.rooms.get(code).players.get(a.user.id).total, 0, "scores reset for the new game");

  sa.close();
  sb.close();
});

test("a finished matchmaking room stays done — there is no lobby to return to", async () => {
  const a = await guestSession(ctx.port, "Cy");
  const b = await guestSession(ctx.port, "Di");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const found = Promise.all([once(sa, "match:found", 15000), once(sb, "match:found", 15000)]);
  sa.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
  sb.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
  const [{ code }] = await found;

  const room = ctx.manager.rooms.get(code);
  room.settings.rounds = 1;
  await Promise.all([once(sa, "game:over", 20000), once(sb, "game:over", 20000)]);

  assert.equal(room.phase, "done", "matchmaking rooms are one-and-done");

  sa.close();
  sb.close();
});

// "Queue again" on the results screen is exactly this pair of events, sent on
// the socket the finished game was played on (see requeue() in public/js/play.js).
// The interesting part is that it happens from INSIDE a room: nothing else in
// the game queues without first being on the lobby page, so this is the one path
// where a stale `locate` entry or a room that refuses to let go would strand a
// player on a dead results screen.
test("queueing again from a finished match puts you in a new room", async () => {
  const a = await guestSession(ctx.port, "Kip");
  const b = await guestSession(ctx.port, "Lux");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const found = Promise.all([once(sa, "match:found", 15000), once(sb, "match:found", 15000)]);
  sa.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
  sb.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
  const [first] = await found;

  ctx.manager.rooms.get(first.code).settings.rounds = 1;
  await Promise.all([once(sa, "game:over", 20000), once(sb, "game:over", 20000)]);

  // Both press it, which is the ordinary case: the two people who just played
  // are the two most likely to want another.
  const again = Promise.all([once(sa, "match:found", 15000), once(sb, "match:found", 15000)]);
  for (const s of [sa, sb]) {
    s.emit("room:leave");
    // The settings come off the finished room's own state, so the second match
    // is the same game on the same ladder as the first.
    s.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
  }
  const [second] = await again;

  assert.notEqual(second.code, first.code, "a new room, not the one that just ended");
  assert.equal(second.clue, "image");
  assert.equal(second.tier, "party");
  assert.equal(ctx.manager.locate.get(a.user.id), second.code, "and the player is in it");
  assert.equal(ctx.manager.locate.get(b.user.id), second.code);
  // The finished room let go rather than leaving them nominally in two places.
  assert.equal(ctx.manager.rooms.has(first.code), false);

  // It plays: a requeue that lands in a room which never starts is no better
  // than being sent back to the menu.
  await Promise.all([once(sa, "round:start", 15000), once(sb, "round:start", 15000)]);

  sa.close();
  sb.close();
});

test("creating a room takes you out of the matchmaking queue", async () => {
  const c = await guestSession(ctx.port, "Eli");
  // Two sockets on one identity: one queues, the other creates a room. Without
  // the dequeue, the pending casual bot-fill fires and relocates the identity
  // into a bot room — silently pulling them out of the room they just made.
  const s1 = connect(ctx.port, c.cookie);
  const s2 = connect(ctx.port, c.cookie);
  await Promise.all([once(s1, "me"), once(s2, "me")]);

  s1.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
  await once(s1, "queue:waiting");

  const joined = once(s2, "room:joined");
  s2.emit("room:create", { rounds: 3, mode: "party", clue: "image" });
  const { code } = await joined;

  let yanked = null;
  s1.on("match:found", (m) => (yanked = m));
  await new Promise((r) => setTimeout(r, 800)); // past the bot-fill window

  assert.equal(yanked, null, "no match fires after entering a room");
  assert.equal(ctx.manager.locate.get(c.user.id), code, "still in the room they created");

  s1.close();
  s2.close();
});

test("joining a room takes you out of the queue, but a failed join does not", async () => {
  const host = await guestSession(ctx.port, "Fay");
  const sh = connect(ctx.port, host.cookie);
  await once(sh, "me");
  const joined = once(sh, "room:joined");
  sh.emit("room:create", { rounds: 3, mode: "party", clue: "image" });
  const { code } = await joined;

  const g = await guestSession(ctx.port, "Gil");
  const s1 = connect(ctx.port, g.cookie);
  const s2 = connect(ctx.port, g.cookie);
  await Promise.all([once(s1, "me"), once(s2, "me")]);

  // A join that fails must leave the player queued — they are still looking for
  // a game, and dropping them from the queue would strand them.
  s1.emit("queue:join", { ranked: false, clue: "text", tier: "chaos" });
  await once(s1, "queue:waiting");
  s2.emit("room:join", { code: "ZZZZZ" });
  await once(s2, "room:error");
  assert.ok(
    ctx.manager.queues.get("casual:text:chaos").some((e) => e.user.id === g.user.id),
    "a failed join leaves the queue entry alone"
  );

  s2.emit("room:join", { code });
  await once(s2, "room:joined");
  assert.ok(
    !ctx.manager.queues.get("casual:text:chaos").some((e) => e.user.id === g.user.id),
    "a successful join clears it"
  );

  sh.close();
  s1.close();
  s2.close();
});

test("a private room's host can change the round timer, and it governs the round", async () => {
  const a = await guestSession(ctx.port, "Ivo");
  const b = await guestSession(ctx.port, "Jem");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const joined = once(sa, "room:joined");
  sa.emit("room:create", { rounds: 1, mode: "party", clue: "image" });
  const { code } = await joined;
  sb.emit("room:join", { code });
  await once(sb, "room:joined");

  const room = ctx.manager.rooms.get(code);
  assert.equal(room.settings.guessSeconds, 2, "starts at the server default");

  const applied = waitFor(sa, "room:state", (s) => s.settings.guessSeconds === 8, 5000);
  sa.emit("room:settings", { guessSeconds: 8 });
  await applied;

  // Out-of-range values clamp rather than being taken literally — a zero-second
  // or hour-long round is not a setting, it is a broken game.
  sa.emit("room:settings", { guessSeconds: 999 });
  await waitFor(sa, "room:state", (s) => s.settings.guessSeconds === 120, 5000);
  sa.emit("room:settings", { guessSeconds: 1 });
  await waitFor(sa, "room:state", (s) => s.settings.guessSeconds === 5, 5000);

  // And the round actually runs to the room's timer, not the server default.
  sa.emit("room:settings", { guessSeconds: 6 });
  await waitFor(sa, "room:state", (s) => s.settings.guessSeconds === 6, 5000);
  const started = once(sa, "round:start", 15000);
  sa.emit("room:start");
  const r = await started;
  const window = r.endsAt - Date.now();
  assert.ok(window > 4500 && window <= 6000, `round window ~6s, got ${window}ms`);

  sa.close();
  sb.close();
});

test("a guest who is not the host cannot change a private room's settings", async () => {
  const a = await guestSession(ctx.port, "Kai");
  const b = await guestSession(ctx.port, "Lux");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const joined = once(sa, "room:joined");
  sa.emit("room:create", { rounds: 1, mode: "party", clue: "image" });
  const { code } = await joined;
  sb.emit("room:join", { code });
  await once(sb, "room:joined");

  sb.emit("room:settings", { guessSeconds: 60 });
  const err = await once(sb, "room:error", 5000);
  assert.match(err.message, /only the host/i);
  assert.equal(ctx.manager.rooms.get(code).settings.guessSeconds, 2, "unchanged");

  sa.close();
  sb.close();
});

test("a matchmaking room's settings cannot be edited by its players", async () => {
  // They come from the queue both players chose. For ranked they also decide
  // which ladder the Elo lands on, so an edit during the pre-match countdown
  // would be a way onto a ladder the player never queued for.
  const a = await guestSession(ctx.port, "Mio");
  const b = await guestSession(ctx.port, "Noa");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const found = Promise.all([once(sa, "match:found", 15000), once(sb, "match:found", 15000)]);
  sa.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
  sb.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
  const [{ code }] = await found;

  sa.emit("room:settings", { clue: "text", mode: "chaos", guessSeconds: 90 });
  const err = await once(sa, "room:error", 5000);
  assert.match(err.message, /fixed/i);

  const room = ctx.manager.rooms.get(code);
  assert.equal(room.settings.clue, "image", "clue unchanged");
  assert.equal(room.settings.mode, "party", "tier — and so the ladder — unchanged");
  assert.equal(room.settings.guessSeconds, 2, "timer unchanged");

  sa.close();
  sb.close();
});

test("an identity cannot hold more sockets than its cap", async () => {
  // The per-event token buckets are per socket, so without a cap an identity
  // multiplies every rate limit by simply opening more connections — and
  // Socket.IO handles its own traffic ahead of Express, so express-rate-limit
  // never sees it. The cap is 3 for this server.
  const h = await guestSession(ctx.port, "Hana");
  const socks = [];
  for (let i = 0; i < 3; i++) {
    const s = connect(ctx.port, h.cookie);
    await once(s, "me");
    socks.push(s);
  }

  const extra = connect(ctx.port, h.cookie);
  const err = await once(extra, "connect_error", 5000);
  assert.match(err.message, /too many open connections/i);
  // Rejected during the handshake, so the client treats it as fatal and stops —
  // a server-side disconnect would have it reconnecting in a loop instead.
  assert.equal(extra.active, false, "the client does not retry a refused handshake");
  extra.close();

  // Closing one frees a slot, so this is a ceiling and not a permanent lockout.
  socks[0].close();
  await new Promise((r) => setTimeout(r, 300));
  const replacement = connect(ctx.port, h.cookie);
  await once(replacement, "me", 5000);

  socks.slice(1).forEach((s) => s.close());
  replacement.close();
});
