"use strict";

const { monitorEventLoopDelay } = require("node:perf_hooks");
const log = require("./log");

// Event loop lag is THE leading indicator for this app, and CPU% is not.
//
// Every mystery pick is a synchronous SQLite read, so when the pool falls out of
// page cache the loop stalls: round timers fire late, the guess window drifts,
// and games desync — all while CPU utilisation still looks unremarkable, because
// the process is blocked rather than busy. Watch p99 lag climb and you get
// warning before players feel anything.

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

// An empty histogram reports int64 max for min/max rather than 0.
const SANE_CEILING_NS = 60e9;
const toMs = (ns) => (Number.isFinite(ns) && ns >= 0 && ns < SANE_CEILING_NS ? Math.round(ns / 1e4) / 100 : 0);

function snapshot() {
  const mem = process.memoryUsage();
  return {
    loopLagP50Ms: toMs(histogram.percentile(50)),
    loopLagP99Ms: toMs(histogram.percentile(99)),
    loopLagMaxMs: toMs(histogram.max),
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
  };
}

// Emit a metrics line periodically. `sample` supplies live counts (rooms,
// sockets) that this module has no business reaching for itself.
//
// The interval is unref'd: a metrics timer must never be the reason the process
// stays alive through a shutdown.
function startReporting({ intervalMs = 60000, sample = () => ({}) } = {}) {
  const timer = setInterval(() => {
    log.info("metrics", { ...snapshot(), ...sample() });
    histogram.reset(); // report per-interval, not since-boot
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { snapshot, startReporting };
