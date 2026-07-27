"use strict";

// Turns a Wikipedia summary into a "guess the article from its description"
// clue: the first sentence or two, with the article's own name blanked out so
// it isn't a giveaway.

const { STOPWORDS } = require("./scoring");

const BLANK = "_____";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// First `max` sentences of the extract, whitespace-normalised and length-capped.
function firstSentences(text, max = 2) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  const parts = clean.match(/[^.!?]+[.!?]+/g);
  let result = parts ? parts.slice(0, max).map((s) => s.trim()).join(" ") : clean;
  if (result.length > 320) result = result.slice(0, 317).trimEnd() + "…";
  return result;
}

// Replace the article title (whole phrase and each significant word) with a
// blank, case-insensitively and accent-aware, collapsing adjacent blanks.
function blankTitle(text, title) {
  if (!text) return "";
  let out = text;

  const phrase = escapeRe(String(title).trim());
  if (phrase) out = out.replace(new RegExp(phrase + "s?", "gi"), BLANK);

  const words = String(title)
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
  for (const w of words) {
    out = out.replace(new RegExp("(?<![\\p{L}\\p{N}])" + escapeRe(w) + "s?(?![\\p{L}\\p{N}])", "giu"), BLANK);
  }

  // Collapse runs of blanks (multi-word titles) into a single blank.
  out = out.replace(/_____(?:[\s\-–—]+_____)+/g, BLANK);
  return out;
}

// { full, blanked } — full for the post-round reveal, blanked for the clue.
function buildClue(extract, title, max = 2) {
  const full = firstSentences(extract, max);
  return { full, blanked: blankTitle(full, title) };
}

module.exports = { firstSentences, blankTitle, buildClue, BLANK };
