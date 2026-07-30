"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Wikidle — guess the article from its opening text, one word at a time.
//
// You start with a handful of words and name the article. Wrong, and one more
// word appears. Your score is how many words it took, so the game is over the
// moment you are right rather than after a fixed number of tries.
//
// The whole thing is server-authoritative, and not by accident: the answer, the
// unrevealed words and the guess count all live here. The client is only ever
// sent the words it has already earned, so there is nothing in the page to read
// ahead to and no count for it to misreport.
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

// Where the game starts and where it gives up. Four words is enough to be a
// puzzle and not enough to be a giveaway; forty is long past the point where an
// article that was ever guessable has said what it is.
const START_WORDS = 4;
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

module.exports = {
  GAME_ID,
  START_WORDS,
  MAX_WORDS,
  CORRECT_AT,
  MIN_TEXT_LEN,
  buildPuzzle,
  puzzleFor,
  isCorrect,
};
