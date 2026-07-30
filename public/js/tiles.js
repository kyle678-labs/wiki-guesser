/* Wikitile — the daily picture scramble.
 *
 * The board here is a mirror, not the record. Every move is posted to the
 * server, which holds the real board and does the counting; this file applies
 * the move locally first so dragging feels immediate, then reconciles with
 * whatever comes back. The two can only disagree if a request fails, and that
 * is exactly when we throw the local copy away and re-read the server's.
 *
 * The one thing the page is genuinely not told is what the picture is. That
 * arrives with the solve.
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

  WG.renderDailyStrip($("daily-strip"), "tiles");

  const boardEl = $("tile-board");
  const image = new Image();

  let state = null;
  let cells = []; // one button per slot, created once and repainted in place

  // How many quarter turns each tile has been given, counted UP and never
  // wrapped — indexed by tile, like `rot`.
  //
  // The server stores a facing (0–3), which is the right thing to store and the
  // wrong thing to animate: the fourth tap takes a tile from 3 back to 0, and
  // CSS reads that as a three-quarter turn anticlockwise. The tile visibly
  // unwinds instead of completing its rotation. Rendering `turns * 90deg`
  // instead means a tap is always a quarter turn clockwise, however many taps
  // have gone before, while the two stay congruent mod 4.
  let turns = [];

  // Adopt the server's facing wherever the local count has drifted out of step
  // with it — a resync, a second tab, or a reload, where `turns` starts empty.
  // A count that still agrees mod 4 is kept, because it holds the history that
  // makes the next turn animate the right way.
  function syncTurns(rot) {
    turns = rot.map((r, tile) => (((turns[tile] % 4) + 4) % 4 === r ? turns[tile] : r));
  }

  // ── Layout ──────────────────────────────────────────────────────────────────
  // Each tile shows one sixteenth of the picture, and the sixteen have to line
  // up as if they were cut from one print. That means every tile carries the
  // WHOLE image as its background, sized identically, and slides its own window
  // over it — so the sizing is computed once from the image's real dimensions
  // rather than left to `cover` (which would fit each tile separately and cut
  // sixteen unrelated crops).
  //
  // Pixels rather than percentages: percentage background-position is relative
  // to (box − image), which is a different quantity per tile and does not
  // survive a non-square picture. Recomputed on resize.
  function frame() {
    const size = boardEl.clientWidth; // the board is square (CSS aspect-ratio)
    const tile = size / state.grid;
    if (!image.naturalWidth || !image.naturalHeight) return { tile, ready: false };
    // Cover: scale so the picture fills the square board, then centre it. A
    // portrait photo loses its top and bottom rather than being squashed.
    const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    return { tile, ready: true, w, h, ox: (size - w) / 2, oy: (size - h) / 2 };
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  function build() {
    boardEl.style.setProperty("--grid", state.grid);
    boardEl.innerHTML = "";
    cells = state.slots.map((_, slot) => {
      const el = document.createElement("button");
      el.className = "tile";
      el.dataset.slot = slot;
      el.type = "button";
      boardEl.appendChild(el);
      return el;
    });
  }

  function paint() {
    const f = frame();
    cells.forEach((el, slot) => {
      const tile = state.slots[slot];
      const row = Math.floor(tile / state.grid);
      const col = tile % state.grid;
      if (f.ready) {
        el.style.backgroundImage = `url("${image.src}")`;
        el.style.backgroundSize = `${f.w}px ${f.h}px`;
        el.style.backgroundPosition = `${f.ox - col * f.tile}px ${f.oy - row * f.tile}px`;
      }
      // Drag offset and rotation share one transform, so the drag sets only the
      // two custom properties and never has to know which way the tile faces.
      el.style.transform = `translate(var(--dx, 0px), var(--dy, 0px)) rotate(${turns[tile] * 90}deg)`;
      el.setAttribute("aria-label", `Tile ${slot + 1} of ${cells.length}`);
      el.disabled = state.done;
    });
    boardEl.classList.toggle("solved", Boolean(state.done));
  }

  function renderStatus() {
    $("tile-status").textContent = state.done
      ? ""
      : `${state.moves} move${state.moves === 1 ? "" : "s"} · par is ${state.par}`;
  }

  function renderResult() {
    const el = $("tile-result");
    if (!state.done) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");

    const answer = `<a href="${state.url}" target="_blank" rel="noopener">${WG.escapeHtml(state.answer)}</a>`;
    const verdict = state.score === state.par ? "Perfect — you hit par." : `Par was ${state.par}.`;
    el.innerHTML = `<h3 class="daily-win">Solved in ${state.score} move${state.score === 1 ? "" : "s"}.</h3>
       <p class="muted">${verdict} The picture is from ${answer}.</p>
       <button class="ghost small" id="tile-share">Copy result</button>`;

    $("tile-share").addEventListener("click", async () => {
      // Deliberately no picture and no article — a result you can post the
      // moment you solve it without spoiling the day for whoever reads it.
      const text = `Wikitile ${state.day} — ${state.score} moves (par ${state.par})\n${location.origin}/tiles`;
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
    WG.loadDailyBoard("tiles", { body: $("tile-leaderboard"), me: $("tile-me"), head: $("tile-unit") });

  function apply(next) {
    state = next;
    syncTurns(state.rot);
    render();
    WG.startDailyCountdown($("daily-reset"), state);
    if (state.done) loadBoard();
  }

  // ── Moves ───────────────────────────────────────────────────────────────────
  // Applied locally first, then sent. This is the same arithmetic the server
  // does (server/game/tiles.js) and it is duplicated on purpose: waiting for a
  // round trip before a tile turns would make the puzzle feel broken over any
  // real connection.
  function applyLocally(move) {
    if (move.type === "rotate") {
      const tile = state.slots[move.slot];
      state.rot[tile] = (state.rot[tile] + 1) % 4;
      turns[tile] += 1;
    } else {
      const { a, b } = move;
      [state.slots[a], state.slots[b]] = [state.slots[b], state.slots[a]];
    }
    state.moves += 1;
  }

  // One request per move, in order. Sending them concurrently would let two
  // swaps arrive reversed, and the server applies what it receives — so the
  // queue is what keeps the two boards the same board.
  const pending = [];
  let sending = false;

  async function drain() {
    if (sending) return;
    sending = true;
    while (pending.length) {
      const move = pending.shift();
      let res, data;
      try {
        res = await fetch("/api/daily/tiles/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(move),
        });
        data = await res.json();
      } catch (e) {
        console.error("move failed", e);
        WG.toast("Couldn't send that move — check your connection.");
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
        WG.toast(data.error || "That move didn't go through.");
        return resync();
      }
      // Only once we are level: while moves are still queued the server is
      // deliberately behind this page, and overwriting would undo them.
      if (!pending.length) apply(data);
    }
    sending = false;
  }

  async function resync() {
    try {
      const res = await fetch("/api/daily/tiles", { credentials: "same-origin" });
      if (res.ok) apply(await res.json());
    } catch (e) {
      console.error("resync failed", e);
    }
  }

  function move(m) {
    if (!state || state.done) return;
    applyLocally(m);
    render();
    pending.push(m);
    drain();
  }

  // ── Pointer ─────────────────────────────────────────────────────────────────
  // One gesture, two meanings: let go where you started and the tile turns; let
  // go on another tile and the two swap. A tap is not a tiny drag, hence the
  // threshold — a finger never holds perfectly still.
  const DRAG_SLOP = 6; // px

  let drag = null;
  let swallowClick = false;

  boardEl.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".tile");
    if (!el || !state || state.done || e.button > 0) return;
    drag = { el, slot: Number(el.dataset.slot), x: e.clientX, y: e.clientY, moved: false };
    // Capture keeps the gesture on the tile it started on once the pointer
    // leaves it. A nicety rather than a requirement — the handlers below are
    // delegated to the board and remember which tile they started on — so a
    // browser that refuses the capture is not a browser that cannot play.
    try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
  });

  boardEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    drag.moved = true;
    drag.el.classList.add("dragging");
    drag.el.style.setProperty("--dx", `${dx}px`);
    drag.el.style.setProperty("--dy", `${dy}px`);
  });

  function endDrag(e) {
    if (!drag) return;
    const { el, slot, moved } = drag;
    drag = null;

    // Find the drop target FIRST, while the tile being dragged is still marked
    // `.dragging` and therefore still transparent to hit-testing.
    //
    // Order matters more than it looks. Dropping the class restores the tile's
    // pointer-events immediately, but its transform animates back over the next
    // 120ms — so for those milliseconds it is still drawn under the pointer and
    // catches the hit test instead of the tile beneath it. That made a swap
    // silently do nothing, and only in one direction: with the lift z-index
    // gone, the two tiles stack in DOM order, so dragging a later tile onto an
    // earlier one hit itself while the reverse worked fine.
    const over = moved ? document.elementFromPoint(e.clientX, e.clientY) : null;
    const target = over && over.closest(".tile");

    el.classList.remove("dragging");
    el.style.removeProperty("--dx");
    el.style.removeProperty("--dy");
    if (!moved) return; // a tap: the click handler below turns the tile
    // A click follows a pointerup on a button, and after a drag it would turn
    // the tile the player just moved. Cleared on a timer rather than by the
    // click handler itself: where a drag ends on a different element the click
    // may be dispatched on the board instead of on a tile, or not at all, and a
    // flag left standing would swallow the next honest tap.
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    // Dropped on nothing? The tile springs back on its own — the drag offset
    // lives in the two custom properties just removed.
    if (target && Number(target.dataset.slot) !== slot) move({ type: "swap", a: slot, b: Number(target.dataset.slot) });
  }

  boardEl.addEventListener("pointerup", endDrag);
  boardEl.addEventListener("pointercancel", endDrag);

  // Click rather than pointerup, so Enter and Space on a focused tile turn it
  // too — the gesture and the keyboard end up on one path.
  boardEl.addEventListener("click", (e) => {
    if (swallowClick) return;
    const el = e.target.closest(".tile");
    if (!el) return;
    move({ type: "rotate", slot: Number(el.dataset.slot) });
  });

  // Arrow keys swap the focused tile with its neighbour, and focus follows it.
  // Adjacent swaps reach every arrangement, so the whole puzzle is playable
  // without a pointer at all.
  const STEP = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  boardEl.addEventListener("keydown", (e) => {
    const step = STEP[e.key];
    const el = e.target.closest(".tile");
    if (!step || !el || !state || state.done) return;
    const slot = Number(el.dataset.slot);
    const col = (slot % state.grid) + step[0];
    const row = Math.floor(slot / state.grid) + step[1];
    if (col < 0 || col >= state.grid || row < 0 || row >= state.grid) return;
    e.preventDefault();
    const target = row * state.grid + col;
    move({ type: "swap", a: slot, b: target });
    cells[target].focus();
  });

  // ── Boot ────────────────────────────────────────────────────────────────────

  const res = await fetch("/api/daily/tiles", { credentials: "same-origin" });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    $("tile-status").textContent = error || "Today's puzzle isn't available.";
    return;
  }
  state = await res.json();
  build();

  // The tiles cannot be positioned until the picture's real proportions are
  // known, so the first paint waits for it. A dead thumbnail is the one failure
  // this page cannot play around.
  image.addEventListener("load", () => { render(); boardEl.classList.remove("loading"); });
  image.addEventListener("error", () => {
    $("tile-status").textContent = "Today's picture wouldn't load — try again in a moment.";
  });
  boardEl.classList.add("loading");
  image.src = state.image;

  apply(state);
  loadBoard();

  // Backgrounds are sized in pixels, so a resize is a repaint rather than
  // something CSS can absorb on its own.
  window.addEventListener("resize", () => { if (state) paint(); });
})();
