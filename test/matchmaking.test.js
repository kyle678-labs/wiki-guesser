"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

// Env must be set before the app is required (startTestServer requires it lazily).
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.REVEAL_SECONDS = "1";
process.env.DATA_DIR = helpers.tempDataDir();

const { startTestServer, guestSession, connect, once } = helpers;
const { titleWords, textFreq } = require("../server/game/scoring");

// A no-network mystery source, in case a matched room's auto-start fires
// before teardown. Matchmaking behaviour itself doesn't depend on it.
const mockFetch = async () => ({
  title: "Test",
  words: titleWords("Test"),
  img: "http://example.test/i.png",
  desc: "",
  freq: textFreq("test test"),
});

let ctx;
before(async () => { ctx = await startTestServer({ roomOptions: { fetchMystery: mockFetch } }); });
after(async () => { await ctx.close(); });

test("two casual players who chose the same mode match into one room", async () => {
  const a = await guestSession(ctx.port, "Alice");
  const b = await guestSession(ctx.port, "Bob");
  assert.notEqual(a.user.id, b.user.id, "guests should have distinct identities");

  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const ma = once(sa, "match:found");
  const mb = once(sb, "match:found");
  sa.emit("queue:join", { ranked: false, clue: "image" });
  sb.emit("queue:join", { ranked: false, clue: "image" });

  const [ra, rb] = await Promise.all([ma, mb]);
  assert.equal(ra.code, rb.code, "both players should land in the same room");
  assert.equal(ra.ranked, false);
  assert.equal(ra.clue, "image");

  sa.close();
  sb.close();
});

test("players who chose different modes do not match", async () => {
  const a = await guestSession(ctx.port, "PicFan");
  const b = await guestSession(ctx.port, "TextFan");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  sa.emit("queue:join", { ranked: false, clue: "image" });
  await once(sa, "queue:waiting");
  sb.emit("queue:join", { ranked: false, clue: "text" });
  await once(sb, "queue:waiting");

  await assert.rejects(once(sa, "match:found", 1500), /timeout/);

  sa.close();
  sb.close();
});

test("ranked queue rejects guests", async () => {
  const a = await guestSession(ctx.port, "GuestOnly");
  const sa = connect(ctx.port, a.cookie);
  await once(sa, "me");

  const err = once(sa, "room:error");
  sa.emit("queue:join", { ranked: true, clue: "mixed" });
  const e = await err;
  assert.match(e.message, /sign in/i);

  sa.close();
});

test("leaving the queue prevents a match", async () => {
  const a = await guestSession(ctx.port, "Leaver");
  const b = await guestSession(ctx.port, "Solo");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  sa.emit("queue:join", { ranked: false, clue: "image" });
  await once(sa, "queue:waiting");
  sa.emit("queue:leave");
  await once(sa, "queue:left");

  // With A gone, B joining alone must not produce a match.
  sb.emit("queue:join", { ranked: false, clue: "image" });
  await once(sb, "queue:waiting");
  await assert.rejects(once(sb, "match:found", 1500), /timeout/);

  sa.close();
  sb.close();
});
