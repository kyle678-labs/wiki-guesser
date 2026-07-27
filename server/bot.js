"use strict";

// A lightweight practice opponent for casual quick match. It's a plain player
// object (no socket); the Room schedules its guesses each round. A single skill
// dial (config.game.botSkill, 0…1) shapes how it plays: how often it names the
// answer outright, how often it whiffs, and — when it guesses an article word —
// whether it grabs a strong (frequent) or weak (rare) one.

const { customAlphabet } = require("nanoid");
const config = require("./config");
const { titleWords, stem, COMMON } = require("./game/scoring");

const botNum = customAlphabet("0123456789", 3);
const NAMES = ["WikiBot", "TriviaTron", "GuessBot", "Quizzler", "PageTurner", "FactFinch"];

// Frequent-but-not-guessable tokens to skip (dates read as noise, not a guess).
const NOISE = new Set(
  "january february march april may june july august september october november december".split(" ")
);

function makeBot() {
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];
  return {
    id: `bot_${botNum()}_${Date.now().toString(36)}`,
    userId: null,
    name: `${name} 🤖`,
    avatar: null,
    ranked: false,
    isBot: true,
  };
}

// Produce the bot's guess string for a given answer. `answer` is the server-side
// mystery: { title, words, freq: Map<stem, count>, ... }.
function botGuess(answer) {
  const skill = config.game.botSkill; // 0 … 1
  const title = (answer && answer.title) || "";

  // Name it outright — more often the higher the skill (≈20% at 0.5, ≈40% at 1).
  if (title && Math.random() < 0.4 * skill) return title;

  // Otherwise sometimes whiff entirely (0 points) — more often the lower the
  // skill (≈30% of these turns at 0.5, never at 1). This is the main "beatable".
  if (Math.random() < 0.6 * (1 - skill)) return "";

  // Otherwise guess a real article word worth points: a content word that isn't
  // part of the title, a filler word, or a bare number/date (those score but read
  // as noise). freq keys are stems, which is what scoreGuess looks up.
  const freq = answer && answer.freq;
  if (freq && freq.size) {
    const titleStems = new Set(titleWords(title).map(stem));
    const cands = [...freq.entries()]
      .filter(([w]) => w.length >= 4 && !/\d/.test(w) && !titleStems.has(w) && !COMMON.has(w) && !NOISE.has(w))
      .sort((a, b) => b[1] - a[1]); // strongest (most frequent → highest score) first
    if (cands.length) {
      // Skill picks how far down the strength list to reach: high skill → the top
      // (big score), low skill → the weak tail (small score), with some jitter.
      const n = cands.length;
      let idx = Math.round((1 - skill) * (n - 1) + (Math.random() - 0.5) * n * 0.35);
      idx = Math.max(0, Math.min(n - 1, idx));
      return cands[idx][0];
    }
    // Fallback: any non-title article word so the bot still takes a turn.
    const any = [...freq.keys()].filter((w) => !titleStems.has(w));
    if (any.length) return any[Math.floor(Math.random() * any.length)];
  }
  return ""; // nothing usable — an empty (0-point) guess
}

// A human-like think time, comfortably inside the guess window.
function botDelayMs(guessSeconds) {
  const window = (guessSeconds || 35) * 1000;
  const max = Math.max(1500, Math.min(9000, Math.floor(window * 0.8)));
  const min = Math.min(3000, max);
  return Math.round(min + Math.random() * (max - min));
}

module.exports = { makeBot, botGuess, botDelayMs };
