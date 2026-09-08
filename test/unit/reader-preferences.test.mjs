/** @protects reader preferences capability contracts. */
import assert from "node:assert/strict";
import {
  ASK_PRESET_KEYS,
  DEFAULT_ASK_PRESET_KEYS,
  DEFAULT_ASK_PRESETS,
  LENSES,
  lensLabel,
  normalizeLens,
} from "../../src/core/hole/lens.js";
import { DEFAULT_REACTION_PROMPTS } from "../../src/core/hole/reaction.js";

/*
 * Theme and global reading size belong to the reader, not the document. This
 * covers the pure part: clamping, the three-state theme, and the fact that a
 * store that refuses writes still holds the choice for the life of the page.
 */

const store = new Map();
let storageWritable = true;
(/** @type {any} */ (globalThis)).localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    if (!storageWritable) throw new Error("storage is unavailable");
    store.set(key, String(value));
  },
  removeItem: (key) => store.delete(key),
};

let systemPrefersDark = false;
const mediaListeners = new Set();
const root = {
  attributes: new Map(),
  classList: { add(){}, remove(){} },
  getAttribute(name){ return this.attributes.has(name) ? this.attributes.get(name) : null; },
  setAttribute(name, value){ this.attributes.set(name, value); },
};
(/** @type {any} */ (globalThis)).document = { documentElement: root };
(/** @type {any} */ (globalThis)).window = {
  matchMedia: (query) => ({
    matches: query.includes("dark") ? systemPrefersDark : false,
    addEventListener: (_type, handler) => mediaListeners.add(handler),
    removeEventListener: (_type, handler) => mediaListeners.delete(handler),
  }),
};
globalThis.matchMedia = globalThis.window.matchMedia;

const {
  READING_SCALE_MAX,
  READING_SCALE_MIN,
  applyTheme,
  ASK_PRESETS_KEY,
  REACTION_PROMPTS_KEY,
  askPreset,
  askPresetsLinked,
  createCustomAskPreset,
  setAskPresetsLinked,
  normalizeAskPresets,
  normalizeReactionPrompts,
  clampReadingScale,
  onPreferenceChange,
  readingScale,
  reactionPrompt,
  resetPreferenceBacking,
  resolvedTheme,
  setReadingScale,
  setAskPreset,
  setAskPresetRemoved,
  visibleAskPresetKeys,
  resetAskPreset,
  resetReactionPrompt,
  setThemePreference,
  setReactionPrompt,
  themePreference,
  toggleTheme,
} = await import("../../src/ui/preferences.js");

// ---- asking presets -------------------------------------------------------

assert.deepEqual(DEFAULT_ASK_PRESET_KEYS, ["explain", "eli5", "deeper"], "three built-in preset slots keep their order");
assert.deepEqual(ASK_PRESET_KEYS, ["explain", "eli5", "deeper", "custom"],
  "one stable optional custom key follows the built-in slots");
assert.equal(Object.values(LENSES).every((preset) =>
  typeof preset.label === "string" && preset.label.trim()
  && typeof preset.instruction === "string" && preset.instruction.trim()), true,
  "every built-in preset carries a non-empty label and instruction");
assert.strictEqual(DEFAULT_ASK_PRESETS.selection, LENSES);
assert.strictEqual(DEFAULT_ASK_PRESETS.followup, DEFAULT_ASK_PRESETS.selection,
  "selection and follow-up share the same defaults until a reader unlinks them");
assert.equal(lensLabel("example"), "Example", "retired persisted lenses keep their display label");
assert.equal(normalizeLens("example"), null, "new asks cannot normalize to the retired Example lens");
assert.equal(normalizeLens("custom"), "custom", "the optional slot keeps a stable lens key on new asks");

