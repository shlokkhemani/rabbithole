import assert from "node:assert/strict";
import { fetchOpenAICompatibleModels, isHttpUrl } from "../../src/web/brain/model-endpoint.js";
import { discoverLocalModels } from "../../src/web/brain/local-model-catalog.js";

assert.equal(isHttpUrl("https://api.example.com/v1"), true);
assert.equal(isHttpUrl("http://localhost:11434/v1"), true);
assert.equal(isHttpUrl("api.example.com/v1"), false, "a bare host would resolve against the app origin");
assert.equal(isHttpUrl("file:///etc/passwd"), false);
assert.equal(isHttpUrl(""), false);

const originalFetch = globalThis.fetch;
let calls = [];
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

try {
  stubFetch(() => json({ data: [{ id: "gpt-oss" }, { id: "text-embedding-3" }, { id: "big", name: "Big Model" }] }));
  let models = await fetchOpenAICompatibleModels("https://api.example.com/v1/", { apiKey: "secret" });
  assert.deepEqual(models.map((model) => model.id), ["gpt-oss", "big"], "embedding models are not chat models");
  assert.equal(models[1].name, "Big Model");
  assert.equal(calls[0].url, "https://api.example.com/v1/models", "a trailing slash must not double up");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret", "a custom endpoint's key must be sent");
  assert.equal(calls[0].options.targetAddressSpace, undefined, "remote endpoints are not loopback requests");

  stubFetch(() => json({ data: [{ id: "llama3.2" }] }));
  models = await fetchOpenAICompatibleModels("http://localhost:11434/v1");
  assert.equal("Authorization" in calls[0].options.headers, false, "no key means no Authorization header");
  assert.equal(calls[0].options.targetAddressSpace, "loopback", "loopback endpoints need the private network hint");

  // Ollama marshals an empty model list as `"data": null`, not `[]`.
  stubFetch(() => json({ data: null }));
  assert.deepEqual(await fetchOpenAICompatibleModels("http://localhost:11434/v1"), []);

  stubFetch(() => json({ data: { nope: true } }));
  await assert.rejects(() => fetchOpenAICompatibleModels("https://api.example.com/v1"), /invalid model list/);

  for (const status of [401, 403, 500]) {
    stubFetch(() => json({ error: { message: "nope" } }, status));
    const error = await fetchOpenAICompatibleModels("https://api.example.com/v1").catch((err) => err);
    assert.equal(error.status, status, "the status has to survive so the UI can tell auth from downtime");
  }

  stubFetch(() => json({ data: [] }));
  const invalid = await fetchOpenAICompatibleModels("api.example.com/v1").catch((err) => err);
  assert.equal(invalid.code, "invalid_url");
  assert.equal(calls.length, 0, "a relative URL must never be fetched against this origin");

  stubFetch(() => { throw new TypeError("Failed to fetch"); });
  const blocked = await fetchOpenAICompatibleModels("https://api.example.com/v1").catch((err) => err);
  assert.equal(blocked.status, undefined, "a CORS or offline failure carries no HTTP status");

  /* Local still layers the Ollama-only vision probe on top of the shared fetch. */
  stubFetch((url, options) => {
    if (url.endsWith("/v1/models")) return json({ data: [{ id: "llama3.2" }, { id: "llava" }] });
    if (url.endsWith("/api/show")) {
      const model = JSON.parse(String(options.body || "{}")).model || "";
      return json({ capabilities: /llava/.test(model) ? ["completion", "vision"] : ["completion"] });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const local = await discoverLocalModels("http://localhost:11434/v1");
  assert.deepEqual(local.map((model) => [model.id, model.vision]), [["llama3.2", false], ["llava", true]]);
  assert.equal(calls.some((call) => "Authorization" in call.options.headers), false, "Local never sends a key");
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write("model-endpoint ok\n");
