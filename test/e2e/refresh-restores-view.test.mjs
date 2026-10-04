/** @protects a browser refresh restores exactly what the human was looking at — reader or canvas, the whole trail, every scroll place, focus, camera, PDF place — in the web app and on the MCP-served page. */
// Failure modes, written before the code; assertion messages carry the labels.
//   R1  the reader comes back as the canvas (the surface is lost)
//   R2  the trail comes back shorter, longer, or with other documents
//   R3  a different pane is the one you are in
//   R4  a pane you are not in loses its scroll place (only the current one kept)
//   R5  a place is restored before the document finished laying out (a diagram
//       above it renders late), so it lands short
//   R6  the trail rests elsewhere: other panes open or folded into tabs
//   R7  "read alone" (focus, F) is dropped
//   R8  the canvas camera (pan and zoom) is reset or re-framed
//   R9  a different card is current on the canvas
//   R10 a card's own scroll place is lost
//   R11 a refresh taken on the canvas forgets the reader's trail: opening the
//       reader afterwards shows a shorter trail than before the refresh
//   R12 per-document text size is lost
//   R13 a PDF opens on page one at 100% instead of its page and zoom
//   R14 another hole's state bleeds into this one (a new hole opens in the
//       previous hole's reader, or with its places)
//   R15 saved state naming a document that no longer exists blanks or crashes
//       the page instead of landing on what survives
//   R16 a refresh right after a move loses that move (the save was still
//       waiting on its debounce)
//   R17 the restore is visible: the reader flies in from a card or its panes
//       slide in, instead of simply being there
//   R18 a second refresh drifts: the restore itself saved a degraded state
//   R19 the MCP-served page loses the reader, the trail, or its places
// Ends by writing test-artifacts/refresh-restores-view/trace.json (titles and
// geometry, never random ids) with before/after screenshots per refresh: the
// same run always writes the same trace.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readAttentionPdfTwoPage } from "../support/attention-pdf.mjs";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { panCanvasBy, selectVisibleText } from "../support/visible-selection.mjs";
import { bootWebApp, ROOT } from "../support/web-app-harness.mjs";

const ARTIFACTS = path.join(ROOT, "test-artifacts", "refresh-restores-view");
const trace = { viewport: null, refreshes: [] };
let shots = 0;

const words = (seed, count) => Array.from({ length: count }, (_, i) => `${seed}${i}`).join(" ");
// A diagram near the top renders late (its runtime loads on demand), so every
// place below it only exists once it has drawn: R5.
const ROOT_DOC = [
  "# Attention Is All You Need",
  "",
  "```mermaid",
  "graph TD",
  "  Input --> Encoder",
  "  Encoder --> Attention",
  "  Attention --> Decoder",
  "  Decoder --> Output",
  "  Output --> Softmax",
  "  Softmax --> Tokens",
  "```",
  "",
  `Sequence models relate positions. ${words("intro", 120)}`,
  "",
  "## Scaled attention",
  "",
  `We divide each dot product by the square root of the dimension. ${words("scaled", 160)}`,
  "",
  `Multi-head attention projects queries several times. ${words("heads", 200)}`,
  "",
  `Positional encodings inject order into the model. ${words("positions", 240)}`,
].join("\n");
const answer = (title, seed) => [`# ${title}\n\n`, `${title} opens here. ${words(seed, 80)}\n\n`, `${words(seed + "b", 1200)}\n`];

await fs.rm(ARTIFACTS, { recursive: true, force: true });
await fs.mkdir(ARTIFACTS, { recursive: true });
const app = await bootWebApp();
const errors = [];
try {
  await webAppJourney();
  await mcpJourney();
  assert(!errors.length, errors.join("\n"));
  await fs.writeFile(path.join(ARTIFACTS, "trace.json"), JSON.stringify(trace, null, 2) + "\n");
  console.log(`ok e2e refresh restores view: ${trace.refreshes.length} refreshes, artifact at ${path.relative(ROOT, ARTIFACTS)}/trace.json`);
} finally {
  await app.close();
}

