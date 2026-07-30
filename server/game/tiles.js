"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Wikitile — one Wikipedia picture a day, cut into sixteen tiles and thrown at
// the board face-up, each one turned some multiple of a quarter turn.
//
// Tap a tile to turn it; drag one onto another to swap them. Both count as one
// move, and your score is how many moves it took, so — as everywhere in the
// dailies — lower is better and there is no clock.
//
// What is server-authoritative here is NOT the picture (a jigsaw you cannot see
// is not a jigsaw). It is the board and the count: every move is applied to the
// state held here, and the score is the number of moves this file applied. A
// client can solve the puzzle any way it likes, but it cannot post a 20 without
// having actually made twenty legal moves.
//
// The article's title is withheld until it is solved, which is the one thing
// worth withholding: assembling the picture and only then finding out what you
// were looking at is most of the fun. That is a soft secret and stated as such —
// the image URL carries a Commons filename that usually names the subject, the
// same trade the live picture rounds already make.
// ────────────────────────────────────────────────────────────────────────────

const config = require("../config");
const log = require("../log");
const { dayKey, pickDaily, cachedForDay, seedFor, rng, shuffle, swapsToSort } = require("./daily");

const GAME_ID = "tiles";

// 4×4. Nine is over in a minute and twenty-five is a chore on a phone.
const GRID = 4;
const TILES = GRID * GRID;

// How scrambled a start has to be to be worth playing. At most four tiles may
// begin in their home slot, and none of those may also be the right way up —
// a tile that is already finished when the board appears is a move nobody had
// to earn, and on a 16-tile board a handful of them is most of the puzzle.
const MAX_SETTLED = 4;

// Whether a tile is done: in its home slot AND unrotated. `slots[i]` is the
// tile sitting in slot i; `rot` is indexed by TILE, not by slot, so a rotation
// travels with the tile when it is swapped — which is what a physical tile does.
const settled = (slots, rot, i) => slots[i] === i && rot[slots[i]] === 0;

function isFairStart(slots, rot) {
  let home = 0;
  for (let i = 0; i < TILES; i++) {
    if (settled(slots, rot, i)) return false;
    if (slots[i] === i) home++;
  }
  return home <= MAX_SETTLED;
}

// The day's scramble. Seeded off the day and a stream of its own, so it is the
// same board for every player, on every instance, forever — and so it does not
// consume draws from the stream pickDaily uses to choose the article.
function scrambleFor(day) {
  const next = rng(seedFor(day, `${GAME_ID}:scramble`));
  const home = [...Array(TILES).keys()];

  // A random permutation is almost always fair (it averages one tile in its
  // home slot, and that one still has to be unrotated to matter), so this
  // essentially never loops. The bound is here so a pathological stream cannot
  // spin forever, not because the retry is expected.
  let slots = null;
  let rot = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    slots = shuffle(home, next);
    rot = Array.from({ length: TILES }, () => Math.floor(next() * 4));
    if (isFairStart(slots, rot)) return { slots, rot };
  }
  // Nudge rather than loop: turn any tile that came out already finished. The
  // result is still deterministic, which is the property that actually matters.
  for (let i = 0; i < TILES; i++) if (settled(slots, rot, i)) rot[slots[i]] = 1;
  log.warn("tiles_scramble_nudged", { day });
  return { slots, rot };
}

// The fewest moves this board can be solved in: the swaps that sort the
// permutation, plus one tap per quarter turn every tile still owes. Rotation is
// independent of position, so the two costs simply add — there is no ordering
// of moves that makes a tile cheaper to turn.
function parFor({ slots, rot }) {
  return swapsToSort(slots) + rot.reduce((n, r) => n + ((4 - r) % 4), 0);
}

function buildPuzzle(day) {
  const rows = pickDaily({
    day,
    gameId: GAME_ID,
    clue: "image",
    // Party tier: a scrambled picture of somewhere you have never heard of is
    // just sixteen brown squares. Recognisability is the whole reward here.
    minPop: config.tierMinPopularity.party,
  });
  if (!rows) return null;

  const row = rows[0];
  const start = scrambleFor(day);
  return {
    day,
    pageId: row.page_id,
    title: row.title,
    image: row.image_url,
    grid: GRID,
    start,
    par: parFor(start),
  };
}

function puzzleFor(now = Date.now()) {
  const day = dayKey(now);
  return cachedForDay(GAME_ID, day, () => buildPuzzle(day));
}

// A player's own board, copied out of the day's puzzle. The copy is the point:
// the puzzle object is cached for the whole day and shared by every player, so
// handing out the arrays themselves would have one player's first move scramble
// everyone else's board.
function freshState(puzzle) {
  return {
    slots: puzzle.start.slots.slice(),
    rot: puzzle.start.rot.slice(),
    moves: 0,
    done: false,
    score: null,
  };
}

const inRange = (n) => Number.isInteger(n) && n >= 0 && n < TILES;

// Apply one move to a player's board. Returns false — changing nothing — for
// anything malformed, so a bad request costs neither a move nor the round.
function applyMove(st, move) {
  if (!move || typeof move !== "object") return false;

  if (move.type === "rotate") {
    if (!inRange(move.slot)) return false;
    const tile = st.slots[move.slot];
    st.rot[tile] = (st.rot[tile] + 1) % 4;
  } else if (move.type === "swap") {
    // A tile swapped with itself is a no-op, and charging a move for it would
    // make a mis-drop cost a point.
    if (!inRange(move.a) || !inRange(move.b) || move.a === move.b) return false;
    [st.slots[move.a], st.slots[move.b]] = [st.slots[move.b], st.slots[move.a]];
  } else {
    return false;
  }

  st.moves += 1;
  return true;
}

function isSolved(st) {
  for (let i = 0; i < TILES; i++) if (st.slots[i] !== i || st.rot[i] !== 0) return false;
  return true;
}

module.exports = {
  GAME_ID,
  GRID,
  TILES,
  MAX_SETTLED,
  buildPuzzle,
  puzzleFor,
  scrambleFor,
  parFor,
  freshState,
  applyMove,
  isSolved,
};
