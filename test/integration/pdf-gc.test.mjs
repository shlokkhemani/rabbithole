import assert from "node:assert/strict";
import { DirectRabbitholeHost } from "../../src/web/transport/direct-host.js";

const hole = (nodes) => ({ hole_id: "gc", title: "GC", root_id: "root", nodes: [{ id: "root", parent_id: null, markdown: "root", status: "answered", extensions: {} }, ...nodes] });
const pdfNode = () => ({ id: "pdf", parent_id: "root", markdown: "plain text", status: "answered", extensions: { pdf: { pages: [{ asset: "page-001.jpg" }] } } });
function storeFixture() {
  const assets = new Map([["page-001.jpg", new Blob(["jpeg"], { type: "image/jpeg" })]]);
  return { assets, async saveHole() {}, async getAsset(_h, n) { return assets.get(n) || null; }, async putAsset(_h, n, b) { assets.set(n, b); }, async deleteAsset(_h, n) { assets.delete(n); } };
}

{
  const store = storeFixture(); const host = new DirectRabbitholeHost({ store, hole: hole([pdfNode()]) });
  await host.handleDeleteNode({ node_id: "pdf" }); assert.equal(store.assets.has("page-001.jpg"), false);
}
{
  const store = storeFixture();
  const sibling = { id: "sibling", parent_id: "root", markdown: "![shared](asset:page-001.jpg)", status: "answered", extensions: {} };
  const host = new DirectRabbitholeHost({ store, hole: hole([pdfNode(), sibling]) });
  await host.handleDeleteNode({ node_id: "pdf" }); assert.equal(store.assets.has("page-001.jpg"), true);
}
{
  const store = storeFixture(); let undo;
  const host = new DirectRabbitholeHost({ store, hole: hole([pdfNode()]), onToast: (toast) => { undo = toast.onAction; } });
  await host.handleDeleteNode({ node_id: "pdf" }); assert.equal(store.assets.has("page-001.jpg"), false);
  await undo(); assert.equal(store.assets.has("page-001.jpg"), true);
}
console.log("ok PDF GC: deletion candidates, surviving refs, and undo share the node-reference extractor");

{
  const store = storeFixture(); const host = new DirectRabbitholeHost({ store, hole: hole([]) });
  const messages = []; const adapter = host.adapter(); adapter.connect({ onMessage: (event) => messages.push(event) });
  await host.handleBrowserEvent({ type: "node_extensions_patch", node_id: "root", namespace: "pdf", value: { version: 1 } });
  assert.deepEqual(host.state.nodes.get("root").extensions.pdf, { version: 1 });
  assert(messages.some((event) => event.type === "node_extensions_patch"));
}
