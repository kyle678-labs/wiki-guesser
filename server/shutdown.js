"use strict";

const log = require("./log");

// Graceful shutdown, factored out of index.js so it can be driven directly by a
// test (Windows has no real SIGTERM, so a signal-based test would only ever run
// on the deploy target).
//
// Rooms and matchmaking queues live in this process's memory, so a hard kill
// drops every game mid-round. Stop taking new work, tell the players what
// happened, release the timers and handles, then exit — with a hard deadline so
// a stuck handle can't wedge a deploy.
//
// `exit` is injectable; it defaults to process.exit.
function createShutdown({ server, io, manager, db, graceMs = 10000, exit = process.exit }) {
  let shuttingDown = false;

  return function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return false; // already draining; ignore repeat signals
    shuttingDown = true;
    log.info("shutdown_started", { signal, rooms: manager.rooms.size });

    const forceExit = setTimeout(() => {
      log.warn("shutdown_forced", { signal, graceMs });
      exit(exitCode);
    }, graceMs);
    if (forceExit.unref) forceExit.unref();

    const finish = () => {
      try {
        db.close();
      } catch (err) {
        log.warn("shutdown_db_close_failed", { err });
      }
      clearTimeout(forceExit);
      log.info("shutdown_complete", { signal });
      exit(exitCode);
    };

    try {
      io.emit("room:error", { message: "The server is restarting — hang tight and rejoin in a moment." });
    } catch (err) {
      log.warn("shutdown_notice_failed", { err });
    }

    // Clears every room's timers and empties the queues; without this the
    // pending round/reveal timeouts keep the event loop alive past close().
    manager.shutdown();

    // Order matters. server.close() waits for open connections to end, and a
    // WebSocket never ends on its own — nesting io.close() inside its callback
    // deadlocks until the force-exit deadline. io.close() disconnects every
    // socket AND closes the HTTP server it's attached to, so it does both jobs.
    io.close(finish);
    // Keep-alive HTTP connections would otherwise hold the close open too.
    if (server.closeIdleConnections) server.closeIdleConnections();
    return true;
  };
}

module.exports = { createShutdown };
