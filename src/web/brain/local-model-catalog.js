export async function discoverLocalModels(baseUrl, { signal } = {}) {
  const base = String(baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  const response = await fetch(`${base}/models`, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Local model endpoint returned HTTP ${response.status}.`);
  const json = await response.json();
  if (!Array.isArray(json?.data)) throw new Error("Local model endpoint returned an invalid model list.");
  return json.data.filter((model) => model?.id).map((model) => ({
    id: String(model.id),
    name: String(model.name || model.id),
  })).filter((model) => !/embed/i.test(`${model.id} ${model.name}`));
}
