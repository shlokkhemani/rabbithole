/** @protects branch context payload ceilings across the portable corpus and a 50-node note-heavy hole. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isNoteNode } from "../../src/core/hole/ask.js";
import { lineageNodesFromMap } from "../../src/core/hole/tree.js";
import { RabbitholeSession } from "../../src/node/transport/session.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-context-budget-"));

const corpusDir = new URL("../fixtures/corpus/", import.meta.url);
const fixtureNames = (await fs.readdir(corpusDir)).filter((name) => name.endsWith(".rabbithole")).sort();
const cases = [];
for (const name of fixtureNames) {
  const payload = JSON.parse(await fs.readFile(new URL(name, corpusDir), "utf8"));
  cases.push({ name, hole: payload.hole });
}
cases.push({ name: "synthesized-50-node-hole", hole: synthesizedHole() });

let synthesizedMetrics = null;
for (const [caseIndex, { name, hole }] of cases.entries()) {
  const session = await coldSession(hole);
  try {
    const parent = deepestAnsweredNode(session.nodes, session.rootId);
    const first = await fireBranch(session, parent.id, `a${caseIndex.toString(36)}`, "First budget ask");
    const firstSize = JSON.stringify(first).length;
    assert(firstSize < 8000, `${name}: first branch delivery is ${firstSize} chars`);
    assert(first.thread?.length, `${name}: a cold first delivery carries the undelivered lineage`);
    assertForbiddenPayloadFields(first, `${name} first delivery`);

    const second = await fireBranch(session, parent.id, `b${caseIndex.toString(36)}`, "Sibling budget ask");
    const secondSize = JSON.stringify(second).length;
    assert(secondSize < 8000, `${name}: sibling branch delivery is ${secondSize} chars`);
    assert.equal(Object.hasOwn(second, "thread"), false, `${name}: the sibling reuses the delivered lineage`);
    assertForbiddenPayloadFields(second, `${name} second delivery`);

    if (name === "synthesized-50-node-hole") {
      const mapJson = JSON.stringify(first.map);
      const mapSize = mapJson.length;
      assert(mapSize < 4000, `50-node map is ${mapSize} chars`);
      for (const node of hole.nodes.filter((node) => node.status !== "pending" && !isNoteNode(node))) {
        assert(first.map.nodes.some((entry) => entry.id === node.id), `50-node map contains answered node ${node.id}`);
      }
      for (const note of hole.nodes.filter(isNoteNode)) {
        assert(first.map.notes.some((entry) => entry.id === note.id), `50-node map contains note ${note.id}`);
      }
      synthesizedMetrics = { first: firstSize, second: secondSize, map: mapSize };
    }
  } finally {
    await session.close("context_budget_complete");
  }
}

assert(synthesizedMetrics);
console.log(`ok context budget: ${fixtureNames.length} corpus holes + synthesized; first=${synthesizedMetrics.first}, second=${synthesizedMetrics.second}, map=${synthesizedMetrics.map}`);

async function coldSession(hole) {
  const session = new RabbitholeSession({
    holeId: hole.hole_id,
    title: hole.title,
    rootId: hole.root_id,
    createdAt: hole.created_at,
    nodes: hole.nodes,
    viewState: hole.view_state ?? null,
    isResume: true,
    deliveredNodeIds: [],
    renderPage: () => "",
  });
  // Saved asks are intentionally ordinary pending map nodes. This contract is
  // measuring two newly fired siblings, so discard only their automatic queue
  // records after the resume constructor has finished requeueing them.
  await new Promise((resolve) => setImmediate(resolve));
  session.queue.length = 0;
  for (const record of session.requests.records()) {
    record.inFlight = null;
    record.delegated = true;
  }
  return session;
}

async function fireBranch(session, parentId, suffix, question) {
  const nodeId = uniqueId(session.nodes, suffix);
  const requestId = `r${nodeId}`;
  await session.handleBrowserEvent({
    type: "branch_request",
    request_id: requestId,
    node_id: nodeId,
    parent_id: parentId,
    selected_text: "",
    question,
  });
  const event = await session.waitForEvent();
  assert.equal(event.request_id, requestId);
  return event;
}

function deepestAnsweredNode(nodes, rootId) {
  const answered = [...nodes.values()].filter((node) => node.status !== "pending" && !isNoteNode(node));
  return answered.sort((a, b) => lineageNodesFromMap(nodes, b.id).length - lineageNodesFromMap(nodes, a.id).length
    || String(a.created_at || "").localeCompare(String(b.created_at || ""))
    || String(a.id).localeCompare(String(b.id)))[0] || nodes.get(rootId);
}

function uniqueId(nodes, seed) {
  let id = seed;
  while (nodes.has(id)) id += "x";
  return id;
}

function assertForbiddenPayloadFields(event, label) {
  const json = JSON.stringify(event);
  for (const forbidden of ["extensions", "attempts", "rehydration", "saved_asks"]) {
    assert.equal(json.includes(forbidden), false, `${label} omits ${forbidden}`);
  }
}

function synthesizedHole() {
  const nodes = [];
  const answeredIds = Array.from({ length: 50 }, (_, index) => index.toString(36));
  for (let index = 0; index < answeredIds.length; index += 1) {
    const id = answeredIds[index];
    const parentId = index === 0 ? null : answeredIds[Math.floor((index - 1) / 7)];
    nodes.push(documentNode(id, parentId, "N", `Node ${index}: ${"x".repeat(190)}`, `d${index.toString(36)}`));
  }
  for (let index = 0; index < 12; index += 1) {
    const standalone = index < 6;
    nodes.push({
      ...documentNode(`n${index.toString(36)}`, standalone ? null : answeredIds[index], "N", standalone ? " ".repeat(300) : "👍".repeat(150), `n${index.toString(36)}`),
      origin: {
        kind: "note",
        ...(standalone ? {} : { instruction: `R${index}` }),
      },
      view: standalone ? {} : { docked: true, reaction: true },
    });
  }
  for (let index = 0; index < 3; index += 1) {
    nodes.push({
      ...documentNode(`p${index}`, answeredIds[index], "P", "", `p${index}`),
      status: "pending",
      origin: { selected_text: "", question: `Pending ${index}`, lens: null, anchor: null, branch_type: "followup" },
    });
  }
  return {
    hole_id: "budget50",
    title: "Budget",
    root_id: answeredIds[0],
    created_at: "d0",
    view_state: null,
    nodes,
  };
}

function documentNode(id, parent_id, title, markdown, created_at) {
  return {
    id, parent_id, title, markdown, base_url: null, base_url_source: null, origin: null,
    position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false,
    status: "answered", read: true, created_at,
  };
}
