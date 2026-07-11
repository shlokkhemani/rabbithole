import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ingestPdf, openRabbithole } from "../../src/node/index.js";
import { closeAllSessions, getSession } from "../../src/node/sessions.js";
import {
  assertSafeHoleId,
  listAssets,
  resolveAsset,
  resolveStagedAssetDir,
  saveHole,
} from "../../src/node/fs-store.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-pdf-ingestion-"));

const ATTENTION_PDF =
  "/private/tmp/claude-501/-Users-shlokkhemani-Projects-rabbit-hole/aa6bb307-c272-4866-927a-c517187acb97/scratchpad/pdfs/attention.pdf";

function pdfLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildTinyPdf(pageTexts) {
  const objects = [];
  objects[1] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const kids = pageTexts.map((_text, index) => `${4 + index * 2} 0 R`).join(" ");
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>\nendobj\n`;
  objects[3] = "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  for (let index = 0; index < pageTexts.length; index += 1) {
    const pageObj = 4 + index * 2;
    const contentObj = pageObj + 1;
    const content = `BT /F1 18 Tf 40 160 Td (${pdfLiteral(pageTexts[index])}) Tj ET\n`;
    objects[pageObj] =
      `${pageObj} 0 obj\n` +
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 220] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>\n` +
      "endobj\n";
    objects[contentObj] = `${contentObj} 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`;
  }

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += objects[id];
  }
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function writeTinyPdf(name = "tiny.pdf") {
  const dir = await fs.mkdtemp(path.join(process.env.RABBITHOLE_DIR, "fixtures-"));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buildTinyPdf(["Hello Rabbithole PDF", "Second PDF page", "Third PDF page"]));
  return filePath;
}

function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
}

async function dirSize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
}

async function makeHole(holeId) {
  const markdown = "Direct hole root";
  await saveHole({
    hole_id: holeId,
    title: "Direct Hole",
    root_id: "root",
    created_at: new Date().toISOString(),
    nodes: [
      {
        id: "root",
        parent_id: null,
        title: "Root",
        markdown,
        base_url: null,
        base_url_source: null,
        origin: null,
        position: { x: 0, y: 0 },
        size: null,
        font_scale: 1,
        collapsed: false,
        status: "answered",
        read: true,
        created_at: new Date().toISOString(),
      },
    ],
  });
}

async function runHappyPath(pdfPath) {
  const result = await ingestPdf({ filePath: pdfPath, pages: "1" });
  assert(result.ingest_id, "staged ingest should return an ingest_id");
  assert.equal(result.title, null);
  assert.equal(result.page_count, 3);
  assert.deepEqual(result.processed_pages, [1]);
  assert.equal(result.assets.pages.length, 1);
  assert.equal(result.assets.pages[0].name, "page-001.png");
  assert.equal(result.assets.embedded_images.length, 0);
  assert.equal(result.text.length, 1);
  assert.match(result.text[0].text, /Hello Rabbithole PDF/);

  const stagingDir = await resolveStagedAssetDir(result.ingest_id);
  assert(stagingDir, "staged asset directory should exist");
  const pagePng = await fs.readFile(path.join(stagingDir, "page-001.png"));
  assert(isPng(pagePng), "rendered page asset should be a PNG");

  console.log("ok pdf: happy path returns staged assets, PNG page render, manifest shape, and text");
}

async function runRangeFixture(pdfPath) {
  const result = await ingestPdf({ filePath: pdfPath, pages: "2-3", includeText: false });
  assert.deepEqual(result.processed_pages, [2, 3]);
  assert.equal(result.assets.pages.length, 2);
  assert.deepEqual(
    result.assets.pages.map((page) => page.name),
    ["page-002.png", "page-003.png"]
  );
  assert.equal(Object.hasOwn(result, "text"), false);
  const stagingDir = await resolveStagedAssetDir(result.ingest_id);
  assert.deepEqual((await fs.readdir(stagingDir)).sort(), ["page-002.png", "page-003.png"]);

  console.log("ok pdf: pages range limits output and include_text=false omits text");
}

