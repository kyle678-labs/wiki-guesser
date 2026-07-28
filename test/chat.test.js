"use strict";

// Chat moderation: reporting a message, the per-player mute, and the host's
// room-wide chat switch.
//
// The report path is the security-sensitive one. A report carries only a message
// ID; the text and the author are resolved from the room's own buffer. If that
// ever regressed to trusting client-supplied text, anyone could manufacture a
// message and pin it on another player — and it would land in the moderation log
// looking exactly like a real one.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = helpers.tempDataDir();

const { startTestServer, guestSession, accountSession, connect, once, waitFor, postJson, get } = helpers;
const { Room } = require("../server/rooms");

let srv;
before(async () => {
  srv = await startTestServer({
    roomOptions: {
      fetchMystery: async () => ({ title: "Fine", words: ["fine"], img: null, extract: "", freq: new Map() }),
    },
  });
});
after(() => srv.close());

// A Room needs only an `io` with a working to().emit() for the chat paths.
function bareRoom(overrides = {}) {
  const sent = [];
  const io = { to: () => ({ emit: (event, payload) => sent.push({ event, payload }) }) };
  const room = new Room(io, { locate: new Map(), rooms: new Map() }, { code: "TESTS", isPrivate: true, ...overrides });
  return { room, sent };
}

const alice = { id: "u1", userId: 1, name: "Alice" };
const bob = { id: "u2", userId: 2, name: "Bob" };

// ── Posting ──────────────────────────────────────────────────────────────────

test("a posted message is broadcast with an id and sanitised", () => {
  const { room, sent } = bareRoom();
  const res = room.postChat(alice, "  hello <script>alert(1)</script>  ");
  assert.equal(res.ok, true);

  const msg = sent.at(-1).payload;
  assert.equal(sent.at(-1).event, "chat:msg");
  assert.ok(msg.id, "a message needs an id or it cannot be reported");
  assert.equal(msg.fromId, "u1");
  assert.ok(!msg.text.includes("<"), "angle brackets must be stripped server-side");
  assert.equal(msg.text, "hello scriptalert(1)/script");
});

test("an empty message is a no-op rather than an error", () => {
  const { room, sent } = bareRoom();
  assert.equal(room.postChat(alice, "   ").ok, true);
  assert.equal(sent.length, 0, "nothing should be broadcast");
});

test("the in-memory buffer is capped and drops the oldest first", () => {
  const { room } = bareRoom();
  for (let i = 0; i < 60; i++) room.postChat(alice, `m${i}`);
  assert.equal(room.chatLog.length, 50);
  assert.equal(room.chatLog[0].text, "m10", "oldest messages must fall out");
});

// ── Reporting ────────────────────────────────────────────────────────────────

test("a report resolves the message from the server's own buffer", () => {
  const { room } = bareRoom();
  room.postChat(alice, "something rude");
  const id = room.chatLog.at(-1).id;

  assert.equal(room.reportChat(bob, id).ok, true);
  assert.ok(room.reported.has(`u2:${id}`));
});

test("a report for an unknown or invented message id is refused", () => {
  const { room } = bareRoom();
  room.postChat(alice, "hello");
  // The shape an attacker would try: a plausible id that was never issued.
  assert.ok(room.reportChat(bob, "c999").error);
  assert.ok(room.reportChat(bob, "").error);
  assert.ok(room.reportChat(bob, null).error);
  assert.ok(room.reportChat(bob, { text: "fabricated" }).error);
});

test("reporting your own message is refused", () => {
  const { room } = bareRoom();
  room.postChat(alice, "my own words");
  const id = room.chatLog.at(-1).id;
  assert.ok(room.reportChat(alice, id).error);
});

test("reporting the same message twice acknowledges but only records once", () => {
  const { room } = bareRoom();
  room.postChat(alice, "spam me");
  const id = room.chatLog.at(-1).id;

  assert.equal(room.reportChat(bob, id).ok, true);
  const second = room.reportChat(bob, id);
  assert.equal(second.ok, true);
  assert.equal(second.already, true);
  assert.equal(room.reported.size, 1);
});

test("the reported text is the broadcast text, not anything the reporter supplies", () => {
  const { room } = bareRoom();
  room.postChat(alice, "perfectly fine message");
  const stored = room.chatLog.at(-1);
  // There is no parameter through which a reporter could pass alternative text —
  // reportChat takes an id and nothing else. Assert the stored record is intact.
  room.reportChat(bob, stored.id);
  assert.equal(room.chatLog.at(-1).text, "perfectly fine message");
  assert.equal(room.chatLog.at(-1).fromId, "u1");
});

