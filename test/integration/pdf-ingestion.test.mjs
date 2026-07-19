import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRabbithole } from "../../src/node/index.js";
import { ingestPdfDocument } from "../../src/node/pdf-ingest.js";
import { closeAllSessions, getSession } from "../../src/node/sessions.js";
import { defaultFsStore, resolveAsset } from "../../src/node/fs-store.js";
import { ATTENTION_PDF_PAGE_COUNT, ATTENTION_PAGE_VIEW, readAttentionPdf } from "../support/attention-pdf.mjs";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-native-pdf-v2-"));

function regionAnchor(sourceSha256) {
  return {
    offset_start: 0,
    offset_end: 0,
    pdf: {
      version: 2,
      source_sha256: sourceSha256,
      kind: "region",
      fragments: [{
        page: 1,
        quads: [[[211.488, 626.359], [281.296, 626.359], [281.296, 641.834], [211.488, 641.834]]],
      }],
    },
  };
}

function assertPng(bytes, message) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], message);
}

const sourceBytes = await readAttentionPdf();
const filePath = path.join(process.env.RABBITHOLE_DIR, "native.PDF");
await fs.writeFile(filePath, sourceBytes);

const staged = await ingestPdfDocument({ filePath, store: defaultFsStore });
assert.equal(staged.pdfExtension.version, 2);
assert.equal(staged.pdfExtension.source.byte_length, sourceBytes.length);
assert.equal(staged.pdfExtension.page_count, ATTENTION_PDF_PAGE_COUNT);
assert.deepEqual(staged.pdfExtension.pages.map((page) => page.view), Array.from({ length: ATTENTION_PDF_PAGE_COUNT }, () => ATTENTION_PAGE_VIEW));
assert.deepEqual(staged.pdfExtension.pages.map((page) => page.rotate), Array(ATTENTION_PDF_PAGE_COUNT).fill(0));
assert.match(staged.markdown, /Attention Is All You Need/);
await staged.discard();

const controller = new AbortController();
setTimeout(() => controller.abort(), 100);
const opened = await openRabbithole({ filePath, signal: controller.signal });
assert.equal(opened.status, "cancelled");
const session = getSession(opened.session_id);
const holeId = session.holeId;
const root = session.nodes.get(session.rootId);
const pdf = root.extensions.pdf;
assert.equal(pdf.version, 2);
assert.equal(pdf.source.asset, `pdf-${pdf.source.sha256}.pdf`);
assert.deepEqual(await fs.readFile(await resolveAsset(holeId, pdf.source.asset)), sourceBytes, "the stored PDF must be byte-identical to the input");
assert.deepEqual(await defaultFsStore.listAssets(holeId), [pdf.source.asset], "imports must persist one source PDF, not page rasters");

await session.handleBrowserEvent({
  type: "branch_request",
  request_id: "pdf-request",
  node_id: "pdf-child",
  parent_id: session.rootId,
  selected_text: "Attention",
  question: "Explain",
  lens: null,
  branch_type: "selection",
  anchor: regionAnchor(pdf.source.sha256),
  position: { x: 10, y: 20 },
});
const branch = await session.waitForEvent();
assert.equal(branch.status, "branch_request");
assert.equal(branch.region.page, 1);
assert.equal(path.isAbsolute(branch.region.image_path), true);
assert.equal(path.basename(branch.region.image_path), "region-pdf-request.png");
assertPng(await fs.readFile(branch.region.image_path), "agent crops must be lossless PNGs rendered from the source PDF");
assert.deepEqual(await defaultFsStore.listAssets(holeId), [pdf.source.asset], "transient agent crops must not enter the durable asset index");

const firstRegionPath = branch.region.image_path;
await closeAllSessions("persist_native_pdf_v2");
await assert.rejects(fs.access(firstRegionPath), { code: "ENOENT" }, "session close must remove transient crops");

const hole = await defaultFsStore.loadHole(holeId);
const persistedRoot = hole.nodes.find((node) => node.id === hole.root_id);
const persistedChild = hole.nodes.find((node) => node.id === "pdf-child");
assert.equal(persistedRoot.extensions.pdf.version, 2);
assert.deepEqual(persistedRoot.extensions.pdf.pages, pdf.pages);
assert.deepEqual(persistedChild.origin.anchor, regionAnchor(pdf.source.sha256));
assert.equal(Object.hasOwn(persistedChild.origin, "crop_asset"), false, "PDF v2 must not persist crop images");
assert.deepEqual(await defaultFsStore.listAssets(holeId), [pdf.source.asset]);

const resumeController = new AbortController();
setTimeout(() => resumeController.abort(), 4000);
const resumed = await openRabbithole({ holeId, signal: resumeController.signal });
assert.equal(resumed.status, "branch_request");
assert.equal(resumed.saved, true);
assert.equal(resumed.node_id, "pdf-child");
assert.equal(resumed.region?.page, 1, "saved PDF asks must regenerate their exact source crop");
assert.notEqual(resumed.region?.image_path, firstRegionPath, "resume gets a request-scoped transient path");
assertPng(await fs.readFile(resumed.region.image_path));
assert.deepEqual(await defaultFsStore.listAssets(holeId), [pdf.source.asset]);

await closeAllSessions("native_pdf_v2_done");
console.log("ok native PDF v2: source fidelity, PDF-space anchor, transient lossless crop, and resume regeneration");
