/** @protects cross host journey capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { serveStatic } from "../support/static-server.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { extractSnapshotPayload } from "../../src/core/portable-import.js";
import { FsStore } from "../../src/node/fs-store.js";
import { importRabbitholeFile } from "../../src/web/portable.js";
import { assertCodeCopy } from "../support/code-copy.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const IMAGE_FIXTURE = path.join(ROOT, "test/integration/fixtures/fake-codex-image.mjs");
const SECRET_KEYS = ["api_key", "apiKey", "provider_keys", "rh-web-settings", "sk-or-v1-"];
const ASSET_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zs1sAAAAASUVORK5CYII=", "base64");
const JOURNEY_CODE = 'const answer = "<raw>&";\nconsole.log(answer);';
const MODERN_MARKDOWN = [
  "# Journey root", "", "Select this exact phrase for the branch.", "", "Inline math $a^2+b^2=c^2$.", "",
  "```js", JOURNEY_CODE, "```", "",
  "```show", "<div class=\"journey-show\">A real show fence</div>", "```", "",
  "![journey asset](asset:journey.png)",
].join("\n");
const BRANCH_MARKDOWN = "First streamed paragraph.\n\nSecond final paragraph with $x+y$.";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-cross-host-journey-"));
const assetPath = path.join(tmp, "journey.png");
await fs.writeFile(assetPath, ASSET_BYTES);
const server = await serveStatic(WEB_DIST, { spaFallback: true });
const webUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
  await modernJourney();
  await queuedAskJourney();
  await imageSettingJourney();
  await imageGenerationJourney();
  console.log("cross-host journey verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

async function queuedAskJourney() {
  const dir = await fs.mkdtemp(path.join(tmp, "queued-ask-"));
  const mcp = await startMcp(dir);
  const context = await browser.newContext();
  try {
    const openPromise = callTool(mcp.client, "open_rabbithole", {
      title: "Queued ask journey",
      content: "Select this exact phrase for queued answers.",
    });
    const page = await context.newPage();
    await page.goto(await mcp.nextUrl());

    await selectAndAsk(page, "Select this exact phrase", "Answer this first");
    const first = await openPromise;
    assert.equal(first.status, "branch_request");

    await selectAndAsk(page, "Select this exact phrase", "Answer this second");
    await page.locator(".ll-live", { hasText: "Waiting for previous answer" }).waitFor();

    const second = await streamAnswer(mcp.client, first, "First queued answer", page, { expectNext: true });
    assert.equal(second.status, "branch_request", `first final should receive queued request: ${JSON.stringify(second)}`);
    const secondSurface = page.locator(`.doc-content[data-node-id="${second.node_id}"]`).first();
    await secondSurface.locator(".ll-live", { hasText: "Thinking" }).waitFor();

    await streamAnswer(mcp.client, second, "Second queued answer", page);
    await secondSurface.getByText("First streamed paragraph.", { exact: false }).waitFor();

    console.log("ok cross-host journey: queued ask waits, advances to thinking, and streams normally");
  } finally {
    await context.close();
    await mcp.close();
  }
}

async function imageGenerationJourney() {
  const hangDir = await fs.mkdtemp(path.join(tmp, "image-hang-"));
  await seedImagesEnabled(hangDir);
  const hangMcp = await startMcp(hangDir, {
    RABBITHOLE_CODEX_BIN: IMAGE_FIXTURE,
    FAKE_CODEX_IMAGE_MODE: "hang",
    RABBITHOLE_IMAGE_DEADLINE_MS: "1500",
  });
  const hangContext = await browser.newContext();
  try {
    const openPromise = callTool(hangMcp.client, "open_rabbithole", {
      title: "Image generation journey",
      content: "Select this sentence before drawing.",
    });
    const page = await hangContext.newPage();
    await page.goto(await hangMcp.nextUrl());
    await selectAndAsk(page, "Select this sentence", "Draw a water cycle diagram");
    const request = await openPromise;

    const partial = await callTool(hangMcp.client, "answer_branch", {
      session_id: request.session_id,
      request_id: request.request_id,
      content: "Here is the streamed explanation.",
      partial: true,
    });
    assert.equal(partial.partial, true);
    const surface = page.locator(`.doc-content[data-node-id="${request.node_id}"]`).first();
    await surface.getByText("Here is the streamed explanation.", { exact: false }).waitFor();

    const drawingCall = hangMcp.client.callTool({
      name: "generate_image",
      arguments: {
        session_id: request.session_id,
        request_id: request.request_id,
        prompt: "A simple labelled diagram of the water cycle.",
        aspect: "landscape",
      },
    }, undefined, { timeout: 10000 });
    await surface.locator(".stream-status .ll-live", { hasText: "Drawing…" }).waitFor();
    const drawingResult = await drawingCall;
    const drawingContent = /** @type {any[]} */ (drawingResult.content);
    assert.equal(drawingResult.isError, undefined, JSON.stringify(drawingResult));
    assert.equal(drawingContent.length, 1);
    assert.deepEqual(JSON.parse(drawingContent[0].text), {
      status: "error",
      code: "timeout",
      message: "Image generation timed out.",
    });
    await surface.locator(".stream-status .ll-live", { hasText: "Writing" }).waitFor();
    console.log("ok cross-host journey: generate_image timeout shows Drawing and restores Writing");
  } finally {
    await hangContext.close();
    await hangMcp.close();
  }

  const okDir = await fs.mkdtemp(path.join(tmp, "image-ok-"));
  await seedImagesEnabled(okDir);
  const okMcp = await startMcp(okDir, {
    RABBITHOLE_CODEX_BIN: IMAGE_FIXTURE,
    FAKE_CODEX_IMAGE_MODE: "ok",
  });
  const okContext = await browser.newContext();
  try {
    const openPromise = callTool(okMcp.client, "open_rabbithole", {
      title: "Image generation success",
      content: "Select this sentence before drawing.",
    });
    const page = await okContext.newPage();
    await page.goto(await okMcp.nextUrl());
    await selectAndAsk(page, "Select this sentence", "Draw a water cycle diagram");
    const request = await openPromise;
    const partial = await callTool(okMcp.client, "answer_branch", {
      session_id: request.session_id,
      request_id: request.request_id,
      content: "The explanation comes first.",
      partial: true,
    });
    assert.equal(partial.partial, true);

    const imageResult = await okMcp.client.callTool({
      name: "generate_image",
      arguments: {
        session_id: request.session_id,
        request_id: request.request_id,
        prompt: "A simple labelled diagram of the water cycle with exactly four labels: evaporation, condensation, precipitation, collection. Clean textbook style.",
        aspect: "landscape",
        caption: "Water cycle diagram",
      },
    }, undefined, { timeout: 10000 });
    const imageContent = /** @type {any[]} */ (imageResult.content);
    assert.equal(imageResult.isError, undefined, JSON.stringify(imageResult));
    assert.equal(imageContent.length, 2);
    const imageBody = JSON.parse(imageContent[0].text);
    assert.equal(imageBody.status, "ok");
    assert.match(imageBody.markdown, /^!\[[^\]]*\]\(asset:gen-[a-z0-9]{8}\.png\)$/);
    assert.equal(imageContent[1].type, "image");
    assert.equal(imageContent[1].mimeType, "image/png");
    assert.match(imageContent[1].data, /^[A-Za-z0-9+/]+=*$/);
    const finalController = new AbortController();
    const finalAnswer = callTool(okMcp.client, "answer_branch", {
      session_id: request.session_id,
      request_id: request.request_id,
      title: "Water cycle diagram",
      content: imageBody.markdown,
    }, { signal: finalController.signal });
    const surface = page.locator(`.doc-content[data-node-id="${request.node_id}"]`).first();
    const image = surface.locator("img").first();
    await image.waitFor();
    finalController.abort();
    await assert.rejects(finalAnswer, /abort/i);
    const src = await image.getAttribute("src");
    assert.ok(src?.endsWith(`/assets/${imageBody.asset}`), `unexpected image src: ${src}`);
    await page.waitForFunction((nodeId) => {
      const image = document.querySelector(`.doc-content[data-node-id="${nodeId}"] img`);
      return image?.complete && image.naturalWidth > 0;
    }, request.node_id);
    await image.evaluate((element) => element.click());
    const lightbox = page.locator(".rh-lightbox");
    await lightbox.waitFor({ state: "visible" });
    await lightbox.locator(".rh-lightbox-caption").waitFor();
    assert.equal(await lightbox.locator(".rh-lightbox-caption-alt").innerText(), "Water cycle diagram");
    assert.equal(await lightbox.locator(".rh-lightbox-caption-prompt").count(), 1);
    console.log("ok cross-host journey: generate_image returns PNG, renders it, and opens provenance lightbox");
  } finally {
    await okContext.close();
    await okMcp.close();
  }
}

