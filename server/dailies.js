"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Daily puzzle routes.
//
// Everything a player could lie about is held here rather than in the browser:
// the answer, the words they have not earned yet, which caption belongs to
// which picture, and how many guesses or moves they have spent. The client is
// sent only what it has already uncovered, so there is nothing in the page to
// read ahead to and no count for it to misreport.
//
// Three games share this file because they share everything except their rules:
// one identity check, one day, one shape of progress, one board. What differs
// per game is a module under game/ and a handful of lines below.
//
// Progress lives on the express session, not in memory. It is already
// SQLite-backed, already per-player, and already survives a deploy — which
// matters, because a restart mid-puzzle should cost a player their place in the
// article, not their morning.
// ────────────────────────────────────────────────────────────────────────────

const express = require("express");

const log = require("./log");
const { getSessionUser } = require("./auth");
const { dayKey, msUntilReset } = require("./game/daily");
const wikidle = require("./game/wikidle");
const tiles = require("./game/tiles");
const match = require("./game/match");
const { recordDailyScore, getDailyLeaderboard, getDailyRank, getDailyEntry } = require("./db");

const BOARD_LIMIT = 25;

// The three puzzles, in the order the strip across the top of each page shows
// them.
//
// `format` is how a score should be read, because "12" on a board means nothing
// on its own and the three games do not agree. Wikidle is a `count` — the
// guesses it took — and carries its unit in both forms so the client never has
// to guess at English ("guesses" does not singularise the way "moves" does).
//
// The two picture games are `time`, in milliseconds. They are puzzles you can
// always finish, so the interesting question is how fast rather than in how
// few; the move count is still shown next to par, but it is not the ranking.
// One consequence worth stating plainly: a timed puzzle can be scouted, and a
// player who solves it once under another identity can then run a memorised
// solution against the clock. Wikidle dropped its clock partly for that reason
// — see the note in db.js — so this is a trade taken knowingly, not an
// oversight.
const GAMES = [
  {
    id: wikidle.GAME_ID,
    mod: wikidle,
    name: "Wikidle",
    path: "/daily",
    format: "count",
    unit: "guesses",
    unitOne: "guess",
    blurb: "Name the article. Every wrong guess reveals one more word.",
  },
  {
    id: tiles.GAME_ID,
    mod: tiles,
    name: "Wikitile",
    path: "/tiles",
    format: "time",
    unit: "time",
    blurb: "One picture, sixteen scrambled tiles. Turn and swap them back together.",
  },
  {
    id: match.GAME_ID,
    mod: match,
    name: "Wikimatch",
    path: "/match",
    format: "time",
    unit: "time",
    blurb: "Nine pictures, nine titles, all in the wrong places. Sort them out.",
  },
];

const byId = new Map(GAMES.map((g) => [g.id, g]));

// Per-day, per-game progress on the session. The whole object is thrown away
// when the day turns rather than pruned per game: a stale day has nothing worth
// keeping, and one comparison is cheaper to reason about than a sweep.
function progressFor(req, game, day, init) {
  if (!req.session.daily || req.session.daily.day !== day) {
    req.session.daily = { day };
  }
  if (!req.session.daily[game]) req.session.daily[game] = init();
  return req.session.daily[game];
}

// Identity, then a puzzle to play. Every game route starts with these two
// checks and neither has a game-specific answer, so they are worth having in
// one place — a box with no pool on disk should serve the site with the dailies
// switched off rather than failing the page.
function ready(req, res, mod) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Choose a name or sign in to play the daily." });
    return null;
  }
  const puzzle = mod.puzzleFor();
  if (!puzzle) {
    res.status(503).json({ error: "Today's puzzle isn't available — check back shortly." });
    return null;
  }
  return { user, puzzle };
}

// One score, written once. A board write must never cost someone their solve:
// they still see the result, and only the leaderboard row is lost.
function record(game, day, user, score) {
  try {
    recordDailyScore({ day, game, identity: user.id, name: user.name, score });
  } catch (err) {
    log.error("daily_score_write_failed", { game, day, err });
  }
}

// ── The clock ────────────────────────────────────────────────────────────────
// Read here and nowhere else. The page shows a running time, but it is seeded
// from this figure and never sent back — the number that reaches the board is
// the difference between two timestamps taken by this process, so a slow, a
// fast or a lying browser all score the same.

function elapsedFor(st) {
  // A puzzle already in progress across the deploy that introduced timing has
  // no start. Better to start the clock now than to let a missing field read as
  // a solve dated 1970 and take the top of the board.
  if (!st.startedAt) st.startedAt = Date.now();
  // Never zero. Zero sorts ahead of every honest time, and a board solved in
  // under a millisecond is a bug report rather than a leaderboard entry.
  return Math.max(1, Date.now() - st.startedAt);
}

// Once finished the score IS the elapsed time, frozen. Reading the live clock
// afterwards would have a solved puzzle tick on forever.
const liveElapsed = (st) => (st.done ? st.score : elapsedFor(st));

