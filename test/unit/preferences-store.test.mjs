import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const { loadSettings, saveSettings } = await import("../../src/web/settings/preferences-store.js");
const { settingsForProvider } = await import("../../src/web/brain/provider-registry.js");

const SETTINGS_KEY = "rh-web-settings";
const read = () => JSON.parse(store.get(SETTINGS_KEY) || "{}");

/* Settings written before the rename must keep working, pointed at Local. */
store.set(SETTINGS_KEY, JSON.stringify({
  preset: "custom",
  base_url: "http://localhost:11434/v1",
  model: "llama3.2",
  transcribe_model: "llama3.2-vision",
  session_only: true,
}));
let settings = loadSettings();
assert.equal(settings.preset, "local", "the legacy Local id is migrated on read");
assert.equal(settings.base_url, "http://localhost:11434/v1");
assert.equal(settings.model, "llama3.2");
assert.equal(settings.transcribe_model, "llama3.2-vision");
assert.equal(settings.session_only, true, "unrelated preferences survive the migration");

/* A configured custom endpoint round-trips through storage, key excluded. */
store.clear();
saveSettings({
  ...settingsForProvider("custom_endpoint", loadSettings()),
  base_url: "https://api.example.com/v1",
  model: "my-model",
  transcribe_model: "my-model",
  api_key: "secret",
  session_only: true,
});
assert.equal(read().api_key, undefined, "the key never lands in the settings blob");
settings = loadSettings();
assert.equal(settings.preset, "custom_endpoint");
assert.equal(settings.base_url, "https://api.example.com/v1");
assert.equal(settings.model, "my-model");

/* Switching to OpenRouter and back must not wipe the typed endpoint. */
saveSettings(settingsForProvider("openrouter", loadSettings()));
settings = loadSettings();
assert.equal(settings.base_url, "https://openrouter.ai/api/v1");
saveSettings(settingsForProvider("custom_endpoint", loadSettings()));
settings = loadSettings();
assert.equal(settings.base_url, "https://api.example.com/v1", "the endpoint survives a trip through OpenRouter");
assert.equal(settings.model, "my-model");

saveSettings(settingsForProvider("local", loadSettings()));
settings = loadSettings();
assert.equal(settings.base_url, "http://localhost:11434/v1", "Local restores its own endpoint");
saveSettings(settingsForProvider("custom_endpoint", loadSettings()));
assert.equal(loadSettings().base_url, "https://api.example.com/v1", "Local must not overwrite the custom slot");

/* Corrupt storage falls back to defaults instead of throwing. */
store.set(SETTINGS_KEY, "not json");
assert.equal(loadSettings().preset, "openrouter");
store.set(SETTINGS_KEY, JSON.stringify(["nope"]));
assert.equal(loadSettings().preset, "openrouter");
store.set(SETTINGS_KEY, JSON.stringify({ preset: "custom_endpoint", providers: "nope" }));
assert.equal(loadSettings().preset, "custom_endpoint");
assert.equal(loadSettings().base_url, "", "a junk provider map degrades to preset defaults");

process.stdout.write("preferences-store ok\n");
