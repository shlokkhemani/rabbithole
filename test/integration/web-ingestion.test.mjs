import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { NEWER_SCHEMA_MESSAGE } from "../../src/core/schema.js";
import { ensureWebDist } from "../support/build.mjs";
import { serveStatic } from "../support/static-server.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");

try {
  await fs.access(path.join(WEB_DIST, "index.html"));
} catch {
  try { ensureWebDist(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}

let proxyCalls = 0;
const server = await serveStatic(WEB_DIST, { routes: {
  "/proxy": (_req, res) => { proxyCalls += 1; res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }); res.end(articleHtml("Proxy fallback article")); },
  "/dead-proxy": (_req, res) => { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end("proxy unavailable"); },
  "/reject-proxy": (_req, res) => { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end("Host is not allowlisted: arxiv.org"); },
} });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript(() => localStorage.setItem("rh-web-settings", JSON.stringify({
  preset: "custom",
  base_url: "http://localhost:11434/v1",
  model: "llama3.2",
  model: "llama3.2",
  session_only: true,
  generation_setup: { version: 1, preset: "custom", base_url: "http://localhost:11434/v1", model: "llama3.2" },
})));
const page = await context.newPage();
const requests = [];
let directArticleCalls = 0;

page.on("request", (request) => {
  requests.push(request.url());
});

await page.route(/https:\/\/ar5iv\.labs\.arxiv\.org\/html\/.+/, async (route) => {
  directArticleCalls += 1;
  await route.abort("failed");
});

