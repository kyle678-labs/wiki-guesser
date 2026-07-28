"use strict";

const { customAlphabet } = require("nanoid");
const config = require("./config");
const log = require("./log");
const { fetchMystery } = require("./game/pool");
const { scoreGuess, creditLabel } = require("./game/scoring");
const { updatePair, tierFor, START_RATING } = require("./elo");
const { findPair, queueStatus } = require("./matchmaking");
const { recordRankedMatch, getRating } = require("./db");
const { normalizeMode } = require("./modes");
const { normalizeTier } = require("./tiers");
const { ladderKey } = require("./ladders");
const { normalizeCategories } = require("./game/categories");
const { makeBot, botGuess, botDelayMs } = require("./bot");

const makeCode = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 5);
const channel = (code) => `room:${code}`;

// A second Socket.IO room, holding only the sockets that want chat delivered.
// Muting is enforced here rather than by hiding messages in the browser: someone
// who switched chat off because they were being harassed should stop RECEIVING
// it, not merely stop seeing it. Everything else — state, rounds, scores — still
// goes to the main channel, so a muted player is a full participant otherwise.
const chatChannel = (code) => `room:${code}:chat`;

// Bounds on a private room's guess timer. The floor is short enough for a
// genuine speed round but long enough to read a clue and type; the ceiling
// stops a host parking everyone else on a five-minute round.
const MIN_GUESS_SECONDS = 5;
const MAX_GUESS_SECONDS = 120;

// How many recent chat messages a room keeps IN MEMORY. This exists solely so a
// report can be resolved against what the server actually broadcast rather than
// against text supplied by the reporter — without it, anyone could report a
// message that was never sent and attribute it to whoever they liked.
//
// It is not history: nothing is replayed to joiners, nothing is written to disk,
// and the buffer dies with the room. Only a message someone explicitly reports
// ever leaves this process.
const CHAT_HISTORY = 50;

// ── A single game room ───────────────────────────────────────────────────────
class Room {
  constructor(io, manager, { code, ranked = false, isPrivate = false, hostId = null, settings = {} }) {
    this.io = io;
    this.manager = manager;
    this.code = code;
    this.ranked = ranked;
    this.isPrivate = isPrivate;
    this.hostId = hostId;

    this.settings = {
      rounds: clampInt(settings.rounds, 1, 15, config.game.roundsPerGame),
      mode: normalizeTier(settings.mode),
      clue: normalizeMode(settings.clue), // image | text | mixed (also the ranked ladder)
      maxPlayers: clampInt(settings.maxPlayers, 2, config.game.maxPlayersPerRoom, config.game.maxPlayersPerRoom),
      // How long players get to answer. Private rooms can change this; ranked
      // and casual rooms are built without it and so keep the server default,
      // which is what makes their speed bonuses comparable across matches.
      guessSeconds: clampInt(settings.guessSeconds, MIN_GUESS_SECONDS, MAX_GUESS_SECONDS, config.game.guessSeconds),
      // Private-room hosts can switch chat off for everyone. Matchmaking rooms
      // are constructed without the flag and so keep it on.
      chatEnabled: asBool(settings.chatEnabled, true),
      // Article categories to draw from. Empty = anything, which is the default
      // and what every matchmaking room uses: ranked ladders have to be
      // comparable, so the pool cannot vary per match.
      categories: normalizeCategories(settings.categories),
    };

    this.players = new Map(); // identityId -> player
    this.phase = "lobby"; // lobby | loading | guessing | reveal | done
    this.round = 0;
    this.answer = null; // server-only { title, words, img, desc, url, freq }
    this.history = []; // per-round recap: { round, title, desc, image, url, scores }
    this.usedTopics = new Set();
    this.timers = { guess: null, reveal: null, start: null, dispose: null };
    this.botTimers = new Map(); // botId -> timeout for this round's scheduled guess
    this.pendingRemoval = new Map(); // identityId -> timeout (reconnect grace)
    this.chatLog = []; // recent messages, in memory only — see CHAT_HISTORY
    this.chatSeq = 0; // per-room message counter; ids only need to be unique here
    this.reported = new Set(); // "reporterId:messageId", so one report per person per message
    this.createdAt = Date.now();
  }

  // ── Membership ─────────────────────────────────────────────────────────────
  addPlayer(user, socket) {
    // Cancel a pending grace-period removal — they came back (or navigated).
    if (this.pendingRemoval.has(user.id)) {
      clearTimeout(this.pendingRemoval.get(user.id));
      this.pendingRemoval.delete(user.id);
    }
    const existing = this.players.get(user.id);
    if (!existing && this.players.size >= this.settings.maxPlayers && this.phase === "lobby") {
      return { error: "This room is full." };
    }
    if (!existing && this.phase !== "lobby") {
      return { error: "That game is already in progress." };
    }
    const player = existing || {
      id: user.id,
      userId: user.userId || null,
      name: user.name,
      avatar: user.avatar || null,
      ranked: Boolean(user.ranked),
      // Rating shown in the player list = this room's (clue × tier) ladder.
      rating: (() => {
        const l = user.ratings && user.ratings[ladderKey(this.settings.clue, this.settings.mode)];
        return l ? l.rating : null;
      })(),
      total: 0,
      guess: "",
      submitted: false,
      connected: true,
    };
    player.connected = true;
    player.socketId = socket.id;
    this.players.set(user.id, player);
    if (!this.hostId) this.hostId = user.id;

    socket.join(channel(this.code));
    // Derived from the persisted identity, so a reconnect always re-establishes
    // the right delivery state even if a live toggle was missed.
    this.setChatDelivery(socket, user.chatEnabled !== false);
    this.manager.locate.set(user.id, this.code);
    this.broadcastState();
    return { ok: true };
  }

