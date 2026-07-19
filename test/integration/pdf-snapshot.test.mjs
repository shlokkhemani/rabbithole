import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { openRabbithole } from "../../src/node/index.js";
import { closeAllSessions, getSession } from "../../src/node/sessions.js";
import { buildSessionExportHtml } from "../../src/node/transport/session-export.js";
import { extractSnapshotPayload } from "../../src/core/portable-import.js";
import { ATTENTION_PDF_PAGE_COUNT, ATTENTION_PDF_PATH, readAttentionPdf } from "../support/attention-pdf.mjs";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-pdf-snapshot-v2-"));

const sourceBytes = await readAttentionPdf();
const sourcePath = path.join(process.env.RABBITHOLE_DIR, "offline.pdf");
const snapshotPath = path.join(process.env.RABBITHOLE_DIR, "offline-snapshot.html");
await fs.writeFile(sourcePath, sourceBytes);
const controller = new AbortController(); setTimeout(() => controller.abort(), 100);
const opened = await openRabbithole({ filePath: sourcePath, signal: controller.signal });
assert.equal(opened.status, "cancelled");
const session = getSession(opened.session_id);
const html = await buildSessionExportHtml(session);
await fs.writeFile(snapshotPath, html);

const projection = JSON.parse(extractSnapshotPayload(html));
const root = projection.hole.nodes.find((node) => node.id === projection.hole.root_id);
const sourceAsset = root.extensions.pdf.source.asset;
assert.equal(Buffer.from(projection.assets[sourceAsset], "base64").equals(sourceBytes), true, "snapshot must embed the original PDF byte-for-byte");
assert.match(html, /id="rabbithole-pdfjs-runtime"/);
assert.match(html, /id="rabbithole-pdf-worker-runtime"/);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const pageErrors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  page.on("request", (request) => { if (!request.url().startsWith("file:") && !request.url().startsWith("blob:") && !request.url().startsWith("data:")) externalRequests.push(request.url()); });
  await page.goto(`file://${snapshotPath}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.rh-pdf-page[data-page="1"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".rh-pdf-canvas-generation canvas");
    const span = document.querySelector(".rh-pdf-textlayer span");
    return !!canvas && canvas.width > 0 && !!span && [...document.querySelectorAll(".rh-pdf-textlayer span")].some((item) => item.textContent === "Attention Is All You Need");
  });
  assert.equal(projection.hole.nodes.find((node) => node.id === projection.hole.root_id).extensions.pdf.page_count, ATTENTION_PDF_PAGE_COUNT);
  assert.equal(await page.locator('.rh-pdf-page[data-page="1"] .rh-pdf-textlayer span', { hasText: "Attention Is All You Need" }).count(), 1, "offline text layer must not duplicate real paper text items");
  assert.equal(await page.locator('.rh-pdf-page[data-page="1"] .rh-pdf-canvas-generation canvas').count(), 1, "offline viewer must keep one active render generation");
  const before = await page.evaluate(() => ({ world: document.querySelector("#world")?.style.transform || "", width: document.querySelector(".rh-pdf-page").getBoundingClientRect().width }));
  await page.click('.rh-pdf-toolbar button[aria-label="Zoom PDF in"]');
  await page.waitForFunction((width) => document.querySelector(".rh-pdf-zoom-value")?.textContent === "125%"
    && document.querySelector(".rh-pdf-page")?.getBoundingClientRect().width > width, before.width);
  const after = await page.evaluate(() => ({ world: document.querySelector("#world")?.style.transform || "", width: document.querySelector(".rh-pdf-page").getBoundingClientRect().width }));
  assert.equal(after.world, before.world, "offline PDF zoom must stay local to the PDF");
  assert(after.width > before.width);
  assert.deepEqual(externalRequests, [], `offline PDF snapshot made network requests: ${externalRequests.join(", ")}`);
  assert.deepEqual(pageErrors, [], `offline PDF snapshot emitted errors:\n${pageErrors.join("\n")}`);
  console.log(`ok PDF snapshot (${path.basename(ATTENTION_PDF_PATH)}): original source, embedded runtime, offline render/text, single generations, and local zoom`);
} finally {
  await browser.close();
  await closeAllSessions("pdf_snapshot_v2_done");
}
