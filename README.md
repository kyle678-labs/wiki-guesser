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
- **`oauth.test.js`** — the login-CSRF guard: every authorization redirect carries
  a `state`, a callback whose state doesn't match the session is refused, and each
  provider gets its own state slot so one flow can't satisfy the other.
- **`chat.test.js`** — sanitising and broadcast, the capped in-memory buffer, and
  the report path (resolved from the server's own buffer, never from text the
  reporter supplies; self-reports and invented ids refused; double reports
  recorded once).
- **`db.test.js`** — ratings tracked per ladder independently, and the leaderboard
  cache being invalidated by a new result.
- **`categories.test.js`** — the offline classifier: template normalisation past
  `Template:` prefixes and sub-pages, multi-category articles, and the
  conservative category rules that catch biographies.
- **`pool-categories.test.js`** / **`pool-legacy.test.js`** — filtered picks are
  an OR and never repeat within a game, a thin category widens the tier rather
  than failing the round, the partial indexes are actually used, and a pool built
  *before* categories still serves unfiltered rounds instead of throwing.
- **`extract.test.js`** — first-sentence extraction and title blanking.
- **`bot.test.js`** — a lone casual player is filled with a practice bot, and two
  humans pair with each other rather than getting bots.

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

### Categories (private rooms only)

A private-room host can narrow the pool to any combination of 12 categories —
People, Places, Animals & nature, Film & TV, Music, Sport, Games, Books & comics,
Science, History, Food & drink, Tech & transport. Selecting several is an **OR**:
a round matches if the article is in any of them. Selecting none means anything,
which is the default.

**Ranked and casual rooms cannot set this.** A ladder is only meaningful if every
match on it draws from the same pool, so the setting is rejected for
non-private rooms exactly like the other queue-fixed settings.

Classification happens **once, offline**, in `scripts/build-mysteries.js` via
`server/game/categories.js`, and is stored as a bitmask column. Two signals from
the CirrusSearch dump, in order of trust:

1. `template` — the infobox an editor chose (`Template:Infobox film`,
   `Template:Speciesbox`). About as close to a curated label as Wikipedia offers.
   Note these must be normalised: the dump is full of sub-templates like
   `Infobox settlement/styles.css`, and matching only exact names loses most of
   them.
2. `category` — noisy (every article carries maintenance categories), so only a
   conservative, high-precision subset is matched. `Living people` and
   `1962 births` are near-perfect biography markers and catch the long tail of
   specialised person infoboxes.

Roughly **69% of the pool classifies** (302,525 of 436,011 rows in the current
build; `npm run check:pool` reports it). The rest are genuinely uncategorisable
concept articles — *Anarchism*, *Albedo*, *Arithmetic mean* — which have no
infobox. They stay in the pool and are served in unfiltered games; they simply
can't be picked by category.

The picker shows a **live article count per category** for the room's current
tier and clue, and says plainly when switching to Total chaos would give a bigger
pool. That matters because the party tier is only ~5.4k articles in total, so a
narrow category there can get thin enough to repeat within a game.

> **Categories require a pool rebuild.** They live in a `categories` column that
> older pools don't have, so a pool built before this feature will fail every
> category-filtered round. Rebuild with `scripts/build-mysteries.js` and re-upload
> the artifact. The rebuild also adds 24 partial indexes (one per category × clue)
> — without them a filtered pick degrades from an index walk into a full scan,
> which blocks the event loop for every room on the box.

Counts are computed once at boot (`warmCategoryCounts`) with a single grouped
scan, not per request, and served through `/api/config`.

Ratings live in the `ratings` table keyed by `(user_id, mode)`, where `mode` is
the composite **ladder key** `"<clue>:<tier>"` (e.g. `image:chaos`) — so each
clue × tier pair is its own ladder (3 clues × 2 tiers = 6). The leaderboard picks a clue and a
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
  index.js          Bootstrap: listen, warm caches, retention sweep, signals
  app.js            Express + Socket.IO wiring, HTTP APIs, static hosting
  config.js         Env-driven configuration
  db.js             SQLite schema + queries (users, ratings, matches)
  auth.js           Passport Google/Discord OAuth + guest identity
  elo.js            Elo rating math + rank tiers
  modes.js          Clue modes: image | text | mixed
  tiers.js          Topic tiers: party | chaos
  ladders.js        Ladder key "<clue>:<tier>" — 6 ranked ladders
  matchmaking.js    Pure ranked pairing rule (search windows, closest pair)
  rooms.js          Room engine (round loop) + matchmaking manager + bot-fill
  socket.js         Socket.IO event wiring
  bot.js            Practice bot (identity, guess logic, timing)
  ratelimit.js      Per-socket token buckets
  log.js            Structured JSON logging (one object per line)
  metrics.js        Event-loop lag + memory sampling
  shutdown.js       SIGTERM drain
  game/
    pool.js         Offline mystery source (local SQLite pool; tiered by topic)
    categories.js   Article categories: offline classifier + runtime helpers
    wikipedia.js    Legacy live-API mystery fetching (kept as a fallback)
    scoring.js      Pure scoring engine
    topics.js       Curated seed titles for the live-API path (NOT categories)
public/
  index.html        Landing page + lobby + leaderboard
  play.html         Game room
  privacy.html      Privacy policy (/privacy)
  terms.html        Terms of service (/terms)
  js/               common.js (shared), home.js, play.js, theme.js, legal.js
  css/styles.css
scripts/
  build-mysteries.js         Build the offline pool from Wikipedia dumps
  check-pool.js              Preflight a built pool before uploading it
  backup-restore-drill.js    Prove a crash-consistent snapshot is restorable
  migrate-ratings-to-tiers.js
infra/                       Terraform: the whole AWS production stack
test/                        Node test runner suite (npm test)
```

## Deploying

### On AWS (the supported path)

`infra/` is a Terraform module that stands up the whole production stack —
EC2 + Elastic IP, Caddy terminating TLS with an auto-renewed Let's Encrypt
certificate, a separate EBS data volume with daily snapshots, secrets in SSM,
JSON logs and alarms in CloudWatch, and shell access via Session Manager rather
than SSH. Roughly $34–37/month.

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # then edit it
terraform init && terraform apply
```

Then follow the `next_steps` output in order — the sequence matters, and the
mystery pool has to be uploaded separately because it is ~908 MB and gitignored.
**Read [`infra/README.md`](infra/README.md) first**: it covers the deploy order,
the alarms and what to do when each one fires, restoring from a snapshot, and —
if your DNS is on Cloudflare — why the record has to be DNS-only rather than
proxied.

Before uploading the pool, check it:

```bash
npm run check:pool
```

A pool built before the categories feature has no `categories` column, and on
one every category-filtered private round fails while the rest of the game looks
entirely healthy. The check refuses the bad pool rather than letting you spend
ten minutes uploading it.

### On a plain VPS

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