// Opening settings warms the OpenRouter model catalog; keep this test offline.
await page.route("https://openrouter.ai/api/v1/models", async (route) => {
  await route.fulfill({
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ data: [
      { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" } },
    ] }),
  });
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#blank-start-new");
  await page.waitForSelector("#composer-path-file");

  requests.length = 0;
  const pdfBytes = buildTinyPdf([
    "Browser PDF page one: Euler math e^(i*pi)+1=0",
    "Browser PDF page two: Integral int_0^1 x dx = 1/2",
  ]);
  await dropPdf(page, pdfBytes, "MaTh-FiXtUrE.PdF", "");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  await page.waitForFunction(() => {
    const img = document.querySelector(".node .doc-content[data-node-id] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });

  const externalDuringPdf = requests.filter((url) => !url.startsWith(baseUrl) && !url.startsWith("blob:"));
  assert.deepEqual(externalDuringPdf, [], `PDF ingest made external request(s): ${externalDuringPdf.join(", ")}`);

  const pdfState = await page.evaluate(async () => {
    const holeId = window.__rabbitholeTest.currentHoleId();
    const { names: assets, sizes } = await window.__rabbitholeTest.inspectAssets(holeId);
    const raw = await window.__rabbitholeTest.readStoredHole(holeId);
    return { assets, sizes, raw: JSON.stringify(raw) };
  });
  assert.deepEqual(pdfState.assets, ["page-001.jpg", "page-002.jpg"]);
  assert(pdfState.sizes["page-001.jpg"] > 100, "page-001.jpg should be stored as a non-empty Blob");
  assert(!pdfState.raw.includes("asset:page-001.jpg"), "model markdown must not contain page-image refs");
  assert(pdfState.raw.includes('"version":1'));
  assert(pdfState.raw.includes("Browser PDF page one"));
  assert(pdfState.raw.includes("Integral int_0^1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".doc-content.rh-pdf .rh-pdf-page[data-page='2']", { state: "attached" });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await setFetchProxy(page, `${baseUrl}/proxy`);
  await page.click("#t-new");
  await page.click("#composer-path-url");
  await page.fill("#composer-input", "https://arxiv.org/abs/1234.5678");
  await page.click("#composer-primary");
  await waitForCanvasText(page, "Proxy fallback article");
  assert(directArticleCalls >= 1, "direct ar5iv fetch should be attempted before proxy fallback");
  assert(proxyCalls >= 1, "proxy fallback should be used after direct fetch is blocked");
  const urlHole = await page.evaluate(async () => {
    const raw = await window.__rabbitholeTest.readStoredHole();
    return JSON.stringify(raw);
  });
  assert(urlHole.includes("Proxy fallback article"));
  assert(urlHole.includes("https://arxiv.org/abs/1234.5678") || urlHole.includes("ar5iv.labs.arxiv.org"));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await setFetchProxy(page, `${baseUrl}/dead-proxy`);
  await page.click("#t-new");
  await page.click("#composer-path-url");
  await page.fill("#composer-input", "https://arxiv.org/abs/9999.0000");
  await page.click("#composer-primary");
  await page.waitForSelector("#ingest-status.error");
  const deadError = await page.textContent("#ingest-status");
  assert.match(deadError, /Try another link or open a PDF/i);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await setFetchProxy(page, `${baseUrl}/reject-proxy`);
  await page.click("#t-new");
  await page.click("#composer-path-url");
  await page.fill("#composer-input", "https://arxiv.org/abs/7777.7777");
  await page.click("#composer-primary");
  await page.waitForSelector("#ingest-status.error");
  const rejectError = await page.textContent("#ingest-status");
  assert.match(rejectError, /isn't supported by the link relay yet/i);
  assert.match(rejectError, /arXiv links work best/);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "broken.HtMl", mimeType: "", buffer: Buffer.from("not a snapshot") });
  await page.waitForSelector("#ingest-status.error");
  assert.match(await page.textContent("#ingest-status"), /Snapshot import failed/i);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "Notes.Md", mimeType: "", buffer: Buffer.from("# Mixed-case markdown\n\nEmpty MIME markdown classified.") });
  await waitForCanvasText(page, "Empty MIME markdown classified.");

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "evil.html.txt", mimeType: "text/plain", buffer: Buffer.from("evil suffix remains text") });
  await waitForCanvasText(page, "evil suffix remains text");

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await page.evaluate(() => {
    const file = new File([new Uint8Array(16 * 1024 * 1024 + 1)], "oversized.md", { type: "text/markdown" });
    const data = new DataTransfer();
    data.items.add(file);
    const input = document.querySelector("#file-md");
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForSelector("#ingest-status.error");
  assert.equal(await page.textContent("#ingest-status"), "Import failed: file exceeds 16 MB.");

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  const futurePortable = JSON.stringify({
    format: "rabbithole",
    format_version: 1,
    hole: { schema_version: 3, hole_id: "future-web", title: "Future", root_id: "root", created_at: null, updated_at: null, view_state: null, nodes: [] },
    assets: {},
  });
  await page.setInputFiles("#file-md", { name: "future.rabbithole", mimeType: "application/json", buffer: Buffer.from(futurePortable) });
  await page.waitForSelector("#ingest-status.error");
  assert.equal(
    await page.textContent("#ingest-status"),
    NEWER_SCHEMA_MESSAGE,
    "web import should surface the exact newer-version refusal",
  );

  console.log("web ingestion verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

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
    const content = `BT /F1 15 Tf 40 160 Td (${pdfLiteral(pageTexts[index])}) Tj ET\n`;
    objects[pageObj] =
      `${pageObj} 0 obj\n` +
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 220] ` +
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
  return [...Buffer.from(pdf, "latin1")];
}

async function dropPdf(page, bytes, name = "math-fixture.pdf", type = "application/pdf") {
  await page.evaluate(({ pdfBytes, name, type }) => {
    const file = new File([new Uint8Array(pdfBytes)], name, { type });
    const data = new DataTransfer();
    data.items.add(file);
    const target = document.querySelector("#composer-card");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, { pdfBytes: bytes, name, type });
}

async function setFetchProxy(page, url) {
  await page.evaluate((value) => {
    const settings = JSON.parse(localStorage.getItem("rh-web-settings") || "{}");
    localStorage.setItem("rh-web-settings", JSON.stringify({ ...settings, fetch_proxy_url: value }));
  }, url);
}

async function waitForCanvasText(page, text) {
  await page.locator(".node", { hasText: text }).first().waitFor();
}

function articleHtml(title) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <article>
      <h1>${title}</h1>
      <p>This article came through the mocked proxy fallback for https://arxiv.org/abs/1234.5678.</p>
      <p>It includes enough body text for conservative extraction and a relative image.</p>
      <img src="/html/assets/figure.png" alt="Relative figure">
    </article>
  </body></html>`;
}
