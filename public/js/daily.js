/* Wikidle — the daily puzzle.
 *
 * Deliberately thin. The server owns the answer, the words not yet earned, the
 * guess count and the clock; this file renders whatever state comes back and
 * posts guesses. There is nothing here worth reading ahead in, because there is
 * nothing here to read ahead to.
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

  WG.renderDailyStrip($("daily-strip"), "wikidle");

  let state = null;

  // ── Rendering ───────────────────────────────────────────────────────────────

  function renderClue() {
    // The blank is the article's own name, removed from its opening sentence.
    // Rendered as a span so it reads as a gap rather than as punctuation.
    const html = state.words
      .map((w) => WG.escapeHtml(w).replace(/_____/g, '<span class="daily-blank">_____</span>'))
      .join(" ");
    $("daily-clue").innerHTML = html + (state.done ? "" : ' <span class="daily-more">…</span>');
  }

  function renderGuesses() {
    if (!state.guesses.length) { $("daily-guesses").innerHTML = ""; return; }
    // Newest first: the list only grows, and the last thing you tried is the
    // thing you are still thinking about.
    $("daily-guesses").innerHTML = [...state.guesses]
      .reverse()
      .map(
        (g) => `<div class="daily-guess ${g.correct ? "hit" : "miss"}">
          <span>${WG.escapeHtml(g.text)}</span>
          <span class="daily-mark">${g.correct ? "✓" : "✕"}</span>
        </div>`
      )
      .join("");
  }

  function renderStatus() {
    const left = state.maxWords - state.revealed;
    $("daily-status").textContent = state.done
      ? ""
      : `${state.revealed} word${state.revealed === 1 ? "" : "s"} shown · ${left} left before it's over`;
  }

  function renderResult() {
    const el = $("daily-result");
    if (!state.done) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    $("daily-guess-row").classList.add("hidden");

    const answer = `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(
      state.answer.replace(/ /g, "_")
    )}" target="_blank" rel="noopener">${WG.escapeHtml(state.answer)}</a>`;

    const guessWord = state.score === 1 ? "guess" : "guesses";
    el.innerHTML = state.won
      ? `<h3 class="daily-win">Got it in ${state.score} ${guessWord}.</h3>
         <p class="muted">It was ${answer}.</p>
         <button class="ghost small" id="daily-share">Copy result</button>`
      : `<h3 class="daily-lose">Out of words.</h3>
         <p class="muted">It was ${answer}.</p>`;

    const share = $("daily-share");
    if (share) {
      share.addEventListener("click", async () => {
        // Deliberately no answer and no link — a result you can post the moment
        // you solve it, without spoiling the day for whoever reads it.
        const text = `Wikidle ${state.day} — ${state.score} ${guessWord}\n${location.origin}/daily`;
        try {
          await navigator.clipboard.writeText(text);
          WG.toast("Result copied!");
        } catch { WG.toast("Couldn't copy — long-press to select."); }
      });
    }
  }

  function render() {
    renderClue();
    renderGuesses();
    renderStatus();
    renderResult();
  }

  // ── Play ────────────────────────────────────────────────────────────────────

  const loadBoard = () => WG.loadDailyBoard("wikidle", { body: $("daily-board"), me: $("daily-me") });

  function apply(next) {
    state = next;
    render();
    WG.startDailyCountdown($("daily-reset"), state);
    if (state.done) loadBoard();
  }

  async function load() {
    const res = await fetch("/api/daily/wikidle", { credentials: "same-origin" });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      $("daily-clue").textContent = error || "Today's puzzle isn't available.";
      $("daily-guess-row").classList.add("hidden");
      return;
    }
    apply(await res.json());
    loadBoard();
  }

  async function submitGuess() {
    const input = $("daily-guess");
    const text = input.value.trim();
    if (!text || state.done) return;

    const btn = $("daily-submit");
    btn.disabled = true;
    input.disabled = true;
    try {
      const res = await fetch("/api/daily/wikidle/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409 carries the finished state with it, so a second tab that has
        // fallen behind catches up rather than just showing an error.
        if (data && data.done) apply(data);
        else WG.toast(data.error || "That didn't go through.");
        return;
      }
      input.value = "";
      apply(data);
    } catch (e) {
      console.error("guess failed", e);
      WG.toast("Couldn't send that guess — check your connection.");
    } finally {
      btn.disabled = false;
      if (!state.done) { input.disabled = false; input.focus(); }
    }
  }

  $("daily-submit").addEventListener("click", submitGuess);
  $("daily-guess").addEventListener("keydown", (e) => { if (e.key === "Enter") submitGuess(); });

  await load();
  $("daily-guess").focus();
})();
