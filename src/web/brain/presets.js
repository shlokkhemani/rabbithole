export const BRAIN_PRESETS = Object.freeze({
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    recommended: true,
    base_url: "https://openrouter.ai/api/v1",
    kind: "openai-compatible",
    requires_key: true,
    author_model: "anthropic/claude-sonnet-5",
    answer_model: "anthropic/claude-sonnet-5",
  }),
  anthropic: Object.freeze({
    id: "anthropic",
    label: "Anthropic direct",
    base_url: "https://api.anthropic.com/v1",
    kind: "anthropic-direct",
    requires_key: true,
    author_model: "claude-sonnet-5",
    answer_model: "claude-sonnet-5",
  }),
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI",
    base_url: "https://api.openai.com/v1",
    kind: "openai-compatible",
    requires_key: true,
    author_model: "gpt-5",
    answer_model: "gpt-5",
  }),
  custom: Object.freeze({
    id: "custom",
    label: "Custom / local",
    base_url: "http://localhost:11434/v1",
    kind: "openai-compatible",
    requires_key: false,
    author_model: "anthropic/claude-sonnet-5",
    answer_model: "anthropic/claude-sonnet-5",
  }),
});

export function presetFor(id) {
  return BRAIN_PRESETS[id] || BRAIN_PRESETS.openrouter;
}

export function defaultBrainSettings() {
  const preset = BRAIN_PRESETS.openrouter;
  return {
    preset: preset.id,
    base_url: preset.base_url,
    author_model: preset.author_model,
    answer_model: preset.answer_model,
    session_only: true,
  };
}

export function settingsForPreset(id, current = {}) {
  const preset = presetFor(id);
  return {
    ...current,
    preset: preset.id,
    base_url: preset.base_url,
    author_model: preset.author_model,
    answer_model: preset.answer_model,
  };
}
