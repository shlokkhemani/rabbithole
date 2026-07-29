import fs from "node:fs/promises";
import path from "node:path";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import { NoraResourceLoader } from "../agent/resource-loader.js";
import { InMemoryModelsStore } from "../llm/model-runtime.js";

const PROVIDER_ID = "nora-vsix-smoke";
const MODEL_ID = "nora-vsix-smoke-model";
const API_ID = "nora-vsix-smoke-api";
const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { ...ZERO_COST, total: 0 },
});
const ONE_BY_ONE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

/**
 * @param {{ extensionPath: string }} options
 */
export async function runVsixSmoke(options) {
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    modelRefreshTimeoutMs: 0,
  });
  const responses = createSmokeResponses();
  modelRuntime.registerProvider(PROVIDER_ID, {
    name: "Nora VSIX smoke provider",
    api: API_ID,
    apiKey: "smoke",
    streamSimple: /** @type {any} */ (smokeStreamSimple(responses)),
    models: /** @type {any} */ ([smokeModel()]),
  });
  const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
  if (!model) throw new Error("Smoke model was not registered");

  /** @type {Array<Record<string, unknown>>} */
  const toolCalls = [];
  /** @type {string[]} */
  const events = [];
  const resourceLoader = new NoraResourceLoader({ skills: [], diagnostics: [] });
  const { session } = await createAgentSession({
    cwd: options.extensionPath,
    agentDir: options.extensionPath,
    modelRuntime,
    model,
    thinkingLevel: "off",
    resourceLoader: /** @type {any} */ (resourceLoader),
    customTools: /** @type {any} */ ([smokeTool(toolCalls)]),
    noTools: "all",
    tools: ["nora_smoke_tool"],
    sessionManager: SessionManager.inMemory(options.extensionPath),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
      packages: [],
      extensions: [],
      prompts: [],
      themes: [],
      skills: [],
    }, { projectTrusted: true }),
  });
  try {
    session.subscribe((event) => events.push(event.type));
    await session.prompt("Call nora_smoke_tool with value ping, then summarize its result.", { expandPromptTemplates: false });
  } finally {
    session.dispose();
  }

  const photon = await verifyPhotonWasm(options.extensionPath);
  if (toolCalls.length !== 1 || toolCalls[0].value !== "ping") {
    throw new Error(`Smoke tool was not called exactly once: ${JSON.stringify(toolCalls)}`);
  }
  if (!events.includes("tool_execution_end") || !events.includes("agent_end")) {
    throw new Error(`Smoke AgentSession did not complete the expected event path: ${events.join(", ")}`);
  }

  return {
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    agentSession: "completed",
    toolCalls,
    photon,
  };
}

function smokeModel() {
  return {
    id: MODEL_ID,
    name: "Nora VSIX Smoke Model",
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: /** @type {const} */ (["text", "image"]),
    cost: ZERO_COST,
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function createSmokeResponses() {
  let callCount = 0;
  return {
    /** @param {unknown} _context */
    next(_context) {
      callCount += 1;
      if (callCount === 1) {
        return assistantMessage([{
          type: "toolCall",
          id: "smoke-tool-call",
          name: "nora_smoke_tool",
          arguments: { value: "ping" },
        }], "toolUse");
      }
      return assistantMessage([{ type: "text", text: "TITLE: VSIX smoke\nTool result observed: pong:ping" }], "stop");
    },
  };
}

/** @param {{ next(context: unknown): Record<string, unknown> }} responses */
function smokeStreamSimple(responses) {
  /**
   * @param {{ id?: unknown, provider?: unknown, api?: unknown }} model
   * @param {unknown} context
   */
  return (model, context) => smokeStream(responses.next(context), model);
}

/** @param {Array<Record<string, unknown>>} toolCalls */
function smokeTool(toolCalls) {
  return {
    name: "nora_smoke_tool",
    label: "Nora smoke tool",
    description: "No-network tool used by the installed VSIX smoke test.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    /**
     * @param {string} _toolCallId
     * @param {{ value: string }} params
     */
    async execute(_toolCallId, params) {
      toolCalls.push({ ...params });
      return {
        content: [{ type: "text", text: `pong:${params.value}` }],
        details: { ok: true, value: params.value },
      };
    },
  };
}

/** @param {Array<Record<string, unknown>>} content @param {"stop" | "toolUse"} stopReason */
function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    content,
    api: API_ID,
    provider: PROVIDER_ID,
    model: MODEL_ID,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

/** @param {Record<string, unknown>} message @param {{ id?: unknown, provider?: unknown, api?: unknown }} model @returns {any} */
function smokeStream(message, model) {
  const events = streamEvents(message);
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
        yield event;
      }
    },
    async result() {
      return { ...message, model: String(model.id), provider: String(model.provider), api: String(model.api) };
    },
  };
}

/** @param {Record<string, any>} message @returns {any[]} */
function streamEvents(message) {
  const partial = /** @type {any} */ ({ ...message, content: [] });
  const events = /** @type {any[]} */ ([{ type: "start", partial }]);
  message.content.forEach(/** @param {any} block @param {number} index */ (block, index) => {
    if (block.type === "text") {
      const textPartial = { ...message, content: [...partial.content, { type: "text", text: block.text }] };
      events.push({ type: "text_start", contentIndex: index, partial });
      events.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: textPartial });
      events.push({ type: "text_end", contentIndex: index, content: block.text, partial: textPartial });
      partial.content = textPartial.content;
      return;
    }
    const toolPartial = { ...message, content: [...partial.content, block] };
    events.push({ type: "toolcall_start", contentIndex: index, partial });
    events.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: toolPartial });
    events.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: toolPartial });
    partial.content = toolPartial.content;
  });
  events.push({ type: "done", reason: message.stopReason, message });
  return events;
}

/** @param {string} extensionPath */
async function verifyPhotonWasm(extensionPath) {
  await fs.access(path.join(extensionPath, "out", "photon_rs_bg.wasm"));
  const resized = await resizeImage(Buffer.from(ONE_BY_ONE_PNG, "base64"), "image/png", {
    maxWidth: 8,
    maxHeight: 8,
    maxBytes: 32 * 1024,
  });
  if (!resized || resized.mimeType !== "image/png" || resized.width !== 1 || resized.height !== 1) {
    throw new Error("Photon WASM image preprocessing did not return the expected PNG result");
  }
  return { mimeType: resized.mimeType, width: resized.width, height: resized.height, wasResized: resized.wasResized };
}
