import { createHash } from "node:crypto";

const COMMITTED_KINDS = new Set(["user_message", "assistant_message", "tool_result"]);
const RECORD_KINDS = new Set([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "assistant_checkpoint",
  "nora_mutation",
  "run_terminal",
]);

/** @typedef {Record<string, unknown>} TranscriptRecord */

/**
 * @param {string} runId
 * @param {unknown} message
 * @param {{ messageId?: string, sequence?: number, now?: string }} [options]
 * @returns {TranscriptRecord[]}
 */
export function committedMessageRecords(runId, message, options = {}) {
  const normalized = normalizeMessage(message);
  const sequence = options.sequence ?? 0;
  const messageId = options.messageId ?? stableMessageId(runId, normalized, sequence);
  if (normalized.role === "user") {
    return [baseRecord("user_message", runId, messageId, options.now, { message: normalized })];
  }
  if (normalized.role === "toolResult") {
    return [baseRecord("tool_result", runId, messageId, options.now, {
      toolCallId: String(normalized.toolCallId ?? ""),
      toolName: String(normalized.toolName ?? ""),
      message: normalized,
    })];
  }
  if (normalized.role !== "assistant") {
    throw new TypeError(`Unsupported model-facing message role: ${String(normalized.role)}`);
  }
  const records = [baseRecord("assistant_message", runId, messageId, options.now, { message: normalized })];
  for (const call of toolCallsFromAssistant(normalized)) {
    records.push(baseRecord("tool_call", runId, call.id || stableToolCallId(messageId, call), options.now, {
      messageId,
      toolCallId: call.id,
      toolName: call.name,
      arguments: cloneJson(call.arguments ?? call.args ?? {}),
    }));
  }
  return records;
}

/**
 * @param {string} runId
 * @param {string} messageId
 * @param {unknown} partialMessage
 * @param {{ sequence?: number, now?: string }} [options]
 */
export function assistantCheckpointRecord(runId, messageId, partialMessage, options = {}) {
  const content = assistantText(partialMessage);
  return baseRecord("assistant_checkpoint", runId, messageId, options.now, {
    sequence: safeNonNegativeInteger(options.sequence ?? 0, "sequence"),
    content,
    message: partialAssistantMessage(partialMessage, content),
  });
}

/**
 * @param {string} runId
 * @param {"complete" | "cancelled" | "failed" | "interrupted"} status
 * @param {{ error?: unknown, now?: string }} [options]
 */
export function runTerminalRecord(runId, status, options = {}) {
  if (!["complete", "cancelled", "failed", "interrupted"].includes(status)) throw new TypeError("terminal status is invalid");
  return baseRecord("run_terminal", runId, `${runId}:terminal`, options.now, {
    status,
    error: status === "failed" ? normalizeError(options.error) : null,
  });
}

/**
 * Record a Nora-owned document mutation that happened during a run. These
 * records advance the JSONL cutoff with the document revision, but are not
 * replayed into Pi as model-facing messages.
 * @param {string} runId
 * @param {unknown} event
 * @param {{ sequence?: number, now?: string }} [options]
 */
export function runMutationRecord(runId, event, options = {}) {
  const sequence = safeNonNegativeInteger(options.sequence ?? 0, "sequence");
  return baseRecord("nora_mutation", runId, `${runId}:mutation:${sequence}`, options.now, {
    sequence,
    event: cloneJson(event),
  });
}

