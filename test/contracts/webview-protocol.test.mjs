import assert from "node:assert/strict";
import {
  validateExtensionMessage,
  validateWebviewMessage,
} from "../../src/extension/protocol.js";

const hydration = {
  session_id: "session",
  hole_id: "hole",
  root_id: "root",
  nodes: [{ id: "root" }],
};

assert.deepEqual(validateWebviewMessage({ type: "ready" }), { type: "ready" });
assert.deepEqual(
  validateWebviewMessage({ type: "uiEvent", message_id: "msg-1", event: { type: "view_state", state: { mode: "reader" } } }),
  { type: "uiEvent", messageId: "msg-1", event: { type: "view_state", state: { mode: "reader" } } },
);
assert.deepEqual(
  validateExtensionMessage({ type: "hydrate", hydration, readonly: false }),
  { type: "hydrate", hydration, readonly: false },
);
assert.deepEqual(
  validateExtensionMessage({ type: "error", message: "Nope" }),
  { type: "error", message: "Nope" },
);
assert.deepEqual(
  validateExtensionMessage({ type: "command", command: "ask" }),
  { type: "command", command: "ask" },
);
assert.deepEqual(
  validateExtensionMessage({ type: "uiAck", message_id: "msg-1", ok: false, message: "No profile" }),
  { type: "uiAck", messageId: "msg-1", ok: false, message: "No profile" },
);

for (const message of [
  null,
  { type: "wat" },
  { type: "ready", event: [] },
  { type: "uiEvent" },
  { type: "uiEvent", event: { nope: true } },
]) {
  assert.throws(() => validateWebviewMessage(message), /message|event|Unsupported/);
}

for (const message of [
  null,
  { type: "wat" },
  { type: "error", message: "" },
  { type: "command", command: "delete" },
  { type: "uiAck", message_id: "", ok: true },
  { type: "uiAck", message_id: "msg-1", ok: "yes" },
  { type: "hydrate", hydration: {} },
  { type: "hydrate", hydration: { ...hydration, nodes: {} } },
]) {
  assert.throws(() => validateExtensionMessage(message), /message|hydration|Unsupported|boolean/);
}

console.log("ok webview protocol: valid messages pass and malformed discriminants fail");
