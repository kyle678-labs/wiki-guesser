"use strict";

// The admin dashboard: who can reach it, what the moderation queue does, and
// what a ban actually stops.
//
// The access-control tests are the ones that matter most, and they are asserting
// something slightly unusual: every rejection is a 404, not a 403. A 403 would
// confirm to anyone who guessed the URL that /admin exists and that an allowlist
// is the only thing in the way. If that ever regresses to a 403 the dashboard
// still works perfectly and every other test here still passes.
//
// The ban tests assert enforcement at the two places that can actually stop
// someone — the Socket.IO handshake and the daily routes — rather than at the
// dashboard, because the dashboard is not where a banned player goes.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.REVEAL_SECONDS = "1";
process.env.GUESS_SECONDS = "2";
process.env.MATCH_START_MS = "200";
process.env.BOT_FILL = "false";
process.env.DATA_DIR = helpers.tempDataDir();
// The admin is granted by account id, and on a fresh database the first account
// created is id 1. Asserted in the before hook below rather than assumed, so a
// change in how ids are handed out fails here with a readable message instead of
// turning every test in this file into a mystery 404.
process.env.ADMIN_USER_IDS = "1";

const { startTestServer, guestSession, accountSession, connect, once, get, postJson, del } = helpers;
const config = require("../server/config");
const { db, activeBan, listChatReports, banUser } = require("../server/db");
const { banMessage, remainingLabel } = require("../server/moderation");

let srv, admin, mod, player, guest;

before(async () => {
  srv = await startTestServer({
    roomOptions: {
      fetchMystery: async () => ({ title: "Fine", words: ["fine"], img: null, extract: "", freq: new Map() }),
    },
  });
  // Order matters: the admin must be the first account this database ever sees.
  admin = await accountSession(srv.port, "Admin");
  assert.equal(admin.user.id, 1, "the admin fixture must be account #1 — see ADMIN_USER_IDS above");
  assert.ok(config.admin.enabled, "the admin routes must be mounted for this file to test anything");

  mod = await accountSession(srv.port, "Mallory");
  player = await accountSession(srv.port, "Pat");
  guest = await guestSession(srv.port, "Gus");
});
after(async () => { await srv.close(); });

const json = (res) => JSON.parse(res.body || "{}");

// ── Who gets in ──────────────────────────────────────────────────────────────

test("the dashboard and its API are invisible to everyone not on the allowlist", async () => {
  for (const [who, c] of [
    ["nobody", undefined],
    ["a guest", guest.cookie],
    ["an ordinary account", player.cookie],
  ]) {
    const page = await get(srv.port, "/admin", c);
    const api = await get(srv.port, "/api/admin/overview", c);
    // 404, not 403: the answer must not distinguish "you may not" from "there is
    // no such thing", or it confirms the dashboard exists to whoever asked.
    assert.equal(page.status, 404, `${who} should not see /admin`);
    assert.equal(api.status, 404, `${who} should not see the admin API`);
    assert.doesNotMatch(page.body, /admin-tabs|Open reports/, `${who} was served the dashboard markup`);
  }
});

test("the dashboard's own script is not reachable through the public static mount", async () => {
  // It lives in server/admin/ precisely so express.static(public) cannot serve
  // it. If it were ever moved under public/ this is the test that would notice.
  const asPlayer = await get(srv.port, "/admin/app.js", player.cookie);
  assert.equal(asPlayer.status, 404);
  const asAdmin = await get(srv.port, "/admin/app.js", admin.cookie);
  assert.equal(asAdmin.status, 200);
  assert.match(asAdmin.body, /api\/admin\/overview/);
});

test("an admin gets the dashboard and the numbers behind it", async () => {
  const page = await get(srv.port, "/admin", admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.body, /admin-tabs/);

  const d = json(await get(srv.port, "/api/admin/overview", admin.cookie));
  assert.equal(d.me.id, 1);
  assert.ok(d.stats.accounts >= 3, "every account created above should be counted");
  assert.ok(d.process.version, "the overview reports what is actually deployed");
  assert.ok(Array.isArray(d.live.rooms), "and what is running right now");
  assert.equal(typeof d.stats.reports.open, "number");
});

