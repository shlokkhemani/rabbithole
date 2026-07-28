import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createModelRuntimeForProfile } from "../../src/extension/llm/model-runtime.js";
import { validateLlmProfiles } from "../../src/extension/llm/profile-store.js";
import { storeProfileCredential } from "../../src/extension/llm/secret-credential-store.js";
import { NoraDocument } from "../../src/extension/nora-document.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

const SECRET = `sk-nora-${"secret-boundary-".repeat(8)}`;

test("Nora-managed LLM credentials stay out of documents, webview messages, provenance, and errors", async () => {
  await withTempDir(async (dir) => {
    const profile = validateLlmProfiles([{
      id: "corp-openai",
      label: "Corporate OpenAI",
      provider: "corp-openai",
      model: "research-large",
      baseUrl: "https://llm.example.test/v1",
      api: "openai-responses",
    }])[0];
    const secrets = new MemorySecrets();
    await storeProfileCredential(secrets, profile.id, { type: "api_key", key: SECRET });

    const filePath = path.join(dir, "secret-boundary.nora");
    const document = await NoraDocument.open(fileUri(filePath), {
      tempRoot: dir,
      title: "Secret Boundary",
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "secret-boundary-doc",
    });
    await document.selectProfile(profile.id);

    const hydration = document.toHydration();
    assert.equal(JSON.stringify(hydration).includes(SECRET), false);
    assert.equal(hydration.nora.selectedProfileId, profile.id);

    const runtime = await createModelRuntimeForProfile(profile, secrets, { ModelRuntime: FakeModelRuntime });
    assert.equal(JSON.stringify(runtime.provenance).includes(SECRET), false);
    assert.deepEqual(runtime.provenance, {
      profileId: "corp-openai",
      provider: "corp-openai",
      model: "research-large",
      endpoint: "https://llm.example.test/v1",
    });

    await document.saveToPath(filePath);
    const bytes = await fs.readFile(filePath);
    assert.equal(bytes.includes(Buffer.from(SECRET)), false);
    assert.equal(JSON.stringify(document.state).includes(SECRET), false);
    assert.equal(JSON.stringify(await runtime.credentialStore.list()).includes(SECRET), false);

    const malformed = [{ id: "bad", provider: "openai", model: "gpt", baseUrl: `https://example.test/v1?token=${SECRET}` }];
    assert.throws(
      () => validateLlmProfiles(malformed),
      (error) => error instanceof Error && !error.message.includes(SECRET) && /credential-bearing/.test(error.message),
      "validation errors name the bad field without echoing credential values",
    );

    await document.dispose();
  });
});

/** @param {string} filePath */
function fileUri(filePath) {
  return {
    scheme: "file",
    fsPath: filePath,
    toString: () => pathToFileURL(filePath).href,
  };
}

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
  static async create() {
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
    const model = registered?.models.find((entry) => entry.id === modelId);
    return model ? { provider: providerId, id: model.id, baseUrl: registered.baseUrl } : undefined;
  }
}
