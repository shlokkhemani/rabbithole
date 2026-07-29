import assert from "node:assert/strict";
import { createModelRuntimeForProfile, customOpenAiProviderConfig } from "../../src/extension/llm/model-runtime.js";
import { validateLlmProfiles } from "../../src/extension/llm/profile-store.js";
import { ProfileCredentialStore, storeProfileCredential } from "../../src/extension/llm/secret-credential-store.js";

class MemorySecrets {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key);
  }

  async store(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}

class FakeModelRuntime {
  static creates = [];

  static async create(options) {
    FakeModelRuntime.creates.push(options);
    return new FakeModelRuntime();
  }

  constructor() {
    this.registered = new Map();
  }

  registerProvider(providerId, config) {
    this.registered.set(providerId, config);
  }

  getModel(providerId, modelId) {
    const registered = this.registered.get(providerId);
    if (registered) {
      const model = registered.models.find((entry) => entry.id === modelId);
      return model ? { provider: providerId, id: model.id, baseUrl: registered.baseUrl } : undefined;
    }
    if (providerId === "anthropic" && modelId === "claude-sonnet-4-5") {
      return { provider: "anthropic", id: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com/" };
    }
    return undefined;
  }
}

const [litellm, anthropicA, anthropicB] = validateLlmProfiles([
  {
    id: "corp-litellm",
    label: "Corporate LiteLLM",
    provider: "litellm",
    model: "claude-router",
    baseUrl: "https://llm.example.test/v1",
    customModel: {
      name: "Claude Router",
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      thinkingLevelMap: { off: null, high: "high" },
      compat: { parallel_tool_calls: false },
    },
  },
  { id: "anthropic-a", label: "Anthropic A", provider: "anthropic", model: "claude-sonnet-4-5" },
  { id: "anthropic-b", label: "Anthropic B", provider: "anthropic", model: "claude-sonnet-4-5" },
]);

assert.equal(litellm.api, "openai-completions", "LiteLLM defaults to the OpenAI completions API");
assert.equal(litellm.baseUrl, "https://llm.example.test/v1");
assert.equal(anthropicA.api, null);

const customConfig = customOpenAiProviderConfig(litellm);
assert.equal(customConfig.baseUrl, "https://llm.example.test/v1");
assert.equal(customConfig.api, "openai-completions");
assert.equal(customConfig.models[0].id, "claude-router");
assert.equal(customConfig.models[0].contextWindow, 200000);
assert.equal(customConfig.models[0].input.includes("image"), true);

for (const invalid of [
  [{ id: "dup", provider: "a", model: "m" }, { id: "dup", provider: "b", model: "m" }],
  [{ id: "bad", provider: "openai", model: "m", apiKey: "sk-nope" }],
  [{ id: "bad", provider: "openai", model: "m", baseUrl: "https://user:pass@example.test/v1" }],
  [{ id: "bad", provider: "openai", model: "m", baseUrl: "https://example.test/v1?api_key=sk-nope" }],
  [{ id: "bad", provider: "openai", model: "m", baseUrl: "https://example.test/v1", customModel: { headers: { Authorization: "Bearer nope" } } }],
]) {
  assert.throws(() => validateLlmProfiles(invalid), /Duplicate|not allowed|userinfo|credential-bearing|unsupported/);
}

const secrets = new MemorySecrets();
await assert.rejects(
  createModelRuntimeForProfile(anthropicA, secrets, { ModelRuntime: FakeModelRuntime }),
  /no stored credential/,
  "run-start preflight refuses a missing SecretStorage credential before constructing Pi",
);
assert.equal(FakeModelRuntime.creates.length, 0);

await storeProfileCredential(secrets, anthropicA.id, { type: "api_key", key: "sk-profile-a" });
await storeProfileCredential(secrets, anthropicB.id, { type: "api_key", key: "sk-profile-b" });

const runtime = await createModelRuntimeForProfile(litellm, secretsWithCredential(litellm.id, "sk-litellm"), {
  ModelRuntime: FakeModelRuntime,
});
assert.equal(FakeModelRuntime.creates.at(-1).modelsPath, null);
assert.equal(FakeModelRuntime.creates.at(-1).allowModelNetwork, false);
assert.equal(typeof FakeModelRuntime.creates.at(-1).modelsStore.read, "function");
assert.equal(runtime.modelRuntime.registered.get("litellm").baseUrl, "https://llm.example.test/v1");
assert.deepEqual(runtime.provenance, {
  profileId: "corp-litellm",
  provider: "litellm",
  model: "claude-router",
  endpoint: "https://llm.example.test/v1",
});

const storeA = new ProfileCredentialStore(secrets, "anthropic-a", "anthropic");
const storeB = new ProfileCredentialStore(secrets, "anthropic-b", "anthropic");
assert.equal((await storeA.read("anthropic")).key, "sk-profile-a");
assert.equal((await storeB.read("anthropic")).key, "sk-profile-b");
await assert.rejects(() => storeA.read("openai"), /cannot access provider/);

let order = "";
await Promise.all([
  storeA.modify("anthropic", async (current) => {
    order += "a";
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { type: "api_key", key: `${current.key}-1` };
  }),
  storeA.modify("anthropic", async (current) => {
    order += "b";
    return { type: "api_key", key: `${current.key}-2` };
  }),
]);
assert.equal(order, "ab");
assert.equal((await storeA.read("anthropic")).key, "sk-profile-a-1-2");

console.log("ok llm profiles: validation, runtime mapping, and SecretStorage isolation hold");

function secretsWithCredential(profileId, key) {
  const secrets = new MemorySecrets();
  secrets.values.set(`nora.llm.credential.${profileId}`, JSON.stringify({ type: "api_key", key }));
  return secrets;
}
