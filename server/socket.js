"use strict";

const { RoomManager } = require("./rooms");
const { identityFromSession } = require("./auth");
const { banMessage } = require("./moderation");
const { SocketLimiter, DEFAULT_SOCKET_LIMITS } = require("./ratelimit");
const config = require("./config");
const log = require("./log");

// Wire Socket.IO onto the server. `sessionMiddleware` is the same express-session
// instance used by HTTP, so sockets see the logged-in (or guest) identity.
// `socketLimits` overrides the per-event token buckets (tests use this); the
// remaining opts are forwarded to the RoomManager (e.g. an injected fetchMystery).
function attachSockets(io, sessionMiddleware, opts = {}) {
  const { socketLimits, maxSocketsPerIdentity, ...roomOpts } = opts;
  const limits = socketLimits || DEFAULT_SOCKET_LIMITS;
  const maxSockets = maxSocketsPerIdentity || config.maxSocketsPerIdentity;
  const manager = new RoomManager(io, roomOpts);

  // How many live sockets each identity holds. The token buckets below are per
  // socket, so without this an identity multiplies every budget by simply
  // opening more connections — and Socket.IO handles its own traffic at the
  // HTTP server, ahead of Express, so the express-rate-limit middleware never
  // sees it. Entries are deleted as they empty, so this tracks live players.
  const socketsPerIdentity = new Map(); // identityId -> Set<socketId>

  // Share the Express session with each socket handshake.
  io.engine.use(sessionMiddleware);

  // Resolve the identity and enforce the connection cap during the handshake,
  // before the socket is established. Rejecting here rather than disconnecting
  // afterwards matters for two reasons: a socket torn down mid-emit may never
  // deliver the explanation, and socket.io-client does NOT auto-retry a
  // middleware rejection — whereas it retries a server-side disconnect forever,
  // turning a refused connection into a reconnect loop.
  //
  // Counting here also makes the check and the increment atomic: they sit in one
  // synchronous block, so two handshakes can't both observe the last free slot.
  io.use((socket, next) => {
    const user = identityFromSession(socket.request.session);
    // Anonymous sockets can listen but not act; they're handled below.
    if (!user) return next();

    // A ban is enforced at the handshake, which is the whole of multiplayer in
    // one place: no socket means no queue, no room, no chat, and no way to
    // reach any of them by hand-rolling a client. Refusing here rather than
    // disconnecting afterwards also gets the reason to the player — a socket
    // torn down mid-emit may never deliver it — and socket.io-client does not
    // retry a middleware rejection, so a banned account is not left in a
    // reconnect loop against a door that will not open.
    if (user.banned) {
      log.warn("banned_socket_refused", { user: user.id, until: user.banned.until });
      return next(new Error(banMessage(user.banned)));
    }

    let held = socketsPerIdentity.get(user.id);
    if (!held) socketsPerIdentity.set(user.id, (held = new Set()));
    if (held.size >= maxSockets) {
      log.warn("socket_identity_limit", { user: user.id, held: held.size, max: maxSockets });
      return next(new Error("Too many open connections for this account — close a tab and try again."));
    }
    held.add(socket.id);
    // Stash it so the connection handler doesn't re-read the session and
    // re-resolve the same identity a second time.
    socket.data.identity = user;
    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.identity || null;

    // Per-socket token buckets; garbage-collected with the socket on disconnect.
    const limiter = new SocketLimiter(limits);

    // Wrap a handler so it silently costs a token, and tells the client to back
    // off when the bucket is empty rather than doing the work.
    const limited = (event, handler) =>
      socket.on(event, (...args) => {
        if (!limiter.allow(event)) {
          log.warn("socket_rate_limited", { event, user: socket.data.user && socket.data.user.id });
          return socket.emit("room:error", { message: "You're doing that too fast — give it a second." });
        }
        handler(...args);
      });

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
    limited("queue:join", ({ ranked, clue, tier } = {}) => {
      const u = requireUser();
      if (!u) return;
      const kind = ranked ? "ranked" : "casual";
      const res = manager.enqueue(kind, clue, tier, u, socket);
      if (res.error) return socket.emit("room:error", { message: res.error });
      // For ranked this also carries the starting search window and the rating
      // being matched on, so the client can show what it is looking for from
      // the first frame rather than waiting for the first queue:status tick.
      //
      // `clue` and `tier` come from the result, not from the request: ranked
      // forces the tier, so echoing what the client asked for would label the
      // queue banner with a game it is not actually searching for.
      const { ok, error, ...status } = res;
      socket.emit("queue:waiting", { kind, ...status });
    });

    socket.on("queue:leave", () => {
      if (socket.data.user) manager.dequeue(socket.data.user.id);
      socket.emit("queue:left");
    });

    // ── Private rooms ─────────────────────────────────────────────────────────
    // Entering a room by any route means you are no longer looking for a match.
    // Leaving a stale queue entry behind let a pending casual bot-fill fire
    // afterwards and relocate the identity into a bot room — silently pulling
    // the player out of the room they had just created or joined.
    limited("room:create", (settings = {}) => {
      const u = requireUser();
      if (!u) return;
      manager.dequeue(u.id);
      if (manager.roomOf(u.id)) manager.roomOf(u.id).markDisconnected(u.id);
      const room = manager.createPrivate(u, socket, settings);
      socket.emit("room:joined", { code: room.code });
    });

    limited("room:join", ({ code } = {}) => {
      const u = requireUser();
      if (!u) return;
      const room = manager.get(code);
      if (!room) return socket.emit("room:error", { message: "No room with that code." });
      const res = room.addPlayer(u, socket);
      if (res.error) return socket.emit("room:error", { message: res.error });
      manager.dequeue(u.id);
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

    limited("room:settings", (patch = {}) => {
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
    limited("guess:submit", ({ text } = {}) => {
      if (!socket.data.user) return;
      const room = manager.roomOf(socket.data.user.id);
      if (room) room.submitGuess(socket.data.user.id, text);
    });

    limited("chat:send", ({ text } = {}) => {
      const u = socket.data.user;
      if (!u) return;
      const room = manager.roomOf(u.id);
      if (!room) return;
      // Sanitising, the room's chat-off setting, and the id the report path
      // needs all live in Room.postChat so there is one definition of a message.
      const res = room.postChat(u, text);
      if (res.error) socket.emit("room:error", { message: res.error });
    });

    // Apply a mute to THIS live connection. Deliberately not the persistence
    // path — that is POST /api/settings/chat, which is reachable from the lobby
    // as well and handles accounts and guests properly. This only moves the
    // socket in or out of the room's chat fan-out so the change takes effect
    // without waiting for a reconnect.
    //
    // If this event is ever lost, the preference is still saved and the next
    // connection derives delivery from it (see Room.addPlayer), so the failure
    // mode is "muted, but still receiving until reconnect" — never the reverse.
    limited("chat:mute", ({ enabled } = {}) => {
      const u = socket.data.user;
      if (!u) return;
      const on = enabled !== false;
      u.chatEnabled = on;
      if (socket.data.identity) socket.data.identity.chatEnabled = on;
      const room = manager.roomOf(u.id);
      if (room) room.setChatDelivery(socket, on);
    });

    // Report a message for moderation. Only an id crosses the wire — see
    // Room.reportChat for why the text deliberately does not.
    limited("chat:report", ({ id } = {}) => {
      const u = socket.data.user;
      if (!u) return;
      const room = manager.roomOf(u.id);
      if (!room) return;
      const res = room.reportChat(u, id);
      if (res.error) return socket.emit("room:error", { message: res.error });
      socket.emit("chat:reported", { id });
    });

    socket.on("disconnect", () => {
      // Release the connection slot off the handshake identity, which is set
      // even for sockets that never went on to do anything.
      const identity = socket.data.identity;
      if (identity) {
        const held = socketsPerIdentity.get(identity.id);
        if (held) {
          held.delete(socket.id);
          if (held.size === 0) socketsPerIdentity.delete(identity.id);
        }
      }
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
