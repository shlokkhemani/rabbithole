import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRabbithole } from "../../src/node/index.js";
import { ingestPdfDocument } from "../../src/node/pdf-ingest.js";
import { closeAllSessions, getSession } from "../../src/node/sessions.js";
import { defaultFsStore, listAssets, loadHole, resolveAsset } from "../../src/node/fs-store.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-native-pdf-"));

function tinyPdf(texts) {
  const objects = [];
  objects[1] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${texts.length} >>\nendobj\n`;
  objects[3] = "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  texts.forEach((raw, i) => {
    const page = 4 + i * 2, stream = page + 1;
    const text = String(raw).replace(/[\\()]/g, "\\$&");
    const content = `BT /F1 18 Tf 40 160 Td (${text}) Tj ET\n`;
    objects[page] = `${page} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 220] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>\nendobj\n`;
    objects[stream] = `${stream} 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`;
  });
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets[i] = Buffer.byteLength(pdf, "latin1"); pdf += objects[i]; }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1");
}

const filePath = path.join(process.env.RABBITHOLE_DIR, "native.PDF");
await fs.writeFile(filePath, tinyPdf(["Same host geometry", "Second page"]));
const staged = await ingestPdfDocument({ filePath, store: defaultFsStore });
await staged.discard();

const controller = new AbortController();
setTimeout(() => controller.abort(), 100);
const opened = await openRabbithole({ filePath, signal: controller.signal });
assert.equal(opened.status, "cancelled");
const session = getSession(opened.session_id);
const holeId = session.holeId;
await session.handleBrowserEvent({ type: "node_extensions_patch", node_id: session.rootId, namespace: "pdf", value: staged.pdfExtension });
assert(session.outboundEvents.some((entry) => entry.data.type === "node_extensions_patch"), "node host must forward extension patches to SSE");
await session.handleBrowserEvent({ type: "branch_request", request_id: "pdf-request", node_id: "pdf-child", parent_id: session.rootId,
  selected_text: "Same host", question: "Explain", lens: null, branch_type: "selection",
  anchor: { offset_start: staged.pdfExtension.lines[0].s, offset_end: staged.pdfExtension.lines[0].s + 9,
    pdf: { page: 1, rect: { x: .1, y: .2, w: .3, h: .04 } } }, position: { x: 10, y: 20 } });
const branch = await session.waitForEvent();
assert.equal(branch.status, "branch_request");
assert.equal(branch.selected_text, "Same host");
assert.equal(branch.region.page, 1);
assert.equal(path.isAbsolute(branch.region.image_path), true);
const regionBytes = await fs.readFile(branch.region.image_path);
assert.equal(regionBytes[0], 0xff); assert.equal(regionBytes[1], 0xd8, "region path should point at a readable JPEG");
const regionPath = branch.region.image_path;
session.inFlightBranchRequests.delete("pdf-request");
await fs.writeFile(await resolveAsset(holeId, staged.pdfExtension.pages[0].asset), Buffer.from("broken"));
await session.handleBrowserEvent({ type: "branch_request", request_id: "pdf-fallback", node_id: "pdf-child-fallback", parent_id: session.rootId,
  selected_text: "fallback", question: "Explain", anchor: { offset_start: 0, offset_end: 1,
    pdf: { page: 1, rect: { x: .1, y: .2, w: .3, h: .04 } } }, position: { x: 20, y: 20 } });
const fallback = await session.waitForEvent();
assert.equal(fallback.request_id, "pdf-fallback");
assert.equal(Object.hasOwn(fallback, "region"), false, "crop failure must preserve the lean branch request");
await closeAllSessions("persist_native_pdf");
const hole = await loadHole(holeId);
const root = hole.nodes.find((node) => node.id === hole.root_id);
assert.equal(root.markdown, staged.markdown, "node host must use the shared canonical builder");
assert.deepEqual(root.extensions.pdf.lines, staged.pdfExtension.lines, "line geometry must match the shared host fixture");
assert.deepEqual(hole.nodes.find((node) => node.id === "pdf-child").origin.anchor.pdf,
  { page: 1, rect: { x: .1, y: .2, w: .3, h: .04 } });
assert.equal(root.extensions.pdf.pages.length, 2);
assert.deepEqual(await listAssets(holeId), ["page-001.jpg", "page-002.jpg"], "transient region crops must not outlive the session");
await assert.rejects(() => fs.access(regionPath), undefined, "the region JPEG file itself must be unlinked at close");
for (const page of root.extensions.pdf.pages) {
  assert(page.w > 0 && page.h > 0);
  assert.equal(page.asset.endsWith(".jpg"), true);
}

// A saved PDF ask re-crops its region on resume, so a reconnecting agent sees
// the same image a live one would have. (Heal the page asset the fallback case
// corrupted above first.)
await fs.copyFile(await resolveAsset(holeId, staged.pdfExtension.pages[1].asset), await resolveAsset(holeId, staged.pdfExtension.pages[0].asset));
const resumeController = new AbortController();
setTimeout(() => resumeController.abort(), 4000);
const resumed = await openRabbithole({ holeId, signal: resumeController.signal });
assert.equal(resumed.status, "branch_request");
assert.equal(resumed.saved, true);
for (let i = 0; i < 100 && !resumed.region; i++) await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(resumed.region?.page, 1, "saved PDF asks must re-crop their region on resume");
const recropBytes = await fs.readFile(resumed.region.image_path);
assert.equal(recropBytes[0], 0xff); assert.equal(recropBytes[1], 0xd8);
await closeAllSessions("recrop_done");
console.log("ok native PDF: file_path builds shared markdown/geometry, JPEG assets, metadata title fallback, persisted extension, and region-crop lifecycle");
