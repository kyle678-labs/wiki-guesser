"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Wikimatch — nine Wikipedia pictures and their nine titles, shuffled apart.
//
// Every picture has the wrong caption under it. Swap two captions at a time
// until each one sits under its own article; your score is how many swaps it
// took. Nothing is timed, and lower is better, as everywhere in the dailies.
//
// This one has a real secret, and it is the pairing. The browser is sent the
// pictures in one order and the titles in another, with nothing joining them —
// which order belongs to which lives only here, and the round ends when the
// arrangement held here is right rather than when the client says so. A player
// who cannot tell an alpaca from a llama can still brute-force it, but a
// permutation of nine has 362,880 arrangements and every attempt costs a swap,
// so the board sorts the people who knew from the people who guessed.
//
// The soft edge, stated plainly: a Commons image URL carries a filename that
// often names its subject, so someone reading the page source can shortcut the
// easy ones. That is the same trade the live picture rounds already make — the
// picture has to reach the browser to be a picture — and it is not worth
// proxying every image through this box to close.
// ────────────────────────────────────────────────────────────────────────────

const config = require("../config");
const log = require("../log");
const { dayKey, pickDaily, cachedForDay, seedFor, rng, shuffle, swapsToSort } = require("./daily");

const GAME_ID = "match";

// Nine: a 3×3 grid on a laptop, one column on a phone, and enough that a lucky
// arrangement is not a solve. Six is trivial, twelve is a wall of pictures.
const COUNT = 9;

// The day's title order, as a permutation with no fixed point: `order[j]` is the
// slot that title j belongs to. Play starts with title j under slot j, so a
// derangement is exactly the guarantee that nothing is right for free.
function orderFor(day) {
  const next = rng(seedFor(day, `${GAME_ID}:order`));
  const slots = [...Array(COUNT).keys()];
  // A random permutation of nine is a derangement about 37% of the time (1/e),
  // so this retries once or twice on average. The bound only exists so a
  // pathological stream cannot spin.
  for (let attempt = 0; attempt < 50; attempt++) {
    const order = shuffle(slots, next);
    if (order.every((slot, j) => slot !== j)) return order;
  }
  // Rotating by one is a derangement by construction, and still deterministic.
  log.warn("match_order_fallback", { day });
  return slots.map((i) => (i + 1) % COUNT);
}

function buildPuzzle(day) {
  const rows = pickDaily({
    day,
    gameId: GAME_ID,
    clue: "image",
    // Party tier, and for a sharper reason than usual: this game asks you to
    // name nine articles from their pictures at once, so nine obscure ones is
    // not a hard puzzle, it is an impossible one.
    minPop: config.tierMinPopularity.party,
    count: COUNT,
  });
  // pickDaily returns a short draw rather than nothing when the pool cannot
  // fill the request. A grid with a hole in it is not a puzzle, so refuse it.
  if (!rows || rows.length < COUNT) {
    if (rows) log.warn("match_puzzle_short", { day, got: rows.length, wanted: COUNT });
    return null;
  }

  const order = orderFor(day);
  return {
    day,
    count: COUNT,
    // Slot i shows images[i]; the player never learns the pool order these came
    // out in, so leaving them as drawn gives nothing away.
    images: rows.map((r) => r.image_url),
    // Title j belongs under slot order[j].
    titles: order.map((slot) => rows[slot].title),
    order,
    pageIds: rows.map((r) => r.page_id),
    // The best possible score: the swaps that sort the starting arrangement.
    par: swapsToSort(order),
  };
}

function puzzleFor(now = Date.now()) {
  const day = dayKey(now);
  return cachedForDay(GAME_ID, day, () => buildPuzzle(day));
}

// `assign[i]` is the title currently sitting under slot i. Everyone starts with
// title i under slot i — which orderFor has already guaranteed is wrong for
// every one of them.
//
// `startedAt` is the clock, and it starts the moment the grid is handed out
// rather than on the first swap. On the first swap it would measure nothing but
// mouse speed: recognising nine articles is the whole puzzle, and a player
// could do all of it before touching anything.
function freshState() {
  return { assign: [...Array(COUNT).keys()], moves: 0, startedAt: Date.now(), done: false, score: null };
}

const inRange = (n) => Number.isInteger(n) && n >= 0 && n < COUNT;

// Swap the titles under two slots. Returns false — changing nothing — for
// anything malformed, so a mis-drop costs neither a move nor the round.
function applySwap(st, a, b) {
  if (!inRange(a) || !inRange(b) || a === b) return false;
  [st.assign[a], st.assign[b]] = [st.assign[b], st.assign[a]];
  st.moves += 1;
  return true;
}

// Solved when every slot holds the title that belongs to it. Deliberately the
// only feedback the game gives: telling a player which three are right would
// turn nine articles they have to recognise into a puzzle they can grind.
function isSolved(st, puzzle) {
  return st.assign.every((title, slot) => puzzle.order[title] === slot);
}

module.exports = {
  GAME_ID,
  COUNT,
  buildPuzzle,
  puzzleFor,
  orderFor,
  freshState,
  applySwap,
  isSolved,
};
