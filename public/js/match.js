/* Wikimatch — the daily picture matchup.
 *
 * Nine pictures arrive in one order and nine titles in another, with nothing
 * joining them: which belongs to which is the answer, and it stays on the
 * server. This page can only ask "swap these two", and the server is the thing
 * that notices when the arrangement is finally right.
 *
 * As on the tile page, swaps are applied locally first so the board responds at
 * once, then reconciled with the server's own count.
 */
(async function () {
  const $ = (id) => document.getElementById(id);

  WG.initTheme();
  await WG.loadConfig();
  WG.injectAds();
  WG.renderUserPill($("user-pill"));

  // The daily needs an identity for the same reason the board does: one entry
  // per player per day has to be attributable to someone. Guests count.
  let user = WG.getUser();
  if (!user) {
    user = await WG.showAuthModal();
    if (!user) { window.location = "/"; return; }
    WG.renderUserPill($("user-pill"));
  }

  WG.renderDailyStrip($("daily-strip"), "match");

  const gridEl = $("match-grid");

  let state = null;
  let picked = null; // the slot whose caption is waiting for a partner

  // ── Rendering ───────────────────────────────────────────────────────────────
  // Pictures are laid out once and never move; only the captions under them
  // change hands. Swapping the pictures instead would be the same game, but it
  // would also mean the thing you are reading jumps around while you think.
  function build() {
    gridEl.innerHTML = state.images
      .map(
        (src, slot) => `
        <figure class="match-cell" data-slot="${slot}">
          <div class="match-photo"><img src="${WG.escapeHtml(src)}" alt="Picture ${slot + 1}" loading="lazy" /></div>
          <figcaption><button type="button" class="match-title" data-slot="${slot}"></button></figcaption>
        </figure>`
      )
      .join("");
  }

  function paint() {
    gridEl.querySelectorAll(".match-cell").forEach((cell) => {
      const slot = Number(cell.dataset.slot);
      const title = state.titles[state.assign[slot]];
      const caption = cell.querySelector("figcaption");

      // Solved, and only then, each caption stops being a control and becomes a
      // link to the article it turned out to belong to.
      if (state.done && state.urls) {
        caption.innerHTML = `<a class="match-title solved" href="${state.urls[state.assign[slot]]}"
          target="_blank" rel="noopener">${WG.escapeHtml(title)}</a>`;
        return;
      }

      const btn = caption.querySelector("button.match-title");
      btn.textContent = title;
      btn.classList.toggle("picked", picked === slot);
      btn.setAttribute("aria-pressed", picked === slot ? "true" : "false");
    });
  }

  // ── The clock ───────────────────────────────────────────────────────────────
  // Display only. The score is the server's own measurement, sent back on every
  // response; this ticks between them so the number on screen moves, and is
  // re-seeded from the server each time one arrives rather than counting up
  // independently and drifting away from what will actually be recorded.
  let clockBase = 0;
  let clockFrom = 0;
  let clockTimer = null;

  const elapsedNow = () => (state.done ? state.score : clockBase + (Date.now() - clockFrom));

  function syncClock() {
    clearInterval(clockTimer);
    clockBase = state.elapsedMs || 0;
    clockFrom = Date.now();
    if (!state.done) clockTimer = setInterval(renderStatus, 1000);
  }

  function renderStatus() {
    $("match-status").textContent = state.done
      ? ""
      : `${WG.formatTime(elapsedNow())} · ${state.moves} swap${state.moves === 1 ? "" : "s"} · par ${state.par}`;
  }

  function renderResult() {
    const el = $("match-result");
    if (!state.done) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");

    // The board ranks on the clock, but the swap count is still the interesting
    // half of how you did — so it stays, next to par.
    const swaps = `${state.moves} swap${state.moves === 1 ? "" : "s"}`;
    const verdict = state.moves === state.par ? `${swaps} — you hit par.` : `${swaps}, par ${state.par}.`;
    el.innerHTML = `<h3 class="daily-win">All nine, in ${WG.formatTime(state.score)}.</h3>
       <p class="muted">${verdict} Every caption is a link now — go and read one.</p>
       <button class="ghost small" id="match-share">Copy result</button>`;

    $("match-share").addEventListener("click", async () => {
      // Deliberately no titles — a result you can post the moment you solve it
      // without spoiling the day for whoever reads it.
      const text = `Wikimatch ${state.day} — ${WG.formatTime(state.score)} (${swaps}, par ${state.par})\n${location.origin}/match`;
      try {
        await navigator.clipboard.writeText(text);
        WG.toast("Result copied!");
      } catch { WG.toast("Couldn't copy — long-press to select."); }
    });
  }

  function render() {
    paint();
    renderStatus();
    renderResult();
  }

  const loadBoard = () =>
    WG.loadDailyBoard("match", { body: $("match-leaderboard"), me: $("match-me"), head: $("match-unit") });

  function apply(next) {
    state = next;
    picked = null;
    syncClock();
    render();
    WG.startDailyCountdown($("daily-reset"), state);
    if (state.done) loadBoard();
  }

  // ── Swaps ───────────────────────────────────────────────────────────────────
  // One request per swap, in order: sending them concurrently would let two
  // arrive reversed, and the server applies what it receives.
  const pending = [];
  let sending = false;

  async function drain() {
    if (sending) return;
    sending = true;
    while (pending.length) {
      const swap = pending.shift();
      let res, data;
      try {
        res = await fetch("/api/daily/match/swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(swap),
        });
        data = await res.json();
      } catch (e) {
        console.error("swap failed", e);
        WG.toast("Couldn't send that swap — check your connection.");
        pending.length = 0;
        sending = false;
        return resync();
      }
      if (!res.ok) {
        // 409 carries the finished state with it, so a second tab that has
        // fallen behind catches up rather than just showing an error.
        pending.length = 0;
        sending = false;
        if (data && data.done) return apply(data);
        WG.toast(data.error || "That swap didn't go through.");
        return resync();
      }
      // Only once we are level: while swaps are still queued the server is
      // deliberately behind this page, and overwriting would undo them.
      if (!pending.length) apply(data);
    }
    sending = false;
  }

  async function resync() {
    try {
      const res = await fetch("/api/daily/match", { credentials: "same-origin" });
      if (res.ok) apply(await res.json());
    } catch (e) {
      console.error("resync failed", e);
    }
  }

  function swap(a, b) {
    if (!state || state.done) return;
    [state.assign[a], state.assign[b]] = [state.assign[b], state.assign[a]];
    state.moves += 1;
    picked = null;
    render();
    pending.push({ a, b });
    drain();
  }

  // Pick one caption, then another. Deliberately not a drag: it is the same
  // gesture with a mouse, a finger and a keyboard, and these captions are long
  // enough that dragging them around a phone screen would be a fight.
  gridEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".match-title");
    if (!btn || !state || state.done) return;
    const slot = Number(btn.dataset.slot);
    if (picked === null) {
      picked = slot;
      paint();
    } else if (picked === slot) {
      picked = null; // changed their mind — costs nothing, because nothing moved
      paint();
    } else {
      swap(picked, slot);
    }
  });

  // ── Boot ────────────────────────────────────────────────────────────────────

  const res = await fetch("/api/daily/match", { credentials: "same-origin" });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    $("match-status").textContent = error || "Today's puzzle isn't available.";
    return;
  }
  state = await res.json();
  build();
  apply(state);
  loadBoard();
})();
