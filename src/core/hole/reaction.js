/** @typedef {"up" | "down"} ReactionKey */

/** @type {readonly ReactionKey[]} */
export const REACTION_KEYS = Object.freeze(["up", "down"]);

/** @type {Readonly<Record<ReactionKey, Readonly<{ glyph: string, instruction: string }>>>} */
export const DEFAULT_REACTION_PROMPTS = Object.freeze({
  up: Object.freeze({ glyph: "👍", instruction: "This landed well — use a similar approach." }),
  down: Object.freeze({ glyph: "👎", instruction: "This didn't land — take a different approach." }),
});

/** @param {unknown} value @returns {ReactionKey | null} */
export function normalizeReactionKey(value) {
  return value === "up" || value === "down" ? value : null;
}

/** @param {{ origin?: any } | null | undefined} node */
export function reactionInstructionForNode(node) {
  return String(node?.origin?.instruction ?? "")
    .trim()
    .slice(0, 4000);
}
