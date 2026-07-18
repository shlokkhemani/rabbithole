import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRabbithole } from "../../src/node/index.js";
import { ingestPdfDocument } from "../../src/node/pdf-ingest.js";
import { closeAllSessions, getSession } from "../../src/node/sessions.js";
import { defaultFsStore, resolveAsset } from "../../src/node/fs-store.js";

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
for (const page of staged.pdfExtension.pages) {
  const bytes = await fs.readFile(await resolveAsset(holeId, page.asset));
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", "page assets should use the sharper, more efficient WebP pipeline");
}
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
assert.equal(path.basename(regionPath), "crop-pdf-child.jpg", "agent region must point at the branch-owned durable crop");
session.inFlightBranchRequests.delete("pdf-request");
await session.handleBrowserEvent({ type: "branch_request", request_id: "clip-followup", node_id: "clip-followup-child", parent_id: "pdf-child",
  selected_text: "", question: "And what follows?", branch_type: "followup", anchor: null, position: { x: 20, y: 20 } });
const inheritedFollowup = await session.waitForEvent();
assert.equal(inheritedFollowup.region.image_path, regionPath, "follow-ups must expose the immediate parent's durable clip");
session.inFlightBranchRequests.delete("clip-followup");
await session.handleBrowserEvent({ type: "branch_request", request_id: "clip-selection", node_id: "clip-selection-child", parent_id: "pdf-child",
  selected_text: "answer text", question: "Explain this", branch_type: "selection", anchor: { offset_start: 0, offset_end: 6 }, position: { x: 20, y: 40 } });
const inheritedSelection = await session.waitForEvent();
assert.equal(inheritedSelection.region.image_path, regionPath, "text selections must expose the immediate parent's durable clip");
session.inFlightBranchRequests.delete("clip-selection");
await fs.writeFile(await resolveAsset(holeId, staged.pdfExtension.pages[0].asset), Buffer.from("broken"));
await session.handleBrowserEvent({ type: "branch_request", request_id: "pdf-fallback", node_id: "pdf-child-fallback", parent_id: session.rootId,
  selected_text: "fallback", question: "Explain", anchor: { offset_start: 0, offset_end: 1,
    pdf: { page: 1, rect: { x: .1, y: .2, w: .3, h: .04 } } }, position: { x: 20, y: 20 } });
const fallback = await session.waitForEvent();
assert.equal(fallback.request_id, "pdf-fallback");
assert.equal(Object.hasOwn(fallback, "region"), false, "crop failure must preserve the lean branch request");
await closeAllSessions("persist_native_pdf");
const hole = await defaultFsStore.loadHole(holeId);
const root = hole.nodes.find((node) => node.id === hole.root_id);
assert.equal(root.markdown, staged.markdown, "node host must use the shared canonical builder");
assert.deepEqual(root.extensions.pdf.lines, staged.pdfExtension.lines, "line geometry must match the shared host fixture");
assert.deepEqual(hole.nodes.find((node) => node.id === "pdf-child").origin.anchor.pdf,
  { page: 1, rect: { x: .1, y: .2, w: .3, h: .04 } });
assert.equal(hole.nodes.find((node) => node.id === "pdf-child").origin.crop_asset, "crop-pdf-child.jpg");
assert.equal(root.extensions.pdf.pages.length, 2);
assert.equal(root.extensions.pdf.scale, 3, "new PDF imports should retain enough pixels for high-DPI readers");
assert.deepEqual(await defaultFsStore.listAssets(holeId), ["crop-pdf-child.jpg", "page-001.webp", "page-002.webp"], "branch-owned region crops must outlive the session");
await fs.access(regionPath);
for (const page of root.extensions.pdf.pages) {
  assert(page.w > 0 && page.h > 0);
  assert.equal(page.asset.endsWith(".webp"), true);
}

// A saved PDF ask reuses its durable crop on resume, so a reconnecting agent
// sees byte-identical image context without re-cropping the page.
await fs.copyFile(await resolveAsset(holeId, staged.pdfExtension.pages[1].asset), await resolveAsset(holeId, staged.pdfExtension.pages[0].asset));
const resumeController = new AbortController();
setTimeout(() => resumeController.abort(), 4000);
const resumed = await openRabbithole({ holeId, signal: resumeController.signal });
assert.equal(resumed.status, "branch_request");
assert.equal(resumed.saved, true);
for (let i = 0; i < 100 && !resumed.region; i++) await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(resumed.region?.page, 1, "saved PDF asks must expose their durable region on resume");
assert.equal(resumed.region?.image_path, regionPath);
const recropBytes = await fs.readFile(resumed.region.image_path);
assert.equal(recropBytes[0], 0xff); assert.equal(recropBytes[1], 0xd8);
await closeAllSessions("recrop_done");
console.log("ok native PDF: shared ingest plus durable, byte-identical branch crop lifecycle");
