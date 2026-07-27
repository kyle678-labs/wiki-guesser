"use strict";
require("dotenv").config();

const path = require("path");
const bool = (v) => v === "true" || v === "1";
// `parseInt(x, 10) || dflt` silently swallows a deliberate 0, which several of
// the matchmaking knobs below accept as a meaningful value (a zero-width search
// window, or growth disabled).
const int = (v, dflt) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : dflt);
const num = (v, dflt) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : dflt);

const isProd = process.env.NODE_ENV === "production";

// A missing SESSION_SECRET in production would silently fall back to a value
// that is public in this repo, making every session cookie forgeable. Refuse to
// boot instead — a crash-looping deploy is far cheaper than a live one signing
// sessions with a known key.
const DEV_SECRET = "dev-insecure-secret-change-me";
const sessionSecret = process.env.SESSION_SECRET || DEV_SECRET;
if (isProd && (sessionSecret === DEV_SECRET || sessionSecret.length < 32)) {
  throw new Error(
    "SESSION_SECRET must be set to a unique random string of at least 32 characters when NODE_ENV=production.\n" +
      '  Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
  );
}

const config = {
  env: process.env.NODE_ENV || "development",
  isProd,
  isTest: process.env.NODE_ENV === "test",
  port: parseInt(process.env.PORT, 10) || 3000,
  baseUrl: (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, ""),
  sessionSecret,
  // Where the SQLite database lives. Overridable so tests use a temp dir.
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data"),

  // Offline mystery pool built by scripts/build-mysteries.js. When present, the
  // game draws rounds from it instead of hitting the Wikipedia API.
  mysteryDb: process.env.MYSTERY_DB
    ? path.resolve(process.env.MYSTERY_DB)
    : path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data"), "mysteries.sqlite"),
  // Minimum popularity_score per topic tier — the guessability knob. popularity
  // (≈ relative pageviews) is a far better "is this a household name" proxy than
  // incoming_links. Higher = more famous only. In the lean pool the chaos floor
  // equals the pool's own floor, so chaos = the whole pool.
  // party ≈ top 0.1% (~4.7k household-name articles); chaos = everything else.
  tierMinPopularity: {
    party: parseFloat(process.env.PARTY_MIN_POP) || 1.0e-5,
    chaos: parseFloat(process.env.CHAOS_MIN_POP) || 2.0e-7,
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },

  adsense: {
    client: process.env.ADSENSE_CLIENT || "",
    slot: process.env.ADSENSE_SLOT || "",
    get enabled() {
      return Boolean(this.client);
    },
  },

  game: {
    roundsPerGame: parseInt(process.env.ROUNDS_PER_GAME, 10) || 5,
    guessSeconds: parseInt(process.env.GUESS_SECONDS, 10) || 20,
    revealSeconds: parseInt(process.env.REVEAL_SECONDS, 10) || 8,
    // Max bonus points for answering instantly; decays to 0 as the timer runs
    // out. Only awarded when the guess actually scored on accuracy.
    speedBonusMax: parseInt(process.env.SPEED_BONUS_MAX, 10) || 30,
    // Reconnect window before a dropped player is removed / a game is forfeited.
    graceMs: parseInt(process.env.GRACE_MS, 10) || 12000,
    minPlayersToStart: 2,
    maxPlayersPerRoom: 8,
    // Casual quick match: if no human joins within this window, fill with a
    // practice bot. Set BOT_FILL=false to disable.
    botFillEnabled: process.env.BOT_FILL !== "false",
    botFillMinMs: parseInt(process.env.BOT_FILL_MIN_MS, 10) || 5000,
    botFillMaxMs: parseInt(process.env.BOT_FILL_MAX_MS, 10) || 10000,
    // Beat between "match found" and the game starting, so clients can land on
    // the game screen first.
    matchStartMs: parseInt(process.env.MATCH_START_MS, 10) || 2500,
    // How good the practice bot is, 0 (pushover) … 1 (tough). Scales how often it
    // names the answer, how often it whiffs, and how strong an article word it
    // picks. Default 0.5 = beatable. (Careful: 0 is a valid value, not "unset".)
    botSkill: (() => {
      const s = parseFloat(process.env.BOT_SKILL);
      return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0.5;
    })(),
  },

  // HTTP rate limits, per client IP. Generous enough that no honest player will
  // notice; low enough that nobody can mint sessions (each one writes a row) or
  // hammer the API in a loop.
  rateLimit: {
    windowMs: parseInt(process.env.RATE_WINDOW_MS, 10) || 15 * 60 * 1000,
    auth: parseInt(process.env.RATE_LIMIT_AUTH, 10) || 30, // /auth/* per window
    api: parseInt(process.env.RATE_LIMIT_API, 10) || 300, // /api/* per window
  },

  // Ranked matchmaking. A waiting player accepts opponents within `startWindow`
  // rating points, and that window grows by `growthPerSec` for every second they
  // wait, up to `maxWindow`. With the defaults a player searches ±100 instantly,
  // ±500 after 20s, and effectively anyone after ~70s — so a tight ladder when
  // there is a crowd, and a game rather than an empty screen when there isn't.
  //
  // Casual is deliberately excluded: it promises an instant game with no rating
  // on the line, and guests (who have no rating at all) play it.
  matchmaking: {
    startWindow: int(process.env.MM_START_WINDOW, 100),
    growthPerSec: num(process.env.MM_GROWTH_PER_SEC, 20),
    maxWindow: int(process.env.MM_MAX_WINDOW, 1500),
    // A rating with almost no games behind it is a guess, not a measurement, so
    // those players search wider from the moment they queue.
    provisionalBonus: int(process.env.MM_PROVISIONAL_BONUS, 150),
    provisionalGames: int(process.env.MM_PROVISIONAL_GAMES, 10),
    // How often waiting ranked queues are re-swept as windows widen.
    tickMs: int(process.env.MM_TICK_MS, 1000),
    // Give up rather than leave someone staring at a spinner forever. 0 disables.
    rankedTimeoutMs: int(process.env.MM_RANKED_TIMEOUT_MS, 3 * 60 * 1000),
  },

  // Automatic erasure of dormant accounts. This exists to keep the retention
  // table in public/privacy.html true: it promises accounts are deleted after
  // 24 months of inactivity, and a promise nothing enforces is worse than no
  // promise. Keep the months here and the number on that page in step.
  retention: {
    purgeEnabled: process.env.INACTIVE_PURGE !== "false",
    inactiveMonths: parseInt(process.env.INACTIVE_PURGE_MONTHS, 10) || 24,
    intervalMs: parseInt(process.env.INACTIVE_PURGE_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000,
  },

  // A signed-in player legitimately has a tab or two open; nobody needs six.
  // The per-event token buckets in ratelimit.js are per SOCKET, so without a cap
  // here anyone can multiply every budget by simply opening more connections —
  // and Socket.IO intercepts at the HTTP server, so express-rate-limit never
  // sees that traffic.
  maxSocketsPerIdentity: parseInt(process.env.MAX_SOCKETS_PER_IDENTITY, 10) || 6,

  // How long to let in-flight games finish on SIGTERM before forcing the exit.
  shutdownGraceMs: parseInt(process.env.SHUTDOWN_GRACE_MS, 10) || 10000,

  // How often to emit the event-loop-lag / memory metrics line.
  metricsIntervalMs: parseInt(process.env.METRICS_INTERVAL_MS, 10) || 60000,

  // Trust the first proxy hop (nginx/caddy) so secure cookies work in prod.
  trustProxy: bool(process.env.TRUST_PROXY) || process.env.NODE_ENV === "production",
};

module.exports = config;