/** @param {TranscriptRecord[]} records */
export function replayableMessagesFromRecords(records) {
  /** @type {any[]} */
  const messages = [];
  const committedAssistantIds = new Set();
  /** @type {Map<string, TranscriptRecord>} */
  const checkpoints = new Map();
  let interruptedTerminal = null;
  for (const record of records) {
    validateTranscriptRecord(record);
    if (record.kind === "assistant_checkpoint") checkpoints.set(String(record.messageId), record);
    if (record.kind === "run_terminal" && record.status !== "complete") interruptedTerminal = record;
    if (!COMMITTED_KINDS.has(String(record.kind))) continue;
    const message = normalizeMessage(record.message);
    messages.push(message);
    if (record.kind === "assistant_message") committedAssistantIds.add(String(record.messageId));
  }
  if (interruptedTerminal) {
    for (const checkpoint of checkpoints.values()) {
      const messageId = String(checkpoint.messageId);
      if (committedAssistantIds.has(messageId)) continue;
      const checkpointMessage = normalizeMessage(checkpoint.message);
      messages.push({
        ...checkpointMessage,
        stopReason: interruptedTerminal.status === "cancelled" ? "aborted" : "error",
        errorMessage: interruptedTerminal.status === "failed" || interruptedTerminal.status === "interrupted" ? "interrupted" : undefined,
      });
    }
  }
  return messages;
}

/**
 * @param {TranscriptRecord[]} records
 * @param {{ appendMessage(message: unknown): unknown }} sessionManager
 */
export function replayRecordsToSessionManager(records, sessionManager) {
  for (const message of replayableMessagesFromRecords(records)) sessionManager.appendMessage(message);
}

/** @param {TranscriptRecord[]} records */
export function traceEntriesFromRecords(records) {
  return records.map((record) => {
    validateTranscriptRecord(record);
    if (record.kind === "user_message") return { kind: "user", text: messageText(record.message) };
    if (record.kind === "assistant_message") return { kind: "assistant", text: messageText(record.message) };
    if (record.kind === "tool_call") return { kind: "tool-call", text: `${record.toolName} ${JSON.stringify(record.arguments ?? {})}` };
    if (record.kind === "tool_result") return { kind: "tool-result", text: messageText(record.message) };
    if (record.kind === "assistant_checkpoint") return { kind: "assistant-checkpoint", text: String(record.content ?? "") };
    if (record.kind === "nora_mutation") return { kind: "nora-mutation", text: JSON.stringify(record.event ?? null) };
    if (record.kind === "run_terminal") return { kind: "terminal", text: String(record.status ?? "") };
    return { kind: String(record.kind), text: JSON.stringify(record) };
  });
}

/** @param {unknown} record */
export function validateTranscriptRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("transcript record must be an object");
  const raw = /** @type {Record<string, unknown>} */ (record);
  if (!RECORD_KINDS.has(String(raw.kind))) throw new TypeError(`unsupported transcript record kind: ${String(raw.kind)}`);
  requireString(raw.runId, "runId");
  requireString(raw.messageId, "messageId");
  if (raw.createdAt != null) requireString(raw.createdAt, "createdAt");
  if (COMMITTED_KINDS.has(String(raw.kind))) normalizeMessage(raw.message);
  if (raw.kind === "assistant_checkpoint") {
    safeNonNegativeInteger(raw.sequence, "sequence");
    if (typeof raw.content !== "string") throw new TypeError("checkpoint content must be a string");
  }
  if (raw.kind === "nora_mutation") {
    safeNonNegativeInteger(raw.sequence, "sequence");
    assertJsonValue(raw.event, "mutation event");
  }
  if (raw.kind === "tool_call") {
    requireString(raw.toolCallId, "toolCallId");
    requireString(raw.toolName, "toolName");
  }
  if (raw.kind === "run_terminal" && !["complete", "cancelled", "failed", "interrupted"].includes(String(raw.status))) {
    throw new TypeError("terminal status is invalid");
  }
  return true;
}

/** @param {unknown} value */
export function assistantText(value) {
  const message = /** @type {Record<string, any>} */ (value && typeof value === "object" ? value : {});
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (/** @type {{ type?: unknown }} */ (part).type === "text") return String(/** @type {{ text?: unknown }} */ (part).text ?? "");
      return "";
    })
    .join("");
}

