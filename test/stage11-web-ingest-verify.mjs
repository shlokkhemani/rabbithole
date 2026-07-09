import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB_DIST = path.join(ROOT, "web/dist");

try {
  await fs.access(path.join(WEB_DIST, "index.html"));
} catch {
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout || "build failed\n");
    process.exit(build.status || 1);
  }
}

let proxyCalls = 0;
const server = await serveStatic(WEB_DIST);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage();
const requests = [];
let directArticleCalls = 0;

page.on("request", (request) => {
  requests.push(request.url());
});

await page.route(/https:\/\/ar5iv\.labs\.arxiv\.org\/html\/.+/, async (route) => {
  directArticleCalls += 1;
  await route.abort("failed");
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#file-md");

  requests.length = 0;
  const pdfBytes = buildTinyPdf([
    "Browser PDF page one: Euler math e^(i*pi)+1=0",
    "Browser PDF page two: Integral int_0^1 x dx = 1/2",
  ]);
  await dropPdf(page, pdfBytes);
  await page.waitForSelector(".doc-content[data-node-id] img");
  await page.waitForSelector("text=Euler math");
  await page.waitForSelector("text=Integral int_0^1");
  await page.waitForFunction(() => {
    const img = document.querySelector(".doc-content[data-node-id] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });

  const externalDuringPdf = requests.filter((url) => !url.startsWith(baseUrl) && !url.startsWith("blob:"));
  assert.deepEqual(externalDuringPdf, [], `PDF ingest made external request(s): ${externalDuringPdf.join(", ")}`);

  const pdfState = await page.evaluate(async () => {
    const holeId = window.__rhWebApp.currentHoleId();
    const assets = await window.__rhWebApp.store.listAssets(holeId);
    const sizes = {};
    for (const name of assets) sizes[name] = (await window.__rhWebApp.store.getAsset(holeId, name)).size;
    const raw = await window.__rhWebApp.readRawHole(holeId);
    return { assets, sizes, raw: JSON.stringify(raw) };
  });
  assert.deepEqual(pdfState.assets, ["page-001.png", "page-002.png"]);
  assert(pdfState.sizes["page-001.png"] > 100, "page-001.png should be stored as a non-empty Blob");
  assert(pdfState.raw.includes("asset:page-001.png"));
  assert(pdfState.raw.includes("Browser PDF page one"));
  assert(pdfState.raw.includes("Integral int_0^1"));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await openAdvancedSettings(page);
  await page.fill("#fetch-proxy-url", `${baseUrl}/proxy`);
  await page.click("#save-settings");
  await page.fill("#open-url-input", "https://arxiv.org/abs/1234.5678");
  await page.click("#open-url");
  await page.waitForSelector("text=Proxy fallback article");
  assert(directArticleCalls >= 1, "direct ar5iv fetch should be attempted before proxy fallback");
  assert(proxyCalls >= 1, "proxy fallback should be used after direct fetch is blocked");
  const urlHole = await page.evaluate(async () => {
    const raw = await window.__rhWebApp.readRawHole();
    return JSON.stringify(raw);
  });
  assert(urlHole.includes("Proxy fallback article"));
  assert(urlHole.includes("https://arxiv.org/abs/1234.5678") || urlHole.includes("ar5iv.labs.arxiv.org"));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await openAdvancedSettings(page);
  await page.fill("#fetch-proxy-url", `${baseUrl}/dead-proxy`);
  await page.click("#save-settings");
  await page.fill("#open-url-input", "https://arxiv.org/abs/9999.0000");
  await page.click("#open-url");
  await page.waitForSelector("#ingest-status.error");
  const deadError = await page.textContent("#ingest-status");
  assert.match(deadError, /Paste the content manually or drop a PDF/i);

  console.log("stage11 web ingestion verification passed");
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

async function dropPdf(page, bytes) {
  await page.evaluate((pdfBytes) => {
    const file = new File([new Uint8Array(pdfBytes)], "math-fixture.pdf", { type: "application/pdf" });
    const data = new DataTransfer();
    data.items.add(file);
    const target = document.querySelector(".new-hole");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, bytes);
}

async function openAdvancedSettings(page) {
  await page.locator(".settings-advanced summary").click();
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

async function serveStatic(rootDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/proxy") {
      proxyCalls += 1;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(articleHtml("Proxy fallback article"));
      return;
    }
    if (url.pathname === "/dead-proxy") {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("proxy unavailable");
      return;
    }

    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(rootDir, rel);
    if (!file.startsWith(rootDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
      res.end(bytes);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  if (file.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}
