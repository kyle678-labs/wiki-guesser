"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.REVEAL_SECONDS = "1"; // keep the reveal pause short so the game is quick
process.env.GRACE_MS = "300"; // short reconnect window so the forfeit test is fast
process.env.DATA_DIR = helpers.tempDataDir();

const { startTestServer, guestSession, connect, once, waitFor } = helpers;
const { titleWords, textFreq } = require("../server/game/scoring");
const { buildClue } = require("../server/game/extract");

// Deterministic mystery source: no network, fixed answers in order. Setting
// `forced` pins the next answers (used by the speed-bonus test).
const ANSWERS = [
  { title: "Polar Bear", text: "The polar bear is a large white bear of the Arctic. Bear bear ice seal." },
  { title: "Sushi", text: "Sushi is a Japanese dish of vinegared rice and fresh fish. Rice fish fish." },
];
let forced = null;
const asMystery = (a) => {
  const clue = buildClue(a.text, a.title, 2);
  return {
    title: a.title,
    words: titleWords(a.title),
    img: "http://example.test/img.png",
    desc: "a test topic",
    url: "http://example.test/wiki/" + encodeURIComponent(a.title),
    extract: clue.blanked,
    extractFull: clue.full,
    freq: textFreq(a.text),
  };
};
function mockFetchFactory() {
  let i = 0;
  return async () => {
    if (forced) return asMystery(forced);
    return asMystery(ANSWERS[i++ % ANSWERS.length]);
  };
}

let ctx;
before(async () => { ctx = await startTestServer({ roomOptions: { fetchMystery: mockFetchFactory() } }); });
after(async () => { await ctx.close(); });

test("a private 2-player game runs every round through to game over", async () => {
  const a = await guestSession(ctx.port, "Alice");
  const b = await guestSession(ctx.port, "Bob");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  // Alice creates a 2-round room.
  const joinedA = once(sa, "room:joined");
  sa.emit("room:create", { rounds: 2, mode: "party", maxPlayers: 8 });
  const { code } = await joinedA;

  // Watch for the full 2-player lobby BEFORE Bob joins so we don't miss the state.
  const twoPlayers = waitFor(sa, "room:state", (st) => st.players.length === 2 && st.phase === "lobby");
  const joinedB = once(sb, "room:joined");
  sb.emit("room:join", { code });
  await joinedB;
  await twoPlayers;

  // Each round: Alice names the answers, Bob submits junk.
  let rounds = 0;
  sa.on("round:start", () => { rounds++; sa.emit("guess:submit", { text: "polar bear sushi" }); });
  sb.on("round:start", () => sb.emit("guess:submit", { text: "zzz nonsense" }));

  let reveals = 0;
  sa.on("round:reveal", () => reveals++);

  const over = once(sa, "game:over", 20000);
  sa.emit("room:start");
  const result = await over;

  assert.equal(rounds, 2, "both rounds should start");
  assert.equal(reveals, 2, "both rounds should reveal");
  assert.equal(result.standings.length, 2);
  assert.equal(result.ranked, false);

  const alice = result.standings.find((s) => s.name.startsWith("Alice"));
  const bob = result.standings.find((s) => s.name.startsWith("Bob"));
  assert.ok(alice.total > 0, "Alice named the answers, should have points");
  assert.ok(alice.total >= bob.total, `Alice ${alice.total} should be >= Bob ${bob.total}`);

  // Recap history: one entry per round, each with topic, image, link, and scores.
  assert.equal(result.history.length, 2, "recap should have one entry per round");
  for (const h of result.history) {
    assert.ok(h.title && h.image && h.url, "recap entry has topic, image, and article link");
    assert.equal(h.scores.length, 2, "recap entry lists every player's round score");
  }

  sa.close();
  sb.close();
});

test("guessing early ends the round without waiting out the timer", async () => {
  const a = await guestSession(ctx.port, "Fast1");
  const b = await guestSession(ctx.port, "Fast2");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const joinedA = once(sa, "room:joined");
  sa.emit("room:create", { rounds: 1, mode: "party" });
  const { code } = await joinedA;

  const twoPlayers = waitFor(sa, "room:state", (st) => st.players.length === 2 && st.phase === "lobby");
  const joinedB = once(sb, "room:joined");
  sb.emit("room:join", { code });
  await joinedB;
  await twoPlayers;

  sa.on("round:start", () => sa.emit("guess:submit", { text: "polar bear" }));
  sb.on("round:start", () => sb.emit("guess:submit", { text: "polar bear" }));

  const startedAt = Date.now();
  const reveal = once(sa, "round:reveal", 10000);
  sa.emit("room:start");
  await reveal;
  // GUESS_SECONDS defaults to 35; both submitted, so reveal must come far sooner.
  assert.ok(Date.now() - startedAt < 10000, "reveal should not wait for the full guess timer");

  sa.close();
  sb.close();
});

