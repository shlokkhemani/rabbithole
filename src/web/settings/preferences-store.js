import { defaultBrainSettings, normalizeProviderSettings, providerFor } from "../brain/provider-registry.js";
import { saveApiKey } from "./credential-store.js";

const SETTINGS_KEY = "rh-web-settings";
const DEFAULT_FETCH_PROXY_URL =
  typeof __RABBITHOLE_DEFAULT_PROXY_URL__ === "string" ? __RABBITHOLE_DEFAULT_PROXY_URL__ : "";

function defaultWebSettings() {
  return { ...defaultBrainSettings(), fetch_proxy_url: DEFAULT_FETCH_PROXY_URL || "" };
}

export function loadSettings() {
  const defaults = defaultWebSettings();
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const preset = providerFor(parsed.preset).id;
    const providers = normalizeProviderSettings(parsed.providers);
    const provider = providerFor(preset);
    const active = providers[preset] || {
      base_url: typeof parsed.base_url === "string" ? parsed.base_url : provider.base_url,
      model: typeof parsed.model === "string" ? parsed.model : provider.model,
      transcribe_model: typeof parsed.transcribe_model === "string" ? parsed.transcribe_model : provider.transcribe_model,
    };
    providers[preset] = active;
    return { ...defaults, ...parsed, preset, ...active, providers };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  const preset = providerFor(settings.preset).id;
  const providers = normalizeProviderSettings(settings.providers);
  providers[preset] = {
    base_url: String(settings.base_url || ""),
    model: String(settings.model || ""),
    transcribe_model: String(settings.transcribe_model || ""),
  };
  const { api_key, ...persistable } = { ...settings, preset, providers };
  if (persistable.fetch_proxy_url === DEFAULT_FETCH_PROXY_URL) delete persistable.fetch_proxy_url;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
  saveApiKey({ ...settings, preset, api_key });
}