async function imageSettingJourney() {
  const offDir = await fs.mkdtemp(path.join(tmp, "image-setting-off-"));
  const offMcp = await startMcp(offDir);
  const context = await browser.newContext();
  try {
    const initialTools = await offMcp.client.listTools();
    assert.equal(initialTools.tools.some((tool) => tool.name === "generate_image"), false,
      "the default store must hide generate_image");
    assert.equal(initialTools.tools.find((tool) => tool.name === "answer_branch")?.description.includes("generate_image"), false,
      "the default answer_branch description must omit image guidance");
    assert.equal(offMcp.client.getInstructions()?.includes("generate_image"), false,
      "the default server instructions must omit image guidance");

    const openPromise = callTool(offMcp.client, "open_rabbithole", {
      title: "Image setting journey", content: "Select this sentence before changing image settings.",
    });
    const page = await context.newPage();
    const url = await offMcp.nextUrl();
    await page.goto(url);
    await selectAndAsk(page, "Select this sentence", "Explain this setting");
    await openPromise;

    const turnedOn = new Promise((resolve) => offMcp.client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
    const onResponse = await fetch(url + "/events", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "preferences_patch", values: { "rh-ai-images": "on" } }),
    });
    assert.equal(onResponse.status, 200);
    await turnedOn;
    const onTools = await offMcp.client.listTools();
    assert.equal(onTools.tools.some((tool) => tool.name === "generate_image"), true,
      "enabling AI images must add generate_image to the live tool list");
    assert.equal(onTools.tools.find((tool) => tool.name === "answer_branch")?.description.includes("generate_image"), true,
      "enabling AI images must restore answer_branch guidance");

    const turnedOff = new Promise((resolve) => offMcp.client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
    const offResponse = await fetch(url + "/events", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "preferences_patch", values: { "rh-ai-images": null } }),
    });
    assert.equal(offResponse.status, 200);
    await turnedOff;
    const offTools = await offMcp.client.listTools();
    assert.equal(offTools.tools.some((tool) => tool.name === "generate_image"), false,
      "disabling AI images must remove generate_image from the live tool list");
    assert.equal(offTools.tools.find((tool) => tool.name === "answer_branch")?.description.includes("generate_image"), false,
      "disabling AI images must remove answer_branch guidance");
    await page.close();
    console.log("ok cross-host journey: AI image discovery is off by default and flips live");
  } finally {
    await context.close();
    await offMcp.close();
  }

  const onDir = await fs.mkdtemp(path.join(tmp, "image-setting-on-"));
  await seedImagesEnabled(onDir);
  const onMcp = await startMcp(onDir);
  try {
    const tools = await onMcp.client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "generate_image"), true,
      "a pre-seeded preference must expose generate_image at startup");
    assert.equal(tools.tools.find((tool) => tool.name === "answer_branch")?.description.includes("generate_image"), true,
      "a pre-seeded preference must expose answer_branch guidance");
    assert.equal(onMcp.client.getInstructions()?.includes("generate_image"), true,
      "a pre-seeded preference must expose the image instruction sentence");
  } finally {
    await onMcp.close();
  }
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
    authorContext = await browser.newContext({
      acceptDownloads: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await authorContext.newPage();
    await page.goto(liveUrl);
    await assertRendered(page, "Select this exact phrase", true);
    await assertCodeCopy(page, { scope: ".doc-content:visible", rawCode: JOURNEY_CODE, click: true, label: "live MCP" });
    await assertSharedSettings(page, "live MCP", { canvas: true, images: true, preferencesPath: path.join(authorDir, "preferences.json") });
    await selectAndAsk(page, "Select this exact phrase", "Explain the selected phrase");
    const branch = await openPromise;
    assert.equal(branch.status, "branch_request", `modern MCP open result: ${JSON.stringify(branch)}`);
    assert.equal(branch.selected_text, "Select this exact phrase");
    assert.equal(typeof branch.hole_id, "string", "the coordinator receives the stable hole id needed to resume after delegation");
    const delegated = await callTool(mcp.client, "answer_branch", {
      session_id: branch.session_id, request_id: branch.request_id, delegated: true,
    });
    assert.equal(delegated.delegated, true);
    const pendingSurface = page.locator(`.doc-content[data-node-id="${branch.node_id}"]`).first();
    await pendingSurface.locator(".ll-live", { hasText: "Working in sub-agent…" }).waitFor();
    await streamDelegatedAnswer(mcp.client, branch, "Modern branch");
    await page.locator(".doc-content", { hasText: "Second final paragraph" }).waitFor();

    // Docked notes are a pure client feature: the MCP host takes the same
    // node_create and the snapshot must carry the note the same way.
    await selectAndNote(page, "Inline math", "A note the snapshot must keep.");
    const dockedNoteId = await page.locator(".note-dot").getAttribute("data-note");

    const snapshotPath = await downloadShare(page, "#sm-export", "modern-snapshot.html");
    const snapshotText = await fs.readFile(snapshotPath, "utf8");
    const snapshot = JSON.parse(extractSnapshotPayload(snapshotText));
    assertProjection(snapshot, { title: "Modern journey", rootMarkdown: MODERN_MARKDOWN, branchMarkdown: BRANCH_MARKDOWN, asset: ASSET_BYTES, stripExtensions: true });
    const canonicalRoot = snapshot.hole.nodes.find((node) => node.id === snapshot.hole.root_id).markdown;
    const snapshotPage = await authorContext.newPage();
    try {
      await snapshotPage.setContent(snapshotText, { waitUntil: "load" });
      await assertRendered(snapshotPage, "Select this exact phrase", true);
      await assertFrozenDockedNote(snapshotPage, dockedNoteId);
      await assertCodeCopy(snapshotPage, { scope: ".doc-content:visible", rawCode: JOURNEY_CODE, hover: false, label: "MCP snapshot" });
      // Appearance is a way of looking, so it survives into a snapshot the same
      // way collapse does — and nothing about providers ever ships with one.
      await assertSharedSettings(snapshotPage, "frozen snapshot", { canvas: false });
    } finally {
      await snapshotPage.close();
    }

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
    console.log("ok cross-host journey: modern MCP → live branch → snapshot → web import → portable → MCP resume");
  } finally {
    await authorContext?.close();
    await mcp.close();
  }
}

