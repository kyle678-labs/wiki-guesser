"use strict";

// Elo-based ranked matchmaking: the pairing rule on its own, then the whole
// ranked path end to end — queue, pair, play, and the rating write.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("./helpers");

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret";
process.env.REVEAL_SECONDS = "1";
process.env.GUESS_SECONDS = "2";
process.env.MATCH_START_MS = "150";
process.env.MM_TICK_MS = "100"; // sweep fast so the widening window is testable
// Widen 10× faster than production so the "waits, then matches" test costs two
// seconds instead of twenty. The pure-function tests below pass their own opts
// and are unaffected by this.
process.env.MM_GROWTH_PER_SEC = "200";
process.env.DATA_DIR = helpers.tempDataDir();

const config = require("../server/config");
const { startTestServer, guestSession, accountSession, connect, once, waitFor } = helpers;
const { searchWindow, accepts, findPair } = require("../server/matchmaking");
const { titleWords, textFreq } = require("../server/game/scoring");
const { ladderKey } = require("../server/ladders");
const { getRating } = require("../server/db");

// Fixed knobs so the arithmetic in these assertions is readable.
const OPTS = {
  startWindow: 100,
  growthPerSec: 20,
  maxWindow: 1000,
  provisionalBonus: 150,
  provisionalGames: 10,
};

const at = (rating, waitedSec = 0, provisional = false) => ({
  rating,
  provisional,
  enqueuedAt: 1_000_000 - waitedSec * 1000,
  user: { id: `p${rating}` },
});
const NOW = 1_000_000;

// ── The pairing rule ─────────────────────────────────────────────────────────

test("the search window starts tight and widens with the wait", () => {
  assert.equal(searchWindow(at(1000, 0), NOW, OPTS), 100);
  assert.equal(searchWindow(at(1000, 10), NOW, OPTS), 300);
  assert.equal(searchWindow(at(1000, 30), NOW, OPTS), 700);
  assert.equal(searchWindow(at(1000, 300), NOW, OPTS), 1000, "capped at maxWindow");
});

test("provisional players search wider from the moment they queue", () => {
  assert.equal(searchWindow(at(1000, 0, true), NOW, OPTS), 250, "start + provisional bonus");
  assert.ok(
    searchWindow(at(1000, 0, true), NOW, OPTS) > searchWindow(at(1000, 0, false), NOW, OPTS),
    "an unproven rating is matched more loosely than a settled one"
  );
});

test("pairing requires mutual acceptance, not just the waiting player's", () => {
  // A veteran 400 points away has waited long enough to accept anyone; the
  // newcomer has not. Matching them would drag the newcomer into a lopsided
  // game they never agreed to, which is the failure this rule exists to stop.
  const veteran = at(1400, 60);
  const newcomer = at(1000, 0);
  assert.equal(accepts(veteran, newcomer, NOW, OPTS), true, "the veteran would accept");
  assert.equal(accepts(newcomer, veteran, NOW, OPTS), false, "the newcomer would not");
  assert.equal(findPair([veteran, newcomer], NOW, OPTS), null, "so no pair is made");
});

test("a pair forms once both windows have grown to cover the gap", () => {
  // 300 apart: each needs a window of 300, i.e. 10 seconds of waiting.
  assert.equal(findPair([at(1000, 9), at(1300, 9)], NOW, OPTS), null, "not yet");
  const pair = findPair([at(1000, 11), at(1300, 11)], NOW, OPTS);
  assert.ok(pair, "once both windows reach the gap");
  assert.equal(pair.gap, 300);
});

test("the closest legal pair wins, not the first one found", () => {
  // All three mutually acceptable after a long wait; 1000/1050 is the tightest.
  const entries = [at(1000, 60), at(1400, 60), at(1050, 60)];
  const pair = findPair(entries, NOW, OPTS);
  assert.equal(pair.gap, 50);
  assert.deepEqual(
    [entries[pair.i].rating, entries[pair.j].rating].sort(),
    [1000, 1050],
    "picks the two closest players rather than the two that happened to be adjacent"
  );
});

test("an empty or single-player queue yields nothing", () => {
  assert.equal(findPair([], NOW, OPTS), null);
  assert.equal(findPair([at(1000, 99)], NOW, OPTS), null);
});

// ── End to end ───────────────────────────────────────────────────────────────

const MYSTERY = {
  title: "Polar Bear",
  words: titleWords("Polar Bear"),
  img: "http://example.test/img.png",
  desc: "a test topic",
  url: "http://example.test/wiki/Polar_Bear",
  extract: "_____ is a large white bear.",
  extractFull: "Polar Bear is a large white bear.",
  freq: textFreq("The polar bear is a large white bear of the Arctic. Bear bear ice seal."),
};

