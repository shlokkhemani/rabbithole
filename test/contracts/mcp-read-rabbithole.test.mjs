/** @protects read_rabbithole selectors, disk/live delivery state, normalization, and file-root context contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-read-contract-"));

const { openRabbithole, sendToRabbithole } = await import("../../src/node/rabbithole.js");
const { closeAllSessions, getSession } = await import("../../src/node/sessions.js");
const { defaultFsStore } = await import("../../src/node/fs-store.js");
const { toolDefinitions } = await import("../../src/node/tools/manifest.js");

const readTool = toolDefinitions.find((tool) => tool.name === "read_rabbithole");
assert(readTool, "the MCP manifest exposes read_rabbithole");
assert.doesNotThrow(() => readTool.validateInput({ hole_id: "closed001", node_ids: Array(20).fill("root0001") }));
assert.throws(
  () => readTool.validateInput({ hole_id: "closed001", node_ids: Array(21).fill("root0001") }),
  /at most 20 items/,
);

try {
  await runClosedDiskSelectors();
  await runLiveDeliveryMarking();
  await runFileRootDelivery();
  console.log("ok read_rabbithole: disk/live selectors, copied ids, delivery marking, limits, and file roots");
} finally {
  await closeAllSessions("read_rabbithole_contract_complete");
}

async function runClosedDiskSelectors() {
  const holeId = "closed001";
  const root = documentNode("root0001", null, "Disk root", "Root markdown", "2026-01-01T00:00:00.000Z");
  const child = documentNode("child001", root.id, "Disk child", "Child markdown", "2026-01-02T00:00:00.000Z");
  const docked = {
    ...documentNode("note0001", child.id, "Note", "Disk note content", "2026-01-03T00:00:00.000Z"),
    origin: { kind: "note", selected_text: "Child" },
    view: { docked: true },
  };
  await defaultFsStore.saveHole({
    hole_id: holeId,
    title: "Closed disk hole",
    root_id: root.id,
    created_at: root.created_at,
    view_state: null,
    nodes: [root, child, docked],
  });

  const mapOnly = await readTool.run({ hole_id: ` \"${holeId}\" ` });
  assert.deepEqual(Object.keys(mapOnly), ["hole_id", "title", "map"]);
  assert.deepEqual(mapOnly.map.nodes.map((node) => node.id), [root.id, child.id]);
  assert.deepEqual(mapOnly.map.notes.map((note) => [note.id, note.new]), [[docked.id, true]]);

  const combined = await readTool.run({
    hole_id: ` '${holeId.slice(0, 4)} ${holeId.slice(4)}' `,
    thread_of: ` \"${child.id.slice(0, 5)} ${child.id.slice(5)}\" `,
    node_ids: [`\`${child.id}\``, ` '${root.id}' `],
    notes: true,
  });
  assert.deepEqual(Object.keys(combined), ["hole_id", "title", "map", "thread", "nodes", "notes"]);
  assert.deepEqual(combined.thread.map((node) => node.id), [root.id, child.id]);
  assert.deepEqual(combined.thread[1].notes.map((note) => note.note_id), [docked.id]);
  assert.deepEqual(combined.nodes.map((node) => node.id), [child.id, root.id], "node_ids preserve request order");
  assert.deepEqual(combined.notes.map((note) => note.note_id), [docked.id]);
  assert.equal(combined.map.notes[0].new, true, "disk reads do not create a delivery session");

  const noteThread = await readTool.run({ hole_id: holeId, thread_of: docked.id });
  assert.deepEqual(noteThread.thread.map((node) => node.id), [root.id, child.id, docked.id],
    "thread_of includes the selected node even when it is a note");

  await assert.rejects(() => readTool.run({ hole_id: holeId, thread_of: "missing-node" }), /Node missing-node not found\./);
  await assert.rejects(() => readTool.run({ hole_id: "missing-hole" }), /Hole missing-hole not found\./);
}

async function runLiveDeliveryMarking() {
  const opened = await openRabbithole({ title: "Live read", content: "Live root", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);
  const published = await sendToRabbithole({
    holeId: session.holeId,
    operationId: "live-read-child",
    title: "Published child",
    content: "Published child markdown",
    parentNodeId: session.rootId,
  });
  await session.handleBrowserEvent({
    type: "node_create",
    id: "live-note",
    parent_id: published.node_id,
    markdown: "A note returned inside the read thread.",
    origin: { kind: "note", selected_text: "Published" },
    docked: true,
  });

  const read = await readTool.run({
    hole_id: ` \"${session.holeId}\" `,
    thread_of: ` '${published.node_id}' `,
  });
  assert.deepEqual(read.thread.map((node) => node.id), [session.rootId, published.node_id]);
  assert.equal(read.map.notes.find((note) => note.id === "live-note")?.new, true,
    "the map describes state before this read records its full notes");
  assert(session.delivered.has(published.node_id));

  await session.handleBrowserEvent({
    type: "branch_request",
    request_id: "after-live-read-request",
    node_id: "after-live-read-node",
    parent_id: published.node_id,
    selected_text: "Published",
    question: "Was this lineage delivered?",
  });
  const next = await openRabbithole({ holeId: session.holeId });
  assert.equal(Object.hasOwn(next, "thread"), false, "read_rabbithole marks live thread nodes delivered");
  assert.equal(Object.hasOwn(next, "notes"), false, "notes returned inside a live read are not re-sent unchanged");
  assert.equal(next.map.notes.find((note) => note.id === "live-note")?.new, false);
}

async function runFileRootDelivery() {
  const filePath = path.join(process.env.RABBITHOLE_DIR, "file-root.md");
  await fs.writeFile(filePath, "# File root\n\nThe agent did not receive this through content.", "utf8");
  const opened = await openRabbithole({ title: "File root", filePath, signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);
  assert.equal(session.delivered.has(session.rootId), false);

  await session.handleBrowserEvent({
    type: "branch_request",
    request_id: "file-root-request",
    node_id: "file-root-node",
    parent_id: session.rootId,
    selected_text: "File root",
    question: "What did the file say?",
  });
  const branch = await openRabbithole({ holeId: session.holeId });
  assert.deepEqual(branch.thread, [{
    id: session.rootId,
    title: "File root",
    markdown: "# File root\n\nThe agent did not receive this through content.",
    notes: [],
  }], "a root opened through file_path is auto-sent on the first ask");
}

function abortAfter(ms = 25) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function documentNode(id, parent_id, title, markdown, created_at) {
  return {
    id, parent_id, title, markdown, base_url: null, base_url_source: null, origin: null,
    position: { x: 0, y: 0 }, size: null, font_scale: 1, collapsed: false,
    status: "answered", read: true, created_at,
  };
}
