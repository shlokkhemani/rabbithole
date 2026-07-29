const WEBVIEW_MESSAGE_TYPES = new Set(["ready", "uiEvent"]);
const EXTENSION_MESSAGE_TYPES = new Set(["hydrate", "error", "command", "uiAck"]);

/**
 * @typedef {{ type: "ready" } | { type: "uiEvent", event: Record<string, unknown>, messageId?: string }} WebviewToExtensionMessage
 * @typedef {{ type: "hydrate", hydration: Record<string, unknown>, readonly: boolean } | { type: "error", message: string } | { type: "command", command: "ask" } | { type: "uiAck", messageId: string, ok: boolean, message?: string }} ExtensionToWebviewMessage
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label */
function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

/** @param {unknown} value @param {string} label */
function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** @param {unknown} value @param {string} label */
function optionalString(value, label) {
  if (value == null) return undefined;
  return requireString(value, label);
}

/** @param {Record<string, unknown>} message @param {readonly string[]} allowed @param {string} label */
function requireOnlyKeys(message, allowed, label) {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(message).filter((key) => !allowedSet.has(key));
  if (unexpected.length) throw new TypeError(`${label} has unsupported keys: ${unexpected.join(", ")}`);
}

/** @param {unknown} value @param {string} label */
function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

/** @param {unknown} raw @returns {WebviewToExtensionMessage} */
export function validateWebviewMessage(raw) {
  const message = requireRecord(raw, "webview message");
  const type = requireString(message.type, "webview message type");
  if (type === "ready") {
    requireOnlyKeys(message, ["type"], "webview ready message");
    return { type };
  }
  if (type !== "uiEvent" || !WEBVIEW_MESSAGE_TYPES.has(type)) throw new TypeError(`Unsupported webview message: ${type}`);
  requireOnlyKeys(message, ["type", "event", "message_id"], "webview ui event message");
  const event = requireRecord(message.event, "webview ui event");
  requireString(event.type, "webview ui event type");
  const messageId = optionalString(message.message_id, "webview message_id");
  return messageId ? { type, event, messageId } : { type, event };
}

/** @param {unknown} raw @returns {ExtensionToWebviewMessage} */
export function validateExtensionMessage(raw) {
  const message = requireRecord(raw, "extension message");
  const type = requireString(message.type, "extension message type");
  if (type === "error") {
    requireOnlyKeys(message, ["type", "message"], "extension error message");
    return { type, message: requireString(message.message, "extension error message") };
  }
  if (type === "command") {
    requireOnlyKeys(message, ["type", "command"], "extension command message");
    const command = requireString(message.command, "extension command");
    if (command !== "ask") throw new TypeError(`Unsupported extension command: ${command}`);
    return { type, command };
  }
  if (type === "uiAck") {
    requireOnlyKeys(message, ["type", "message_id", "messageId", "ok", "message"], "extension ui ack message");
    const messageId = requireString(message.message_id ?? message.messageId, "extension ui ack message_id");
    const ok = requireBoolean(message.ok, "extension ui ack ok");
    const text = optionalString(message.message, "extension ui ack message");
    return text ? { type: "uiAck", messageId, ok, message: text } : { type: "uiAck", messageId, ok };
  }
  if (type !== "hydrate" || !EXTENSION_MESSAGE_TYPES.has(type)) throw new TypeError(`Unsupported extension message: ${type}`);
  requireOnlyKeys(message, ["type", "hydration", "readonly"], "extension hydrate message");
  const hydration = requireRecord(message.hydration, "extension hydration");
  requireString(hydration.session_id, "hydration session_id");
  requireString(hydration.hole_id, "hydration hole_id");
  requireString(hydration.root_id, "hydration root_id");
  if (!Array.isArray(hydration.nodes)) throw new TypeError("hydration nodes must be an array");
  return { type, hydration, readonly: message.readonly === true };
}

/** @param {WebviewToExtensionMessage} message */
export function serializeWebviewMessage(message) {
  return validateWebviewMessage(message);
}

/** @param {ExtensionToWebviewMessage} message */
export function serializeExtensionMessage(message) {
  return validateExtensionMessage(message);
}
