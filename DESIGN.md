# Wiki-Guesser — Design & Specs

Architecture and current specifications. For setup/usage see [README.md](README.md).

## Overview

A multiplayer "guess the Wikipedia article" game. A mystery clue (an image, or the
article's opening sentences with the title blanked) appears; players race to name
the topic — or land scoring words from its article — before the timer. Highest
total after all rounds wins.

Modes of play: **ranked** matchmaking (Elo, account required), **casual** quick
match (guests welcome, filled by a practice bot if no human joins), and **private
rooms** (share a code, up to 8 players).

The defining architectural choice: **all mysteries are served from a local,
pre-built SQLite pool — there are zero live Wikipedia API calls at play time.**
(Article images are still loaded by the player's browser directly from Wikimedia's
CDN; they never touch our server.)

## Stack & layout

Node + Express + Socket.IO, a **single stateful process**, SQLite via
`better-sqlite3` (synchronous). Rooms and matchmaking queues live in memory.

```
server/
  index.js        bootstrap + listen
  app.js          Express + Socket.IO wiring, HTTP APIs, static hosting
  config.js       env-driven configuration (all knobs)
  db.js           SQLite: users, ratings, matches (+ session store)
  auth.js         Passport Google/Discord OAuth + guest identity
  elo.js          Elo math + rank tiers
  modes.js        clue modes: image | text | mixed
  tiers.js        topic tiers: party | chaos
  ladders.js      ranked ladder key = "<clue>:<tier>" (6 ladders)
  rooms.js        Room engine (round loop) + matchmaking manager + bot-fill
  socket.js       Socket.IO event wiring
  bot.js          practice bot (identity, guess logic, timing)
  log.js          structured JSON logging (one object per line, stdout/stderr)
  ratelimit.js    token buckets for Socket.IO events
  shutdown.js     graceful drain on SIGTERM (factored out so it's testable)
  game/
    pool.js       offline mystery source (reads the SQLite pool)
    scoring.js    pure scoring engine (naming + article-word hits)
    extract.js    builds the blanked "description" clue
    wikipedia.js  legacy live-API source (fallback; unused by default)
public/           index.html (lobby+leaderboard), play.html (room), js/, css/
scripts/
  build-mysteries.js          builds the offline pool from Wikimedia dumps
  migrate-ratings-to-tiers.js one-off ratings migration to ladder keys
data/
  wiki-guesser.sqlite       users / ratings / matches / sessions
  mysteries*.sqlite        the offline mystery pool (see below)
```

## The mystery pool

The heart of the offline design. One row = one self-contained, playable mystery.

**Built** by `scripts/build-mysteries.js` from two Wikimedia dumps (streamed, never
fully decompressed to disk):
- **CirrusSearch content dump** → `title`, `opening_text`, `text`, `incoming_links`,
  `popularity_score`.
- **`page_props` SQL dump** → `page_image_free` (lead-image filename).

**`mysteries` table:**

| column | purpose |
|---|---|
| `page_id` (PK) | Wikipedia id; also the "used this game" key |
| `title` | the answer |
| `image_name` | raw Commons filename (regenerate other thumb sizes from this) |
| `image_url` | **500px** thumbnail URL, or NULL — the image-mode clue |
| `opening_text` | cleaned lead sentences, or NULL — the text-mode clue |
| `freq_json` | `{stem: count}` top-60 article words — offline article-hit scoring |
| `incoming_links` | link count (kept for analysis; not used for tiers) |
| `popularity` | ≈ relative pageviews — **the tier / guessability knob** |
| `word_count` | title word count (build filter) |
| `rnd` | random ∈ [0,1) — fast random selection |

Indexes: `idx_links`, and partial `idx_img_rnd` / `idx_txt_rnd` on `rnd`.

**Filters at build time:** namespace 0 only; title 1–3 words, alphabetic, no
"List of…"; must have an image or ≥40 chars of opening text. A popularity floor
(`--max-pool`, default = the chaos threshold) drops the obscure long tail.

**Image URLs are constructed offline** from the filename via Wikimedia's MD5 path
scheme, at 500px (an allowed Wikimedia thumbnail bucket — arbitrary widths 400).
The browser loads them from `upload.wikimedia.org`; a small % may 404 (stale dump)
and should be handled client-side.

**Fast random pick** (`pool.js`): pick a random `rnd`, take the first indexed row
past it that also clears the tier's popularity floor (wrap to 0 if none). Walks
~1/selectivity rows instead of an `ORDER BY RANDOM()` full scan → single-digit ms.

**Two builds** (select via `MYSTERY_DB`):
- **Full:** ~4.76M rows, ~11 GB.
- **Lean** (`--max-pool` at the chaos floor, the default): ~436k rows, **~908 MB** —
  fits in 2 GB RAM. Party & chaos are identical to the full build; only the deep
  long tail is dropped. **This is the deploy artifact.**

## Clue modes, tiers, ladders

- **Clue mode** (`modes.js`): `image` (guess from picture), `text` (guess from the
  blanked opening sentences), `mixed` (each round randomly one or the other).
- **Topic tier** (`tiers.js`): `party` (`popularity ≥ 1e-5`, ~top 0.1%, household
  names) and `chaos` (`popularity ≥ 2e-7` = the whole lean pool). Thresholds:
  `PARTY_MIN_POP` / `CHAOS_MIN_POP`.
- **Ranked ladder** (`ladders.js`): every (clue × tier) pair is its own Elo ladder,
  keyed `"<clue>:<tier>"` (e.g. `image:chaos`) → **6 ladders**. Ratings live in the
  `ratings` table keyed by `(user_id, mode)` where `mode` is the ladder key. The
  leaderboard picks a clue + tier (`/api/leaderboard?clue=&tier=`).

## Scoring (`game/scoring.js`)

Each guess earns the **higher** of two accuracy scores:
1. **Naming it** — letter-similarity of guess words vs. the answer's title words
   (0–100). Near-misses earn partial credit; synonym groups map everyday words to
   Wikipedia terms.
2. **Article-word hits** — guess words appearing in the article score on a logistic
   curve by frequency (caps at 85). Filler/common words are discounted to 12%.

A **speed bonus** (up to `SPEED_BONUS_MAX` = 30) is added on top of any scoring
guess, decaying from full (instant) to 0 (timer expiry). Wrong/empty guess = 0.

## Elo (`elo.js`)

1v1 per ladder. Start 1000; K-factor 40 (provisional, <10 games), 24, or 16 (≥2100).
Rank tiers by rating: Bronze / Silver (900) / Gold (1100) / Platinum (1300) /
Diamond (1500) / Master (1750) / Grandmaster (2000).

## Rooms & matchmaking (`rooms.js`)

**Room lifecycle:** `lobby → loading → guessing → reveal → done`, looping per round.
Reconnect grace window; if a game can't be contested it forfeits to whoever stayed.
Non-private rooms self-dispose 60s after game over (tracked timer).

**Matchmaking queues** are split by **kind × clue × tier**, so you only match
someone who chose the same thing. Ranked requires an account. On a match, both land
in a room that starts after `MATCH_START_MS` (2500 ms).

**Casual bot-fill:** a lone casual player who isn't matched within
`BOT_FILL_MIN_MS…BOT_FILL_MAX_MS` (5–10 s) is paired with a practice bot. Ranked and
private rooms never get a bot.

## Practice bot (`bot.js`)

A socket-less player; the room schedules its guess each round after a human-like
delay. A single dial **`BOT_SKILL` ∈ [0,1]** (default 0.5) shapes play:
- **Names the answer** with probability `0.4 × skill` (≈20% at 0.5, ≈40% at 1).
- Otherwise **whiffs** (0 points) with probability `0.6 × (1 − skill)` (≈30% at 0.5,
  0% at 1) — the main "beatable" lever.
- Otherwise **guesses a real article word** (from `freq`, excluding title words,
  filler, numbers/dates); skill picks how far down the strength-ranked list to reach
  (high skill → frequent/high-scoring, low skill → rare/low-scoring).

Approx. avg points/round: skill 0.25 → ~44, **0.5 → ~60**, 1.0 → ~87.

## Configuration (`config.js` / `.env`)

| Var | Default | Meaning |
|---|---|---|
| `PORT` / `BASE_URL` | 3000 / localhost | listen port / public origin |
| `SESSION_SECRET` | — | session cookie signing |
| `NODE_ENV` | development | `production` ⇒ secure cookies |
| `GOOGLE_*` / `DISCORD_*` | — | OAuth (ranked identity) |
| `ADSENSE_CLIENT` / `_SLOT` | — | optional ad slots |
| `MYSTERY_DB` | `data/mysteries.sqlite` | which pool to serve (set to the lean DB) |
| `PARTY_MIN_POP` / `CHAOS_MIN_POP` | 1e-5 / 2e-7 | tier popularity floors |
| `ROUNDS_PER_GAME` | 5 | rounds per game |
| `GUESS_SECONDS` | 20 | guessing window |
| `REVEAL_SECONDS` | 8 | reveal between rounds |
| `SPEED_BONUS_MAX` | 30 | max speed bonus |
| `GRACE_MS` | 12000 | reconnect grace |
| `BOT_FILL` / `_MIN_MS` / `_MAX_MS` | on / 5000 / 10000 | casual bot-fill window (`BOT_FILL=false` disables) |
| `MATCH_START_MS` | 2500 | delay from match-found to game start |
| `BOT_SKILL` | 0.5 | practice-bot difficulty, 0…1 |
| `LOG_LEVEL` | info | debug\|info\|warn\|error\|silent |
| `RATE_WINDOW_MS` | 900000 | HTTP rate-limit window |
| `RATE_LIMIT_AUTH` / `_API` | 30 / 300 | per-IP requests per window |
| `SHUTDOWN_GRACE_MS` | 10000 | SIGTERM drain deadline |

## Operational hardening

The game logic assumes a cooperative client and a process that stays up; these
are the pieces that make that assumption safe to expose to the internet.

**Fail-fast config.** `SESSION_SECRET` in production must be present, not the
in-repo placeholder, and ≥32 chars — otherwise `config.js` throws at require
time. A crash-looping deploy is cheaper than a live one signing sessions with a
publicly known key.

**Error containment.** `nextRound()` is async but every caller is a timer or a
socket handler, so an unhandled rejection would terminate the process and every
concurrent game with it. `safeNextRound()` catches, logs, and parks the room back
in its lobby. Ranked rating writes are wrapped separately: losing one ladder
update beats killing a live server on `SQLITE_BUSY`.

**Rate limits.** Two layers, because the expensive actions arrive over different
transports. HTTP (`express-rate-limit`, per IP) covers `/auth` — `POST
/auth/guest` mints a session and writes a row — and `/api`. Sockets use per-socket
token buckets (`ratelimit.js`) on the events that allocate or broadcast:
`room:create`, `room:join` (which also throttles room-code guessing), `queue:join`,
`chat:send`, `guess:submit`, `room:settings`. Buckets die with the socket.

**CSP.** `script-src 'self'` with no nonce or hash — the theme bootstrap lives in
`public/js/theme.js` rather than inline specifically to make that possible.
`style-src` keeps `'unsafe-inline'` for the markup's `style=""` attributes.
`img-src` allowlists Wikimedia and the OAuth avatar CDNs. Google's ad hosts are
added to `script-src`/`frame-src`/`img-src` **only when AdSense is configured**.

**Shutdown.** SIGTERM notifies players, clears every room timer, then closes
Socket.IO — which disconnects sockets *and* the HTTP server. Order matters:
`server.close()` waits for open connections, and a WebSocket never ends on its
own, so closing the HTTP server first deadlocks until the force-exit deadline.

## Deployment & capacity

Single long-running process (WebSockets — **not** serverless). SQLite must be on a
**local disk**; S3 is only the artifact store (build the pool, push to S3, pull to
the instance's disk at deploy; queries run against the local copy).

- **Bottleneck:** synchronous SQLite reads block the single event loop, and the DB
  must fit in RAM or party-tier picks stall on disk seeks. The **lean ~908 MB DB in
  ≥2 GB RAM** keeps every read warm.
- **Sizing:** a ~$10/mo box (Lightsail 2 GB, or `t4g.small`) comfortably serves a
  few hundred concurrent players. The full 11 GB DB would need ~16 GB RAM (~$60+/mo)
  for no gameplay benefit — hence the lean build is the deploy artifact.
- **Bandwidth is negligible** (small JSON; images on Wikimedia's CDN). Put
  Cloudflare's free tier in front for TLS + static caching + DDoS. No load balancer.

## Testing

`npm test` (Node's built-in runner, no framework). Covers scoring, Elo, per-ladder
ratings/leaderboard, matchmaking (incl. tier splitting), a full private game, the
description clue, and casual bot-fill. The Wikipedia source is dependency-injected
so tests need no network or pool DB.