// ── The report queue ─────────────────────────────────────────────────────────

// Play far enough into a private room that there is a chat message to report,
// then report it. Returns the reported message id.
async function reportSomething({ author, reporter, text = "you are terrible at this" }) {
  const sa = connect(srv.port, author.cookie);
  const sb = connect(srv.port, reporter.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const joined = once(sa, "room:joined");
  sa.emit("room:create", { rounds: 1, mode: "party", clue: "image" });
  const { code } = await joined;
  sb.emit("room:join", { code });
  await once(sb, "room:joined");

  const seen = once(sb, "chat:msg");
  sa.emit("chat:send", { text });
  const msg = await seen;

  sb.emit("chat:report", { id: msg.id });
  await once(sb, "chat:reported");

  sa.emit("room:leave");
  sb.emit("room:leave");
  sa.close();
  sb.close();
  // Let the disconnects land before the next caller opens two more. Sockets are
  // capped per identity, and these accounts are reused across the file.
  await new Promise((r) => setTimeout(r, 60));
  return { code, messageId: msg.id, text };
}

test("a reported message becomes a row in the queue, with both sides named", async () => {
  const { code, text } = await reportSomething({ author: mod, reporter: player });

  const { reports } = json(await get(srv.port, "/api/admin/reports?status=open", admin.cookie));
  const row = reports.find((r) => r.room === code);
  assert.ok(row, "the report should be waiting in the open queue");
  // Resolved from the room's own buffer, never from the reporter's request.
  assert.equal(row.message.text, text);
  assert.equal(row.author.userId, mod.user.id);
  assert.equal(row.author.name, "Mallory");
  assert.equal(row.reporter.userId, player.user.id);
  assert.equal(row.status, "open");
  assert.equal(row.authorBan, null, "not banned yet, so the queue offers the option");
});

test("resolving a report closes it, and closing it twice is an answer rather than an error", async () => {
  const { code } = await reportSomething({ author: mod, reporter: player, text: "second one" });
  const open = json(await get(srv.port, "/api/admin/reports?status=open", admin.cookie));
  const id = open.reports.find((r) => r.room === code).id;

  const first = json(
    await postJson(srv.port, `/api/admin/reports/${id}/resolve`, { status: "dismissed", note: "banter" }, admin.cookie)
  );
  assert.equal(first.changed, true);
  assert.equal(first.report.status, "dismissed");
  assert.equal(first.report.note, "banter");

  // Two admins clicking at once must agree on the first answer rather than race
  // to overwrite it.
  const again = json(
    await postJson(srv.port, `/api/admin/reports/${id}/resolve`, { status: "actioned" }, admin.cookie)
  );
  assert.equal(again.changed, false, "an already-closed report is not re-decided");
  assert.equal(again.report.status, "dismissed");

  const still = json(await get(srv.port, "/api/admin/reports?status=open", admin.cookie));
  assert.ok(!still.reports.some((r) => r.id === id), "and it has left the open queue");
});

test("a report can only be closed as actioned or dismissed", async () => {
  const any = listChatReports({ status: "all", limit: 1 })[0];
  assert.ok(any, "the tests above should have left at least one report to try this on");
  const bad = await postJson(srv.port, `/api/admin/reports/${any.id}/resolve`, { status: "open" }, admin.cookie);
  assert.equal(bad.status, 400);
  const missing = await postJson(srv.port, "/api/admin/reports/999999/resolve", { status: "actioned" }, admin.cookie);
  assert.equal(missing.status, 404);
});

test("a report against a guest says so, because there is no account to suspend", async () => {
  const { code } = await reportSomething({ author: guest, reporter: player, text: "guests can be rude too" });
  const { reports } = json(await get(srv.port, "/api/admin/reports?status=open", admin.cookie));
  const row = reports.find((r) => r.room === code);
  assert.ok(row);
  assert.equal(row.author.userId, null, "a guest identity has no account behind it");
  assert.match(row.author.identity, /^g_/);
});

// ── Bans ─────────────────────────────────────────────────────────────────────

test("a suspended account cannot open a socket, and is told why", async () => {
  const target = await accountSession(srv.port, "Banned");
  const res = json(
    await postJson(srv.port, "/api/admin/bans", { userId: target.user.id, days: 7, reason: "abuse" }, admin.cookie)
  );
  assert.equal(res.ok, true);
  assert.equal(res.ban.reason, "abuse");
  assert.ok(res.ban.until > Date.now(), "a 7-day suspension is in force now");

  // The handshake is the whole of multiplayer in one place: no socket means no
  // queue, no room and no chat, however the client is written.
  const sock = connect(srv.port, target.cookie);
  const err = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the banned socket connected")), 8000);
    sock.on("connect_error", (e) => { clearTimeout(t); resolve(e); });
    sock.on("me", () => { clearTimeout(t); reject(new Error("the banned socket was accepted")); });
  });
  assert.match(err.message, /suspended/i, `got "${err.message}"`);
  assert.match(err.message, /abuse/, "the reason somebody typed is the reason they are shown");
  sock.close();

  // And off the public boards, which is the other place a banned player is seen.
  const daily = await get(srv.port, "/api/daily/wikidle", target.cookie);
  assert.equal(daily.status, 403);
  assert.match(json(daily).error, /suspended/i);
});

