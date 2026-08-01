"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Wikidle — guess the article from its opening text, one word at a time.
//
// You start with a handful of words and name the article. Wrong, and one more
// word appears. Your score is how many words it took, so the game is over the
// moment you are right rather than after a fixed number of tries.
//
// It also borrows Wordle's two visible aids, because an unbounded answer with no
// feedback is a very different game from a five-letter word with plenty: the
// answer's SHAPE (how many words, how long each one is) is on screen from the
// first frame, and every guess comes back marked letter by letter. See shapeOf
// and markGuess below.
//
// The whole thing is server-authoritative, and not by accident: the answer, the
// unrevealed words and the guess count all live here. The client is only ever
// sent the words it has already earned, so there is nothing in the page to read
// ahead to and no count for it to misreport. The shape and the marks are part of
// that same discipline — both are derived here, from the answer, and only ever
// describe letters the player has already paid a guess for.
// ────────────────────────────────────────────────────────────────────────────

const config = require("../config");
const log = require("../log");
const { dayKey, pickDaily, cachedForDay } = require("./daily");
const { blankTitle, stripPronunciation } = require("./extract");
const { titleWords, scoreGuess } = require("./scoring");

const GAME_ID = "wikidle";

// Long enough that forty words is a real reveal rather than the whole article.
// Measured against the pool: party articles run 1,600–3,700 characters, so this
// only excludes the stubs (a "Yes discography" is 198).
const MIN_TEXT_LEN = 400;

// Where the game starts and where it gives up. Six words is roughly a clause —
// enough for the lead to have started saying what the subject IS, which four
// often was not ("_____ is a large") — and forty is long past the point where an
// article that was ever guessable has said what it is.
const START_WORDS = 6;
const MAX_WORDS = 40;

// How close a guess has to be. scoreGuess returns 100 for the exact title and
// degrades with edit distance, so this tolerates a typo or a missing accent
// while still requiring essentially the whole name — "bear" must not take
// "Polar Bear".
const CORRECT_AT = 80;

// Build the day's puzzle: the article, and its opening text with the title
// blanked out, as a word list.
//
// Blanking is what makes this playable rather than trivial — the opening line
// of a Wikipedia article almost always leads with its own subject. blankTitle
// is the same helper the live text mode uses, so the two behave identically.
function buildPuzzle(day) {
  const rows = pickDaily({
    day,
    gameId: GAME_ID,
    clue: "text",
    minPop: config.tierMinPopularity.party,
    minTextLen: MIN_TEXT_LEN,
  });
  if (!rows) return null;

  const row = rows[0];
  // Order matters: strip the pronunciation apparatus FIRST, then blank. A
  // respelling like CHEK-oh-sloh-VAK-ee-ə is not a form blankTitle recognises,
  // so blanking first would leave a phonetic copy of the answer in the clue.
  const words = blankTitle(stripPronunciation(row.opening_text), row.title)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);

  // A pool row that blanks down to almost nothing would be an unplayable day.
  // Better to serve no puzzle than a broken one.
  if (words.length < START_WORDS + 4) {
    log.warn("wikidle_puzzle_too_short", { day, title: row.title, words: words.length });
    return null;
  }

  return { day, pageId: row.page_id, title: row.title, words };
}

function puzzleFor(now = Date.now()) {
  const day = dayKey(now);
  return cachedForDay(GAME_ID, day, () => buildPuzzle(day));
}

// Did this guess name the article? Reuses the live game's scorer with an empty
// frequency map, which zeroes the "words from the article" half and leaves
// exactly the title-similarity score — the same near-miss behaviour players
// already know from a normal round, with no second definition of "close".
function isCorrect(guess, title) {
  const r = scoreGuess(guess, { words: titleWords(title), freq: new Map() });
  return r.score >= CORRECT_AT;
}

// ── Wordle-style feedback ────────────────────────────────────────────────────
//
// Two aids, and they are the reason this puzzle is playable rather than a
// staring contest. Wordle gives its player the answer's length for free and
// colours every letter they try; this had neither, so a lead that had not yet
// named a category left nothing to work with but the clue text.