// A timed game ends the same way whichever it is: stop the clock, and that is
// the score.
function finishTimed(st, gameId, day, user) {
  st.done = true;
  st.score = elapsedFor(st);
  record(gameId, day, user, st.score);
}

// Fields every game's response carries, so the countdown and the "come back
// tomorrow" copy are written once in the client rather than three times.
const common = (puzzle, st) => ({
  day: puzzle.day,
  resetInMs: msUntilReset(),
  done: st.done,
  score: st.score,
});

// Link out to the article, which is most of why anyone plays these.
const wikiUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

const router = express.Router();

// The hub: what today is, when it flips, and which of these this player has
// already finished. Read by the strip at the top of all three pages.
router.get("/api/daily", (req, res) => {
  const user = getSessionUser(req);
  const day = dayKey();

  res.json({
    day,
    resetInMs: msUntilReset(),
    signedIn: Boolean(user),
    games: GAMES.map((g) => {
      const mine = user ? getDailyEntry(day, g.id, user.id) : null;
      return {
        id: g.id,
        name: g.name,
        path: g.path,
        format: g.format,
        unit: g.unit,
        unitOne: g.unitOne,
        blurb: g.blurb,
        available: Boolean(g.mod.puzzleFor()),
        played: Boolean(mine),
        score: mine ? mine.score : null,
      };
    }),
  });
});

// ── Wikidle ──────────────────────────────────────────────────────────────────

// What the browser is allowed to know. Note `words`: sliced to what has been
// earned, never the full list.
//
// `shape` and the per-guess `marks` are the Wordle half of the game, and both
// are derived here rather than stored: the session keeps only what the player
// typed, and everything shown about the answer is recomputed from it. A guess
// list is therefore the whole record of a round — there is no second copy of
// "which letters they have found" to drift out of step with it.
function wikidleView(puzzle, st) {
  return {
    ...common(puzzle, st),
    words: puzzle.words.slice(0, st.revealed),
    revealed: st.revealed,
    maxWords: wikidle.MAX_WORDS,
    // Word count and word lengths, with correctly-placed letters filled in.
    // Everything still unfound is a null slot, so this never runs ahead of what
    // the guesses have earned.
    shape: wikidle.revealedShape(puzzle.title, st.guesses),
    guesses: st.guesses.map((g) => ({ ...g, marks: wikidle.markGuess(g.text, puzzle.title) })),
    won: st.won,
    // Only once the round is over, win or lose. Before that it is the answer.
    answer: st.done ? puzzle.title : null,
  };
}

const wikidleState = () => ({
  revealed: wikidle.START_WORDS,
  guesses: [],
  done: false,
  won: false,
  score: null,
});

router.get("/api/daily/wikidle", (req, res) => {
  const r = ready(req, res, wikidle);
  if (!r) return;

  const st = progressFor(req, wikidle.GAME_ID, r.puzzle.day, wikidleState);
  req.session.save((err) =>
    err ? res.status(500).json({ error: "Couldn't start today's puzzle." }) : res.json(wikidleView(r.puzzle, st))
  );
});

router.post("/api/daily/wikidle/guess", express.json(), (req, res, next) => {
  const r = ready(req, res, wikidle);
  if (!r) return;
  const { user, puzzle } = r;

  const st = progressFor(req, wikidle.GAME_ID, puzzle.day, wikidleState);
  if (st.done) return res.status(409).json({ error: "You've already finished today's puzzle.", ...wikidleView(puzzle, st) });

  // Same treatment chat gets: angle brackets stripped and a hard length cap, so
  // nothing stored or echoed back can carry markup.
  const text = String((req.body && req.body.text) || "").replace(/[<>]/g, "").trim().slice(0, 80);
  if (!text) return res.status(400).json({ error: "Type a guess first." });

  const correct = wikidle.isCorrect(text, puzzle.title);
  st.guesses.push({ text, correct });

  if (correct) {
    st.done = true;
    st.won = true;
    // The score is how many guesses it took, so a first-try solve scores 1.
    // Counted from the server's own list rather than anything the client sends,
    // which is what stops "1" being a thing you can simply claim.
    st.score = st.guesses.length;
    record(wikidle.GAME_ID, puzzle.day, user, st.score);
  } else {
    st.revealed += 1;
    // Out of article. Forty words is long past where a guessable subject has
    // said what it is, so this is a loss rather than an endless reveal.
    if (st.revealed >= wikidle.MAX_WORDS) {
      st.done = true;
      st.won = false;
    }
  }

  req.session.save((err) => (err ? next(err) : res.json(wikidleView(puzzle, st))));
});

// ── Wikitile ─────────────────────────────────────────────────────────────────