test("a ban reaches a player who is already connected", async () => {
  const target = await accountSession(srv.port, "Midgame");
  const sock = connect(srv.port, target.cookie);
  await once(sock, "me");

  const told = once(sock, "room:error", 8000);
  const res = json(await postJson(srv.port, "/api/admin/bans", { userId: target.user.id }, admin.cookie));
  assert.equal(res.disconnected, 1, "the live socket should have been counted and closed");
  assert.match((await told).message, /suspended/i);
  assert.equal(res.ban.until, null, "no days means permanent");
  sock.close();
});

test("lifting a suspension lets them straight back in", async () => {
  const target = await accountSession(srv.port, "Forgiven");
  await postJson(srv.port, "/api/admin/bans", { userId: target.user.id, days: 1 }, admin.cookie);
  assert.ok(activeBan(target.user.id));

  const res = json(await del(srv.port, `/api/admin/bans/${target.user.id}`, admin.cookie));
  assert.equal(res.removed, true);
  assert.equal(activeBan(target.user.id), null);

  // The handshake guard reads the ban fresh on every connection, so the next one
  // is simply allowed — nothing has to be told that the ban is gone.
  const sock = connect(srv.port, target.cookie);
  await once(sock, "me");
  const daily = await get(srv.port, "/api/daily/wikidle", target.cookie);
  assert.notEqual(daily.status, 403);
  sock.close();

  // Lifting a suspension nobody has is not an error; it is the same end state.
  assert.equal(json(await del(srv.port, `/api/admin/bans/${target.user.id}`, admin.cookie)).removed, false);
});

test("a suspension that has expired stops applying on its own", () => {
  const id = 4242;
  db.prepare("INSERT OR IGNORE INTO users (id, provider, provider_id, display_name, created_at) VALUES (?,?,?,?,?)")
    .run(id, "test", "expired-fixture", "Expired", Date.now());
  // Written directly with a past expiry: there is no way to ask the API for a
  // ban that has already lapsed, and "it lifts by itself" is the property.
  banUser({ userId: id, reason: "old", expiresAt: Date.now() - 1000 });
  assert.equal(activeBan(id), null, "an expired row must not keep anybody out");
  // The row survives for the record until the retention sweep takes it.
  assert.ok(db.prepare("SELECT 1 FROM bans WHERE user_id = ?").get(id));
});

