import assert from "node:assert/strict";
import { discoverLocalModels } from "../../src/web/brain/local-model-catalog.js";
import { pdfTranscriptionCapability } from "../../src/web/brain/pdf-transcription.js";
import { formatModelPrice } from "../../src/web/brain/model-catalog.js";

assert.equal(formatModelPrice({ id: "local/model" }), "", "local models without provider pricing should have no price label");
assert.equal(formatModelPrice({ promptPrice: -1, completionPrice: -1 }), "Varies", "router-dependent pricing should not render negative token costs");
assert.equal(formatModelPrice({ promptPrice: 0, completionPrice: 0 }), "Free");

const localSettings = { preset: "custom", model: "text:7b", transcribe_model: "text:7b" };
assert.equal(pdfTranscriptionCapability({ preset: "openrouter", transcribe_model: "vision/cloud" }).available, true);
assert.equal(pdfTranscriptionCapability(localSettings, { models: [] }).status, "no_models");
assert.equal(pdfTranscriptionCapability(localSettings, { models: [{ id: "text:7b", vision: false }] }).status, "no_vision");
assert.equal(pdfTranscriptionCapability(localSettings, { models: [{ id: "custom:7b", vision: null }] }).status, "unverified");
assert.equal(
  pdfTranscriptionCapability(localSettings, { models: [{ id: "text:7b", vision: false }, { id: "vision:11b", vision: true }] }).recommendedModel,
  "vision:11b",
);
assert.equal(
  pdfTranscriptionCapability({ ...localSettings, transcribe_model: "vision:11b" }, { models: [{ id: "vision:11b", vision: true }] }).available,
  true,
);

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), body: options.body || "" });
  if (String(url).endsWith("/v1/models")) {
    return new Response(JSON.stringify({ data: [{ id: "embed:latest" }, { id: "text:7b" }, { id: "vision:11b" }] }), { status: 200 });
  }
  const model = JSON.parse(options.body).model;
  return new Response(JSON.stringify({ capabilities: model === "vision:11b" ? ["completion", "vision"] : ["completion"] }), { status: 200 });
};
try {
  const models = await discoverLocalModels("http://localhost:11434/v1");
  assert.deepEqual(models.map(({ id, vision }) => ({ id, vision })), [
    { id: "text:7b", vision: false },
    { id: "vision:11b", vision: true },
  ]);
  assert.equal(calls.filter((call) => call.url === "http://localhost:11434/api/show").length, 2);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("ok PDF transcription capability: provider states and Ollama vision discovery");
