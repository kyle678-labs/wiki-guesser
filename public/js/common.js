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
    // connect_error is a reserved event, so onAny never sees it. The server
    // refuses a handshake when an identity already holds too many connections;
    // without this the tab would just sit there looking broken.
    socket.on("connect_error", (err) => {
      if (socket.active) return; // transient — the client is already retrying
      toast(err.message || "Couldn't connect — please reload.");
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

  // ── Profile ──────────────────────────────────────────────────────────────────
  // Short date for the match list — the year only when it isn't this one, so the
  // common case stays compact.
  function shortDate(ms) {
    const d = new Date(ms);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  const RESULT_LABEL = { win: "W", loss: "L", draw: "D" };

  function renderMatches(matches) {
    if (!matches.length) {
      return `<p class="hint">No ranked games yet. Casual and private games aren't recorded —
        only ranked matches count towards a ladder.</p>`;
    }
    return matches
      .map((m) => {
        const delta = m.delta >= 0 ? `+${m.delta}` : `${m.delta}`;
        return `<div class="result-item">
          <div class="pts result-${m.result}">${RESULT_LABEL[m.result] || "?"}</div>
          <div class="meta">
            <div>vs ${avatarHtml(m.opponent, m.opponentAvatar, "sm")} ${escapeHtml(m.opponent)}</div>
            <div class="credit">${escapeHtml(ladderLabel(m.mode))} · ${escapeHtml(shortDate(m.at))}</div>
          </div>
          <div class="meta profile-figures">
            <div class="score">${m.myScore}–${m.theirScore}</div>
            <div class="credit">
              <span class="${m.delta >= 0 ? "delta-up" : "delta-down"}">${delta}</span>
              <span class="muted">→ ${m.ratingAfter}</span>
            </div>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderLadders(user) {
    const played = Object.entries((user && user.ratings) || {}).filter(([, r]) => r.gamesPlayed > 0);
    if (!played.length) return `<p class="hint">You haven't played a ranked match yet.</p>`;
    return `<div class="profile-ladders">${played
      .sort((a, b) => b[1].rating - a[1].rating)
      .map(
        ([key, r]) => `<div class="profile-ladder">
          <div class="profile-ladder-name">${escapeHtml(ladderLabel(key))}</div>
          <div class="profile-ladder-rating">${r.tierIcon || "🏅"} ${r.rating}
            <span class="muted">${escapeHtml(r.tier)}</span></div>
          <div class="credit">${r.wins}W · ${r.losses}L · ${r.draws}D</div>
        </div>`
      )
      .join("")}</div>`;
  }

  // Your record and your last games, plus the self-service erasure the privacy
  // policy promises. Fetches fresh rather than reusing the cached /api/config
  // identity, so ratings reflect games played since the page loaded.
  async function showProfile() {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="card modal profile-modal"><p class="muted">Loading your profile…</p></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener("click", (e) => { if (e.target === back) close(); });

    let data;
    try {
      const res = await fetch("/api/profile", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`profile ${res.status}`);
      data = await res.json();
    } catch (e) {
      console.error("profile failed to load", e);
      back.querySelector(".modal").innerHTML =
        `<p class="muted">Couldn't load your profile — try again in a moment.</p>
         <button class="ghost small" id="p-close" style="margin-top:1rem">Close</button>`;
      back.querySelector("#p-close").addEventListener("click", close);
      return;
    }

    const u = data.user;
    const modal = back.querySelector(".modal");
    modal.innerHTML = `
      <div class="profile-head">
        ${avatarHtml(u.name, u.avatar)}
        <div>
          <h2>${escapeHtml(u.name)}</h2>
          <p class="hint">${data.guest ? "Guest — no account is stored for you." : "Signed-in account"}</p>
        </div>
      </div>
      ${data.guest ? "" : `
        <h3 class="profile-section">Your ladders</h3>
        ${renderLadders(u)}
        <h3 class="profile-section">Last ${data.matches.length || ""} ranked game${data.matches.length === 1 ? "" : "s"}</h3>
        <div class="profile-matches">${renderMatches(data.matches)}</div>
        <h3 class="profile-section danger">Delete account</h3>
        <p class="hint">Permanently erases your profile, every ladder rating, and your match
          history. This is immediate and cannot be undone.</p>
        <div id="danger-zone"><button class="ghost small red" id="p-delete">Delete my account</button></div>
      `}
      <button class="ghost small" id="p-close" style="margin-top:1.2rem">Close</button>`;
    modal.querySelector("#p-close").addEventListener("click", close);

    // Two steps, because the first click of an irreversible thing should never
    // be the last one. Both states render into the same slot.
    const zone = modal.querySelector("#danger-zone");
    if (zone) {
      const armed = () => {
        zone.innerHTML = `
          <p class="hint red"><strong>Are you sure?</strong> Your rating, rank and history are gone
            for good. Deleting also removes these matches from your opponents' histories.</p>
          <div class="share-row">
            <button class="ghost small" id="p-cancel">Keep my account</button>
            <button class="small red-btn" id="p-confirm">Yes, delete everything</button>
          </div>`;
        zone.querySelector("#p-cancel").addEventListener("click", idle);
        zone.querySelector("#p-confirm").addEventListener("click", doDelete);
      };
      const idle = () => {
        zone.innerHTML = `<button class="ghost small red" id="p-delete">Delete my account</button>`;
        zone.querySelector("#p-delete").addEventListener("click", armed);
      };
      const doDelete = async () => {
        const btn = zone.querySelector("#p-confirm");
        btn.disabled = true;
        btn.textContent = "Deleting…";
        try {
          const res = await fetch("/api/account/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ confirm: "DELETE" }),
          });
          if (!res.ok) throw new Error(`delete ${res.status}`);
        } catch (e) {
          console.error("account deletion failed", e);
          btn.disabled = false;
          btn.textContent = "Yes, delete everything";
          return toast("Couldn't delete your account — please try again.");
        }
        // The session is gone server-side; drop the local view of it and land
        // the player somewhere that doesn't assume they're signed in.
        if (config) config.user = null;
        close();
        toast("Your account and all its data have been deleted.");
        setTimeout(() => (window.location = "/"), 1200);
      };
      idle();
    }
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
      <button class="pill pill-profile" id="pill-profile" title="Your profile, history and account settings">
        ${avatarHtml(u.name, u.avatar, "sm")} ${escapeHtml(u.name)}</button>
      <button class="ghost small" id="pill-logout">Log out</button>`;
    el.querySelector("#pill-profile").addEventListener("click", () => showProfile());
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
    guestLogin, logout, showAuthModal, ensureUser, renderUserPill, showProfile,
    injectAds, toast, escapeHtml, avatarHtml, initTheme, chooseMode, modeLabel,
    chooseTier, tierLabel, ladderLabel,
  };
})();
