"use strict";

// ────────────────────────────────────────────────────────────────────────────
// The operator's dashboard: /admin, and the /api/admin/* endpoints behind it.
//
// Who gets in is decided by ADMIN_USER_IDS — a list of account ids in the
// environment, not a column on the row (see config.admin for why). Everything
// in this file sits behind one middleware, `requireAdmin`, and there is exactly
// one of it: no route here re-derives the rule, so there is no route here that
// can get it subtly wrong.
//
// A REJECTION LOOKS LIKE A 404, NOT A 403. Anyone who is not an admin — signed
// out, a guest, or an ordinary account — gets the same "no such page" the rest
// of the site gives for a typo. A 403 would confirm that /admin exists and that
// the allowlist is the only thing in the way, which is free reconnaissance and
// buys nothing: an actual admin never sees either.
//
// The UI is served from server/admin/ rather than public/, and that placement is
// load-bearing. express.static(publicDir) serves anything under it to anybody;
// a dashboard page that happened to live there would be readable by the whole
// internet, and "it has no data in it until the API answers" is not a defence
// worth relying on.
// ────────────────────────────────────────────────────────────────────────────

const path = require("path");
const express = require("express");

const config = require("./config");
const log = require("./log");
const metrics = require("./metrics");
const { getSessionUser } = require("./auth");
const { banMessage } = require("./moderation");
const { dayKey } = require("./game/daily");
const {
  REPORT_STATUSES,
  reportCounts,
  listChatReports,
  getChatReport,
  resolveChatReport,
  banUser,
  unbanUser,
  listBans,
  activeBan,
  adminStats,
  recentSignups,
  searchUsers,
  adminUserDetail,
  getUserById,
} = require("./db");

// How much of each list the dashboard pulls at once. Small on purpose: these are
// working views, and a queue you have to scroll for five minutes is one people
// stop opening.
const PAGE = 50;
const BAN_LIST = 100;

// The longest a suspension can be set for in one go, in days. Not a policy about
// severity — a permanent ban is one click away — but a guard against a fat
// finger turning "7" into "7000" and producing a ban that outlives the service.
const MAX_BAN_DAYS = 3650;

const isAdmin = (user) => Boolean(user && user.userId && config.admin.userIds.has(user.userId));

// Everything below this line requires an admin. `next()` on failure rather than
// a status: the request falls through to the site's ordinary 404 handler, which
// answers JSON under /api and the lobby page anywhere else.
function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!isAdmin(user)) {
    // Logged, because a request to /admin from an account that is not on the
    // list is either a misconfigured deploy or somebody trying it on, and both
    // are worth being able to see afterwards.
    if (user) log.warn("admin_denied", { user: user.id, path: req.originalUrl.split("?")[0] });
    return next();
  }
  req.admin = user;
  next();
}

// ── Response shaping ─────────────────────────────────────────────────────────
// The database rows go out renamed rather than raw. Two reasons: the browser
// should not have to know that a column is called `author_user_id`, and shaping
// here is what stops a future column being published to the dashboard by
// accident simply because somebody added it to the table.

const reportView = (r) => ({
  id: r.id,
  at: r.created_at,
  room: r.room_code,
  ranked: r.ranked === 1,
  isPrivate: r.is_private === 1,
  message: { id: r.message_id, at: r.message_at, text: r.message_text },
  author: { identity: r.author_identity, userId: r.author_user_id, name: r.author_name },
  reporter: { identity: r.reporter_identity, userId: r.reporter_user_id, name: r.reporter_name },
  status: r.status,
  resolvedAt: r.resolved_at,
  note: r.note,
});

// What the queue needs to know about the accused before you open anything: is
// this an account at all (a guest cannot be banned), and are they already
// suspended. Cheap — one indexed lookup per row, over a page of 50.
const withBanState = (r) => ({ ...reportView(r), authorBan: activeBan(r.author_user_id) });

