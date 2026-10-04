/** @protects a ~30k-word hole stays cheap everywhere: work follows what is on screen or what changed, never the size of the documents. */
// Failure modes, written before the code; assertion messages carry the labels.
// Every check counts work the browser or the host reports (forced renders,
// rendered blocks, DOM nodes, restyled elements, bytes on disk), never time.
//   L1 opening a hole into the reader lays out the canvas it builds behind it
//      (a hidden card measured, scrolled or cloned forces its layout)
//   L2 the canvas lays out and paints a long document's off-screen text
//   L3 a streaming frame rebuilds the whole answer: DOM work grows with the
//      answer, not with the text that arrived
//   L4 a streaming frame restyles or re-lays out the whole answer
//   L5 a scroll pause saves the whole hole (every document's markdown)
//      instead of where the human is reading
// Ends by writing test-artifacts/large-document/counters.json: every counter
// the assertions read, for comparing runs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { largeHole, wordCount } from "../support/large-hole.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const ARTIFACTS = path.join(ROOT, "test-artifacts", "large-document");
const HIDDEN_RENDER = /subtree hidden by content-visibility/;
const counters = {};

const hole = largeHole();
// Reopened where it was left: reading the root, the canvas behind it.
hole.view_state = { mode: "reader", node_id: hole.root_id, reader: { trail: [hole.root_id], position: 0, focused: false } };
const cards = hole.nodes.filter((node) => node.extensions?.note?.docked !== true).length;
counters.hole = { words: wordCount(hole), nodes: hole.nodes.length, cards };
assert(counters.hole.words > 28000 && cards > 30, `the hole must be large: ${JSON.stringify(counters.hole)}`);

