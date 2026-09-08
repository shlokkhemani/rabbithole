export const DEFAULT_ASK_PRESET_KEYS = Object.freeze(["explain", "eli5", "deeper"]);
export const ASK_PRESET_KEYS = Object.freeze([...DEFAULT_ASK_PRESET_KEYS, "custom"]);

/*
 * Default instructions are deliberately minimal: the model already sees the
 * selection and the document, so a preset only needs to name the move. Anyone
 * who wants a more opinionated instruction edits the preset in Settings.
 *
 * A surface shows at most three questions. These built-ins fill the slots by
 * default; a custom question can exist only by filling a slot a reader vacates.
 */
/** @type {Readonly<Record<PropertyKey, { label: string, instruction: string, removed?: boolean }>>} */
export const LENSES = Object.freeze({
  explain: Object.freeze({ label: "Explain", instruction: "Explain this further." }),
  eli5: Object.freeze({ label: "ELI5", instruction: "Explain like I'm five." }),
  deeper: Object.freeze({ label: "Go deeper", instruction: "Go one level deeper." }),
});

/*
 * Lens keys that once shipped as defaults. Old nodes still carry them in
 * origin.lens, so they keep a display label without ever being offered again.
 */
/** @type {Readonly<Record<PropertyKey, string>>} */
const LEGACY_LENS_LABELS = Object.freeze({ example: "Example" });

// Selection and follow-up ask the same three questions out of the box; the
// sets only diverge once someone unlinks them in Settings.
export const DEFAULT_ASK_PRESETS = Object.freeze({
  selection: LENSES,
  followup: LENSES,
});

/** @param {unknown} value @param {number} length */
export function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}

/** @param {PropertyKey} key */
export function lensLabel(key) {
  if (LENSES[key]) return LENSES[key].label;
  if (key === "custom") return "Custom question";
  return LEGACY_LENS_LABELS[key] || String(key || "");
}

/** @param {unknown} lens */
export function normalizeLens(lens) {
  const key = String(lens ?? "").trim();
  return ASK_PRESET_KEYS.includes(key) ? key : null;
}
