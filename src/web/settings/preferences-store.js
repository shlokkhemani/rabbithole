import { defaultBrainSettings, providerFor, resolveProviderId } from "../brain/provider-registry.js";
import { ensureCanonicalCredentials, getApiKey, saveApiKey } from "./credential-store.js";

const SETTINGS_KEY = "rh-web-settings";
const DEFAULT_FETCH_PROXY_URL =
  typeof __RABBITHOLE_DEFAULT_PROXY_URL__ === "string" ? __RABBITHOLE_DEFAULT_PROXY_URL__ : "";

export function defaultWebSettings() {
  return { ...defaultBrainSettings(), fetch_proxy_url: DEFAULT_FETCH_PROXY_URL || "" };
}

export function loadSettings() {
  const defaults = defaultWebSettings();
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...defaults, ...parsed } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  const { api_key, ...persistable } = settings;
  if (persistable.fetch_proxy_url === DEFAULT_FETCH_PROXY_URL) delete persistable.fetch_proxy_url;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
  saveApiKey({ ...settings, api_key });
}

export function ensureCanonical() {
  ensureCanonicalCredentials();
  const defaults = defaultWebSettings();
  let raw = null;
  let stored = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {}

  let canonical = stored || defaults;
  if (stored && resolveProviderId(stored.preset) !== stored.preset) {
    const provider = providerFor(stored.preset);
    canonical = {
      ...stored,
      preset: provider.id,
      base_url: provider.base_url,
      answer_model: provider.answer_model,
      author_model: provider.author_model,
    };
  }
  canonical = { ...canonical };
  if (stored && !canonical.generation_setup) {
    const provider = providerFor(canonical.preset);
    const hasLegacySetup = provider.id === "custom" || !!getApiKey(canonical);
    if (hasLegacySetup && canonical.answer_model) {
      canonical.generation_setup = {
        version: 1,
        preset: provider.id,
        base_url: String(canonical.base_url || provider.base_url).replace(/\/+$/, ""),
        model: String(canonical.answer_model).trim(),
      };
    }
  }
  if (canonical.fetch_proxy_url === DEFAULT_FETCH_PROXY_URL) delete canonical.fetch_proxy_url;
  const serialized = JSON.stringify(canonical);
  if (raw !== null && raw !== serialized) {
    try { localStorage.setItem(SETTINGS_KEY, serialized); } catch {}
  }
}