  // Whether this socket receives chat. Delivery only — the preference itself is
  // persisted over HTTP (POST /api/settings/chat); this just applies it to a
  // live connection.
  setChatDelivery(socket, enabled) {
    if (enabled) socket.join(chatChannel(this.code));
    else socket.leave(chatChannel(this.code));
  }

  // Add a socket-less practice bot as a player. The round loop schedules its
  // guesses (see scheduleBotMoves).
  addBot(bot) {
    this.players.set(bot.id, {
      id: bot.id,
      userId: null,
      name: bot.name,
      avatar: null,
      ranked: false,
      isBot: true,
      rating: null,
      total: 0,
      guess: "",
      submitted: false,
      connected: true,
    });
    this.manager.locate.set(bot.id, this.code);
    this.broadcastState();
  }

  hasBot() {
    for (const p of this.players.values()) if (p.isBot) return true;
    return false;
  }
  hasHuman() {
    for (const p of this.players.values()) if (!p.isBot) return true;
    return false;
  }
  connectedHumans() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected && !p.isBot) n++;
    return n;
  }

  isActiveGame() {
    return this.phase === "loading" || this.phase === "guessing" || this.phase === "reveal";
  }

  // A player dropped (network) or left (immediate:true, e.g. the Leave button).
  // A page navigation or brief blip should be forgiven within the grace window;
  // an explicit leave is acted on at once.
  markDisconnected(identityId, { immediate = false } = {}) {
    const p = this.players.get(identityId);
    if (!p) return;
    p.connected = false;
    // Mid-guessing, count them as submitted so the round can resolve immediately
    // instead of the remaining player waiting out the full timer.
    if (this.phase === "guessing") {
      p.submitted = true;
      this.maybeEndGuessing();
    }

    // If a game in progress can no longer be contested, forfeit it to whoever
    // stayed rather than dragging the remaining player through empty rounds.
    if (this.isActiveGame() && this.activeCount() < config.game.minPlayersToStart) {
      if (immediate) return this.forfeit();
      this.scheduleForfeit(identityId);
      this.broadcastState();
      return;
    }

    if (immediate) return this.removePlayer(identityId);
    this.scheduleRemoval(identityId);
    this.broadcastState();
  }

  // End the game early, awarding the win to the sole remaining player.
  forfeit() {
    if (!this.isActiveGame()) return;
    // If the only ones left are bots, there's no human to play on — tear it down
    // rather than "award" the game to a bot.
    if (this.connectedHumans() === 0) return this.dispose();
    const remaining = [...this.players.values()].filter((p) => p.connected);
    if (remaining.length !== 1) {
      // Nobody (or somehow more than one) left to award it to.
      if (remaining.length === 0) this.dispose();
      return;
    }
    this.finish({ forfeitWinnerId: remaining[0].id });
  }

  removePlayer(identityId) {
    if (this.pendingRemoval.has(identityId)) {
      clearTimeout(this.pendingRemoval.get(identityId));
      this.pendingRemoval.delete(identityId);
    }
    if (!this.players.delete(identityId)) return;
    if (this.manager.locate.get(identityId) === this.code) this.manager.locate.delete(identityId);
    if (identityId === this.hostId) this.reassignHost();
    // Empty, or only bots left → nothing to play for; dispose.
    if (this.players.size === 0 || !this.hasHuman()) this.dispose();
    else this.broadcastState();
  }

  scheduleRemoval(identityId) {
    if (this.pendingRemoval.has(identityId)) clearTimeout(this.pendingRemoval.get(identityId));
    const t = setTimeout(() => {
      this.pendingRemoval.delete(identityId);
      const p = this.players.get(identityId);
      if (!p || p.connected) return; // reconnected in the meantime
      this.removePlayer(identityId);
    }, config.game.graceMs);
    this.pendingRemoval.set(identityId, t);
  }

  // If the dropped player doesn't return within the grace window, forfeit.
  scheduleForfeit(identityId) {
    if (this.pendingRemoval.has(identityId)) clearTimeout(this.pendingRemoval.get(identityId));
    const t = setTimeout(() => {
      this.pendingRemoval.delete(identityId);
      const p = this.players.get(identityId);
      if (p && p.connected) return; // came back in time
      if (this.isActiveGame() && this.activeCount() < config.game.minPlayersToStart) this.forfeit();
      else if (p && !p.connected) this.removePlayer(identityId);
    }, config.game.graceMs);
    this.pendingRemoval.set(identityId, t);
  }

  reassignHost() {
    const next = [...this.players.keys()][0] || null;
    this.hostId = next;
  }

  activeCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ── Game flow ──────────────────────────────────────────────────────────────
  start(byId) {
    if (this.phase !== "lobby" && this.phase !== "done") return { error: "Game already running." };
    if (this.isPrivate && byId !== this.hostId) return { error: "Only the host can start." };
    if (this.activeCount() < config.game.minPlayersToStart) {
      return { error: `Need at least ${config.game.minPlayersToStart} players.` };
    }
    for (const p of this.players.values()) p.total = 0;
    this.round = 0;
    this.history = [];
    this.usedTopics = new Set();
    this.safeNextRound();
    return { ok: true };
  }

  // nextRound() is async but every caller is fire-and-forget (a socket handler or
  // a timer), so an unhandled rejection here would take down the whole process —
  // and with it every other game on the box. Contain the blast radius: log it,
  // park this room back in the lobby, and let everyone else keep playing.
  safeNextRound() {
    this.nextRound().catch((err) => {
      log.error("round_failed", { code: this.code, round: this.round, ranked: this.ranked, err });
      this.clearTimers();
      this.phase = "lobby";
      this.answer = null;
      this.io.to(channel(this.code)).emit("room:error", {
        message: "Something went wrong running that round — back to the lobby.",
      });
      this.broadcastState();
      // A matchmaking room has no lobby worth returning to; tear it down so the
      // players can queue again rather than stranding them on a dead screen.
      if (!this.isPrivate) this.dispose();
    });
  }

  async nextRound() {
    this.clearTimers();
    this.round += 1;
    if (this.round > this.settings.rounds) return this.finish();

    this.phase = "loading";
    this.answer = null;
    for (const p of this.players.values()) {
      p.guess = "";
      p.submitted = false;
      p.submittedAt = null;
    }
    // In "mixed" mode each round is independently a picture or a description.
    this.roundClue = this.settings.clue === "mixed" ? (Math.random() < 0.5 ? "image" : "text") : this.settings.clue;
    this.io.to(channel(this.code)).emit("round:loading", { round: this.round, totalRounds: this.settings.rounds });

    let mystery;
    try {
      mystery = await this.manager.fetchMystery(
        this.settings.mode,
        this.usedTopics,
        this.roundClue,
        this.settings.categories
      );
    } catch (err) {
      this.io.to(channel(this.code)).emit("room:error", { message: "Couldn't load a mystery — retrying…" });
      // one more attempt, then bail to lobby
      try {
        mystery = await this.manager.fetchMystery(
          this.settings.mode,
          this.usedTopics,
          this.roundClue,
          this.settings.categories
        );
      } catch {
        this.phase = "lobby";
        this.broadcastState();
        return;
      }
    }
    // The game may have ended (forfeit) or the room emptied while we awaited
    // the network — don't resurrect it by starting a round.
    if (this.phase !== "loading") return;
    if (this.activeCount() === 0) return this.dispose();

    this.answer = mystery;
    this.phase = "guessing";
    this.roundStartedAt = Date.now();
    this.roundEndsAt = this.roundStartedAt + this.settings.guessSeconds * 1000;
    this.io.to(channel(this.code)).emit("round:start", {
      round: this.round,
      totalRounds: this.settings.rounds,
      clue: this.roundClue,
      image: mystery.img,
      extract: mystery.extract, // blanked description (text mode)
      wordCount: mystery.words.length,
      mode: this.settings.mode,
      endsAt: this.roundEndsAt,
    });
    this.broadcastState();
    this.scheduleBotMoves();
    this.timers.guess = setTimeout(() => this.endGuessing(), this.settings.guessSeconds * 1000);
  }

  // Each bot submits a computed guess after a human-like delay within the window.
  scheduleBotMoves() {
    for (const p of this.players.values()) {
      if (!p.isBot || !p.connected) continue;
      const t = setTimeout(() => {
        this.botTimers.delete(p.id);
        if (this.phase !== "guessing") return;
        this.submitGuess(p.id, botGuess(this.answer));
      }, botDelayMs(this.settings.guessSeconds));
      this.botTimers.set(p.id, t);
    }
  }

  submitGuess(identityId, text) {
    if (this.phase !== "guessing") return;
    const p = this.players.get(identityId);
    if (!p || p.submitted) return;
    p.guess = String(text || "").slice(0, 80);
    p.submitted = true;
    p.submittedAt = Date.now();
    this.io.to(channel(this.code)).emit("round:progress", {
      submitted: this.submittedCount(),
      total: this.activeCount(),
    });
    this.maybeEndGuessing();
  }

  submittedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected && p.submitted) n++;
    return n;
  }

  maybeEndGuessing() {
    if (this.phase !== "guessing") return;
    if (this.submittedCount() >= this.activeCount()) this.endGuessing();
  }

  endGuessing() {
    if (this.phase !== "guessing") return;
    this.clearTimers();
    this.phase = "reveal";

    // The speed bonus decays across this room's own window, so a short timer
    // stays as winnable as a long one rather than collapsing the bonus to zero.
    const windowMs = this.settings.guessSeconds * 1000;
    const results = [];
    for (const p of this.players.values()) {
      const r = scoreGuess(p.guess, this.answer);
      // Speed bonus: only when the guess actually scored, decaying from the full
      // bonus (instant) to 0 (timer expiry). Faster correct guesses score higher.
      let speedBonus = 0;
      if (r.score > 0 && p.submittedAt) {
        const remaining = Math.max(0, this.roundEndsAt - p.submittedAt);
        const frac = Math.max(0, Math.min(1, remaining / windowMs));
        speedBonus = Math.round(config.game.speedBonusMax * frac);
      }
      const points = r.score + speedBonus;
      p.total += points;
      results.push({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        guess: p.guess.trim(),
        points,
        base: r.score,
        speedBonus,
        credit: creditLabel(r),
        total: p.total,
      });
    }
    // Higher total first; tie-break by the faster (earlier) submission.
    results.sort((a, b) => b.points - a.points || (a.speedBonus === b.speedBonus ? 0 : b.speedBonus - a.speedBonus));

    // Keep a recap entry for the end-of-game overview.
    this.history.push({
      round: this.round,
      title: this.answer.title,
      desc: this.answer.desc,
      clue: this.roundClue,
      image: this.answer.img,
      extract: this.answer.extractFull || null,
      url: this.answer.url || null,
      scores: results.map((x) => ({ id: x.id, name: x.name, points: x.points })),
    });

    this.io.to(channel(this.code)).emit("round:reveal", {
      round: this.round,
      totalRounds: this.settings.rounds,
      title: this.answer.title,
      desc: this.answer.desc,
      clue: this.roundClue,
      image: this.answer.img,
      extract: this.answer.extractFull || null,
      results,
      scoreboard: this.scoreboard(),
    });

    const isLast = this.round >= this.settings.rounds;
    this.timers.reveal = setTimeout(() => this.safeNextRound(), config.game.revealSeconds * 1000);
    if (isLast) {
      // nextRound() will detect round > rounds and call finish().
    }
  }

  finish({ forfeitWinnerId = null } = {}) {
    this.clearTimers();
    this.phase = "done";
    let standings = this.scoreboard();
    if (forfeitWinnerId) {
      // The player who stayed is the winner regardless of points on the board.
      standings = [...standings].sort((a, b) => {
        if (a.id === forfeitWinnerId) return -1;
        if (b.id === forfeitWinnerId) return 1;
        return b.connected - a.connected || b.total - a.total;
      });
    }
    let ratingChanges = null;
    // A failed rating write (SQLITE_BUSY, disk full) must not abort the game
    // over — finish() runs inside timers and socket handlers where a throw ends
    // the process. Losing one ladder update is the cheaper failure.
    if (this.ranked) {
      try {
        ratingChanges = this.applyRanked(forfeitWinnerId);
      } catch (err) {
        log.error("ranked_write_failed", { code: this.code, err });
      }
    }

    this.io.to(channel(this.code)).emit("game:over", {
      standings,
      ranked: this.ranked,
      ratingChanges,
      forfeit: Boolean(forfeitWinnerId),
      winnerId: forfeitWinnerId,
      history: this.history,
    });
    this.broadcastState();

    // Tidy up players who already left so a replay lobby isn't full of ghosts.
    if (forfeitWinnerId) {
      for (const p of this.players.values()) if (!p.connected) this.scheduleRemoval(p.id);
    }
    // Ranked matchmaking rooms are one-and-done; private rooms can replay.
    // Tracked so shutdown()/dispose() can clear it (else it keeps the loop alive).
    if (!this.isPrivate) {
      this.timers.dispose = setTimeout(() => this.dispose(), 60 * 1000);
      return;
    }
    // A private room that stayed in "done" was unreplayable: the client only
    // renders the lobby — and with it the Start button and the invite link —
    // while the phase is "lobby", so the host had no way back in. start()
    // already accepts either phase; the room just never returned to one that
    // the UI would draw. Park it in the lobby so "Back to lobby" means it.
    //
    // Emitted as a second state after game:over, not instead of it: the client
    // needs the standings to render the results panel first.
    this.phase = "lobby";
    this.round = 0;
    this.answer = null;
    this.broadcastState();
  }

  // Ranked 1v1 Elo for this game's mode ladder. Only applies when exactly two
  // account players finished. On a forfeit, the outcome favours who stayed.
  applyRanked(forfeitWinnerId = null) {
    const accounts = [...this.players.values()].filter((p) => p.userId);
    if (accounts.length !== 2) return null;
    const [pa, pb] = accounts;
    const mode = ladderKey(this.settings.clue, this.settings.mode); // e.g. "image:chaos"
    // Pull fresh per-ladder ratings in case they changed elsewhere.
    const ra = getRating(pa.userId, mode);
    const rb = getRating(pb.userId, mode);

    const outcome = forfeitWinnerId
      ? pa.id === forfeitWinnerId ? 1 : 0
      : pa.total > pb.total ? 1 : pa.total < pb.total ? 0 : 0.5;
    const res = updatePair(
      { rating: ra.rating, gamesPlayed: ra.games_played },
      { rating: rb.rating, gamesPlayed: rb.games_played },
      outcome
    );
    recordRankedMatch({
      mode,
      a: { id: pa.userId },
      b: { id: pb.userId },
      aScore: pa.total,
      bScore: pb.total,
      outcome,
      aRatingAfter: res.aRating,
      bRatingAfter: res.bRating,
      aDelta: res.aDelta,
      bDelta: res.bDelta,
    });
    return {
      mode,
      [pa.id]: { before: ra.rating, after: res.aRating, delta: res.aDelta, tier: tierFor(res.aRating) },
      [pb.id]: { before: rb.rating, after: res.bRating, delta: res.bDelta, tier: tierFor(res.bRating) },
    };
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
  // Sanitising here rather than at the socket keeps the room the single place
  // that decides what a message is, which is what lets a report resolve against
  // the exact text that was broadcast.
  postChat(user, rawText) {
    if (!this.settings.chatEnabled) return { error: "Chat is switched off in this room." };
    const text = String(rawText || "").replace(/[<>]/g, "").trim().slice(0, 200);
    if (!text) return { ok: true }; // nothing typed; not an error worth surfacing

    const msg = { id: `c${++this.chatSeq}`, fromId: user.id, name: user.name, text, at: Date.now() };
    this.chatLog.push(msg);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();

    // Note the channel: chat goes only to sockets that have not muted it. The
    // message is still recorded in this room's buffer either way, so a report
    // from someone who DID see it still resolves.
    this.io.to(chatChannel(this.code)).emit("chat:msg", msg);
    return { ok: true };
  }

  // Report a message for moderation.
  //
  // The reporter sends only an ID. The text, the author and the timestamp are
  // all taken from this room's own buffer — never from the request — so a report
  // cannot be used to fabricate a message or pin one on someone else.
  //
  // This is the ONLY path by which a chat message is written anywhere durable
  // (the application log, and from there CloudWatch for its retention window).
  // public/privacy.html documents that; keep the two in step.
  reportChat(reporter, messageId) {
    const msg = this.chatLog.find((m) => m.id === String(messageId || ""));
    // The buffer is short and in-memory, so an expired or invented id is simply
    // absent. Same answer either way — we don't confirm what does exist.
    if (!msg) return { error: "That message is no longer available to report." };
    if (msg.fromId === reporter.id) return { error: "You can't report your own message." };

    const key = `${reporter.id}:${msg.id}`;
    // Report twice, get the same acknowledgement, log once.
    if (this.reported.has(key)) return { ok: true, already: true };
    this.reported.add(key);

    const author = this.players.get(msg.fromId);
    // warn, not info: this should surface wherever errors surface. userId is
    // included where there is one because an account is the only thing an
    // operator can actually act on — a guest id dies with the session.
    log.warn("chat_report", {
      code: this.code,
      ranked: this.ranked,
      isPrivate: this.isPrivate,
      reporterId: reporter.id,
      reporterUserId: reporter.userId || null,
      reporterName: reporter.name,
      authorId: msg.fromId,
      authorUserId: author ? author.userId : null,
      authorName: msg.name,
      sentAt: msg.at,
      message: msg.text,
    });
    return { ok: true };
  }

  // ── State / helpers ────────────────────────────────────────────────────────
  scoreboard() {
    return [...this.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        total: p.total,
        connected: p.connected,
        rating: p.rating,
      }))
      .sort((a, b) => b.total - a.total);
  }

  broadcastState() {
    this.io.to(channel(this.code)).emit("room:state", this.publicState());
  }

  publicState() {
    return {
      code: this.code,
      ranked: this.ranked,
      isPrivate: this.isPrivate,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      settings: this.settings,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        total: p.total,
        connected: p.connected,
        submitted: p.submitted,
        rating: p.rating,
      })),
    };
  }

  updateSettings(byId, patch) {
    // A matchmaking room's settings come from the queue both players chose, and
    // for ranked they decide which ladder the Elo is written to — so a player
    // editing them during the pre-match countdown could farm or dodge a ladder
    // they never queued on. Fixed once the match is made.
    if (!this.isPrivate) return { error: "This match's settings are fixed by the queue you joined." };
    if (byId !== this.hostId) return { error: "Only the host can change settings." };
    if (this.phase !== "lobby" && this.phase !== "done") return { error: "Can't change settings mid-game." };
    if (patch.rounds != null) this.settings.rounds = clampInt(patch.rounds, 1, 15, this.settings.rounds);
    if (patch.mode != null) this.settings.mode = normalizeTier(patch.mode);
    if (patch.clue != null) this.settings.clue = normalizeMode(patch.clue);
    if (patch.guessSeconds != null) {
      this.settings.guessSeconds = clampInt(
        patch.guessSeconds,
        MIN_GUESS_SECONDS,
        MAX_GUESS_SECONDS,
        this.settings.guessSeconds
      );
    }
    if (patch.maxPlayers != null)
      this.settings.maxPlayers = clampInt(patch.maxPlayers, 2, config.game.maxPlayersPerRoom, this.settings.maxPlayers);
    if (patch.chatEnabled != null) this.settings.chatEnabled = asBool(patch.chatEnabled, this.settings.chatEnabled);
    if (patch.categories != null) this.settings.categories = normalizeCategories(patch.categories);
    this.broadcastState();
    return { ok: true };
  }

  clearTimers() {
    if (this.timers.guess) clearTimeout(this.timers.guess);
    if (this.timers.reveal) clearTimeout(this.timers.reveal);
    if (this.timers.start) clearTimeout(this.timers.start);
    if (this.timers.dispose) clearTimeout(this.timers.dispose);
    this.timers.guess = this.timers.reveal = this.timers.start = this.timers.dispose = null;
    for (const t of this.botTimers.values()) clearTimeout(t);
    this.botTimers.clear();
  }

  dispose() {
    this.clearTimers();
    for (const t of this.pendingRemoval.values()) clearTimeout(t);
    this.pendingRemoval.clear();
    for (const id of this.players.keys()) {
      if (this.manager.locate.get(id) === this.code) this.manager.locate.delete(id);
    }
    this.manager.rooms.delete(this.code);
  }
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// A toggle can arrive as a real boolean over Socket.IO or as a string from a
// form control, and `Boolean("false")` is true — which would make a room setting
// impossible to switch off. Anything unrecognised falls back to the default
// rather than silently becoming false.
function asBool(v, dflt) {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return dflt;
}