const migratedPresets = normalizeAskPresets({
  lenses: {
    go_deeper: { label: "Mechanism", q: "Show the mechanism." },
  },
});
assert.deepEqual(migratedPresets.followup.deeper,
  { label: "Mechanism", instruction: "Show the mechanism.", removed: false },
  "supported historical identifiers and q fields migrate to the canonical preset shape");
assert.notEqual(migratedPresets.selection, migratedPresets.followup, "selection and follow-up sets are independent objects");

const storedV1Presets = normalizeAskPresets(JSON.parse(JSON.stringify({
  version: 1,
  linked: false,
  selection: {
    explain: { label: "Stored explanation", instruction: "Use the stored wording.", removed: false },
    example: { label: "Worked", instruction: "Show a stored example.", removed: false },
  },
  followup: {
    example: { label: "Worked", instruction: "Show another example.", removed: false },
  },
})));
assert.equal(Object.hasOwn(storedV1Presets.selection, "example"), false,
  "a stored v1 Example entry is silently dropped from selection presets");
assert.equal(Object.hasOwn(storedV1Presets.followup, "example"), false,
  "a stored v1 Example entry is silently dropped from follow-up presets");
assert.deepEqual(storedV1Presets.selection.explain,
  { label: "Stored explanation", instruction: "Use the stored wording.", removed: false },
  "a stored v1 preset retains its validated label, instruction, and removal flag");
assert.equal(normalizeAskPresets(null).linked, true, "empty storage starts with one linked preset set");
assert.equal(normalizeAskPresets({ linked: false }).linked, false, "an explicitly unlinked stored preference survives");
assert.equal(normalizeAskPresets({ linked: "yes" }).linked, true, "only explicit false opts out of linking");
assert.equal(Object.hasOwn(normalizeAskPresets({ selection: {
  custom: { label: "Lost", instruction: "Do not restore me.", removed: true },
} }).selection, "custom"), false, "a removed custom entry normalizes back to an absent slot");

assert.equal(askPresetsLinked(), true, "the live empty store starts linked");
assert.equal(askPreset("selection", "explain").label, "Explain");
assert.equal(askPreset("selection", "explain").instruction, "Explain this further.",
  "default instructions are minimal — the model needs the move, not an essay");
assert.equal(askPreset("followup", "example"), null, "retired stored keys are not exposed as editable presets");
setAskPresetsLinked(false);
setAskPreset("selection", "explain", { label: "Clarify", instruction: "Lead with the key distinction." });
assert.deepEqual(askPreset("selection", "explain"),
  { label: "Clarify", instruction: "Lead with the key distinction.", removed: false });
assert.equal(askPreset("followup", "explain").label, "Explain", "editing selection presets must not affect follow-ups");
assert.equal(JSON.parse(store.get(ASK_PRESETS_KEY)).version, 1, "asking preferences live in a versioned global key");
const existingExplain = askPreset("selection", "explain");
const beforeEmptyLabel = store.get(ASK_PRESETS_KEY);
assert.strictEqual(setAskPreset("selection", "explain", { label: "   " }), existingExplain,
  "an empty label returns the existing preset unchanged");
assert.equal(store.get(ASK_PRESETS_KEY), beforeEmptyLabel, "an invalid label does not rewrite storage");
assert.equal(setAskPreset("selection", "explain", { label: "  Clarify succinctly  " }).label, "Clarify succinctly",
  "label edits trim before they are stored");
assert.equal(JSON.parse(store.get(ASK_PRESETS_KEY)).selection.explain.label, "Clarify succinctly");
const trimmedExplain = askPreset("selection", "explain");
const beforeEmptyInstruction = store.get(ASK_PRESETS_KEY);
assert.strictEqual(setAskPreset("selection", "explain", { instruction: "   " }), trimmedExplain,
  "an empty instruction returns the existing preset unchanged");
assert.equal(store.get(ASK_PRESETS_KEY), beforeEmptyInstruction, "an invalid instruction does not rewrite storage");
assert.equal(setAskPreset("selection", "explain", { instruction: "  State the key distinction.  " }).instruction,
  "State the key distinction.", "instruction edits trim before they are stored");
