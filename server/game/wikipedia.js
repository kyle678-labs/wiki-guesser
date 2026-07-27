"use strict";

const { TOPICS } = require("./topics");
const { textFreq, titleWords } = require("./scoring");
const { buildClue, firstSentences } = require("./extract");

const MAX_WORDS = 2;
const UA = "wiki-guesser/0.1 (multiplayer guessing game; contact: admin@example.com)";

async function wikiFetch(url) {
  return fetch(url, { headers: { "Api-User-Agent": UA, Accept: "application/json" } });
}

function pickImage(data) {
  if (data.originalimage && data.originalimage.width <= 4000) return data.originalimage.source;
  if (data.thumbnail) return data.thumbnail.source;
  return data.originalimage ? data.originalimage.source : null;
}

// Whether an article can serve the requested clue type. Image mode needs a
// picture; text ("description") mode needs a couple of usable sentences.
function hasClue(data, clue) {
  if (clue === "text") return firstSentences(data.extract || "", 2).length >= 40;
  return Boolean(pickImage(data));
}

// Word-frequency table of the answer's full article text.
async function fetchArticleFreq(title) {
  try {
    const url =
      "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=extracts&explaintext=1&titles=" +
      encodeURIComponent(title);
    const res = await wikiFetch(url);
    if (!res.ok) return new Map();
    const data = await res.json();
    const page = data.query && data.query.pages && Object.values(data.query.pages)[0];
    return textFreq((page && page.extract) || "");
  } catch {
    return new Map();
  }
}

async function toMystery(title, data) {
  const canonical = (data.titles && data.titles.canonical) || title;
  let freq = await fetchArticleFreq(canonical);
  if (freq.size === 0) freq = textFreq((data.description || "") + " " + (data.extract || ""));
  const url =
    (data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page) ||
    "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(canonical || title).replace(/ /g, "_"));
  const clue = buildClue(data.extract || "", title, 2);
  return {
    title,
    words: titleWords(title),
    img: pickImage(data),
    desc: data.description || "",
    url,
    extract: clue.blanked, // shown as the clue (title blanked out)
    extractFull: clue.full, // revealed after the round
    freq, // kept server-side only
  };
}

// Curated "party mix": a guessable topic with a known-good clue.
async function fetchCurated(used = new Set(), clue = "image") {
  for (let attempt = 0; attempt < 14; attempt++) {
    const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
    if (used.size < TOPICS.length && used.has(topic)) continue;
    const res = await wikiFetch(
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(topic)
    );
    if (!res.ok) continue;
    const data = await res.json();
    if (!hasClue(data, clue)) continue;
    used.add(topic);
    return toMystery(topic, data);
  }
  throw new Error("Couldn't fetch a usable topic");
}

// "Total chaos": a genuinely random article with a 1–2 word title.
async function fetchChaos(used = new Set(), clue = "image") {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await wikiFetch("https://en.wikipedia.org/api/rest_v1/page/random/summary");
    if (!res.ok) continue;
    const data = await res.json();
    if (data.type !== "standard") continue;
    const title = data.title.replace(/\s*\(.*?\)\s*/g, " ").trim();
    const words = titleWords(title);
    if (words.length < 1 || words.length > MAX_WORDS) continue;
    if (!/^[a-zA-ZÀ-ɏ' -]+$/.test(title)) continue;
    if (used.has(title.toLowerCase())) continue;
    if (!hasClue(data, clue)) continue;
    used.add(title.toLowerCase());
    return toMystery(title, data);
  }
  throw new Error("Couldn't find a good mystery article after many tries");
}

// mode: "party" | "chaos"; clue: "image" | "text". Retries on transient failures.
async function fetchMystery(mode = "party", used = new Set(), clue = "image") {
  const pick = mode === "chaos" ? fetchChaos : fetchCurated;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await pick(used, clue);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Failed to fetch mystery");
}

module.exports = { fetchMystery };
