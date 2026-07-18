import assert from "node:assert/strict";
import { MAX_PDF_SOURCE_BYTES } from "../../src/core/assets.js";
import { createPortableProjection } from "../../src/core/portable-projection.js";
import { parsePortableImportPayload, MAX_IMPORT_PAYLOAD_BYTES, MAX_IMPORT_ASSETS } from "../../src/core/portable-import.js";
import { MAX_PDF_FIGURE_ASSET_BYTES, buildPdfDocument } from "../../src/core/pdf-shared.js";

// A maximum source PDF plus the complete durable figure budget must still fit
// through the base64 portable format with room for document JSON.
const inflatedAssetBudget = Math.ceil(((MAX_PDF_SOURCE_BYTES + MAX_PDF_FIGURE_ASSET_BYTES) * 4) / 3);
assert(
  inflatedAssetBudget + 8 * 1024 * 1024 <= MAX_IMPORT_PAYLOAD_BYTES,
  `PDF source and figure budgets leave insufficient JSON headroom under the ${MAX_IMPORT_PAYLOAD_BYTES} payload cap`,
);

const PAGE_COUNT = 40;
const FIGURE_COUNT = 30;
const sha256 = "ab".repeat(32);
const sourceAsset = `pdf-${sha256}.pdf`;
const pageLines = Array.from({ length: PAGE_COUNT }, (_, i) => ({
  page: i + 1,
  lines: Array.from({ length: 45 }, (_, j) => ({ text: `Page ${i + 1} line ${j} of representative dense body text for sizing.` })),
}));
const built = buildPdfDocument({
  title: "Source-backed fixture",
  pageCount: PAGE_COUNT,
  processedPages: pageLines.map((entry) => entry.page),
  pageMetadata: pageLines.map((entry) => ({ n: entry.page, view: [0, 0, 612, 792], rotate: 0, user_unit: 1 })),
  pageLines,
  notes: [],
  source: { asset: sourceAsset, sha256, byte_length: 1024 * 1024 },
});

const hole = {
  schema_version: 2,
  hole_id: "source-backed-portable",
  title: "Source-backed fixture",
  root_id: "root",
  created_at: "2026-07-11T00:00:00.000Z",
  updated_at: "2026-07-11T00:00:00.000Z",
  view_state: null,
  nodes: [{
    id: "root", parent_id: null, title: "Source-backed fixture", markdown: built.markdown,
    base_url: null, base_url_source: null, origin: null, position: { x: 0, y: 0 }, size: null,
    font_scale: 1, collapsed: false, status: "answered", read: true, created_at: "2026-07-11T00:00:00.000Z",
    extensions: { pdf: built.pdfExtension },
  }],
};

const assets = { [sourceAsset]: Buffer.alloc(1024 * 1024, 37).toString("base64") };
for (let i = 1; i <= FIGURE_COUNT; i++) {
  assets[`fig-p${String(i).padStart(3, "0")}-1.png`] = Buffer.alloc(16 * 1024, i).toString("base64");
}
assert(Object.keys(assets).length <= MAX_IMPORT_ASSETS);

const payload = JSON.stringify(createPortableProjection(hole, assets));
assert(payload.length < MAX_IMPORT_PAYLOAD_BYTES);
const parsed = parsePortableImportPayload(payload, "rabbithole");
assert.equal(parsed.hole.hole_id, "source-backed-portable");
assert.equal(Object.keys(parsed.assets).length, FIGURE_COUNT + 1);
assert.deepEqual(parsed.hole.nodes[0].extensions.pdf.source, built.pdfExtension.source);
assert.equal(parsed.hole.nodes[0].extensions.pdf.pages.length, PAGE_COUNT);
assert.equal(parsed.hole.nodes[0].extensions.pdf.pages.some((page) => "asset" in page), false, "pages must carry geometry, never persistent rasters");

console.log(`ok PDF portability caps: a 100 MB source budget fits the export door and source-backed v2 round-trips (${(payload.length / 1024 / 1024).toFixed(1)} MB fixture)`);
