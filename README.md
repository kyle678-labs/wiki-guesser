# 🧠 Wiki-Guesser

A standalone, multiplayer version of the Wikipedia image-guessing game. A mystery
Wikipedia image appears; players race to name the topic — or fish scoring words
from its article — before the timer runs out. Highest total after all rounds wins.

- **Ranked matches** — random 1-on-1 matchmaking with an Elo ladder and tiers.
- **Casual quick match** — instant random matchup, no rating on the line (guests welcome).
- **Private rooms** — create a room, share a link, play with up to 8 friends.
- **Ads** — optional Google AdSense slots to cover server costs.

Built with Node + Express + Socket.IO and SQLite. The answer and scoring live on
the server, so the mystery can't be peeked at in the browser.

## Quick start

```bash
cd wiki-guesser
cp .env.example .env      # then edit .env (see below)
npm install
npm start                 # http://localhost:3000
```

Open two browser windows (one in a private/incognito window so they get separate
sessions), set a guest name in each, create a private room in one, and join with
the code in the other to try a full multiplayer round.

> Requires **Node 18.17+** (uses the built-in `fetch`). `better-sqlite3` compiles a
> native module on install — on Windows you may need the "Desktop development with
> C++" workload from Visual Studio Build Tools if a prebuilt binary isn't available.

## Configuration (`.env`)