await fs.rm(ARTIFACTS, { recursive: true, force: true });
await fs.mkdir(ARTIFACTS, { recursive: true });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-large-document-"));
const holeFile = path.join(dir, `${hole.hole_id}.json`);
const viewFile = path.join(dir, "views", `${hole.hole_id}.json`);
await fs.writeFile(holeFile, JSON.stringify(hole));
const mcp = await startMcp(dir);
const browser = await chromium.launch();
const errors = [];
const listener = new AbortController();
try {
  const opening = callTool(mcp.client, "open_rabbithole", { hole_id: hole.hole_id }, { signal: listener.signal });
  // A failure before the ask aborts this call: let the failure speak, not the abort.
  opening.catch(() => {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Which of a document's blocks the browser renders, as it decides (L2).
  await context.addInitScript(() => {
    const skipped = new Map();
    document.addEventListener("contentvisibilityautostatechange", (event) => skipped.set(event.target, /** @type {any} */ (event).skipped), true);
    window.__rhSkipped = skipped;
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.on("pageerror", (error) => errors.push(error.message));
  let hiddenRenders = 0;
  page.on("console", (message) => {
    if (HIDDEN_RENDER.test(message.text())) hiddenRenders += 1;
  });

  // L1: the reader first, the canvas built behind it card by card.
  await page.goto(await mcp.nextUrl(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reader-pane .doc-content", { state: "visible" });
  await page.waitForFunction((count) => document.querySelectorAll(".card[data-id]").length === count, cards);
  await settle(page);
  counters.boot = { hiddenRenders };
  assert.equal(hiddenRenders, 0, "L1 building the canvas behind the reader forced layout of hidden content");

  // L5: a scroll pause writes the view, not the hole.
  const written = await quietFile(holeFile);
  const pane = page.locator(".reader-pane").first();
  const rootId = await pane.getAttribute("data-node-id");
  await pane.locator(".pane-scroll").evaluate((scroller) => {
    scroller.scrollTop = 2400;
  });
  const saved = await waitForSave(viewFile, holeFile, written);
  counters.viewSave = { holeBytes: (await fs.stat(holeFile)).size, viewBytes: saved.bytes, holeRewritten: saved.holeRewritten };
  assert.equal(saved.holeRewritten, false, "L5 a scroll pause rewrote the whole hole");
  assert.equal(saved.view?.view_state?.scrolls?.[rootId] > 0, true, "L5 the saved view holds the reading place");
  assert(saved.bytes < 2000, `L5 a view save carries the view alone, not documents (${saved.bytes} bytes)`);

  // L3 L4: ask, then stream a long answer in the reader.
  await selectPhrase(page, rootId);
  await page.fill("#ask-text", "What does this mean?");
  await page.keyboard.press("Meta+Enter");
  const request = await opening;
  assert.equal(request.status, "branch_request");
  await page.waitForSelector(`.reader-pane[data-node-id="${request.node_id}"] .doc-content`);
  await page.evaluate(() => {
    const frames = [];
    let added = 0;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) added += 1 + (node.getElementsByTagName ? node.getElementsByTagName("*").length : 0);
    }).observe(document.body, { childList: true, subtree: true });
    (function frame() {
      requestAnimationFrame(() => {
        if (added) frames.push(added);
        added = 0;
        frame();
      });
    })();
    window.__rhAddedPerFrame = frames;
  });
  hiddenRenders = 0;
  const ids = { session_id: request.session_id, request_id: request.request_id };
  const trace = await traced(cdp, async () => {
    for (let i = 0; i < 48; i++) {
      await callTool(mcp.client, "answer_branch", { ...ids, content: chunk(i), partial: true });
      await page.waitForFunction((text) => document.querySelector(".reader-pane .stream-caret")?.parentElement?.textContent.includes(text), `point ${i}`);
    }
  });
  const answerElements = await page.evaluate((id) => document.querySelector(`.reader-pane .doc-content[data-node-id="${id}"]`).getElementsByTagName("*").length, request.node_id);
  const perFrame = await page.evaluate(() => window.__rhAddedPerFrame.slice());
  counters.stream = { answerElements, addedPerFrame: perFrame, ...trace, hiddenRenders };
  assert(answerElements > 300, `the answer must grow large (${answerElements} elements)`);
  const late = perFrame.slice(-12);
  assert(Math.max(...late) < 150, `L3 a streaming frame rebuilt the answer: nodes added per frame ${late.join(",")} for a ${answerElements}-element answer`);
  assert(trace.maxRestyle < 400, `L4 a streaming frame restyled ${trace.maxRestyle} elements at once`);
  assert(trace.maxRelayout < 400, `L4 a streaming frame re-laid out ${trace.maxRelayout} objects at once`);
  assert.equal(hiddenRenders, 0, "L4 streaming forced layout of the hidden canvas card");
  const finished = callTool(mcp.client, "answer_branch", { ...ids, title: "Layers", content: "Done.\n" }, { signal: listener.signal }).catch(() => null);
  await page.waitForFunction(() => !document.querySelector(".stream-caret"));

  // L2: on the canvas, a long document renders only what is on screen.
  await page.locator("#reader-restore").click();
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await settle(page);
  counters.canvas = await renderedBlocks(page);
  assert(counters.canvas.skipped > counters.canvas.blocks * 0.8, `L2 the canvas renders a long document's off-screen text: ${JSON.stringify(counters.canvas)}`);

  assert(!errors.length, errors.join("\n"));
  listener.abort();
  await finished;
  await context.close();
  console.log(`ok e2e large document: ${counters.hole.words} words, artifact at ${path.relative(ROOT, ARTIFACTS)}/counters.json`);
} finally {
  await fs.writeFile(path.join(ARTIFACTS, "counters.json"), JSON.stringify(counters, null, 2) + "\n");
  listener.abort();
  await browser.close();
  await mcp.client.close();
  await fs.rm(dir, { recursive: true, force: true });
}

// One chunk of a long answer: prose, and now and then a list or code.
function chunk(i) {
  const prose = `Traits sit at the base, adaptations above them, and a life story integrates both, point ${i}. `.repeat(3);
  if (i === 0) return `# Layers\n\n${prose}`;
  if (i % 5 === 3) return `\n\n- one layer\n- another layer\n- a story with $x^2$\n\n${prose}`;
  if (i % 11 === 6) return `\n\n\`\`\`python\ndef layer(x):\n    return x * ${i}\n\`\`\`\n\n${prose}`;
  return i % 2 ? prose : `\n\n${prose}`;
}

// Everything the page had queued settles: ten frames with nothing changing.
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let last = -1;
        let still = 0;
        (function frame() {
          requestAnimationFrame(() => {
            const height = document.body.scrollHeight + document.querySelectorAll("*").length;
            still = height === last ? still + 1 : 0;
            last = height;
            if (still >= 10) resolve();
            else frame();
          });
        })();
      }),
  );
}

