import { buildAnswerMessages, buildAuthorMessages, buildExplainerMessages, buildTranscribeMessages } from "../../core/prompts/index.js";
import { ProviderError, normalizeProviderError } from "./errors.js";
import { adaptBranchGeneration, adaptTextGeneration } from "./generation-events.js";

export class OpenAICompatibleBrain {
  constructor({ baseUrl, apiKey, model, transcribeModel, extraHeaders = {}, title = "Rabbithole" } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey || "";
    this.model = model || "anthropic/claude-sonnet-5";
    this.transcribeModel = transcribeModel || this.model;
    this.extraHeaders = extraHeaders || {};
    this.title = title;
  }

  async *authorDocument(source, signal) {
    const body = {
      model: this.model,
      messages: buildAuthorMessages(source),
      stream: true,
      temperature: 0.2,
    };
    yield* adaptTextGeneration(streamOpenAICompatible({
      url: chatCompletionsUrl(this.baseUrl),
      apiKey: this.apiKey,
      body,
      signal,
      extraHeaders: this.extraHeaders,
      title: this.title,
    }));
  }

  async *authorExplainer({ question } = {}, signal) {
    const body = {
      model: this.model,
      messages: buildExplainerMessages({ question }),
      stream: true,
      temperature: 0.35,
    };
    yield* adaptTextGeneration(streamOpenAICompatible({
      url: chatCompletionsUrl(this.baseUrl),
      apiKey: this.apiKey,
      body,
      signal,
      extraHeaders: this.extraHeaders,
      title: this.title,
    }));
  }

  async *answerBranch(context, signal) {
    const body = {
      model: this.model,
      messages: buildAnswerMessages(context),
      stream: true,
      temperature: 0.4,
    };
    yield* adaptBranchGeneration(streamOpenAICompatible({
      url: chatCompletionsUrl(this.baseUrl),
      apiKey: this.apiKey,
      body,
      signal,
      extraHeaders: this.extraHeaders,
      title: this.title,
    }), { fallbackTitle: context?.fallbackTitle });
  }

  async *transcribePages(input, signal) {
    yield* adaptTextGeneration(streamOpenAICompatible({
      url: chatCompletionsUrl(this.baseUrl), apiKey: this.apiKey,
      body: { model: this.transcribeModel, messages: buildTranscribeMessages(input), stream: true, temperature: 0.1 },
      signal, extraHeaders: this.extraHeaders, title: this.title,
    }));
  }
}

export async function* streamOpenAICompatible({ url, apiKey, body, signal, extraHeaders = {}, title = "Rabbithole" }) {
  let response;
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...extraHeaders,
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (url.startsWith("https://openrouter.ai/")) {
      headers["HTTP-Referer"] = globalThis.location?.origin || "https://rabbithole.ing";
      headers["X-Title"] = title;
    }
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (err) {
    throw normalizeProviderError(err);
  }
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new ProviderError("The provider did not return a stream.", { code: "no_stream" });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) {
        const text = parseOpenAISseEvent(event);
        if (text) yield text;
      }
    }
    if (buffer) {
      const text = parseOpenAISseEvent(buffer);
      if (text) yield text;
    }
  } catch (err) {
    throw normalizeProviderError(err);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export function parseOpenAISseEvent(eventText) {
  const lines = String(eventText || "").split(/\r?\n/);
  let out = "";
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.error) throw new ProviderError(json.error.message || "The provider returned an error.", { code: json.error.code || "provider_error" });
    out += json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || "";
  }
  return out;
}

async function responseError(response) {
  let detail = "";
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.message || "";
      } catch {
        detail = text.slice(0, 180);
      }
    }
  } catch {}
  const status = response.status;
  const prefix = status === 401 ? "Bad or missing API key"
    : status === 429 ? "Rate limited by the provider"
      : `Provider returned HTTP ${status}`;
  return new ProviderError(detail ? `${prefix}: ${detail}` : prefix, {
    status,
    code: String(status),
    retryable: status !== 401 && status !== 403,
  });
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!value) throw new ProviderError("A provider base URL is required.", { code: "missing_base_url", retryable: false });
  return value;
}

function chatCompletionsUrl(baseUrl) {
  return /\/chat\/completions$/.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
}