test("an admin cannot suspend themselves or another admin", async () => {
  const self = await postJson(srv.port, "/api/admin/bans", { userId: admin.user.id }, admin.cookie);
  assert.equal(self.status, 400);
  assert.match(json(self).error, /yourself/i);
  assert.equal(activeBan(admin.user.id), null, "and nothing was written");

  // Being the only operator locked out by your own dashboard is the failure this
  // guard exists for, so it holds for any allowlisted id rather than just self.
  config.admin.userIds.add(player.user.id);
  const other = await postJson(srv.port, "/api/admin/bans", { userId: player.user.id }, admin.cookie);
  config.admin.userIds.delete(player.user.id);
  assert.equal(other.status, 400);
  assert.match(json(other).error, /ADMIN_USER_IDS/);
});

test("a suspension length has to be sane, and the account has to exist", async () => {
  const target = await accountSession(srv.port, "Validate");
  for (const days of [0, -3, 99999, "soon"]) {
    const res = await postJson(srv.port, "/api/admin/bans", { userId: target.user.id, days }, admin.cookie);
    assert.equal(res.status, 400, `days=${days} should be refused`);
  }
  const ghost = await postJson(srv.port, "/api/admin/bans", { userId: 999999 }, admin.cookie);
  assert.equal(ghost.status, 404);
  assert.equal(activeBan(target.user.id), null, "a refused request writes nothing");
});

// ── The player view ──────────────────────────────────────────────────────────

test("a player's record gathers what you need before acting on them", async () => {
  const found = json(await get(srv.port, "/api/admin/players?q=Mallory", admin.cookie));
  const hit = found.players.find((p) => p.id === mod.user.id);
  assert.ok(hit, "search by display name finds the account");

  const { player: detail } = json(await get(srv.port, `/api/admin/players/${mod.user.id}`, admin.cookie));
  assert.equal(detail.id, mod.user.id);
  assert.ok(detail.reportsAgainst.total >= 1, "how often they have been reported is the context that matters");
  assert.ok(detail.recentReports.length >= 1);
  assert.equal(detail.isAdmin, false);
  assert.ok(Array.isArray(detail.matches));

  // Pasting an id straight from a report is the fastest route to the person.
  const byId = json(await get(srv.port, `/api/admin/players?q=${mod.user.id}`, admin.cookie));
  assert.ok(byId.players.some((p) => p.id === mod.user.id));
});

test("a name search does not treat a typed % as 'everyone'", async () => {
  const res = json(await get(srv.port, "/api/admin/players?q=%25", admin.cookie));
  assert.equal(res.players.length, 0, "LIKE's wildcards must be escaped, or one character lists the site");
});

// ── Erasure ──────────────────────────────────────────────────────────────────

test("deleting an account takes its reports and its suspension with it", async () => {
  const doomed = await accountSession(srv.port, "Doomed");
  await reportSomething({ author: doomed, reporter: player, text: "something regrettable" });
  banUser({ userId: doomed.user.id, reason: "pending deletion" });

  const before = listChatReports({ status: "all", limit: 200 });
  assert.ok(before.some((r) => r.author_user_id === doomed.user.id));

  const res = await postJson(srv.port, "/api/account/delete", { confirm: "DELETE" }, doomed.cookie);
  assert.equal(res.status, 200);

  const after = listChatReports({ status: "all", limit: 200 });
  assert.ok(!after.some((r) => r.author_user_id === doomed.user.id), "their reports go with the account");
  assert.equal(db.prepare("SELECT 1 FROM bans WHERE user_id = ?").get(doomed.user.id), undefined);
});

// ── Site notices ─────────────────────────────────────────────────────────────
// The thing worth asserting is that a pinned notice reaches an ORDINARY
// visitor's /api/config — that is the whole feature, and it is the one part an
// admin cannot check by looking at their own dashboard.