// ===========================================================================
// web app
// ===========================================================================
async function webAppJourney() {
  const context = await app.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConfiguredOpenRouter(context);
  await context.addInitScript(recordRestoreMotion);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await routeProvider(page, { streams: [answer("Why the square root", "sqrt"), answer("Why several subspaces", "sub")] });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  trace.viewport = page.viewportSize();
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown), ROOT_DOC);
  await page.waitForSelector(".card.root .rh-mermaid svg[id^='rh-mermaid-']", { state: "visible" });
  await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  const rootId = await page.locator(".reader-pane").first().getAttribute("data-node-id");

  // A three-document trail: the root, an answer, and an answer to it.
  const sqrtId = await ask(page, rootId, "divide each dot product", "Why divide by the square root?");
  const subId = await ask(page, sqrtId, "Why the square root opens", "Why several subspaces?");
  await settled(page);

  // ------------------------------------------- reader: a scrolled trail
  // Walk back to the middle document so a pane on each side of the current
  // one is on screen, then give every pane its own place.
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
  await page.keyboard.press("ArrowLeft");
  await settled(page);
  await page.locator("#r-textup").click(); // R12: the middle document reads larger
  await scrollPane(page, rootId, 3500); // folded behind its tab, and deep below the diagram
  await scrollPane(page, subId, 1100);
  await settled(page);
  // The last move lands right before the refresh: nothing has had time to save.
  await scrollPane(page, sqrtId, 1700);
  let before = await lookOf(page);
  assert.equal(before.mode, "reader");
  assert.equal(before.panes.length, 3);
  assert(before.panes.some((p) => p.folded), "setup: the root rests folded as a tab");
  let after = await refresh(page, "reader: three panes, each scrolled, the last move just made");
  assertSameReader(before, after, "reader trail");
  await assertRestoreStill(page, "R17 reader trail");

  // A place set too early clamps short: prove the root's place lies below the
  // late diagram and is still exact once it has drawn.
  const diagramAbove = await page.evaluate((id) => {
    const pane = document.querySelector(`.reader-pane[data-node-id="${id}"]`);
    const host = pane.querySelector(".viz-mermaid");
    const svg = host?.shadowRoot?.querySelector("svg[id^='rh-mermaid-']");
    const scroll = pane.querySelector(".pane-scroll");
    // Without the diagram's height this place would not exist at all.
    const withoutDiagram = scroll.scrollHeight - scroll.clientHeight - host.offsetHeight;
    return !!svg && host.offsetHeight > 200 && withoutDiagram < scroll.scrollTop;
  }, rootId);
  assert(diagramAbove, "R5 setup: the root's place only exists once its late-drawn diagram has drawn");

  after = await refresh(page, "reader: a second refresh with no move in between");
  assertSameReader(before, after, "R18 second refresh");

  // ------------------------------------------- reader: one document alone
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
  await page.keyboard.press("f");
  await settled(page);
  before = await lookOf(page);
  assert.equal(before.panes.filter((p) => !p.folded).length, 1, "setup: F reads one document alone");
  after = await refresh(page, "reader: one document read alone");
  assert.equal(after.focused, true, "R7 reading alone survives a refresh");
  assertSameReader(before, after, "focused");
  await page.keyboard.press("Escape");
  await settled(page);

  // ------------------------------------------- canvas: camera, current, cards
  await page.locator("#reader-restore").click();
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await settled(page);
  await page.locator("#t-zout").click();
  await waitForCamera(page);
  await panCanvasBy(page, { x: -140, y: 90 });
  await waitForCamera(page);
  await scrollCard(page, rootId, 900);
  await scrollCard(page, subId, 450);
  await settled(page);
  before = await lookOf(page);
  assert.equal(before.mode, "canvas");
  after = await refresh(page, "canvas: zoomed, panned, cards scrolled");
  assert.equal(after.mode, "canvas", "R1 the canvas comes back as the canvas");
  assert.equal(after.camera, before.camera, "R8 the camera keeps its pan and zoom");
  assert.equal(after.zoom, before.zoom, "R8 the zoom label agrees");
  assert.equal(after.currentCard, before.currentCard, "R9 the same card is current");
  assert.deepEqual(after.cards, before.cards, "R10 every card keeps its scroll place");
  assert.deepEqual(after.trail, before.trail, "R11 the reader's trail waits behind the canvas");

  // Opening the reader after a canvas refresh finds the trail it left, every
  // document where its card was read to (a document has one place).
  const cardPlaces = await contentPlaces(page, "card");
  await page.evaluate(() => document.querySelector(".card.current [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  const reopened = await settled(page);
  assert.deepEqual(reopened.panes.map((p) => p.title), before.trail, "R11 the reader reopens on the whole trail");
  const panePlaces = await contentPlaces(page, "pane");
  for (const title of before.trail) {
    const [card, pane] = [cardPlaces[title], panePlaces[title]];
    assert(card && pane && card.block === pane.block && Math.abs(card.into - pane.into) < 0.05,
      `R11 "${title}" reopens where its card was read to: ${JSON.stringify({ card, pane })}`);
  }
  await snap(page, "reader reopened after a canvas refresh");
  const readerBefore = reopened;

  // ------------------------------------------- another hole: a PDF
  await page.setInputFiles("#file-md", { name: "attention.pdf", mimeType: "application/pdf", buffer: await readAttentionPdfTwoPage() });
  await page.waitForSelector(".card .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  const fresh = await settled(page);
  assert.equal(fresh.mode, "canvas", "R14 a new hole opens on its own canvas, not the last hole's reader");
  assert.equal(fresh.trail.length, 0, "R14 no pane of another hole comes along");
  await page.evaluate(() => document.querySelector(".card.current [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await page.waitForSelector(".reader-pane .rh-pdf-page[data-page='2']");
  await page.click('#tb-document .rh-pdf-zoom-control[aria-label="Zoom PDF in"]');
  await page.waitForFunction(() => document.querySelector("#tb-document .rh-pdf-zoom-value")?.textContent === "125%");
  // Every page laid out at its real size first: the place is read, not raced.
  await page.waitForFunction(() => [...document.querySelectorAll(".reader-pane .rh-pdf-page")].every((p) => /px$/.test(/** @type {HTMLElement} */ (p).style.height)));
  await settled(page);
  await page.evaluate(() => {
    const scroll = document.querySelector(".reader-pane .rh-pdf-scroll");
    const second = scroll.querySelector(".rh-pdf-page[data-page='2']");
    scroll.scrollTop = second.offsetTop + Math.round(second.offsetHeight * 0.4);
  });
  await settled(page);
  before = await lookOf(page);
  after = await refresh(page, "reader: a PDF zoomed and scrolled to page two");
  assert.equal(after.mode, "reader", "R1 a PDF read in the reader comes back in the reader");
  assert.deepEqual(after.pdf, before.pdf, "R13 the PDF keeps its page, its place on it, and its zoom");

  // Back to the first hole through the rail: its own reader, untouched.
  await page.locator("#t-rail").click();
  await page.locator(".rail-row", { hasText: "Attention Is All You Need" }).locator(".rail-open").first().click();
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && document.querySelectorAll(".reader-pane").length === 3);
  await page.locator("#t-rail").click();
  const back = await settled(page);
  assert.deepEqual(stripPdf(back), stripPdf(readerBefore), "R14 the first hole keeps its own reader and places");
  assert.equal(back.pdf, null, "R14 no PDF place from the other hole shows here");

  // ------------------------------------------- stale state: a deleted answer
  // The deepest answer is the one you are in, and it is deleted elsewhere
  // (another tab): the saved view still names it.
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
  await page.keyboard.press("ArrowRight");
  const onDeepest = await settled(page);
  assert.equal(onDeepest.panes.find((p) => p.current)?.title, "Why several subspaces?", "setup: the deepest answer is current");
  await page.waitForTimeout(1500); // let the view save land
  const holeId = await page.evaluate(() => window.__rabbitholeTest.currentHoleId());
  await page.close();
  const doctor = await context.newPage();
  await doctor.goto(`${app.baseUrl}/favicon.svg`);
  await doctor.evaluate(async ({ id, gone }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("rabbithole-browser");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("holes", "readwrite");
    const holes = tx.objectStore("holes");
    const hole = await new Promise((resolve) => { holes.get(id).onsuccess = (e) => resolve(e.target.result); });
    hole.nodes = hole.nodes.filter((node) => node.id !== gone);
    holes.put(hole);
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    db.close();
  }, { id: holeId, gone: subId });
  await doctor.close();
  const reborn = await context.newPage();
  reborn.on("pageerror", (error) => errors.push(error.message));
  await reborn.goto(app.baseUrl, { waitUntil: "networkidle" });
  const survived = await settled(reborn);
  assert.equal(survived.mode, "reader", "R15 a saved trail naming a deleted answer still opens the reader");
  assert.deepEqual(survived.panes.map((p) => p.title), readerBefore.panes.map((p) => p.title).slice(0, 2), "R15 the trail keeps what survives");
  assert.equal(survived.panes.find((p) => p.current)?.title, "Why divide by the square root?", "R15 the deepest surviving document becomes current");
  const survivedScroll = survived.panes.find((p) => p.title === "Why divide by the square root?");
  assert.equal(survivedScroll.scrollTop, readerBefore.panes.find((p) => p.title === "Why divide by the square root?").scrollTop, "R15 what survives keeps its place");
  trace.refreshes.push({ name: "stale state: the deepest answer was deleted", after: survived });
  await snap(reborn, "stale state after");
  await context.close();
}

// ===========================================================================
// MCP-served page
// ===========================================================================
async function mcpJourney() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-refresh-view-"));
  const mcp = await startMcp(dir);
  const context = await app.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(recordRestoreMotion);
  try {
    const opening = callTool(mcp.client, "open_rabbithole", { title: "Refresh on the local page", content: ROOT_DOC.replace("# Attention Is All You Need", "# Refresh on the local page") });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(await mcp.nextUrl(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".card.root .rh-mermaid svg[id^='rh-mermaid-']", { state: "visible" });
    await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
    await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
    const rootId = await page.locator(".reader-pane").first().getAttribute("data-node-id");
    await selectPhrase(page, rootId, "divide each dot product");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Why divide?");
    await page.keyboard.press("Meta+Enter");
    const request = await opening;
    assert.equal(request.status, "branch_request");
    const listener = new AbortController();
    const final = callTool(mcp.client, "answer_branch", {
      session_id: request.session_id, request_id: request.request_id, title: "Why divide",
      content: answer("Why divide", "divide").join(""),
    }, { signal: listener.signal }).catch(() => null);
    await page.waitForFunction((id) => document.querySelector(`.reader-pane[data-node-id="${id}"] .doc-content`)?.textContent.includes("Why divide opens here"), request.node_id);
    await settled(page);
    await scrollPane(page, rootId, 1300);
    await settled(page);
    await scrollPane(page, request.node_id, 900); // the last move, right before the refresh
    let before = await lookOf(page);
    let after = await refresh(page, "MCP page: reader with an answer beside, both scrolled", { waitUntil: "domcontentloaded" });
    assertSameReader(before, after, "R19 MCP reader");
    await assertRestoreStill(page, "R19 R17 MCP reader");

    await page.locator("#reader-restore").click();
    await page.waitForFunction(() => document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
    before = await lookOf(page);
    after = await refresh(page, "MCP page: back on the canvas, refreshed at once", { waitUntil: "domcontentloaded" });
    assert.equal(after.mode, "canvas", "R19 R16 the MCP page keeps the canvas it was just switched to");
    assert.equal(after.camera, before.camera, "R19 R8 the MCP page keeps its camera");
    listener.abort();
    await final;
  } finally {
    await context.close();
    await mcp.client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// helpers
// ===========================================================================
function assertSameReader(before, after, label) {
  assert.equal(after.mode, "reader", `R1 ${label}: the reader comes back as the reader`);
  assert.deepEqual(after.panes.map((p) => p.title), before.panes.map((p) => p.title), `R2 ${label}: the same trail, in order`);
  assert.deepEqual(after.panes.map((p) => p.current), before.panes.map((p) => p.current), `R3 ${label}: the same pane is current`);
  for (let i = 0; i < before.panes.length; i++) {
    const [b, a] = [before.panes[i], after.panes[i]];
    assert.equal(a.scrollTop, b.scrollTop, `R4 R5 R16 ${label}: "${b.title}" keeps its scroll place (${b.current ? "current" : "not current"})`);
    assert.equal(a.folded, b.folded, `R6 ${label}: "${b.title}" is open or folded as before`);
    assert.equal(a.x, b.x, `R6 ${label}: "${b.title}" rests at the same place on the trail`);
    assert.equal(a.fontSize, b.fontSize, `R12 ${label}: "${b.title}" keeps its text size`);
  }
  assert.equal(after.focused, before.focused, `R7 ${label}: reading alone is kept as it was`);
}

async function assertRestoreStill(page, label) {
  const log = await page.evaluate(() => window.__restoreLog);
  assert.equal(log.flight, false, `${label}: the reader never flies in on a refresh`);
  assert.equal(log.entering, false, `${label}: no pane slides in on a refresh`);
}

// Runs in every page before its own scripts: records any restore motion.
function recordRestoreMotion() {
  const log = { flight: false, entering: false };
  Object.defineProperty(window, "__restoreLog", { value: log });
  new MutationObserver(() => {
    if (document.body?.classList.contains("mode-flight")) log.flight = true;
    if (document.querySelector(".reader-pane.pane-entering")) log.entering = true;
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
}

async function refresh(page, name, { waitUntil = "networkidle" } = {}) {
  const before = await lookOf(page);
  await snap(page, `${name} — before`);
  await page.reload({ waitUntil });
  const after = await settled(page);
  await snap(page, `${name} — after`);
  trace.refreshes.push({ name, before, after });
  return after;
}

// What is on screen, by title and geometry — never by id.
async function lookOf(page) {
  return page.evaluate(() => {
    const canvas = document.body.classList.contains("mode-canvas");
    const round = (n) => Math.round(n);
    const livePanes = [...document.querySelectorAll(".reader-pane:not(.pane-leaving)")];
    const pdfScroll = document.querySelector(canvas ? ".card.current .rh-pdf-scroll" : ".reader-pane.current .rh-pdf-scroll");
    return {
      mode: canvas ? "canvas" : "reader",
      trail: livePanes.map((el) => el.getAttribute("aria-label")),
      panes: canvas ? [] : livePanes.map((el) => ({
        title: el.getAttribute("aria-label"),
        current: el.classList.contains("current"),
        folded: el.classList.contains("pane-folded"),
        x: el.style.transform,
        scrollTop: round(el.querySelector(".pane-scroll").scrollTop),
        fontSize: getComputedStyle(el.querySelector(".doc-content")).fontSize,
      })),
      focused: !canvas && !!document.querySelector(".reader-pane .pane-focus[aria-pressed='true']"),
      camera: canvas ? document.getElementById("world").style.transform : null,
      zoom: canvas ? document.getElementById("zoom-label").textContent : null,
      currentCard: canvas ? document.querySelector(".card.current .card-title")?.textContent || null : null,
      cards: canvas
        ? Object.fromEntries([...document.querySelectorAll(".card")].map((card) => [card.querySelector(".card-title").textContent, round(card.querySelector(".card-body").scrollTop)]))
        : null,
      pdf: pdfScroll
        ? {
            zoom: pdfScroll.dataset.zoom,
            label: document.querySelector(canvas ? ".card.current .rh-pdf-zoom-value" : "#tb-document .rh-pdf-zoom-value")?.textContent || null,
            scrollTop: round(pdfScroll.scrollTop),
            page: [...pdfScroll.querySelectorAll(".rh-pdf-page")].filter((p) => p.offsetTop <= pdfScroll.scrollTop).length,
          }
        : null,
    };
  });
}

function stripPdf(look) {
  const { pdf: _pdf, ...rest } = look;
  return rest;
}

// Still for 800ms: every late layout (fonts, diagrams) has landed, and any
// restore hold has had its say.
async function settled(page) {
  const start = Date.now();
  let last = "";
  let since = Date.now();
  for (;;) {
    const now = JSON.stringify(await lookOf(page));
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= 800) return JSON.parse(now);
    if (Date.now() - start > 15000) throw new Error(`view never settled: ${now}`);
    await page.waitForTimeout(100);
  }
}

async function snap(page, name) {
  const file = `${String(++shots).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "")}.png`;
  await page.screenshot({ path: path.join(ARTIFACTS, file) });
}

async function waitForCamera(page) {
  await page.evaluate(() => window.__rabbitholeTest?.waitForCanvasViewSettled?.());
}

async function ask(page, paneId, text, question) {
  const count = await page.locator(".reader-pane:not(.pane-leaving)").count();
  await selectVisibleText(page, { text, rootSelector: `.reader-pane[data-node-id="${paneId}"] .doc-content` });
  await page.fill("#ask-text", question);
  await page.keyboard.press("Meta+Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".reader-pane:not(.pane-leaving)").length === n + 1, count);
  const id = await page.locator(".reader-pane:not(.pane-leaving)").last().getAttribute("data-node-id");
  await page.waitForFunction((paneId) => /opens here/.test(document.querySelector(`.reader-pane[data-node-id="${paneId}"] .doc-content`)?.textContent || "") && !document.querySelector(`.reader-pane[data-node-id="${paneId}"] .ll-live`), id);
  return id;
}

// The MCP page has no test seam: select the way a mouse leaves a selection.
async function selectPhrase(page, paneId, phrase) {
  const selected = await page.evaluate(([id, needle]) => {
    const root = document.querySelector(`.reader-pane[data-node-id="${id}"] .doc-content`);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.data.indexOf(needle);
      if (index < 0) continue;
      node.parentElement.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selection.toString();
    }
    return "";
  }, [paneId, phrase]);
  assert.equal(selected, phrase);
}

async function scrollPane(page, id, top) {
  await page.evaluate(([paneId, value]) => {
    document.querySelector(`.reader-pane[data-node-id="${paneId}"] .pane-scroll`).scrollTop = value;
  }, [id, top]);
}

// For every document on the trail, by title: the block at the top of its
// card's (or its pane's) view, and how far into that block the view begins.
async function contentPlaces(page, kind) {
  return page.evaluate((surface) => {
    const out = {};
    for (const pane of document.querySelectorAll(".reader-pane:not(.pane-leaving)")) {
      const id = pane.getAttribute("data-node-id");
      const scroller = surface === "pane" ? pane.querySelector(".pane-scroll") : document.querySelector(`.card[data-id="${id}"] > .card-body`);
      if (!scroller) continue;
      const top = scroller.getBoundingClientRect().top;
      for (const block of scroller.querySelectorAll(".doc-content > *")) {
        const rect = block.getBoundingClientRect();
        if (rect.bottom <= top + 0.5) continue;
        out[pane.getAttribute("aria-label")] = { block: block.textContent.slice(0, 24), into: scroller.scrollTop ? (top - rect.top) / rect.height : 0 };
        break;
      }
    }
    return out;
  }, kind);
}

async function scrollCard(page, id, top) {
  await page.evaluate(([cardId, value]) => {
    document.querySelector(`.card[data-id="${cardId}"] .card-body`).scrollTop = value;
  }, [id, top]);
}

async function startMcp(dir) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, "bin/mcp-server.js")], cwd: ROOT, stderr: "pipe",
    env: { ...process.env, RABBITHOLE_DIR: dir, RABBITHOLE_NO_BROWSER: "1" },
  });
  let stderr = "";
  const urls = [];
  const waiters = [];
  transport.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    for (const match of chunk.toString().matchAll(/listening at (http:\/\/127\.0\.0\.1:\d+)/g)) {
      const waiter = waiters.shift();
      if (waiter) waiter(match[1]); else urls.push(match[1]);
    }
  });
  const client = new Client({ name: "refresh-restores-view", version: "1" });
  await client.connect(transport);
  return {
    client,
    nextUrl: () => urls.length ? Promise.resolve(urls.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP canvas URL timeout; stderr=${stderr}`)), 5000);
      waiters.push((url) => { clearTimeout(timer); resolve(url); });
    }),
  };
}

async function callTool(client, name, args, options = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000, ...options });
  assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
}