/** @param {unknown} message */
function messageText(message) {
  const raw = /** @type {Record<string, any>} */ (message && typeof message === "object" ? message : {});
  if (typeof raw.content === "string") return raw.content;
  if (!Array.isArray(raw.content)) return "";
  return raw.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (part.type === "text") return String(part.text ?? "");
    if (part.type === "toolCall") return `${String(part.name ?? "tool")} ${JSON.stringify(part.arguments ?? part.args ?? {})}`;
    return "";
  }).filter(Boolean).join("\n");
}

/** @param {unknown} error */
export function normalizeError(error) {
  if (!error) return null;
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (typeof error === "string") return { message: error };
  if (typeof error === "object" && !Array.isArray(error)) {
    const raw = /** @type {Record<string, unknown>} */ (error);
    return cloneJson({
      name: typeof raw.name === "string" ? raw.name : undefined,
      message: typeof raw.message === "string" ? raw.message : undefined,
      code: typeof raw.code === "string" ? raw.code : undefined,
      reason: typeof raw.reason === "string" ? raw.reason : undefined,
    });
  }
  return { message: String(error) };
}

/** @param {unknown} value @param {string} label @param {Set<unknown>} [seen] */
function assertJsonValue(value, label, seen = new Set()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite JSON data`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} must be JSON data`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${label} must be plain JSON data`);
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) throw new TypeError(`${label}.${key} must be JSON data`);
    assertJsonValue(entry, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

/**
 * @param {string} kind
 * @param {string} runId
 * @param {string} messageId
 * @param {string | undefined} now
 * @param {Record<string, unknown>} extra
 */
function baseRecord(kind, runId, messageId, now, extra) {
  const record = {
    kind,
    runId: requireString(runId, "runId"),
    messageId: requireString(messageId, "messageId"),
    createdAt: now ?? new Date().toISOString(),
    ...extra,
  };
  validateTranscriptRecord(record);
  return record;
}

/** @param {unknown} message */
function normalizeMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new TypeError("message must be an object");
  const copy = cloneJson(message);
  const role = copy.role;
  if (!["user", "assistant", "toolResult"].includes(role)) throw new TypeError(`unsupported message role: ${String(role)}`);
  if (role === "assistant") delete copy.diagnostics;
  if (copy.timestamp == null) copy.timestamp = Date.now();
  return copy;
}

/** @param {unknown} value @param {string} label */
function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** @param {unknown} value @param {string} label */
function safeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return Number(value);
}

/** @param {any} assistant */
function toolCallsFromAssistant(assistant) {
  const content = Array.isArray(assistant.content) ? assistant.content : [];
  return content
    .filter((/** @type {any} */ part) => part && typeof part === "object" && part.type === "toolCall")
    .map((/** @type {any} */ part) => ({
      id: String(part.id ?? ""),
      name: String(part.name ?? ""),
      arguments: part.arguments ?? part.args ?? {},
    }))
    .filter((/** @type {{ id: string, name: string }} */ part) => part.id && part.name);
}

/** @param {string} messageId @param {{ id: string, name: string, arguments: unknown }} call */
function stableToolCallId(messageId, call) {
  return `${messageId}:tool:${hashJson(call).slice(0, 12)}`;
}

/** @param {string} runId @param {unknown} message @param {number} sequence */
function stableMessageId(runId, message, sequence) {
  return `${runId}:msg:${sequence}:${hashJson(message).slice(0, 12)}`;
}

/** @param {unknown} value */
function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** @param {unknown} partialMessage @param {string} content */
function partialAssistantMessage(partialMessage, content) {
  const raw = /** @type {Record<string, any>} */ (partialMessage && typeof partialMessage === "object" ? partialMessage : {});
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: raw.api ?? "unknown",
    provider: raw.provider ?? "unknown",
    model: raw.model ?? "unknown",
    usage: raw.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: raw.stopReason ?? "aborted",
    timestamp: raw.timestamp ?? Date.now(),
  };
}

/** @param {unknown} value */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
