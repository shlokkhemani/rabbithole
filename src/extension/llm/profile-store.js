export const LLM_PROFILES_SETTING = "nora.llm.profiles";
export const DEFAULT_OPENAI_COMPATIBLE_API = "openai-completions";
export const OPENAI_COMPATIBLE_APIS = Object.freeze(["openai-completions", "openai-responses"]);

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "authheader",
  "header",
  "headers",
  "cookie",
  "bearer",
]);
const SECRET_QUERY_RE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential|authorization|auth|key)$/i;
const PROFILE_KEYS = new Set(["id", "label", "provider", "model", "baseUrl", "api", "piApiType", "customModel"]);
const CUSTOM_MODEL_KEYS = new Set(["name", "contextWindow", "maxTokens", "reasoning", "input", "cost", "thinkingLevelMap", "compat"]);
const COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const MODEL_INPUTS = new Set(["text", "image"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * @typedef {"openai-completions" | "openai-responses"} NoraPiApiType
 * @typedef {{
 *   name?: string,
 *   contextWindow?: number,
 *   maxTokens?: number,
 *   reasoning?: boolean,
 *   input?: ("text" | "image")[],
 *   cost?: { input: number, output: number, cacheRead: number, cacheWrite: number },
 *   thinkingLevelMap?: Record<string, string | null>,
 *   compat?: Record<string, unknown>
 * }} NoraCustomModelMetadata
 * @typedef {{
 *   id: string,
 *   label: string,
 *   provider: string,
 *   model: string,
 *   baseUrl: string | null,
 *   api: NoraPiApiType | null,
 *   customModel: NoraCustomModelMetadata | null
 * }} NoraLlmProfile
 */

/** @param {typeof import("vscode")} vscode */
export function readConfiguredLlmProfiles(vscode) {
  const raw = readConfigurationValue(vscode, LLM_PROFILES_SETTING);
  return validateLlmProfiles(raw ?? []);
}

/** @param {unknown} raw @returns {NoraLlmProfile[]} */
export function validateLlmProfiles(raw) {
  if (!Array.isArray(raw)) throw new TypeError(`${LLM_PROFILES_SETTING} must be an array`);
  /** @type {NoraLlmProfile[]} */
  const profiles = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    const profile = normalizeProfile(entry, `profiles[${index}]`);
    if (seen.has(profile.id)) throw new TypeError(`Duplicate Nora LLM profile id: ${profile.id}`);
    seen.add(profile.id);
    profiles.push(profile);
  });
  return profiles;
}

/** @param {NoraLlmProfile[]} profiles @param {string | null | undefined} id */
export function getProfileById(profiles, id) {
  if (!id) return null;
  return profiles.find((profile) => profile.id === id) ?? null;
}

/** @param {NoraLlmProfile} profile */
export function profileRuntimeProviderId(profile) {
  return profile.provider;
}

/** @param {NoraLlmProfile} profile */
export function isCustomOpenAiProfile(profile) {
  return !!profile.baseUrl;
}

/** @param {NoraLlmProfile} profile */
export function profileEndpoint(profile) {
  return profile.baseUrl;
}

/** @param {NoraLlmProfile} profile */
export function profilePublicSummary(profile) {
  return {
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    endpoint: profileEndpoint(profile),
    api: profile.api,
  };
}

/** @param {unknown} value @param {string} path */
export function assertNoSecretFields(value, path = "value") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (isSecretFieldName(key)) throw new TypeError(`${path}.${key} is not allowed in Nora LLM profile configuration`);
    assertNoSecretFields(entry, `${path}.${key}`);
  }
}

/** @param {unknown} raw @param {string} path @returns {NoraLlmProfile} */
function normalizeProfile(raw, path) {
  const input = requirePlainRecord(raw, path);
  assertNoSecretFields(input, path);
  requireOnlyKeys(input, PROFILE_KEYS, path);
  const id = normalizeProfileId(input.id, `${path}.id`);
  const label = optionalNonEmptyString(input.label, `${path}.label`) ?? id;
  const provider = requireNonEmptyString(input.provider, `${path}.provider`);
  const model = requireNonEmptyString(input.model, `${path}.model`);
  const baseUrl = normalizeBaseUrl(input.baseUrl, `${path}.baseUrl`);
  const api = normalizeApi(input.api ?? input.piApiType, `${path}.api`, !!baseUrl);
  const customModel = normalizeCustomModel(input.customModel, `${path}.customModel`);
  if (customModel && !baseUrl) throw new TypeError(`${path}.customModel requires baseUrl`);
  return { id, label, provider, model, baseUrl, api, customModel };
}

/** @param {unknown} raw @param {string} path @returns {NoraCustomModelMetadata | null} */
function normalizeCustomModel(raw, path) {
  if (raw == null) return null;
  const input = requirePlainRecord(raw, path);
  assertNoSecretFields(input, path);
  requireOnlyKeys(input, CUSTOM_MODEL_KEYS, path);
  /** @type {NoraCustomModelMetadata} */
  const metadata = {};
  const name = optionalNonEmptyString(input.name, `${path}.name`);
  if (name) metadata.name = name;
  if (input.contextWindow != null) metadata.contextWindow = requirePositiveSafeInteger(input.contextWindow, `${path}.contextWindow`);
  if (input.maxTokens != null) metadata.maxTokens = requirePositiveSafeInteger(input.maxTokens, `${path}.maxTokens`);
  if (input.reasoning != null) {
    if (typeof input.reasoning !== "boolean") throw new TypeError(`${path}.reasoning must be a boolean`);
    metadata.reasoning = input.reasoning;
  }
  if (input.input != null) metadata.input = normalizeInputs(input.input, `${path}.input`);
  if (input.cost != null) metadata.cost = normalizeCost(input.cost, `${path}.cost`);
  if (input.thinkingLevelMap != null) metadata.thinkingLevelMap = normalizeThinkingLevelMap(input.thinkingLevelMap, `${path}.thinkingLevelMap`);
  if (input.compat != null) metadata.compat = normalizeJsonObject(input.compat, `${path}.compat`);
  return metadata;
}

