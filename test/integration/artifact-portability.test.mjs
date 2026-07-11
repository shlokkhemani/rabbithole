import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const MOCK_KEY = `sk-or-v1-${"x".repeat(64)}`;
const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY_URL = "https://openrouter.ai/api/v1/key";

try {
  await fs.access(path.join(WEB_DIST, "index.html"));
} catch {
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout || "build failed\n");
    process.exit(build.status || 1);
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-artifact-portability-"));
const server = await serveStatic(WEB_DIST);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let authorCalls = 0;
  await page.route(KEY_URL, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ data: { label: "test key" } }),
    });
  });
  // Opening settings warms the OpenRouter model catalog; keep this test offline.
  await page.route("https://openrouter.ai/api/v1/models", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ data: [
        { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" } },
      ] }),
    });
  });
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
  await assertShellPolish(page);
  await page.click("#t-settings");
  await page.fill("#api-key", MOCK_KEY);
  await page.press("#api-key", "Enter");
  await page.waitForSelector("#api-key-status.valid");
  await page.click("#complete-model-setup");
  await page.waitForSelector("#web-settings-popover", { state: "detached" });

  await page.evaluate(() => window.__rabbitholeTest.createDocument(
    "# Author Check\n\nraw notes about a streamed authoring pass",
    { improveStructure: true },
  ));
  await waitForCanvasText(page, "This document was streamed through the author model");
  assert.equal(authorCalls, 1, "Improve structure should call authorDocument once");

  await page.click("#t-new");

  const pdfBytes = buildTinyPdf(["Portable asset page: import should render this PNG asset."]);
  await dropPdf(page, pdfBytes);
  await page.waitForSelector(".node .doc-content[data-node-id] img");
  await waitForCanvasText(page, "Portable asset page");
  await page.waitForFunction(() => {
    const img = document.querySelector(".node .doc-content[data-node-id] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });

  const original = await page.evaluate(async () => {
    const holeId = window.__rabbitholeTest.currentHoleId();
    const raw = await window.__rabbitholeTest.readStoredHole(holeId);
    const { names: assets, sizes } = await window.__rabbitholeTest.inspectAssets(holeId);
    return { holeId, raw, assets, sizes };
  });
  assert.deepEqual(original.assets, ["page-001.png"]);
  assert(original.sizes["page-001.png"] > 100, "PDF page asset should be non-empty");

  const shareDownloadPromise = page.waitForEvent("download");
  await page.click("#t-share");
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
  assert.equal(exported.hole.schema_version, 2);
  assert.equal(typeof exported.assets["page-001.png"], "string");

  await ensureRailOpen(page);
  assert.equal(await page.locator(".rail-row", { hasText: "pdf document" }).first().locator(".rail-export").count(), 1);
  await page.locator(`.rail-row[data-hole="${original.holeId}"]`).hover();
  const homeDownloadPromise = page.waitForEvent("download");
  await page.locator(`.rail-row[data-hole="${original.holeId}"] .rail-export`).click();
  const homeDownload = await homeDownloadPromise;
  assert.match(homeDownload.suggestedFilename(), /^pdf-document\.rabbithole$/);

  const fresh = await browser.newContext({ acceptDownloads: true });
  const importPage = await fresh.newPage();
  await importPage.goto(baseUrl, { waitUntil: "networkidle" });
  await importPage.setInputFiles("#file-md", shareExportPath);
  await importPage.waitForSelector(".node .doc-content[data-node-id] img");
  await waitForCanvasText(importPage, "Portable asset page");
  await importPage.waitForFunction(() => {
    const img = document.querySelector(".node .doc-content[data-node-id] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });

  const imported = await importPage.evaluate(async () => {
    const holeId = window.__rabbitholeTest.currentHoleId();
    const raw = await window.__rabbitholeTest.readStoredHole(holeId);
    const { names: assets, sizes } = await window.__rabbitholeTest.inspectAssets(holeId);
    return { holeId, raw, assets, sizes };
  });
  assert.deepEqual(projectHole(imported.raw), projectHole(original.raw));
  assert.deepEqual(imported.assets, original.assets);
  assert.equal(imported.sizes["page-001.png"], original.sizes["page-001.png"]);

  await fresh.close();
  await context.close();
  await verifyPublishOutput();
  console.log("artifact portability verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

async function assertShellPolish(page) {
  await page.waitForSelector("#blank-start:not([hidden])");
  assert.equal(await page.locator("#blank-start-new").isDisabled(), true, "new Rabbithole should wait for model setup");
  assert.equal(await page.locator("#toolbar #t-rail").count(), 1, "rail toggle should live in the toolbar");
  assert.equal(await page.locator("#toolbar #t-new").count(), 1, "new Rabbithole button should live in the toolbar");
  assert.equal(await page.locator(".composer-path").count(), 3, "new Rabbithole should present three clear starting paths");
  await page.click("#t-settings");
  const keyLinkCount = await page.locator(`a[href="${"https://openrouter.ai/keys"}"]`).count();
  assert.equal(keyLinkCount, 1, "OpenRouter key link should appear exactly once in settings");
  assert.equal(await page.locator("#save-settings, #web-settings-close").count(), 0, "settings should apply live without save or close buttons");
  assert.deepEqual(await page.locator(".provider-choice button").allTextContents(), ["OpenRouter", "Local"]);
  assert.equal(await page.getAttribute('[data-provider="openrouter"]', "aria-pressed"), "true");
  await page.click('[data-provider="custom"]');
  assert.equal(await page.getAttribute('[data-provider="custom"]', "aria-pressed"), "true", "provider flow should switch through the shared two-option control");
  assert.equal(await page.locator("#provider-base").count(), 1);
  await page.locator(".settings-advanced summary").click();
  assert.equal(await page.locator("#provider-base").isVisible(), true, "Local should keep only its endpoint under Connection settings");
  await page.click('[data-provider="openrouter"]');
  assert.equal(await page.locator(".settings-advanced").count(), 0, "OpenRouter should not duplicate model choices or expose link-relay plumbing");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#web-settings-popover", { state: "detached" });
}

async function waitForCanvasText(page, text) {
  await page.locator(".node", { hasText: text }).first().waitFor();
}

async function ensureRailOpen(page) {
  if (await page.getAttribute("#t-rail", "aria-expanded") !== "true") {
    await page.click("#t-rail");
  }
  await page.waitForSelector("#web-rail.open");
}

function projectHole(hole) {
  // view_state is session-local; comparing captures from two sessions races their post-open saves. Canonical portable carry-over is covered by the artifact fixed-point tests.
  return {
    title: hole.title,
    root_id: hole.root_id,
    nodes: hole.nodes.map((node) => ({
      id: node.id,
      parent_id: node.parent_id,
      title: node.title,
      markdown: node.markdown,
      base_url: node.base_url,
      base_url_source: node.base_url_source,
      origin: node.origin,
      position: node.position,
      size: node.size,
      font_scale: node.font_scale,
      collapsed: node.collapsed,
      status: node.status,
      read: node.read,
    })),
  };
}

function sse(chunks) {
  return chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    const target = document.querySelector("#composer-card");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, bytes);
}

async function verifyPublishOutput() {
  const publish = spawnSync(process.execPath, ["scripts/build-publish.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (publish.status !== 0) {
    process.stderr.write(publish.stderr || publish.stdout || "build:publish failed\n");
    process.exit(publish.status || 1);
  }
  const publishDir = path.join(ROOT, "publish");
  for (const file of ["index.html", "app.js", "styles.css", "og.jpg", "robots.txt", "llms.txt", "favicon.svg", "_redirects"]) {
    await fs.access(path.join(publishDir, file));
  }
  const redirects = await fs.readFile(path.join(publishDir, "_redirects"), "utf8");
  assert(redirects.includes("/app / 301"));
  assert(redirects.includes("/app/* /:splat 301"));
  const html = await fs.readFile(path.join(publishDir, "index.html"), "utf8");
  assert(html.includes("Rabbithole — an infinite canvas for learning"));
  const llms = await fs.readFile(path.join(publishDir, "llms.txt"), "utf8");
  assert(!llms.includes("rabbithole.ing/app"));
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
