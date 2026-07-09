import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB_DIST = path.join(ROOT, "web/dist");
const MOCK_KEY = "rh_mock_key_DO_NOT_LEAK";
const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";

try {
  await fs.access(path.join(WEB_DIST, "index.html"));
} catch {
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout || "build failed\n");
    process.exit(build.status || 1);
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage12-"));
const server = await serveStatic(WEB_DIST);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let authorCalls = 0;
  await page.route(PROVIDER_URL, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
      return;
    }
    authorCalls += 1;
    const body = JSON.parse(route.request().postData() || "{}");
    assert.equal(body.model, "anthropic/claude-sonnet-5");
    assert.match(JSON.stringify(body.messages), /Source content/);
    await route.fulfill({
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
      },
      body: sse([
        "# Authored Structure\n\n",
        "This document was streamed through the author model.\n\n",
        "```js\nconsole.log('authored');\n```",
      ]),
    });
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await assertHomePolish(page);
  await page.selectOption("#provider-preset", "openrouter");
  await page.fill("#api-key", MOCK_KEY);
  await page.check("#session-only");
  await page.click("#save-settings");

  await page.check("#improve-structure");
  await page.fill("#new-title", "Author Check");
  await page.fill("#paste-md", "raw notes about a streamed authoring pass");
  await page.click("#create-hole");
  await page.waitForSelector("text=This document was streamed through the author model");
  assert.equal(authorCalls, 1, "Improve structure should call authorDocument once");

  await page.click("#web-home");
  await page.waitForSelector("#file-md");
  await page.uncheck("#improve-structure");

  const pdfBytes = buildTinyPdf(["Portable asset page: import should render this PNG asset."]);
  await dropPdf(page, pdfBytes);
  await page.waitForSelector(".doc-content[data-node-id] img");
  await page.waitForSelector("text=Portable asset page");
  await page.waitForFunction(() => {
    const img = document.querySelector(".doc-content[data-node-id] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });

  const original = await page.evaluate(async () => {
    const holeId = window.__rhWebApp.currentHoleId();
    const raw = await window.__rhWebApp.readRawHole(holeId);
    const assets = await window.__rhWebApp.store.listAssets(holeId);
    const sizes = {};
    for (const name of assets) sizes[name] = (await window.__rhWebApp.store.getAsset(holeId, name)).size;
    return { holeId, raw, assets, sizes };
  });
  assert.deepEqual(original.assets, ["page-001.png"]);
  assert(original.sizes["page-001.png"] > 100, "PDF page asset should be non-empty");

  const sessionJsonPath = path.join(tmp, "pdf-document-session.json");
  const sessionJson = await page.evaluate(() => window.__rhWebApp.exportSnapshotJsonForTest());
  assert.equal(sessionJson.format, "rabbithole-session-json");
  assert.equal(typeof sessionJson.session.asset_data["page-001.png"], "string");
  await fs.writeFile(sessionJsonPath, `${JSON.stringify(sessionJson, null, 2)}\n`);

  const shareDownloadPromise = page.waitForEvent("download");
  await page.click("#r-share");
  await page.click("#sm-portable");
  const shareDownload = await shareDownloadPromise;
  const shareExportPath = path.join(tmp, shareDownload.suggestedFilename());
  await shareDownload.saveAs(shareExportPath);
  assert.equal(path.extname(shareExportPath), ".rabbithole");

  const exportText = await fs.readFile(shareExportPath, "utf8");
  assert(!exportText.includes(MOCK_KEY), "share .rabbithole export must not contain provider key material");
  const exported = JSON.parse(exportText);
  assert.equal(exported.format, "rabbithole");
  assert.equal(exported.format_version, 1);
  assert.equal(exported.hole.schema_version, 1);
  assert.equal(typeof exported.assets["page-001.png"], "string");

  await page.click("#web-home");
  await page.waitForSelector("#hole-list");
  const homeDownloadPromise = page.waitForEvent("download");
  await page.locator(".hole-row", { hasText: "pdf document" }).first().locator(".hole-export").click();
  const homeDownload = await homeDownloadPromise;
  assert.match(homeDownload.suggestedFilename(), /^pdf-document\.rabbithole$/);

  const fresh = await browser.newContext({ acceptDownloads: true });
  const importPage = await fresh.newPage();
  await importPage.goto(baseUrl, { waitUntil: "networkidle" });
  await importPage.setInputFiles("#file-md", shareExportPath);
  await importPage.waitForSelector(".doc-content[data-node-id] img");
  await importPage.waitForSelector("text=Portable asset page");
  await importPage.waitForFunction(() => {
    const img = document.querySelector(".doc-content[data-node-id] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });

  const imported = await importPage.evaluate(async () => {
    const holeId = window.__rhWebApp.currentHoleId();
    const raw = await window.__rhWebApp.readRawHole(holeId);
    const assets = await window.__rhWebApp.store.listAssets(holeId);
    const sizes = {};
    for (const name of assets) sizes[name] = (await window.__rhWebApp.store.getAsset(holeId, name)).size;
    return { holeId, raw, assets, sizes };
  });
  assert.deepEqual(projectHole(imported.raw), projectHole(original.raw));
  assert.deepEqual(imported.assets, original.assets);
  assert.equal(imported.sizes["page-001.png"], original.sizes["page-001.png"]);

  await fresh.close();

  const jsonFresh = await browser.newContext({ acceptDownloads: true });
  const jsonImportPage = await jsonFresh.newPage();
  await jsonImportPage.goto(baseUrl, { waitUntil: "networkidle" });
  await jsonImportPage.setInputFiles("#file-md", sessionJsonPath);
  await jsonImportPage.waitForSelector(".doc-content[data-node-id] img");
  await jsonImportPage.waitForSelector("text=Portable asset page");
  await jsonImportPage.waitForFunction(() => {
    const img = document.querySelector(".doc-content[data-node-id] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });

  const jsonImported = await jsonImportPage.evaluate(async () => {
    const holeId = window.__rhWebApp.currentHoleId();
    const raw = await window.__rhWebApp.readRawHole(holeId);
    const assets = await window.__rhWebApp.store.listAssets(holeId);
    const sizes = {};
    for (const name of assets) sizes[name] = (await window.__rhWebApp.store.getAsset(holeId, name)).size;
    return { holeId, raw, assets, sizes };
  });
  assert.deepEqual(projectHole(jsonImported.raw), projectHole(original.raw));
  assert.deepEqual(jsonImported.assets, original.assets);
  assert.equal(jsonImported.sizes["page-001.png"], original.sizes["page-001.png"]);

  await jsonFresh.close();
  await context.close();
  console.log("stage12 portability verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

async function assertHomePolish(page) {
  await page.waitForSelector("#settings-panel");
  const walkthroughCount = await page.locator("text=30-second OpenRouter key walkthrough").count();
  assert.equal(walkthroughCount, 1, "OpenRouter walkthrough link should appear exactly once");
  const emptyInList = await page.locator("#hole-list", { hasText: "No saved holes yet." }).count();
  assert.equal(emptyInList, 1, "saved-holes empty state should stay in the list area");
  const selectState = await page.$eval("#provider-preset", (select) => ({
    label: select.options[select.selectedIndex]?.textContent || "",
    width: select.getBoundingClientRect().width,
  }));
  assert.equal(selectState.label, "OpenRouter (recommended)");
  assert(selectState.width >= 220, `provider select should be wide enough, got ${selectState.width}`);
}

function projectHole(hole) {
  return {
    title: hole.title,
    root_id: hole.root_id,
    view_state: comparableViewState(hole),
    nodes: hole.nodes.map((node) => ({
      id: node.id,
      parent_id: node.parent_id,
      title: node.title,
      markdown: node.markdown,
      base_url: node.base_url,
      base_url_source: node.base_url_source,
      origin: node.origin,
      position: node.position,
      size: comparableNodeSize(node, hole),
      font_scale: node.font_scale,
      collapsed: node.collapsed,
      status: node.status,
      read: node.read,
    })),
  };
}

function comparableNodeSize(node, hole) {
  const size = node.size;
  if (!size) return null;
  const defaults = node.id === hole.root_id ? { w: 480, h: 580 } : { w: 420, h: 460 };
  const isDefaultSize = Number(size.w) === defaults.w && Number(size.h) === defaults.h;
  return isDefaultSize ? null : size;
}

function comparableViewState(hole) {
  const state = hole.view_state;
  if (!state) return null;
  const view = state.view || {};
  const isDefaultReaderLanding =
    state.mode === "reader" &&
    state.node_id === hole.root_id &&
    (Number(state.scroll) || 0) === 0 &&
    (Number(view.x) || 0) === 0 &&
    (Number(view.y) || 0) === 0 &&
    (Number(view.scale) || 1) === 1;
  return isDefaultReaderLanding ? null : state;
}

function sse(chunks) {
  return chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, http-referer, x-title",
  };
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
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 440 220] ` +
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
    const file = new File([new Uint8Array(pdfBytes)], "pdf-document.pdf", { type: "application/pdf" });
    const data = new DataTransfer();
    data.items.add(file);
    const target = document.querySelector(".new-hole");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, bytes);
}

async function serveStatic(rootDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
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