// Which characters are the puzzle. Letters and digits are hidden; punctuation
// and spacing are structure, and showing them is what makes a hyphenated or
// possessive title legible as itself rather than as one long run of blanks.
const HIDDEN = /[\p{L}\p{N}]/u;

// One character as it is compared: lower-cased and stripped of accents, so
// "Zurich" marks against "Zürich" letter for letter. The same tolerance the
// near-miss scorer already grants a whole guess, applied one character at a
// time — a player who cannot type an umlaut should not be told they were wrong.
function fold(ch) {
  return String(ch).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const wordsOf = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).map((w) => [...w]);

// The answer's skeleton: one entry per word, one slot per character. `null` is a
// slot the player has not earned; anything else is shown as-is.
//
// This is the only thing about the answer that goes out before it is solved, and
// it is deliberately shape-only — word count and lengths, which is exactly what
// a Wordle player reads off an empty grid.
function shapeOf(title) {
  return wordsOf(title).map((w) => w.map((ch) => (HIDDEN.test(ch) ? null : ch)));
}

// Mark one guess against the answer: Wordle's two passes, generalised to a title
// of several words of unknown length.
//
// Position is judged PER WORD — the third letter of the second word against the
// third letter of the answer's second word — because that is the only alignment
// a player can reason about when the guess and the answer have different word
// counts. Anything left unplaced then falls back to presence anywhere in the
// answer, drawn from a shared pool so three E's in a guess cannot all come back
// "near" against an answer holding one. That pool is the whole point of doing it
// in two passes rather than one: a letter already claimed by a green square is
// gone, and cannot also colour a yellow one.
//
// Non-alphanumerics are marked "skip" rather than judged. Scoring a player's
// hyphen would be feedback about their typing, not about the answer.
function markGuess(guess, title) {
  const gWords = wordsOf(guess);
  const aWords = wordsOf(title);

  // Answer characters still unclaimed, counted by folded value.
  const pool = new Map();
  const take = (k, n) => pool.set(k, (pool.get(k) || 0) + n);
  for (const w of aWords) for (const ch of w) if (HIDDEN.test(ch)) take(fold(ch), 1);

  const marks = gWords.map((w, i) =>
    w.map((ch, j) => {
      if (!HIDDEN.test(ch)) return { ch, mark: "skip" };
      const a = aWords[i] && aWords[i][j];
      // Each answer position can be claimed by at most one guess position, so a
      // hit can never draw more from the pool than that letter put into it.
      if (a != null && fold(a) === fold(ch)) {
        take(fold(ch), -1);
        return { ch, mark: "hit" };
      }
      return { ch, mark: "miss" };
    })
  );

  for (const w of marks) {
    for (const c of w) {
      if (c.mark !== "miss") continue;
      const k = fold(c.ch);
      if ((pool.get(k) || 0) <= 0) continue;
      take(k, -1);
      c.mark = "near";
    }
  }
  return marks;
}

// The skeleton with every correctly-placed letter filled in — Wordle's green
// squares, kept between guesses so progress accumulates instead of scrolling out
// of sight up the guess list.
//
// Recomputed from the guess list rather than stored alongside it, so there is
// one record of what a player did and no second copy of it to fall out of step.
// Filled from the ANSWER's characters, not the guess's, so a solve typed without
// its accents still reveals the title as Wikipedia spells it.
function revealedShape(title, guesses = []) {
  const shape = shapeOf(title);
  const aWords = wordsOf(title);
  for (const g of guesses) {
    markGuess(g && g.text, title).forEach((w, i) =>
      w.forEach((c, j) => {
        if (c.mark === "hit") shape[i][j] = aWords[i][j];
      })
    );
  }
  return shape;
}

module.exports = {
  GAME_ID,
  START_WORDS,
  MAX_WORDS,
  CORRECT_AT,
  MIN_TEXT_LEN,
  buildPuzzle,
  puzzleFor,
  isCorrect,
  shapeOf,
  markGuess,
  revealedShape,
};
