/** @protects Shared engine state, persistence, and asset GC parity across the MCP and web host adapters. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-host-parity-"));
process.env.RABBITHOLE_NO_BROWSER = "1";

const [{ RabbitholeSession }, { defaultFsStore }, { DirectRabbitholeHost }] = await Promise.all([
  import("../../src/node/mcp/hole-session/session.js"),
  import("../../src/node/mcp/store/fs-store.js"),
  import("../../src/web/transport/direct-host.js"),
]);
const { toPersistedHole } = await import("../../src/core/schema.js");

const root = {
  id: "root", parent_id: null, title: "Root", markdown: "Root", base_url: null,
  base_url_source: null, origin: null, position: { x: 0, y: 0 }, size: { w: 720, h: 640 },
  font_scale: 1, collapsed: false, status: "answered", read: false, created_at: null,
};
const hole = { hole_id: "host-parity", title: "Host parity", root_id: "root", created_at: "2026-08-29T00:00:00.000Z", view_state: null, nodes: [root] };

class MemoryStore {
  constructor() { this.hole = null; this.assets = new Map(); }
  async saveHole(value) { this.hole = toPersistedHole(value, { updatedAt: "2026-08-29T00:00:01.000Z" }); }
  async putAsset(_holeId, name, bytes) { this.assets.set(name, bytes); }
  async getAsset(_holeId, name) { return this.assets.get(name) || null; }
  async deleteAsset(_holeId, name) { this.assets.delete(name); }
  async listAssets() { return [...this.assets.keys()].sort(); }
}

const webStore = new MemoryStore();
const web = new DirectRabbitholeHost({ store: webStore, hole });
const mcp = new RabbitholeSession({
  holeId: hole.hole_id, title: hole.title, rootId: hole.root_id, createdAt: hole.created_at,
  nodes: hole.nodes, assetNames: [], viewState: hole.view_state, isResume: false,
  renderPage: () => "", onClose: () => {}, onContextClose: () => {}, mintRunId: () => "parity-run",
});

const assetName = "paste-parity.png";
await webStore.putAsset(hole.hole_id, assetName, new Uint8Array([1, 2, 3]));
await defaultFsStore.putAsset(hole.hole_id, assetName, Buffer.from([1, 2, 3]));
mcp.assetNames.add(assetName);

const events = [
  { type: "node_create", id: "note", parent_id: null, title: "Parity note",
    markdown: `![Parity](asset:${assetName})`, origin: { kind: "note" },
    position: { x: 40, y: 60 }, size: { w: 300, h: 180 } },
  { type: "node_update", node_id: "note", title: "Renamed parity note", position: { x: 80, y: 120 }, size: { w: 340, h: 220 } },
  { type: "node_extensions_patch", node_id: "note", namespace: "canvas", value: { pin: { x: 9, y: 10, scale: 1 } } },
  { type: "view_state", state: { node_id: "note", view: { x: 3, y: 4, scale: 0.9 } } },
  { type: "delete_node", node_id: "note" },
];

for (const event of events) {
  assert.equal((await web.handleBrowserEvent(structuredClone(event))).ok, true);
  assert.equal((await mcp.handleBrowserEvent(structuredClone(event))).ok, true);
}
await Promise.all([web.flushSave(), mcp.flushSave()]);

const mcpHole = await defaultFsStore.loadHole(hole.hole_id);
const stableEnvelope = (value) => ({ ...value, updated_at: null });
assert.deepEqual(stableEnvelope(webStore.hole), stableEnvelope(mcpHole),
  "both adapters must persist the identical schema-v2 Rabbithole apart from their wall-clock write stamp");
assert.deepEqual(await webStore.listAssets(), await defaultFsStore.listAssets(hole.hole_id), "both adapters must retain identical asset names");
assert.deepEqual(await webStore.listAssets(), [], "deleting the final reference must collect the same asset in both hosts");

await web.dispose();
await mcp.close("host_parity_complete");
console.log("ok host parity: one browser-event script produces identical holes and asset names in both adapters");
