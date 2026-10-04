/** @protects filesystem store capability contracts. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { assertRabbitholeStore } from "../../src/core/store.js";
import { FsStore } from "../../src/node/mcp/store/fs-store.js";
import { RabbitholeSession } from "../../src/node/mcp/hole-session/session.js";
import { runStoreContract } from "../support/store-contract.mjs";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-filesystem-store-"));

const store = assertRabbitholeStore(new FsStore());

await runStoreContract(store, {
  readRawHole: async (holeId) => JSON.parse(await fs.readFile(path.join(process.env.RABBITHOLE_DIR, `${holeId}.json`), "utf8")),
  writeRawHole: async (holeId, fixture) => fs.writeFile(path.join(process.env.RABBITHOLE_DIR, `${holeId}.json`), JSON.stringify(fixture, null, 2), "utf8"),
  makeDeleteHost: async ({ root, childA, childB }) => {
    const session = new RabbitholeSession({
      holeId: "gc-hole",
      title: "GC Hole",
      rootId: "root",
      nodes: [root, childA, childB],
      assetNames: new Set(["shared.png"]),
      isResume: false,
      renderPage: () => "",
    });
    return {
      deleteNode: (nodeId) => session.handleDeleteNode({ node_id: nodeId }),
      close: async () => {
        session.close("filesystem_store_test_complete");
        await session.saveChain.flush();
      },
    };
  },
});

{
  const session = new RabbitholeSession({
    holeId: "mcp-note-create",
    title: "MCP note create",
    rootId: "root",
    createdAt: "2026-08-11T00:00:00.000Z",
    nodes: [{ id: "root", parent_id: null, title: "Root", markdown: "Root body", status: "answered" }],
    assetNames: new Set(),
    isResume: false,
    renderPage: () => "",
  });
  const result = await session.handleBrowserEvent({
    type: "node_create",
    id: "standalone-note",
    markdown: "Durable MCP note",
    position: { x: 140, y: -20 },
    origin: { kind: "note" },
  });
  assert.deepEqual(result, { ok: true, node_id: "standalone-note" });
  assert.deepEqual(session.queue, [], "node_create must not queue an agent-facing MCP event");
  assert.equal(session.buildHydration().nodes.find((node) => node.id === "standalone-note")?.parent_id, null, "standalone notes hydrate outside the root tree");
  const saved = await store.loadHole("mcp-note-create");
  assert.equal(saved.nodes.find((node) => node.id === "standalone-note")?.markdown, "Durable MCP note", "MCP node_create must be durable before returning");

  await session.handleBrowserEvent({ type: "delete_node", node_id: "standalone-note" });
  await session.flushSave();
  assert.equal((await store.loadHole("mcp-note-create")).nodes.some((node) => node.id === "standalone-note"), false, "MCP host deletes and persists standalone notes");
  await session.close("filesystem_note_test_complete");
}
console.log("ok filesystem notes: MCP node_create persists and hydrates standalone notes without agent-facing events");

const concurrentBase = { hole_id: "concurrent-hole", root_id: "root", nodes: [{ id: "root", markdown: "body" }] };
await Promise.all([
  store.saveHole({ ...concurrentBase, title: "First" }),
  store.saveHole({ ...concurrentBase, title: "Second" }),
]);
const concurrentHole = await store.loadHole("concurrent-hole");
const concurrentSummary = JSON.parse(await fs.readFile(path.join(process.env.RABBITHOLE_DIR, "concurrent-hole.summary.json"), "utf8"));
assert.equal(concurrentHole.title, "Second");
assert.equal(concurrentSummary.title, concurrentHole.title, "serialized save queue keeps the sidecar atomic with its hole");

console.log("filesystem store contract verification passed");