/* Hosts compose sections: live canvases add Canvas while frozen snapshots keep
   only the shared looking/asking preferences and never ship live maintenance. */
async function assertSharedSettings(page, label, capabilities) {
  assert.equal(await page.getAttribute("#t-settings", "aria-haspopup"), "dialog", `${label}: the gear should announce a dialog`);
  await page.click("#t-settings");
  await page.waitForSelector("#settings-sheet");
  const expectedSections = capabilities.canvas
    ? ["Appearance", "Canvas", "Quick questions", ...(capabilities.images ? ["Images"] : [])]
    : ["Appearance", "Quick questions"];
  assert.deepEqual(await page.locator("[data-settings-section]").allTextContents(), expectedSections,
    `${label}: settings sections should match the host's live capabilities`);
  /* The fixed height matters most here: with a short selected section the
     sheet must still open at the same frame every host shows — the space
     below the rows is the design, never a squat strip. */
  const frame = await page.locator("#settings-sheet").evaluate((sheet) => ({
    height: sheet.offsetHeight, // layout height: immune to the entrance scale
    expected: Math.min(480, innerHeight - 96),
  }));
  assert(Math.abs(frame.height - frame.expected) < 1, `${label}: the settings sheet must keep the fixed frame, got ${frame.height}px wanting ${frame.expected}px`);
  assert.deepEqual(await page.locator(".settings-sheet-sub").allTextContents(),
    ["What the canvas follows.", "Scales every card; each can fine-tune."],
    `${label}: both rows carry a one-line sub that describes the effect`);
  assert.deepEqual(await page.locator(".settings-sheet-identity span").allTextContents(), ["Rabbithole", "Local"],
    `${label}: the sidebar footer should name the product and the host`);
  assert.equal(await page.locator("#settings-panel, .provider-list, #api-key").count(), 0,
    `${label}: no provider code path may reach a host that never registered Model`);
  assert.deepEqual(await page.locator("[data-theme-choice]").allTextContents(), ["Light", "Dark", "System"],
    `${label}: theme should be a three-state choice`);
  await page.click('[data-theme-choice="dark"]');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark", `${label}: theme should apply live`);
  await page.click('[data-reading-step="1"]');
  assert.equal(await page.locator("[data-reading-value]").innerText(), "110%", `${label}: reading size should step`);
  assert.equal(await page.locator(".doc-content").first().evaluate((doc) => parseFloat(getComputedStyle(doc).fontSize)) >= 15, true,
    `${label}: the global reading size should reach the cards`);
  await page.click("[data-reading-reset]");
  if (capabilities.images) {
    await page.getByRole("tab", { name: "Images" }).click();
    assert.deepEqual(await page.locator(".settings-sheet-sub").allTextContents(),
      ["Your agent can draw a picture when you ask for one, using Codex image generation. Each picture costs extra tokens, so this is off by default. Needs Codex installed and signed in."],
      `${label}: the Images setting uses the specified copy`);
    const imageSwitch = page.locator("[data-ai-images-enabled]");
    assert.equal(await imageSwitch.isChecked(), false, `${label}: AI images default off`);
    await imageSwitch.check();
    await waitForPreference(capabilities.preferencesPath, (values) => values["rh-ai-images"] === "on");
    await imageSwitch.uncheck();
    await waitForPreference(capabilities.preferencesPath, (values) => !Object.hasOwn(values, "rh-ai-images"));
  }
  await page.keyboard.press("Escape");
  await page.waitForSelector("#settings-sheet", { state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-settings", `${label}: closing should restore focus to the gear`);
}

async function waitForPreference(file, predicate) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const values = JSON.parse(await fs.readFile(file, "utf8")).values;
      if (predicate(values)) return values;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("preferences.json did not reach the expected state");
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
    await selectAndAsk(page, "Select this exact phrase", "Restore this tree");
    const request = await resumePromise;
    assert.equal(request.status, "branch_request", `resume result: ${JSON.stringify(request)}`);
    assert.equal(JSON.stringify(request).includes("extensions"), false, `resume context leaked extensions: ${JSON.stringify(request)}`);
    assert.equal(JSON.stringify(request).includes("rehydration"), false, `resume used the removed full-tree payload: ${JSON.stringify(request)}`);
    assertNoCredentials(JSON.stringify(request), `${prefix} resume context`);
    assert.deepEqual(request.thread.map((node) => node.id), [saved.root_id]);
    assert.equal(request.thread[0].markdown, rootMarkdown, `resumed root markdown: ${JSON.stringify(request.thread[0])}`);
    assert.equal(request.map.nodes.find((node) => node.id === saved.root_id)?.title, title);
    if (branchMarkdown) assert(request.map.nodes.some((node) => node.title === "Modern branch"), `resume map lacks the prior branch: ${JSON.stringify(request.map)}`);
    await streamAnswer(mcp.client, request, "Resume answer", page);

    const secondPromise = callTool(mcp.client, "open_rabbithole", { hole_id: imported.hole_id });
    await selectAndAsk(page, "Select this exact phrase", "Use the same restored lineage");
    const second = await secondPromise;
    assert.equal(second.status, "branch_request");
    assert.equal(Object.hasOwn(second, "thread"), false, "a second ask on the delivered lineage omits thread");
  } finally { await context.close(); await mcp.close(); }
}