assert.equal(JSON.parse(store.get(ASK_PRESETS_KEY)).selection.explain.instruction, "State the key distinction.");
resetAskPreset("selection", "explain");
assert.deepEqual(askPreset("selection", "explain"),
  { label: "Explain", instruction: "Explain this further.", removed: false });

// ---- linked follow-ups ----------------------------------------------------

assert.equal(normalizeAskPresets({ linked: true }).linked, true, "the linked flag rides the same versioned key");
setAskPreset("selection", "deeper", { label: "Mechanism", instruction: "Show the mechanism." });
setAskPreset("followup", "deeper", { label: "Own", instruction: "Follow-up flavored." });
setAskPresetsLinked(true);
assert.equal(askPresetsLinked(), true);
assert.deepEqual(askPreset("followup", "deeper"),
  { label: "Mechanism", instruction: "Show the mechanism.", removed: false },
  "while linked every follow-up read resolves to the selection preset — buttons, badges, and the wire all follow");
assert.equal(JSON.parse(store.get(ASK_PRESETS_KEY)).linked, true);
assert.equal(JSON.parse(store.get(ASK_PRESETS_KEY)).followup.deeper.label, "Own",
  "the stored follow-up set is untouched while linked");
setAskPresetsLinked(false);
assert.deepEqual(askPreset("followup", "deeper"),
  { label: "Own", instruction: "Follow-up flavored.", removed: false },
  "unlinking restores the follow-up customizations exactly");
resetAskPreset("selection", "deeper");
resetAskPreset("followup", "deeper");

// ---- removable presets ----------------------------------------------------

const freshPresets = normalizeAskPresets(null);
assert.deepEqual(Object.entries(freshPresets.selection).filter(([, preset]) => !preset.removed).map(([key]) => key),
  ["explain", "eli5", "deeper"], "fresh selection preferences show three lenses");
assert.deepEqual(Object.entries(freshPresets.followup).filter(([, preset]) => !preset.removed).map(([key]) => key),
  ["explain", "eli5", "deeper"], "fresh follow-up preferences use the same three-slot ceiling");
assert.deepEqual(visibleAskPresetKeys("selection"), ["explain", "eli5", "deeper"],
  "the live selection row exposes exactly the supported slots");
assert.equal(normalizeAskPresets(null).selection.explain.removed, false, "removal defaults off");
assert.equal(normalizeAskPresets({ selection: { eli5: { label: "ELI5", instruction: "x", removed: true } } }).selection.eli5.removed, true,
  "removal is a flag on the stored slot, not a hole in the set");
setAskPreset("selection", "eli5", { label: "Kid gloves", instruction: "Very simply." });
setAskPresetRemoved("selection", "eli5", true);
assert.deepEqual(visibleAskPresetKeys("selection"), ["explain", "deeper"],
  "a removed preset leaves the visible row");
assert.equal(askPreset("selection", "eli5").label, "Kid gloves",
  "the removed slot keeps its words — old branch badges and restore both need them");
setAskPresetsLinked(true);
assert.deepEqual(visibleAskPresetKeys("followup"), ["explain", "deeper"],
  "while linked, follow-up visibility follows selection removals");
setAskPresetsLinked(false);
assert.deepEqual(visibleAskPresetKeys("followup"), ["explain", "eli5", "deeper"],
  "unlinked follow-ups keep their own three-slot row");
setAskPresetRemoved("selection", "eli5", false);
assert.deepEqual(visibleAskPresetKeys("selection"), ["explain", "eli5", "deeper"]);
assert.equal(askPreset("selection", "eli5").label, "Kid gloves", "restore brings back the customized words, not the default");
setAskPresetRemoved("selection", "eli5", true);
resetAskPreset("selection", "eli5");
assert.equal(askPreset("selection", "eli5").removed, false, "reset also returns a removed slot to the row");
assert.equal(askPreset("selection", "eli5").label, "ELI5");

