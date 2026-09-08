/*
 * Preferences that belong to the reader, not the document.
 *
 * Theme and global reading size describe the eyes and the monitor in front of
 * the page — not the thing being read. Stable web origins keep them in
 * localStorage; ephemeral MCP origins compose a machine-backed store under
 * the same string encoding. They never enter the hole document, the
 * node_update wire, exports, or the portable format. Per-node `font_scale` is
 * the authorial counterpart and stays in the doc; the two compose (see fontPx
 * in core.js).
 */

import { ASK_PRESET_KEYS, DEFAULT_ASK_PRESET_KEYS, DEFAULT_ASK_PRESETS } from "../core/hole/lens.js";
import { DEFAULT_REACTION_PROMPTS, normalizeReactionKey, REACTION_KEYS } from "../core/hole/reaction.js";

const THEME_KEY = "rh-theme";
const READING_SCALE_KEY = "rh-reading-scale";
const AUTO_TIDY_KEY = "rh-auto-tidy";
const AUTO_TIDY_GRACE_KEY = "rh-auto-tidy-grace";
export const AI_IMAGES_PREF_KEY = "rh-ai-images";
export const ASK_PRESETS_KEY = "rh-ask-presets-v1";
export const REACTION_PROMPTS_KEY = "rh-reaction-prompts-v1";

export const READING_SCALE_MIN = 0.8;
export const READING_SCALE_MAX = 1.4;
export const READING_SCALE_STEP = 0.1;
export const AUTO_TIDY_GRACE_DEFAULT = 120;
export const AUTO_TIDY_GRACE_STOPS = [30, 60, 120, 300, 600];

const listeners = [];
let systemThemeMql = null;
let readingScaleCache = null;
let autoTidyEnabledCache = null;
let autoTidyGraceCache = null;
let aiImagesEnabledCache = null;
let swapFrame = 0;
let askPresetsCache = null;
let reactionPromptsCache = null;
let configuredBacking = null;
let configuredValues = null;

/*
 * A frozen snapshot is often opened from a file or a data document where
 * localStorage throws. The preference still has to hold for the life of the
 * page, so an unwritable store falls back to memory rather than silently
 * refusing the change.
 */
const memory = Object.create(null);

function readStored(key) {
  if (configuredValues) return configuredValues[key] === undefined ? "" : configuredValues[key];
  // A value only lands in memory when the store refused it, so it is always
  // the more recent intent.
  if (memory[key] !== undefined) return memory[key];
  try {
    return localStorage.getItem(key) || "";
  } catch (error) {}
  return "";
}

function writeStored(key, value) {
  if (configuredValues) {
    configuredValues[key] = value;
    try {
      configuredBacking.write(key, value);
    } catch (error) {}
    return;
  }
  try {
    localStorage.setItem(key, value);
    delete memory[key];
  } catch (error) {
    memory[key] = value;
  }
}

function removeStored(key) {
  if (configuredValues) {
    delete configuredValues[key];
    try {
      configuredBacking.write(key, null);
    } catch (error) {}
    return;
  }
  try {
    localStorage.removeItem(key);
    delete memory[key];
  } catch (error) {
    memory[key] = "";
  }
}

function resetDerivedCaches() {
  readingScaleCache = null;
  autoTidyEnabledCache = null;
  autoTidyGraceCache = null;
  aiImagesEnabledCache = null;
  askPresetsCache = null;
  reactionPromptsCache = null;
}

export function configurePreferenceBacking(backing) {
  const seed = backing && backing.seed && typeof backing.seed === "object" ? backing.seed : {};
  configuredBacking = backing && typeof backing.write === "function" ? backing : { write: function () {} };
  configuredValues = Object.create(null);
  Object.keys(seed).forEach(function (key) {
    if (typeof seed[key] === "string") configuredValues[key] = seed[key];
  });
  resetDerivedCaches();
}

export function resetPreferenceBacking() {
  configuredBacking = null;
  configuredValues = null;
  resetDerivedCaches();
}

