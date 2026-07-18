import assert from "node:assert/strict";
import { buildPdfDocument, normalizePdfExtension } from "../../src/core/pdf-shared.js";
import { createHoleState, holeStateToHole, reduceHoleEvent } from "../../src/core/reducer.js";
import { parsePersistedHole, toPersistedHole } from "../../src/core/schema.js";

const sha256 = "ab".repeat(32);
const source = { asset: `pdf-${sha256}.pdf`, sha256, byte_length: 12345 };
const built = buildPdfDocument({
  title: "Hostile paper",
  pageCount: 2,
  processedPages: [1, 2],
  pageMetadata: [
    { n: 1, view: [12, 20, 612, 820], rotate: 90, user_unit: 1 },
    { n: 2, view: [0, 0, 612, 792], rotate: 0, user_unit: 1 },
  ],
  pageLines: [
    { page: 1, lines: [{ text: "```show" }, { text: "inside" }] },
    { page: 2, lines: [] },
  ],
  notes: ["Processed first 2 of 3 pages."],
  source,
});
assert.match(built.markdown, /```show id=pdf000/);
assert.match(built.markdown, /\*\(page 2: no extractable text\)\*/);
assert.match(built.markdown, /Processed first 2 of 3 pages\./);
for (const line of built.pdfExtension.lines) assert.equal(built.markdown.slice(line.s, line.e).length > 0, true);
assert.equal(built.pdfExtension.version, 2);
assert.deepEqual(built.pdfExtension.source, source);
assert.deepEqual(built.pdfExtension.pages[0].view, [12, 20, 612, 820]);

const valid = normalizePdfExtension({ markdown: built.markdown, extensions: { pdf: built.pdfExtension } });
assert(valid);
assert.equal(valid.pages[0].rotate, 90);
for (const invalid of [
  { ...built.pdfExtension, version: 1 },
  { ...built.pdfExtension, source: { ...source, asset: "page-001.png" } },
  { ...built.pdfExtension, source: { ...source, sha256: "bad" } },
  { ...built.pdfExtension, pages: [{ n: 1, view: [0, 0, 0, 10], rotate: 0, user_unit: 1 }] },
  { ...built.pdfExtension, pages: [{ n: 1, view: [0, 0, 10, 10], rotate: 45, user_unit: 1 }] },
  { ...built.pdfExtension, lines: [{ p: 1, s: 0, e: built.markdown.length + 1 }] },
]) assert.equal(normalizePdfExtension({ markdown: built.markdown, extensions: { pdf: invalid } }), null);

const pdfAnchor = {
  version: 2,
  source_sha256: sha256,
  kind: "text",
  fragments: [{ page: 1, quads: [[[40, 120], [140, 120], [140, 105], [40, 105]]] }],
};
const branch = reduceHoleEvent(createHoleState({
  hole_id: "pdf-roundtrip", title: "PDF", root_id: "root",
  nodes: [{ id: "root", parent_id: null, title: "Root", markdown: "Body", extensions: {} }],
}), {
  type: "branch_request", parent_id: "root", node_id: "clip-child", question: "What is this?",
  selected_text: "selected text", anchor: { offset_start: 0, offset_end: 0, pdf: pdfAnchor },
}, { now: "2026-07-13T00:00:00.000Z" });
const persisted = parsePersistedHole(toPersistedHole(holeStateToHole(branch.state), { updatedAt: "2026-07-13T00:00:01.000Z" }));
const child = persisted.nodes.find((node) => node.id === "clip-child");
assert.deepEqual(child.origin.anchor.pdf, pdfAnchor);
assert.equal(child.origin.crop_asset, undefined, "PDF-space provenance replaces durable crop images");
assert.equal(child.markdown, "");

console.log("ok PDF v2 provenance: original source, visible boxes, and PDF-space quads round-trip");
