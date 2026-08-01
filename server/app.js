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
const { db, getLeaderboard, getRecentMatches, deleteAccount, setChatEnabled, activeNotices } = require("./db");
const { configurePassport, getSessionUser, router: authRouter } = require("./auth");
const { router: dailyRouter, MOVE_PATHS } = require("./dailies");
const { buildAdminRouter } = require("./admin");
const { attachSockets } = require("./socket");
const { tierFor } = require("./elo");
const { MODES, MODE_LABELS, normalizeMode } = require("./modes");
const { TIERS, TIER_LABELS, normalizeTier } = require("./tiers");
const { ladderKey, RANKED_MODES, RANKED_TIERS, DEFAULT_RANKED_TIER } = require("./ladders");
const { CATEGORIES, CATEGORY_LABELS } = require("./game/categories");
const { categoryCounts } = require("./game/pool");

// How many past games the profile panel shows. Small on purpose: it is a "how
// have I been doing lately" view, not an archive.
const PROFILE_MATCH_LIMIT = 10;

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
//
// Takes its inputs rather than reading config directly so both branches are
// testable: the production directives are the ones that matter and they are
// exactly the ones a test server (NODE_ENV=test) would otherwise never build.
function cspDirectives({ isProd = config.isProd, adsEnabled = config.adsense.enabled } = {}) {
  const ads = adsEnabled ? AD_HOSTS : [];
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
    // Socket.IO upgrades to a WebSocket on the same origin, and CSP3 'self'
    // already covers ws:/wss: there — every current browser implements that.
    //
    // The bare schemes are DEV-ONLY, and deliberately so: `ws:` and `wss:` are
    // scheme sources with no host, so they permit a socket to ANY host on the
    // internet. In production that hands an XSS a clean exfiltration channel
    // and quietly undoes the point of the rest of this policy. Locally they
    // stay, because a tunnel or a second dev port is not same-origin and a dev
    // box is not where that risk lives.
    connectSrc: isProd ? ["'self'", ...ads] : ["'self'", "ws:", "wss:", ...ads],
    frameSrc: ads.length ? ads : ["'none'"],
    // helmet turns this on by default; over plain http in dev it would rewrite
    // local requests to https. `null` removes a default directive entirely.
    upgradeInsecureRequests: isProd ? [] : null,
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
      rooms: manager.rooms.size,
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

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  // Built here rather than after the routes, because the admin dashboard reads
  // live rooms and queues off the manager and has to be handed it at mount
  // time. Position carries no other meaning: Socket.IO intercepts at the HTTP
  // server, ahead of Express, so where it sits among the routes is irrelevant
  // to how requests are dispatched.
  const io = new Server(server, { cors: { origin: config.baseUrl, credentials: true } });
  const manager = attachSockets(io, sessionMiddleware, {
    ...(overrides.roomOptions || {}),
    socketLimits: overrides.socketLimits,
    maxSocketsPerIdentity: overrides.maxSocketsPerIdentity,
  });

  // ── Rate limiting ───────────────────────────────────────────────────────────
  // /auth is the sharpest of the three: POST /auth/guest mints a session and
  // writes a row to SQLite, so an unthrottled loop is a disk-fill. Limits are
  // overridable so tests can drive them without waiting out a 15-minute window.
  const limits = { ...config.rateLimit, ...(overrides.rateLimit || {}) };
  const makeLimiter = (name, max, opts = {}) =>
    rateLimit({
      windowMs: limits.windowMs,
      limit: max,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (req, res) => {
        log.warn("rate_limited", { limiter: name, path: req.originalUrl.split("?")[0], ip: req.ip });
        res.status(429).json({ error: "Too many requests — slow down and try again shortly." });
      },
      ...opts,
    });

  // The picture dailies post one request per move (see dailies.js for why the
  // count has to be the server's). That is a legitimate few hundred requests
  // from one person in an evening, which the API budget is not sized for and
  // should not have to be — so they are budgeted separately and the API limiter
  // steps over them rather than counting them twice.
  const isDailyMove = (req) => MOVE_PATHS.includes(req.originalUrl.split("?")[0]);

  app.use("/auth", makeLimiter("auth", limits.auth));
  app.use(MOVE_PATHS, makeLimiter("dailyMoves", limits.dailyMoves));
  app.use("/api", makeLimiter("api", limits.api, { skip: isDailyMove }));

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
      // Which of the above ranked will actually accept. Casual and private
      // rooms still use the full `modes`/`tiers` lists; only ranked is narrowed
      // (see ladders.js for why). Served rather than hardcoded in the browser so
      // the two can never drift — the queue guard rejects on exactly these.
      ranked: { modes: RANKED_MODES, tiers: RANKED_TIERS, defaultTier: DEFAULT_RANKED_TIER },
      categories: CATEGORIES,
      categoryLabels: CATEGORY_LABELS,
      // Per tier and clue, so the private-room picker can show a real article
      // count next to each category and say plainly when chaos would give more.
      // null when there is no pool on disk (tests, or a failed S3 fetch) — the
      // picker then simply shows no counts.
      categoryCounts: categoryCounts(),
      // Anything an operator has pinned from /admin. Carried here rather than on
      // an endpoint of its own because every page already awaits this one, so a
      // notice costs no extra round trip — and the read is served from memory
      // (see activeNotices in db.js), so it costs no query either.
      notices: activeNotices(),
      user: getSessionUser(req),
    });
  });

  app.get("/api/leaderboard", (req, res) => {
    // Only ranked ladders have standings, so a request for anything else is
    // pulled onto the nearest one that does rather than returning an empty
    // table that looks like "nobody has played yet". The response echoes what
    // was actually served, so a client asking for a retired ladder can see it
    // was redirected instead of silently believing it got what it asked for.
    const asked = normalizeMode(req.query.clue);
    const clue = RANKED_MODES.includes(asked) ? asked : RANKED_MODES[0];
    const askedTier = normalizeTier(req.query.tier);
    const tier = RANKED_TIERS.includes(askedTier) ? askedTier : DEFAULT_RANKED_TIER;
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

  // ── Profile ─────────────────────────────────────────────────────────────────
  // A player's own record: their ladders, and the last few ranked games. Casual
  // and private games are never recorded, so this is genuinely everything the
  // database holds about how they've played.
  app.get("/api/profile", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    if (!user.userId) {
      // Guests have no stored account, which is the whole point of guest play.
      return res.json({ user, matches: [], guest: true });
    }
    res.json({ user, guest: false, matches: getRecentMatches(user.userId, PROFILE_MATCH_LIMIT) });
  });

  // Whether this player wants to see room chat. Persisted server-side rather
  // than in localStorage so it follows the player between devices and games,
  // which is the whole point of a mute — someone who turned chat off because of
  // harassment should not have it come back on the next machine they use.
  //
  // Lives on HTTP rather than the socket because it is reachable from the lobby
  // (the profile panel) as well as from inside a game.
  app.post("/api/settings/chat", express.json(), (req, res, next) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false." });
    }
    const enabled = req.body.enabled;

    try {
      if (user.userId) {
        setChatEnabled(user.userId, enabled);
        return res.json({ ok: true, chatEnabled: enabled });
      }
    } catch (err) {
      return next(err);
    }
    // Guest: no account row, so it lives on the session.
    req.session.guest.chatEnabled = enabled;
    req.session.save((err) => (err ? next(err) : res.json({ ok: true, chatEnabled: enabled })));
  });

  // Self-service erasure, as promised in public/privacy.html. Irreversible and
  // immediate: no soft-delete, no grace period, nothing retained.
  //
  // The explicit confirm field is a deliberate-action guard, not a security
  // control — the session cookie is SameSite=Lax, so a cross-site POST carries
  // no credentials and cannot reach here in the first place.
  app.post("/api/account/delete", express.json(), (req, res, next) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    if (!user.userId) return res.status(400).json({ error: "Guest sessions hold no account to delete." });
    if (!req.body || req.body.confirm !== "DELETE") {
      return res.status(400).json({ error: "Deletion must be confirmed." });
    }

    let removed;
    try {
      removed = deleteAccount(user.userId);
    } catch (err) {
      return next(err);
    }
    // Deliberately logged without the display name: the point of the request was
    // to stop holding it, and this line outlives the row by the log retention.
    log.info("account_deleted", { userId: user.userId, matches: removed.matches, ratings: removed.ratings });

    // Drop the session too. Any OTHER session still pointing at this id resolves
    // through deserializeUser, which returns false for a missing user, so it
    // simply stops being signed in — nothing to chase down.
    const done = () => res.json({ ok: true, ...removed });
    if (req.logout) return req.logout((err) => (err ? next(err) : req.session.destroy(done)));
    req.session.destroy(done);
  });

  app.use(authRouter);
  // After the /api rate limiter above, so daily traffic is budgeted like the
  // rest of the API rather than being an unmetered way in.
  app.use(dailyRouter);

  // ── Admin ─────────────────────────────────────────────────────────────────
  // Registered before the static mount, which is what keeps /admin under the
  // allowlist: express.static serves whatever it finds to whoever asks, so the
  // dashboard's own HTML lives outside public/ and is served from here.
  //
  // Mounted only when there is somebody to let in. With ADMIN_USER_IDS unset —
  // the default, and what a box with a dropped env file looks like — these
  // routes do not exist at all, rather than existing and refusing everyone.
  if (config.admin.enabled) {
    app.use(buildAdminRouter({ manager, io }));
    log.info("admin_enabled", { accounts: [...config.admin.userIds] });
  }

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

  return { app, server, io, manager, sessionMiddleware };
}

// cspDirectives is exported for tests. The production policy is the one worth
// asserting on, and a test server never builds it — NODE_ENV=test means every
// header a running-server test can inspect is the dev variant.
module.exports = { buildServer, cspDirectives };
