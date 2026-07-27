"use strict";

// Production-hardening behaviour: health checks, security headers, rate limits
// (HTTP and socket), error containment in the round loop, and the refusal to
// boot with an unsafe session secret.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const helpers = require("./helpers");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.REVEAL_SECONDS = "1";
process.env.DATA_DIR = helpers.tempDataDir();

const { startTestServer, guestSession, connect, once, get, postJson } = helpers;
const { TokenBucket } = require("../server/ratelimit");

// A mystery source that resolves with a row missing `words` — what a corrupt
// pool row looks like to nextRound(), which then throws while building the
// round:start payload. Exercises the rejection path, not the fetch path (that
// one nextRound already retries and handles).
const brokenMystery = async () => ({ title: "Broken", img: null, extract: "", freq: new Map() });

let srv;
before(async () => {
  srv = await startTestServer({
    socketLimits: { "room:create": { burst: 1, perSec: 0 } },
    roomOptions: { fetchMystery: async () => ({ title: "Fine", words: ["fine"], img: null, extract: "", freq: new Map() }) },
  });
});
after(() => srv.close());

// ── Token bucket ─────────────────────────────────────────────────────────────
test("a token bucket allows a burst then refuses until it refills", () => {
  const b = new TokenBucket(3, 1); // 3 burst, 1/sec
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false, "fourth call in the same tick is over budget");

  // Rewind the clock a second: exactly one token should have accrued.
  b.last -= 1000;
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
});

test("a token bucket never accrues more than its burst", () => {
  const b = new TokenBucket(2, 10);
  b.last -= 60_000; // a minute of idling would be 600 tokens, uncapped
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false, "idle time must not bank unlimited tokens");
});

// ── Health check ─────────────────────────────────────────────────────────────
test("/healthz reports ok and does not set a session cookie", async () => {
  const res = await get(srv.port, "/healthz");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptime, "number");
  assert.equal(res.headers["set-cookie"], undefined, "health polling must not mint sessions");
});

// ── Security headers ─────────────────────────────────────────────────────────
test("responses carry a CSP and omit the framework fingerprint", async () => {
  const res = await get(srv.port, "/");
  assert.equal(res.status, 200);
  const csp = res.headers["content-security-policy"];
  assert.ok(csp, "expected a Content-Security-Policy header");
  assert.match(csp, /frame-ancestors 'none'/, "must not be framable");
  assert.match(csp, /object-src 'none'/);
  // The theme bootstrap moved to /js/theme.js so this can stay nonce-free.
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "script-src must not allow inline scripts");
  assert.match(csp, /img-src[^;]*upload\.wikimedia\.org/, "article images must still load");
  assert.equal(res.headers["x-powered-by"], undefined);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});

test("the theme bootstrap is served as a real file so the CSP holds", async () => {
  const res = await get(srv.port, "/js/theme.js");
  assert.equal(res.status, 200);
  assert.match(res.body, /wg-theme/);
});

// ── HTTP rate limiting ───────────────────────────────────────────────────────
// Its own server: spending a limiter's budget is destructive, so it must not
// leak into the other tests' ability to create guest sessions.
test("/auth is rate limited once the window budget is spent", async () => {
  const local = await startTestServer({ rateLimit: { windowMs: 60_000, auth: 3, api: 3 } });
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const res = await postJson(local.port, "/auth/guest", { name: `Flood${i}` });
      codes.push(res.status);
    }
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200], "honest requests go through");
    assert.equal(codes[3], 429, "the 4th request in the window is refused");
    // Gameplay endpoints keep their own budget rather than sharing /auth's.
    assert.equal((await get(local.port, "/healthz")).status, 200);
  } finally {
    await local.close();
  }
});

