import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractSnapshotPayload } from "../../src/core/portable-import.js";
import { FsStore } from "../../src/node/fs-store.js";
import { importRabbitholeFile } from "../../src/web/portable.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const LEGACY = path.join(ROOT, "test/fixtures/corpus/10-schema-null-legacy.rabbithole");
const SECRET_KEYS = ["api_key", "apiKey", "provider_keys", "rh-web-settings", "sk-or-v1-"];
const ASSET_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zs1sAAAAASUVORK5CYII=", "base64");
const MODERN_MARKDOWN = [
  "# Journey root", "", "Select this exact phrase for the branch.", "", "Inline math $a^2+b^2=c^2$.", "",
  "```show", "<div class=\"journey-show\">A real show fence</div>", "```", "",
  "![journey asset](asset:journey.png)",
].join("\n");
const BRANCH_MARKDOWN = "First streamed paragraph.\n\nSecond final paragraph with $x+y$.";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage19-"));
const assetPath = path.join(tmp, "journey.png");
await fs.writeFile(assetPath, ASSET_BYTES);
const server = await serveStatic(WEB_DIST);
const webUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
  await modernJourney();
  await temporalJourney();
  console.log("stage19 journey verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

async function modernJourney() {
  const authorDir = await fs.mkdtemp(path.join(tmp, "modern-author-"));
  const mcp = await startMcp(authorDir);
  let authorContext;
  try {
    const openPromise = callTool(mcp.client, "open_rabbithole", {
      title: "Modern journey", content: MODERN_MARKDOWN,
      assets: [{ name: "journey.png", file_path: assetPath }],
    });
    const liveUrl = await mcp.nextUrl();
    authorContext = await browser.newContext({ acceptDownloads: true });
    const page = await authorContext.newPage();
    await page.goto(liveUrl);
    await assertRendered(page, "Select this exact phrase", true);
    await selectAndAsk(page, "Select this exact phrase", "Explain the selected phrase");
    const branch = await openPromise;
    assert.equal(branch.status, "branch_request", `modern MCP open result: ${JSON.stringify(branch)}`);
    assert.equal(branch.selected_text, "Select this exact phrase");
    await streamAnswer(mcp.client, branch, "Modern branch");
    await page.click("#r-canvas");
    await page.locator(".doc-content", { hasText: "Second final paragraph" }).waitFor();

    const snapshotPath = await downloadShare(page, "#sm-export", "modern-snapshot.html");
    const snapshotText = await fs.readFile(snapshotPath, "utf8");
    const snapshot = JSON.parse(extractSnapshotPayload(snapshotText));
    assertProjection(snapshot, { title: "Modern journey", rootMarkdown: MODERN_MARKDOWN, branchMarkdown: BRANCH_MARKDOWN, asset: ASSET_BYTES, stripExtensions: true });
    const canonicalRoot = snapshot.hole.nodes.find((node) => node.id === snapshot.hole.root_id).markdown;

    const webContext = await browser.newContext({ acceptDownloads: true });
    try {
      const webPage = await webContext.newPage();
      await webPage.goto(webUrl);
      await webPage.setInputFiles("#file-md", snapshotPath);
      await assertRendered(webPage, "Second final paragraph", true);
      const stored = await webPage.evaluate(() => window.__rabbitholeTest.readStoredHole());
      assertHole(stored, "Modern journey", canonicalRoot, BRANCH_MARKDOWN);
      const portablePath = await downloadShare(webPage, "#sm-portable", "modern.rabbithole");
      const portableText = await fs.readFile(portablePath, "utf8");
      assertNoCredentials(portableText, "modern portable");
      assertProjection(JSON.parse(portableText), { title: "Modern journey", rootMarkdown: canonicalRoot, branchMarkdown: BRANCH_MARKDOWN, asset: ASSET_BYTES });
      await resumePortableOverMcp(portableText, "modern-resume", "Modern journey", canonicalRoot, BRANCH_MARKDOWN);
    } finally { await webContext.close(); }
    console.log("ok stage19 C1: modern MCP → live branch → snapshot → web import → portable → MCP resume journey");
  } finally {
    await authorContext?.close();
    await mcp.close();
  }
}

async function temporalJourney() {
  const legacyPath = path.join(tmp, "legacy.rabbithole");
  await fs.copyFile(LEGACY, legacyPath);
  const first = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await first.newPage();
    await page.goto(webUrl);
    await page.setInputFiles("#file-md", legacyPath);
    await assertRendered(page, "Legacy defaults are backfilled", false);
    const imported = await page.evaluate(() => window.__rabbitholeTest.readStoredHole());
    assert.equal(imported.schema_version, 2, `legacy import schema: ${JSON.stringify(imported)}`);
    const snapshotPath = await downloadShare(page, "#sm-export", "legacy-snapshot.html");
    const snapshot = JSON.parse(extractSnapshotPayload(await fs.readFile(snapshotPath, "utf8")));
    assert.equal(snapshot.hole.schema_version, 2);
    assert.equal(snapshot.hole.nodes[0].markdown, "Legacy defaults are backfilled");

    const second = await browser.newContext({ acceptDownloads: true });
    try {
      const page2 = await second.newPage();
      await page2.goto(webUrl);
      await page2.setInputFiles("#file-md", snapshotPath);
      await assertRendered(page2, "Legacy defaults are backfilled", false);
      const reimported = await page2.evaluate(() => window.__rabbitholeTest.readStoredHole());
      assert.equal(reimported.schema_version, 2);
      assert.equal(reimported.nodes[0].markdown, "Legacy defaults are backfilled");
      const portablePath = await downloadShare(page2, "#sm-portable", "legacy.rabbithole");
      const portableText = await fs.readFile(portablePath, "utf8");
      const portable = JSON.parse(portableText);
      assert.equal(portable.hole.schema_version, 2);
      assert.equal(portable.hole.nodes[0].markdown, "Legacy defaults are backfilled");
      assertNoCredentials(portableText, "legacy portable");
      await resumePortableOverMcp(portableText, "legacy-resume", "Null schema legacy", "Legacy defaults are backfilled", null);
    } finally { await second.close(); }
    console.log("ok stage19 C1: v0.1 import → web → snapshot → web import → portable → MCP resume journey");
  } finally { await first.close(); }
}

