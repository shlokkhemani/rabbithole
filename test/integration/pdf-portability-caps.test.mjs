import assert from "node:assert/strict";
import { createPortableProjection } from "../../src/core/portable-projection.js";
import { parsePortableImportPayload, MAX_IMPORT_PAYLOAD_BYTES, MAX_IMPORT_ASSETS } from "../../src/core/portable-import.js";
import { MAX_PDF_PAGE_ASSET_BYTES, MAX_PDF_FIGURE_ASSET_BYTES, buildPdfDocument } from "../../src/core/pdf-shared.js";

// ---- cap coherence: the ingest budgets must fit through the export door -----
// base64 inflates 4/3; leave >= 1.5 MB of headroom for JSON structure and a
// large markdown body. If a budget bump ever breaks this, exports silently
// stop being importable — fail here instead.
const inflated = Math.ceil(((MAX_PDF_PAGE_ASSET_BYTES + MAX_PDF_FIGURE_ASSET_BYTES) * 4) / 3);
assert(
  inflated + 1.5 * 1024 * 1024 <= MAX_IMPORT_PAYLOAD_BYTES,
  `PDF asset budgets (${inflated} base64 bytes) leave no headroom under the ${MAX_IMPORT_PAYLOAD_BYTES} payload cap`,
);

// ---- a maxed-out converted PDF hole round-trips through the portable format --
const PAGE_COUNT = 40;
const FIGURE_COUNT = 30;
const pageBytes = Math.floor((MAX_PDF_PAGE_ASSET_BYTES * 0.98) / PAGE_COUNT);
const figureBytes = Math.floor((MAX_PDF_FIGURE_ASSET_BYTES * 0.98) / FIGURE_COUNT);

const pageLines = Array.from({ length: PAGE_COUNT }, (_, i) => ({
  page: i + 1,
  lines: Array.from({ length: 45 }, (_, j) => ({ text: `Page ${i + 1} line ${j} of representative dense body text for sizing.`, x: 0.08, y: 0.02 * j, w: 0.84, h: 0.018 })),
}));
const built = buildPdfDocument({
  title: "Near-cap fixture",
  pageCount: PAGE_COUNT,
  processedPages: pageLines.map((entry) => entry.page),
  pageAssets: pageLines.map((entry) => ({ page: entry.page, name: `page-${String(entry.page).padStart(3, "0")}.jpg`, width: 1224, height: 1584 })),
  pageLines,
  notes: [],
});

const hole = {
  schema_version: 2,
  hole_id: "near-cap",
  title: "Near-cap fixture",
  root_id: "root",
  created_at: "2026-07-11T00:00:00.000Z",
  updated_at: "2026-07-11T00:00:00.000Z",
  view_state: null,
  nodes: [{
    id: "root", parent_id: null, title: "Near-cap fixture", markdown: built.markdown,
    base_url: null, base_url_source: null, origin: null, position: { x: 0, y: 0 }, size: null,
    font_scale: 1, collapsed: false, status: "answered", read: true, created_at: "2026-07-11T00:00:00.000Z",
    extensions: { pdf: { ...built.pdfExtension, converted: false, original_markdown: null } },
  }],
};

const assets = {};
const filler = (bytes, seed) => Buffer.alloc(bytes, seed % 251).toString("base64");
for (const page of built.pdfExtension.pages) assets[page.asset] = filler(pageBytes, page.n);
for (let i = 1; i <= FIGURE_COUNT; i++) assets[`fig-p${String(i).padStart(3, "0")}-1.jpg`] = filler(figureBytes, 100 + i);
assert(Object.keys(assets).length <= MAX_IMPORT_ASSETS);

const payload = JSON.stringify(createPortableProjection(hole, assets));
assert(
  payload.length <= MAX_IMPORT_PAYLOAD_BYTES,
  `near-cap export serialized to ${payload.length} bytes — over the ${MAX_IMPORT_PAYLOAD_BYTES} import cap`,
);
assert(payload.length > MAX_IMPORT_PAYLOAD_BYTES * 0.85, "fixture should genuinely crowd the cap, not sit far below it");

const parsed = parsePortableImportPayload(payload, "rabbithole");
assert.equal(parsed.hole.hole_id, "near-cap");
assert.equal(Object.keys(parsed.assets).length, PAGE_COUNT + FIGURE_COUNT);
assert.equal(parsed.hole.nodes[0].extensions.pdf.pages.length, PAGE_COUNT);

console.log(`ok PDF portability caps: budgets cohere with the export door; near-cap hole (${(payload.length / 1024 / 1024).toFixed(1)} MB payload) re-imports`);