// ── Error handling ───────────────────────────────────────────────────────────
test("an unknown API path returns JSON, not an HTML error page", async () => {
  const res = await get(srv.port, "/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.match(res.headers["content-type"], /application\/json/);
  assert.equal(JSON.parse(res.body).error, "Not found");
});

// ── Socket rate limiting ─────────────────────────────────────────────────────
test("a socket event over its budget is refused instead of doing the work", async () => {
  const { cookie } = await guestSession(srv.port, "Spammer");
  const sock = connect(srv.port, cookie);
  try {
    await once(sock, "me");

    sock.emit("room:create", {});
    const first = await once(sock, "room:joined");
    assert.ok(first.code, "the first room is created normally");

    const roomsBefore = srv.manager.rooms.size;
    sock.emit("room:create", {});
    const err = await once(sock, "room:error");
    assert.match(err.message, /too fast/i);
    assert.equal(srv.manager.rooms.size, roomsBefore, "the refused event must not allocate a room");
  } finally {
    sock.disconnect();
  }
});

// ── Round-loop containment ───────────────────────────────────────────────────
test("a round that throws returns the room to the lobby instead of crashing", async () => {
  const local = await startTestServer({ roomOptions: { fetchMystery: brokenMystery } });
  let sa, sb;
  try {
    const a = await guestSession(local.port, "Ann");
    const b = await guestSession(local.port, "Bea");
    sa = connect(local.port, a.cookie);
    sb = connect(local.port, b.cookie);
    await Promise.all([once(sa, "me"), once(sb, "me")]);

    sa.emit("room:create", {});
    const { code } = await once(sa, "room:joined");
    sb.emit("room:join", { code });
    await once(sb, "room:joined");

    sa.emit("room:start");
    const err = await once(sa, "room:error");
    assert.match(err.message, /went wrong/i);

    // The process is still up and the room is playable again — that's the whole
    // point of catching here rather than letting the rejection terminate Node.
    const room = local.manager.get(code);
    assert.ok(room, "a private room survives a failed round");
    assert.equal(room.phase, "lobby");
  } finally {
    if (sa) sa.disconnect();
    if (sb) sb.disconnect();
    await local.close();
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
test("shutdown drains rooms, closes handles, and exits cleanly", async () => {
  const { createShutdown } = require("../server/shutdown");
  const local = await startTestServer({
    roomOptions: { fetchMystery: async () => ({ title: "X", words: ["x"], img: null, extract: "", freq: new Map() }) },
  });

  // A live room with a pending timer — exactly what a hard kill would strand.
  const { cookie } = await guestSession(local.port, "Player");
  const sock = connect(local.port, cookie);
  await once(sock, "me");
  sock.emit("room:create", {});
  await once(sock, "room:joined");
  assert.equal(local.manager.rooms.size, 1);

  const exits = [];
  // Fake db: closing the real one would break the other tests sharing it.
  const shutdown = createShutdown({
    server: local.server,
    io: local.io,
    manager: local.manager,
    db: { close: () => {} },
    graceMs: 5000,
    exit: (code) => exits.push(code),
  });

  const warned = once(sock, "room:error");
  assert.equal(shutdown("SIGTERM"), true);
  const notice = await warned;
  assert.match(notice.message, /restarting/i, "players are told why they were dropped");

  assert.equal(shutdown("SIGTERM"), false, "a second signal while draining is ignored");
  assert.equal(local.manager.rooms.size, 0, "rooms and their timers are released");

  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(exits, [0], "exits exactly once, with a success code");

  sock.disconnect();
});

// ── Fail-fast configuration ──────────────────────────────────────────────────
// config.js reads the environment at require time, so this has to be a separate
// process rather than a mutated env in this one.
test("production refuses to boot without a strong SESSION_SECRET", () => {
  const loadConfig = (env) =>
    execFileSync(process.execPath, ["-e", 'require("./server/config")'], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...env },
      stdio: "pipe",
      encoding: "utf8",
    });

  assert.throws(
    () => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "" }),
    /SESSION_SECRET must be set/,
    "a missing secret must not fall back to the in-repo default"
  );

  assert.throws(
    () => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "too-short" }),
    /SESSION_SECRET must be set/,
    "a trivially short secret must be rejected too"
  );

  // A real secret boots fine.
  const ok = loadConfig({
    NODE_ENV: "production",
    SESSION_SECRET: "a".repeat(64),
    DATA_DIR: helpers.tempDataDir(),
  });
  assert.equal(typeof ok, "string");
});