// ── Room + matchmaking manager ───────────────────────────────────────────────
class RoomManager {
  constructor(io, opts = {}) {
    this.io = io;
    this.rooms = new Map(); // code -> Room
    this.locate = new Map(); // identityId -> code
    // "kind:clue:tier" -> array of
    //   { user, socketId, enqueuedAt, rating, provisional }
    // The last three exist for ranked pairing; casual ignores them.
    this.queues = new Map();
    this.botFillTimers = new Map(); // identityId -> timeout (casual bot-fill)
    // One shared timer re-sweeps the ranked queues while anyone is waiting, so
    // widening search windows are acted on. Null whenever nobody is queued.
    this.rankedTicker = null;
    // Mystery source is injectable so tests can supply a deterministic one.
    this.fetchMystery = opts.fetchMystery || fetchMystery;
  }

  get(code) {
    return this.rooms.get(String(code || "").toUpperCase());
  }

  roomOf(identityId) {
    const code = this.locate.get(identityId);
    return code ? this.rooms.get(code) : null;
  }

  createPrivate(user, socket, settings) {
    let code;
    do {
      code = makeCode();
    } while (this.rooms.has(code));
    const room = new Room(this.io, this, {
      code,
      ranked: false,
      isPrivate: true,
      hostId: user.id,
      settings,
    });
    this.rooms.set(code, room);
    room.addPlayer(user, socket);
    return room;
  }