// The picture goes out on the first request — a jigsaw you cannot see is not a
// jigsaw. The title does not: finishing the picture and only then learning what
// it was is the payoff, so it is held back exactly like Wikidle's answer.
function tilesView(puzzle, st) {
  return {
    ...common(puzzle, st),
    image: puzzle.image,
    grid: puzzle.grid,
    slots: st.slots,
    rot: st.rot,
    moves: st.moves,
    elapsedMs: liveElapsed(st),
    par: puzzle.par,
    answer: st.done ? puzzle.title : null,
    url: st.done ? wikiUrl(puzzle.title) : null,
  };
}

router.get("/api/daily/tiles", (req, res) => {
  const r = ready(req, res, tiles);
  if (!r) return;

  const st = progressFor(req, tiles.GAME_ID, r.puzzle.day, () => tiles.freshState(r.puzzle));
  req.session.save((err) =>
    err ? res.status(500).json({ error: "Couldn't start today's puzzle." }) : res.json(tilesView(r.puzzle, st))
  );
});

// One move per request, which is the only way the move count means anything:
// the score is what this route applied, not what the page reports having done.
// That is also why these have a rate-limit budget of their own (see app.js) —
// a puzzle solved in forty moves is forty requests, and that is a completely
// different traffic shape from the rest of the API.
router.post("/api/daily/tiles/move", express.json(), (req, res, next) => {
  const r = ready(req, res, tiles);
  if (!r) return;
  const { user, puzzle } = r;

  const st = progressFor(req, tiles.GAME_ID, puzzle.day, () => tiles.freshState(puzzle));
  if (st.done) return res.status(409).json({ error: "You've already finished today's puzzle.", ...tilesView(puzzle, st) });

  if (!tiles.applyMove(st, req.body)) return res.status(400).json({ error: "That isn't a move." });

  if (tiles.isSolved(st)) finishTimed(st, tiles.GAME_ID, puzzle.day, user);

  req.session.save((err) => (err ? next(err) : res.json(tilesView(puzzle, st))));
});

// ── Wikimatch ────────────────────────────────────────────────────────────────

// Pictures in one order, titles in another, and nothing here joins them. The
// mapping is the answer, and it stays on the server until the player finds it —
// at which point their own arrangement IS the answer and there is nothing left
// to send.
function matchView(puzzle, st) {
  return {
    ...common(puzzle, st),
    images: puzzle.images,
    titles: puzzle.titles,
    assign: st.assign,
    moves: st.moves,
    elapsedMs: liveElapsed(st),
    par: puzzle.par,
    // Only once it is solved, so the page can link out to nine articles it has
    // just proved it can name.
    urls: st.done ? puzzle.titles.map(wikiUrl) : null,
  };
}

router.get("/api/daily/match", (req, res) => {
  const r = ready(req, res, match);
  if (!r) return;

  const st = progressFor(req, match.GAME_ID, r.puzzle.day, match.freshState);
  req.session.save((err) =>
    err ? res.status(500).json({ error: "Couldn't start today's puzzle." }) : res.json(matchView(r.puzzle, st))
  );
});

router.post("/api/daily/match/swap", express.json(), (req, res, next) => {
  const r = ready(req, res, match);
  if (!r) return;
  const { user, puzzle } = r;

  const st = progressFor(req, match.GAME_ID, puzzle.day, match.freshState);
  if (st.done) return res.status(409).json({ error: "You've already finished today's puzzle.", ...matchView(puzzle, st) });

  const { a, b } = req.body || {};
  if (!match.applySwap(st, a, b)) return res.status(400).json({ error: "That isn't a swap." });

  if (match.isSolved(st, puzzle)) finishTimed(st, match.GAME_ID, puzzle.day, user);

  req.session.save((err) => (err ? next(err) : res.json(matchView(puzzle, st))));
});

// ── Boards ───────────────────────────────────────────────────────────────────

router.get("/api/daily/:game/leaderboard", (req, res) => {
  const game = byId.get(String(req.params.game || ""));
  if (!game) return res.status(404).json({ error: "No such daily game." });

  const user = getSessionUser(req);
  const day = dayKey();
  const rows = getDailyLeaderboard(day, game.id, BOARD_LIMIT).map((r, i) => ({
    rank: i + 1,
    name: r.name,
    score: r.score,
  }));

  // A player outside the visible top N still gets their placing, which is the
  // only way a board of 25 means anything once more than 25 people have played.
  let me = null;
  const mine = user ? getDailyEntry(day, game.id, user.id) : null;
  if (mine) {
    me = { rank: getDailyRank(day, game.id, mine.score, mine.created_at), name: mine.name, score: mine.score };
  }

  res.json({
    day,
    resetInMs: msUntilReset(),
    format: game.format,
    unit: game.unit,
    unitOne: game.unitOne,
    leaderboard: rows,
    me,
  });
});

// The endpoints that take one request per move. Declared here, next to the
// routes themselves, because app.js has to give them a rate-limit budget of
// their own and a path list that lives in the other file is one rename away
// from silently applying the wrong limit.
const MOVE_PATHS = ["/api/daily/tiles/move", "/api/daily/match/swap"];

module.exports = { router, GAMES, MOVE_PATHS };
