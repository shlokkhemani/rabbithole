import { buildAnswerMessages } from "../../core/prompts/index.js";
import { ProviderError, normalizeProviderError } from "./errors.js";
import { OpenAICompatibleBrain } from "./openai-compatible.js";

export class AnthropicDirectBrain {
  constructor({ baseUrl, apiKey, authorModel, answerModel } = {}) {
    this.baseUrl = String(baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.apiKey = apiKey || "";
    this.authorModel = authorModel || answerModel || "claude-sonnet-5";
    this.answerModel = answerModel || this.authorModel;
    this.compat = new OpenAICompatibleBrain({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      authorModel: this.authorModel,
      answerModel: this.answerModel,
      extraHeaders: { "anthropic-dangerous-direct-browser-access": "true" },
    });
  }

  async *authorDocument(source, signal) {
    yield* this.compat.authorDocument(source, signal);
  }

  async *answerBranch(context, signal) {
    try {
      yield* this.compat.answerBranch(context, signal);
    } catch (err) {
      const normalized = normalizeProviderError(err);
      if (normalized.status && normalized.status !== 404) throw normalized;
      yield* this.answerBranchMessagesApi(context, signal);
    }
  }

  async *answerBranchMessagesApi(context, signal) {
    const messages = buildAnswerMessages(context);
    const system = messages.find((m) => m.role === "system")?.content || "";
    const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
    let response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: this.answerModel,
          max_tokens: 4096,
          stream: true,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal,
      });
    } catch (err) {
      throw normalizeProviderError(err);
    }
    if (!response.ok) throw await anthropicResponseError(response);
    if (!response.body) throw new ProviderError("Anthropic did not return a stream.", { code: "no_stream" });

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
          const text = parseAnthropicSseEvent(event);
          if (text) yield text;
        }
      }
      if (buffer) {
        const text = parseAnthropicSseEvent(buffer);
        if (text) yield text;
      }
    } catch (err) {
      throw normalizeProviderError(err);
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
}

function parseAnthropicSseEvent(eventText) {
  const lines = String(eventText || "").split(/\r?\n/);
  let out = "";
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data) continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.type === "error") throw new ProviderError(json.error?.message || "Anthropic returned an error.", { code: json.error?.type || "provider_error" });
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") out += json.delta.text || "";
  }
  return out;
}

async function anthropicResponseError(response) {
  let detail = "";
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || "";
      } catch {
        detail = text.slice(0, 180);
      }
    }
  } catch {}
  const status = response.status;
  const prefix = status === 401 ? "Bad or missing Anthropic API key"
    : status === 429 ? "Rate limited by Anthropic"
      : `Anthropic returned HTTP ${status}`;
  return new ProviderError(detail ? `${prefix}: ${detail}` : prefix, {
    status,
    code: String(status),
    retryable: status !== 401 && status !== 403,
  });
}
