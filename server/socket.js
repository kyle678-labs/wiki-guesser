"use strict";

const { RoomManager } = require("./rooms");
const { identityFromSession } = require("./auth");

// Wire Socket.IO onto the server. `sessionMiddleware` is the same express-session
// instance used by HTTP, so sockets see the logged-in (or guest) identity.
// `opts` is forwarded to the RoomManager (e.g. an injected fetchMystery for tests).
function attachSockets(io, sessionMiddleware, opts = {}) {
  const manager = new RoomManager(io, opts);

  // Share the Express session with each socket handshake.
  io.engine.use(sessionMiddleware);

  io.on("connection", (socket) => {
    const session = socket.request.session;
    const user = identityFromSession(session);

    if (!user) {
      socket.emit("need-auth");
      // They can still listen, but can't act until they pick an identity.
    } else {
      socket.data.user = user;
      socket.emit("me", { user });
      // Reconnect: if this identity was already in a room, re-attach them.
      const room = manager.roomOf(user.id);
      if (room) {
        room.addPlayer(user, socket);
        socket.emit("room:rejoined", { code: room.code });
      }
    }

    const requireUser = (cb) => {
      if (!socket.data.user) {
        socket.emit("room:error", { message: "Please choose a name or sign in first." });
        return null;
      }
      return socket.data.user;
    };

    // ── Quick match / ranked queue ────────────────────────────────────────────
    socket.on("queue:join", ({ ranked, clue, tier } = {}) => {
      const u = requireUser();
      if (!u) return;
      const kind = ranked ? "ranked" : "casual";
      const res = manager.enqueue(kind, clue, tier, u, socket);
      if (res.error) return socket.emit("room:error", { message: res.error });
      socket.emit("queue:waiting", { kind, clue, tier: res.tier, position: res.position });
    });

    socket.on("queue:leave", () => {
      if (socket.data.user) manager.dequeue(socket.data.user.id);
      socket.emit("queue:left");
    });

    // ── Private rooms ─────────────────────────────────────────────────────────
    socket.on("room:create", (settings = {}) => {
      const u = requireUser();
      if (!u) return;
      if (manager.roomOf(u.id)) manager.roomOf(u.id).markDisconnected(u.id);
      const room = manager.createPrivate(u, socket, settings);
      socket.emit("room:joined", { code: room.code });
    });

    socket.on("room:join", ({ code } = {}) => {
      const u = requireUser();
      if (!u) return;
      const room = manager.get(code);
      if (!room) return socket.emit("room:error", { message: "No room with that code." });
      const res = room.addPlayer(u, socket);
      if (res.error) return socket.emit("room:error", { message: res.error });
      socket.emit("room:joined", { code: room.code });
    });

    socket.on("room:start", () => {
      const u = requireUser();
      if (!u) return;
      const room = manager.roomOf(u.id);
      if (!room) return;
      const res = room.start(u.id);
      if (res.error) socket.emit("room:error", { message: res.error });
    });

    socket.on("room:settings", (patch = {}) => {
      const u = requireUser();
      if (!u) return;
      const room = manager.roomOf(u.id);
      if (!room) return;
      const res = room.updateSettings(u.id, patch);
      if (res.error) socket.emit("room:error", { message: res.error });
    });

    socket.on("room:leave", () => {
      if (!socket.data.user) return;
      const room = manager.roomOf(socket.data.user.id);
      if (room) {
        socket.leave(`room:${room.code}`);
        // Explicit leave: act immediately (forfeits an in-progress game).
        room.markDisconnected(socket.data.user.id, { immediate: true });
      }
      socket.emit("room:left");
    });

    // ── Gameplay ──────────────────────────────────────────────────────────────
    socket.on("guess:submit", ({ text } = {}) => {
      if (!socket.data.user) return;
      const room = manager.roomOf(socket.data.user.id);
      if (room) room.submitGuess(socket.data.user.id, text);
    });

    socket.on("chat:send", ({ text } = {}) => {
      const u = socket.data.user;
      if (!u) return;
      const room = manager.roomOf(u.id);
      if (!room) return;
      const clean = String(text || "").replace(/[<>]/g, "").trim().slice(0, 200);
      if (!clean) return;
      io.to(`room:${room.code}`).emit("chat:msg", { name: u.name, text: clean, at: Date.now() });
    });

    socket.on("disconnect", () => {
      const u = socket.data.user;
      if (!u) return;
      manager.dequeue(u.id);
      const room = manager.roomOf(u.id);
      // Only treat it as leaving if this socket is the player's current one.
      if (room) {
        const p = room.players.get(u.id);
        if (p && p.socketId === socket.id) room.markDisconnected(u.id);
      }
    });
  });

  return manager;
}

module.exports = { attachSockets };
