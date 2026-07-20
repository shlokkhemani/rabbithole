import { providerFor } from "../brain/provider-registry.js";

const KEYS_KEY = "rh-web-api-keys";
const memoryKeys = Object.create(null);

function readRememberedKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRememberedKeys(keys) {
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
