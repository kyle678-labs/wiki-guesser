"use strict";

// The three game modes. Each is a separate ranked ladder.
//   image – picture clues only
//   text  – description clues only (title blanked out)
//   mixed – each round is randomly a picture or a description
const MODES = ["image", "text", "mixed"];

const MODE_LABELS = { image: "Pictures", text: "Descriptions", mixed: "Combined" };

function normalizeMode(m) {
  return MODES.includes(m) ? m : "image";
}

module.exports = { MODES, MODE_LABELS, normalizeMode };
