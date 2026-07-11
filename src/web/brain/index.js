import { providerFor } from "./provider-registry.js";
import { OpenAICompatibleBrain } from "./openai-compatible.js";

export * from "./errors.js";
export * from "./provider-registry.js";
export * from "./title-sentinel.js";
export * from "./generation-events.js";
export * from "./openai-compatible.js";

export function createBrain(settings, apiKey) {
  const preset = providerFor(settings?.preset);
  const base = settings?.base_url || preset.base_url;
  const common = {
    baseUrl: base,
    apiKey,
    authorModel: settings?.author_model || preset.author_model,
    answerModel: settings?.answer_model || preset.answer_model,
  };
  return new OpenAICompatibleBrain(common);
}