// A live snapshot of the process. Not from the database at all: rooms, queues
// and sockets exist only in memory, and this is the only view of them there is.
function liveView(manager, io) {
  const rooms = [...manager.rooms.values()].map((room) => ({
    code: room.code,
    phase: room.phase,
    ranked: room.ranked,
    isPrivate: room.isPrivate,
    round: room.round,
    rounds: room.settings.rounds,
    clue: room.settings.clue,
    tier: room.settings.mode,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      userId: p.userId || null,
      name: p.name,
      total: p.total,
      connected: p.connected,
      isBot: Boolean(p.isBot),
    })),
  }));
  const queues = [...manager.queues.entries()]
    .filter(([, q]) => q.length)
    .map(([key, q]) => ({ key, waiting: q.length, oldestMs: Date.now() - Math.min(...q.map((e) => e.enqueuedAt)) }));

  return {
    rooms,
    queues,
    sockets: io.engine.clientsCount,
    // Rooms with a human in them, which is the number that answers "is anyone
    // playing right now" — a room left holding only a bot is not a game.
    activeRooms: rooms.filter((r) => r.players.some((p) => !p.isBot && p.connected)).length,
  };
}

// ── Router ───────────────────────────────────────────────────────────────────
// `manager` and `io` are passed in rather than imported: they are built by
// buildServer and there is one pair per server, which is also what lets a test
// drive an isolated instance.
function buildAdminRouter({ manager, io }) {
  const router = express.Router();
  const json = express.json();
  const uiDir = path.join(__dirname, "admin");
  // redirect:false and index:false, so /admin is served by the route below
  // rather than bounced to /admin/ — a 301 from a URL that is supposed to be
  // invisible tells an anonymous caller that something is there.
  const ui = express.static(uiDir, { redirect: false, index: false });

  // The dashboard itself: /admin is the page, /admin/app.js its script. Behind
  // the same guard as the data it displays, and served from this directory
  // rather than public/ — see the note at the top of the file.
  router.get("/admin", requireAdmin, (req, res, next) =>
    req.admin ? res.sendFile(path.join(uiDir, "index.html")) : next()
  );
  router.use("/admin", requireAdmin, (req, res, next) => (req.admin ? ui(req, res, next) : next()));

  // `next("router")` leaves this router entirely rather than falling through to
  // the routes below it, so a non-admin lands on the site's 404 without any
  // handler here having to remember to check again.
  router.use("/api/admin", requireAdmin, (req, res, next) => (req.admin ? next() : next("router")));

  // Overview: the numbers, the process, and what is happening right now.
  router.get("/api/admin/overview", (req, res) => {
    res.json({
      me: { id: req.admin.userId, name: req.admin.name },
      stats: adminStats({ day: dayKey() }),
      process: {
        uptime: Math.round(process.uptime()),
        version: require("../package.json").version,
        env: config.env,
        ...metrics.snapshot(),
      },
      live: liveView(manager, io),
      signups: recentSignups(10).map((u) => ({
        id: u.id,
        name: u.display_name,
        avatar: u.avatar_url,
        provider: u.provider,
        createdAt: u.created_at,
        lastSeen: u.last_seen,
      })),
    });
  });

  // ── Reports ────────────────────────────────────────────────────────────────
  router.get("/api/admin/reports", (req, res) => {
    const status = REPORT_STATUSES.includes(req.query.status) || req.query.status === "all"
      ? req.query.status
      : "open";
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const rows = listChatReports({ status, limit: PAGE, offset });
    // The counts ride along with every page. Without them the queue badge only
    // moved on the overview's poll, so working through a backlog left a "3
    // waiting" chip above an empty list for the next twenty seconds — which
    // reads as the resolve not having worked.
    res.json({ status, offset, limit: PAGE, counts: reportCounts(), reports: rows.map(withBanState) });
  });

  // Close one. `actioned` and `dismissed` are both endings — the difference is
  // the finding, and it is recorded because "we looked and it was fine" is the
  // answer you want on hand the second time the same player is reported.
  router.post("/api/admin/reports/:id/resolve", json, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const status = String((req.body && req.body.status) || "");
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad report id." });
    if (status !== "actioned" && status !== "dismissed") {
      return res.status(400).json({ error: "status must be 'actioned' or 'dismissed'." });
    }
    const report = getChatReport(id);
    if (!report) return res.status(404).json({ error: "No such report." });

    const changed = resolveChatReport({ id, status, note: req.body.note, adminId: req.admin.userId });
    log.info("admin_report_resolved", { id, status, by: req.admin.userId, alreadyClosed: !changed });
    res.json({ ok: true, changed, report: withBanState(getChatReport(id)) });
  });

  // ── Bans ───────────────────────────────────────────────────────────────────
  router.get("/api/admin/bans", (req, res) => res.json({ bans: listBans(BAN_LIST) }));

  // Suspend an account. `days` omitted or null means permanent.
  //
  // Three guards, and the first is the one that matters: an admin cannot ban
  // themselves. It reads as paranoia until you picture the alternative — the
  // only operator locked out of their own game by their own dashboard, with no
  // way back in short of an SSH session and a SQL client.
  router.post("/api/admin/bans", json, (req, res) => {
    const userId = parseInt(req.body && req.body.userId, 10);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: "Bad account id." });
    if (userId === req.admin.userId) return res.status(400).json({ error: "You cannot suspend yourself." });
    if (config.admin.userIds.has(userId)) {
      return res.status(400).json({ error: "That account is an admin — remove it from ADMIN_USER_IDS first." });
    }
    if (!getUserById(userId)) return res.status(404).json({ error: "No such account." });

    const rawDays = req.body.days;
    let expiresAt = null;
    if (rawDays != null && rawDays !== "") {
      const days = Number(rawDays);
      if (!Number.isFinite(days) || days <= 0 || days > MAX_BAN_DAYS) {
        return res.status(400).json({ error: `days must be between 1 and ${MAX_BAN_DAYS}, or omitted for permanent.` });
      }
      expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    }

    const ban = banUser({
      userId,
      reason: req.body.reason,
      expiresAt,
      byUserId: req.admin.userId,
    });
    log.warn("admin_ban", { userId, by: req.admin.userId, until: expiresAt, reason: ban.reason });

    // A ban has to reach a player who is already connected, or it does nothing
    // until they next reload. The handshake guard only runs on a NEW socket, so
    // the live ones are closed here — and the room they were in treats it as an
    // ordinary disconnect, which the game already knows how to survive.
    const dropped = disconnectIdentity(`u${userId}`, banMessage(ban));
    res.json({ ok: true, ban, disconnected: dropped });
  });

  router.delete("/api/admin/bans/:userId", (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: "Bad account id." });
    const removed = unbanUser(userId);
    log.warn("admin_unban", { userId, by: req.admin.userId, existed: removed });
    res.json({ ok: true, removed });
  });

  // ── Players ────────────────────────────────────────────────────────────────
  router.get("/api/admin/players", (req, res) => {
    const rows = searchUsers(req.query.q, 25).map((u) => ({
      id: u.id,
      name: u.display_name,
      avatar: u.avatar_url,
      provider: u.provider,
      createdAt: u.created_at,
      lastSeen: u.last_seen,
      ban: activeBan(u.id),
    }));
    res.json({ players: rows });
  });

  router.get("/api/admin/players/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad account id." });
    const detail = adminUserDetail(id);
    if (!detail) return res.status(404).json({ error: "No such account." });
    res.json({
      player: {
        ...detail,
        isAdmin: config.admin.userIds.has(id),
        recentReports: detail.recentReports.map(reportView),
      },
    });
  });

  // Close every live socket held by an identity, telling it why. Returns how
  // many were closed, which is what lets the dashboard say "and they were
  // playing" rather than leaving the operator to guess.
  function disconnectIdentity(identityId, message) {
    let n = 0;
    for (const socket of io.sockets.sockets.values()) {
      const u = socket.data && (socket.data.identity || socket.data.user);
      if (!u || u.id !== identityId) continue;
      // Emitted before the close so it is on the wire first; the client shows it
      // and stops reconnecting. Even if it is lost, the next handshake is
      // refused with the same wording.
      socket.emit("room:error", { message });
      socket.disconnect(true);
      n++;
    }
    return n;
  }

  return router;
}

module.exports = { buildAdminRouter, isAdmin, requireAdmin, MAX_BAN_DAYS };
