"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { firstSentences, blankTitle, buildClue } = require("../server/game/extract");

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
