"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Daily puzzle routes.
//
// Everything a player could lie about is held here rather than in the browser:
// the answer, the words they have not earned yet, how many guesses they have
// spent, and when their clock started. The client is sent only what it has
// already uncovered, so there is nothing in the page to read ahead to.
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
const { recordDailyScore, getDailyLeaderboard, getDailyRank, getDailyEntry } = require("./db");

const BOARD_LIMIT = 25;

// Per-day, per-game progress on the session. The whole object is thrown away
// when the day turns rather than pruned per game: a stale day has nothing worth
// keeping, and one comparison is cheaper to reason about than a sweep.
function progressFor(req, game, day) {
  if (!req.session.daily || req.session.daily.day !== day) {
    req.session.daily = { day };
  }
  if (!req.session.daily[game]) {
    req.session.daily[game] = {
      revealed: wikidle.START_WORDS,
      guesses: [],
      done: false,
      won: false,
      score: null,
    };
  }
  return req.session.daily[game];
}

// What the browser is allowed to know. Note `words`: sliced to what has been
// earned, never the full list.
function wikidleView(puzzle, st) {
  return {
    day: puzzle.day,
    resetInMs: msUntilReset(),
    words: puzzle.words.slice(0, st.revealed),
    revealed: st.revealed,
    maxWords: wikidle.MAX_WORDS,
    guesses: st.guesses,
    done: st.done,
    won: st.won,
    score: st.score,
    // Only once the round is over, win or lose. Before that it is the answer.
    answer: st.done ? puzzle.title : null,
  };
}

const router = express.Router();

// The hub: what today is, when it flips, and whether this player has finished.
router.get("/api/daily", (req, res) => {
  const user = getSessionUser(req);
  const day = dayKey();
  const puzzle = wikidle.puzzleFor();
  const mine = user ? getDailyEntry(day, wikidle.GAME_ID, user.id) : null;

  res.json({
    day,
    resetInMs: msUntilReset(),
    signedIn: Boolean(user),
    games: [
      {
        id: wikidle.GAME_ID,
        name: "Wikidle",
        blurb: "Name the article. Every wrong guess reveals one more word.",
        // A box with no pool on disk serves the site with the dailies switched
        // off rather than failing the page.
        available: Boolean(puzzle),
        played: Boolean(mine),
        score: mine ? mine.score : null,
      },
    ],
  });
});

router.get("/api/daily/wikidle", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Choose a name or sign in to play the daily." });

  const puzzle = wikidle.puzzleFor();
  if (!puzzle) return res.status(503).json({ error: "Today's puzzle isn't available — check back shortly." });

  const st = progressFor(req, wikidle.GAME_ID, puzzle.day);
  req.session.save((err) => (err ? res.status(500).json({ error: "Couldn't start today's puzzle." }) : res.json(wikidleView(puzzle, st))));
});

router.post("/api/daily/wikidle/guess", express.json(), (req, res, next) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Choose a name or sign in to play the daily." });

  const puzzle = wikidle.puzzleFor();
  if (!puzzle) return res.status(503).json({ error: "Today's puzzle isn't available — check back shortly." });

  const st = progressFor(req, wikidle.GAME_ID, puzzle.day);
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
    try {
      recordDailyScore({
        day: puzzle.day,
        game: wikidle.GAME_ID,
        identity: user.id,
        name: user.name,
        score: st.score,
      });
    } catch (err) {
      // A board write must never cost someone their solve. They still see the
      // result; only the leaderboard row is lost.
      log.error("daily_score_write_failed", { game: wikidle.GAME_ID, day: puzzle.day, err });
    }
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

router.get("/api/daily/:game/leaderboard", (req, res) => {
  const game = String(req.params.game || "");
  if (game !== wikidle.GAME_ID) return res.status(404).json({ error: "No such daily game." });

  const user = getSessionUser(req);
  const day = dayKey();
  const rows = getDailyLeaderboard(day, game, BOARD_LIMIT).map((r, i) => ({
    rank: i + 1,
    name: r.name,
    score: r.score,
  }));

  // A player outside the visible top N still gets their placing, which is the
  // only way a board of 25 means anything once more than 25 people have played.
  let me = null;
  const mine = user ? getDailyEntry(day, game, user.id) : null;
  if (mine) {
    me = { rank: getDailyRank(day, game, mine.score, mine.created_at), name: mine.name, score: mine.score };
  }

  res.json({ day, resetInMs: msUntilReset(), leaderboard: rows, me });
});

module.exports = { router };
