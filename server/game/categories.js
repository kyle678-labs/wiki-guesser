"use strict";

// ────────────────────────────────────────────────────────────────────────────
// Article categories — "give me a game of nothing but animals".
//
// Shared by scripts/build-mysteries.js (which classifies once, offline) and the
// runtime (which only ever reads the stored bitmask). Nothing here runs per
// round: classification happens at build time and the result is one integer
// column, so filtering a round by category costs an indexed lookup.
//
// NOT to be confused with game/topics.js, which is a hand-written list of party
// titles used by the live-Wikipedia fallback path. This module is about the
// offline pool.
//
// ── How an article is classified ───────────────────────────────────────────
// Two signals from the CirrusSearch dump, in order of trust:
//
//   1. `template` — the infobox an editor chose. `Template:Infobox film` on an
//      article is about as close to a curated label as Wikipedia offers, so
//      these rules are matched first and trusted outright.
//   2. `category` — noisier: an article carries dozens, most of them
//      maintenance junk ("Articles with short description"). Only a conservative,
//      high-precision subset is matched, and mostly as a fallback.
//
// Multi-label is deliberate. A footballer is `people` AND `sport`; a film score
// is `film` AND `music`. Picking a category means "must include this", not
// "must be only this".
//
// The mask is a 32-bit JS integer, which caps this list at 30 entries. SQLite
// stores it as INTEGER and filters with `categories & ?`.
// ────────────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  "people",
  "places",
  "nature",
  "film",
  "music",
  "sport",
  "games",
  "books",
  "science",
  "history",
  "food",
  "tech",
];

const CATEGORY_LABELS = {
  people: "People",
  places: "Places",
  nature: "Animals & nature",
  film: "Film & TV",
  music: "Music",
  sport: "Sport",
  games: "Games",
  books: "Books & comics",
  science: "Science",
  history: "History",
  food: "Food & drink",
  tech: "Tech & transport",
};

if (CATEGORIES.length > 30) throw new Error("CATEGORIES must stay under 31 entries — the mask is a 32-bit int.");

const BIT = {};
CATEGORIES.forEach((c, i) => (BIT[c] = 1 << i));

// ── Template rules ───────────────────────────────────────────────────────────
// Keyed on the NORMALISED template name: lowercased, "template:" stripped, and
// everything from the first "/" removed. That last part matters — the dump is
// full of sub-templates like "Infobox settlement/styles.css" and
// "Infobox musical artist/color" which would otherwise all miss.
const TEMPLATE_RULES = [
  [BIT.people, [
    "infobox person", "infobox officeholder", "infobox writer", "infobox scientist",
    "infobox military person", "infobox academic", "infobox royalty", "infobox artist",
    "infobox model", "infobox criminal", "infobox philosopher", "infobox politician",
    "infobox religious biography", "infobox monarch", "infobox noble", "infobox architect",
    "infobox chef", "infobox comedian", "infobox economist", "infobox engineer",
    "infobox journalist", "infobox medical person", "infobox astronaut", "infobox saint",
    "infobox military officer", "infobox pageant titleholder", "infobox character",
  ]],
  [BIT.places, [
    "infobox settlement", "infobox country", "infobox u.s. county", "infobox uk place",
    "infobox protected area", "infobox mountain", "infobox river", "infobox lake",
    "infobox islands", "infobox island", "infobox building", "infobox bridge",
    "infobox station", "infobox park", "infobox museum", "infobox university",
    "infobox school", "infobox castle", "infobox church", "infobox national park",
    "infobox body of water", "infobox continent", "infobox french commune",
    "infobox german location", "infobox italian comune", "infobox province",
    "infobox city", "infobox town", "infobox village", "infobox region",
    "infobox lighthouse", "infobox airport", "infobox historic site",
  ]],
  [BIT.nature, [
    "taxobox", "automatic taxobox", "speciesbox", "subspeciesbox", "infraspeciesbox",
    "infobox organism", "infobox plant", "infobox animal", "infobox dinosaur",
    "infobox breed", "infobox dog breed", "infobox cat breed", "infobox horse breed",
    "paleobox", "ichnobox",
  ]],
  [BIT.film, [
    "infobox film", "infobox television", "infobox television episode",
    "infobox television season", "infobox tv channel", "infobox film festival",
  ]],
  [BIT.music, [
    "infobox musical artist", "infobox album", "infobox song", "infobox single",
    "infobox musical composition", "infobox instrument", "infobox music genre",
    "infobox concert tour", "infobox musical",
  ]],
  [BIT.sport, [
    "infobox sportsperson", "infobox football biography", "infobox football club",
    "infobox baseball biography", "infobox basketball biography", "infobox ice hockey player",
    "infobox cricketer", "infobox tennis biography", "infobox boxer", "infobox golfer",
    "infobox nfl biography", "infobox olympic event", "infobox sports team",
    "infobox athlete", "infobox motorsport driver", "infobox rugby biography",
    "infobox swimmer", "infobox gymnast", "infobox sport", "infobox stadium",
  ]],
  [BIT.games, ["infobox video game", "infobox board game", "infobox game", "infobox arcade game"]],
  [BIT.books, [
    "infobox book", "infobox novel", "infobox comic book title", "infobox comics character",
    "infobox magazine", "infobox newspaper", "infobox short story", "infobox poem",
    "infobox manga", "infobox anime", "infobox writer",
  ]],
  [BIT.science, [
    "chembox", "infobox medical condition", "infobox disease", "infobox mineral",
    "infobox planet", "infobox spacecraft", "infobox star", "infobox galaxy",
    "infobox element", "infobox protein", "infobox gene", "infobox enzyme",
    "infobox anatomy", "infobox drug", "infobox nebula", "infobox telescope",
    "infobox scientist",
  ]],
  [BIT.history, [
    "infobox military conflict", "infobox war", "infobox treaty", "infobox historical event",
    "infobox battle", "infobox civil conflict", "infobox archaeological site",
    "infobox ancient site", "infobox former country", "infobox military person",
  ]],
  [BIT.food, [
    "infobox food", "infobox dish", "infobox prepared food", "infobox beverage",
    "infobox drink", "infobox cheese", "infobox wine region",
  ]],
  [BIT.tech, [
    "infobox aircraft", "infobox aircraft type", "infobox automobile", "infobox ship",
    "infobox locomotive", "infobox train", "infobox rocket", "infobox weapon",
    "infobox software", "infobox website", "infobox company", "infobox brand",
    "infobox operating system", "infobox programming language",
  ]],
];

