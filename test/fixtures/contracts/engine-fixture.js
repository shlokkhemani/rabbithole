/** @typedef {import("../../../src/core/contracts/engine.js").DocEvent} DocEvent */
/** @typedef {import("../../../src/core/contracts/engine.js").HoleState} HoleState */

/** @type {HoleState} */
export const holeStateFixture = {
  hole_id: "typed-engine",
  title: "Typed engine",
  root_id: "root",
  created_at: null,
  view_state: null,
  nodes: new Map([["root", { id: "root", markdown: "Body" }]]),
};

/** @type {DocEvent[]} */
export const docEventFixtures = [
  { type: "branch_request", parent_id: "root", node_id: "child", question: "Why?" },
  { type: "node_progress", node_id: "root", markdown: "Partial", run: { id: "run", seq: 1 } },
  { type: "node_answered", node_id: "root", title: "Done", markdown: "Answer" },
  { type: "delete_node", node_id: "child" },
  { type: "node_deleted", node_ids: ["child"] },
  { type: "node_update", node_id: "root", collapsed: true },
  { type: "nodes_update", nodes: [{ node_id: "root", read: true }] },
  { type: "view_state", state: { mode: "canvas" } },
  { type: "hole_title", title: "New title" },
  { type: "node_origin", node_id: "root", origin: { source: "fixture" } },
];