test("a player leaving mid-game forfeits the win to whoever stays", async () => {
  const a = await guestSession(ctx.port, "Stayer");
  const b = await guestSession(ctx.port, "Quitter");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const joinedA = once(sa, "room:joined");
  sa.emit("room:create", { rounds: 5, mode: "party" });
  const { code } = await joinedA;

  const twoPlayers = waitFor(sa, "room:state", (st) => st.players.length === 2 && st.phase === "lobby");
  const joinedB = once(sb, "room:joined");
  sb.emit("room:join", { code });
  await joinedB;
  await twoPlayers;

  // As soon as the first round begins, the Stayer guesses and the Quitter drops.
  let dropped = false;
  sa.on("round:start", () => {
    sa.emit("guess:submit", { text: "polar bear" });
    if (!dropped) { dropped = true; sb.close(); }
  });

  const over = once(sa, "game:over", 8000);
  sa.emit("room:start");
  const result = await over;

  assert.equal(result.forfeit, true, "should be flagged as a forfeit");
  assert.equal(result.winnerId, a.user.id, "the player who stayed should be the winner");
  assert.equal(result.standings[0].id, a.user.id, "winner listed first");
  // The game ended early rather than playing out all 5 rounds.

  sa.close();
});

test("the faster of two identical correct guesses scores higher", async () => {
  forced = { title: "Polar Bear", text: ANSWERS[0].text };
  try {
    const a = await guestSession(ctx.port, "Speedy");
    const b = await guestSession(ctx.port, "Slowpoke");
    const sa = connect(ctx.port, a.cookie);
    const sb = connect(ctx.port, b.cookie);
    await Promise.all([once(sa, "me"), once(sb, "me")]);

    const joinedA = once(sa, "room:joined");
    sa.emit("room:create", { rounds: 1, mode: "party" });
    const { code } = await joinedA;

    const twoPlayers = waitFor(sa, "room:state", (st) => st.players.length === 2 && st.phase === "lobby");
    const joinedB = once(sb, "room:joined");
    sb.emit("room:join", { code });
    await joinedB;
    await twoPlayers;

    // Both guess the same correct word — Speedy instantly, Slowpoke after a delay.
    sa.on("round:start", () => sa.emit("guess:submit", { text: "polar bear" }));
    sb.on("round:start", () => setTimeout(() => sb.emit("guess:submit", { text: "polar bear" }), 2500));

    const reveal = once(sa, "round:reveal", 12000);
    sa.emit("room:start");
    const r = await reveal;

    const fast = r.results.find((x) => x.id === a.user.id);
    const slow = r.results.find((x) => x.id === b.user.id);
    assert.ok(fast.base > 0, "the shared correct guess should score on accuracy");
    assert.equal(fast.base, slow.base, "same word → identical accuracy base");
    assert.ok(fast.speedBonus > slow.speedBonus, `faster bonus ${fast.speedBonus} should beat slower ${slow.speedBonus}`);
    assert.ok(fast.points > slow.points, `faster total ${fast.points} should beat slower ${slow.points}`);

    sa.close();
    sb.close();
  } finally {
    forced = null;
  }
});

test("description mode sends a blanked text clue with the title hidden", async () => {
  forced = { title: "Polar Bear", text: ANSWERS[0].text };
  try {
    const a = await guestSession(ctx.port, "Reader");
    const b = await guestSession(ctx.port, "Reader2");
    const sa = connect(ctx.port, a.cookie);
    const sb = connect(ctx.port, b.cookie);
    await Promise.all([once(sa, "me"), once(sb, "me")]);

    const joinedA = once(sa, "room:joined");
    sa.emit("room:create", { rounds: 1, mode: "party", clue: "text" });
    const { code } = await joinedA;

    const twoPlayers = waitFor(sa, "room:state", (st) => st.players.length === 2 && st.phase === "lobby");
    const joinedB = once(sb, "room:joined");
    sb.emit("room:join", { code });
    await joinedB;
    await twoPlayers;

    // Let the round resolve so the server doesn't sit waiting.
    sa.on("round:start", () => sa.emit("guess:submit", { text: "polar bear" }));
    sb.on("round:start", () => sb.emit("guess:submit", { text: "polar bear" }));

    const started = once(sa, "round:start", 8000);
    sa.emit("room:start");
    const r = await started;

    assert.equal(r.clue, "text", "round should be flagged as a description clue");
    assert.ok(r.extract && r.extract.includes("_____"), "the clue text should contain a blank");
    assert.ok(!/polar/i.test(r.extract) && !/\bbear\b/i.test(r.extract), "the title words must be hidden");

    sa.close();
    sb.close();
  } finally {
    forced = null;
  }
});
