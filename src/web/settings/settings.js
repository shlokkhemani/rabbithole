import { defaultProviderSettings, normalizeProviderSettings, providerFor } from "../provider/provider-registry.js";
import { saveApiKey } from "./credential-store.js";

export const SETTINGS_KEY = "rh-web-settings";
const DEFAULT_FETCH_PROXY_URL =
  typeof __RABBITHOLE_DEFAULT_PROXY_URL__ === "string" ? __RABBITHOLE_DEFAULT_PROXY_URL__ : "";

/** @returns {Record<string, any>} */
function defaultWebSettings() {
  return { ...defaultProviderSettings(), fetch_proxy_url: DEFAULT_FETCH_PROXY_URL || "" };
}

let currentSettings = null;
const subscribers = new Set();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_KEY) return;
    currentSettings = null;
    const settings = loadSettings();
    for (const subscriber of subscribers) subscriber(settings);
  });
}

/** @returns {Record<string, any>} */
export function loadSettings() {
  if (currentSettings) return currentSettings;
  const defaults = defaultWebSettings();
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const preset = providerFor(parsed.preset).id;
    const providers = normalizeProviderSettings(parsed.providers, { [preset]: parsed });
    const active = providers[preset] || normalizeProviderSettings({ [preset]: parsed })[preset];
    providers[preset] = active;
    currentSettings = { ...defaults, ...parsed, agent: "", agents: {}, preset, ...active, providers };
    return currentSettings;
  } catch {
    currentSettings = defaults;
    return currentSettings;
  }
}

/** @param {Record<string, any>} settings */
export function saveSettings(settings) {
  const preset = providerFor(settings.preset).id;
  const providers = normalizeProviderSettings(settings.providers);
  providers[preset] = normalizeProviderSettings({ [preset]: settings })[preset];
  const { api_key, ...persistable } = /** @type {Record<string, any>} */ ({ ...settings, preset, providers });
  if (persistable.fetch_proxy_url === DEFAULT_FETCH_PROXY_URL) delete persistable.fetch_proxy_url;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
  saveApiKey({ ...settings, preset, api_key });
  currentSettings = { ...settings, preset, providers };
  for (const subscriber of subscribers) subscriber(currentSettings);
}

function persist(settings) {
  const preset = providerFor(settings.preset).id;
  const providers = normalizeProviderSettings(settings.providers);
  providers[preset] = normalizeProviderSettings({ [preset]: settings })[preset];
  const { api_key, ...persistable } = /** @type {Record<string, any>} */ ({ ...settings, preset, providers });
  if (persistable.fetch_proxy_url === DEFAULT_FETCH_PROXY_URL) delete persistable.fetch_proxy_url;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
}

export const getSettings = loadSettings;

/** @param {Record<string, any>} values */
export function patchSettings(values) {
  saveSettings({ ...loadSettings(), ...values });
  return currentSettings;
}

/** @param {(settings: Record<string, any>) => void} subscriber */
export function subscribeSettings(subscriber) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

/** Test/dev storage replacement hook; production settings stay memory-owned. */
export function resetSettingsCache() {
  currentSettings = null;
}