let ctx;
before(async () => {
  ctx = await startTestServer({
    roomOptions: { fetchMystery: async () => ({ ...MYSTERY, freq: new Map(MYSTERY.freq) }) },
  });
});
after(async () => { await ctx.close(); });

// Ranked runs on the chaos tier only. The tier is deliberately NOT sent here:
// the server decides it, and a client that never mentions a tier is exactly
// what public/js/home.js now does.
const LADDER = ladderKey("image", "chaos");
const joinRanked = (s) => s.emit("queue:join", { ranked: true, clue: "image" });

// The manager keys queues "<kind>:<clue>:<tier>", so the ranked queue for this
// ladder is just "ranked:" plus the ladder key. Derived rather than spelled out:
// a stale hardcoded key returns undefined from queues.get(), and `.length` on
// undefined throws inside an async test, which surfaces as the whole file
// hanging rather than as an obvious mismatch.
const RANKED_QUEUE = `ranked:${LADDER}`;

test("two closely-rated players match immediately", async () => {
  const a = await accountSession(ctx.port, "Close-A", { ratings: { [LADDER]: { rating: 1200 } } });
  const b = await accountSession(ctx.port, "Close-B", { ratings: { [LADDER]: { rating: 1240 } } });
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const found = Promise.all([once(sa, "match:found", 5000), once(sb, "match:found", 5000)]);
  joinRanked(sa);
  joinRanked(sb);
  const [m] = await found;

  assert.equal(m.ranked, true);
  assert.equal(m.ratingGap, 40, "40 points apart, well inside the opening window");

  sa.close();
  sb.close();
});

test("distant players wait, then match once the window has widened", async () => {
  // 500 apart: neither accepts the other at ±100, so this can only happen if the
  // ticker re-sweeps as the windows grow. Settled ratings, so no provisional
  // bonus is doing the work.
  const a = await accountSession(ctx.port, "Far-A", { ratings: { [LADDER]: { rating: 900 } } });
  const b = await accountSession(ctx.port, "Far-B", { ratings: { [LADDER]: { rating: 1400 } } });
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const waiting = once(sa, "queue:waiting", 5000);
  joinRanked(sa);
  joinRanked(sb);
  const first = await waiting;
  assert.equal(first.window, 100, "opens at the tight window");
  assert.equal(first.rating, 900, "matched on this ladder's rating");

  // Not paired yet — the gap is far outside the opening window.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ctx.manager.queues.get(RANKED_QUEUE).length, 2, "still waiting");

  // The status ticks with a wider window as the wait grows.
  const widened = await waitFor(sa, "queue:status", (s) => s.window > 100, 5000);
  assert.ok(widened.waitedMs > 0);

  const found = await once(sa, "match:found", 20000);
  assert.equal(found.ratingGap, 500, "eventually paired despite the gap");

  sa.close();
  sb.close();
});

test("a ranked match writes Elo to the right ladder and leaves the others alone", async () => {
  const a = await accountSession(ctx.port, "Elo-A", { ratings: { [LADDER]: { rating: 1200 } } });
  const b = await accountSession(ctx.port, "Elo-B", { ratings: { [LADDER]: { rating: 1200 } } });
  const sa = connect(ctx.port, a.cookie);
  const sb = connect(ctx.port, b.cookie);
  await Promise.all([once(sa, "me"), once(sb, "me")]);

  const found = Promise.all([once(sa, "match:found", 5000), once(sb, "match:found", 5000)]);
  joinRanked(sa);
  joinRanked(sb);
  const [{ code }] = await found;
  ctx.manager.rooms.get(code).settings.rounds = 1;

  const over = Promise.all([once(sa, "game:over", 20000), once(sb, "game:over", 20000)]);
  await Promise.all([once(sa, "round:start", 15000), once(sb, "round:start", 15000)]);
  sa.emit("guess:submit", { text: "polar bear" }); // names it
  sb.emit("guess:submit", { text: "zzzzz" }); // scores nothing
  const [result] = await over;

  assert.equal(result.ranked, true);
  assert.equal(result.ratingChanges.mode, LADDER);
  assert.ok(result.ratingChanges[a.id].delta > 0, "the winner gains");
  assert.ok(result.ratingChanges[b.id].delta < 0, "the loser drops");

  // Persisted, on that ladder only.
  assert.ok(getRating(a.user.id, LADDER).rating > 1200, "winner's rating written");
  assert.equal(getRating(a.user.id, ladderKey("text", "chaos")).rating, 1000, "other ladders untouched");

  sa.close();
  sb.close();
});

