import assert from "node:assert/strict";
import { DirectRabbitholeHost, createHoleFromMarkdown } from "../../src/web/transport/direct-host.js";
globalThis.FileReader ||= class { readAsDataURL(blob) { blob.arrayBuffer().then((bytes) => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`; this.onload?.(); }); } };

const ORIGINAL = "# PDF\n\nOriginal body line";
// Real provenance lines, offsets valid against ORIGINAL only — conversion
// replaces the body, so any code that re-normalizes mid-run fails against them.
const fixture = ({ converting = false, markdown = ORIGINAL, pages = 2 } = {}) => {
  const hole = createHoleFromMarkdown({ title: "PDF", markdown });
  hole.nodes[0].extensions.pdf = {
    version: 1, scale: 2, page_count: pages,
    pages: Array.from({ length: pages }, (_, i) => ({ n: i + 1, asset: `page-${String(i + 1).padStart(3, "0")}.jpg`, w: 10, h: 10 })),
    lines: [{ p: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.05, s: 7, e: ORIGINAL.length }],
    notes: [], converting, converted: false, original_markdown: converting ? ORIGINAL : null,
  };
  return hole;
};
const assets = new Map(Array.from({ length: 6 }, (_, i) => [`page-${String(i + 1).padStart(3, "0")}.jpg`, new Blob([`p${i + 1}`], { type: "image/jpeg" })]));
const store = { saveHole: async () => {}, getAsset: async (_id, name) => assets.get(name), listAssets: async () => [...assets.keys()], putAsset: async (_id, name, blob) => assets.set(name, blob) };
const settle = async (predicate) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

// ---- capability gate rejects conversion before starting --------------------
{
  const brain = { async *transcribePages() { throw new Error("must not run"); } };
  const host = new DirectRabbitholeHost({ store, hole: fixture(), brain, getPdfTranscriptionCapability: () => ({ available: false, reason: "Install a local vision model." }) });
  const result = await host.handleBrowserEvent({ type: "convert_pdf", node_id: host.state.root_id });
  assert.deepEqual(result, { ok: false, error: "Install a local vision model." });
  assert.equal(host.state.nodes.get(host.state.root_id).extensions.pdf.converting, false);
}

// ---- streamed commit, converted flag, and stash preservation ---------------
{
  const brain = { async *transcribePages({ pages, tail }) { assert.equal(pages.length, 2); assert.equal(tail, ""); yield { type: "text", delta: "# Converted\n\nFaithful text." }; } };
  const host = new DirectRabbitholeHost({ store, hole: fixture(), brain }), rootId = host.state.root_id, events = [];
  host.onEvent = (event) => events.push(event);
  const start = await host.handleBrowserEvent({ type: "convert_pdf", node_id: rootId });
  assert.equal(start.ok, true, start.error);
  await settle(() => host.state.nodes.get(rootId).extensions.pdf.converted);
  const node = host.state.nodes.get(rootId);
  assert.equal(node.markdown, "# Converted\n\nFaithful text.");
  const pdf = node.extensions.pdf;
  assert.equal(pdf.converted, true);
  assert.equal(pdf.pages.length, 2, "finish must preserve the page stash");
  assert.equal(pdf.lines.length, 1, "finish must preserve the provenance stash");
  assert.equal(pdf.original_markdown, ORIGINAL, "finish must keep the stashed original");
  assert(events.some((event) => event.type === "pdf_convert_progress"));
}

// ---- provider failure mid-run: restore + toast ------------------------------
{
  const brain = { async *transcribePages() { yield { type: "text", delta: "" }; throw new Error("model exploded"); } };
  const toasts = [];
  const host = new DirectRabbitholeHost({ store, hole: fixture(), brain, onToast: (toast) => toasts.push(toast) });
  const rootId = host.state.root_id;
  await host.handleBrowserEvent({ type: "convert_pdf", node_id: rootId });
  await settle(() => toasts.length > 0);
  const node = host.state.nodes.get(rootId);
  assert.equal(node.markdown, ORIGINAL, "failure must restore the original body");
  assert.equal(node.extensions.pdf.converting, false);
  assert.equal(node.extensions.pdf.pages.length, 2, "failure restore must preserve the extension");
  assert.match(toasts[0].message, /PDF conversion failed: model exploded/);
}

// ---- cancel mid-run (after a committed batch): restore, no toast ------------
{
  const brain = { async *transcribePages({ pages }, signal) {
    if (pages[0].n === 1) { yield { type: "text", delta: "# Batch one committed" }; return; }
    await new Promise((_, reject) => { const fail = () => reject(new DOMException("Aborted", "AbortError")); if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true }); });
  } };
  const toasts = [];
  const host = new DirectRabbitholeHost({ store, hole: fixture({ pages: 6 }), brain, onToast: (toast) => toasts.push(toast) });
  const rootId = host.state.root_id;
  await host.handleBrowserEvent({ type: "convert_pdf", node_id: rootId });
  await settle(() => host.state.nodes.get(rootId).markdown.includes("Batch one"));
  assert.equal(host.state.nodes.get(rootId).extensions.pdf.converting, true);
  await host.handleBrowserEvent({ type: "convert_cancel", node_id: rootId });
  await settle(() => !host.state.nodes.get(rootId).extensions.pdf.converting);
  const node = host.state.nodes.get(rootId);
  assert.equal(node.markdown, ORIGINAL, "cancel after a committed batch must restore the original body");
  assert.equal(node.extensions.pdf.converting, false);
  assert.equal(node.extensions.pdf.pages.length, 6, "cancel restore must preserve the extension");
  assert.deepEqual(toasts, [], "a deliberate cancel is not an error");
}

// ---- hydration restore, including a dirty mid-run persisted body -----------
{
  const clean = new DirectRabbitholeHost({ store, hole: fixture({ converting: true }), brain: null });
  assert.equal(clean.state.nodes.get(clean.state.root_id).markdown, ORIGINAL);
  assert.equal(clean.state.nodes.get(clean.state.root_id).extensions.pdf.converting, false);

  const dirty = new DirectRabbitholeHost({ store, hole: fixture({ converting: true, markdown: "# Half-streamed junk" }), brain: null });
  const restored = dirty.state.nodes.get(dirty.state.root_id);
  assert.equal(restored.markdown, ORIGINAL, "hydration must restore even when the persisted body is the mid-run stream");
  assert.equal(restored.extensions.pdf.converting, false);
  assert.equal(restored.extensions.pdf.pages.length, 2);
}

console.log("ok PDF conversion: streamed commit with stash preservation, failure toast + restore, cancel restore, and clean/dirty hydration restore");
