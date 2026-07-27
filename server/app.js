"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
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
const log = require("./log");
const metrics = require("./metrics");
const { db, getLeaderboard } = require("./db");
const { configurePassport, getSessionUser, router: authRouter } = require("./auth");
const { attachSockets } = require("./socket");
const { tierFor } = require("./elo");
const { MODES, MODE_LABELS, normalizeMode } = require("./modes");
const { TIERS, TIER_LABELS, normalizeTier } = require("./tiers");
const { ladderKey } = require("./ladders");

// Google's ad tags pull scripts and frames from these; only allowed when ads are
// actually configured, so the default CSP stays as tight as possible.
const AD_HOSTS = [
  "https://pagead2.googlesyndication.com",
  "https://googleads.g.doubleclick.net",
  "https://tpc.googlesyndication.com",
  "https://www.googletagservices.com",
];

// `style-src` keeps 'unsafe-inline' because the markup uses inline style=""
// attributes; nothing else needs an inline exception (the theme bootstrap lives
// in /js/theme.js precisely so script-src can stay on 'self').
function cspDirectives() {
  const ads = config.adsense.enabled ? AD_HOSTS : [];
  const directives = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    scriptSrc: ["'self'", ...ads],
    styleSrc: ["'self'", "'unsafe-inline'"],
    // Article images come from Wikimedia's CDN; avatars from the OAuth providers.
    imgSrc: [
      "'self'",
      "data:",
      "https://upload.wikimedia.org",
      "https://*.wikimedia.org",
      "https://*.googleusercontent.com",
      "https://cdn.discordapp.com",
      ...ads,
    ],
    // Socket.IO upgrades to a WebSocket on the same origin.
    connectSrc: ["'self'", "ws:", "wss:", ...ads],
    frameSrc: ads.length ? ads : ["'none'"],
    // helmet turns this on by default; over plain http in dev it would rewrite
    // local requests to https. `null` removes a default directive entirely.
    upgradeInsecureRequests: config.isProd ? [] : null,
  };
  return directives;
}

// Build the full Express + Socket.IO server WITHOUT listening. Returns the
// pieces so both the real entry point (index.js) and tests can drive it.
// `overrides.roomOptions` is forwarded to the RoomManager (e.g. a mock
// fetchMystery for deterministic tests).
function buildServer(overrides = {}) {
  const app = express();
  const server = http.createServer(app);
  // Assigned at the end of this function; the /healthz closure below only reads
  // it at request time, by which point it's set.
  let manager = null;

  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: { directives: cspDirectives() },
      // HSTS is meaningless (and misleading) until TLS is actually terminated.
      strictTransportSecurity: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
      // Article images are hotlinked from Wikimedia into our pages.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      // Match the CSP's frame-ancestors 'none' for pre-CSP browsers; helmet's
      // default of SAMEORIGIN would be laxer than what we actually want.
      xFrameOptions: { action: "deny" },
    })
  );

  // ── Request logging ─────────────────────────────────────────────────────────
  // Registered first so the timer covers every downstream handler. Socket.IO
  // traffic never reaches Express (it intercepts at the HTTP server), so this
  // stays quiet during gameplay.
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        method: req.method,
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        ip: req.ip,
      };
      if (res.statusCode >= 500) log.error("http", fields);
      else if (res.statusCode >= 400) log.warn("http", fields);
      else log.debug("http", fields);
    });
    next();
  });

  // ── Health check ────────────────────────────────────────────────────────────
  // Registered before the session middleware so ALB/ASG polling neither creates
  // sessions nor touches the session store. Verifies the event loop is alive and
  // the database still answers — a process that can't read SQLite is not healthy
  // even though it can still accept TCP.
  app.get("/healthz", (req, res) => {
    try {
      db.prepare("SELECT 1").get();
    } catch (err) {
      log.error("healthz_db_failed", { err });
      return res.status(503).json({ ok: false, error: "database unavailable" });
    }
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      rooms: manager ? manager.rooms.size : 0,
      version: require("../package.json").version,
      // Exposed here so any monitor can scrape the leading indicator without
      // needing to parse logs or ship a custom CloudWatch metric.
      ...metrics.snapshot(),
    });
  });

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

  // ── Rate limiting ───────────────────────────────────────────────────────────
  // /auth is the sharper of the two: POST /auth/guest mints a session and writes
  // a row to SQLite, so an unthrottled loop is a disk-fill. Limits are
  // overridable so tests can drive them without waiting out a 15-minute window.
  const limits = { ...config.rateLimit, ...(overrides.rateLimit || {}) };
  const makeLimiter = (name, max) =>
    rateLimit({
      windowMs: limits.windowMs,
      limit: max,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (req, res) => {
        log.warn("rate_limited", { limiter: name, path: req.originalUrl.split("?")[0], ip: req.ip });
        res.status(429).json({ error: "Too many requests — slow down and try again shortly." });
      },
    });

  app.use("/auth", makeLimiter("auth", limits.auth));
  app.use("/api", makeLimiter("api", limits.api));

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

  // ── Errors ────────────────────────────────────────────────────────────────────
  // Anything unmatched is a 404; anything thrown lands in the error handler,
  // which logs the full stack server-side and returns a bare message to the
  // client (Express's default handler would leak stacks outside production).
  // API and auth routes always answer in JSON — their callers are fetch(), not a
  // browser address bar, and content negotiation can't be trusted to tell them
  // apart (a request with no Accept header matches everything). A mistyped page
  // URL still lands on the lobby.
  app.use((req, res) => {
    const isApi = req.path.startsWith("/api/") || req.path.startsWith("/auth/");
    if (!isApi && req.accepts("html")) return res.status(404).sendFile(path.join(publicDir, "index.html"));
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, req, res, next) => {
    log.error("request_failed", { method: req.method, path: req.originalUrl.split("?")[0], err });
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: "Something went wrong on our end." });
  });

  // ── Socket.IO ─────────────────────────────────────────────────────────────────
  const io = new Server(server, { cors: { origin: config.baseUrl, credentials: true } });
  manager = attachSockets(io, sessionMiddleware, {
    ...(overrides.roomOptions || {}),
    socketLimits: overrides.socketLimits,
  });

  return { app, server, io, manager, sessionMiddleware };
}

module.exports = { buildServer };
