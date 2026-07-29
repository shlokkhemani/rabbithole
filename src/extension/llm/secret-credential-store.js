import { profileRuntimeProviderId } from "./profile-store.js";

const SECRET_PREFIX = "nora.llm.credential.";

/**
 * @typedef {import("./profile-store.js").NoraLlmProfile} NoraLlmProfile
 * @typedef {{ type: "api_key", key?: string, env?: Record<string, string> } | ({ type: "oauth", access: string, refresh: string, expires: number } & Record<string, unknown>)} Credential
 * @typedef {{ get(key: string): Thenable<string | undefined> | Promise<string | undefined>, store(key: string, value: string): Thenable<void> | Promise<void>, delete(key: string): Thenable<void> | Promise<void> }} SecretStorageLike
 */

/** @param {string} profileId */
export function secretKeyForProfile(profileId) {
  return `${SECRET_PREFIX}${profileId}`;
}

export class NoraSecretCredentialStore {
  /** @param {SecretStorageLike} secretStorage */
  constructor(secretStorage) {
    this.secretStorage = secretStorage;
  }

  /** @param {NoraLlmProfile} profile */
  forProfile(profile) {
    return new ProfileCredentialStore(this.secretStorage, profile.id, profileRuntimeProviderId(profile));
  }
}

export class ProfileCredentialStore {
  /**
   * @param {SecretStorageLike} secretStorage
   * @param {string} profileId
   * @param {string} runtimeProviderId
   */
  constructor(secretStorage, profileId, runtimeProviderId) {
    this.secretStorage = secretStorage;
    this.profileId = profileId;
    this.runtimeProviderId = runtimeProviderId;
    this.secretKey = secretKeyForProfile(profileId);
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
  }

  /** @param {string} providerId @returns {Promise<Credential | undefined>} */
  async read(providerId) {
    this.#assertProvider(providerId);
    const serialized = await this.secretStorage.get(this.secretKey);
    if (serialized == null || serialized === "") return undefined;
    return parseCredential(serialized, this.secretKey);
  }

  async list() {
    const credential = await this.read(this.runtimeProviderId);
    return credential ? [{ providerId: this.runtimeProviderId, type: credential.type }] : [];
  }

  /**
   * @param {string} providerId
   * @param {(current: Credential | undefined) => Promise<Credential | undefined>} fn
   * @returns {Promise<Credential | undefined>}
   */
  modify(providerId, fn) {
    this.#assertProvider(providerId);
    const run = async () => {
      const current = await this.read(providerId);
      const next = await fn(cloneCredential(current));
      if (next === undefined) return current;
      const normalized = normalizeCredential(next, `${this.secretKey}.credential`);
      await this.secretStorage.store(this.secretKey, JSON.stringify(normalized));
      return cloneCredential(normalized);
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** @param {string} providerId */
  async delete(providerId) {
    this.#assertProvider(providerId);
    const run = async () => {
      await this.secretStorage.delete(this.secretKey);
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    await result;
  }

  /** @param {string} providerId */
  #assertProvider(providerId) {
    if (providerId !== this.runtimeProviderId) {
      throw new Error(`Credential store for profile ${this.profileId} cannot access provider ${providerId}`);
    }
  }
}

/**
 * @param {SecretStorageLike} secretStorage
 * @param {string} profileId
 */
export async function readProfileCredential(secretStorage, profileId) {
  const serialized = await secretStorage.get(secretKeyForProfile(profileId));
  return serialized ? parseCredential(serialized, secretKeyForProfile(profileId)) : undefined;
}

/**
 * @param {SecretStorageLike} secretStorage
 * @param {string} profileId
 */
export async function hasProfileCredential(secretStorage, profileId) {
  return !!await readProfileCredential(secretStorage, profileId);
}

/**
 * @param {SecretStorageLike} secretStorage
 * @param {string} profileId
 * @param {Credential} credential
 */
export async function storeProfileCredential(secretStorage, profileId, credential) {
  await secretStorage.store(secretKeyForProfile(profileId), JSON.stringify(normalizeCredential(credential, "credential")));
}

/** @param {string} serialized @param {string} path @returns {Credential} */
function parseCredential(serialized, path) {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`${path} must contain Credential JSON`);
  }
  return normalizeCredential(parsed, path);
}

/** @param {unknown} value @param {string} path @returns {Credential} */
function normalizeCredential(value, path) {
  const input = requirePlainRecord(value, path);
  const type = input.type;
  if (type === "api_key") {
    return normalizeApiKeyCredential(input, path);
  }
  if (type === "oauth") {
    return normalizeOAuthCredential(input, path);
  }
  throw new TypeError(`${path}.type must be api_key or oauth`);
}

/** @param {Record<string, unknown>} input @param {string} path @returns {Credential} */
function normalizeApiKeyCredential(input, path) {
  requireOnlyKeys(input, new Set(["type", "key", "env"]), path);
  /** @type {{ type: "api_key", key?: string, env?: Record<string, string> }} */
  const credential = { type: "api_key" };
  if (input.key != null) {
    if (typeof input.key !== "string" || input.key === "") throw new TypeError(`${path}.key must be a non-empty string`);
    credential.key = input.key;
  }
  if (input.env != null) credential.env = normalizeStringRecord(input.env, `${path}.env`);
  return credential;
}

/** @param {Record<string, unknown>} input @param {string} path @returns {Credential} */
function normalizeOAuthCredential(input, path) {
  assertJsonValue(input, path);
  const access = requireString(input.access, `${path}.access`);
  const refresh = requireString(input.refresh, `${path}.refresh`);
  const expires = input.expires;
  if (!Number.isFinite(expires)) throw new TypeError(`${path}.expires must be finite`);
  return /** @type {Credential} */ ({ ...cloneJson(input), type: "oauth", access, refresh, expires: Number(expires) });
}

/** @param {unknown} value @param {string} path @returns {Record<string, string>} */
function normalizeStringRecord(value, path) {
  const input = requirePlainRecord(value, path);
  /** @type {Record<string, string>} */
  const output = {};
  for (const [key, entry] of Object.entries(input)) {
    if (typeof entry !== "string") throw new TypeError(`${path}.${key} must be a string`);
    output[key] = entry;
  }
  return output;
}

/** @param {unknown} value @param {string} path */
function requireString(value, path) {
  if (typeof value !== "string" || !value) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

/** @param {Record<string, unknown>} value @param {Set<string>} allowed @param {string} path */
function requireOnlyKeys(value, allowed, path) {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new TypeError(`${path} has unsupported keys: ${unsupported.join(", ")}`);
}

/** @param {unknown} value @param {string} path @returns {Record<string, unknown>} */
function requirePlainRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path} must be a plain object`);
  return /** @type {Record<string, unknown>} */ (value);
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

/** @param {Credential | undefined} credential */
function cloneCredential(credential) {
  return credential ? JSON.parse(JSON.stringify(credential)) : undefined;
}

/** @param {unknown} value */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
