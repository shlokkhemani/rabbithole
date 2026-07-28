import { addressSpaceHint, fetchOpenAICompatibleModels } from "./model-endpoint.js";

export async function discoverLocalModels(baseUrl, { signal } = {}) {
  const base = String(baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  const models = await fetchOpenAICompatibleModels(base, { signal });
  const showUrl = ollamaShowUrl(base);
  return Promise.all(models.map(async (model) => {
    try {
      const detail = await fetch(showUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.id }),
        signal,
        ...addressSpaceHint(showUrl),
      });
      if (!detail.ok) return { ...model, capabilities: null, vision: null };
      const payload = await detail.json();
      const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities.map(String) : null;
      return { ...model, capabilities, vision: capabilities ? capabilities.includes("vision") : null };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return { ...model, capabilities: null, vision: null };
    }
  }));
}

function ollamaShowUrl(baseUrl) {
  const value = String(baseUrl || "").replace(/\/+$/, "");
  return `${value.replace(/\/v1$/i, "")}/api/show`;
}