  // ── Matchmaking ────────────────────────────────────────────────────────────
  // Queues are split by kind (ranked/casual), clue (image/text/mixed) AND topic
  // tier, so a player only ever matches someone who chose the same thing. Both
  // ranked and casual players pick their tier; ranked ratings are per (clue,tier).
  queueKey(kind, clue, tier) {
    return `${kind === "ranked" ? "ranked" : "casual"}:${normalizeMode(clue)}:${tier}`;
  }
  queueFor(key) {
    if (!this.queues.has(key)) this.queues.set(key, []);
    return this.queues.get(key);
  }

  // The queue entry for a player on a given ladder. Ranked pairing needs the
  // rating they hold on THAT ladder — not their best or their most recent —
  // because each clue × tier pair is rated independently.
  makeEntry(user, socket, clue, tier) {
    const ladder = user.ratings && user.ratings[ladderKey(clue, tier)];
    return {
      user,
      socketId: socket.id,
      enqueuedAt: Date.now(),
      rating: ladder ? ladder.rating : START_RATING,
      provisional: !ladder || ladder.gamesPlayed < config.matchmaking.provisionalGames,
    };
  }

  enqueue(kind, clue, tier, user, socket) {
    if (kind === "ranked" && !user.ranked) {
      return { error: "Sign in with Google or Discord to play ranked." };
    }
    const effTier = normalizeTier(tier);
    const key = this.queueKey(kind, clue, effTier);
    // Drop any stale entry for this identity across all queues first.
    this.dequeue(user.id);
    const queue = this.queueFor(key);
    const entry = this.makeEntry(user, socket, clue, effTier);
    queue.push(entry);
    this.tryMatch(key);

    const stillWaiting = queue.some((e) => e.user.id === user.id);
    // Casual: if we didn't immediately pair with a human, fill with a bot after
    // a short wait so the player isn't stuck in an empty queue. Ranked never
    // gets a bot — a rating has to be won against a person.
    if (kind === "casual" && stillWaiting) this.scheduleBotFill(user.id, key);
    if (kind === "ranked" && stillWaiting) this.startRankedTicker();

    return {
      ok: true,
      position: queue.length,
      tier: effTier,
      ...(kind === "ranked" ? queueStatus(entry, Date.now()) : {}),
    };
  }