function preferenceKind(key) {
  if (key === THEME_KEY) return "theme";
  if (key === READING_SCALE_KEY) return "reading-scale";
  if (key === ASK_PRESETS_KEY) return "ask-presets";
  if (key === REACTION_PROMPTS_KEY) return "reaction-prompts";
  if (key === AUTO_TIDY_KEY || key === AUTO_TIDY_GRACE_KEY) return "auto-tidy";
  if (key === AI_IMAGES_PREF_KEY) return "ai-images";
  return null;
}

export function applyPreferencePatch(values) {
  if (!configuredValues || !values || typeof values !== "object" || Array.isArray(values)) return false;
  const kinds = new Set();
  Object.keys(values).forEach(function (key) {
    const value = values[key];
    if (value === null) delete configuredValues[key];
    else if (typeof value === "string") configuredValues[key] = value;
    else return;
    const kind = preferenceKind(key);
    if (kind) kinds.add(kind);
  });
  resetDerivedCaches();
  kinds.forEach(function (kind) {
    if (kind === "theme") applyTheme();
    notify(kind);
  });
  return true;
}

export function onPreferenceChange(handler) {
  if (typeof handler !== "function") return function () {};
  listeners.push(handler);
  return function () {
    const index = listeners.indexOf(handler);
    if (index !== -1) listeners.splice(index, 1);
  };
}

function notify(kind) {
  const snapshot = listeners.slice();
  for (let i = 0; i < snapshot.length; i++) {
    try {
      snapshot[i](kind);
    } catch (error) {}
  }
}

// ---------------------------------------------------------------- theme