// ── Room-wide switch ─────────────────────────────────────────────────────────

test("chat is on by default and the host can switch it off for everyone", () => {
  const { room, sent } = bareRoom({ hostId: "u1" });
  assert.equal(room.settings.chatEnabled, true);

  assert.equal(room.updateSettings("u1", { chatEnabled: false }).ok, true);
  assert.equal(room.settings.chatEnabled, false);

  const before = sent.length;
  assert.ok(room.postChat(alice, "hello?").error, "posting must be refused when chat is off");
  assert.equal(sent.filter((s) => s.event === "chat:msg").length, 0);
  assert.ok(sent.length >= before, "state is still broadcast");
});

test("the chat switch survives arriving as a string from a form control", () => {
  const { room } = bareRoom({ hostId: "u1" });
  // Boolean("false") is true, which would make the setting impossible to clear.
  room.updateSettings("u1", { chatEnabled: "false" });
  assert.equal(room.settings.chatEnabled, false);
  room.updateSettings("u1", { chatEnabled: "true" });
  assert.equal(room.settings.chatEnabled, true);
  // Anything unrecognised leaves it alone rather than silently disabling chat.
  room.updateSettings("u1", { chatEnabled: "banana" });
  assert.equal(room.settings.chatEnabled, true);
});

test("only the host can change the chat setting", () => {
  const { room } = bareRoom({ hostId: "u1" });
  assert.ok(room.updateSettings("u2", { chatEnabled: false }).error);
  assert.equal(room.settings.chatEnabled, true);
});

test("a matchmaking room's chat setting is fixed", () => {
  const { room } = bareRoom({ isPrivate: false, hostId: "u1" });
  assert.ok(room.updateSettings("u1", { chatEnabled: false }).error);
  assert.equal(room.settings.chatEnabled, true);
});

// ── The per-player mute ──────────────────────────────────────────────────────

test("an account's chat preference persists and is reported on the identity", async () => {
  const { cookie, user } = await accountSession(srv.port, "Muter");

  const before = JSON.parse((await get(srv.port, "/auth/me", cookie)).body);
  assert.equal(before.user.chatEnabled, true, "chat is on by default");

  const res = await postJson(srv.port, "/api/settings/chat", { enabled: false }, cookie);
  assert.equal(res.status, 200);

  const after = JSON.parse((await get(srv.port, "/auth/me", cookie)).body);
  assert.equal(after.user.chatEnabled, false, "the mute must survive a fresh request");

  // And it is on the account, not the session — a different session for the same
  // user sees it too.
  const { getUserById } = require("../server/db");
  assert.equal(getUserById(user.id).chat_enabled, 0);
});

test("a guest's chat preference persists on their session", async () => {
  const { cookie } = await guestSession(srv.port, "Ghost");

  assert.equal(JSON.parse((await get(srv.port, "/auth/me", cookie)).body).user.chatEnabled, true);
  assert.equal((await postJson(srv.port, "/api/settings/chat", { enabled: false }, cookie)).status, 200);
  assert.equal(JSON.parse((await get(srv.port, "/auth/me", cookie)).body).user.chatEnabled, false);
});

test("the chat preference endpoint refuses anonymous callers and non-booleans", async () => {
  assert.equal((await postJson(srv.port, "/api/settings/chat", { enabled: false })).status, 401);

  const { cookie } = await guestSession(srv.port, "Picky");
  assert.equal((await postJson(srv.port, "/api/settings/chat", { enabled: "false" }, cookie)).status, 400);
  assert.equal((await postJson(srv.port, "/api/settings/chat", {}, cookie)).status, 400);
});

// ── End to end over the socket ───────────────────────────────────────────────

// Resolves true if `event` does NOT arrive within `ms`. Proving a negative needs
// a window; 600ms is far longer than an in-process socket round trip.
//
// Like every observer here, this must be attached BEFORE the action that might
// trigger it. Socket.IO does not replay events, so a listener registered after
// the fact waits forever — which is a test that fails for a reason that has
// nothing to do with the behaviour under test.
function notReceived(sock, event, ms = 600) {
  return new Promise((resolve) => {
    const onEvent = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { sock.off(event, onEvent); resolve(true); }, ms);
    sock.once(event, onEvent);
  });
}

