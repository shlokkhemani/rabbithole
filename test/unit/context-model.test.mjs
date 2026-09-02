/** @protects compact context map, deterministic tree order, thread, and delta-note contracts. */
import assert from "node:assert/strict";
import { buildMap, buildThread, buildUndeliveredThread, collectBranchNotes, collectNewNotes } from "../../src/core/hole/context.js";
import { depthFirstNodes } from "../../src/core/hole/tree.js";

const nodes = new Map([
  ["late", node("late", "root", "Late", "2026-01-03")],
  ["standalone-note", note("standalone-note", null, "A  standalone\n note that is deliberately longer than sixty characters for preview clipping.", "2026-01-09")],
  ["root", node("root", null, "Root", "2026-01-01")],
  ["nested", node("nested", "early", "Nested", "2026-01-04")],
  ["early", node("early", "root", "Early", "2026-01-02")],
  ["docked-note", note("docked-note", "early", "👍", "2026-01-05", { instruction: "Prefer the precise proof." }, { docked: true, reaction: true })],
  ["orphan", node("orphan", null, "Orphan", "2026-01-06")],
  ["pending", node("pending", "orphan", "Pending", "2026-01-07", "pending")],
]);

assert.deepEqual(
  depthFirstNodes(nodes, "root").map((entry) => entry.id),
  ["root", "early", "nested", "docked-note", "late", "orphan", "pending", "standalone-note"],
  "depth-first order starts at the root, sorts siblings by age, and appends parentless canvas nodes",
);

const noteHashes = new Map([["standalone-note", "standalone-v1"], ["docked-note", "reaction-v1"]]);
const deliveredNoteHashes = new Map([["docked-note", "reaction-v1"]]);
const map = buildMap(Object.fromEntries(nodes), "root", { noteHashes, deliveredNoteHashes });
assert.deepEqual(map.nodes.map((entry) => entry.id), ["root", "early", "nested", "late", "orphan", "pending"]);
assert.deepEqual(map.nodes.at(-1), { id: "pending", parent: "orphan", title: "Pending", status: "pending" });
assert.deepEqual(map.notes, [
  {
    id: "standalone-note",
    on: null,
    preview: "A standalone note that is deliberately longer than sixty cha",
    new: true,
  },
  { id: "docked-note", on: "early", preview: "Prefer the precise proof.", new: false },
]);

assert.deepEqual(collectBranchNotes(nodes, "early", { noteHashes, deliveredNoteHashes }).map((entry) => entry.note_id), [
  "standalone-note",
], "only new non-lineage notes ship in full");
assert.deepEqual(collectNewNotes(nodes, { noteHashes, deliveredNoteHashes }).map((entry) => entry.note_id), ["standalone-note"]);
assert.deepEqual(buildThread(nodes, "nested"), [
  { id: "root", title: "Root", markdown: "Root markdown", notes: [] },
  {
    id: "early",
    title: "Early",
    markdown: "Early markdown",
    notes: [{
      note_id: "docked-note",
      on_node_id: "early",
      on_selected_text: null,
      content: "Prefer the precise proof.",
      created_at: "2026-01-05",
    }],
  },
  { id: "nested", title: "Nested", markdown: "Nested markdown", notes: [] },
]);

assert.deepEqual(
  buildUndeliveredThread(nodes, "nested", { delivered: new Set(["root", "nested"]) }).map((entry) => entry.id),
  ["early"],
  "only lineage nodes never delivered travel as thread; delivered ancestors are skipped",
);
assert.deepEqual(buildUndeliveredThread(nodes, "nested", { delivered: new Set(["root", "early", "nested"]) }), []);
assert.deepEqual(
  buildUndeliveredThread(nodes, "docked-note", { delivered: new Set(["root"]) }).map((entry) => entry.id),
  ["early"],
  "note nodes on the lineage ride as on_lineage notes, never as thread entries",
);
assert.deepEqual(
  buildUndeliveredThread(nodes, "pending", { delivered: new Set() }).map((entry) => entry.id),
  ["orphan"],
  "pending nodes have no markdown to deliver",
);

const budgeted = buildUndeliveredThread(nodes, "nested", { delivered: new Set(), budget: 140 });
assert.deepEqual(budgeted.map((entry) => [entry.id, entry.omitted === true]), [["root", false], ["early", true], ["nested", false]],
  "the budget admits nearest-first, skips an entry that does not fit, and keeps root→node order");
assert.deepEqual(budgeted[1], { id: "early", title: "Early", chars: "Early markdown".length, omitted: true });
assert.equal(budgeted[2].markdown, "Nested markdown");

console.log("ok context model: deterministic DFS, compact map, reaction preview, thread, and note deltas");

/** @returns {any} */
function node(id, parent_id, title, created_at, status = "answered") {
  return { id, parent_id, title, markdown: `${title} markdown`, status, created_at, origin: null };
}

/** @returns {any} */
function note(id, parent_id, markdown, created_at, origin = {}, view = {}) {
  return { id, parent_id, title: "Note", markdown, status: "answered", created_at, origin: { kind: "note", ...origin }, view };
}