/** @param {unknown} raw @param {string} path @param {boolean} hasBaseUrl @returns {NoraPiApiType | null} */
function normalizeApi(raw, path, hasBaseUrl) {
  if (raw == null || raw === "") return hasBaseUrl ? DEFAULT_OPENAI_COMPATIBLE_API : null;
  const value = requireNonEmptyString(raw, path);
  if (!OPENAI_COMPATIBLE_APIS.includes(/** @type {NoraPiApiType} */ (value))) {
    throw new TypeError(`${path} must be one of: ${OPENAI_COMPATIBLE_APIS.join(", ")}`);
  }
  return /** @type {NoraPiApiType} */ (value);
}

/** @param {unknown} raw @param {string} path */
function normalizeBaseUrl(raw, path) {
  if (raw == null || raw === "") return null;
  const value = requireNonEmptyString(raw, path);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${path} must be a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`${path} must use http or https`);
  if (url.username || url.password) throw new TypeError(`${path} must not contain URL userinfo`);
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(key)) throw new TypeError(`${path} must not contain credential-bearing query parameter ${key}`);
  }
  return url.toString();
}

/** @param {unknown} raw @param {string} path @returns {("text" | "image")[]} */
function normalizeInputs(raw, path) {
  if (!Array.isArray(raw) || raw.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  return raw.map((entry, index) => {
    const value = requireNonEmptyString(entry, `${path}[${index}]`);
    if (!MODEL_INPUTS.has(value)) throw new TypeError(`${path}[${index}] must be text or image`);
    return /** @type {"text" | "image"} */ (value);
  });
}

/** @param {unknown} raw @param {string} path */
function normalizeCost(raw, path) {
  const input = requirePlainRecord(raw, path);
  requireOnlyKeys(input, COST_KEYS, path);
  return {
    input: requireFiniteNumber(input.input, `${path}.input`),
    output: requireFiniteNumber(input.output, `${path}.output`),
    cacheRead: requireFiniteNumber(input.cacheRead, `${path}.cacheRead`),
    cacheWrite: requireFiniteNumber(input.cacheWrite, `${path}.cacheWrite`),
  };
}

/** @param {unknown} raw @param {string} path */
function normalizeThinkingLevelMap(raw, path) {
  const input = requirePlainRecord(raw, path);
  /** @type {Record<string, string | null>} */
  const output = {};
  for (const [level, value] of Object.entries(input)) {
    if (!THINKING_LEVELS.has(level)) throw new TypeError(`${path}.${level} is not a supported thinking level`);
    if (value !== null && typeof value !== "string") throw new TypeError(`${path}.${level} must be a string or null`);
    output[level] = value;
  }
  return output;
}

/** @param {unknown} raw @param {string} path */
function normalizeJsonObject(raw, path) {
  const input = requirePlainRecord(raw, path);
  assertJsonValue(input, path);
  return cloneJson(input);
}

/** @param {unknown} value @param {string} path */
function normalizeProfileId(value, path) {
  const id = requireNonEmptyString(value, path);
  if (!PROFILE_ID_RE.test(id)) throw new TypeError(`${path} must be stable ASCII id text`);
  return id;
}

/** @param {unknown} value @param {string} path */
function requireNonEmptyString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${path} must be a non-empty string`);
  return value.trim();
}

/** @param {unknown} value @param {string} path */
function optionalNonEmptyString(value, path) {
  if (value == null || value === "") return undefined;
  return requireNonEmptyString(value, path);
}

/** @param {unknown} value @param {string} path */
function requirePositiveSafeInteger(value, path) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${path} must be a positive safe integer`);
  return Number(value);
}

/** @param {unknown} value @param {string} path */
function requireFiniteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${path} must be a non-negative finite number`);
  return value;
}

/** @param {unknown} value @param {string} path @returns {Record<string, unknown>} */
function requirePlainRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path} must be a plain object`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value @param {Set<string>} allowed @param {string} path */
function requireOnlyKeys(value, allowed, path) {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new TypeError(`${path} has unsupported keys: ${unsupported.join(", ")}`);
}

/** @param {unknown} value @param {string} path @param {Set<unknown>} [seen] */
function assertJsonValue(value, path, seen = new Set()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite JSON data`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must be JSON data`);
  if (seen.has(value)) throw new TypeError(`${path} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  requirePlainRecord(value, path);
  for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`, seen);
  seen.delete(value);
}

/** @param {unknown} value */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {string} key */
function isSecretFieldName(key) {
  return SECRET_FIELD_NAMES.has(key.replace(/[-_\s]/g, "").toLowerCase());
}

/** @param {typeof import("vscode")} vscode @param {string} key */
function readConfigurationValue(vscode, key) {
  const workspace = vscode.workspace;
  const full = workspace.getConfiguration().get(key);
  if (full !== undefined) return full;
  const prefix = "nora.";
  if (key.startsWith(prefix)) {
    return workspace.getConfiguration("nora").get(key.slice(prefix.length));
  }
  return undefined;
}
