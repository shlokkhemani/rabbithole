/** @protects live node work-state projection capability contracts. */
import assert from "node:assert/strict";
import { applyServerEvent } from "../../src/ui/store/apply-server-event.js";

const node = {
  id: "pending-node",
  status: "pending",
  title: "Pending",
  markdown: "",
  delegated: false,
  queued: false,
  extensions: {},
};
const store = { nodes: { [node.id]: node } };

let result = applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "queued",
});
assert.equal(node.queued, true, "queued work state marks the pending node as waiting");
assert.equal(node.delegated, false, "queued work is not delegated");
assert.equal(result.invalidated.has("status"), true, "queued work state invalidates the status surface");

applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "delegated",
});
assert.equal(node.queued, false, "delegation clears queued state");
assert.equal(node.delegated, true, "delegated work state still marks delegation");

result = applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "drawing",
});
assert.equal(node.drawing, true, "drawing work state marks the pending node as drawing");
assert.equal(node.queued, false, "drawing work is not queued");
assert.equal(node.delegated, false, "drawing work is not delegated");
assert.equal(result.invalidated.has("status"), true, "drawing work state invalidates the status surface");

applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "thinking",
});
assert.equal(node.drawing, false, "thinking clears drawing state");

applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "queued",
});
applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "thinking",
});
assert.equal(node.queued, false, "delivery clears queued state through the thinking work state");
assert.equal(node.delegated, false, "thinking work is not delegated");

applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "drawing",
});
result = applyServerEvent(store, {
  type: "node_progress",
  node_id: node.id,
  markdown: "Streaming",
});
assert.equal(node.drawing, false, "streaming progress clears drawing state");
assert.equal(result.invalidated.has("stream"), true);

applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "queued",
});
result = applyServerEvent(store, {
  type: "node_progress",
  node_id: node.id,
  markdown: "Still streaming",
});
assert.equal(node.queued, false, "streaming progress clears queued state");
assert.equal(node.delegated, false, "streaming progress clears delegated state");

applyServerEvent(store, {
  type: "node_work_state",
  node_id: node.id,
  state: "drawing",
});
result = applyServerEvent(store, {
  type: "node_answered",
  node_id: node.id,
  title: "Answered",
  markdown: "Complete",
});
assert.equal(node.drawing, false, "completion clears drawing state");
assert.equal(node.queued, false, "completion clears queued state");
assert.equal(node.delegated, false, "completion clears delegated state");
assert.equal(node.status, "answered");
assert.equal(result.invalidated.has("status"), true);

const answered = {
  id: "answered-node",
  status: "answered",
  title: "Answered",
  markdown: "Complete",
  delegated: false,
  queued: false,
  drawing: false,
  extensions: {},
};
store.nodes[answered.id] = answered;
result = applyServerEvent(store, {
  type: "node_work_state",
  node_id: answered.id,
  state: "drawing",
});
assert.equal(answered.drawing, false, "work-state changes apply only to pending nodes");
assert.equal(result.invalidated.has("status"), false, "ignored work-state changes do not invalidate status");

console.log("ok apply server event: queued and drawing states reset with the pending-node lifecycle");
