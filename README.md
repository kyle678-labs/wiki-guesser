# 🧠 Wiki-Guesser

[![CI](https://github.com/kyle678-labs/wiki-guesser/actions/workflows/ci.yml/badge.svg)](https://github.com/kyle678-labs/wiki-guesser/actions/workflows/ci.yml)

A standalone, multiplayer version of the Wikipedia image-guessing game. A mystery
Wikipedia image appears; players race to name the topic — or fish scoring words
from its article — before the timer runs out. Highest total after all rounds wins.

- **Ranked matches** — random 1-on-1 matchmaking with an Elo ladder and tiers.
- **Casual quick match** — instant random matchup, no rating on the line (guests welcome).
- **Private rooms** — create a room, share a link, play with up to 8 friends.
- **Wikidle** — a daily solo puzzle at `/daily`: name the article from the opening words of its lead.
- **Wikitile** — a daily picture scramble at `/tiles`: one article's picture, sixteen tiles, turned and shuffled. Against the clock.
- **Wikimatch** — a daily matchup at `/match`: nine pictures, nine titles, every caption in the wrong place. Against the clock.
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
| `RATE_LIMIT_DAILY_MOVES` | Per-IP budget for the picture dailies' move endpoints (default 900/window). They post one request per move, which is a different traffic shape from the rest of the API — so they are budgeted apart from it rather than inside it. |
| `MAX_SOCKETS_PER_IDENTITY` | Simultaneous socket connections one identity may hold (default 6). Socket rate limits are per socket, so this is what caps them per player. |
| `MM_START_WINDOW` / `MM_GROWTH_PER_SEC` / `MM_MAX_WINDOW` | Ranked search window: how close an opponent must be, and how fast that loosens while you wait. |
| `MM_PROVISIONAL_BONUS` / `MM_PROVISIONAL_GAMES` | Extra search width for players whose rating isn't settled yet. |
| `MM_TICK_MS` / `MM_RANKED_TIMEOUT_MS` | How often ranked queues re-sweep; how long before a fruitless search gives up. |
| `INACTIVE_PURGE_MONTHS` / `INACTIVE_PURGE_INTERVAL_MS` / `INACTIVE_PURGE` | Automatic deletion of dormant accounts. Keep the months in step with `public/privacy.html`. |
| `SHUTDOWN_GRACE_MS` | How long SIGTERM waits for games to drain before forcing the exit. |
| `PRELOAD_PARTY` / `PARTY_PRELOAD_MAX_ROWS` | Hold the party tier in memory (default on) — it removes the app's biggest event-loop stall. |
| `DAILY_SCORE_DAYS` | How long daily puzzle scores are kept (default 30). Each row carries a display name, so keep this equal to the retention stated in public/privacy.html. |
| `ADMIN_USER_IDS` | Comma-separated account ids that may reach `/admin`. **Unset (the default) means the admin routes are never mounted at all** — see [Admin dashboard](#admin-dashboard). Find your id with `npm run accounts`. |
| `REPORT_DAYS` | How long a reported chat message is kept (default 30), and how long after expiry a suspension record is. A report is the only case in which chat touches disk, so keep this equal to the figure in public/privacy.html. |
| `STMT_CACHE_MAX` | How many compiled mystery-pick statements to keep (default 512). One per clue column × exclusion size × category mask, so it is bounded by an LRU rather than left to grow with the number of category combinations players pick. |
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
- **Reported messages and suspensions expire.** `purgeOldReports` and
  `purgeExpiredBans` run on the same daily sweep, at `REPORT_DAYS`. A report is
  the one circumstance in which a chat message is written to disk at all, so the
  policy page names both the storage and the number — change one, change both.
  Account deletion takes a player's reports (on either side) and their
  suspension with it, in the same transaction as everything else.

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

There are three **clue** modes, each combined with a topic **tier**. You pick
both before a casual match; private-room hosts pick them in the lobby. The tiers
are Party mix (well-known) and Total chaos (the broader pool, still guessable).

**Ranked uses a deliberately narrower set** — Pictures or Descriptions, always
Total chaos, so there are two ranked ladders rather than six. Combined and Party
mix stay fully playable in casual and private rooms. See
[`server/ladders.js`](server/ladders.js) for the reasoning; briefly, every extra
ladder splits the same players and a rating ladder is only meaningful if there is
somebody close to you waiting in it.

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
clue × tier pair is rated independently. Ranked accepts two of them
(`image:chaos`, `text:chaos`); the queue refuses any other combination, and it
does so server-side, because `queue:join` is a socket event and the picker in
the browser is presentation rather than enforcement. The leaderboard lists only
ranked ladders and pulls a request for any other onto the nearest one that has
standings (`/api/leaderboard?clue=&tier=`, which echoes back what it served).
Matchmaking queues are split by kind × clue × tier, so you only ever match
someone who chose the same thing. All of this derives from `RANKED_MODES` /
`RANKED_TIERS` in `server/ladders.js` — widening ranked is an edit there and
nowhere else, including the client, which reads the set from `/api/config`.

## The daily puzzles

Three solo puzzles, one of each per day, the same for everybody, each with its
own leaderboard:

| | Where | The puzzle | Scored on |
|---|---|---|---|
| **Wikidle** | `/daily` | Name the article from the first six words of its opening, its own name blanked out. Every wrong guess buys one more word, and comes back marked letter by letter. | guesses taken |
| **Wikitile** | `/tiles` | One article's picture, cut into sixteen tiles, shuffled and turned. Tap to turn a tile, drag to swap two. | solve time |
| **Wikimatch** | `/match` | Nine pictures and nine titles, every caption under the wrong picture. Swap two captions at a time. | solve time |

Everything below is true of all three. Lower is always better, and the picture
games publish a **par** — the fewest moves the day's board can be solved in
(`swapsToSort` in `game/daily.js`) — which is not the score but is worth
chasing, because the short way round is usually the quick one.

**Two kinds of score, one column.** Both are integers where lower wins and a
board only ever reads one game, so `daily_scores.score` holds guesses for
Wikidle and milliseconds for the picture games; `/api/daily*` publishes a
`format` next to the rows so nothing has to infer which from the number.

**Wikidle is not timed, and the picture games are.** A word puzzle on a clock
rewards typing speed as much as working the clue out, which is why Wikidle
counts guesses and stores no time at all. The picture games are the opposite
case: they are puzzles you can always finish, so "how fast" is the only
question left. The clock is the server's — it starts when the board is handed
out, stops when the puzzle is solved, and the browser is only ever sent the
current figure to display, never asked for it.

It starts at hand-out rather than at the first move on purpose. First-move
timing looks fairer (nobody is charged for a slow thumbnail) but it gives the
game away: you could study the board as long as you liked, plan every move, and
then run a memorised solution against a clock that had not started.

**A timed puzzle can be scouted**, and this is the honest cost of the change.
Someone who solves the day's board as a guest, then plays it again signed in,
runs a solution they already know. Nothing here defends against that — the
defence would have to be an account requirement, which would cost more than it
saves on a puzzle whose leaderboard resets nightly. Ties still go to whoever got
there first (`created_at`), which for millisecond scores is close to decorative.

**The day is UTC.** Local midnight would read more naturally to one player, but
it makes a shared board incoherent — two people holding "today's" best score on
different puzzles — and it moves the clock into the client, which is the one
input a scoreboard must not trust.

**Nothing schedules the puzzles.** The day plus the game id hash into a seed
(`server/game/daily.js`), and that seed drives the same indexed `rnd` walk
`pool.js` already uses for random picks. The pool is read-only, so the same day
always resolves to the same article, on every instance, forever — with no table
of upcoming puzzles to maintain or get out of sync. The picture games take their
scramble from a second stream off the same seed, so the board is identical for
everyone too and par means the same thing on every leaderboard.

**Wikidle borrows Wordle's two aids**, and it needs them more than Wordle does.
A five-letter word with a grid tells you its length for free; an article title of
unknown length, blanked out of a lead that may not have said what it is yet, told
you nothing. So the answer's **shape** — how many words, how long each one, with
its punctuation shown — is on screen from the first frame, and every guess comes
back **marked letter by letter**: right letter in the right place, right letter
elsewhere in the title, or not in it at all. Letters you place stay filled into
the shape, so progress accumulates instead of scrolling up the guess list.

Position is judged per word (the third letter of your second word against the
third letter of the answer's second word), because that is the only alignment a
player can reason about when the two have different word counts, and the
remaining letters are drawn from a shared pool — so three E's in a guess cannot
all come back "elsewhere" against an answer holding one. Both live in
`game/wikidle.js` (`shapeOf`, `markGuess`, `revealedShape`) and are derived from
the answer on every request rather than stored, so the session holds only what
the player typed and there is no second copy of their progress to fall out of
step with it.

**The server holds everything worth lying about.** Wikidle keeps the answer and
the words you have not earned; Wikimatch keeps which caption belongs to which
picture, and ships the pictures in one order and the titles in another with
nothing joining them. Every guess, move and swap is applied to state held on the
server, both clocks are read there, and the score is whatever the server
measured — so a 1, or a 40-second solve, has to be earned rather than claimed.
Someone who looks an answer up still scores 1; the clue was never what stopped
that.

Wikitile is the honest exception, and worth naming: a jigsaw you cannot see is
not a jigsaw, so the picture goes out immediately and only the article's *name*
is withheld until you finish. Nothing in that puzzle is secret at all — what
makes its board mean anything is that the server, not the page, decides when it
is solved and how long that took. The same soft edge applies to Wikimatch — a
Commons URL carries a filename that often names its subject, which is the trade
the live picture rounds already make.

That is also why the two picture games post **one request per move**: the server
has to hold the board to know when it is finished, and it will not take the
page's word for that. Those endpoints carry their own rate-limit budget
(`RATE_LIMIT_DAILY_MOVES`) rather than spending the API's. The pages apply each
move locally first and reconcile with the response, so play stays immediate —
which matters more now that the clock is running.

Scores are stored per day and **not** per account — guests are on the board too.
Rows carry the display name as it was at the time, are deleted after
`DAILY_SCORE_DAYS`, and go immediately if the account behind them is deleted.

Dailies filter the pool harder than the live game does: a 20-second round can
afford "Nine Inch Nails discography", a whole day cannot. All three draw from
the party tier — a scrambled picture of somewhere nobody has heard of is sixteen
brown squares, and nine obscure articles is not a hard matchup but an impossible
one. For Wikidle the lead's pronunciation apparatus is stripped too
(`stripPronunciation` in `game/extract.js`) — a lead that opens `Czechoslovakia
(/ˌtʃɛkoʊsloʊˈvæki.ə/ CHEK-oh-sloh-VAK-ee-ə; Czech: Československo)` spells the
answer out twice over right beside the blank.

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

**"Queue again" re-enters the queue from the results screen.** A matchmaking
room is one-and-done, and the thing most people want next is the same game
again — so the game-over panel queues directly rather than sending them back to
the lobby to re-pick two settings they already chose. The clue and tier are read
off the finished room's own state, which for ranked is what keeps the next match
on the ladder they were just rated on. The client leaves the finished room first
(`room:leave`, then `queue:join`), so nobody is nominally present in one room
while being matched into another; from there it is the ordinary queue, bot-fill
and `match:found` navigation the lobby uses. Private rooms keep "Back to lobby"
— they have a lobby to go back to.

A matchmaking room's settings are **fixed by the queue its players joined** —
its lobby shows neither an invite link nor the rules, and the server rejects any
attempt to change them. For ranked that is a correctness rule, not tidiness: the
clue and tier decide which ladder the Elo is written to, so an edit during the
pre-match countdown would be a way onto a ladder the player never queued for.
Private rooms remain fully configurable by their host.

## Admin dashboard

`/admin` — the moderation queue, suspensions, a player lookup, and a live view of
rooms, queues and process health. Built from `server/admin.js` (the routes) and
`server/admin/` (the page).

**Access is an environment allowlist.** `ADMIN_USER_IDS` holds account ids; you
sign in with Google or Discord exactly as any player does, and being on the list
is what grants the dashboard. There is no admin password, no second login form,
and no role column on the row. Two reasons for the environment rather than the
database: granting admin becomes a deploy, which leaves a trace in the same place
every other change to this service does, and a database somebody can write to
still cannot hand them the dashboard.

**Unset means the routes do not exist.** Not "exist but refuse" — `buildServer`
never mounts them. That is the correct failure mode for a box that came up
without its env file.

There is a deliberate chicken-and-egg: admin is granted by account id, and the id
is assigned on first sign-in. So sign in once, then:

```bash
npm run accounts
```

which prints ids newest-first, flagging who is already an admin and who is
suspended. Put yours in `.env` and restart. It reads the database directly, so it
has to be run on the box — admin is granted by somebody with a shell, never
through the web.

**Every rejection is a 404, not a 403.** Signed out, a guest, or an ordinary
account all get the same "no such page" a typo gets, and the dashboard's own
script is served from `server/admin/` rather than `public/` precisely so
`express.static` cannot hand it out. A 403 would confirm that `/admin` exists and
that an allowlist is the only thing in the way; a real admin never sees either.
`test/admin.test.js` asserts the status code, not just the refusal.

### The moderation queue

Reporting a chat message used to write a `log.warn` line and nothing else, which
told an operator that something happened but gave them nothing to act on. Reports
now land in `chat_reports` as work items: the message, both display names, the
room, and — where the sender had an account rather than a guest session — the id
you would act on. The report path itself is unchanged and still resolves the text
and the author from the room's own buffer, never from the reporter's request.

A report is closed as **actioned** or **dismissed**, with an optional note.
Closing one twice is an answer rather than an error (`changed: false`), so two
admins clicking at once agree on the first finding instead of racing to overwrite
it. Resolving a report never bans anybody and banning somebody never closes a
report — "this message was fine" and "this player is fine" are different findings,
and conflating them makes the queue lie.

### Suspensions

A ban is one row per account in `bans`, permanent or with an expiry, carrying the
reason and who applied it. It is resolved **once**, onto the identity, by
`accountIdentity` in `auth.js`, so there is one definition of "banned" and an
expired ban stops applying everywhere at the same instant.

Enforced at two places, which between them are everything a banned player could
do in public:

- **The Socket.IO handshake.** No socket means no queue, no room and no chat,
  however the client is written. Refused there rather than disconnected
  afterwards, because a socket torn down mid-emit may never deliver the reason —
  and socket.io-client does not retry a middleware rejection, so nobody is left
  in a reconnect loop against a door that will not open.
- **The daily routes.** Every daily result publishes a display name next to a
  score, which is the one public surface left otherwise.

Banning someone who is already connected also closes their live sockets, telling
them why first; the room treats it as an ordinary disconnect, which the game
already knows how to survive. A suspended player can still read the site, and the
lobby shows them the reason and when it lifts rather than a site that has
silently stopped working.

Two limits, stated plainly because the UI states them too. **Only accounts can be
suspended** — a guest identity is a cookie, and the next guest session is a new
one, so a report against a guest has nothing to act on beyond dismissing it. And
**an account is not a person**: deleting the account drops the ban with it, and a
fresh sign-in through the same provider is a new row with a new id.

An admin cannot suspend themselves or anyone else on the allowlist. That reads as
paranoia until you picture the alternative — the only operator locked out of
their own game by their own dashboard.

### Notices

A short message pinned from the dashboard and shown to every visitor as a
dismissible card in the corner of the page — "server restarts at 9pm", "the
daily is broken, working on it". Optionally set to expire after a number of
days, otherwise it stays until unpinned.

It rides inside `/api/config`, which every page already fetches, so a notice
costs **no extra request and no extra query**: `activeNotices` in `db.js` holds
every row in memory and filters by expiry on each read. That filtering happens on
read rather than when the cache is filled, which is what makes an expiry exact
with no TTL — a notice pinned for an hour stops being served on the hour, with
nothing having to write. The one assumption that rests on is that `expires_at` is
set at insert and never edited; add an edit path and it has to invalidate.

Dismissal is per browser, in `localStorage`, keyed by notice id — there is no
account requirement to read the site, so there is nowhere else to put it. Ids
that no longer exist are pruned on every render, so the key stays the size of
what is pinned rather than becoming a running log.

Deliberately **not** a messaging system: no recipient, no reply, no read
receipts. The moment it grows a "to" it needs a privacy policy entry and a
deletion path, and it stops being a notice board.

## What a page load costs the database

The landing page is the one URL that scales with *visitors* rather than with
concurrent players, so it is worth being precise about what it touches.

**For a signed-out visitor: nothing.** Not "one cheap query" — zero. `/api/config`
serves static config, `categoryCounts()` (a single grouped scan, warmed at boot),
and `activeNotices()` (held in memory, invalidated on write). `getSessionUser`
returns `null` without a read when there is no session. `/api/leaderboard` is
served from a 30-second cache keyed on `mode:limit`.

**The leaderboard cache is invalidated on write as well as by TTL.**
`recordRankedMatch` is the only thing that moves a rating and it clears the
cache, so the ladder is never actually stale — the TTL is just a backstop for
out-of-band writes like `scripts/migrate-ratings-to-tiers.js` against a live
database. `LEADERBOARD_TTL_MS` tunes it. Asserted in `test/db.test.js`: a repeat
read returns the *same array instance*, and a new result replaces it.

**A signed-in visitor costs three small indexed reads** — the user row, their
ratings, and their ban state — resolved once per request by `accountIdentity`.
Those are inherently per-session and there is nothing to cache; `last_seen`
writes are throttled to one per user per hour on top.

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
  db.js             SQLite schema + queries (users, ratings, matches, dailies,
                    chat reports, bans)
  auth.js           Passport Google/Discord OAuth + guest identity
  dailies.js        The three daily puzzles' routes and leaderboards
  admin.js          /admin + /api/admin/* behind the ADMIN_USER_IDS allowlist
  admin/            The dashboard page itself — outside public/ on purpose, so
                    express.static cannot serve it to anyone
  moderation.js     What a ban means at the edges: how long is left, what to say
  elo.js            Elo rating math + rank tiers
  modes.js          Clue modes: image | text | mixed
  tiers.js          Topic tiers: party | chaos
  ladders.js        Ladder key "<clue>:<tier>" — and which pairs ranked accepts
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
    daily.js        The UTC day, and the seeded pick every daily shares
    wikidle.js      Daily: name the article from its opening words
    tiles.js        Daily: the scrambled picture
    match.js        Daily: nine pictures, nine titles
    extract.js      Lead-text handling: blank the title, strip pronunciations
    wikipedia.js    Legacy live-API mystery fetching (kept as a fallback)
    scoring.js      Pure scoring engine
    topics.js       Curated seed titles for the live-API path (NOT categories)
public/
  index.html        Landing page + lobby + leaderboard
  play.html         Game room
  daily.html        Wikidle    tiles.html / match.html  the picture dailies
  privacy.html      Privacy policy (/privacy)
  terms.html        Terms of service (/terms)
  js/               common.js (shared), home.js, play.js, daily.js, tiles.js,
                    match.js, theme.js, legal.js
  css/styles.css    Every page, /admin included — a stylesheet is not a secret
scripts/
  list-accounts.js           Print account ids, for ADMIN_USER_IDS
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
than SSH.

**Roughly $21/month** at the defaults, in us-east-1:

| | $/month |
|---|---|
| `t4g.small` (2 vCPU / 2 GiB, Graviton) | 12.26 |
| 2 × 20 GiB gp3 (root + data) | 3.20 |
| Public IPv4 on the Elastic IP | 3.65 |
| 12 CloudWatch alarms | 1.20 |
| Route 53 health check, log ingestion, custom metrics | ~2.50 |
| Daily snapshots, S3 pool storage | ~0.20 |

Two things about that number, both learned the hard way.

**An idle box costs exactly what a busy one does.** The whole design — SQLite on
local disk, rooms in memory, long-lived WebSockets, a pool that wants to stay
page-cached — assumes a machine that is always on. There is no scale-to-zero to
reach for without building a different application, so the only real lever is
right-sizing, and `instance_type` is where nearly all of it lives. This ran on
`c7i-flex.large` ($61.90) until 2026-08, which was 5× the instance this needs.

**On an AWS Free plan you cannot launch whatever you like.** `RunInstances`
refuses any type that is not free-tier eligible, and the list does not include
`t4g.medium` — the obvious 4 GiB Graviton choice. Because Terraform replaces an
instance by destroying it first, discovering that costs an outage. Check before
you change `instance_type`, and do not trust `--dry-run`, which validates IAM
only and will happily approve a type the account cannot launch:

```bash
aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true \
  --query 'InstanceTypes[].InstanceType' --output text
```

On a paid plan the catalogue opens up; `t4g.medium` is $24.53 and doubles the
memory headroom. A one-year Compute Savings Plan takes either figure down by
roughly a third.

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