// ---- optional custom preset -----------------------------------------------

assert.equal(askPreset("selection", "custom"), null, "fresh sets leave the optional custom slot absent");
const fullSetBeforeCustom = store.get(ASK_PRESETS_KEY);
assert.equal(createCustomAskPreset("selection"), null, "a full three-question set rejects a custom question");
assert.equal(store.get(ASK_PRESETS_KEY), fullSetBeforeCustom, "rejecting a custom question does not rewrite storage");
setAskPresetRemoved("selection", "eli5", true);
assert.deepEqual(createCustomAskPreset("selection"), {
  label: "New question",
  instruction: "Ask a focused question about this.",
  removed: false,
});
assert.deepEqual(visibleAskPresetKeys("selection"), ["explain", "deeper", "custom"],
  "a custom question fills the vacant third slot after the remaining built-ins");
setAskPreset("selection", "custom", { label: "Counterpoint", instruction: "Challenge this claim." });
assert.deepEqual(askPreset("selection", "custom"), {
  label: "Counterpoint",
  instruction: "Challenge this claim.",
  removed: false,
});
const customStored = store.get(ASK_PRESETS_KEY);
resetPreferenceBacking();
assert.equal(store.get(ASK_PRESETS_KEY), customStored);
assert.deepEqual(askPreset("selection", "custom"), {
  label: "Counterpoint",
  instruction: "Challenge this claim.",
  removed: false,
}, "the optional slot reloads from the same v1 preset document");
setAskPresetRemoved("selection", "eli5", false);
assert.deepEqual(visibleAskPresetKeys("selection"), ["explain", "eli5", "deeper"],
  "a legacy three-built-ins-plus-custom store keeps only the built-ins visible");
assert.deepEqual(askPreset("selection", "custom"), {
  label: "Counterpoint",
  instruction: "Challenge this claim.",
  removed: false,
}, "the capped legacy custom question remains stored while hidden");
setAskPresetRemoved("selection", "custom", true);
assert.equal(askPreset("selection", "custom"), null, "removing custom deletes the slot instead of leaving a restore flag");
assert.equal(Object.hasOwn(JSON.parse(store.get(ASK_PRESETS_KEY)).selection, "custom"), false,
  "custom removal persists as absence");
assert.deepEqual(visibleAskPresetKeys("selection"), ["explain", "eli5", "deeper"]);

// ---- reaction prompts -----------------------------------------------------

assert.deepEqual(normalizeReactionPrompts(null), {
  version: 1,
  up: { instruction: DEFAULT_REACTION_PROMPTS.up.instruction },
  down: { instruction: DEFAULT_REACTION_PROMPTS.down.instruction },
}, "fresh reaction prompts use the versioned defaults");
assert.deepEqual(normalizeReactionPrompts({
  version: 99,
  prompts: {
    up: { instruction: "  Keep this shape.  ", glyph: "editable-looking noise" },
    down: { instruction: "   " },
    future: { instruction: "Ignore me." },
  },
}), {
  version: 1,
  up: { instruction: "Keep this shape." },
  down: { instruction: DEFAULT_REACTION_PROMPTS.down.instruction },
}, "unknown, malformed, and blank reaction fields fall back without making glyphs configurable");
assert.equal(reactionPrompt("👍").instruction, DEFAULT_REACTION_PROMPTS.up.instruction,
  "glyph aliases resolve to their fixed prompt slots");
assert.equal(setReactionPrompt("up", { instruction: "  Keep the concrete opening.  " }).instruction,
  "Keep the concrete opening.");
