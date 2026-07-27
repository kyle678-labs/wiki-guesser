"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const { Server } = require("socket.io");
const SqliteStore = require("better-sqlite3-session-store")(session);

// The session store's periodic cleanup timer is never unref'd (and the library
// ignores { clear: false }), so on its own it keeps the process alive — which
// breaks graceful shutdown and test teardown. Unref it: the timer should never
// be the reason the event loop stays open.
SqliteStore.prototype.startInterval = function () {
  const timer = setInterval(this.clearExpiredSessions.bind(this), this.expired.intervalMs);
  if (timer.unref) timer.unref();
  this._cleanupTimer = timer;
};

const config = require("./config");
const { db, getLeaderboard } = require("./db");
const { configurePassport, getSessionUser, router: authRouter } = require("./auth");
const { attachSockets } = require("./socket");
const { tierFor } = require("./elo");
const { MODES, MODE_LABELS, normalizeMode } = require("./modes");
const { TIERS, TIER_LABELS, normalizeTier } = require("./tiers");
const { ladderKey } = require("./ladders");

// Build the full Express + Socket.IO server WITHOUT listening. Returns the
// pieces so both the real entry point (index.js) and tests can drive it.
// `overrides.roomOptions` is forwarded to the RoomManager (e.g. a mock
// fetchMystery for deterministic tests).
function buildServer(overrides = {}) {
  const app = express();
  const server = http.createServer(app);

  if (config.trustProxy) app.set("trust proxy", 1);

  const sessionMiddleware = session({
    store: new SqliteStore({
      client: db,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProd,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
  app.use(sessionMiddleware);

  configurePassport();
  app.use(passport.initialize());
  app.use(passport.session());

  // ── API ─────────────────────────────────────────────────────────────────────
  app.get("/api/config", (req, res) => {
    res.json({
      adsense: config.adsense.enabled ? { client: config.adsense.client, slot: config.adsense.slot } : null,
      providers: { google: config.google.enabled, discord: config.discord.enabled },
      game: { rounds: config.game.roundsPerGame, guessSeconds: config.game.guessSeconds },
      modes: MODES,
      modeLabels: MODE_LABELS,
      tiers: TIERS,
      tierLabels: TIER_LABELS,
      user: getSessionUser(req),
    });
  });

  app.get("/api/leaderboard", (req, res) => {
    const clue = normalizeMode(req.query.clue);
    const tier = normalizeTier(req.query.tier);
    const mode = ladderKey(clue, tier);
    const rows = getLeaderboard(mode, 50).map((u, i) => {
      const tier = tierFor(u.rating);
      return {
        rank: i + 1,
        name: u.display_name,
        avatar: u.avatar_url,
        rating: u.rating,
        tier: tier.name,
        tierIcon: tier.icon,
        wins: u.wins,
        losses: u.losses,
        draws: u.draws,
        games: u.games_played,
      };
    });
    res.json({ clue, tier, leaderboard: rows });
  });

  app.use(authRouter);

  // ── Static site ───────────────────────────────────────────────────────────────
  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir, { extensions: ["html"] }));
  app.get("/room/:code", (req, res) => res.sendFile(path.join(publicDir, "play.html")));
  app.get("/play", (req, res) => res.sendFile(path.join(publicDir, "play.html")));

  // ── Socket.IO ─────────────────────────────────────────────────────────────────
  const io = new Server(server, { cors: { origin: config.baseUrl, credentials: true } });
  const manager = attachSockets(io, sessionMiddleware, overrides.roomOptions || {});

  return { app, server, io, manager, sessionMiddleware };
}

module.exports = { buildServer };
