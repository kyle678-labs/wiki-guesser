/* Shared client helpers used by both the lobby and the game screen. */
const WG = (() => {
  let config = null;
  let socket = null;
  const listeners = {}; // event -> [fn]

  async function loadConfig() {
    const res = await fetch("/api/config", { credentials: "same-origin" });
    config = await res.json();
    // Notices are rendered as a side effect of loading config, which is not the
    // tidiest thing in this file but is the right trade: every page on the site
    // already awaits loadConfig, so hanging the render here means a NEW page
    // gets notices for free instead of by somebody remembering to call
    // something. Cheap and idempotent — it does nothing when nothing is pinned.
    try { renderNotices(); } catch (e) { console.error("notices failed to render", e); }
    return config;
  }

  // ── Site notices ────────────────────────────────────────────────────────────
  // Whatever an operator has pinned from /admin, as dismissible cards in the
  // corner. Dismissal is per browser and per notice, held in localStorage: there
  // is no account requirement to read one, so there is nowhere else to put it.
  const DISMISSED_KEY = "wg-dismissed-notices";

  function readDismissed() {
    try {
      const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((n) => Number.isInteger(n)) : [];
    } catch { return []; }
  }

  function writeDismissed(ids) {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids)); } catch (e) {}
  }

  function renderNotices() {
    const all = (config && config.notices) || [];
    document.getElementById("wg-notices")?.remove();
    if (!all.length) {
      // Nothing pinned any more, so the dismissal list has nothing left to
      // suppress. Clearing it stops the key growing without bound across the
      // life of a browser profile.
      if (readDismissed().length) writeDismissed([]);
      return;
    }

    // Ids that no longer exist are dropped on every render, so this stays the
    // size of what is actually pinned rather than a running log.
    const live = all.map((n) => n.id);
    const dismissed = readDismissed().filter((id) => live.includes(id));
    writeDismissed(dismissed);

    const showing = all.filter((n) => !dismissed.includes(n.id));
    if (!showing.length) return;

    const box = document.createElement("div");
    box.id = "wg-notices";
    box.className = "notice-stack";
    // role="status" rather than "alert": these are announcements, not errors,
    // and an alert interrupts a screen reader mid-sentence.
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    box.innerHTML = showing
      .map(
        (n) => `<div class="notice notice-${n.level === "warn" ? "warn" : "info"}" data-notice="${n.id}">
          <p>${escapeHtml(n.message)}</p>
          <button class="notice-x" aria-label="Dismiss this notice">&times;</button>
        </div>`
      )
      .join("");

    box.addEventListener("click", (e) => {
      const btn = e.target.closest(".notice-x");
      if (!btn) return;
      const card = btn.closest(".notice");
      const id = parseInt(card.dataset.notice, 10);
      writeDismissed([...readDismissed(), id]);
      card.remove();
      if (!box.querySelector(".notice")) box.remove();
    });

    document.body.appendChild(box);
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

  // ── Chat preference ──────────────────────────────────────────────────────────
  // The source of truth is the server (the account row, or the guest's session),
  // so muting chat follows the player to their next device and their next game
  // rather than living in one browser. localStorage is only a mirror, so the
  // page can render the right thing before /api/config has come back instead of
  // flashing chat that the player has switched off.
  const CHAT_KEY = "wg-chat";

  function chatEnabled() {
    const u = getUser();
    if (u && typeof u.chatEnabled === "boolean") return u.chatEnabled;
    try { return localStorage.getItem(CHAT_KEY) !== "off"; } catch (e) { return true; }
  }

  async function setChatEnabled(enabled) {
    try { localStorage.setItem(CHAT_KEY, enabled ? "on" : "off"); } catch (e) {}
    if (config && config.user) config.user.chatEnabled = enabled;
    // Take effect on the open connection first. The server drops muted sockets
    // out of the room's chat fan-out, so messages stop ARRIVING rather than just
    // being hidden — which is what someone muting to escape harassment expects.
    try { emit("chat:mute", { enabled }); } catch (e) {}
    try {
      const res = await fetch("/api/settings/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`chat pref ${res.status}`);
    } catch (e) {
      // The local mirror already applied, so the setting works for this session
      // either way — but say so rather than implying it was saved.
      console.error("couldn't save chat preference", e);
      toast("Saved here, but we couldn't store that preference on your account.");
    }
    return enabled;
  }

  // ── Auth modal ───────────────────────────────────────────────────────────────
  function showAuthModal({ rankedRequired = false } = {}) {
    return new Promise((resolve) => {
      const providers = (config && config.providers) || {};
      // No provider configured means nobody can sign in at all. That is an
      // operator state, and a player is owed what it means for them — not the
      // name of an environment variable they cannot set. Whatever this renders,
      // it must never be a dead end: with `rankedRequired` the guest form is
      // deliberately absent, so if there is also nothing to sign in with, the
      // copy has to point at what still works.
      const canSignIn = Boolean(providers.google || providers.discord);
      const subtitle = rankedRequired
        ? canSignIn
          ? "Ranked matches need an account so your rating sticks."
          : "Ranked sign-in is unavailable right now, so ranked matches can't be started."
        : canSignIn
          ? "Sign in to climb the ranked ladder, or play as a guest."
          : "Pick a display name and jump straight in.";
      const back = document.createElement("div");
      back.className = "modal-backdrop";
      back.innerHTML = `
        <div class="card modal">
          <h2>Jump in</h2>
          <p class="muted">${subtitle}</p>
          <div class="auth-btns">
            ${providers.google ? `<button class="btn-oauth btn-google" data-go="/auth/google">Continue with Google</button>` : ""}
            ${providers.discord ? `<button class="btn-oauth btn-discord" data-go="/auth/discord">Continue with Discord</button>` : ""}
            ${!canSignIn && rankedRequired
              ? `<p class="hint">Casual quick match and private rooms are still open to guests — close this and pick one of those.</p>` : ""}
          </div>
          ${rankedRequired ? "" : `
            ${canSignIn ? `<div class="divider">or play as a guest</div>` : ""}
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

  // What ranked will actually accept. The server decides this (see
  // server/ladders.js) and serves it on /api/config; the fallbacks only cover a
  // page loaded against an older server, and match what that server enforced.
  function rankedConfig() {
    const r = (getConfig() && getConfig().ranked) || {};
    const tiers = r.tiers && r.tiers.length ? r.tiers : ["chaos"];
    return {
      modes: r.modes && r.modes.length ? r.modes : ["image", "text"],
      tiers,
      defaultTier: r.defaultTier || tiers[0],
    };
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
      <h3 class="profile-section">Preferences</h3>
      <div class="share-row">
        <span class="hint" style="flex:1">Show chat in games</span>
        <button class="ghost small" id="p-chat">${chatEnabled() ? "On" : "Off"}</button>
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

    const chatBtn = modal.querySelector("#p-chat");
    chatBtn.addEventListener("click", async () => {
      chatBtn.disabled = true;
      const next = await setChatEnabled(!chatEnabled());
      chatBtn.textContent = next ? "On" : "Off";
      chatBtn.disabled = false;
    });

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
        ${avatarHtml(u.name, u.avatar, "sm")} <span class="pill-name">${escapeHtml(u.name)}</span></button>
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
  // `only` restricts the offered set — ranked accepts fewer clue types than
  // casual does, and the list comes from /api/config rather than being written
  // out here, so the picker cannot offer something the queue will refuse.
  function chooseMode({ title = "Choose a mode", subtitle = "", only = null } = {}) {
    return new Promise((resolve) => {
      const modes = only || (getConfig() && getConfig().modes) || ["image", "text", "mixed"];
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

  // ── Daily scores ─────────────────────────────────────────────────────────────
  // Two kinds of score across the three puzzles: a count of guesses, and a solve
  // time in milliseconds. Which one a game uses comes from the server (`format`
  // on every daily response), so this never has to guess from the number — and
  // adding a fourth game does not mean teaching the client about it.

  // m:ss, and h:mm:ss only once there is an hour to show. Seconds are padded so
  // a column of times stays aligned; the leading unit never is, because "01:23"
  // reads like a stopwatch nobody asked for.
  function formatTime(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // A score as a player should read it. `spec` is any daily response — it needs
  // `format`, and `unit`/`unitOne` when that format is a count.
  function formatScore(score, spec) {
    if (score == null) return "";
    if (spec && spec.format === "time") return formatTime(score);
    const unit = score === 1 ? (spec && spec.unitOne) || "" : (spec && spec.unit) || "";
    return unit ? `${score} ${unit}` : String(score);
  }

  // What to head the score column with.
  const scoreHeading = (spec) =>
    spec && spec.format === "time" ? "Time" : ((spec && spec.unit) || "Score").replace(/^./, (c) => c.toUpperCase());

  // ── Daily strip ──────────────────────────────────────────────────────────────
  // The three daily puzzles across the top of each of their pages: which ones
  // are today's, which you have already done, and what you scored. Driven off
  // /api/daily rather than hardcoded, so adding a fourth game is a change in
  // server/dailies.js and nowhere else — including here.
  //
  // Rendered async and quietly: it is navigation, not the game, so a page whose
  // strip fails to load is still perfectly playable.
  async function renderDailyStrip(el, currentId) {
    if (!el) return;
    let data;
    try {
      const res = await fetch("/api/daily", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`daily hub ${res.status}`);
      data = await res.json();
    } catch (e) {
      console.error("daily strip failed to load", e);
      el.innerHTML = "";
      return;
    }

    el.innerHTML = data.games
      .map((g) => {
        const state = !g.available
          ? `<span class="daily-tab-state muted">unavailable</span>`
          : g.played
            ? `<span class="daily-tab-state done">✓ ${escapeHtml(formatScore(g.score, g))}</span>`
            : `<span class="daily-tab-state">not played</span>`;
        const body = `<span class="daily-tab-name">${escapeHtml(g.name)}</span>${state}`;
        // The page you are on is not a link to itself, and a game with no
        // puzzle today is not a link at all — both would be dead clicks.
        return g.id === currentId || !g.available
          ? `<span class="daily-tab${g.id === currentId ? " current" : ""}">${body}</span>`
          : `<a class="daily-tab" href="${g.path}">${body}</a>`;
      })
      .join("");
  }

  // How long until the puzzles flip. Driven off the server's own figure rather
  // than the browser's clock, so a machine with the wrong time still counts down
  // to the right moment. One timer per element — restarting replaces it rather
  // than stacking a second one on top.
  const countdowns = new WeakMap();
  function startDailyCountdown(el, { day, resetInMs }) {
    if (!el) return;
    clearInterval(countdowns.get(el));
    const endsAt = Date.now() + resetInMs;
    const tick = () => {
      const left = Math.max(0, endsAt - Date.now());
      const h = Math.floor(left / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      const s = Math.floor((left % 60000) / 1000);
      el.textContent = `Puzzle for ${day} · next one in ${h}h ${m}m ${s}s`;
      if (left <= 0) {
        clearInterval(countdowns.get(el));
        el.textContent = "A new puzzle is ready — reload to play it.";
      }
    };
    tick();
    countdowns.set(el, setInterval(tick, 1000));
  }

  // Today's board for one daily game. The score column is labelled and rendered
  // from the format the server reports, because 12 guesses and 12 seconds are
  // different things and only the server knows which game this is.
  async function loadDailyBoard(game, { body, me, head } = {}) {
    if (!body) return;
    try {
      const res = await fetch(`/api/daily/${game}/leaderboard`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`board ${res.status}`);
      const data = await res.json();

      if (head) head.textContent = scoreHeading(data);
      body.innerHTML = data.leaderboard.length
        ? data.leaderboard
            .map(
              (r) => `<tr><td>${r.rank}</td><td>${escapeHtml(r.name)}</td>
                <td>${escapeHtml(formatScore(r.score, data))}</td></tr>`
            )
            .join("")
        : `<tr><td colspan="3" class="muted">Nobody has solved it yet today — go first.</td></tr>`;
      if (me) me.textContent = data.me ? `You: #${data.me.rank} with ${formatScore(data.me.score, data)}.` : "";
    } catch (e) {
      console.error("daily board failed to load", e);
      body.innerHTML = `<tr><td colspan="3" class="muted">Couldn't load the board.</td></tr>`;
    }
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
    renderDailyStrip, startDailyCountdown, loadDailyBoard, formatTime, formatScore,
    chooseTier, tierLabel, ladderLabel, chatEnabled, setChatEnabled, rankedConfig,
  };
})();
