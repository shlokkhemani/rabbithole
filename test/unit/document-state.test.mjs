import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDocumentState,
  documentStateToHydrationNodes,
  documentStateToPersisted,
  reduceDocumentEvent,
} from "../../src/core/document-state.js";
import {
  NEWER_NORA_DOCUMENT_MESSAGE,
  validateNoraDocument,
} from "../../src/core/document-schema.js";
import { agentRunSummaryFixture } from "../fixtures/contracts/agent-run-fixture.js";
import { noraDocumentFixture } from "../fixtures/contracts/document-fixture.js";
import { evidenceRecordFixture, sourceRecordFixture } from "../fixtures/contracts/evidence-fixture.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const noraCases = JSON.parse(await fs.readFile(path.join(ROOT, "test/fixtures/document-goldens/cases.json"), "utf8"));
const legacyCases = JSON.parse(await fs.readFile(path.join(ROOT, "test/fixtures/reducer-goldens/cases.json"), "utf8"));

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  if (Object.isFrozen(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      deepFreeze(key, seen);
      deepFreeze(entry, seen);
    }
    const rejectMutation = () => { throw new TypeError("Cannot mutate frozen Map"); };
    Object.defineProperties(value, {
      set: { value: rejectMutation },
      delete: { value: rejectMutation },
      clear: { value: rejectMutation },
    });
  } else {
    for (const entry of Object.values(value)) deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}

function summarizeEffects(effects) {
  const out = {};
  if (effects.createdNode) out.createdNodeId = effects.createdNode.id;
  if (effects.createdNodeId) out.createdNodeId = effects.createdNodeId;
  if (effects.answeredNode) out.answeredNodeId = effects.answeredNode.id;
  if (effects.answeredNodeId) out.answeredNodeId = effects.answeredNodeId;
  if (effects.deletedNodeIds) out.deletedNodeIds = effects.deletedNodeIds;
  if (effects.node_id) out.node_id = effects.node_id;
  return out;
}

function minimalDocument(overrides = {}) {
  return {
    documentId: "minimal-doc",
    title: "Minimal",
    rootNodeId: "root",
    nodes: [{ id: "root", title: "Root", markdown: "Body" }],
    ...overrides,
  };
}

for (const testCase of noraCases) {
  const state = createDocumentState(testCase.initial);
  const persisted = documentStateToPersisted(state);
  assert.equal(validateNoraDocument(persisted), true, `${testCase.name}: persisted document validates`);
  assert.equal(persisted.schemaVersion, 1, `${testCase.name}: schema version is fixed`);
  assert.equal(persisted.selectedProfileId, "profile-a", `${testCase.name}: selected profile is persisted`);
  assert.equal(persisted.sources[0].type, "git-file", `${testCase.name}: source records are retained`);
  assert.equal(persisted.evidence[0].excerpt, "export const value = 1;", `${testCase.name}: evidence excerpt is retained`);
  assert.equal(persisted.runs.find((run) => run.id === "run-interrupted").status, "interrupted", `${testCase.name}: interrupted run status is valid persisted data`);
  assert.equal(persisted.nodes.find((node) => node.id === "deep").state, "interrupted", `${testCase.name}: interrupted node status is valid persisted data`);
  assert.deepEqual(persisted.edges.map((edge) => [edge.fromNodeId, edge.toNodeId]), [["root", "rtl"], ["rtl", "deep"], ["root", "wide"]], `${testCase.name}: stable parent-child edges are derived`);

  const hydration = documentStateToHydrationNodes(state);
  assert.equal(hydration.find((node) => node.id === "rtl").status, "pending", `${testCase.name}: running nodes hydrate as renderer-pending`);
  assert.equal(hydration.find((node) => node.id === "rtl").nora_state, "running", `${testCase.name}: Nora node state remains visible to the adapter`);
  assert.equal(hydration.find((node) => node.id === "deep").status, "answered", `${testCase.name}: interrupted partial content hydrates as selectable renderer content`);
}
console.log(`ok document state: ${noraCases.length} Nora document golden fixture validates metadata, edges, and run states`);

{
  const state = createDocumentState(noraDocumentFixture);
  const persisted = documentStateToPersisted(state);
  assert.deepEqual(persisted.sources, [sourceRecordFixture]);
  assert.deepEqual(persisted.evidence, [evidenceRecordFixture]);
  assert.deepEqual(persisted.runs, [agentRunSummaryFixture]);
  assert.equal(persisted.nodes[0].extensions.learn.c8lb3.attempts, 1);
  assert.equal(documentStateToHydrationNodes(state)[1].nora_state, "interrupted");
}
console.log("ok document state: typed Nora contract fixtures are fixed points");

