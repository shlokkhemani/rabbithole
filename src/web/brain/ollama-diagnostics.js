import { discoverLocalModels } from "./local-model-catalog.js";

export const RECOMMENDED_OLLAMA_MODEL = "gemma3:4b";
export const RECOMMENDED_OLLAMA_MODEL_SIZE = "3.3 GB";
const DEFAULT_TIMEOUT_MS = 5000;

export async function diagnoseOllama(baseUrl, { requestPermission = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const urls = ollamaUrls(baseUrl);
  const permission = await queryLoopbackPermission();
  if (permission === "denied") return result("permission_denied", { permission, urls });
  if (permission === "prompt" && !requestPermission) return result("permission_prompt", { permission, urls });

  const opaque = await probe(urls.version, { mode: "no-cors", timeoutMs });
  const permissionAfterProbe = await queryLoopbackPermission();
  if (permissionAfterProbe === "denied") return result("permission_denied", { permission: permissionAfterProbe, urls });
  // Opaque no-cors probes are not permission-gated, so a failure here means the
  // endpoint itself is down — reporting it as a permission problem dead-ends
  // users whose Ollama simply isn't running.
  if (!opaque.ok) return result(opaque.timeout ? "timeout" : "unreachable", { permission: permissionAfterProbe, urls, error: opaque.error });

  const readable = await probe(urls.version, { mode: "cors", timeoutMs, parseJson: true });
  if (!readable.ok) {
    // Readable requests ARE permission-gated: an undecided permission blocks
    // them before CORS is consulted, so only blame Ollama's origin list once
    // the permission is settled.
    if (permissionAfterProbe === "prompt") return result("permission_prompt", { permission: permissionAfterProbe, urls, error: readable.error });
    return result("origin_blocked", { permission: permissionAfterProbe, urls, error: readable.error });
  }
  if (!readable.response.ok || !readable.json?.version) {
    return result("incompatible", {
      permission: permissionAfterProbe,
      urls,
      status: readable.response.status,
      error: readable.json?.error || "The local service did not return an Ollama version.",
    });
  }

  try {
    const models = await withTimeout((signal) => discoverLocalModels(urls.openAiBase, { signal }), timeoutMs);
    if (!models.length) return result("no_models", { permission: permissionAfterProbe, urls, version: readable.json.version, models });
    return result("ready", { permission: permissionAfterProbe, urls, version: readable.json.version, models });
  } catch (error) {
    const status = error?.name === "AbortError" ? "timeout"
      : error instanceof TypeError ? "origin_blocked"
        : "models_error";
    return result(status, {
      permission: permissionAfterProbe, urls, version: readable.json.version, error,
    });
  }
}

export async function pullOllamaModel(baseUrl, model = RECOMMENDED_OLLAMA_MODEL, { signal, onProgress } = {}) {
  const response = await fetch(ollamaUrls(baseUrl).pull, {
    method: "POST",
    headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
    body: JSON.stringify({ name: model, stream: true }),
    credentials: "omit",
    signal,
    ...loopbackFetchHint(),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status} while downloading the model.`);
  if (!response.body) throw new Error("Ollama did not return download progress.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const update = JSON.parse(line);
      if (update.error) throw new Error(update.error);
      onProgress?.(normalizePullProgress(update));
    }
  }
  if (buffer.trim()) {
    const update = JSON.parse(buffer);
    if (update.error) throw new Error(update.error);
    onProgress?.(normalizePullProgress(update));
  }
}

export async function verifyOllamaModel(baseUrl, model, { timeoutMs = 120000 } = {}) {
  const response = await withTimeout((signal) => fetch(`${ollamaUrls(baseUrl).openAiBase}/chat/completions`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word ready." }],
      stream: false,
      temperature: 0,
      max_tokens: 8,
    }),
    credentials: "omit",
    signal,
    ...loopbackFetchHint(),
  }), timeoutMs);
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status} while checking ${model}.`);
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("The model loaded, but did not return a response.");
  return content.trim();
}

export function ollamaUrls(baseUrl) {
  const openAiBase = String(baseUrl || "http://localhost:11434/v1").trim().replace(/\/+$/, "");
  const nativeBase = openAiBase.replace(/\/v1$/i, "");
  return {
    openAiBase,
    version: `${nativeBase}/api/version`,
    pull: `${nativeBase}/api/pull`,
  };
}

export async function queryLoopbackPermission() {
  if (!globalThis.navigator?.permissions?.query) return "unsupported";
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      const permission = await navigator.permissions.query({ name });
      if (permission?.state) return permission.state;
    } catch {}
  }
  return "unsupported";
}

function result(status, details) {
  return { status, ...details };
}

async function probe(url, { mode, timeoutMs, parseJson = false }) {
  try {
    const response = await withTimeout((signal) => fetch(url, {
      mode,
      credentials: "omit",
      signal,
      ...loopbackFetchHint(),
    }), timeoutMs);
    let json = null;
    if (parseJson) {
      try { json = await response.json(); } catch {}
    }
    return { ok: true, response, json };
  } catch (error) {
    return { ok: false, timeout: error?.name === "AbortError", error };
  }
}

function withTimeout(run, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.resolve().then(() => run(controller.signal)).finally(() => clearTimeout(timer));
}

function loopbackFetchHint() {
  return { targetAddressSpace: "loopback" };
}

function normalizePullProgress(update) {
  const total = Number(update?.total) || 0;
  const completed = Number(update?.completed) || 0;
  return {
    status: String(update?.status || "Downloading model…"),
    total,
    completed,
    fraction: total > 0 ? Math.max(0, Math.min(1, completed / total)) : null,
  };
}
