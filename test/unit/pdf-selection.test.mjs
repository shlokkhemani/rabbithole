import assert from "node:assert/strict";
import { normalizeAnchor } from "../../src/core/model.js";
import { expandPdfBounds, pdfAnchorBounds } from "../../src/core/pdf-shared.js";

const sha256 = "cd".repeat(32);
const normalized = normalizeAnchor({ offset_start: -5, offset_end: 9, pdf: {
  version: 2,
  source_sha256: sha256,
  kind: "text",
  fragments: [
    { page: 3.9, quads: [
      [[10.123456, 40], [80, 40], [80, 25], [10.123456, 25]],
      [[12, 20], [55, 20], [55, 10], [12, 10]],
    ] },
  ],
} });
assert.equal(normalized.offset_start, 0);
assert.equal(normalized.offset_end, 9);
assert.equal(normalized.pdf.fragments[0].page, 3);
assert.equal(normalized.pdf.fragments[0].quads[0][0][0], 10.1235);
assert.deepEqual(pdfAnchorBounds(normalized.pdf, 3), [10.1235, 10, 80, 40]);
assert.deepEqual(expandPdfBounds([10, 10, 80, 40], [12, 8, 70, 50], 5), [12, 8, 70, 45]);

for (const pdf of [
  { page: 1, rect: { x: 0, y: 0, w: 1, h: 1 } },
  { version: 2, source_sha256: "bad", kind: "region", fragments: [] },
  { version: 2, source_sha256: sha256, kind: "region", fragments: [{ page: 1, quads: [[[0, 0], [1, 1], [2, 2], [3, 3]]] }] },
]) assert.equal(normalizeAnchor({ offset_start: 2, offset_end: 4, pdf }).pdf, undefined);

const region = normalizeAnchor({ pdf: {
  version: 2, source_sha256: sha256, kind: "region",
  fragments: [{ page: 1, quads: [[[12, 18], [72, 18], [72, 54], [12, 54]]] }],
} });
assert(region.pdf);
assert.deepEqual(pdfAnchorBounds(region.pdf, 1), [12, 18, 72, 54]);
assert.equal(pdfAnchorBounds(region.pdf, 2), null);

console.log("ok PDF v2 selection: quads validate, round deterministically, and derive exact bounds");
