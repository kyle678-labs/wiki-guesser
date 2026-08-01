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

  // A revealed slot is either a letter the player placed or a piece of the
  // title's punctuation, which was never hidden. Only the first gets the
  // "you found this" treatment. Kept in step with HIDDEN in game/wikidle.js.
  const LETTER = /[\p{L}\p{N}]/u;

  // ── Rendering ───────────────────────────────────────────────────────────────

  function renderClue() {
    // The blank is the article's own name, removed from its opening sentence.
    // Rendered as a span so it reads as a gap rather than as punctuation.
    const html = state.words
      .map((w) => WG.escapeHtml(w).replace(/_____/g, '<span class="daily-blank">_____</span>'))
      .join(" ");
    $("daily-clue").innerHTML = html + (state.done ? "" : ' <span class="daily-more">…</span>');
  }

  // The answer's shape — a box per character, with the letters you have placed
  // already filled in. A `null` slot is one nobody has earned yet; anything else
  // is a character the server has decided you may see, so it is drawn as-is.
  function renderShape() {
    const el = $("daily-pattern");
    // Once it is over the answer itself is on screen, and a half-filled outline
    // of a word you can already read is just noise.
    if (state.done || !state.shape || !state.shape.length) { el.innerHTML = ""; return; }

    const boxes = state.shape
      .map(
        (word) =>
          `<span class="wd-word">` +
          word
            .map((c) =>
              c == null
                ? `<span class="wd-slot"></span>`
                : `<span class="wd-slot ${LETTER.test(c) ? "known" : "fixed"}">${WG.escapeHtml(c)}</span>`
            )
            .join("") +
          `</span>`
      )
      .join("");

    const words = state.shape.length;
    const chars = state.shape.reduce((n, w) => n + w.length, 0);
    el.innerHTML =
      `<div class="wd-shape">${boxes}</div>` +
      `<p class="hint">The answer: ${words} word${words === 1 ? "" : "s"}, ${chars} character${chars === 1 ? "" : "s"}.</p>`;
  }

  // A guess, marked letter by letter. `marks` is the server's reading of it, so
  // an old response that predates them (or a guess of pure punctuation) falls
  // back to the plain text rather than rendering an empty row.
  function guessTiles(g) {
    if (!g.marks || !g.marks.length) return `<span>${WG.escapeHtml(g.text)}</span>`;
    return (
      `<span class="wd-guess">` +
      g.marks
        .map(
          (word) =>
            `<span class="wd-word">` +
            word.map((c) => `<span class="wd-tile ${c.mark}">${WG.escapeHtml(c.ch)}</span>`).join("") +
            `</span>`
        )
        .join("") +
      `</span>`
    );
  }

  function renderGuesses() {
    if (!state.guesses.length) { $("daily-guesses").innerHTML = ""; return; }
    // Newest first: the list only grows, and the last thing you tried is the
    // thing you are still thinking about.
    $("daily-guesses").innerHTML = [...state.guesses]
      .reverse()
      .map(
        (g) => `<div class="daily-guess ${g.correct ? "hit" : "miss"}">
          ${guessTiles(g)}
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
    renderShape();
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
