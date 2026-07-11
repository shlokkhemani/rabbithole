const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const MODEL_URL = "https://openrouter.ai/api/v1/models";
const LOCAL_MODEL_URL = "http://localhost:11434/v1/models";
const MOCK_KEY = `sk-or-v1-${"x".repeat(64)}`;

export const MOCK_MODEL = "anthropic/claude-sonnet-5";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, http-referer, x-title",
  };
}

export function sse(chunks) {
  return chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
}

export async function routeProvider(page, { keyStatus, streams = [], onProviderCall = null, providerDelayMs = 0, keyLabel = "test key" } = {}) {
  await page.route(LOCAL_MODEL_URL, (route) => route.fulfill({
    status: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ data: [{ id: "llama3.2", name: "llama3.2" }, { id: "deepseek-r1:7b", name: "deepseek-r1:7b" }] }),
  }));
  await page.route(MODEL_URL, (route) => route.fulfill({
    status: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ data: [
      { id: MOCK_MODEL, name: "Anthropic: Claude Sonnet 5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" } },
      { id: "openai/gpt-5", name: "OpenAI: GPT-5", context_length: 400000, pricing: { prompt: "0.00000125", completion: "0.00001" } },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek: DeepSeek V4 Flash", context_length: 164000, pricing: { prompt: "0", completion: "0" } },
    ] }),
  }));
  await page.route(KEY_URL, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
    const key = (route.request().headers().authorization || "").replace(/^Bearer\s+/i, "");
    const status = keyStatus ? keyStatus(key) : 200;
    await route.fulfill({ status, headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" }, body: status === 200 ? JSON.stringify({ data: { label: keyLabel } }) : JSON.stringify({ error: { message: "invalid key" } }) });
  });
  await page.route(PROVIDER_URL, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
    onProviderCall?.();
    const chunks = streams.shift() || ["# Fallback\n\nFallback streamed document."];
    if (providerDelayMs) await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
    await route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" }, body: sse(chunks) });
  });
}

export async function seedConfiguredOpenRouter(context) {
  await context.addInitScript(({ key, model }) => {
    localStorage.setItem("rh-web-settings", JSON.stringify({
      preset: "openrouter", base_url: "https://openrouter.ai/api/v1", model: model, session_only: false,
      generation_setup: { version: 1, preset: "openrouter", base_url: "https://openrouter.ai/api/v1", model },
    }));
    localStorage.setItem("rh-web-api-keys", JSON.stringify({ openrouter: key }));
  }, { key: MOCK_KEY, model: MOCK_MODEL });
}
