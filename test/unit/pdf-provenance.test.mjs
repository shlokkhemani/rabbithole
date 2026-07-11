import assert from "node:assert/strict";
import { buildPdfDocument, normalizePdfExtension } from "../../src/core/pdf-shared.js";

const built = buildPdfDocument({
  title: "Hostile paper",
  pageCount: 2,
  processedPages: [1, 2],
  pageAssets: [
    { page: 1, name: "page-001.jpg", width: 1200, height: 1600 },
    { page: 2, name: "page-002.jpg", width: 1200, height: 1600 },
  ],
  pageLines: [
    { page: 1, lines: [{ text: "```show", x: .1, y: .2, w: .7, h: .03 }, { text: "inside", x: .1, y: .24, w: .2, h: .03 }] },
    { page: 2, lines: [] },
  ],
  notes: ["Processed first 2 of 3 pages."],
});
assert.match(built.markdown, /```show id=pdf000/);
assert.match(built.markdown, /\*\(page 2: no extractable text\)\*/);
assert.match(built.markdown, /Processed first 2 of 3 pages\./);
for (const line of built.pdfExtension.lines) assert.equal(built.markdown.slice(line.s, line.e).length > 0, true);
assert.equal(built.markdown.slice(built.pdfExtension.lines[0].s, built.pdfExtension.lines[0].e), "```show id=pdf000");

const valid = normalizePdfExtension({ markdown: built.markdown, extensions: { pdf: built.pdfExtension } });
assert(valid);
const clamped = structuredClone(built.pdfExtension);
clamped.lines[0].x = -4; clamped.lines[0].w = 8;
assert.equal(normalizePdfExtension({ markdown: built.markdown, extensions: { pdf: clamped } }).lines[0].x, 0);
assert.equal(normalizePdfExtension({ markdown: built.markdown, extensions: { pdf: clamped } }).lines[0].w, 1);
for (const invalid of [
  { ...built.pdfExtension, version: 2 },
  { ...built.pdfExtension, pages: [{ n: 1, asset: "../bad.jpg", w: 1, h: 1 }] },
  { ...built.pdfExtension, lines: [{ p: 1, x: 0, y: 0, w: 1, h: 1, s: 0, e: built.markdown.length + 1 }] },
  { ...built.pdfExtension, lines: Array.from({ length: 25001 }, () => ({})) },
]) assert.equal(normalizePdfExtension({ markdown: built.markdown, extensions: { pdf: invalid } }), null);

console.log("ok PDF provenance: normalize-first offsets, scanned markers, notes, clamping, and hostile fallback");
