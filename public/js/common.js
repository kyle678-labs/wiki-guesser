/* Shared client helpers used by both the lobby and the game screen. */
const WG = (() => {
  let config = null;
  let socket = null;
  const listeners = {}; // event -> [fn]

  async function loadConfig() {
    const res = await fetch("/api/config", { credentials: "same-origin" });
    config = await res.json();
    return config;
  }

  function getConfig() { return config; }
  function getUser() { return config && config.user; }

  // ── Socket (singleton) ─────────────────────────────────────────────────────
  function connect() {
    if (socket) return socket;
    socket = io({ withCredentials: true });
    // Re-dispatch to any handlers registered via WG.on before/after connect.
    socket.onAny((event, ...args) => {
      (listeners[event] || []).forEach((fn) => fn(...args));
    });
    return socket;
  }

  function on(event, fn) {
    (listeners[event] = listeners[event] || []).push(fn);
  }
  function emit(...args) {
    connect().emit(...args);
  }

  // Reconnect the socket so it re-reads the session (after login/guest/logout).
  function reconnect() {
    if (!socket) return connect();
    socket.disconnect();
    socket.connect();
    return socket;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  async function guestLogin(name) {
    const res = await fetch("/auth/guest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (config) config.user = data.user;
    return data.user;
  }

  async function logout() {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    if (config) config.user = null;
  }

  // ── Auth modal ───────────────────────────────────────────────────────────────
  function showAuthModal({ rankedRequired = false } = {}) {
    return new Promise((resolve) => {
      const providers = (config && config.providers) || {};
      const back = document.createElement("div");
      back.className = "modal-backdrop";
      back.innerHTML = `
        <div class="card modal">
          <h2>Jump in</h2>
          <p class="muted">${rankedRequired
            ? "Ranked matches need an account so your rating sticks."
            : "Sign in to climb the ranked ladder, or play as a guest."}</p>
          <div class="auth-btns">
            ${providers.google ? `<button class="btn-oauth btn-google" data-go="/auth/google">Continue with Google</button>` : ""}
            ${providers.discord ? `<button class="btn-oauth btn-discord" data-go="/auth/discord">Continue with Discord</button>` : ""}
            ${(!providers.google && !providers.discord)
              ? `<p class="hint">OAuth isn't configured yet — set GOOGLE_/DISCORD_ keys in .env to enable ranked accounts.</p>` : ""}
          </div>
          ${rankedRequired ? "" : `
            <div class="divider">or play as a guest</div>
            <div class="share-row">
              <input id="guest-name" type="text" maxlength="20" placeholder="Pick a display name" />
              <button class="primary" id="guest-go">Go</button>
            </div>
            <p class="hint">Guests can play private rooms &amp; casual matches, but not ranked.</p>
          `}
          <p class="hint" style="margin-top:0.9rem">By playing you agree to our
            <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and
            <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>
          <button class="ghost small" id="auth-cancel" style="margin-top:1rem">Cancel</button>
        </div>`;
      document.body.appendChild(back);

      back.querySelectorAll("[data-go]").forEach((b) =>
        b.addEventListener("click", () => (window.location = b.dataset.go))
      );
      const close = (val) => { back.remove(); resolve(val); };
      back.querySelector("#auth-cancel").addEventListener("click", () => close(null));
      back.addEventListener("click", (e) => { if (e.target === back) close(null); });

      const guestGo = back.querySelector("#guest-go");
      if (guestGo) {
        const doGuest = async () => {
          const name = back.querySelector("#guest-name").value.trim();
          const user = await guestLogin(name || "Guest");
          reconnect();
          close(user);
        };
        guestGo.addEventListener("click", doGuest);
        back.querySelector("#guest-name").addEventListener("keydown", (e) => { if (e.key === "Enter") doGuest(); });
        setTimeout(() => back.querySelector("#guest-name").focus(), 50);
      }
    });
  }

  // Ensure we have an identity; prompt if not. Returns the user or null.
  async function ensureUser(opts = {}) {
    if (getUser()) return getUser();
    return showAuthModal(opts);
  }

  // ── UI bits ────────────────────────────────────────────────────────────────
  const MODE_LABELS = { image: "Pictures", text: "Descriptions", mixed: "Combined" };
  const MODE_SHORT = { image: "IMG", text: "TXT", mixed: "MIX" };
  function modeLabel(m) {
    return (getConfig() && getConfig().modeLabels && getConfig().modeLabels[m]) || MODE_LABELS[m] || m;
  }

  const TIER_LABELS = { party: "Party mix", chaos: "Total chaos" };
  function tierLabel(t) {
    return (getConfig() && getConfig().tierLabels && getConfig().tierLabels[t]) || TIER_LABELS[t] || t;
  }

  // A ranked ladder key is "clue:tier" — e.g. "image:chaos" → "Pictures · Total chaos".
  function ladderLabel(key) {
    const [clue, tier] = String(key || "").split(":");
    return `${modeLabel(clue)} · ${tierLabel(tier)}`;
  }

  function renderUserPill(el) {
    const u = getUser();
    if (!u) {
      el.innerHTML = `<button class="primary small" id="pill-signin">Sign in / Play</button>`;
      el.querySelector("#pill-signin").addEventListener("click", async () => {
        await showAuthModal();
        if (getUser()) renderUserPill(el);
      });
      return;
    }
    let rank;
    if (u.ranked && u.ratings) {
      // Up to 9 ladders is too many for the pill — headline the best-rated one
      // the player has actually played; full detail lives on the leaderboard.
      const played = Object.entries(u.ratings).filter(([, r]) => r.gamesPlayed > 0);
      if (played.length) {
        const [key, r] = played.sort((a, b) => b[1].rating - a[1].rating)[0];
        rank = `<span class="pill pill-ratings" title="Top ladder: ${escapeHtml(ladderLabel(key))} — ${escapeHtml(r.tier)} ${r.rating}">${r.tierIcon || "🏅"} ${r.rating}</span>`;
      } else {
        rank = `<span class="pill">Ranked</span>`;
      }
    } else {
      rank = `<span class="pill">Guest</span>`;
    }
    el.innerHTML = `
      ${rank}
      <span class="pill">${avatarHtml(u.name, u.avatar, "sm")} ${escapeHtml(u.name)}</span>
      <button class="ghost small" id="pill-logout">Log out</button>`;
    el.querySelector("#pill-logout").addEventListener("click", async () => {
      await logout();
      reconnect();
      renderUserPill(el);
      toast("Logged out");
    });
  }

  // Modal that makes the player pick one of the three modes. Resolves the chosen
  // mode key, or null if cancelled.
  function chooseMode({ title = "Choose a mode", subtitle = "" } = {}) {
    return new Promise((resolve) => {
      const modes = (getConfig() && getConfig().modes) || ["image", "text", "mixed"];
      const blurb = {
        image: "Guess from the article's picture.",
        text: "Guess from the article's description, with the name blanked out.",
        mixed: "Each round is randomly a picture or a description.",
      };
      const back = document.createElement("div");
      back.className = "modal-backdrop";
      back.innerHTML = `
        <div class="card modal">
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ""}
          <div class="mode-choice">
            ${modes
              .map(
                (m) => `<button class="mode-opt" data-mode="${m}">
                  <span class="mode-opt-name">${escapeHtml(modeLabel(m))}</span>
                  <span class="mode-opt-desc">${escapeHtml(blurb[m] || "")}</span>
                </button>`
              )
              .join("")}
          </div>
          <button class="ghost small" id="mode-cancel" style="margin-top:0.8rem">Cancel</button>
        </div>`;
      document.body.appendChild(back);
      const close = (val) => { back.remove(); resolve(val); };
      back.querySelectorAll("[data-mode]").forEach((b) =>
        b.addEventListener("click", () => close(b.dataset.mode))
      );
      back.querySelector("#mode-cancel").addEventListener("click", () => close(null));
      back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    });
  }

  // Modal that makes the player pick a topic tier. Resolves the chosen tier key,
  // or null if cancelled.
  function chooseTier({ title = "Choose a difficulty", subtitle = "" } = {}) {
    return new Promise((resolve) => {
      const tiers = (getConfig() && getConfig().tiers) || ["party", "chaos"];
      const blurb = {
        party: "Well-known topics — the easiest.",
        chaos: "A broader mix, but still guessable.",
      };
      const back = document.createElement("div");
      back.className = "modal-backdrop";
      back.innerHTML = `
        <div class="card modal">
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ""}
          <div class="mode-choice">
            ${tiers
              .map(
                (t) => `<button class="mode-opt" data-tier="${t}">
                  <span class="mode-opt-name">${escapeHtml(tierLabel(t))}</span>
                  <span class="mode-opt-desc">${escapeHtml(blurb[t] || "")}</span>
                </button>`
              )
              .join("")}
          </div>
          <button class="ghost small" id="tier-cancel" style="margin-top:0.8rem">Cancel</button>
        </div>`;
      document.body.appendChild(back);
      const close = (val) => { back.remove(); resolve(val); };
      back.querySelectorAll("[data-tier]").forEach((b) =>
        b.addEventListener("click", () => close(b.dataset.tier))
      );
      back.querySelector("#tier-cancel").addEventListener("click", () => close(null));
      back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    });
  }

  function injectAds() {
    const ads = config && config.adsense;
    document.querySelectorAll(".ad-slot").forEach((slot) => {
      if (!ads) { slot.classList.add("hidden"); return; }
      slot.innerHTML = `
        <ins class="adsbygoogle" style="display:block;width:100%"
             data-ad-client="${ads.client}" data-ad-slot="${ads.slot}"
             data-ad-format="auto" data-full-width-responsive="true"></ins>`;
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
    });
    if (ads && !document.getElementById("adsense-lib")) {
      const s = document.createElement("script");
      s.id = "adsense-lib";
      s.async = true;
      s.crossOrigin = "anonymous";
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ads.client}`;
      document.head.appendChild(s);
    }
  }

  // ── Theme (light/dark) ───────────────────────────────────────────────────────
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("wg-theme", theme); } catch (e) {}
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.textContent = theme === "dark" ? "Light" : "Dark";
      b.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    });
  }
  function initTheme() {
    applyTheme(currentTheme());
    document.querySelectorAll("[data-theme-toggle]").forEach((b) =>
      b.addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark"))
    );
  }

  let toastTimer;
  function toast(msg) {
    let t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Avatar: the OAuth image if present, otherwise a plain initial monogram.
  function avatarHtml(name, url, cls = "") {
    if (url) return `<img class="avatar ${cls}" src="${escapeHtml(url)}" alt="">`;
    const initial = (String(name || "?").trim()[0] || "?").toUpperCase();
    return `<span class="avatar mono ${cls}">${escapeHtml(initial)}</span>`;
  }

  return {
    loadConfig, getConfig, getUser, connect, on, emit, reconnect,
    guestLogin, logout, showAuthModal, ensureUser, renderUserPill,
    injectAds, toast, escapeHtml, avatarHtml, initTheme, chooseMode, modeLabel,
    chooseTier, tierLabel, ladderLabel,
  };
})();
