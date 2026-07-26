export const PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    recommended: true,
    model_source: "catalog",
    base_url: "https://openrouter.ai/api/v1",
    kind: "openai-compatible",
    requires_key: true,
    model: "anthropic/claude-sonnet-5",
    transcribe_model: "google/gemini-2.5-flash",
  }),
  local: Object.freeze({
    id: "local",
    label: "Local",
    model_source: "custom",
    base_url: "http://localhost:11434/v1",
    kind: "openai-compatible",
    requires_key: false,
    model: "llama3.2",
    transcribe_model: "llama3.2",
  }),
  custom_endpoint: Object.freeze({
    id: "custom_endpoint",
    label: "Custom",
    model_source: "custom",
    base_url: "",
    kind: "openai-compatible",
    requires_key: false,
    allows_key: true,
    requires_base_url: true,
    key_label: "API key",
    model: "",
    transcribe_model: "",
  }),
});

export function providerFor(id) {
  if (id === "custom") return PROVIDERS.local;
  return PROVIDERS[id] || PROVIDERS.openrouter;
}

export function defaultBrainSettings() {
  const provider = PROVIDERS.openrouter;
  return {
    preset: provider.id,
    base_url: provider.base_url,
    model: provider.model,
    transcribe_model: provider.transcribe_model,
    fetch_proxy_url: "",
    session_only: false,
    providers: providerDefaults(),
  };
}

export function settingsForProvider(id, current = {}) {
  const provider = providerFor(id);
  const currentProvider = providerFor(current.preset);
  const providers = normalizeProviderSettings(current.providers);
  providers[currentProvider.id] = settingsSlot(currentProvider, current);
  const restored = settingsSlot(provider, providers[provider.id]);
  return {
    ...current,
    preset: provider.id,
    ...restored,
    providers,
  };
}

export function providerDefaults() {
  return Object.fromEntries(Object.values(PROVIDERS).map((provider) => [provider.id, settingsSlot(provider)]));
}

export function normalizeProviderSettings(value) {
  const providers = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return providers;
  for (const [id, slot] of Object.entries(value)) {
    const provider = id === "custom" ? PROVIDERS.local : PROVIDERS[id];
    if (!provider || !slot || typeof slot !== "object" || Array.isArray(slot)) continue;
    providers[provider.id] = settingsSlot(provider, slot);
  }
  return providers;
}

function settingsSlot(provider, value = {}) {
  return {
    base_url: typeof value.base_url === "string" ? value.base_url : provider.base_url,
    model: typeof value.model === "string" ? value.model : provider.model,
    transcribe_model: typeof value.transcribe_model === "string" ? value.transcribe_model : provider.transcribe_model,
  };
}