{
  const state = createDocumentState(minimalDocument());
  const event = { type: "selected_profile", profileId: "profile-b" };
  deepFreeze(event);
  const selected = reduceDocumentEvent(state, event);
  assert.equal(selected.state.selectedProfileId, "profile-b");
  assert.equal(selected.state.revision, state.revision + 1);
  const titled = reduceDocumentEvent(selected.state, { type: "document_title", title: "Renamed" });
  assert.equal(titled.state.title, "Renamed");
  const terminal = reduceDocumentEvent(titled.state, { type: "node_state", node_id: "root", state: "cancelled", updated_at: "2026-07-28T11:00:00.000Z" });
  assert.equal(terminal.state.nodes.get("root").state, "cancelled");
  assert.equal(documentStateToHydrationNodes(terminal.state)[0].status, "answered");
  const unchanged = reduceDocumentEvent(terminal.state, { type: "node_state", node_id: "missing", state: "running" });
  assert.strictEqual(unchanged.state, terminal.state);
}
console.log("ok document state: Nora document events are immutable and revisioned");

{
  const state = createDocumentState(minimalDocument({
    sources: [{ ...sourceRecordFixture, id: "source-existing" }],
    evidence: [{ ...evidenceRecordFixture, id: "evidence-existing", sourceId: "source-existing" }],
  }));
  const run = { ...agentRunSummaryFixture, targetNodeId: "root", id: "run-root", status: "complete" };
  const result = reduceDocumentEvent(state, { type: "run_summary", run });
  assert.equal(result.effects.run_id, "run-root");
  assert.equal(result.state.runs.get("run-root").status, "complete");
}
console.log("ok document state: collection events validate against document references");

assert.throws(
  () => createDocumentState({ ...noraDocumentFixture, schemaVersion: 2 }),
  (error) => error?.message === NEWER_NORA_DOCUMENT_MESSAGE,
);
assert.throws(
  () => createDocumentState(minimalDocument({ nodes: [{ id: "root", extensions: { bad: undefined } }] })),
  /must be JSON data/,
);
{
  const state = createDocumentState(minimalDocument());
  assert.throws(() => reduceDocumentEvent(state, { type: "node_state", node_id: "root", state: "lost" }), /state is invalid/);
  assert.equal(state.revision, 0, "failed validation must not mutate the previous state");
  assert.equal(state.nodes.get("root").state, "complete");
}
console.log("ok document state: malformed schema and events reject without mutating the last valid revision");

function legacyInitialToNora(initial, index) {
  const rootNodeId = initial.root_id || initial.nodes?.[0]?.id || `legacy-root-${index}`;
  const nodes = Array.isArray(initial.nodes) && initial.nodes.length
    ? initial.nodes
    : [{ id: rootNodeId, title: "Root", markdown: "" }];
  return createDocumentState({
    documentId: initial.hole_id || `legacy-${index}`,
    title: initial.title || "Untitled",
    rootNodeId,
    createdAt: initial.created_at ?? null,
    viewState: initial.view_state ?? null,
    nodes,
  });
}

function assertExpectedHydrationSubset(testCase, actualState) {
  const hydrationById = new Map(documentStateToHydrationNodes(actualState).map((node) => [node.id, node]));
  assert.equal(actualState.title, testCase.expected.title, `${testCase.name}: title`);
  assert.equal(actualState.rootNodeId, testCase.expected.root_id, `${testCase.name}: root id`);
  assert.deepEqual(actualState.viewState, testCase.expected.view_state, `${testCase.name}: view state`);
  for (const expectedNode of testCase.expected.nodes) {
    const actual = hydrationById.get(expectedNode.id);
    assert(actual, `${testCase.name}: expected node ${expectedNode.id}`);
    for (const [key, value] of Object.entries(expectedNode)) {
      if (key === "created_at") continue;
      if (key === "base_url_source" && value === "document") continue;
      if (Object.prototype.hasOwnProperty.call(actual, key)) {
        assert.deepEqual(actual[key], value, `${testCase.name}: node ${expectedNode.id}.${key}`);
      }
    }
  }
}

for (let index = 0; index < legacyCases.length; index += 1) {
  const testCase = legacyCases[index];
  let noraState = legacyInitialToNora(testCase.initial, index);
  let noraEffects = {};
  let noraError = null;
  try {
    for (const step of testCase.events) {
      deepFreeze(noraState);
      deepFreeze(step.event);
      ({ state: noraState, effects: noraEffects } = reduceDocumentEvent(noraState, step.event, step.options));
    }
  } catch (error) {
    noraError = error;
  }

  if (testCase.expected_error) {
    assert.equal(noraError?.message, testCase.expected_error, `${testCase.name}: Nora adapter preserves expected error`);
    continue;
  }
  assert.equal(noraError, null, `${testCase.name}: Nora reducer must not fail`);
  assertExpectedHydrationSubset(testCase, noraState);
  assert.deepEqual(summarizeEffects(noraEffects), summarizeEffects(testCase.expected_effects), `${testCase.name}: effects`);
  assert.equal(validateNoraDocument(documentStateToPersisted(noraState)), true, `${testCase.name}: Nora state stays valid`);
}
console.log(`ok document state: ${legacyCases.length} renderer-event goldens are pinned through the Nora reducer adapter`);
