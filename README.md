# 🧠 WikiGuessr

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
| `SESSION_SECRET` | Signs session cookies. Generate a long random string. |
| `NODE_ENV` | `production` enables secure cookies (serve over HTTPS). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth. Redirect URI: `{BASE_URL}/auth/google/callback`. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord OAuth. Redirect URI: `{BASE_URL}/auth/discord/callback`. |
| `ADSENSE_CLIENT` / `ADSENSE_SLOT` | Google AdSense publisher + slot IDs. Leave blank to hide ads. |
| `ROUNDS_PER_GAME` / `GUESS_SECONDS` | Gameplay tuning. |

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
- **`game.test.js`** — a full private game runs every round through to game over,
  and submitting early ends a round without waiting out the timer.

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
4. Keep it alive with a process manager (`pm2 start server/index.js --name wikiguessr`
   or a systemd unit).
5. The SQLite database lives in `data/` — back that folder up.

## Attribution

Images and article text come from [Wikipedia](https://en.wikipedia.org) under
CC BY-SA. This is a fan project and is not affiliated with the Wikimedia Foundation.
