import {
  DEFAULT_OPENAI_COMPATIBLE_API,
  getProfileById,
  isCustomOpenAiProfile,
  profileEndpoint,
  profileRuntimeProviderId,
  readConfiguredLlmProfiles,
} from "./profile-store.js";
import {
  ProfileCredentialStore,
  readProfileCredential,
} from "./secret-credential-store.js";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * @typedef {import("./profile-store.js").NoraLlmProfile} NoraLlmProfile
 * @typedef {import("./secret-credential-store.js").SecretStorageLike} SecretStorageLike
 */

export class NoraModelRuntimeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "NoraModelRuntimeError";
    this.code = code;
  }
}

export class InMemoryModelsStore {
  constructor() {
    /** @type {Map<string, unknown>} */
    this.entries = new Map();
  }

  /** @param {string} providerId */
  async read(providerId) {
    const entry = this.entries.get(providerId);
    return entry ? cloneJson(entry) : undefined;
  }

  /** @param {string} providerId @param {unknown} entry */
  async write(providerId, entry) {
    this.entries.set(providerId, cloneJson(entry));
  }

  /** @param {string} providerId */
  async delete(providerId) {
    this.entries.delete(providerId);
  }
}

/**
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {typeof import("vscode")} vscode
 * @param {SecretStorageLike} secretStorage
 * @param {Record<string, any>} [options]
 */
export async function createModelRuntimeForSelectedDocument(document, vscode, secretStorage, options = {}) {
  const profiles = options.profiles ?? readConfiguredLlmProfiles(vscode);
  const selectedProfileId = document.state.selectedProfileId;
  if (!selectedProfileId) {
    throw new NoraModelRuntimeError("NORA_PROFILE_MISSING_SELECTION", "Select an LLM profile before running Nora.");
  }
  const profile = getProfileById(profiles, selectedProfileId);
  if (!profile) {
    throw new NoraModelRuntimeError("NORA_PROFILE_NOT_FOUND", `Selected LLM profile is no longer configured: ${selectedProfileId}`);
  }
  return createModelRuntimeForProfile(profile, secretStorage, options);
}

/**
 * @param {NoraLlmProfile} profile
 * @param {SecretStorageLike} secretStorage
 * @param {{
 *   ModelRuntime?: { create(options?: Record<string, unknown>): Promise<any> },
 *   modelsStore?: unknown,
 *   credentialStore?: ProfileCredentialStore,
 * }} [options]
 */
export async function createModelRuntimeForProfile(profile, secretStorage, options = {}) {
  const credential = await readProfileCredential(secretStorage, profile.id);
  if (!credential) {
    throw new NoraModelRuntimeError("NORA_PROFILE_CREDENTIAL_MISSING", `LLM profile ${profile.label} has no stored credential.`);
  }
  return createUncheckedModelRuntimeForProfile(profile, secretStorage, options);
}

/**
 * Builds a Pi runtime for commands that create credentials, such as OAuth login.
 * Run-start code must use createModelRuntimeForProfile so missing credentials
 * are refused before the runtime is constructed.
 * @param {NoraLlmProfile} profile
 * @param {SecretStorageLike} secretStorage
 * @param {{
 *   ModelRuntime?: { create(options?: Record<string, unknown>): Promise<any> },
 *   modelsStore?: unknown,
 *   credentialStore?: ProfileCredentialStore,
 * }} [options]
 */
export async function createUncheckedModelRuntimeForProfile(profile, secretStorage, options = {}) {
  const runtimeProviderId = profileRuntimeProviderId(profile);
  const credentialStore = options.credentialStore ?? new ProfileCredentialStore(secretStorage, profile.id, runtimeProviderId);
  const ModelRuntime = options.ModelRuntime ?? await loadModelRuntimeConstructor();
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: null,
    modelsStore: options.modelsStore ?? new InMemoryModelsStore(),
    allowModelNetwork: false,
    modelRefreshTimeoutMs: 0,
  });

  if (isCustomOpenAiProfile(profile)) {
    modelRuntime.registerProvider(runtimeProviderId, customOpenAiProviderConfig(profile));
  }

  const model = modelRuntime.getModel(runtimeProviderId, profile.model);
  if (!model) {
    throw new NoraModelRuntimeError(
      "NORA_PROFILE_MODEL_NOT_FOUND",
      `LLM profile ${profile.label} cannot resolve exact model ${runtimeProviderId}/${profile.model}.`,
    );
  }

  return {
    profile,
    runtimeProviderId,
    credentialStore,
    modelRuntime,
    model,
    provenance: runProvenanceForProfile(profile, model),
  };
}

/** @param {NoraLlmProfile} profile */
export function customOpenAiProviderConfig(profile) {
  const custom = profile.customModel ?? {};
  const api = profile.api ?? DEFAULT_OPENAI_COMPATIBLE_API;
  return {
    name: profile.label,
    baseUrl: profile.baseUrl ?? undefined,
    api,
    authHeader: true,
    models: [{
      id: profile.model,
      name: custom.name ?? profile.model,
      api,
      baseUrl: profile.baseUrl ?? undefined,
      reasoning: custom.reasoning ?? false,
      input: custom.input ?? ["text"],
      cost: custom.cost ?? ZERO_COST,
      contextWindow: custom.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: custom.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinkingLevelMap: custom.thinkingLevelMap,
      compat: custom.compat,
    }],
  };
}

/**
 * @param {NoraLlmProfile} profile
 * @param {{ provider?: string, id?: string, baseUrl?: string }} model
 */
export function runProvenanceForProfile(profile, model) {
  return {
    profileId: profile.id,
    provider: String(model.provider ?? profile.provider),
    model: String(model.id ?? profile.model),
    endpoint: profileEndpoint(profile) ?? (typeof model.baseUrl === "string" ? model.baseUrl : null),
  };
}

async function loadModelRuntimeConstructor() {
  const dynamicImport = Function("specifier", "return import(specifier)");
  const pi = await dynamicImport("@earendil-works/pi-coding-agent");
  return pi.ModelRuntime;
}

/** @param {unknown} value */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
