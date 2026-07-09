import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
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

const server = await serveStatic(WEB_DIST);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage();
const requests = [];
let providerCalls = 0;

page.on("request", (request) => {
  requests.push(request.url());
});

await page.route(PROVIDER_URL, async (route) => {
  const request = route.request();
  if (request.method() === "OPTIONS") {
    await route.fulfill({
      status: 204,
      headers: corsHeaders(),
      body: "",
    });
    return;
  }
  providerCalls += 1;
  const body = providerCalls === 1
    ? sse([
        "TITLE: Euler branch\n",
        "Euler identity connects rotation, growth, and zero in one compact statement.\n\n",
        "```show\n<style>.flow{display:grid;gap:8px}.box{border:1px solid var(--border);padding:8px;border-radius:6px}</style><div class='flow'><div class='box'>rotation</div><div class='box'>cancellation</div></div>\n```\n",
      ])
    : sse([
        "TITLE: Deeper link\n",
        "Second branch explains the geometric view: multiplication by $e^{i\\theta}$ rotates a point on the complex plane.",
      ]);
  await route.fulfill({
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body,
  });
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.selectOption("#provider-preset", "openrouter");
  await page.fill("#api-key", MOCK_KEY);
  await page.check("#session-only");
  await page.click("#save-settings");

  const markdown = [
    "# Web Smoke",
    "",
    "Euler identity $e^{i\\pi}+1=0$ ties exponentials to geometry.",
    "",
    "```js",
    "console.log('math branch');",
    "```",
    "",
    "```show",
    "<style>.flow{display:grid;gap:8px}.box{border:1px solid var(--border);padding:8px;border-radius:6px}</style>",
    "<div class='flow'><div class='box'>Select</div><div class='box' style='background:var(--hl)'>Ask</div></div>",
    "```",
  ].join("\n");

  await page.fill("#new-title", "Web Smoke");
  await page.fill("#paste-md", markdown);
  await page.click("#create-hole");
  await page.waitForSelector(".doc-content[data-node-id]");
  await page.waitForSelector(".katex");
  await page.waitForSelector(".hljs");
  await page.waitForSelector(".viz-show");
  const synthModes = await page.$$eval("#synth-mode option", (options) => options.map((option) => option.value));
  assert.deepEqual(synthModes, ["synthesis", "question_map"]);

  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Why does this matter?");
  await page.click("#ask-go");
  await page.waitForSelector(".side-item:not(.pending)");
  await page.click(".side-item:not(.pending)");
  await page.waitForSelector("text=Euler identity connects rotation");
  assert.equal(providerCalls, 1);

  await page.fill("#composer-text", "Go one layer deeper.");
  await page.click("#composer-send");
  await page.waitForSelector("text=Second branch explains the geometric view");
  assert.equal(providerCalls, 2);

  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rhWebApp && !!document.querySelector(".doc-content[data-node-id]"));
  const reloadedRaw = await page.evaluate(() => window.__rhWebApp.readRawHole().then((hole) => JSON.stringify(hole)));
  assert(reloadedRaw.includes("Euler identity connects rotation"));
  assert(reloadedRaw.includes("Second branch explains the geometric view"));
  if (await page.locator("text=Euler identity connects rotation").count() === 0) {
    await page.click(".side-item:not(.pending)");
  }
  await page.waitForSelector("text=Euler identity connects rotation");
  await page.waitForSelector("text=Second branch explains the geometric view");

  const snapshotHtml = await page.evaluate(() => window.__rhWebApp.exportSnapshotForTest());
  assert(snapshotHtml.includes("Euler identity connects rotation"));
  assert(snapshotHtml.includes("Second branch explains the geometric view"));
  assert(!snapshotHtml.includes(MOCK_KEY), "snapshot export must not contain provider key");

  const snapshotJson = await page.evaluate(() => window.__rhWebApp.exportSnapshotJsonForTest());
  assert.equal(snapshotJson.format, "rabbithole-session-json");
  assert.equal(snapshotJson.format_version, 1);
  assert.equal(snapshotJson.session.title, "Web Smoke");
  assert(JSON.stringify(snapshotJson).includes("Second branch explains the geometric view"));
  assert(!JSON.stringify(snapshotJson).includes(MOCK_KEY), "session JSON export must not contain provider key");

  const rawHoleJson = await page.evaluate(() => window.__rhWebApp.readRawHole().then((hole) => JSON.stringify(hole)));
  assert(rawHoleJson.includes("Second branch explains the geometric view"));
  assert(!rawHoleJson.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");

  const persistedKey = await page.evaluate(() => localStorage.getItem("rh-web-api-key"));
  assert.equal(persistedKey, null, "session-only key must not be stored in localStorage");
  assert(!page.url().includes(MOCK_KEY), "URL must not contain provider key");

  const external = requests.filter((url) => !url.startsWith(baseUrl));
  assert(external.length > 0, "provider should have been called");
  assert(external.every((url) => url === PROVIDER_URL), `unexpected external request(s): ${external.join(", ")}`);

  console.log("stage10 web verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
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

async function selectText(page, needle) {
  await page.evaluate((text) => {
    const root = document.querySelector(".doc-content[data-node-id]");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(text);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 120, clientY: 160 }));
      return;
    }
    throw new Error(`Text not found: ${text}`);
  }, needle);
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
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}