/** The stored choice: "light", "dark", or "system" (the default). */
export function themePreference() {
  const saved = readStored(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function systemTheme() {
  try {
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch (error) {
    return "light";
  }
}

/** What the page actually paints right now. */
export function resolvedTheme() {
  const preference = themePreference();
  return preference === "system" ? systemTheme() : preference;
}

export function setThemePreference(value) {
  const next = value === "light" || value === "dark" ? value : "system";
  writeStored(THEME_KEY, next);
  applyTheme();
  notify("theme");
  return next;
}

/*
 * The taskbar button is a quick toggle, not a third state: pressing it always
 * commits an explicit light/dark choice and leaves "system" behind.
 */
export function toggleTheme() {
  return setThemePreference(resolvedTheme() === "dark" ? "light" : "dark");
}

export function applyTheme() {
  const root = document.documentElement;
  const resolved = resolvedTheme();
  if (root.getAttribute("data-theme") !== resolved) suppressColorTransitions(root);
  root.setAttribute("data-theme", resolved);
  syncSystemThemeListener();
  return resolved;
}

/*
 * Every surface animates its colours; swapping the whole palette through those
 * transitions smears the page for a frame. Kill them for exactly the swap.
 */
function suppressColorTransitions(root) {
  root.classList.add("theme-swapping");
  const clear = function () {
    swapFrame = 0;
    root.classList.remove("theme-swapping");
  };
  if (swapFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(swapFrame);
  if (typeof requestAnimationFrame !== "function") {
    clear();
    return;
  }
  swapFrame = requestAnimationFrame(function () {
    swapFrame = requestAnimationFrame(clear);
  });
}

function onSystemThemeChange() {
  if (themePreference() !== "system") return;
  applyTheme();
  notify("theme");
}

function syncSystemThemeListener() {
  const wanted = themePreference() === "system";
  if (wanted && !systemThemeMql) {
    try {
      systemThemeMql = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
    } catch (error) {
      systemThemeMql = null;
    }
    if (!systemThemeMql) return;
    if (systemThemeMql.addEventListener) systemThemeMql.addEventListener("change", onSystemThemeChange);
    else if (systemThemeMql.addListener) systemThemeMql.addListener(onSystemThemeChange);
    return;
  }
  if (!wanted && systemThemeMql) {
    if (systemThemeMql.removeEventListener) systemThemeMql.removeEventListener("change", onSystemThemeChange);
    else if (systemThemeMql.removeListener) systemThemeMql.removeListener(onSystemThemeChange);
    systemThemeMql = null;
  }
}

// -------------------------------------------------------- reading size

export function clampReadingScale(value) {
  const numeric = typeof value === "number" ? value : parseFloat(value);
  if (!isFinite(numeric)) return 1;
  return Math.round(Math.min(READING_SCALE_MAX, Math.max(READING_SCALE_MIN, numeric)) * 100) / 100;
}

export function readingScale() {
  if (readingScaleCache === null) readingScaleCache = clampReadingScale(readStored(READING_SCALE_KEY));
  return readingScaleCache;
}

export function setReadingScale(value) {
  const next = clampReadingScale(value);
  readingScaleCache = next;
  writeStored(READING_SCALE_KEY, String(next));
  notify("reading-scale");
  return next;
}

// ------------------------------------------------------------ auto-tidy

export function autoTidyEnabled() {
  if (autoTidyEnabledCache === null) autoTidyEnabledCache = readStored(AUTO_TIDY_KEY) === "on";
  return autoTidyEnabledCache;
}

export function setAutoTidyEnabled(value) {
  const next = value === true;
  autoTidyEnabledCache = next;
  if (next) writeStored(AUTO_TIDY_KEY, "on");
  else removeStored(AUTO_TIDY_KEY);
  notify("auto-tidy");
  return next;
}

export function clampAutoTidyGraceSeconds(value) {
  if (value == null || String(value).trim() === "") return AUTO_TIDY_GRACE_DEFAULT;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return AUTO_TIDY_GRACE_DEFAULT;
  return Math.min(900, Math.max(5, Math.round(numeric)));
}

export function autoTidyGraceSeconds() {
  if (autoTidyGraceCache === null) autoTidyGraceCache = clampAutoTidyGraceSeconds(readStored(AUTO_TIDY_GRACE_KEY));
  return autoTidyGraceCache;
}

export function setAutoTidyGraceSeconds(value) {
  const next = clampAutoTidyGraceSeconds(value);
  autoTidyGraceCache = next;
  writeStored(AUTO_TIDY_GRACE_KEY, String(next));
  notify("auto-tidy");
  return next;
}

// ------------------------------------------------------------- AI images

export function aiImagesEnabled() {
  if (aiImagesEnabledCache === null) aiImagesEnabledCache = readStored(AI_IMAGES_PREF_KEY) === "on";
  return aiImagesEnabledCache;
}

export function setAiImagesEnabled(value) {
  const next = value === true;
  aiImagesEnabledCache = next;
  if (next) writeStored(AI_IMAGES_PREF_KEY, "on");
  else removeStored(AI_IMAGES_PREF_KEY);
  notify("ai-images");
  return next;
}

// ------------------------------------------------------------ ask presets

/*
 * "example" and its spellings are absent on purpose: the slot retired before
 * the optional custom slot shipped, so stored entries for it stay dropped.
 */
const PRESET_KEY_ALIASES = Object.freeze({
  explain: "explain",
  eli5: "eli5",
  deeper: "deeper",
  "go-deeper": "deeper",
  go_deeper: "deeper",
  custom: "custom",
});

function clonePresetSetDefaults(set) {
  return Object.fromEntries(
    DEFAULT_ASK_PRESET_KEYS.map((key) => [
      key,
      {
        label: DEFAULT_ASK_PRESETS[set][key].label,
        instruction: DEFAULT_ASK_PRESETS[set][key].instruction,
        removed: DEFAULT_ASK_PRESETS[set][key].removed === true,
      },
    ]),
  );
}

function clonePresetDefaults() {
  return {
    version: 1,
    linked: true,
    selection: clonePresetSetDefaults("selection"),
    followup: clonePresetSetDefaults("followup"),
  };
}

function normalizedPresetKey(value) {
  return (
    PRESET_KEY_ALIASES[
      String(value || "")
        .trim()
        .toLowerCase()
    ] || null
  );
}

function normalizePresetSet(value, defaults) {
  const out = { ...defaults };
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [entry?.key ?? entry?.id ?? ASK_PRESET_KEYS[index], entry])
    : value && typeof value === "object"
      ? Object.entries(value)
      : [];
  for (const [rawKey, rawPreset] of entries) {
    const key = normalizedPresetKey(rawKey);
    if (!key || !rawPreset || typeof rawPreset !== "object" || Array.isArray(rawPreset)) continue;
    const label = String(rawPreset.label ?? "").trim();
    const instruction = String(rawPreset.instruction ?? rawPreset.q ?? "").trim();
    if (label && instruction && !(key === "custom" && rawPreset.removed === true))
      out[key] = {
        label: label.slice(0, 80),
        instruction: instruction.slice(0, 4000),
        removed: rawPreset.removed === true,
      };
  }
  return out;
}

/** Migrate and validate storage only here; callers always receive v1 canonical keys. */
export function normalizeAskPresets(value) {
  const defaults = clonePresetDefaults();
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const legacySets = raw.presets && typeof raw.presets === "object" ? raw.presets : raw;
  const shared = legacySets.lenses || legacySets.default || null;
  return {
    version: 1,
    // Linked is the default: one set everywhere until someone unlinks. Only an
    // explicit false survives — v1 always writes the boolean, and the legacy
    // shapes shared one set anyway.
    linked: raw.linked !== false,
    selection: normalizePresetSet(legacySets.selection || shared, defaults.selection),
    followup: normalizePresetSet(legacySets.followup || legacySets.followups || shared, defaults.followup),
  };
}

export function askPresets() {
  if (!askPresetsCache) {
    let parsed = null;
    try {
      parsed = JSON.parse(readStored(ASK_PRESETS_KEY));
    } catch (error) {}
    askPresetsCache = normalizeAskPresets(parsed);
  }
  return askPresetsCache;
}

/*
 * The link resolves here, at the single read point, so every consumer — the
 * live button rows, badge labels, and the wire instruction — follows the
 * toggle without knowing it exists. The stored follow-up set is untouched
 * while linked; unlinking restores it exactly.
 */
export function askPreset(set, key) {
  let setKey = set === "selection" ? "selection" : "followup";
  if (setKey === "followup" && askPresets().linked) setKey = "selection";
  const presetKey = normalizedPresetKey(key);
  return presetKey ? askPresets()[setKey][presetKey] || null : null;
}

export function askPresetsLinked() {
  return askPresets().linked === true;
}

/** The keys a surface actually shows, in row order — removal follows the link. */
export function visibleAskPresetKeys(set) {
  const builtIns = DEFAULT_ASK_PRESET_KEYS.filter((key) => {
    const preset = askPreset(set, key);
    return !!preset && preset.removed !== true;
  });
  const custom = askPreset(set, "custom");
  // A legacy store may contain three visible built-ins plus a custom preset.
  // Keep that custom value stored but hidden until a built-in leaves a slot.
  return [...builtIns, ...(custom && custom.removed !== true ? ["custom"] : [])].slice(0, 3);
}

export function setAskPresetsLinked(value) {
  const next = value === true;
  const current = askPresets();
  if (current.linked === next) return next;
  askPresetsCache = { ...current, linked: next };
  writeStored(ASK_PRESETS_KEY, JSON.stringify(askPresetsCache));
  notify("ask-presets");
  return next;
}

export function setAskPreset(set, key, value) {
  const setKey = set === "selection" ? "selection" : "followup";
  const presetKey = normalizedPresetKey(key);
  if (!presetKey) return null;
  const current = askPresets();
  const existing = current[setKey][presetKey];
  if (!existing && presetKey !== "custom") return null;
  const label = String(value?.label ?? existing?.label ?? "")
    .trim()
    .slice(0, 80);
  const instruction = String(value?.instruction ?? existing?.instruction ?? "")
    .trim()
    .slice(0, 4000);
  const removed = typeof value?.removed === "boolean" ? value.removed : existing?.removed === true;
  if (!label || !instruction) return existing;
  askPresetsCache = {
    version: 1,
    linked: current.linked === true,
    selection: { ...current.selection },
    followup: { ...current.followup },
    [setKey]: { ...current[setKey], [presetKey]: { label, instruction, removed } },
  };
  writeStored(ASK_PRESETS_KEY, JSON.stringify(askPresetsCache));
  notify("ask-presets");
  return askPresetsCache[setKey][presetKey];
}

export function setAskPresetRemoved(set, key, value) {
  const setKey = set === "selection" ? "selection" : "followup";
  const presetKey = normalizedPresetKey(key);
  if (presetKey === "custom" && value === true) {
    const current = askPresets();
    if (!current[setKey].custom) return null;
    const nextSet = { ...current[setKey] };
    delete nextSet.custom;
    askPresetsCache = {
      version: 1,
      linked: current.linked === true,
      selection: { ...current.selection },
      followup: { ...current.followup },
      [setKey]: nextSet,
    };
    writeStored(ASK_PRESETS_KEY, JSON.stringify(askPresetsCache));
    notify("ask-presets");
    return null;
  }
  return setAskPreset(set, key, { removed: value === true });
}

export function createCustomAskPreset(set) {
  if (visibleAskPresetKeys(set).length >= 3) return null;
  return setAskPreset(set, "custom", {
    label: "New question",
    instruction: "Ask a focused question about this.",
    removed: false,
  });
}

export function resetAskPreset(set, key) {
  const setKey = set === "selection" ? "selection" : "followup";
  const presetKey = normalizedPresetKey(key);
  if (!presetKey || presetKey === "custom") return null;
  return setAskPreset(setKey, presetKey, { ...DEFAULT_ASK_PRESETS[setKey][presetKey], removed: false });
}

// ------------------------------------------------------- reaction prompts

function cloneReactionPromptDefaults() {
  return {
    version: 1,
    ...Object.fromEntries(
      REACTION_KEYS.map((key) => [key, { instruction: DEFAULT_REACTION_PROMPTS[key].instruction }]),
    ),
  };
}

export function normalizeReactionPrompts(value) {
  const defaults = cloneReactionPromptDefaults();
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const source = raw.prompts && typeof raw.prompts === "object" && !Array.isArray(raw.prompts) ? raw.prompts : raw;
  for (const [rawKey, rawPrompt] of Object.entries(source)) {
    const key = normalizeReactionKey(rawKey);
    if (!key) continue;
    const candidate = typeof rawPrompt === "string" ? rawPrompt : rawPrompt?.instruction;
    const instruction = String(candidate ?? "").trim();
    if (instruction) defaults[key] = { instruction: instruction.slice(0, 4000) };
  }
  return defaults;
}

export function reactionPrompts() {
  if (!reactionPromptsCache) {
    let parsed = null;
    try {
      parsed = JSON.parse(readStored(REACTION_PROMPTS_KEY));
    } catch (error) {}
    reactionPromptsCache = normalizeReactionPrompts(parsed);
  }
  return reactionPromptsCache;
}

export function reactionPrompt(key) {
  const promptKey = normalizeReactionKey(key);
  return promptKey ? reactionPrompts()[promptKey] : null;
}

export function setReactionPrompt(key, value) {
  const promptKey = normalizeReactionKey(key);
  if (!promptKey) return null;
  const existing = reactionPrompt(promptKey);
  const instruction = String(value?.instruction ?? value ?? "")
    .trim()
    .slice(0, 4000);
  if (!instruction) return existing;
  reactionPromptsCache = { ...reactionPrompts(), [promptKey]: { instruction } };
  writeStored(REACTION_PROMPTS_KEY, JSON.stringify(reactionPromptsCache));
  notify("reaction-prompts");
  return reactionPromptsCache[promptKey];
}

export function resetReactionPrompt(key) {
  const promptKey = normalizeReactionKey(key);
  return promptKey
    ? setReactionPrompt(promptKey, { instruction: DEFAULT_REACTION_PROMPTS[promptKey].instruction })
    : null;
}
