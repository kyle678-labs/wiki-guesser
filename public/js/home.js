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
        <button class="ghost small" id="btn-cancel-queue" style="margin-top:0.6rem">Cancel</button>`;
      banner.querySelector("#btn-cancel-queue").addEventListener("click", () => {
        WG.emit("queue:leave");
        setQueueUi(false);
      });
    } else if (banner) {
      banner.remove();
    }
  }

  document.getElementById("btn-ranked").addEventListener("click", async () => {
    const user = await WG.ensureUser({ rankedRequired: true });
    if (!user) return;
    if (!user.ranked) return WG.toast("Ranked needs a Google or Discord account.");
    WG.renderUserPill(document.getElementById("user-pill"));
    const clue = await WG.chooseMode({ title: "Ranked match", subtitle: "Pick a clue type." });
    if (!clue) return;
    const tier = await WG.chooseTier({ title: "Ranked match", subtitle: "Each clue × tier is its own rating ladder." });
    if (!tier) return;
    WG.emit("queue:join", { ranked: true, clue, tier });
    setQueueUi(true, `Finding a ranked ${WG.tierLabel(tier)} · ${WG.modeLabel(clue)} match`);
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
  let boardClue = "image";
  let boardTier = "party";
  function wireTabs(sel, onPick) {
    document.querySelectorAll(`${sel} .board-tab`).forEach((tab) =>
      tab.addEventListener("click", () => {
        document.querySelectorAll(`${sel} .board-tab`).forEach((t) => t.classList.toggle("active", t === tab));
        onPick(tab);
        loadLeaderboard();
      })
    );
  }
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