test("a pinned notice reaches every visitor, and unpinning takes it away", async () => {
  const pinned = json(
    await postJson(srv.port, "/api/admin/notices", { message: "Server restarts at 9pm.", level: "warn" }, admin.cookie)
  );
  assert.equal(pinned.ok, true);
  assert.ok(pinned.notices.some((n) => n.id === pinned.id && n.active));

  // A signed-out stranger, not the admin: this is what the site actually serves.
  const cfg = json(await helpers.get(srv.port, "/api/config"));
  const seen = cfg.notices.find((n) => n.id === pinned.id);
  assert.ok(seen, "the notice should be in the config every page already fetches");
  assert.equal(seen.message, "Server restarts at 9pm.");
  assert.equal(seen.level, "warn");
  assert.equal(seen.createdBy, undefined, "who pinned it is nobody's business but ours");

  const removed = json(await del(srv.port, `/api/admin/notices/${pinned.id}`, admin.cookie));
  assert.equal(removed.removed, true);
  const after = json(await helpers.get(srv.port, "/api/config"));
  assert.ok(!after.notices.some((n) => n.id === pinned.id), "unpinning takes it off the site at once");
});

test("a notice cannot carry markup, and is capped in length", async () => {
  const res = json(
    await postJson(srv.port, "/api/admin/notices", { message: "<script>alert(1)</script> hi " + "x".repeat(400) }, admin.cookie)
  );
  const stored = res.notices.find((n) => n.id === res.id);
  assert.ok(!stored.message.includes("<"), "angle brackets are stripped server-side");
  assert.ok(stored.message.length <= 280, `capped, got ${stored.message.length}`);
  await del(srv.port, `/api/admin/notices/${res.id}`, admin.cookie);
});

test("a notice expires while sitting in the cache, with no write to trigger it", async () => {
  const { db: raw, activeNotices, createNotice } = require("../server/db");
  // Pinned with a real expiry through the ordinary path, then simply waited out.
  // Nothing writes in between, and no TTL elapses — the point is that the filter
  // runs on every READ, so a cached row stops being served the moment its own
  // expiry passes. A cache that filtered when it was FILLED would keep showing
  // this until the next unrelated pin.
  const id = createNotice({ message: "Back in ten minutes", level: "info", expiresAt: Date.now() + 60 });
  assert.ok(activeNotices().some((n) => n.id === id), "still in force when pinned");

  await new Promise((r) => setTimeout(r, 90));

  assert.ok(!activeNotices().some((n) => n.id === id), "an expired notice must not keep showing");
  // It survives in the table for the admin list until the retention sweep.
  assert.ok(raw.prepare("SELECT 1 FROM notices WHERE id = ?").get(id));
  raw.prepare("DELETE FROM notices WHERE id = ?").run(id);
});

test("bad notices are refused", async () => {
  for (const body of [{ message: "   " }, { message: "ok", level: "shouty" }, { message: "ok", days: 0 }, { message: "ok", days: 999 }]) {
    const res = await postJson(srv.port, "/api/admin/notices", body, admin.cookie);
    assert.equal(res.status, 400, `should have refused ${JSON.stringify(body)}`);
  }
});

test("only an admin can pin one", async () => {
  const res = await postJson(srv.port, "/api/admin/notices", { message: "I am in charge now" }, player.cookie);
  assert.equal(res.status, 404, "same 404 as every other admin route");
  const cfg = json(await helpers.get(srv.port, "/api/config"));
  assert.ok(!cfg.notices.some((n) => n.message.includes("in charge")));
});

// ── Wording ──────────────────────────────────────────────────────────────────

test("a ban explains itself in one sentence, and never counts down to zero", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.match(banMessage({ until: null, reason: "" }, now), /permanent/i);
  assert.match(banMessage({ until: now + 90 * 60 * 1000, reason: "spam" }, now), /2 hours.*spam/);
  // Rounded up: "0 hours left" on a ban still in force reads as a bug.
  assert.equal(remainingLabel(now + 30 * 1000, now), "in 1 min");
  assert.equal(remainingLabel(now - 1, now), "shortly");
  assert.equal(remainingLabel(now + 25 * 60 * 60 * 1000, now), "in 2 days");
});
