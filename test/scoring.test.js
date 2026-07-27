"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { scoreGuess, textFreq, titleWords } = require("../server/game/scoring");

function answerOf(title, articleText) {
  return { words: titleWords(title), freq: textFreq(articleText) };
}

test("naming the topic scores high and is credited as a name", () => {
  const answer = answerOf("Polar bear", "The polar bear is a large bear native to the Arctic. Bear.");
  const r = scoreGuess("polar bear", answer);
  assert.equal(r.type, "name");
  assert.ok(r.score >= 90, `expected >=90, got ${r.score}`);
});

test("a near-miss spelling still earns partial naming credit", () => {
  const answer = answerOf("Giraffe", "The giraffe is a tall African mammal.");
  const r = scoreGuess("giraff", answer);
  assert.ok(r.score > 0 && r.score < 100, `expected partial, got ${r.score}`);
});

test("a guess word that appears in the article scores via frequency", () => {
  const answer = answerOf("Something", "mountain mountain mountain climbing peak alpine");
  const r = scoreGuess("mountain", answer);
  assert.equal(r.type, "wiki");
  assert.ok(r.score > 0, `expected >0, got ${r.score}`);
});

test("filler/common words are heavily discounted", () => {
  const common = answerOf("Topic", "located located located located located");
  const meaningful = answerOf("Topic", "volcano volcano volcano volcano volcano");
  const cScore = scoreGuess("located", common).score;
  const mScore = scoreGuess("volcano", meaningful).score;
  assert.ok(mScore > cScore, `meaningful (${mScore}) should beat filler (${cScore})`);
});

test("empty or whitespace guess scores zero", () => {
  const answer = answerOf("Cat", "The cat is a small domesticated feline.");
  assert.equal(scoreGuess("", answer).score, 0);
  assert.equal(scoreGuess("   ", answer).score, 0);
});
