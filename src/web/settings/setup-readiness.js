import { providerFor } from "../brain/provider-registry.js";
import { getApiKey } from "./credential-store.js";
import { loadSettings, saveSettings } from "./preferences-store.js";

const SETUP_VERSION = 1;

function fingerprint(settings) {
  return {
    version: SETUP_VERSION,
    preset: providerFor(settings.preset).id,
    base_url: String(settings.base_url || "").replace(/\/+$/, ""),
    model: String(settings.model || "").trim(),
  };
}

function fingerprintsMatch(left, right) {
  return !!left && left.version === right.version && left.preset === right.preset
    && left.base_url === right.base_url && left.model === right.model;
}

export function getGenerationSetupStatus(settings = loadSettings()) {
  const preset = providerFor(settings.preset);
  const expected = fingerprint(settings);
  if (!fingerprintsMatch(settings.generation_setup, expected)) {
    return { ready: false, reason: "setup_incomplete", preset, model: expected.model };
  }
  if (!expected.model) return { ready: false, reason: "missing_model", preset, model: "" };
  if (preset.requires_key && !getApiKey(settings)) {
    return { ready: false, reason: "missing_key", preset, model: expected.model };
  }
  return { ready: true, reason: "", preset, model: expected.model };
}

export function markGenerationSetupComplete(settings = loadSettings()) {
  const next = { ...settings, generation_setup: fingerprint(settings), api_key: getApiKey(settings) };
  saveSettings(next);
  return getGenerationSetupStatus(next);
}

export function invalidateGenerationSetup(settings = loadSettings()) {
  const { generation_setup: _discarded, ...next } = settings;
  saveSettings({ ...next, api_key: getApiKey(settings) });
  return getGenerationSetupStatus(next);
}

export function setupFingerprint(settings) {
  return fingerprint(settings);
}
