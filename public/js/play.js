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

  WG.on("chat:msg", ({ name, text }) => {
    const log = $("chat-log");
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `<span class="who">${WG.escapeHtml(name)}:</span> ${WG.escapeHtml(text)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  });

  WG.on("need-auth", async () => {
    const u = await WG.showAuthModal();
    if (u) { WG.reconnect(); WG.emit("room:join", { code }); }
  });

  // ── Rendering ───────────────────────────────────────────────────────────────
  function render() {
    if (!state) return;
    $("room-label").textContent = state.ranked ? "Ranked" : state.isPrivate ? `Room ${state.code}` : "Casual";

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
      if (state.isPrivate) {
        $("share-link").value = `${location.origin}/room/${state.code}`;
        $("set-rounds").value = String(state.settings.rounds);
        $("set-mode").value = state.settings.mode;
        $("set-clue").value = state.settings.clue || "image";
        setSeconds(state.settings.guessSeconds);
        $("set-rounds").disabled = $("set-mode").disabled = $("set-clue").disabled =
          $("set-seconds").disabled = !isHost;
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
  $("set-rounds").addEventListener("change", (e) => WG.emit("room:settings", { rounds: e.target.value }));
  $("set-seconds").addEventListener("change", (e) => WG.emit("room:settings", { guessSeconds: e.target.value }));
  $("set-mode").addEventListener("change", (e) => WG.emit("room:settings", { mode: e.target.value }));
  $("set-clue").addEventListener("change", (e) => WG.emit("room:settings", { clue: e.target.value }));

  $("btn-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("share-link").value); WG.toast("Link copied!"); }
    catch { $("share-link").select(); }
  });

  $("btn-leave").addEventListener("click", () => { WG.emit("room:leave"); window.location = "/"; });

  function sendChat() {
    const t = $("chat-input").value.trim();
    if (!t) return;
    WG.emit("chat:send", { text: t });
    $("chat-input").value = "";
  }
  $("chat-send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

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