| Variable | What it does |
| --- | --- |
| `PORT` / `BASE_URL` | Where the server listens / its public origin (used for OAuth callbacks + share links). |
| `SESSION_SECRET` | Signs session cookies. Generate a long random string. **Required in production** — the server refuses to boot without a strong one. |
| `NODE_ENV` | `production` enables secure cookies + HSTS (serve over HTTPS). |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error`\|`silent`. JSON logs on stdout. Default `info`. |
| `RATE_LIMIT_AUTH` / `RATE_LIMIT_API` / `RATE_WINDOW_MS` | Per-IP HTTP rate limits. |
| `MAX_SOCKETS_PER_IDENTITY` | Simultaneous socket connections one identity may hold (default 6). Socket rate limits are per socket, so this is what caps them per player. |
| `MM_START_WINDOW` / `MM_GROWTH_PER_SEC` / `MM_MAX_WINDOW` | Ranked search window: how close an opponent must be, and how fast that loosens while you wait. |
| `MM_PROVISIONAL_BONUS` / `MM_PROVISIONAL_GAMES` | Extra search width for players whose rating isn't settled yet. |
| `MM_TICK_MS` / `MM_RANKED_TIMEOUT_MS` | How often ranked queues re-sweep; how long before a fruitless search gives up. |
| `INACTIVE_PURGE_MONTHS` / `INACTIVE_PURGE_INTERVAL_MS` / `INACTIVE_PURGE` | Automatic deletion of dormant accounts. Keep the months in step with `public/privacy.html`. |
| `SHUTDOWN_GRACE_MS` | How long SIGTERM waits for games to drain before forcing the exit. |
| `PRELOAD_PARTY` / `PARTY_PRELOAD_MAX_ROWS` | Hold the party tier in memory (default on) — it removes the app's biggest event-loop stall. |
| `LEADERBOARD_TTL_MS` / `METRICS_INTERVAL_MS` | Leaderboard cache TTL; how often the metrics line is logged. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth. Redirect URI: `{BASE_URL}/auth/google/callback`. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord OAuth. Redirect URI: `{BASE_URL}/auth/discord/callback`. |
| `ADSENSE_CLIENT` / `ADSENSE_SLOT` | Google AdSense publisher + slot IDs. Leave blank to hide ads. |
| `ROUNDS_PER_GAME` / `GUESS_SECONDS` | Gameplay defaults. Private-room hosts can override both in the lobby (`GUESS_SECONDS` within 5–120); matchmaking rooms always use these. |

**Guests vs. accounts:** the site runs with zero OAuth configured — players just
pick a guest name and can play casual + private rooms. **Ranked** requires a
Google or Discord account so ratings have a stable identity.

### Setting up OAuth

- **Google:** [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
  Create OAuth client ID (Web application) → add `{BASE_URL}/auth/google/callback`
  as an authorized redirect URI.
- **Discord:** [Discord Developer Portal](https://discord.com/developers/applications) →
  New Application → OAuth2 → add `{BASE_URL}/auth/discord/callback` as a redirect.

### Setting up ads

Create a Google AdSense account, get your publisher ID (`ca-pub-…`) and a display
ad unit slot ID, and put them in `ADSENSE_CLIENT` / `ADSENSE_SLOT`. Ad placeholders
appear at the top, mid-page, and in the game sidebar.

> **Ads are off by default, and turning them on has compliance strings attached.**
> The site currently sets only a strictly-necessary session cookie, which is why it
> needs no consent banner. Ad cookies are not strictly necessary, so before setting
> `ADSENSE_CLIENT` you need (a) a banner that gets consent *before* the ad script
> loads, (b) a Google-certified Consent Management Platform for EEA/UK visitors —
> Google's EU user consent policy does not accept a hand-rolled banner — and (c) an
> update to `public/privacy.html`, which currently states that we run no advertising.

## Legal pages

`public/privacy.html` and `public/terms.html` are served at `/privacy` and `/terms`
and linked from the footer and the sign-in modal. They are written to match what
the code actually does — no email is collected, chat is never persisted, one
session cookie — so **if you change what the server stores, update them.**

Any unfilled placeholder is highlighted in amber on the rendered page and marked
`class="todo"` in the source — search for `todo` and make sure none remain before
launch. **Have a lawyer review both documents** — they are a solid, accurate
starting point, not legal advice.

Two commitments in the privacy policy are enforced by code rather than by good
intentions, so keep them in step:

- **Self-service deletion.** Players open their profile from the name pill and
  delete their account outright (`POST /api/account/delete` → `deleteAccount` in
  `server/db.js`). It erases the profile row, every ladder rating, and every
  match, in one transaction. Match rows name both players, so deleting also
  removes those games from the opponent's history — their rating and win/loss
  totals live in `ratings` and are untouched.
- **24-month inactivity.** `purgeInactiveAccounts` runs at startup and daily
  thereafter, measured against `users.last_seen` (refreshed, at most hourly, on
  any request that resolves the account). `INACTIVE_PURGE_MONTHS` and the number
  on the policy page must match.

## Tests

```bash
npm test
```

Runs the suite with Node's built-in test runner (no extra framework). Coverage:

- **`scoring.test.js`** — the scoring engine (naming, near-misses, article-word
  frequency, filler-word discounting, empty guesses).
- **`elo.test.js`** — Elo deltas, draws, upsets, and tier boundaries.
- **`matchmaking.test.js`** — two distinct players match into one room, ranked
  rejects guests, and leaving the queue cancels a pending match. (Guards the
  queue-pairing regression directly.)
- **`ranked.test.js`** — the Elo pairing rule (widening windows, mutual
  acceptance, closest-pair selection) and the whole ranked path end to end:
  queue, pair, play, and the rating write landing on the right ladder.
- **`game.test.js`** — a full private game runs every round through to game over,
  and submitting early ends a round without waiting out the timer.
- **`hardening.test.js`** — the production wrapper: `/healthz`, security headers,
  HTTP and per-socket rate limits, JSON 404s, a thrown round returning the room to
  the lobby instead of crashing the process, graceful shutdown, and the refusal to
  boot in production without a strong `SESSION_SECRET`.
- **`lifecycle.test.js`** — the states a room is left in between games (a private
  room returns to its lobby and replays; a matchmaking room does not), entering a
  room clearing the matchmaking queue, and the per-identity connection cap.
- **`profile.test.js`** — match history read from the viewer's side of the row,
  account deletion, and the inactivity sweep.

Tests boot the real server in-process on an ephemeral port. The Wikipedia fetch
is dependency-injected (see `buildServer({ roomOptions: { fetchMystery } })` in
`server/app.js`), so the suite is fast and needs no network.

## Game modes

There are three **clue** modes, each combined with a topic **tier** to form a
ranked ladder. You pick both before every ranked or casual match; private-room
hosts pick them in the lobby. The tiers are Party mix (well-known) and Total
chaos (the broader pool, still guessable).

- **Pictures** (`image`) — guess from the article's image.
- **Descriptions** (`text`) — guess from the first sentence or two of the article,
  with the topic's own name blanked out (`_____`). A "Read aloud" button voices it
  via the browser's speech synthesis. Extraction/blanking lives in
  `server/game/extract.js`; these fetches require a usable extract, not an image.
- **Combined** (`mixed`) — each round is independently, randomly a picture or a
  description.

Ratings live in the `ratings` table keyed by `(user_id, mode)`, where `mode` is
the composite **ladder key** `"<clue>:<tier>"` (e.g. `image:chaos`) — so each
clue × tier pair is its own ladder (up to 9). The leaderboard picks a clue and a
tier (`/api/leaderboard?clue=&tier=`). Matchmaking queues are split by
kind × clue × tier, so you only ever match someone who chose the same thing.
Ladder keys are built in `server/ladders.js`.

## Matchmaking

**Ranked pairs on rating** (`server/matchmaking.js`). Each waiting player has a
search window that starts at ±`MM_START_WINDOW` and widens by
`MM_GROWTH_PER_SEC` for every second they wait, capped at `MM_MAX_WINDOW`. With
the defaults that's ±100 the moment you queue, ±500 after 20 seconds, and
effectively anyone after about 70 — a tight ladder when there's a crowd, and a
game rather than an empty screen when there isn't.

Two rules make it fair rather than merely fast:

- **Mutual acceptance.** A pair forms only when each player is inside the
  *other's* window. Without this, someone who has waited two minutes would drag
  a player who just arrived into a lopsided game they never agreed to.
- **Closest pair first.** Each sweep picks the tightest legal pairing in the
  queue, not the first one it stumbles on. The scan is O(n²), which is the right
  call for queues that hold a handful of players per ladder.

A player whose rating has fewer than `MM_PROVISIONAL_GAMES` games behind it
searches `MM_PROVISIONAL_BONUS` points wider from the start — that number is
still a guess, and pinning it to a tight window just makes them wait.

Because windows widen over time, one shared timer re-sweeps the ranked queues
every `MM_TICK_MS`. It exists only while somebody is waiting, so an idle server
does no matchmaking work at all. After `MM_RANKED_TIMEOUT_MS` a fruitless search
gives up and says so instead of spinning forever, and clients get a `queue:status`
tick showing the current range so the wait is legible. Each match logs a
`ranked_matched` line with both ratings, the gap and both wait times — that's
what to tune the windows from once real players are queuing.

**Casual stays first-come-first-served**, and fills with a practice bot if
nobody shows up within a few seconds. It promises an instant game with no rating
at stake, and guests — who have no rating to match on — play it. Ranked never
bot-fills: a rating has to be won against a person.

A matchmaking room's settings are **fixed by the queue its players joined** —
its lobby shows neither an invite link nor the rules, and the server rejects any
attempt to change them. For ranked that is a correctness rule, not tidiness: the
clue and tier decide which ladder the Elo is written to, so an edit during the
pre-match countdown would be a way onto a ladder the player never queued for.
Private rooms remain fully configurable by their host.

## How scoring works

Each guess earns the higher of two **accuracy** scores:

1. **Naming it** — letter-similarity between your words and the answer's words.
2. **Article hits** — any word in your guess that appears in the answer's Wikipedia
   article scores on a curve by how often it appears. Filler words ("located",
   "century") are heavily discounted so they can't carry a round.

On top of that, a **speed bonus** (up to `SPEED_BONUS_MAX`, default 30) is added
when a guess actually scored — full value for an instant answer, decaying to zero
as the round timer runs out. So if two players land the same correct word, the
faster one takes the round. A fast wrong/empty guess earns no bonus.

Accuracy is ported from the original single-page game in `scoring.js` (pure,
server-side); the speed bonus is applied in `rooms.js`, which knows the timing.

## Project layout

```
server/
  index.js          Express + Socket.IO bootstrap, HTTP APIs, static hosting
  config.js         Env-driven configuration
  db.js             SQLite schema + queries (users, matches)
  auth.js           Passport Google/Discord OAuth + guest identity
  elo.js            Elo rating math + tiers
  matchmaking.js    Pure ranked pairing rule (search windows, closest pair)
  rooms.js          Room engine (round loop) + matchmaking manager
  socket.js         Socket.IO event wiring
  game/
    pool.js         Offline mystery source (local SQLite pool; tiered by topic)
    wikipedia.js    Legacy live-API mystery fetching (kept as a fallback)
    scoring.js      Pure scoring engine
    topics.js       Curated topic list
