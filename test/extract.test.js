"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { firstSentences, blankTitle, buildClue, stripPronunciation } = require("../server/game/extract");

test("firstSentences returns the first N sentences, whitespace-normalised", () => {
  const t = "The polar bear is a bear.  It lives in the Arctic. It is large.";
  assert.equal(firstSentences(t, 2), "The polar bear is a bear. It lives in the Arctic.");
  assert.equal(firstSentences(t, 1), "The polar bear is a bear.");
});

test("blankTitle hides the whole title and each of its words", () => {
  const out = blankTitle("The polar bear is a large bear native to the Arctic.", "Polar bear");
  assert.ok(!/polar/i.test(out), "'polar' should be blanked");
  assert.ok(!/\bbear\b/i.test(out), "'bear' should be blanked");
  assert.ok(out.includes("_____"), "a blank should be present");
  assert.ok(/Arctic/.test(out), "unrelated words remain");
});

test("blankTitle handles a single-word title and its plural", () => {
  const out = blankTitle("Sushi is a dish. Many sushis are served worldwide.", "Sushi");
  assert.ok(!/sushi/i.test(out), "all forms of the title word are blanked");
  assert.ok(/dish/.test(out));
});

test("blankTitle collapses adjacent blanks from multi-word titles", () => {
  const out = blankTitle("The Eiffel Tower is in Paris.", "Eiffel Tower");
  assert.ok(!/eiffel/i.test(out) && !/tower/i.test(out));
  assert.equal((out.match(/_____/g) || []).length, 1, "consecutive blanks collapse to one");
  assert.ok(/Paris/.test(out));
});

test("buildClue returns both the full sentence and the blanked clue", () => {
  const { full, blanked } = buildClue("The Eiffel Tower is a tower in Paris. It is tall.", "Eiffel Tower", 1);
  assert.equal(full, "The Eiffel Tower is a tower in Paris.");
  assert.ok(!/eiffel/i.test(blanked) && !/tower/i.test(blanked));
  assert.ok(/Paris/.test(blanked));
});

// ── Pronunciation apparatus ──────────────────────────────────────────────────
// A Wikipedia lead opens by spelling its own subject out phonetically, and
// often in its native language too. In the daily Wikidle puzzle the clue is
// metered a word at a time, so that block is both the answer and a dozen wasted
// words. These assert it goes without taking real clues with it.

test("stripPronunciation removes IPA, respellings and native-name glosses", () => {
  const lead =
    "Czechoslovakia (/ˌtʃɛkoʊsloʊˈvæki.ə, ˈtʃɛkə-/ CHEK-oh-sloh-VAK-ee-ə; " +
    "Czech and Slovak: Československo) was a country in Central Europe.";
  const out = stripPronunciation(lead);
  assert.doesNotMatch(out, /ˈ|ˌ|tʃ/, "IPA must go");
  assert.doesNotMatch(out, /CHEK/, "the respelling spells the answer out loud");
  assert.doesNotMatch(out, /Československo/, "so does the native-language name");
  assert.match(out, /was a country in Central Europe/, "the actual clue survives");
});

test("stripPronunciation keeps a birth date sharing brackets with the IPA", () => {
  // Biographies put both in one parenthetical, so dropping whole brackets would
  // throw away a real clue to save us from a phonetic one.
  const out = stripPronunciation("Matthew Macfadyen (/məkˈfædiən/; born 17 October 1974) is an English actor.");
  assert.doesNotMatch(out, /məkˈfædiən/);
  assert.match(out, /born 17 October 1974/, "the date is a clue worth keeping");
});

test("stripPronunciation leaves slashes that are not phonetic alone", () => {
  const text = "The ratio was 3/4 and the date 12/06 stayed put.";
  assert.equal(stripPronunciation(text), text);
});

// ── Accent folding ───────────────────────────────────────────────────────────

test("blankTitle hides a title the text spells with diacritics", () => {
  // The lead writes "Vāranāsi" where the title is "Varanasi". Matching on the
  // raw characters leaves a near-copy of the answer beside the blank.
  const out = blankTitle("Varanasi (stylized onscreen as Vāranāsi) is a film.", "Varanasi");
  assert.doesNotMatch(out, /V[āa]ran[āa]si/i, "no spelling of the title may survive");
  assert.match(out, /stylized onscreen as/, "the surrounding text is untouched");
});

test("blankTitle leaves no stranded combining marks behind", () => {
  const out = blankTitle("Beyoncé Giselle Knowles-Carter is a singer.", "Beyonce");
  assert.doesNotMatch(out, /[\u0300-\u036f]/, "an orphaned accent would sit against the blank");
  assert.match(out, /^_____ Giselle/);
});
