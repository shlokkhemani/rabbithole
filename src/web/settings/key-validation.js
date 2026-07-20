import { providerFor } from "../brain/index.js";

const OPENROUTER_KEY_CHECK_URL = "https://openrouter.ai/api/v1/key";

/** @param {{ key?: string, presetId?: string, statusEl?: HTMLElement | null, required?: boolean, onShake?: (() => void) | null }} [options] */
export async function validateKeyForPreset({ key, presetId, statusEl, required = false, onShake = null } = {}) {
  const value = String(key || "").trim();
  const preset = providerFor(presetId);
  if (!preset.requires_key) {
    setKeyStatus(statusEl, "No key required for this provider.", "valid");
    return true;
  }
  const hint = providerKeyHint(value, preset.id);
  if (!value) {
    if (required) {
      setKeyStatus(statusEl, "Enter a key first.", "invalid");
      shake(onShake);
      return false;
    }
    setKeyStatus(statusEl, "", "");
    return false;
  }
  if (hint) {
    setKeyStatus(statusEl, hint, "hint");
    if (required && /truncated|looks like/i.test(hint)) shake(onShake);
    if (preset.id !== "openrouter") return true;
    if (!isPlausibleOpenRouterKey(value)) return false;
  }
  if (preset.id !== "openrouter") {
    setKeyStatus(statusEl, "Key saved for this provider.", "valid");
    return true;
  }
  if (!isPlausibleOpenRouterKey(value)) {
    setKeyStatus(statusEl, "That OpenRouter key looks too short.", "invalid");
    if (required) shake(onShake);
    return false;
  }
  setKeyStatus(statusEl, "Validating...", "busy");
  try {
    const result = await validateOpenRouterKey(value);
    setKeyStatus(statusEl, openRouterValidMessage(result), "valid");
    return true;
  } catch (err) {
    setKeyStatus(statusEl, err?.message || "OpenRouter rejected that key.", "invalid");
    shake(onShake);
    return false;
  }
}

async function validateOpenRouterKey(key) {
  const response = await fetch(OPENROUTER_KEY_CHECK_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? "That key was rejected by OpenRouter."
      : `OpenRouter returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  let json = {};
  try { json = await response.json(); } catch {}
  return json;
}

function providerKeyHint(key, presetId) {
  const value = String(key || "").trim();
  if (!value) return "";
  if (presetId === "openrouter" && value.startsWith("sk-ant-")) return "That looks like an Anthropic key — use an OpenRouter key here.";
  if (presetId === "openrouter" && value.startsWith("sk-") && !value.startsWith("sk-or-") && !value.startsWith("sk-ant-")) {
    return "That looks like an OpenAI key — use an OpenRouter key here.";
  }
  if (presetId === "openrouter" && value.startsWith("sk-or-v1-") && value.length < 30) {
    return "That OpenRouter key looks truncated.";
  }
  return "";
}

function isPlausibleOpenRouterKey(value) {
  return /^sk-or-v1-[A-Za-z0-9_-]{24,}$/.test(String(value || "").trim());
}

function openRouterValidMessage(result) {
  const data = result?.data || result || {};
  const label = data.label || data.name || data.key_name || "";
  const limit = data.limit || data.usage_limit || data.limit_remaining || "";
  const detail = [label, limit ? `limit ${limit}` : ""].filter(Boolean).join(" · ");
  return detail ? `Connected · ${detail}` : "Connected";
}

/** @param {HTMLElement | null} el @param {string} message @param {string} [tone] */
export function setKeyStatus(el, message, tone = "") {
  if (!el) return;
  el.textContent = message || "";
  el.className = `key-status${message ? " visible" : ""}${tone ? ` ${tone}` : ""}`;
}

function shake(onShake) {
  onShake?.();
  window.setTimeout(() => document.querySelectorAll(".shake-once").forEach((el) => el.classList.remove("shake-once")), 260);
}