public/
  index.html        Landing page + lobby + leaderboard
  play.html         Game room
  js/               common.js (shared), home.js, play.js
  css/styles.css
```

## Deploying to a VPS

1. Install Node 18+ and clone the repo.
2. `npm ci --omit=dev` (or `npm install`), create `.env`, set `NODE_ENV=production`
   and `BASE_URL=https://your-domain.com`.
3. Run behind a reverse proxy (nginx/Caddy) terminating TLS and forwarding to
   `PORT`. WebSocket upgrade headers must be passed through.
4. Keep it alive with a process manager (`pm2 start server/index.js --name wiki-guesser`
   or a systemd unit). Send **SIGTERM** to restart: the server tells connected
   players it's restarting, drains in-flight games, and exits within
   `SHUTDOWN_GRACE_MS`. A `SIGKILL` drops every game mid-round.
5. The SQLite database lives in `data/` — back that folder up.
6. Point your health check at **`GET /healthz`**. It returns 200 with
   `{ok, uptime, rooms, version}`, or 503 if the database has stopped answering —
   a process that can't read SQLite is unhealthy even though it still accepts TCP.
   It runs before the session middleware, so polling it costs nothing.

Logs are JSON, one object per line on stdout (warn and above on stderr), which
CloudWatch Logs Insights and friends parse without a custom pattern.

## Attribution

Images and article text come from [Wikipedia](https://en.wikipedia.org) under
CC BY-SA. This is a fan project and is not affiliated with the Wikimedia Foundation.
