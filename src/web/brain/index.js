import { providerFor } from "./provider-registry.js";
import { OpenAICompatibleBrain } from "./openai-compatible.js";
import { AnthropicDirectBrain } from "./anthropic-messages.js";

export * from "./errors.js";
export * from "./provider-registry.js";
export * from "./tested-models.js";
export * from "./title-sentinel.js";
export * from "./openai-compatible.js";
export * from "./anthropic-messages.js";

export function createBrain(settings, apiKey) {
  const preset = providerFor(settings?.preset);
  const base = settings?.base_url || preset.base_url;
  const common = {
    baseUrl: base,
    apiKey,
    authorModel: settings?.author_model || preset.author_model,
    answerModel: settings?.answer_model || preset.answer_model,
  };
  if (preset.kind === "anthropic-direct") return new AnthropicDirectBrain(common);
  return new OpenAICompatibleBrain(common);
}
