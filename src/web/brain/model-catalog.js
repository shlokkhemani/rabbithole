/*
 * The OpenRouter model catalog behind the settings model picker. One public
 * GET (no key needed) covers every provider OpenRouter routes to, so the
 * picker can search the whole space instead of a hardcoded shortlist.
 */

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_KEY = "rh-model-catalog-v1";
const CACHE_TTL_MS = 60 * 60 * 1000;

export const RECOMMENDED_MODEL_ID = "anthropic/claude-sonnet-5";

/* Missing ids simply drop out of the suggestions, so this list can trail the catalog. */
export const SUGGESTED_MODEL_IDS = Object.freeze([
  RECOMMENDED_MODEL_ID,
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.6-luna",
  "google/gemini-3.5-flash",
  "deepseek/deepseek-v4-flash",
]);

let catalogPromise = null;

export function loadModelCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchCatalog().catch((err) => {
      catalogPromise = null;
      throw err;
    });
  }
  return catalogPromise;
}

async function fetchCatalog() {
  const cached = readCache();
  if (cached) return cached;
  const response = await fetch(OPENROUTER_MODELS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenRouter models returned HTTP ${response.status}.`);
  const json = await response.json();
  const models = (Array.isArray(json?.data) ? json.data : [])
    .filter((model) => model?.id)
    .map((model) => ({
      id: String(model.id),
      name: cleanModelName(model.name, model.id),
      context: Number(model.context_length) || 0,
      promptPrice: Number(model.pricing?.prompt) || 0,
      completionPrice: Number(model.pricing?.completion) || 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  writeCache(models);
  return models;
}

function readCache() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
    if (raw && Date.now() - raw.at < CACHE_TTL_MS && Array.isArray(raw.models) && raw.models.length) {
      return raw.models;
    }
  } catch {}
  return null;
}

function writeCache(models) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), models }));
  } catch {}
}

export function searchModels(models, query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return models;
  return models.filter((model) => {
    const hay = `${model.id} ${model.name}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

function cleanModelName(name, id) {
  const label = String(name || "").replace(/^[^:]{2,24}:\s*/, "").trim();
  return label || prettyModelId(id);
}

export function prettyModelId(id) {
  const slug = (String(id || "").split("/").pop() || String(id || "")).replace(/:free$/i, " free");
  const pretty = slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d/.test(part)) return part;
      if (part.length <= 3) return part.toUpperCase();
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
  return pretty || String(id || "");
}

export function formatModelPrice(model) {
  if (!model) return "";
  if (!Number.isFinite(model.promptPrice) && !Number.isFinite(model.completionPrice)) return "";
  if (model.promptPrice < 0 || model.completionPrice < 0) return "Varies";
  if (!model.promptPrice && !model.completionPrice) return "Free";
  return `$${perMillion(model.promptPrice)} · $${perMillion(model.completionPrice)}`;
}

function perMillion(perToken) {
  const n = perToken * 1e6;
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return String(parseFloat(n.toFixed(1)));
  return String(parseFloat(n.toFixed(2)));
}
