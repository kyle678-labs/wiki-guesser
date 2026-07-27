"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Scoring engine (ported from the original single-page Image Guesser).
// A guess earns the higher of two scores:
//   • Naming it   — letter-similarity of guess words vs. the answer's words.
//   • Article hits — any guess word that appears in the answer's Wikipedia
//     article scores on a logistic curve by how often it appears.
// This module is pure/stateless so it can run identically on client & server.
// ────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  ("a an the of in on at by for with and or to from is was are were as it its his her hers their this that " +
    "who which has have had been being also most more other into over under between not but they them he she you your " +
    "when where while after before during about than then there these those such some may can will would could all one two first").split(" ")
);

function stem(w) {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleWords(str) {
  return normalize(str).split(" ").filter((w) => w.length > 0);
}

function textFreq(text) {
  const freq = new Map();
  for (const w of titleWords(text)) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    const s = stem(w);
    freq.set(s, (freq.get(s) || 0) + 1);
  }
  return freq;
}

// Logistic curve: climbs fast, saturates at 80.
function wikiPoints(count) {
  return Math.round(80 / (1 + Math.exp(-0.55 * (count - 4))));
}

// Low-information words that appear on nearly every article: still score, but
// discounted to 12% so filler words can't carry a round.
const COMMON_DISCOUNT = 0.12;
const COMMON = new Set(
  ("year time day month week century decade era period date age early late later latest recent recently current currently " +
    "former formerly modern today annual once often sometimes usually generally typically frequently eventually finally " +
    "initially originally previously subsequently now then still yet soon never always ago " +
    "made make using used use known know call called named become became becoming began begin begun held hold take took " +
    "taken given gave give found founded follow followed following include included includes including consider considered " +
    "describe described refer referred refers say said see saw seen locate located situated establish established built " +
    "build create created develop developed produce produced release released publish published receive received write " +
    "wrote written work worked working play played playing lead led base based move moved remain remained continue " +
    "continued result resulted according report reported note noted state stated open opened close closed start started " +
    "serve served appear appeared present presented involve involved run running ran " +
    "large largest larger small smallest smaller big biggest great greatest greater high highest higher low lowest lower " +
    "long longest longer short wide widely many much several various numerous few number total approximately around least " +
    "less nearly almost main mainly major minor primary primarily important significant notable popular famous best better " +
    "common commonly general generally particular particularly especially specific specifically similar different " +
    "north south east west northern southern eastern western northeast northwest southeast southwest central middle near " +
    "nearby part area region place side center centre location " +
    "name type kind form way group member series system example term case use fact order level rate range variety version " +
    "standard feature section style model unit list " +
    "american british english french german italian spanish european national international world worldwide united states " +
    "people person family life death died born career history historical " +
    "one two three four five six seven eight nine ten first second third hundred thousand million billion").split(/\s+/).map(stem)
);

// Everyday words people guess vs. the words Wikipedia tends to use (pre-stemmed).
const SYNONYM_GROUPS = [
  ["movie", "film", "cinema"],
  ["actor", "actres", "star", "celebrity"],
  ["singer", "musician", "band", "song", "music", "rapper"],
  ["soccer", "footballer", "football"],
  ["bug", "insect"],
  ["city", "town", "village", "municipality", "capital"],
  ["mountain", "peak", "summit", "volcano"],
  ["river", "stream", "creek"],
  ["ship", "boat", "vessel", "liner"],
  ["plane", "aircraft", "airplane", "jet"],
  ["car", "automobile", "vehicle"],
  ["plant", "flower", "tree"],
  ["animal", "creature", "specie", "mammal"],
  ["game", "videogame", "sport"],
  ["book", "novel", "author", "writer"],
  ["show", "serie", "television", "sitcom"],
  ["politician", "president", "minister", "leader"],
  ["athlete", "player", "sportsman"],
  ["food", "dish", "snack", "dessert", "cuisine"],
  ["drink", "beverage", "cocktail"],
  ["building", "tower", "monument", "landmark", "structure"],
];
const SYN_MAP = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const w of group) SYN_MAP.set(w, group);
}

function expandWord(gw) {
  const s = stem(gw);
  return SYN_MAP.get(s) || [s];
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function wordSimilarity(a, b) {
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  return Math.max(0, 1 - dist / Math.max(a.length, b.length));
}

// `answer` = { words: string[], freq: Map<string, number> }
function scoreGuess(guess, answer) {
  const guessWords = titleWords(guess || "");
  if (guessWords.length === 0) return { score: 0, type: "none" };

  let total = 0;
  for (const aw of answer.words) {
    let best = 0;
    for (const gw of guessWords) best = Math.max(best, wordSimilarity(aw, gw));
    if (best >= 0.5) total += best;
  }
  const titleScore = Math.round((total / answer.words.length) * 100);

  let best = null;
  let extras = 0;
  for (const gw of new Set(guessWords)) {
    if (gw.length < 3 || STOPWORDS.has(gw)) continue;
    let eff = 0, raw = 0, isCommon = false;
    for (const cand of expandWord(gw)) {
      const c = answer.freq.get(cand) || 0;
      if (!c) continue;
      const common = COMMON.has(cand);
      const e = common ? c * COMMON_DISCOUNT : c;
      if (e > eff) { eff = e; raw = c; isCommon = common; }
    }
    if (eff === 0) continue;
    const pts = wikiPoints(eff);
    if (!best || pts > best.pts) {
      if (best && !best.isCommon) extras++;
      best = { pts, word: gw, count: raw, isCommon };
    } else if (!isCommon) {
      extras++;
    }
  }
  const wikiScore = best ? Math.min(best.pts + 5 * extras, 85) : 0;

  if (titleScore >= wikiScore) {
    return { score: titleScore, type: titleScore > 0 ? "name" : "none" };
  }
  return { score: wikiScore, type: "wiki", word: best.word, count: best.count, isCommon: best.isCommon };
}

// Short human-readable label for how a guess earned its points.
function creditLabel(r) {
  if (!r || r.score <= 0) return "";
  if (r.type === "name") return "named it";
  if (r.isCommon) return `“${r.word}” ×${r.count} — filler word, heavily discounted`;
  return `“${r.word}” appears ${r.count}× in its article`;
}

module.exports = {
  STOPWORDS,
  COMMON,
  normalize,
  titleWords,
  textFreq,
  scoreGuess,
  creditLabel,
  stem,
};
