"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { updatePair, tierFor, START_RATING } = require("../server/elo");

test("winner gains rating, loser loses rating", () => {
  const r = updatePair({ rating: 1000, gamesPlayed: 0 }, { rating: 1000, gamesPlayed: 0 }, 1);
  assert.ok(r.aDelta > 0, "winner delta should be positive");
  assert.ok(r.bDelta < 0, "loser delta should be negative");
  assert.equal(r.aRating, 1000 + r.aDelta);
  assert.equal(r.bRating, 1000 + r.bDelta);
});

test("a draw between equals barely moves ratings", () => {
  const r = updatePair({ rating: 1200, gamesPlayed: 30 }, { rating: 1200, gamesPlayed: 30 }, 0.5);
  assert.equal(r.aDelta, 0);
  assert.equal(r.bDelta, 0);
});

test("beating a much higher-rated player yields a big gain", () => {
  const underdog = updatePair({ rating: 1000, gamesPlayed: 30 }, { rating: 1600, gamesPlayed: 30 }, 1);
  const expected = updatePair({ rating: 1300, gamesPlayed: 30 }, { rating: 1300, gamesPlayed: 30 }, 1);
  assert.ok(underdog.aDelta > expected.aDelta, "upset should gain more than an even win");
});

test("tier boundaries", () => {
  assert.equal(tierFor(0).name, "Bronze");
  assert.equal(tierFor(START_RATING).name, "Silver"); // 1000
  assert.equal(tierFor(1100).name, "Gold");
  assert.equal(tierFor(2000).name, "Grandmaster");
});