assert.deepEqual(JSON.parse(store.get(REACTION_PROMPTS_KEY)), {
  version: 1,
  up: { instruction: "Keep the concrete opening." },
  down: { instruction: DEFAULT_REACTION_PROMPTS.down.instruction },
}, "reaction prompts persist separately as instructions only");
const beforeBlankReaction = store.get(REACTION_PROMPTS_KEY);
assert.equal(setReactionPrompt("up", { instruction: "   " }).instruction, "Keep the concrete opening.");
assert.equal(store.get(REACTION_PROMPTS_KEY), beforeBlankReaction, "a blank reaction edit does not rewrite storage");
assert.equal(resetReactionPrompt("up").instruction, DEFAULT_REACTION_PROMPTS.up.instruction);

// ---- reading size ---------------------------------------------------------

assert.equal(readingScale(), 1, "an unset reading size is 100%");
assert.equal(clampReadingScale(2.5), READING_SCALE_MAX, "reading size clamps at the top");
assert.equal(clampReadingScale(0.2), READING_SCALE_MIN, "reading size clamps at the bottom");
assert.equal(clampReadingScale("nonsense"), 1, "an unreadable stored value falls back to 100%");
assert.equal(clampReadingScale(1.0000000001), 1, "float drift never leaks into the displayed percentage");
assert.equal(clampReadingScale(1.15), 1.15, "a half step survives the round trip");

const seen = [];
const stopListening = onPreferenceChange((kind) => seen.push(kind));
assert.equal(setReadingScale(1.2), 1.2);
assert.equal(store.get("rh-reading-scale"), "1.2", "the global reading size lives in its own storage slot");
assert.equal(readingScale(), 1.2);
assert.equal(setReadingScale(9), READING_SCALE_MAX, "out-of-range input is clamped before it is stored");
setReadingScale(1);

// The composition the cards render: base x global x per-node font_scale.
const effective = (base, global, fontScale) => Math.round(base * global * fontScale);
assert.equal(effective(17, 1.2, 1.15), 23, "reader base 17 at global 120% and card 115%");
assert.equal(effective(14, 1.2, 1.15), 19, "canvas base 14 at global 120% and card 115%");
assert.equal(effective(14, 1, 1.15), 16, "the same card at global 100% is smaller — the two compose, neither replaces");

// ---- theme ----------------------------------------------------------------

assert.equal(themePreference(), "system", "no stored choice means the page follows the system");
systemPrefersDark = true;
assert.equal(resolvedTheme(), "dark");
applyTheme();
assert.equal(root.getAttribute("data-theme"), "dark", "system resolves to a painted theme");
assert.equal(mediaListeners.size, 1, "system mode listens for the system flipping under it");

systemPrefersDark = false;
mediaListeners.forEach((handler) => handler());
assert.equal(root.getAttribute("data-theme"), "light", "a system flip repaints while the preference stays system");
assert.equal(themePreference(), "system");

assert.equal(setThemePreference("dark"), "dark");
assert.equal(store.get("rh-theme"), "dark", "the theme keeps its existing storage slot");
assert.equal(root.getAttribute("data-theme"), "dark");
assert.equal(mediaListeners.size, 0, "an explicit choice stops following the system");

// The taskbar button is a quick toggle: it always commits an explicit choice.
setThemePreference("system");
systemPrefersDark = true;
applyTheme();
assert.equal(toggleTheme(), "light", "toggling out of system writes the opposite of what is painted");
assert.equal(themePreference(), "light");

assert.deepEqual(new Set(seen), new Set(["reading-scale", "theme"]), "both active listeners announce their changes");
stopListening();
const before = seen.length;
setReadingScale(1.1);
assert.equal(seen.length, before, "unsubscribing stops the announcements");

// ---- a store that refuses writes ------------------------------------------

storageWritable = false;
assert.equal(setThemePreference("dark"), "dark");
assert.equal(themePreference(), "dark", "a snapshot opened without localStorage still holds the choice");
assert.equal(setReadingScale(1.3), 1.3);
assert.equal(readingScale(), 1.3);
storageWritable = true;

console.log("reader preferences ok");
