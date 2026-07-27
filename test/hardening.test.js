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

// ── Mystery pool: party-tier in-memory index ─────────────────────────────────
test("the party index never hands back a page already used this game", () => {
  const { pickFromIndex } = require("../server/game/pool");
  const rows = Array.from({ length: 50 }, (_, i) => ({ page_id: i, title: `T${i}` }));

  assert.equal(pickFromIndex([], new Set()), null, "an empty index yields nothing");
  assert.equal(pickFromIndex(null, new Set()), null, "a missing index yields nothing");

  // Random probing handles the normal case; drain the whole index to force the
  // linear-scan fallback and prove it stays correct rather than looping forever.
  const used = new Set();
  for (let i = 0; i < 50; i++) {
    const row = pickFromIndex(rows, used);
    assert.ok(row, `pick ${i} should succeed while pages remain`);
    assert.ok(!used.has(row.page_id), "never returns an already-used page");
    used.add(row.page_id);
  }
  assert.equal(used.size, 50, "every page was reachable");
  assert.equal(pickFromIndex(rows, used), null, "exhausted index reports empty rather than hanging");
});

test("warming the party index is survivable when no pool is on disk", (t) => {
  // warmPartyIndex() runs at boot before listen(); if a missing or unreadable
  // pool threw, the server would fail to start rather than degrading to the
  // SQLite path.
  const { warmPartyIndex } = require("../server/game/pool");
  const prev = process.env.MYSTERY_DB;
  t.after(() => {
    if (prev === undefined) delete process.env.MYSTERY_DB;
    else process.env.MYSTERY_DB = prev;
  });

  const config = require("../server/config");
  const prevPath = config.mysteryDb;
  config.mysteryDb = path.join(helpers.tempDataDir(), "does-not-exist.sqlite");
  t.after(() => { config.mysteryDb = prevPath; });

  assert.doesNotThrow(() => warmPartyIndex());
});

// ── Metrics ──────────────────────────────────────────────────────────────────
test("the metrics snapshot reports sane event-loop numbers", () => {
  const metrics = require("../server/metrics");
  const snap = metrics.snapshot();

  for (const key of ["loopLagP50Ms", "loopLagP99Ms", "loopLagMaxMs", "rssMb", "heapUsedMb"]) {
    assert.equal(typeof snap[key], "number", `${key} is a number`);
    assert.ok(Number.isFinite(snap[key]), `${key} is finite`);
    assert.ok(snap[key] >= 0, `${key} is non-negative`);
  }
  // An unpopulated interval histogram reports int64 max for max/percentiles;
  // unclamped that would surface as a ~9.2e12 ms "lag" on a healthy server.
  assert.ok(snap.loopLagMaxMs < 60000, "lag is clamped to something believable");
  assert.ok(snap.rssMb > 0, "rss is actually measured");
});

// ── Health check ─────────────────────────────────────────────────────────────
test("/healthz reports ok and does not set a session cookie", async () => {
  const res = await get(srv.port, "/healthz");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptime, "number");
  // Exposed so a monitor can watch the leading indicator without parsing logs.
  assert.equal(typeof body.loopLagP99Ms, "number", "health check reports event-loop lag");
  assert.equal(typeof body.rssMb, "number");
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

// ── Legal pages ──────────────────────────────────────────────────────────────
test("the privacy policy and terms are reachable and cross-linked", async () => {
  for (const [path, marker] of [
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Service"],
  ]) {
    const res = await get(srv.port, path);
    assert.equal(res.status, 200, `${path} must serve`);
    assert.match(res.body, new RegExp(marker));
    assert.match(res.body, /href="\/(privacy|terms)"/, `${path} must link to the other document`);
  }
});

test("reading the privacy policy sets no cookie", async () => {
  // The policy claims the only cookie is the sign-in session. Reading the policy
  // itself must therefore not mint one, or the document contradicts the site.
  const res = await get(srv.port, "/privacy");
  assert.equal(res.headers["set-cookie"], undefined);
});

// ── OAuth scope ──────────────────────────────────────────────────────────────
test("both OAuth strategies request an explicit, minimal scope", (t) => {
  // Google rejects an authorization request with no scope, and passport-google
  // -oauth20 supplies no default — so a missing scope silently breaks sign-in.
  // The scopes are also exactly what the privacy policy tells users we ask for.
  const passport = require("passport");
  const prev = {
    gi: process.env.GOOGLE_CLIENT_ID,
    gs: process.env.GOOGLE_CLIENT_SECRET,
    di: process.env.DISCORD_CLIENT_ID,
    ds: process.env.DISCORD_CLIENT_SECRET,
  };
  t.after(() => {
    for (const [k, v] of [
      ["GOOGLE_CLIENT_ID", prev.gi], ["GOOGLE_CLIENT_SECRET", prev.gs],
      ["DISCORD_CLIENT_ID", prev.di], ["DISCORD_CLIENT_SECRET", prev.ds],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.GOOGLE_CLIENT_ID = "test-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.DISCORD_CLIENT_ID = "test-id";
  process.env.DISCORD_CLIENT_SECRET = "test-secret";
  // config caches env at require time, so poke the live object the same way.
  const config = require("../server/config");
  config.google.clientId = config.google.clientSecret = "x";
  config.discord.clientId = config.discord.clientSecret = "x";
  require("../server/auth").configurePassport();

  assert.deepEqual(passport._strategy("google")._scope, ["profile"], "no email scope is requested");
  assert.deepEqual(passport._strategy("discord")._scope, ["identify"]);
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
