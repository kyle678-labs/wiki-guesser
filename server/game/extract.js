"use strict";

// Turns a Wikipedia summary into a "guess the article from its description"
// clue: the first sentence or two, with the article's own name blanked out so
// it isn't a giveaway.

const { STOPWORDS } = require("./scoring");

const BLANK = "_____";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip the pronunciation apparatus a Wikipedia lead opens with.
//
// This is not tidying. A lead like
//   Czechoslovakia (/ˌtʃɛkoʊsloʊˈvæki.ə/ CHEK-oh-sloh-VAK-ee-ə; Czech: Československo)
// spells the answer out twice over — phonetically and in its native language —
// so blanking the title alone leaves the giveaway sitting right next to the
// blank. It also eats a dozen words of a clue that is measured in words.
//
// Deliberately surgical rather than dropping whole parentheticals: "(born 17
// October 1974)" shares its brackets with the IPA on most biographies, and the
// date is a real clue worth keeping.
function stripPronunciation(text) {
  if (!text) return "";
  return (
    String(text)
      // /ˌtʃɛkoʊsloʊˈvæki.ə/ — only when the span actually looks phonetic, so a
      // date or a fraction between slashes survives.
      .replace(/\/[^/\n]{2,80}\//g, (m) => (/[ˈˌːɪɛəʃʒŋθðæɑɔʊʌɜ]/.test(m) ? "" : m))
      // CHEK-oh-sloh-VAK-ee-ə — a respelling always carries an all-caps run.
      .replace(/\b[A-Z]{2,}(?:[-‐‑‒–—⁠][A-Za-zəɪˈ]+)+/g, "")
      // "Czech: Československo" / "Czech and Slovak: Č…" — the native-name gloss.
      .replace(/\b[A-Z][a-z]+(?:\s+(?:and|or)\s+[A-Z][a-z]+)*:\s*[^;)]+/g, "")
      // Sweep the debris out of each parenthetical.
      //
      // The removals above take the main pronunciation but leave the SECONDARY
      // ones behind as syllable fragments — "(-, -slə-, -VAH-)" is what is left
      // of Czechoslovakia's lead. A fragment is recognisable by leading or
      // trailing with a dash, which no real word does; "Knowles-Carter" and
      // "born 17 October 1974" are untouched because their dashes are interior.
      // If nothing survives, the brackets go too.
      .replace(/\(([^()]*)\)/g, (_m, inner) => {
        const kept = inner
          .split(/\s+/)
          .filter((t) => t && !/^[-‐‑‒–—⁠]/.test(t) && !/[-‐‑‒–—⁠]$/.test(t.replace(/[,;.]+$/, "")))
          .join(" ")
          .replace(/^[\s,;]+|[\s,;]+$/g, "");
        return kept ? `(${kept})` : "";
      })
      // Whatever punctuation all of that stranded.
      .replace(/\(\s*[;,]\s*/g, "(")
      .replace(/[;,]\s*\)/g, ")")
      .replace(/\(\s*\)/g, "")
      .replace(/\s+([,;.])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
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
const COMBINING = /[̀-ͯ]/;
const foldPlain = (s) => s.normalize("NFD").replace(/[̀-ͯ]/gu, "");

// Fold accents for MATCHING only, keeping a map back into the original string
// so the replacement lands on the characters the reader actually sees.
//
// Leads routinely spell the title with diacritics the title itself omits —
// "Vāranāsi" for Varanasi, "Beyoncé" for Beyonce — and a near-copy of the
// answer sitting next to the blank is the one thing a guessing game cannot
// ship. Folded per character on purpose: normalising the whole string at once
// changes its length, and then every index into it is wrong.
function foldWithMap(text) {
  let folded = "";
  const map = []; // folded index -> original index
  for (let i = 0; i < text.length; i++) {
    const f = foldPlain(text[i]);
    for (let k = 0; k < f.length; k++) {
      folded += f[k];
      map.push(i);
    }
  }
  return { folded, map };
}

// Collapse runs of blanks (multi-word titles) into a single blank.
const collapseBlanks = (s) => s.replace(/_____(?:[\s\-–—]+_____)+/g, BLANK);

function blankTitle(text, title) {
  if (!text) return "";
  const source = String(text);
  const { folded, map } = foldWithMap(source);

  // Every pattern runs against the folded copy, so it must be folded too.
  const patterns = [];
  const phrase = foldPlain(String(title).trim());
  if (phrase) patterns.push(new RegExp(escapeRe(phrase) + "s?", "gi"));

  const words = foldPlain(String(title))
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
  for (const w of words) {
    patterns.push(new RegExp("(?<![\\p{L}\\p{N}])" + escapeRe(w) + "s?(?![\\p{L}\\p{N}])", "giu"));
  }

  // Collect every hit as a span in ORIGINAL coordinates.
  const spans = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(folded)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++; // a zero-width match would spin here forever
        continue;
      }
      const start = map[m.index];
      let end = map[m.index + m[0].length - 1] + 1;
      // Swallow any combining marks hanging off the end, or removing "ā" would
      // leave its macron stranded against the blank.
      while (end < source.length && COMBINING.test(source[end])) end++;
      spans.push([start, end]);
    }
  }
  if (!spans.length) return collapseBlanks(source);

  // Merge overlaps — the whole-phrase pattern and the per-word patterns hit the
  // same characters — then replace back to front so earlier indices stay valid.
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  let out = source;
  for (let i = merged.length - 1; i >= 0; i--) {
    out = out.slice(0, merged[i][0]) + BLANK + out.slice(merged[i][1]);
  }
  return collapseBlanks(out);
}

// { full, blanked } — full for the post-round reveal, blanked for the clue.
function buildClue(extract, title, max = 2) {
  const full = firstSentences(extract, max);
  return { full, blanked: blankTitle(full, title) };
}

// stripPronunciation is used by the daily Wikidle puzzle, where a lead is
// metered out a word at a time and a phonetic respelling of the title is a
// straight giveaway. The live text mode shows only a sentence or two and has
// not been switched over — worth doing, but it changes an existing clue's
// wording, so it belongs in its own change rather than riding along with this.
module.exports = { firstSentences, blankTitle, buildClue, stripPronunciation, BLANK };