async function runStagingAdoptionFixture(pdfPath) {
  const staged = await ingestPdf({ filePath: pdfPath, pages: "1", includeText: false });
  assert(await resolveStagedAssetDir(staged.ingest_id));

  const controller = new AbortController();
  const opened = openRabbithole({
    title: "Adopted PDF",
    content: "![page](asset:page-001.png)",
    ingestId: staged.ingest_id,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const event = await opened;
  assert.equal(event.status, "cancelled");
  const session = getSession(event.session_id);
  assert(session, "cancelled open should still have created a session");
  assert.equal(await resolveStagedAssetDir(staged.ingest_id), null, "adoption should remove staging dir");

  const live = await fetch(session.url);
  assert.equal(live.status, 200);
  const liveHtml = await live.text();
  assert(liveHtml.includes("asset:page-001.png"));
  assert(!liveHtml.includes('"contentHtml"'));
  const asset = await fetch(`${session.url}/assets/page-001.png`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert(isPng(Buffer.from(await asset.arrayBuffer())));

  await closeAllSessions("pdf_adoption_complete");
  console.log("ok pdf: staging adoption by open_rabbithole renders and serves assets");
}

async function runDirectHoleFixture(pdfPath) {
  await makeHole("direct-hole");
  const result = await ingestPdf({ filePath: pdfPath, holeId: "direct-hole", pages: "1", includeText: false });
  assert.equal(result.hole_id, "direct-hole");
  assert.equal(Object.hasOwn(result, "ingest_id"), false);
  assert.deepEqual(await listAssets("direct-hole"), ["page-001.png"]);
  assert(isPng(await fs.readFile(await resolveAsset("direct-hole", "page-001.png"))));

  console.log("ok pdf: direct hole_id ingestion writes immediately usable assets");
}

async function runValidationFixtures(pdfPath) {
  const dir = await fs.mkdtemp(path.join(process.env.RABBITHOLE_DIR, "bad-"));
  const fakePdf = path.join(dir, "renamed.pdf");
  await fs.writeFile(fakePdf, "not really a pdf");

  await assert.rejects(() => ingestPdf({ filePath: fakePdf }), /not a PDF/);
  await assert.rejects(() => ingestPdf({ filePath: path.join(dir, "missing.pdf") }), /does not exist/);
  await assert.rejects(
    () => openRabbithole({ title: "Unknown", content: "x", ingestId: "ingest-missing" }),
    /Unknown ingest_id/
  );
  await assert.rejects(() => ingestPdf({ filePath: pdfPath, pages: "0" }), /positive ascending/);
  assert.throws(() => assertSafeHoleId(".staging"), /Invalid hole id/);

  console.log("ok pdf: invalid PDFs, missing files, unknown ingest_id, bad ranges, and dot hole ids are rejected");
}

async function runRealPaperFixture() {
  try {
    await fs.access(ATTENTION_PDF);
  } catch {
    console.log(`skip pdf: real paper fixture absent at ${ATTENTION_PDF}`);
    return null;
  }

  const start = performance.now();
  const result = await ingestPdf({ filePath: ATTENTION_PDF });
  const wallMs = performance.now() - start;
  assert.equal(result.page_count, 15);
  assert.equal(result.assets.pages.length, 15);
  assert(result.assets.embedded_images.length >= 1, "attention.pdf should expose at least one embedded image");
  assert.equal(result.text.length, 15);

  const stagingDir = await resolveStagedAssetDir(result.ingest_id);
  const outputBytes = await dirSize(stagingDir);
  console.log(
    `ok pdf: attention.pdf real-paper renders=${result.assets.pages.length} embedded=${result.assets.embedded_images.length} ` +
      `wall=${(wallMs / 1000).toFixed(2)}s output=${formatBytes(outputBytes)}`
  );
  return { wallMs, outputBytes };
}

const tinyPdf = await writeTinyPdf();
await runHappyPath(tinyPdf);
await runRangeFixture(tinyPdf);
await runStagingAdoptionFixture(tinyPdf);
await runDirectHoleFixture(tinyPdf);
await runValidationFixtures(tinyPdf);
await runRealPaperFixture();
await closeAllSessions("pdf_ingestion_test_complete");
console.log("PDF ingestion verification passed");
