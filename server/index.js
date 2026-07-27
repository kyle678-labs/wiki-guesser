"use strict";

const config = require("./config");
const log = require("./log");
const { db } = require("./db");
const { buildServer } = require("./app");
const { createShutdown } = require("./shutdown");
const { warmPartyIndex } = require("./game/pool");
const metrics = require("./metrics");

const { server, io, manager } = buildServer();

// Pull the party tier into memory before accepting traffic. Done here rather
// than in buildServer so the test suite — which injects its own mystery source
// and has no pool on disk — never pays for it.
warmPartyIndex();

server.listen(config.port, () => {
  const auth = [config.google.enabled && "Google", config.discord.enabled && "Discord"].filter(Boolean);
  log.info("server_started", {
    baseUrl: config.baseUrl,
    port: server.address().port,
    env: config.env,
    oauth: auth.length ? auth : null,
    ads: config.adsense.enabled ? config.adsense.client : null,
    pool: config.mysteryDb,
    logLevel: log.level,
  });
});

metrics.startReporting({
  intervalMs: config.metricsIntervalMs,
  sample: () => ({ rooms: manager.rooms.size, sockets: io.engine.clientsCount }),
});

const shutdown = createShutdown({ server, io, manager, db, graceMs: config.shutdownGraceMs });

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Last-resort process guards ───────────────────────────────────────────────
// A rejected promise nobody awaited would otherwise terminate the process by
// default (killing every concurrent game). The known source — the round loop —
// is handled at its call sites in rooms.js; this catches whatever we missed, and
// logs loudly enough to be alerted on.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled_rejection", { err: reason instanceof Error ? reason : new Error(String(reason)) });
});

// An uncaught exception leaves the process in an unknown state, so unlike a
// stray rejection this is not survivable — shut down cleanly and let the process
// manager (systemd/pm2) start a fresh one.
process.on("uncaughtException", (err) => {
  log.error("uncaught_exception", { err });
  shutdown("uncaughtException", 1);
});