// name -> mask, built once.
const TEMPLATE_INDEX = new Map();
for (const [bit, names] of TEMPLATE_RULES) {
  for (const n of names) TEMPLATE_INDEX.set(n, (TEMPLATE_INDEX.get(n) || 0) | bit);
}

// ── Category rules ───────────────────────────────────────────────────────────
// Deliberately conservative. Wikipedia categories are a swamp of maintenance
// tags, so only patterns that are almost never wrong are here. "Living people"
// and "1962 births" in particular are near-perfect biography markers and cover
// the many people-articles that use a specialised infobox we don't list.
const CATEGORY_RULES = [
  [BIT.people, [/^living people$/i, /^\d{3,4}s? births$/i, /^\d{3,4}s? deaths$/i]],
  [BIT.nature, [/\bspecies\b/i, /\bgenera\b/i, /^(birds|mammals|insects|fish|reptiles|amphibians|plants|fungi|molluscs)\b/i, /\bfauna\b/i, /\bflora\b/i]],
  // The television patterns are anchored to a leading year on purpose. Real show
  // categories look like "2019 American television series debuts"; the people who
  // appear on them are filed under "Participants in American reality television
  // series", which an unanchored /television series$/ also matches. Measured on
  // the built pool, that unanchored form put 6% of Film & TV — Katy Perry, Ozzy
  // Osbourne, Ariana Grande — into a category a player would never expect them
  // in. Actual shows are caught reliably by Template:Infobox television above.
  [BIT.film, [/^\d{4} films$/i, /\bfilms$/i, /^\d{4}s?\b.*\btelevision series/i, /^\d{4}s?\b.*\btelevision shows/i]],
  [BIT.music, [/\balbums$/i, /\bsongs$/i, /\bmusical groups\b/i, /\bsingles$/i]],
  [BIT.books, [/\bnovels$/i, /\bbooks$/i, /\bcomics$/i]],
  [BIT.games, [/\bvideo games$/i, /\bboard games$/i]],
  [BIT.sport, [/\bfootballers$/i, /\bcricketers$/i, /\bsportspeople\b/i]],
  [BIT.places, [/\bpopulated places\b/i, /^(cities|towns|villages)\b/i, /\bmunicipalities\b/i]],
  [BIT.food, [/\bcuisine$/i, /\bfoods$/i, /\bbeverages$/i, /\bdishes$/i]],
];

// "Template:Infobox musical artist/color" -> "infobox musical artist"
function normalizeTemplate(name) {
  let s = String(name || "").toLowerCase();
  if (s.startsWith("template:")) s = s.slice(9);
  const slash = s.indexOf("/");
  if (slash !== -1) s = s.slice(0, slash);
  return s.trim();
}

// Classify one article into a category bitmask. Build-time only.
function classify(templates, categories) {
  let mask = 0;
  for (const t of templates || []) {
    const hit = TEMPLATE_INDEX.get(normalizeTemplate(t));
    if (hit) mask |= hit;
  }
  // Categories run regardless rather than only as a fallback: the rules above
  // are high-precision, and they usefully ADD to a template match (a footballer
  // tagged only `sport` by their infobox is also a person).
  for (const c of categories || []) {
    for (const [bit, patterns] of CATEGORY_RULES) {
      if (mask & bit) continue; // already established; skip the regex work
      for (const re of patterns) {
        if (re.test(c)) { mask |= bit; break; }
      }
    }
  }
  return mask;
}

// ── Runtime helpers ──────────────────────────────────────────────────────────

// Keep only recognised keys, de-duplicated and in CATEGORIES order so a room's
// setting is stable no matter what order the client sent.
function normalizeCategories(list) {
  if (!Array.isArray(list)) return [];
  const want = new Set(list.map((c) => String(c)));
  return CATEGORIES.filter((c) => want.has(c));
}

// Bitmask for a set of category keys. An empty selection means "anything", and
// callers treat a 0 mask as "no filter" rather than "match nothing".
function maskFor(list) {
  let mask = 0;
  for (const c of normalizeCategories(list)) mask |= BIT[c];
  return mask;
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  BIT,
  classify,
  normalizeCategories,
  maskFor,
  normalizeTemplate,
};
