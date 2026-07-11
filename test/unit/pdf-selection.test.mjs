import assert from "node:assert/strict";
import { normalizeAnchor } from "../../src/core/model.js";
import { normalizeRectUnion, pdfSelectionOffsets } from "../../src/ui/pdf-view.js";

const lines = [{ s: 10, e: 20 }, { s: 30, e: 42 }];
const startSpan = { dataset: { line: "0" } }, endSpan = { dataset: { line: "1" } };
const offsets = pdfSelectionOffsets({
  startContainer: { nodeType: 3, parentElement: startSpan }, startOffset: 3,
  endContainer: { nodeType: 3, parentElement: endSpan }, endOffset: 5,
}, lines);
assert.deepEqual(offsets, { start: 13, end: 35 }, "intra-line range offsets map into post-normalization markdown space");

assert.deepEqual(normalizeRectUnion([
  { left: 120, top: 220, right: 180, bottom: 230, width: 60, height: 10 },
  { left: 110, top: 240, right: 210, bottom: 260, width: 100, height: 20 },
], { left: 100, top: 200, width: 200, height: 400 }), { x: .05, y: .05, w: .5, h: .1 });

assert.deepEqual(normalizeAnchor({ offset_start: -5, offset_end: 9, pdf: {
  page: 3.9, rect: { x: -.2, y: .8, w: 4, h: .7 },
} }), { offset_start: 0, offset_end: 9, pdf: { page: 3, rect: { x: 0, y: .8, w: 1, h: 1 - .8 } } });
assert.deepEqual(normalizeAnchor({ offset_start: 2, offset_end: 4, pdf: { page: 0, rect: {} } }), { offset_start: 2, offset_end: 4 });

console.log("ok PDF selection: intra-span offsets, normalized rect unions, and anchor.pdf clamps");
