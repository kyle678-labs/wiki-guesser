"use strict";
require("dotenv").config();

const path = require("path");
const bool = (v) => v === "true" || v === "1";

const config = {
  env: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",
  port: parseInt(process.env.PORT, 10) || 3000,
  baseUrl: (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, ""),
  sessionSecret: process.env.SESSION_SECRET || "dev-insecure-secret-change-me",
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

  // Trust the first proxy hop (nginx/caddy) so secure cookies work in prod.
  trustProxy: bool(process.env.TRUST_PROXY) || process.env.NODE_ENV === "production",
};

module.exports = config;
