export async function discoverLocalModels(baseUrl, { signal } = {}) {
  const base = String(baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  const response = await fetch(`${base}/models`, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Local model endpoint returned HTTP ${response.status}.`);
  const json = await response.json();
  if (!Array.isArray(json?.data)) throw new Error("Local model endpoint returned an invalid model list.");
  const models = json.data.filter((model) => model?.id).map((model) => ({
    id: String(model.id),
    name: String(model.name || model.id),
  })).filter((model) => !/embed/i.test(`${model.id} ${model.name}`));
  const showUrl = ollamaShowUrl(base);
  return Promise.all(models.map(async (model) => {
    try {
      const detail = await fetch(showUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.id }),
        signal,
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
