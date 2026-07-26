export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(String(value || "").trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchOpenAICompatibleModels(baseUrl, { apiKey = "", signal } = {}) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  // A relative value would resolve against this origin and quietly probe the app itself.
  if (!isHttpUrl(base)) throw Object.assign(new Error("Enter a full URL, like https://api.example.com/v1."), { code: "invalid_url" });
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${base}/models`, { headers, signal, ...loopbackFetchHint(base) });
  if (!response.ok) {
    throw Object.assign(new Error(`Model endpoint returned HTTP ${response.status}.`), { status: response.status });
  }
  const json = await response.json();
  const data = json?.data === null ? [] : json?.data;
  if (!Array.isArray(data)) throw new Error("Model endpoint returned an invalid model list.");
  return data.filter((model) => model?.id).map((model) => ({
    id: String(model.id),
    name: String(model.name || model.id),
  })).filter((model) => !/embed/i.test(`${model.id} ${model.name}`));
}

export function loopbackFetchHint(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
      ? { targetAddressSpace: "loopback" }
      : {};
  } catch {
    return {};
  }
}