async function resumePortableOverMcp(text, prefix, title, rootMarkdown, branchMarkdown) {
  const dir = await fs.mkdtemp(path.join(tmp, `${prefix}-`));
  const previousDir = process.env.RABBITHOLE_DIR;
  process.env.RABBITHOLE_DIR = dir;
  const store = new FsStore();
  const imported = await importRabbitholeFile(store, text);
  const saved = await store.loadHole(imported.hole_id);
  if (previousDir === undefined) delete process.env.RABBITHOLE_DIR; else process.env.RABBITHOLE_DIR = previousDir;
  assert.equal(saved.schema_version, 2);
  const mcp = await startMcp(dir);
  const context = await browser.newContext();
  try {
    const resumePromise = callTool(mcp.client, "open_rabbithole", { hole_id: imported.hole_id });
    const page = await context.newPage();
    await page.goto(await mcp.nextUrl());
    const selection = rootMarkdown.includes("Select this exact phrase") ? "Select this exact phrase" : "Legacy defaults are backfilled";
    await selectAndAsk(page, selection, "Rehydrate this tree");
    const request = await resumePromise;
    assert.equal(request.status, "branch_request", `resume result: ${JSON.stringify(request)}`);
    assert(request.rehydration, `first resumed request lacks rehydration: ${JSON.stringify(request)}`);
    assert.equal(JSON.stringify(request.rehydration).includes("extensions"), false, `rehydration leaked extensions: ${JSON.stringify(request.rehydration)}`);
    assertNoCredentials(JSON.stringify(request), `${prefix} rehydration`);
    const nodes = request.rehydration.nodes;
    assert.equal(request.rehydration.title, title);
    assert.equal(nodes[0].markdown, rootMarkdown, `rehydrated root markdown: ${JSON.stringify(nodes[0])}`);
    if (branchMarkdown) assert(nodes.some((node) => node.title === "Modern branch" && node.markdown === branchMarkdown), `rehydrated branch mismatch: ${JSON.stringify(nodes)}`);
    await streamAnswer(mcp.client, request, "Resume answer");
  } finally { await context.close(); await mcp.close(); }
}

