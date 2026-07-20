import { defaultBrainSettings } from "../brain/provider-registry.js";
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
