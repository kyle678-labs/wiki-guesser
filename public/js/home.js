/* Landing / lobby page logic. */
(async function () {
  WG.initTheme();
  await WG.loadConfig();
  WG.connect();
  WG.injectAds();
  WG.renderUserPill(document.getElementById("user-pill"));

  // Surface OAuth errors passed back on the query string.
  const params = new URLSearchParams(location.search);
  if (params.get("error") === "oauth_unconfigured") WG.toast("That sign-in method isn't configured.");
  if (params.get("error") === "auth_failed") WG.toast("Sign-in failed — please try again.");
  if (params.get("error")) history.replaceState({}, "", "/");

  // A suspended account is refused at the socket handshake and by the daily
  // routes, which without this would look like a site that has simply stopped
  // working. Say it plainly and once, at the top of the page they land on.
  renderBanNotice();
  function renderBanNotice() {
    const me = WG.getUser();
    if (!me || !me.banned) return;
    const { reason, until } = me.banned;
    const lifts = until == null
      ? "This suspension is permanent."
      : `It lifts on ${new Date(until).toLocaleString()}.`;
    const card = document.createElement("div");
    card.className = "card ban-notice";
    card.innerHTML =
      `<h2>Your account is suspended</h2>
       <p>${WG.escapeHtml(lifts)} You can still read the site, but not play, queue or chat.</p>` +
      (reason ? `<p class="muted">Reason: ${WG.escapeHtml(reason)}</p>` : "");
    const grid = document.querySelector(".mode-grid");
    if (grid) grid.before(card);
    else document.querySelector(".container").prepend(card);
  }

  const gotoRoom = (code) => (window.location = `/room/${code}`);

  // Navigation into a room happens once the server confirms membership.
  WG.on("room:joined", ({ code }) => gotoRoom(code));
  WG.on("match:found", ({ code }) => gotoRoom(code));
  WG.on("room:error", ({ message }) => { setQueueUi(false); WG.toast(message); });

  // ── Matchmaking ─────────────────────────────────────────────────────────────
  let queued = false;
  function setQueueUi(on, label) {
    queued = on;
    ["btn-ranked", "btn-casual", "btn-create", "btn-join"].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = on;
    });
    let banner = document.getElementById("queue-banner");
    if (on) {
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "queue-banner";
        banner.className = "card";
        banner.style.textAlign = "center";
        document.querySelector(".mode-grid").after(banner);
      }
      banner.innerHTML = `<p>${label}… <span class="muted">waiting for an opponent</span></p>
        <p class="hint" id="queue-status"></p>
        <button class="ghost small" id="btn-cancel-queue" style="margin-top:0.6rem">Cancel</button>`;
      banner.querySelector("#btn-cancel-queue").addEventListener("click", () => {
        WG.emit("queue:leave");
        setQueueUi(false);
      });
    } else if (banner) {
      banner.remove();
    }
  }

  // Ranked search widens the longer you wait, so say so — an unexplained wait
  // reads as broken, whereas a widening range reads as looking harder.
  function renderQueueStatus(s) {
    const el = document.getElementById("queue-status");
    if (!el || !s || s.window == null) return;
    const secs = Math.round((s.waitedMs || 0) / 1000);
    const lo = Math.max(0, s.rating - s.window);
    const hi = s.rating + s.window;
    el.textContent =
      `Searching ${lo}–${hi} (your rating ${s.rating}${s.provisional ? ", provisional" : ""})` +
      ` · ${secs}s · the range widens as you wait`;
  }

  WG.on("queue:waiting", renderQueueStatus);
  WG.on("queue:status", renderQueueStatus);

  WG.on("queue:timeout", ({ waitedMs }) => {
    setQueueUi(false);
    const mins = Math.max(1, Math.round((waitedMs || 0) / 60000));
    WG.toast(`No ranked opponent found after ${mins} min — try casual, or a private room with friends.`);
  });

  document.getElementById("btn-ranked").addEventListener("click", async () => {
    const user = await WG.ensureUser({ rankedRequired: true });
    if (!user) return;
    // A player who already has a guest session never sees the auth modal —
    // ensureUser returns their existing identity — so this is the only place
    // that tells them why ranked is refusing them. It has to distinguish "get an
    // account" from "there is no account to get", or it sends someone off to
    // find a sign-in button that isn't rendered.
    if (!user.ranked) {
      const p = (WG.getConfig() && WG.getConfig().providers) || {};
      return WG.toast(
        p.google || p.discord
          ? "Ranked needs a Google or Discord account."
          : "Ranked sign-in is unavailable right now — casual and private rooms are still open."
      );
    }
    WG.renderUserPill(document.getElementById("user-pill"));
    // No tier prompt: ranked runs on a single tier, so asking would be a
    // question with one answer. The clue picker offers only the rankable ones —
    // both lists come from the server, which is also what enforces them, so the
    // picker can never offer something the queue would then refuse.
    const ranked = WG.rankedConfig();
    const clue = await WG.chooseMode({
      title: "Ranked match",
      subtitle: `Pick a clue type — ranked is always ${WG.tierLabel(ranked.defaultTier)}.`,
      only: ranked.modes,
    });
    if (!clue) return;
    WG.emit("queue:join", { ranked: true, clue, tier: ranked.defaultTier });
    setQueueUi(true, `Finding a ranked ${WG.tierLabel(ranked.defaultTier)} · ${WG.modeLabel(clue)} match`);
  });

  document.getElementById("btn-casual").addEventListener("click", async () => {
    const user = await WG.ensureUser();
    if (!user) return;
    WG.renderUserPill(document.getElementById("user-pill"));
    const clue = await WG.chooseMode({ title: "Casual quick match", subtitle: "No rating on the line." });
    if (!clue) return;
    const tier = await WG.chooseTier({ title: "Casual quick match", subtitle: "How obscure should the topics get?" });
    if (!tier) return;
    WG.emit("queue:join", { ranked: false, clue, tier });
    setQueueUi(true, `Finding a casual ${WG.tierLabel(tier)} · ${WG.modeLabel(clue)} match`);
  });

  // ── Private rooms ───────────────────────────────────────────────────────────
  document.getElementById("btn-create").addEventListener("click", async () => {
    const user = await WG.ensureUser();
    if (!user) return;
    WG.emit("room:create", { rounds: 5, mode: "party", maxPlayers: 8 });
  });

  async function joinByCode() {
    const code = document.getElementById("join-code").value.trim().toUpperCase();
    if (!code) return;
    const user = await WG.ensureUser();
    if (!user) return;
    WG.emit("room:join", { code });
  }
  document.getElementById("btn-join").addEventListener("click", joinByCode);
  document.getElementById("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinByCode(); });

  // ── Leaderboard ─────────────────────────────────────────────────────────────
  // Only ranked ladders have standings, so the tabs are exactly the ranked set —
  // rendered from /api/config rather than written into the markup, so adding a
  // ranked ladder stays a one-file change on the server and the board follows.
  const boardCfg = WG.rankedConfig();
  let boardClue = boardCfg.modes[0];
  let boardTier = boardCfg.defaultTier;

  function renderBoardTabs() {
    const tab = (attr, value, label, on) =>
      `<button class="board-tab${on ? " active" : ""}" data-${attr}="${value}">${WG.escapeHtml(label)}</button>`;

    document.getElementById("board-clue-tabs").innerHTML = boardCfg.modes
      .map((m) => tab("clue", m, WG.modeLabel(m), m === boardClue))
      .join("");

    // A single ranked tier means there is nothing to pick between, and one tab
    // that cannot be unselected is furniture. Hidden rather than deleted so the
    // row reappears on its own if a second ranked tier is ever added.
    const tierTabs = document.getElementById("board-tier-tabs");
    tierTabs.classList.toggle("hidden", boardCfg.tiers.length < 2);
    tierTabs.innerHTML = boardCfg.tiers
      .map((t) => tab("tier", t, WG.tierLabel(t), t === boardTier))
      .join("");
  }

  function wireTabs(sel, onPick) {
    document.querySelectorAll(`${sel} .board-tab`).forEach((tab) =>
      tab.addEventListener("click", () => {
        document.querySelectorAll(`${sel} .board-tab`).forEach((t) => t.classList.toggle("active", t === tab));
        onPick(tab);
        loadLeaderboard();
      })
    );
  }
  renderBoardTabs();
  wireTabs("#board-clue-tabs", (tab) => { boardClue = tab.dataset.clue; });
  wireTabs("#board-tier-tabs", (tab) => { boardTier = tab.dataset.tier; });

  // Must come after boardClue/boardTier are initialised: calling it earlier hits
  // their temporal dead zone, and the catch below turns that into a permanent
  // "couldn't load" on first paint.
  loadLeaderboard();

  async function loadLeaderboard() {
    try {
      const res = await fetch(`/api/leaderboard?clue=${encodeURIComponent(boardClue)}&tier=${encodeURIComponent(boardTier)}`);
      const { leaderboard } = await res.json();
      const body = document.getElementById("board-body");
      if (!leaderboard.length) {
        body.innerHTML = `<tr><td colspan="5" class="muted">No ranked games yet — be the first!</td></tr>`;
        return;
      }
      body.innerHTML = leaderboard
        .map(
          (r) => `<tr>
            <td>${r.rank}</td>
            <td><div class="who">${WG.avatarHtml(r.name, r.avatar, "sm")} ${WG.escapeHtml(r.name)}</div></td>
            <td>${WG.escapeHtml(r.tier)}</td>
            <td class="rating">${r.rating}</td>
            <td class="muted">${r.wins}/${r.losses}/${r.draws}</td>
          </tr>`
        )
        .join("");
    } catch (e) {
      // Surfaced, not just swallowed — a silent catch here hid the bug above.
      console.error("leaderboard failed to load", e);
      document.getElementById("board-body").innerHTML = `<tr><td colspan="5" class="muted">Couldn't load leaderboard.</td></tr>`;
    }
  }
})();
