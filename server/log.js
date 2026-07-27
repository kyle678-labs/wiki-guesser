"use strict";

// Structured JSON logging to stdout/stderr — one object per line, which is what
// CloudWatch Logs Insights (and every other log pipeline) wants to ingest. No
// dependency: the app's logging needs are a handful of fields, and hand-rolling
// keeps the house style of the rest of the codebase.
//
//   log.info("http", { method, path, status, ms })
//   log.error("round_failed", { code, err })
//
// LOG_LEVEL (debug|info|warn|error|silent) gates output; tests default to silent
// so the suite's output stays readable.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const configured = String(process.env.LOG_LEVEL || "").toLowerCase();
const threshold =
  LEVELS[configured] != null ? LEVELS[configured] : process.env.NODE_ENV === "test" ? LEVELS.silent : LEVELS.info;

// Errors don't survive JSON.stringify (name/message/stack are non-enumerable),
// so unwrap them into something a log search can actually match on.
function serialize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, stack: v.stack };
    } else if (typeof v === "bigint") {
      out[k] = v.toString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...serialize(fields) });
  // Anything at warn or above goes to stderr so it can be alerted on separately.
  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

module.exports = {
  debug: (event, fields) => emit("debug", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
  level: Object.keys(LEVELS).find((k) => LEVELS[k] === threshold) || "info",
};
