import assert from "node:assert/strict";
import { DirectRabbitholeHost } from "../../src/web/transport/direct-host.js";

const hole = (nodes) => ({ hole_id: "gc", title: "GC", root_id: "root", nodes: [{ id: "root", parent_id: null, markdown: "root", status: "answered", extensions: {} }, ...nodes] });
const sha256 = "ab".repeat(32);
const sourceAsset = `pdf-${sha256}.pdf`;
const pdfNode = (id = "pdf") => ({ id, parent_id: "root", markdown: "plain text", status: "answered", extensions: { pdf: { version: 2, source: { asset: sourceAsset, sha256, byte_length: 4 } } } });
function storeFixture() {
  const assets = new Map([
    [sourceAsset, new Blob(["%PDF"], { type: "application/pdf" })],
    ["crop-clip.jpg", new Blob(["crop"], { type: "image/jpeg" })],
  ]);
  return { assets, async saveHole() {}, async getAsset(_h, n) { return assets.get(n) || null; }, async putAsset(_h, n, b) { assets.set(n, b); }, async deleteAsset(_h, n) { assets.delete(n); } };
}

{
  const store = storeFixture();
  const clip = { id: "clip", parent_id: "root", markdown: "clean answer", status: "answered", origin: { crop_asset: "crop-clip.jpg" }, extensions: {} };
  const host = new DirectRabbitholeHost({ store, hole: hole([clip]) });
  await host.handleDeleteNode({ node_id: "clip" });
  assert.equal(store.assets.has("crop-clip.jpg"), false, "deleting a clip owner removes its crop asset");
}

{
  const store = storeFixture(); const host = new DirectRabbitholeHost({ store, hole: hole([pdfNode()]) });
  await host.handleDeleteNode({ node_id: "pdf" }); assert.equal(store.assets.has(sourceAsset), false);
}
{
  const store = storeFixture();
  const sibling = pdfNode("sibling");
  const host = new DirectRabbitholeHost({ store, hole: hole([pdfNode(), sibling]) });
  await host.handleDeleteNode({ node_id: "pdf" }); assert.equal(store.assets.has(sourceAsset), true);
}
{
  const store = storeFixture(); let undo;
  const host = new DirectRabbitholeHost({ store, hole: hole([pdfNode()]), onToast: (toast) => { undo = toast.onAction; } });
  await host.handleDeleteNode({ node_id: "pdf" }); assert.equal(store.assets.has(sourceAsset), false);
  await undo(); assert.equal(store.assets.has(sourceAsset), true);
}
console.log("ok PDF v2 GC: source deletion candidates, shared references, and undo use one reference extractor");

{
  const store = storeFixture(); const host = new DirectRabbitholeHost({ store, hole: hole([]) });
  const messages = []; const adapter = host.adapter(); adapter.connect({ onMessage: (event) => messages.push(event) });
  await host.handleBrowserEvent({ type: "node_extensions_patch", node_id: "root", namespace: "pdf", value: { version: 2 } });
  assert.deepEqual(host.state.nodes.get("root").extensions.pdf, { version: 2 });
  assert(messages.some((event) => event.type === "node_extensions_patch"));
}
