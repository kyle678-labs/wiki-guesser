"use strict";

// Article categories: the offline classifier, and the room setting that uses it.
//
// The classifier runs once at build time over ~7M articles and its output is
// then frozen into a 900 MB artifact, so a rule that is subtly wrong is
// expensive to discover — these tests pin the behaviours that are easy to break
// and hard to notice, particularly the template-name normalisation.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  CATEGORIES,
  CATEGORY_LABELS,
  BIT,
  classify,
  normalizeCategories,
  maskFor,
  normalizeTemplate,
} = require("../server/game/categories");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.DATA_DIR = require("./helpers").tempDataDir();
const { Room } = require("../server/rooms");

const has = (mask, cat) => (mask & BIT[cat]) !== 0;

// ── Template normalisation ───────────────────────────────────────────────────
// The dump is full of sub-templates. Every one of these forms appears in the
// real CirrusSearch data and all must collapse to the same rule.

test("template names normalise past the Template: prefix and sub-pages", () => {
  assert.equal(normalizeTemplate("Template:Infobox film"), "infobox film");
  assert.equal(normalizeTemplate("Template:Infobox musical artist/color"), "infobox musical artist");
  assert.equal(normalizeTemplate("Template:Infobox settlement/styles.css"), "infobox settlement");
  assert.equal(normalizeTemplate("INFOBOX FILM"), "infobox film");
  assert.equal(normalizeTemplate(null), "");
});

test("a sub-template alone still classifies the article", () => {
  // Articles frequently list "Infobox settlement/styles.css" without the bare
  // name. Matching only the exact name would silently lose them.
  const mask = classify(["Template:Infobox settlement/areadisp"], []);
  assert.ok(has(mask, "places"));
});

// ── Template rules ───────────────────────────────────────────────────────────

test("infoboxes map to the categories a player would expect", () => {
  assert.ok(has(classify(["Template:Infobox film"], []), "film"));
  assert.ok(has(classify(["Template:Speciesbox"], []), "nature"));
  assert.ok(has(classify(["Template:Automatic taxobox"], []), "nature"));
  assert.ok(has(classify(["Template:Infobox video game"], []), "games"));
  assert.ok(has(classify(["Template:Infobox album"], []), "music"));
  assert.ok(has(classify(["Template:Infobox person"], []), "people"));
  assert.ok(has(classify(["Template:Infobox automobile"], []), "tech"));
});

test("an article can land in several categories at once", () => {
  // A footballer is a person AND a sportsperson; filtering on either should
  // find them, which is the whole reason the mask is multi-label.
  const mask = classify(["Template:Infobox football biography", "Template:Infobox person"], []);
  assert.ok(has(mask, "sport"));
  assert.ok(has(mask, "people"));
});

test("the generic bare Infobox classifies nothing", () => {
  // It is the single most common template in the dump (~85k in 150k articles).
  // Treating it as a signal would put most of Wikipedia in one bucket.
  assert.equal(classify(["Template:Infobox"], []), 0);
  assert.equal(classify(["Template:Short description", "Template:Pagetype"], []), 0);
});

// ── Category rules ───────────────────────────────────────────────────────────

test("biography categories catch people whose infobox we do not list", () => {
  // "Living people" and "1962 births" are near-perfect biography markers and
  // cover the long tail of specialised person infoboxes.
  assert.ok(has(classify([], ["Living people"]), "people"));
  assert.ok(has(classify([], ["1962 births"]), "people"));
  assert.ok(has(classify([], ["1840s deaths"]), "people"));
});

test("category rules add to a template match rather than replacing it", () => {
  const mask = classify(["Template:Infobox football biography"], ["Living people"]);
  assert.ok(has(mask, "sport"), "the template signal survives");
  assert.ok(has(mask, "people"), "and the category adds the one it missed");
});

test("reality-TV participants are people, not Film & TV", () => {
  // The regression this guards: an unanchored /television series$/ also matches
  // "Participants in American reality television series", which measured on the
  // real pool put 6% of Film & TV — Katy Perry, Ozzy Osbourne — into a category
  // no player would look for them in.
  const perry = classify([], [
    "American women pop singers",
    "Participants in American reality television series",
    "Living people",
  ]);
  assert.ok(has(perry, "people"));
  assert.ok(!has(perry, "film"), "a person who appeared on a show is not a show");

  // Real shows must still classify, by either signal.
  assert.ok(has(classify([], ["2019 American television series debuts"]), "film"));
  assert.ok(has(classify(["Template:Infobox television"], []), "film"));
});