// Both sockets connect concurrently, so their "me" events land at roughly the
// same moment. Awaiting one and THEN listening for the other loses whichever
// arrived first. Attach both listeners up front, then await.
const bothReady = (sa, sb) => Promise.all([once(sa, "me"), once(sb, "me")]);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("a muted player stops RECEIVING chat, not merely seeing it", async () => {
  const a = await accountSession(srv.port, "Talker");
  const b = await accountSession(srv.port, "Muted");
  const sa = connect(srv.port, a.cookie);
  const sb = connect(srv.port, b.cookie);

  try {
    await bothReady(sa, sb);
    sa.emit("room:create", {});
    const { code } = await once(sa, "room:joined");
    sb.emit("room:join", { code });
    await once(sb, "room:joined");

    // Baseline: chat is delivered before muting.
    const gotBefore = waitFor(sb, "chat:msg", (m) => m.text === "before the mute");
    sa.emit("chat:send", { text: "before the mute" });
    assert.ok(await gotBefore);

    sb.emit("chat:mute", { enabled: false });
    await pause(150); // let the channel leave apply

    // Both observers armed before the send, so neither can race it.
    const senderSees = waitFor(sa, "chat:msg", (m) => m.text === "should never arrive", 2000);
    const mutedGets = notReceived(sb, "chat:msg");
    sa.emit("chat:send", { text: "should never arrive" });

    assert.equal(await mutedGets, true, "a muted socket must not receive chat at all");
    // The sender still sees their own message — only the muted player is out.
    assert.ok(await senderSees, "muting one player must not stop delivery to everyone else");

    // And unmuting restores delivery.
    sb.emit("chat:mute", { enabled: true });
    await pause(150);
    const gotAfter = waitFor(sb, "chat:msg", (m) => m.text === "after unmuting");
    sa.emit("chat:send", { text: "after unmuting" });
    assert.ok(await gotAfter);
  } finally {
    sa.close();
    sb.close();
  }
});

test("a saved mute suppresses delivery from the moment the player joins", async () => {
  const a = await accountSession(srv.port, "Talker2");
  const b = await accountSession(srv.port, "PreMuted");
  // Persisted BEFORE connecting, the way a returning player arrives.
  await postJson(srv.port, "/api/settings/chat", { enabled: false }, b.cookie);

  const sa = connect(srv.port, a.cookie);
  const sb = connect(srv.port, b.cookie);
  try {
    const [, bMe] = await bothReady(sa, sb);
    assert.equal(bMe.user.chatEnabled, false, "the stored mute must reach the socket identity");

    sa.emit("room:create", {});
    const { code } = await once(sa, "room:joined");
    sb.emit("room:join", { code });
    await once(sb, "room:joined");

    const mutedGets = notReceived(sb, "chat:msg");
    sa.emit("chat:send", { text: "invisible to the pre-muted" });
    assert.equal(
      await mutedGets,
      true,
      "delivery must follow the stored preference without any client toggle"
    );
  } finally {
    sa.close();
    sb.close();
  }
});

test("muting does not cut a player off from anything else", async () => {
  const a = await accountSession(srv.port, "Host3");
  const b = await accountSession(srv.port, "Quiet3");
  const sa = connect(srv.port, a.cookie);
  const sb = connect(srv.port, b.cookie);

  try {
    await bothReady(sa, sb);
    sa.emit("room:create", {});
    const { code } = await once(sa, "room:joined");
    sb.emit("room:join", { code });
    await once(sb, "room:joined");

    sb.emit("chat:mute", { enabled: false });
    await new Promise((r) => setTimeout(r, 150));

    // Room state still reaches them — a mute is not a partial disconnect.
    sa.emit("room:settings", { rounds: 7 });
    const state = await waitFor(sb, "room:state", (s) => s.settings.rounds === 7, 2000);
    assert.equal(state.settings.rounds, 7);
  } finally {
    sa.close();
    sb.close();
  }
});

test("a reported message reaches the server and is acknowledged to the reporter", async () => {
  const a = await accountSession(srv.port, "Sender");
  const b = await accountSession(srv.port, "Reporter");
  const sa = connect(srv.port, a.cookie);
  const sb = connect(srv.port, b.cookie);

  try {
    await once(sa, "me");
    await once(sb, "me");

    sa.emit("room:create", {});
    const { code } = await once(sa, "room:joined");
    sb.emit("room:join", { code });
    await once(sb, "room:joined");

    sa.emit("chat:send", { text: "you are terrible at this" });
    const msg = await waitFor(sb, "chat:msg", (m) => m.text.includes("terrible"));
    assert.ok(msg.id);

    sb.emit("chat:report", { id: msg.id });
    const ack = await once(sb, "chat:reported");
    assert.equal(ack.id, msg.id);
  } finally {
    sa.close();
    sb.close();
  }
});
