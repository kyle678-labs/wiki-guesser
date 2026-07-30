/* Game room logic. */
(async function () {
  // Room code comes from /room/CODE or /play?code=CODE.
  const m = location.pathname.match(/^\/room\/([A-Za-z0-9]+)/);
  const code = (m ? m[1] : new URLSearchParams(location.search).get("code") || "").toUpperCase();

  WG.initTheme();
  await WG.loadConfig();
  WG.injectAds();
  WG.renderUserPill(document.getElementById("user-pill"));

  const $ = (id) => document.getElementById(id);
  let state = null;      // latest room:state
  let myId = WG.getUser() && WG.getUser().id;
  let timerHandle = null;
  let submitted = false;
  // What the invite buttons copy. Taken from the room's own state rather than
  // from `code` above, which is only what was typed into the address bar.
  let roomCode = "";
  let inviteUrl = "";

  // Need an identity before we can join.
  let user = WG.getUser();
  if (!user) {
    user = await WG.showAuthModal();
    if (!user) { window.location = "/"; return; }
    WG.renderUserPill($("user-pill"));
  }
  myId = WG.getUser() && WG.getUser().id;

  WG.connect();
  WG.on("me", ({ user }) => { myId = user.id; });
  WG.emit("room:join", { code });

  // ── Socket events ───────────────────────────────────────────────────────────
  WG.on("room:error", ({ message }) => {
    WG.toast(message);
    if (/no room|in progress|full/i.test(message)) setTimeout(() => (window.location = "/"), 1800);
  });

  WG.on("room:aborted", ({ message }) => {
    WG.toast(message || "Match aborted.");
    setTimeout(() => (window.location = "/"), 1800);
  });

  WG.on("room:state", (s) => {
    // Notice an opponent dropping out mid-game and say so.
    if (state && s.phase !== "lobby" && s.phase !== "done") {
      const was = new Map(state.players.map((p) => [p.id, p.connected]));
      for (const p of s.players) {
        if (p.id !== myId && was.get(p.id) === true && p.connected === false) {
          WG.toast(`${p.name} disconnected — waiting for them to reconnect…`);
        }
      }
    }
    state = s;
    render();
  });
  WG.on("room:joined", () => {});
  WG.on("room:rejoined", () => {});

  WG.on("round:loading", ({ round, totalRounds }) => {
    hide("reveal-panel", "over-panel", "guess-area");
    stopSpeak();
    $("round-label").textContent = `· Round ${round}/${totalRounds}`;
    $("image-frame").classList.remove("text-mode");
    $("image-frame").innerHTML = `<div class="loading" id="frame-msg">Loading the next clue…</div>`;
    stopTimer();
    $("timer").textContent = "";
  });

  WG.on("round:start", (r) => {
    hide("reveal-panel", "over-panel");
    submitted = false;
    $("round-label").textContent = `· Round ${r.round}/${r.totalRounds}`;
    const frame = $("image-frame");
    if (r.clue === "text") {
      frame.classList.add("text-mode");
      frame.innerHTML = `<div class="clue-text">${WG.escapeHtml(r.extract || "")}</div>
        <button class="small clue-speak" id="clue-speak" type="button">🔊 Read aloud</button>`;
      $("clue-speak").addEventListener("click", () => speak(r.extract || ""));
    } else {
      frame.classList.remove("text-mode");
      const img = new Image();
      img.onload = () => { frame.innerHTML = ""; frame.appendChild(img); };
      img.onerror = () => { frame.innerHTML = `<div class="loading">Image failed to load.</div>`; };
      img.src = r.image;
    }
    $("guess-area").classList.remove("hidden");
    $("guess-input").value = "";
    $("guess-input").disabled = false;
    $("guess-submit").disabled = false;
    $("guess-input").focus();
    $("guess-hint").textContent = r.clue === "text"
      ? `Which article is this describing? ${r.wordCount} word${r.wordCount > 1 ? "s" : ""} — answer fast for a bigger score.`
      : `${r.wordCount} word${r.wordCount > 1 ? "s" : ""}. Name it or fish words from its article — answer fast for a bigger score.`;
    startTimer(r.endsAt);
  });

  WG.on("round:progress", ({ submitted, total }) => {
    if (!submitted) return;
    $("guess-hint").textContent = `${submitted}/${total} locked in…`;
  });

  WG.on("round:reveal", (r) => {
    stopTimer();
    stopSpeak();
    $("timer").textContent = "";
    hide("guess-area");
    // In description mode, fill the blank back in so players see the full sentence.
    if (r.clue === "text" && r.extract) {
      const frame = $("image-frame");
      frame.classList.add("text-mode");
      frame.innerHTML = `<div class="clue-text">${WG.escapeHtml(r.extract)}</div>`;
    }
    $("reveal-answer").textContent = r.title;
    $("reveal-desc").textContent = r.desc || "";
    $("reveal-results").innerHTML = r.results
      .map(
        (x) => `<div class="result-item">
          <div class="pts">${x.points}</div>
          <div class="meta">
            <div>${WG.escapeHtml(x.name)} ${x.id === myId ? "<span class='muted'>(you)</span>" : ""}</div>
            <div class="g">${x.guess ? "“" + WG.escapeHtml(x.guess) + "”" : "(no guess)"}</div>
            ${x.credit ? `<div class="credit">${WG.escapeHtml(x.credit)}</div>` : ""}
            ${x.speedBonus ? `<div class="credit">${x.base} base + ${x.speedBonus} speed</div>` : ""}
          </div>
          <div class="score">${x.total}</div>
        </div>`
      )
      .join("");
    show("reveal-panel");
  });

  WG.on("game:over", ({ standings, ranked, ratingChanges, forfeit, winnerId, history }) => {
    stopTimer();
    hide("guess-area", "reveal-panel");
    const winner = standings[0];
    const iWon = winner && winner.id === myId;
    $("over-title").textContent = iWon ? "You win!" : `${winner ? winner.name : "Nobody"} wins!`;
    const notes = [];
    if (ranked && ratingChanges && ratingChanges.mode) notes.push(`Ranked · ${WG.ladderLabel(ratingChanges.mode)} ladder`);
    if (forfeit) notes.push(iWon ? "Your opponent left — the win goes to you by forfeit." : "The game ended early because a player left.");
    $("over-note").textContent = notes.join(" — ");
    $("over-standings").innerHTML = standings
      .map((x, i) => {
        const rc = ratingChanges && ratingChanges[x.id];
        const deltaHtml = rc
          ? ` <span class="${rc.delta >= 0 ? "delta-up" : "delta-down"}">${rc.delta >= 0 ? "+" : ""}${rc.delta}</span>
              <span class="muted">→ ${rc.after} ${WG.escapeHtml(rc.tier.name)}</span>`
          : "";
        return `<div class="result-item">
          <div class="pts">${i + 1}</div>
          <div class="meta"><div>${WG.escapeHtml(x.name)} ${x.id === myId ? "<span class='muted'>(you)</span>" : ""}${deltaHtml}</div></div>
          <div class="score">${x.total}</div>
        </div>`;
      })
      .join("");
    renderRecap(history);

    const actions = $("over-actions");
    actions.innerHTML = "";
    if (state && state.isPrivate) {
      const again = document.createElement("button");
      again.className = "primary";
      again.textContent = "Back to lobby";
      again.onclick = () => { hide("over-panel"); render(); };
      actions.appendChild(again);
    } else {
      const home = document.createElement("button");
      home.className = "primary";
      home.textContent = "New match";
      home.onclick = () => (window.location = "/");
      actions.appendChild(home);
    }
    show("over-panel");
  });

  WG.on("chat:msg", ({ id, fromId, name, text }) => {
    const log = $("chat-log");
    const div = document.createElement("div");
    div.className = "msg";
    if (id) div.dataset.mid = id;
    // No reporting your own messages — the server refuses it anyway, so offering
    // the button would only produce an error.
    const canReport = Boolean(id) && fromId !== myId;
    div.innerHTML =
      `<span class="who">${WG.escapeHtml(name)}:</span> <span class="txt">${WG.escapeHtml(text)}</span>` +
      (canReport ? ` <button class="chat-report" title="Report this message">⚑</button>` : "");
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  });

  // Reporting is two-step for the same reason account deletion is: the first
  // click of something that reaches a human should never be the last one. The
  // button arms itself, and only a second click sends. Delegated, because
  // messages are appended continuously.
  $("chat-log").addEventListener("click", (e) => {
    const btn = e.target.closest(".chat-report");
    if (!btn) return;
    const row = btn.closest(".msg");
    if (!row) return;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Report?";
      btn.classList.add("armed");
      // Disarm if they don't follow through, so it can't be clicked by accident
      // much later.
      setTimeout(() => {
        if (btn.dataset.armed !== "1") return;
        delete btn.dataset.armed;
        btn.textContent = "⚑";
        btn.classList.remove("armed");
      }, 4000);
      return;
    }
    WG.emit("chat:report", { id: row.dataset.mid });
    btn.disabled = true;
    btn.textContent = "…";
  });

  WG.on("chat:reported", ({ id }) => {
    const row = $("chat-log").querySelector(`.msg[data-mid="${window.CSS && CSS.escape ? CSS.escape(id) : id}"]`);
    if (row) {
      row.classList.add("reported");
      const btn = row.querySelector(".chat-report");
      if (btn) btn.replaceWith(document.createTextNode(" (reported)"));
    }
    WG.toast("Thanks — that message has been reported.");
  });

  WG.on("need-auth", async () => {
    const u = await WG.showAuthModal();
    if (u) { WG.reconnect(); WG.emit("room:join", { code }); }
  });

  // ── Rendering ───────────────────────────────────────────────────────────────
  function render() {
    if (!state) return;
    $("room-label").textContent = state.ranked ? "Ranked" : state.isPrivate ? `Room ${state.code}` : "Casual";
    applyChatVisibility();

    // Players list
    $("players-list").innerHTML = state.players
      .map((p) => {
        const dot = !p.connected ? "" : p.id === state.hostId ? "host" : p.submitted ? "ready" : "";
        return `<div class="player-row ${p.connected ? "" : "disconnected"}">
          <span class="status-dot ${dot}"></span>
          ${WG.avatarHtml(p.name, p.avatar, "sm")}
          <span class="name">${WG.escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>
          ${p.rating ? `<span class="muted">${p.rating}</span>` : ""}
          <span class="score">${p.total}</span>
        </div>`;
      })
      .join("");

    // Lobby vs in-game
    const inLobby = state.phase === "lobby";
    const isHost = state.hostId === myId;
    if (inLobby) {
      show("lobby-box");
      // A matchmaking room has nobody to invite and settings the queue already
      // decided, so it shows neither — just who it found and that it's starting.
      $("invite-block").classList.toggle("hidden", !state.isPrivate);
      $("host-settings").classList.toggle("hidden", !state.isPrivate);
      // Sibling of host-settings rather than a field inside it (the grid is for
      // single selects), so it needs hiding explicitly — a matchmaking room's
      // pool is fixed by the queue.
      $("cat-picker").classList.toggle("hidden", !state.isPrivate);
      if (state.isPrivate) {
        roomCode = state.code;
        inviteUrl = `${location.origin}/room/${state.code}`;
        $("room-code").textContent = roomCode;
        $("share-link").textContent = inviteUrl;
        $("set-rounds").value = String(state.settings.rounds);
        $("set-mode").value = state.settings.mode;
        $("set-clue").value = state.settings.clue || "image";
        $("set-chat").value = String(state.settings.chatEnabled !== false);
        setSeconds(state.settings.guessSeconds);
        $("set-rounds").disabled = $("set-mode").disabled = $("set-clue").disabled =
          $("set-seconds").disabled = $("set-chat").disabled = !isHost;
        renderCategories(isHost);
      }
      const enoughPlayers = state.players.filter((p) => p.connected).length >= 2;
      if (!state.isPrivate) {
        $("btn-start").classList.add("hidden");
        $("lobby-hint").textContent = "Match found — starting shortly…";
      } else {
        $("btn-start").classList.toggle("hidden", !isHost);
        $("btn-start").disabled = !enoughPlayers;
        $("lobby-hint").textContent = isHost
          ? enoughPlayers ? "" : "Waiting for at least one more player…"
          : "Waiting for the host to start…";
      }
      // Back in the lobby, whether that's a fresh room or one that just finished
      // a game — so clear the last round's clue and timer rather than leaving
      // the previous mystery on screen.
      $("image-frame").classList.remove("text-mode");
      $("image-frame").innerHTML = `<div class="loading" id="frame-msg">Waiting in the lobby…</div>`;
      $("timer").textContent = "";
      hide("guess-area");
    } else {
      hide("lobby-box");
    }
  }

  // The dropdown offers a fixed set of timers, but the server accepts anything
  // from 5 to 120 — a room built with a custom GUESS_SECONDS default would
  // otherwise show a blank select. Add whatever value the room actually has.
  function setSeconds(seconds) {
    const sel = $("set-seconds");
    const value = String(seconds);
    if (!sel.querySelector(`option[value="${value}"]`)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      sel.appendChild(opt);
    }
    sel.value = value;
  }

  // ── Controls ────────────────────────────────────────────────────────────────
  function submitGuess() {
    if (submitted) return;
    const text = $("guess-input").value.trim();
    submitted = true;
    $("guess-input").disabled = true;
    $("guess-submit").disabled = true;
    $("guess-hint").textContent = "Locked in — waiting for others…";
    WG.emit("guess:submit", { text });
  }
  $("guess-submit").addEventListener("click", submitGuess);
  $("guess-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitGuess(); });

  $("btn-start").addEventListener("click", () => WG.emit("room:start"));
  // ── Category picker ─────────────────────────────────────────────────────────
  // Each category shows how many articles it actually offers for THIS room's
  // difficulty and clue type, because "Animals" meaning 3,000 articles or 90 is
  // the difference between a varied game and seeing the same otter twice. When
  // the party tier makes a chosen category thin, the note below says so and
  // names the number chaos would give instead — a concrete comparison rather
  // than a vague warning.
  // Below this a pool is small enough that repeats show up quickly: at 5 rounds
  // a game, 100 articles is roughly twenty sessions before you have seen most of
  // it. Calibrated against the real pool, where party-tier image mode leaves
  // Food & drink on 15 articles and Games on 21 — numbers a player would
  // absolutely notice, and the reason the note points at Total chaos.
  const THIN = 100;

  function catCounts() {
    const cfg = WG.getConfig() || {};
    const counts = cfg.categoryCounts;
    if (!counts || !state) return null;
    const tier = counts[state.settings.mode] || counts.party;
    return (tier && tier[state.settings.clue || "image"]) || null;
  }

  function renderCategories(isHost) {
    const cfg = WG.getConfig() || {};
    const cats = cfg.categories || [];
    const labels = cfg.categoryLabels || {};
    const chosen = new Set(state.settings.categories || []);
    const counts = catCounts();

    $("cat-grid").innerHTML = cats
      .map((c) => {
        const n = counts ? counts[c] : null;
        const thin = n != null && n < THIN;
        // aria-pressed because these are toggles: without it the only signal
        // that a category is selected is a border colour, which a screen reader
        // cannot convey and a colourblind player may not see.
        return `<button type="button" class="cat-opt${chosen.has(c) ? " on" : ""}${thin ? " thin" : ""}"
                  data-cat="${c}" aria-pressed="${chosen.has(c)}" ${isHost ? "" : "disabled"}>
          <span class="cat-name">${WG.escapeHtml(labels[c] || c)}</span>
          <span class="cat-count">${n == null ? "" : n.toLocaleString()}</span>
        </button>`;
      })
      .join("");
    $("cat-clear").disabled = !isHost || chosen.size === 0;
    $("cat-note").innerHTML = categoryNote(chosen, counts);
  }

  function categoryNote(chosen, counts) {
    if (!chosen.size) return "Any topic. Pick one or more to narrow the game.";

    const cfg = WG.getConfig() || {};
    const labels = cfg.categoryLabels || {};
    const names = [...chosen].map((c) => WG.escapeHtml(labels[c] || c)).join(", ");
    if (!counts) return `Drawing from: ${names}.`;

    // Categories combine as OR — a round matches if the article is in ANY of
    // them — so the pool is at most the sum. Articles in two chosen categories
    // are double-counted here, which makes this a slight over-estimate and
    // therefore the safe direction for a warning.
    const total = [...chosen].reduce((n, c) => n + (counts[c] || 0), 0);
    const line = `Drawing from: ${names} — about ${total.toLocaleString()} article${total === 1 ? "" : "s"}.`;
    if (state.settings.mode !== "party") return line;

    const chaosAll = (cfg.categoryCounts && cfg.categoryCounts.chaos) || null;
    const chaosFor = chaosAll && chaosAll[state.settings.clue || "image"];
    if (!chaosFor) return line;
    const chaosTotal = [...chosen].reduce((n, c) => n + (chaosFor[c] || 0), 0);
    if (chaosTotal <= total) return line;

    // Judged on the combined pool, not per category — what a player experiences
    // is the total they are drawing from, however many boxes produced it.
    const thin = total < THIN;
    return (
      line +
      `<br><span class="${thin ? "warn" : "muted"}">` +
      (thin ? "That's a small pool — expect repeats. " : "") +
      `Switching Difficulty to <strong>Total chaos</strong> raises it to about ${chaosTotal.toLocaleString()}.` +
      "</span>"
    );
  }

  $("cat-grid").addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-opt");
    if (!btn || btn.disabled || !state) return;
    const chosen = new Set(state.settings.categories || []);
    const c = btn.dataset.cat;
    if (chosen.has(c)) chosen.delete(c);
    else chosen.add(c);
    WG.emit("room:settings", { categories: [...chosen] });
  });

  $("cat-clear").addEventListener("click", () => WG.emit("room:settings", { categories: [] }));

  $("set-rounds").addEventListener("change", (e) => WG.emit("room:settings", { rounds: e.target.value }));
  $("set-seconds").addEventListener("change", (e) => WG.emit("room:settings", { guessSeconds: e.target.value }));
  $("set-mode").addEventListener("change", (e) => WG.emit("room:settings", { mode: e.target.value }));
  $("set-clue").addEventListener("change", (e) => WG.emit("room:settings", { clue: e.target.value }));

  // Copy the code or the whole link. Where the clipboard is refused — an
  // insecure origin, a browser that wants a permission first — the text is
  // selected instead, so the player can still take it manually rather than
  // being left with a button that silently does nothing.
  async function copyInvite(text, el, label) {
    try {
      await navigator.clipboard.writeText(text);
      WG.toast(`${label} copied!`);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      WG.toast("Couldn't copy — it's selected, so press Ctrl+C.");
    }
  }

  $("btn-copy").addEventListener("click", () => copyInvite(inviteUrl, $("share-link"), "Invite link"));
  $("btn-copy-code").addEventListener("click", () => copyInvite(roomCode, $("room-code"), "Room code"));

  $("btn-leave").addEventListener("click", () => { WG.emit("room:leave"); window.location = "/"; });

  function sendChat() {
    const t = $("chat-input").value.trim();
    if (!t) return;
    WG.emit("chat:send", { text: t });
    $("chat-input").value = "";
  }
  $("chat-send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  // Two independent switches, and they mean different things:
  //   • the host's room setting removes chat for EVERYONE in a private room
  //   • the player's own toggle hides it for THEM, in every room and every game
  // The room setting wins, because there is nothing to show when it is off.
  function applyChatVisibility() {
    const roomAllows = !state || state.settings.chatEnabled !== false;
    const mine = WG.chatEnabled();
    $("chat-card").classList.toggle("hidden", !roomAllows);
    $("chat-body").classList.toggle("hidden", !mine);
    $("chat-hidden-note").classList.toggle("hidden", mine);
    $("chat-toggle").textContent = mine ? "Hide" : "Show";
  }

  $("chat-toggle").addEventListener("click", async () => {
    const btn = $("chat-toggle");
    btn.disabled = true;
    await WG.setChatEnabled(!WG.chatEnabled());
    btn.disabled = false;
    applyChatVisibility();
  });

  $("set-chat").addEventListener("change", (e) =>
    WG.emit("room:settings", { chatEnabled: e.target.value === "true" })
  );

  // The player's own preference is known before any room state arrives, so paint
  // it immediately rather than leaving chat visible until the first room:state.
  applyChatVisibility();

  // ── Timer ───────────────────────────────────────────────────────────────────
  function startTimer(endsAt) {
    stopTimer();
    const tick = () => {
      const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      const el = $("timer");
      el.textContent = `${left}s`;
      el.classList.toggle("low", left <= 5);
      if (left <= 0) stopTimer();
    };
    tick();
    timerHandle = setInterval(tick, 250);
  }
  function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } $("timer").classList.remove("low"); }

  // End-of-game overview: each round's image, topic (linked to Wikipedia), and scores.
  function renderRecap(history) {
    const el = $("over-recap");
    if (!history || !history.length) { el.innerHTML = ""; return; }
    el.innerHTML =
      `<h3 class="recap-title">Round recap</h3><div class="recap-list">` +
      history
        .map((h) => {
          const topic = h.url
            ? `<a href="${WG.escapeHtml(h.url)}" target="_blank" rel="noopener">${WG.escapeHtml(h.title)}</a>`
            : WG.escapeHtml(h.title);
          const scores = h.scores
            .map((s) => `<span>${WG.escapeHtml(s.name)}${s.id === myId ? " (you)" : ""}: <b>${s.points}</b></span>`)
            .join("");
          const thumb = h.clue === "text" || !h.image
            ? `<div class="recap-img recap-img-text">${WG.escapeHtml(h.extract || h.desc || "")}</div>`
            : `<img class="recap-img" src="${WG.escapeHtml(h.image)}" alt="" loading="lazy">`;
          return `<div class="recap-item">
            ${thumb}
            <div class="recap-meta">
              <div class="recap-topic"><span class="recap-num">R${h.round}</span> ${topic}</div>
              ${h.desc ? `<div class="hint">${WG.escapeHtml(h.desc)}</div>` : ""}
              <div class="recap-scores">${scores}</div>
            </div>
          </div>`;
        })
        .join("") +
      `</div>`;
  }

  // Read the description clue aloud (Web Speech API), blanks voiced as "blank".
  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return;
    stopSpeak();
    const spoken = text.replace(/_____/g, " blank ");
    const u = new SpeechSynthesisUtterance(spoken);
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  }
  function stopSpeak() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  function show(...ids) { ids.forEach((id) => $(id).classList.remove("hidden")); }
  function hide(...ids) { ids.forEach((id) => $(id).classList.add("hidden")); }
})();
