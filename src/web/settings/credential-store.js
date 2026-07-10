import { providerFor } from "../brain/provider-registry.js";

const LEGACY_KEY = "rh-web-api-key";
const KEYS_KEY = "rh-web-api-keys";
const memoryKeys = Object.create(null);

export function readRememberedKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeRememberedKeys(keys) {
  try {
    if (Object.keys(keys).length) localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
    else localStorage.removeItem(KEYS_KEY);
    return true;
  } catch {
    return false;
  }
}

export function saveApiKey(settings) {
  const providerId = providerFor(settings.preset).id;
  const apiKey = settings.api_key || "";
  const keys = readRememberedKeys();
  if (settings.session_only === false) {
    if (apiKey) keys[providerId] = apiKey;
    else delete keys[providerId];
    writeRememberedKeys(keys);
    delete memoryKeys[providerId];
  } else {
    delete keys[providerId];
    writeRememberedKeys(keys);
    memoryKeys[providerId] = apiKey;
  }
}

export function getApiKey(settings) {
  const providerId = providerFor(settings.preset).id;
  if (settings.session_only === false) return readRememberedKeys()[providerId] || "";
  return memoryKeys[providerId] || "";
}

export function ensureCanonicalCredentials() {
  let legacyRaw = null;
  let keysRaw = null;
  try {
    legacyRaw = localStorage.getItem(LEGACY_KEY);
    keysRaw = localStorage.getItem(KEYS_KEY);
  } catch { return; }

  const keys = readRememberedKeys();
  const canonicalKeys = Object.keys(keys).length ? JSON.stringify(keys) : null;
  if (keysRaw !== canonicalKeys && !writeRememberedKeys(keys)) return;
  if (!Object.prototype.hasOwnProperty.call(keys, "openrouter") && legacyRaw) {
    const adopted = { ...keys, openrouter: legacyRaw };
    if (!writeRememberedKeys(adopted)) return;
    const landed = readRememberedKeys();
    if (landed.openrouter !== legacyRaw) return;
  }
  if (legacyRaw !== null) {
    try { localStorage.removeItem(LEGACY_KEY); } catch {}
  }
}
