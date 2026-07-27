"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

// Env must be set before the app is required.
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.ROUNDS_PER_GAME = "1";
process.env.GUESS_SECONDS = "2";
process.env.REVEAL_SECONDS = "1";
process.env.BOT_FILL_MIN_MS = "200"; // fill almost immediately in tests
process.env.BOT_FILL_MAX_MS = "200";
process.env.MATCH_START_MS = "200"; // and start almost immediately
process.env.DATA_DIR = helpers.tempDataDir();

const { startTestServer, guestSession, connect, once, waitFor } = helpers;
const { titleWords, textFreq } = require("../server/game/scoring");

// Deterministic mystery so the bot has a title/words/freq to work with.
const mockFetch = async () => ({
  title: "Eiffel Tower",
  words: titleWords("Eiffel Tower"),
  img: "http://example.test/i.png",
  desc: "",
  url: "http://example.test/wiki",
  extract: "",
  extractFull: "",
  freq: textFreq("the eiffel tower is an iron lattice tower in paris built by gustave eiffel"),
});

let ctx;
before(async () => { ctx = await startTestServer({ roomOptions: { fetchMystery: mockFetch } }); });
after(async () => { await ctx.close(); });

test("a lone casual player is filled with a bot and plays a full game", async () => {
  const a = await guestSession(ctx.port, "SoloPlayer");
  const sa = connect(ctx.port, a.cookie);
  try {
    await once(sa, "me");

    // Queue casual with nobody else around → a bot should fill in.
    const found = once(sa, "match:found");
    sa.emit("queue:join", { ranked: false, clue: "image", tier: "party" });
    const m = await found;
    assert.equal(m.bot, true, "match:found flags this as a bot fill");
    assert.equal(m.ranked, false);

    // Play through: submit as soon as guessing starts, then the game must finish.
    sa.on("round:start", () => sa.emit("guess:submit", { text: "eiffel tower" }));
    const over = await waitFor(sa, "game:over", () => true, 12000);

    assert.equal(over.standings.length, 2, "both the player and the bot are in the standings");
    assert.equal(over.ranked, false, "casual bot game is not ranked");
    const bot = over.standings.find((p) => p.id.startsWith("bot_"));
    const human = over.standings.find((p) => !p.id.startsWith("bot_"));
    assert.ok(bot, "a bot opponent is in the standings");
    assert.ok(human && human.name.startsWith("SoloPlayer"), "the human is in the standings");
    assert.equal(typeof bot.total, "number", "the bot took a turn and has a score");
  } finally {
    sa.close();
  }
});

test("a casual match with a human present pairs the two humans, not a bot", async () => {
  const a = await guestSession(ctx.port, "HumanA");
  const b = await guestSession(ctx.port, "HumanB");
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  try {
    await Promise.all([once(sa, "me"), once(sb, "me")]);

    const ma = once(sa, "match:found");
    const mb = once(sb, "match:found");
    sa.emit("queue:join", { ranked: false, clue: "text", tier: "chaos" });
    sb.emit("queue:join", { ranked: false, clue: "text", tier: "chaos" });
    const [ra, rb] = await Promise.all([ma, mb]);
    assert.equal(ra.code, rb.code, "the two humans matched each other");
    assert.notEqual(ra.bot, true, "human match is not a bot fill");
  } finally {
    sa.close();
    sb.close();
  }
});