test("guests are still refused, and a lone ranked player is not given a bot", async () => {
  const guest = await guestSession(ctx.port, "Tag-Along");
  const sg = connect(ctx.port, guest.cookie);
  await once(sg, "me");
  joinRanked(sg);
  const err = await once(sg, "room:error", 5000);
  assert.match(err.message, /sign in/i);

  // A rating has to be won against a person, so ranked never bot-fills — even
  // though casual would have done so by now.
  const solo = await accountSession(ctx.port, "Solo", { ratings: { [LADDER]: { rating: 1000 } } });
  const ss = connect(ctx.port, solo.cookie);
  await once(ss, "me");
  joinRanked(ss);
  let matched = false;
  ss.on("match:found", () => (matched = true));
  await new Promise((r) => setTimeout(r, 900)); // well past the casual bot-fill window
  assert.equal(matched, false, "no bot opponent in ranked");
  assert.equal(ctx.manager.queues.get(RANKED_QUEUE).length, 1, "still queued alone");

  sg.close();
  ss.close();
});

test("a ranked player who finds nobody is told, not left spinning", async () => {
  // On a small ladder at a quiet hour there may genuinely be no opponent, and an
  // indefinite spinner is the worst way to say so.
  const original = config.matchmaking.rankedTimeoutMs;
  config.matchmaking.rankedTimeoutMs = 400;
  try {
    const solo = await accountSession(ctx.port, "Patient", { ratings: { [LADDER]: { rating: 1000 } } });
    const s = connect(ctx.port, solo.cookie);
    await once(s, "me");

    joinRanked(s);
    const timedOut = await once(s, "queue:timeout", 5000);

    assert.equal(timedOut.kind, "ranked");
    assert.ok(timedOut.waitedMs >= 400);
    assert.equal(ctx.manager.queues.get(RANKED_QUEUE).length, 0, "and removed from the queue");

    s.close();
  } finally {
    config.matchmaking.rankedTimeoutMs = original;
  }
});

test("the ranked ticker stops when the last player leaves the queue", async () => {
  const solo = await accountSession(ctx.port, "Ticker", { ratings: { [LADDER]: { rating: 1000 } } });
  const s = connect(ctx.port, solo.cookie);
  await once(s, "me");

  joinRanked(s);
  await once(s, "queue:waiting", 5000);
  assert.ok(ctx.manager.rankedTicker, "ticking while someone waits");

  s.emit("queue:leave");
  await once(s, "queue:left", 5000);
  assert.equal(ctx.manager.rankedTicker, null, "an idle server does no matchmaking work");

  s.close();
});

// ── Which ladders ranked will accept ─────────────────────────────────────────
// queue:join is a socket event, so the picker in the browser is decoration, not
// enforcement. A hand-rolled client — or one running yesterday's cached JS —
// can ask for any combination it likes, and an unguarded server would happily
// mint Elo on a ladder nobody else queues for. That is a free rating, so these
// assert the server's own refusal rather than what the UI offers.

test("ranked refuses a clue type that has no ladder", async () => {
  const a = await accountSession(ctx.port, "Mixed-Seeker");
  const sa = connect(ctx.port, a.cookie);
  await once(sa, "me");

  const err = once(sa, "room:error");
  sa.emit("queue:join", { ranked: true, clue: "mixed" });
  const e = await err;
  // Refused, not quietly rerouted: pictures and descriptions are different
  // games, so moving someone off the one they picked would be worse than no.
  assert.match(e.message, /casual and private/i, `got: ${e.message}`);

  sa.close();
});

test("ranked pins a stale tier request onto the ranked tier", async () => {
  const a = await accountSession(ctx.port, "Party-Seeker");
  const sa = connect(ctx.port, a.cookie);
  await once(sa, "me");

  const waiting = once(sa, "queue:waiting");
  // What a browser with the previous release's JS still sends.
  sa.emit("queue:join", { ranked: true, clue: "image", tier: "party" });
  const w = await waiting;

  // Forced rather than refused: there is one ranked tier, so the request cannot
  // have expressed a preference between alternatives. The response has to say
  // what is actually being searched, or the queue banner lies about the game.
  assert.equal(w.tier, "chaos", "a party request must land on the ranked tier");
  assert.equal(w.clue, "image");

  sa.emit("queue:leave");
  sa.close();
});

test("mixed and party remain playable in casual", async () => {
  const a = await accountSession(ctx.port, "Casual-Mixed");
  const sa = connect(ctx.port, a.cookie);
  await once(sa, "me");

  // Narrowing ranked must not narrow the game. Casual keeps every clue type and
  // both tiers; that is the whole point of confining the change to the ladders.
  const waiting = once(sa, "queue:waiting");
  sa.emit("queue:join", { ranked: false, clue: "mixed", tier: "party" });
  const w = await waiting;
  assert.equal(w.clue, "mixed", "casual must still accept the combined clue");
  assert.equal(w.tier, "party", "casual must still accept the party tier");

  sa.emit("queue:leave");
  sa.close();
});
