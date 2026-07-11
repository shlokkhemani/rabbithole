export const PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    id: "openrouter",
    aliases: Object.freeze(["anthropic", "openai"]),
    label: "OpenRouter",
    recommended: true,
    model_source: "catalog",
    base_url: "https://openrouter.ai/api/v1",
    kind: "openai-compatible",
    requires_key: true,
    model: "anthropic/claude-sonnet-5",
  }),
  custom: Object.freeze({
    id: "custom",
    label: "Local",
    model_source: "custom",
    base_url: "http://localhost:11434/v1",
    kind: "openai-compatible",
    requires_key: false,
    model: "llama3.2",
  }),
});

export function resolveProviderId(id) {
  if (PROVIDERS[id]) return id;
  return Object.values(PROVIDERS).find((provider) => provider.aliases?.includes(id))?.id || "openrouter";
}

export function providerFor(id) {
  return PROVIDERS[resolveProviderId(id)];
}

export function defaultBrainSettings() {
  const provider = PROVIDERS.openrouter;
  return {
    preset: provider.id,
    base_url: provider.base_url,
    model: provider.model,
    fetch_proxy_url: "",
    session_only: false,
  };
}

export function settingsForProvider(id, current = {}) {
  const provider = providerFor(id);
  return {
    ...current,
    preset: provider.id,
    base_url: provider.base_url,
    model: provider.model,
  };
}
