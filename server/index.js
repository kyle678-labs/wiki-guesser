"use strict";

const config = require("./config");
const log = require("./log");
const { db, purgeInactiveAccounts } = require("./db");
const { buildServer } = require("./app");
const { createShutdown } = require("./shutdown");
const { warmPartyIndex, warmCategoryCounts } = require("./game/pool");
const metrics = require("./metrics");

const { server, io, manager } = buildServer();

// Pull the party tier into memory before accepting traffic. Done here rather
// than in buildServer so the test suite — which injects its own mystery source
// and has no pool on disk — never pays for it.
warmPartyIndex();
// Same reasoning: one grouped scan of the pool, paid before we accept traffic
// rather than by whichever player first opens the category picker.
warmCategoryCounts();

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

// ── Retention ────────────────────────────────────────────────────────────────
// public/privacy.html commits to deleting accounts after 24 months of
// inactivity. This is what makes that true. It runs on boot and then daily; the
// deletes are transactional and the sweep is idempotent, so a restart mid-sweep
// costs nothing. Always logs its result, including zero — a job that quietly
// deletes user data should be visible even on the days it does nothing.
function runRetentionSweep() {
  try {
    const months = config.retention.inactiveMonths;
    const res = purgeInactiveAccounts(months);
    if (res.accounts > 0) log.warn("inactive_accounts_purged", { months, ...res });
    else log.info("inactive_accounts_purged", { months, ...res });
  } catch (err) {
    log.error("retention_sweep_failed", { err });
  }
}

if (config.retention.purgeEnabled) {
  runRetentionSweep();
  const retentionTimer = setInterval(runRetentionSweep, config.retention.intervalMs);
  // Never the reason the process stays alive through a shutdown.
  if (retentionTimer.unref) retentionTimer.unref();
} else {
  log.warn("retention_purge_disabled", {});
}

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