async function renderedBlocks(page) {
  return page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll(".card.root .doc-content > *"));
    const skipped = blocks.filter((block) => window.__rhSkipped.get(block) === true).length;
    return { blocks: blocks.length, skipped, rendered: blocks.length - skipped };
  });
}

// The largest single restyle and relayout the renderer did while `run` ran.
async function traced(cdp, run) {
  await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReturnAsStream" });
  await run();
  const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  const { stream } = await complete;
  let data = "";
  for (;;) {
    const read = await cdp.send("IO.read", { handle: stream });
    data += read.data;
    if (read.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  const events = JSON.parse(data).traceEvents;
  const threads = new Set(
    events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`),
  );
  const main = events.filter((e) => e.ph === "X" && threads.has(`${e.pid}:${e.tid}`));
  const restyles = main.filter((e) => e.name === "UpdateLayoutTree").map((e) => e.args?.elementCount || 0);
  const relayouts = main.filter((e) => e.name === "Layout").map((e) => e.args?.beginData?.dirtyObjects || 0);
  return { maxRestyle: Math.max(0, ...restyles), maxRelayout: Math.max(0, ...relayouts) };
}

async function selectPhrase(page, paneId) {
  const selected = await page.evaluate((id) => {
    const root = document.querySelector(`.reader-pane[data-node-id="${id}"] .doc-content`);
    const scroller = root.closest(".pane-scroll");
    const top = scroller.getBoundingClientRect().top;
    const paragraph = Array.from(root.querySelectorAll(":scope > p")).find((p) => p.getBoundingClientRect().top > top + 80 && p.firstChild?.nodeType === Node.TEXT_NODE);
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, 24);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return selection.toString();
  }, paneId);
  assert.equal(selected.length, 24);
  await page.waitForSelector("#ask.visible");
}

// The hole file, once the session's own opening save has landed.
async function quietFile(file) {
  let last = (await fs.stat(file)).mtimeMs;
  for (let still = 0; still < 8; ) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const now = (await fs.stat(file)).mtimeMs;
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return last;
}

// Whichever the save wrote: the view on its own, or the whole hole again.
async function waitForSave(viewFile, holeFile, written) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await fs.stat(holeFile)).mtimeMs !== written) return { holeRewritten: true, view: null, bytes: 0 };
    const text = await fs.readFile(viewFile, "utf8").catch(() => "");
    const view = text ? JSON.parse(text) : null;
    if (Object.values(view?.view_state?.scrolls || {}).some((top) => top > 0))
      return { holeRewritten: false, view, bytes: text.length };
  }
  assert.fail("L5 nothing was saved after a scroll pause");
}

async function startMcp(dir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "bin/mcp-server.js")],
    cwd: ROOT,
    stderr: "pipe",
    env: { ...process.env, RABBITHOLE_DIR: dir, RABBITHOLE_NO_BROWSER: "1" },
  });
  let stderr = "";
  const urls = [];
  const waiters = [];
  transport.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    for (const match of chunk.toString().matchAll(/listening at (http:\/\/127\.0\.0\.1:\d+)/g)) {
      const waiter = waiters.shift();
      if (waiter) waiter(match[1]);
      else urls.push(match[1]);
    }
  });
  const client = new Client({ name: "large-document", version: "1" });
  await client.connect(transport);
  return {
    client,
    nextUrl: () =>
      urls.length
        ? Promise.resolve(urls.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`MCP canvas URL timeout; stderr=${stderr}`)), 5000);
            waiters.push((url) => {
              clearTimeout(timer);
              resolve(url);
            });
          }),
  };
}

async function callTool(client, name, args, options = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000, ...options });
  assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
}
