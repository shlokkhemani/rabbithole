import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { addBytesAttachmentToDocument } from "../../src/extension/attachments.js";
import { buildSnapshotHtmlForDocument } from "../../src/extension/commands/export-commands.js";
import { NoraDocument } from "../../src/extension/nora-document.js";
import { ATTENTION_PAGE_VIEW, ATTENTION_PDF_PAGE_COUNT, ATTENTION_PDF_PATH, readAttentionPdf } from "../support/attention-pdf.mjs";
import { ensureNoraBuild } from "../support/nora-webview-assets.mjs";

const sourceBytes = await readAttentionPdf();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nora-pdf-snapshot-"));
const snapshotPath = path.join(tmp, "offline-snapshot.html");
await ensureNoraBuild();
const document = await NoraDocument.open(fileUri(path.join(tmp, "offline.nora")), {
  tempRoot: tmp,
  title: "Attention PDF",
  now: "2026-07-28T00:00:00.000Z",
  idFactory: () => "pdf-snapshot-doc",
});
const attachment = await addBytesAttachmentToDocument(document, sourceBytes, {
  title: "Attention PDF",
  filename: path.basename(ATTENTION_PDF_PATH),
  mediaType: "application/pdf",
  now: "2026-07-28T00:00:01.000Z",
  idFactory: idFactory(["source", "evidence"]),
});
await document.commitEvent({
  type: "node_answered",
  node_id: "root",
  title: "Attention PDF",
  markdown: "# Attention PDF\n",
  read: true,
});
await document.commitEvent({
  type: "node_extensions_patch",
  node_id: "root",
  namespace: "pdf",
  value: {
    version: 2,
    source: { asset: attachment.assetName, sha256: attachment.sha256, byte_length: attachment.bytes },
    page_count: ATTENTION_PDF_PAGE_COUNT,
    pages: [{ n: 1, view: ATTENTION_PAGE_VIEW, rotate: 0, user_unit: 1 }],
    lines: [],
    notes: [],
    converting: false,
    converted: false,
    original_markdown: null,
  },
});
await document.commitEvent({
  type: "node_references",
  node_id: "root",
  source_ids: [attachment.source.id],
  evidence_ids: [attachment.evidence.id],
  attachment_ids: [attachment.attachment.id],
});
const html = await buildSnapshotHtmlForDocument({ extensionUri: fileUri(process.cwd()) }, fakeVscodeApi(), document);
await fs.writeFile(snapshotPath, html);

const projection = JSON.parse(extractNoraSnapshotPayload(html));
const root = projection.document.nodes.find((node) => node.id === projection.document.rootNodeId);
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
  assert.equal(root.extensions.pdf.page_count, ATTENTION_PDF_PAGE_COUNT);
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
  await document.dispose();
  await fs.rm(tmp, { recursive: true, force: true });
}

function extractNoraSnapshotPayload(html) {
  const open = '<script type="application/vnd.nora+json" id="nora-snapshot">';
  const start = html.indexOf(open);
  assert.notEqual(start, -1, "Nora snapshot payload should be present");
  assert.equal(html.indexOf(open, start + open.length), -1, "Nora snapshot payload should be unique");
  const end = html.indexOf("</script>", start + open.length);
  assert.notEqual(end, -1, "Nora snapshot payload should be closed");
  return html.slice(start + open.length, end);
}

function fakeVscodeApi() {
  return {
    workspace: {
      fs: {
        readFile: async (uri) => fs.readFile(uri.fsPath),
      },
    },
    Uri: {
      file: fileUri,
      joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)),
    },
  };
}

/** @param {string[]} values */
function idFactory(values) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

/** @param {string} filePath */
function fileUri(filePath) {
  const absolute = path.resolve(filePath);
  return {
    scheme: "file",
    fsPath: absolute,
    toString: () => pathToFileURL(absolute).href,
  };
}