async function startMcp(dir) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, "bin/mcp-server.js")], cwd: ROOT, stderr: "pipe",
    env: { ...process.env, RABBITHOLE_DIR: dir, RABBITHOLE_NO_BROWSER: "1", RABBITHOLE_MAX_BLOCK_MS: "2000" },
  });
  let stderr = "";
  const urls = [];
  const waiters = [];
  transport.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    for (const match of chunk.toString().matchAll(/listening at (http:\/\/127\.0\.0\.1:\d+)/g)) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(match[1]); else urls.push(match[1]);
    }
  });
  const client = new Client({ name: "stage19-journey", version: "1" });
  await client.connect(transport);
  return {
    client,
    nextUrl: () => urls.length ? Promise.resolve(urls.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP canvas URL timeout; stderr=${stderr}`)), 5000);
      waiters.push({ resolve: (url) => { clearTimeout(timer); resolve(url); } });
    }),
    close: async () => { await client.close(); },
  };
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
  assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
}

async function selectAndAsk(page, phrase, question) {
  await page.locator(".doc-content:visible", { hasText: phrase }).first().waitFor();
  const selected = await page.evaluate((needle) => {
    const root = [...document.querySelectorAll(".doc-content")].find((el) => el.offsetParent !== null && el.textContent.includes(needle));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.indexOf(needle);
      if (index >= 0) { const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + needle.length); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return sel.toString(); }
    }
    return "";
  }, phrase);
  assert.equal(selected, phrase, `selection mismatch: ${JSON.stringify({ selected, phrase })}`);
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", question);
  await page.press("#ask-text", "Enter");
}

async function streamAnswer(client, request, title) {
  const split = BRANCH_MARKDOWN.indexOf("\n\n") + 2;
  const partial = await callTool(client, "answer_branch", { session_id: request.session_id, request_id: request.request_id, content: BRANCH_MARKDOWN.slice(0, split), partial: true });
  assert.equal(partial.partial, true);
  const final = await callTool(client, "answer_branch", { session_id: request.session_id, request_id: request.request_id, title, content: BRANCH_MARKDOWN.slice(split) });
  assert.equal(final.status, "keep_listening", `final answer result: ${JSON.stringify(final)}`);
}

async function downloadShare(page, selector, filename) {
  await page.click(await page.locator("#t-share:visible").count() ? "#t-share" : "#r-share");
  const pending = page.waitForEvent("download");
  await page.click(selector);
  const download = await pending;
  const target = path.join(tmp, `${Date.now()}-${filename}`);
  await download.saveAs(target);
  return target;
}

async function assertRendered(page, text, expectAsset) {
  try {
    await page.locator(".doc-content:visible", { hasText: text }).first().waitFor({ timeout: 10000 });
  } catch (error) {
    throw new Error(`canvas did not render ${JSON.stringify(text)} at ${page.url()}; body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 1200))}`, { cause: error });
  }
  if (expectAsset) await page.waitForFunction(() => { const img = document.querySelector(".doc-content img"); return img?.complete && img.naturalWidth > 0; });
}

function assertProjection(projection, expected) {
  assert.equal(projection.hole.schema_version, 2);
  assertHole(projection.hole, expected.title, expected.rootMarkdown, expected.branchMarkdown);
  assert.deepEqual(Buffer.from(projection.assets["journey.png"], "base64"), expected.asset, `asset bytes differ: ${projection.assets["journey.png"]}`);
  if (expected.stripExtensions) assert(projection.hole.nodes.every((node) => !Object.hasOwn(node, "extensions")), `snapshot projection leaked extensions: ${JSON.stringify(projection.hole.nodes)}`);
  assertNoCredentials(JSON.stringify(projection), "projection");
}

function assertHole(hole, title, rootMarkdown, branchMarkdown) {
  assert.equal(hole.title, title);
  const actualRoot = hole.nodes.find((node) => node.id === hole.root_id)?.markdown;
  if (rootMarkdown === MODERN_MARKDOWN) {
    assert.equal(actualRoot.replace(/```show id=[a-z0-9]{4,8}\n/, "```show\n"), rootMarkdown, `root markdown mismatch after documented block-id mint: ${JSON.stringify(hole.nodes)}`);
  } else assert.equal(actualRoot, rootMarkdown, `root markdown mismatch: ${JSON.stringify(hole.nodes)}`);
  if (branchMarkdown) assert(hole.nodes.some((node) => node.title === "Modern branch" && node.markdown === branchMarkdown), `branch mismatch: ${JSON.stringify(hole.nodes)}`);
}

function assertNoCredentials(text, label) {
  for (const key of SECRET_KEYS) assert.equal(text.includes(key), false, `${label} contains credential marker ${key}`);
}

async function serveStatic(root) {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.join(root, relative);
    try { res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }); res.end(await fs.readFile(file)); } catch { res.statusCode = 404; res.end("not found"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}