async function startMcp(dir, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, "bin/mcp-server.js")], cwd: ROOT, stderr: "pipe",
    env: { ...process.env, RABBITHOLE_DIR: dir, RABBITHOLE_NO_BROWSER: "1", ...env },
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
  const client = new Client({ name: "cross-host-journey", version: "1" });
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

async function seedImagesEnabled(dir) {
  await fs.writeFile(path.join(dir, "preferences.json"), JSON.stringify({ version: 1, values: { "rh-ai-images": "on" } }), "utf8");
}

async function callTool(client, name, args, options = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000, ...options });
  assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result)}`);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(result.content[0].text, JSON.stringify(parsed), `${name} returns compact JSON text`);
  return parsed;
}

async function selectAndAsk(page, phrase, question) {
  await selectPhrase(page, phrase);
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", question);
  await page.press("#ask-text", "Control+Enter");
}

async function selectPhrase(page, phrase) {
  await page.locator(".doc-content:visible", { hasText: phrase }).first().waitFor();
  const selected = await page.evaluate((needle) => {
    const root = [...document.querySelectorAll(".doc-content")].find((el) => el.offsetParent !== null && el.textContent.includes(needle));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.indexOf(needle);
      if (index >= 0) { const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + needle.length); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); const picked = sel.toString(); root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return picked; }
    }
    return "";
  }, phrase);
  assert.equal(selected, phrase, `selection mismatch: ${JSON.stringify({ selected, phrase })}`);
}

async function selectAndNote(page, phrase, markdown) {
  await selectPhrase(page, phrase);
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", markdown);
  await page.click('#ask .ask-commit[data-commit="note"]');
  await page.waitForSelector(".note-dot");
}

/* A frozen snapshot is a way of looking: the wash, the dot and the note itself
   survive it, while every way of changing the note is simply gone. */
async function assertFrozenDockedNote(page, noteId) {
  await page.waitForSelector(`.note-dot[data-note="${noteId}"]`);
  assert.equal(await page.locator(`mark[data-child="${noteId}"].mark-note`).count(), 1,
    "a frozen snapshot keeps the docked note's wash");
  assert.equal(await page.locator(`.card[data-id="${noteId}"]`).count(), 0,
    "a docked note must not turn into a card in a snapshot");
  await page.locator(`.note-dot[data-note="${noteId}"]`).click();
  await page.waitForSelector("#notepop.visible");
  assert.equal((await page.locator("#notepop .note-pop-view").innerText()).trim(), "A note the snapshot must keep.",
    "a frozen docked note still reads");
  assert.equal(await page.locator("#notepop .note-pop-actions button:visible").count(), 0,
    "a snapshot offers no place-on-canvas and no delete");
  await page.locator(`.note-dot[data-note="${noteId}"]`).dblclick();
  assert.equal(await page.locator("#notepop .note-editor").count(), 0, "a snapshot cannot be edited");
  await page.click(".card.root .card-more");
  assert.equal(await page.locator("#cm-note").count(), 0,
    "the card menu carries no Add note — the card composer is the only way to write one, and a snapshot has no composer");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

async function streamAnswer(client, request, title, page, { expectNext = false } = {}) {
  const split = BRANCH_MARKDOWN.indexOf("\n\n") + 2;
  const partial = await callTool(client, "answer_branch", { session_id: request.session_id, request_id: request.request_id, content: BRANCH_MARKDOWN.slice(0, split), partial: true });
  assert.equal(partial.partial, true);
  const surface = page.locator(`.doc-content[data-node-id="${request.node_id}"]`).first();
  await surface.getByText("First streamed paragraph.", { exact: false }).waitFor();
  if (expectNext) {
    return callTool(client, "answer_branch", {
      session_id: request.session_id, request_id: request.request_id, title, content: BRANCH_MARKDOWN.slice(split),
    });
  }
  const controller = new AbortController();
  const final = callTool(client, "answer_branch", {
    session_id: request.session_id, request_id: request.request_id, title, content: BRANCH_MARKDOWN.slice(split),
  }, { signal: controller.signal });
  await surface.getByText("Second final paragraph", { exact: false }).waitFor();
  controller.abort();
  await assert.rejects(final, /abort/i, "the host should be able to cancel an otherwise indefinite listener after the answer commits");
}

async function streamDelegatedAnswer(client, request, title) {
  const split = BRANCH_MARKDOWN.indexOf("\n\n") + 2;
  const partial = await callTool(client, "answer_branch", {
    session_id: request.session_id, request_id: request.request_id,
    content: BRANCH_MARKDOWN.slice(0, split), partial: true,
  });
  assert.equal(partial.partial, true);
  const final = await callTool(client, "answer_branch", {
    session_id: request.session_id, request_id: request.request_id,
    title, content: BRANCH_MARKDOWN.slice(split),
  });
  assert.deepEqual(final, {
    ok: true, node_id: request.node_id, request_id: request.request_id, completed: true, delegated: true,
  }, "a delegated answer completes without capturing the session listener");
}

async function downloadShare(page, selector, filename) {
  await page.click("#t-share");
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
  // A share strips personal extension state; a note's docked flag is how the
  // page is shaped, so it travels with the page.
  if (expected.stripExtensions) assert(projection.hole.nodes.every((node) => Object.keys(node.extensions).every((namespace) => namespace === "note")),
    `snapshot projection leaked extensions: ${JSON.stringify(projection.hole.nodes)}`);
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
