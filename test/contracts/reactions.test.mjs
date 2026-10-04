/** @protects reaction notes as ordinary notes across context and artifact projections. */
import assert from "node:assert/strict";
import { collectRelevantNotes } from "../../src/core/hole/ask.js";
import { makeNode } from "../../src/core/hole/node.js";
import { DEFAULT_REACTION_PROMPTS } from "../../src/core/hole/reaction.js";
import { createPortableProjection } from "../../src/core/portable-projection.js";
import { buildAnswerMessages } from "../../src/core/prompts/answering-v1.js";
import { parsePersistedHole, toPersistedHole } from "../../src/core/schema.js";
import { createSnapshotProjection } from "../../src/core/snapshot-projection.js";

const root = makeNode({ id: "root", parent_id: null, title: "Root", markdown: "A marked passage lives here." });
const reaction = makeNode({
  id: "reaction",
  parent_id: "root",
  title: "Note",
  markdown: "👍",
  origin: {
    kind: "note",
    selected_text: "marked passage",
    anchor: { offset_start: 2, offset_end: 16 },
    branch_type: "selection",
    instruction: "Keep the crisp example and concrete opening.",
  },
  read: true,
  created_at: "2026-08-31T00:00:00.000Z",
  view: { docked: true, reaction: true },
});
const persisted = toPersistedHole({
  hole_id: "reaction-contract",
  title: "Reaction contract",
  root_id: "root",
  created_at: "2026-08-31T00:00:00.000Z",
  view_state: null,
  nodes: [root, reaction],
}, { updatedAt: "2026-08-31T00:00:01.000Z" });
const roundTrip = parsePersistedHole(JSON.parse(JSON.stringify(persisted)));
const storedReaction = roundTrip.nodes.find((node) => node.id === "reaction");
assert.deepEqual(storedReaction.extensions, { note: { docked: true, reaction: true } },
  "reaction presentation round-trips through hole JSON in the open extensions bag");
assert.deepEqual(storedReaction.origin, reaction.origin, "reaction identity remains an ordinary anchored note origin");
assert.equal(storedReaction.markdown, "👍", "the complete reaction markdown is exactly the glyph");

const notes = collectRelevantNotes(new Map(roundTrip.nodes.map((node) => [node.id, node])), "root");
assert.deepEqual(notes, [{
  note_id: "reaction",
  on_node_id: "root",
  on_selected_text: "marked passage",
  content: "Keep the crisp example and concrete opening.",
  created_at: "2026-08-31T00:00:00.000Z",
}], "agent context collects a reaction through the unchanged note path");
const prompt = buildAnswerMessages({
  root_title: "Root",
  parent_id: "root",
  parent_title: "Root",
  parent_markdown: root.markdown,
  ancestors: [],
  selected_text: "another passage",
  question: "What now?",
  notes,
})[1].content;
assert.equal(prompt.split("\n").find((line) => line.startsWith("- Human:")),
  '- Human: Anchored to "marked passage": Keep the crisp example and concrete opening.',
  "the shared note projection substitutes the configured instruction before prompt assembly");

for (const { label, projection } of [
  { label: "portable", projection: createPortableProjection(roundTrip, {}) },
  { label: "snapshot", projection: createSnapshotProjection(roundTrip, null, {}) },
]) {
  const projected = projection.hole.nodes.find((node) => node.id === "reaction");
  assert.ok(projected, `${label} projection carries the reaction note node`);
  assert.deepEqual(projected.extensions, { note: { docked: true, reaction: true } },
    `${label} projection carries reaction presentation only in extensions.note`);
  assert.equal(Object.hasOwn(projected, "reaction"), false, `${label} projection adds no reaction-specific node field`);
  assert.equal(Object.hasOwn(projected.origin, "reaction"), false, `${label} projection adds no reaction-specific origin field`);
}

console.log("ok reaction contracts: glyph persistence, configured context, portable, and snapshot");
