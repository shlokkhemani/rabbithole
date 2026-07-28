import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState } from "../../src/core/document-state.js";
import { buildRunContext } from "../../src/extension/agent/context-builder.js";

test("selected-node context includes lineage, origin, evidence, and parent run", () => {
  const document = documentLike({
    nodes: [
      node("root", null, "Root", "Root markdown"),
      node("child", "root", "Child", "Child markdown", {
        origin: { question: "Why?", selected_text: "selected code" },
        evidenceIds: ["ev-1"],
        runId: "run-parent",
      }),
    ],
    evidence: [{
      id: "ev-1",
      sourceId: null,
      sourceType: "git-file",
      stableLocator: { repositoryId: "repo", path: "src/a.js" },
      title: "src/a.js",
      excerpt: "export const value = 1;",
      capturedAt: "2026-07-28T00:00:00.000Z",
      range: null,
      extensions: {},
    }],
    runs: [runSummary("run-parent")],
  });
  const context = buildRunContext(document, {
    prompt: "Explain",
    scope: { type: "node", node_id: "child" },
    model: { contextWindow: 10000 },
    estimateTokens: () => 10,
  });
  assert.equal(context.targetNodeId, "child");
  assert.equal(context.parentRunId, "run-parent");
  assert.deepEqual(context.includedNodeIds, ["root", "child"]);
  assert.deepEqual(context.evidenceIds, ["ev-1"]);
  assert.match(context.projection, /selected code/);
  assert.match(context.projection, /export const value = 1/);
});

test("whole-canvas context is deterministic and omits UI-only view state", () => {
  const document = documentLike({
    viewState: { mode: "canvas", node_id: "root", scroll: 99 },
    nodes: [
      node("root", null, "Root", "Root"),
      node("b", "root", "B", "Second", { position: { x: 10, y: 20 } }),
      node("a", "root", "A", "First", { position: { x: 10, y: 10 } }),
    ],
  });
  const context = buildRunContext(document, {
    prompt: "Summarize",
    scope: { type: "whole_canvas" },
    model: { contextWindow: 10000 },
    estimateTokens: () => 10,
  });
  assert.deepEqual(context.includedNodeIds, ["root", "a", "b"]);
  assert(context.projection.indexOf("Node 2: A") < context.projection.indexOf("Node 3: B"));
  assert.doesNotMatch(context.projection, /scroll/);
});

test("oversized context is refused before a run can mutate the document", () => {
  const document = documentLike({ nodes: [node("root", null, "Root", "x".repeat(1000))] });
  assert.throws(
    () => buildRunContext(document, {
      prompt: "Explain",
      scope: { type: "whole_canvas" },
      model: { contextWindow: 100 },
      estimateTokens: () => 99,
      responseRoomTokens: 2,
    }),
    /too large/,
  );
});

function documentLike(overrides = {}) {
  return {
    state: createDocumentState({
      documentId: "doc",
      title: "Doc",
      rootNodeId: "root",
      viewState: null,
      nodes: [node("root", null, "Root", "")],
      ...overrides,
    }),
  };
}

function node(id, parentId, title, markdown, overrides = {}) {
  return {
    id,
    parentId,
    title,
    markdown,
    position: { x: 0, y: 0 },
    state: "complete",
    read: true,
    ...overrides,
  };
}

function runSummary(id) {
  return {
    id,
    parentRunId: null,
    targetNodeId: "child",
    status: "complete",
    prompt: "Parent",
    profileId: "profile",
    provider: "fake",
    model: "fake",
    endpoint: null,
    startedAt: "2026-07-28T00:00:00.000Z",
    endedAt: "2026-07-28T00:00:01.000Z",
    error: null,
    transcriptPath: `runs/${id}.jsonl`,
    extensions: {},
  };
}