  // Mutates the queue arrays in place so any held references stay valid.
  dequeue(identityId) {
    this.cancelBotFill(identityId);
    for (const q of this.queues.values()) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].user.id === identityId) q.splice(i, 1);
      }
    }
    // That may have been the last ranked player waiting; don't keep ticking.
    if (this.rankedTicker && !this.hasRankedWaiting()) this.stopRankedTicker();
  }

  hasRankedWaiting() {
    for (const [key, q] of this.queues) if (key.startsWith("ranked:") && q.length) return true;
    return false;
  }

  // ── Casual bot-fill ──────────────────────────────────────────────────────────
  scheduleBotFill(identityId, key) {
    if (!config.game.botFillEnabled) return;
    this.cancelBotFill(identityId);
    const { botFillMinMs: min, botFillMaxMs: max } = config.game;
    const delay = Math.round(min + Math.random() * Math.max(0, max - min));
    this.botFillTimers.set(identityId, setTimeout(() => this.fillWithBot(identityId, key), delay));
  }

  cancelBotFill(identityId) {
    const t = this.botFillTimers.get(identityId);
    if (t) {
      clearTimeout(t);
      this.botFillTimers.delete(identityId);
    }
  }

  // Still-waiting casual player → pair them with a practice bot and start.
  fillWithBot(identityId, key) {
    this.botFillTimers.delete(identityId);
    const [kind, clue, tier] = key.split(":");
    if (kind !== "casual") return;
    const queue = this.queueFor(key);
    const idx = queue.findIndex((e) => e.user.id === identityId);
    if (idx === -1) return; // matched or left in the meantime
    const entry = queue[idx];
    const socket = this.io.sockets.sockets.get(entry.socketId);
    queue.splice(idx, 1);
    if (!socket) return; // player vanished

    let code;
    do {
      code = makeCode();
    } while (this.rooms.has(code));
    const room = new Room(this.io, this, {
      code,
      ranked: false,
      isPrivate: false,
      settings: { rounds: config.game.roundsPerGame, mode: tier, clue },
    });
    this.rooms.set(code, room);
    room.addPlayer(entry.user, socket);
    room.addBot(makeBot());
    this.io.to(channel(code)).emit("match:found", { code, ranked: false, clue, tier, bot: true });
    this.startAfterCountdown(room);
  }

  // Give clients a beat to land on the game screen, then start. Tracked on the
  // room so it's cleared if the room is torn down before it fires.
  startAfterCountdown(room) {
    room.timers.start = setTimeout(() => {
      room.timers.start = null;
      const res = room.start(room.hostId);
      if (res && res.error) {
        // Someone bailed during the countdown — don't strand the other player.
        this.io.to(channel(room.code)).emit("room:aborted", { message: "Opponent left before the match started." });
        room.dispose();
      }
    }, config.game.matchStartMs);
  }

  tryMatch(key) {
    const [kind] = key.split(":");
    return kind === "ranked" ? this.tryMatchRanked(key) : this.tryMatchCasual(key);
  }

  // Casual stays first-come-first-served. It promises an instant game with no
  // rating at stake, and guests — who have no rating to match on — play it.
  tryMatchCasual(key) {
    const [, clue, tier] = key.split(":");
    const queue = this.queueFor(key);
    while (queue.length >= 2) {
      const a = queue.shift();
      const b = queue.shift();
      const sa = this.io.sockets.sockets.get(a.socketId);
      const sb = this.io.sockets.sockets.get(b.socketId);
      // If either dropped, requeue the survivor and stop.
      if (!sa) {
        if (sb) queue.unshift(b);
        continue;
      }
      if (!sb) {
        queue.unshift(a);
        return;
      }
      this.startMatch("casual", clue, tier, a, b);
    }
  }

  // Ranked pairs on rating: the closest two players who currently accept each
  // other (see matchmaking.js). Repeats until the queue holds no legal pair —
  // one sweep can settle several matches when a crowd arrives at once.
  tryMatchRanked(key) {
    const [, clue, tier] = key.split(":");
    const queue = this.queueFor(key);
    this.pruneDeadSockets(queue);

    while (queue.length >= 2) {
      const pair = findPair(queue, Date.now());
      if (!pair) return; // nobody will have anybody yet — the ticker retries
      // Splice the higher index first so the lower one stays valid.
      const [b] = queue.splice(pair.j, 1);
      const [a] = queue.splice(pair.i, 1);
      const sa = this.io.sockets.sockets.get(a.socketId);
      const sb = this.io.sockets.sockets.get(b.socketId);
      // A socket can still vanish between the sweep and here. Put whoever is
      // left back rather than dropping a waiting player on the floor.
      if (!sa || !sb) {
        if (sa) queue.push(a);
        if (sb) queue.push(b);
        continue;
      }
      const room = this.startMatch("ranked", clue, tier, a, b);
      log.info("ranked_matched", {
        code: room.code,
        ladder: ladderKey(clue, tier),
        ratings: [a.rating, b.rating],
        gap: pair.gap,
        waitedMs: [Date.now() - a.enqueuedAt, Date.now() - b.enqueuedAt],
      });
    }
  }

  // Drop entries whose socket has gone. The disconnect handler already dequeues,
  // so this is a backstop that keeps the ticker from pairing against a ghost.
  pruneDeadSockets(queue) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!this.io.sockets.sockets.get(queue[i].socketId)) queue.splice(i, 1);
    }
  }

  // Build the room a matched pair drops into and start the countdown. Shared by
  // both queues so ranked and casual matches are set up identically.
  startMatch(kind, clue, tier, a, b) {
    let code;
    do {
      code = makeCode();
    } while (this.rooms.has(code));
    const ranked = kind === "ranked";
    const room = new Room(this.io, this, {
      code,
      ranked,
      isPrivate: false,
      // Tier is baked into the queue key — both queues carry the player's choice.
      settings: { rounds: config.game.roundsPerGame, mode: tier, clue },
    });
    this.rooms.set(code, room);
    // Matched with a human — no bot needed for either player.
    this.cancelBotFill(a.user.id);
    this.cancelBotFill(b.user.id);
    room.addPlayer(a.user, this.io.sockets.sockets.get(a.socketId));
    room.addPlayer(b.user, this.io.sockets.sockets.get(b.socketId));
    this.io.to(channel(code)).emit("match:found", {
      code,
      ranked,
      clue,
      tier,
      // Lets the client say who it found rather than just that it found someone.
      ...(ranked ? { ratingGap: Math.abs(a.rating - b.rating) } : {}),
    });
    this.startAfterCountdown(room);
    return room;
  }

  // ── Ranked queue ticker ──────────────────────────────────────────────────────
  // Search windows widen with waiting time, so a pair that is illegal now may be
  // legal a second from now. One shared timer re-sweeps every ranked queue
  // rather than one timer per waiting player, and it exists only while somebody
  // is actually waiting — an idle server runs no matchmaking work at all.
  startRankedTicker() {
    if (this.rankedTicker) return;
    this.rankedTicker = setInterval(() => this.sweepRanked(), config.matchmaking.tickMs);
    // Must never be the reason the process stays alive through a shutdown.
    if (this.rankedTicker.unref) this.rankedTicker.unref();
  }

  stopRankedTicker() {
    if (!this.rankedTicker) return;
    clearInterval(this.rankedTicker);
    this.rankedTicker = null;
  }

  sweepRanked() {
    const now = Date.now();
    let waiting = 0;
    for (const [key, queue] of this.queues) {
      if (!key.startsWith("ranked:") || queue.length === 0) continue;
      this.expireRanked(key, now);
      this.tryMatch(key);
      this.publishQueueStatus(key, now);
      waiting += this.queueFor(key).length;
    }
    if (waiting === 0) this.stopRankedTicker();
  }

  // Give up rather than leave someone staring at a spinner indefinitely. On a
  // small ladder at a quiet hour there may genuinely be nobody to play.
  expireRanked(key, now) {
    const timeout = config.matchmaking.rankedTimeoutMs;
    if (!timeout) return;
    const queue = this.queueFor(key);
    for (let i = queue.length - 1; i >= 0; i--) {
      const waited = now - queue[i].enqueuedAt;
      if (waited < timeout) continue;
      const [entry] = queue.splice(i, 1);
      const socket = this.io.sockets.sockets.get(entry.socketId);
      log.info("ranked_queue_timeout", { ladder: key.slice("ranked:".length), waitedMs: waited });
      if (socket) socket.emit("queue:timeout", { kind: "ranked", waitedMs: waited });
    }
  }

  // Tell each waiting player how long they've been searching and how wide their
  // window has grown, so the wait is legible instead of an indefinite spinner.
  publishQueueStatus(key, now) {
    const queue = this.queueFor(key);
    for (const entry of queue) {
      const socket = this.io.sockets.sockets.get(entry.socketId);
      if (socket) socket.emit("queue:status", { ...queueStatus(entry, now), waiting: queue.length });
    }
  }

  // Tear down every room (clearing all timers) and empty the queues. Used for
  // graceful shutdown and to let test processes exit cleanly.
  shutdown() {
    for (const t of this.botFillTimers.values()) clearTimeout(t);
    this.botFillTimers.clear();
    this.stopRankedTicker();
    for (const room of [...this.rooms.values()]) room.dispose();
    this.queues = new Map();
  }
}

module.exports = { Room, RoomManager, channel, chatChannel };