test("maintenance categories are ignored", () => {
  // These decorate nearly every article; matching any of them would be fatal.
  const junk = [
    "Articles with short description",
    "Short description is different from Wikidata",
    "Wikipedia indefinitely semi-protected pages",
    "Use dmy dates from September 2019",
    "All Wikipedia articles in need of updating",
  ];
  assert.equal(classify([], junk), 0);
});

test("an article with no usable signal is left unclassified", () => {
  // Concept articles genuinely have no infobox. They stay in the pool and are
  // served in unfiltered games; they simply cannot be selected by category.
  assert.equal(classify([], []), 0);
  assert.equal(classify(undefined, undefined), 0);
});

// ── Runtime helpers ──────────────────────────────────────────────────────────

test("category lists are validated against the allowlist", () => {
  // Output follows CATEGORIES declaration order, not input order — that is what
  // makes the stored setting stable regardless of the order boxes were ticked.
  assert.deepEqual(normalizeCategories(["film", "nature"]), ["nature", "film"]);
  assert.deepEqual(normalizeCategories(["film", "not-a-category", ""]), ["film"]);
  assert.deepEqual(normalizeCategories("film"), [], "a bare string is not a list");
  assert.deepEqual(normalizeCategories(null), []);
});

test("normalisation is order-stable and de-duplicated", () => {
  // The stored setting must not depend on click order, or two identical rooms
  // would render their pickers differently.
  assert.deepEqual(normalizeCategories(["nature", "film", "nature"]), normalizeCategories(["film", "nature"]));
});

test("an empty selection is a zero mask, meaning no filter", () => {
  assert.equal(maskFor([]), 0);
  assert.equal(maskFor(["nonsense"]), 0);
  assert.equal(maskFor(["film"]), BIT.film);
  assert.equal(maskFor(["film", "music"]), BIT.film | BIT.music);
});

test("every category has a label and a distinct bit", () => {
  const bits = new Set();
  for (const c of CATEGORIES) {
    assert.ok(CATEGORY_LABELS[c], `${c} needs a player-facing label`);
    assert.ok(BIT[c] > 0);
    assert.ok(!bits.has(BIT[c]), `${c} must not share a bit`);
    bits.add(BIT[c]);
  }
  // The mask is a 32-bit JS integer; going over would silently corrupt it.
  assert.ok(CATEGORIES.length <= 30);
});

// ── Room setting ─────────────────────────────────────────────────────────────

function bareRoom(overrides = {}) {
  const io = { to: () => ({ emit: () => {} }) };
  return new Room(io, { locate: new Map(), rooms: new Map() }, { code: "TESTS", isPrivate: true, hostId: "u1", ...overrides });
}

test("a room defaults to no category filter", () => {
  assert.deepEqual(bareRoom().settings.categories, []);
});

test("the host can set and clear categories", () => {
  const room = bareRoom();
  assert.equal(room.updateSettings("u1", { categories: ["film", "music"] }).ok, true);
  assert.deepEqual(room.settings.categories, ["film", "music"]);
  room.updateSettings("u1", { categories: [] });
  assert.deepEqual(room.settings.categories, []);
});

test("junk categories are dropped rather than stored", () => {
  const room = bareRoom();
  room.updateSettings("u1", { categories: ["film", "'; DROP TABLE mysteries; --", 42] });
  assert.deepEqual(room.settings.categories, ["film"]);
});

test("only the host can change categories, and never in a matchmaking room", () => {
  const room = bareRoom();
  assert.ok(room.updateSettings("u2", { categories: ["film"] }).error);
  assert.deepEqual(room.settings.categories, []);

  // Ranked ladders must stay comparable, so the pool cannot vary per match.
  const ranked = bareRoom({ isPrivate: false });
  assert.ok(ranked.updateSettings("u1", { categories: ["film"] }).error);
  assert.deepEqual(ranked.settings.categories, []);
});

test("the room passes its categories to the mystery source", async () => {
  const room = bareRoom();
  room.updateSettings("u1", { categories: ["nature"] });

  let sawCategories = null;
  room.manager.fetchMystery = async (tier, used, clue, categories) => {
    sawCategories = categories;
    return { title: "Otter", words: ["otter"], img: null, extract: "", freq: new Map() };
  };
  room.players.set("u1", { id: "u1", connected: true, total: 0 });
  try {
    await room.nextRound();
    assert.deepEqual(sawCategories, ["nature"], "a category filter that never reaches the pool does nothing");
  } finally {
    // nextRound arms the guess timer before it returns, and that timer chains
    // into the next round. Without this the file runs a whole 5-round game in
    // real time and the test process never exits.
    room.dispose();
  }
});
