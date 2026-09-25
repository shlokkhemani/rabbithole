/** @protects the reader trail: answers open beside their source, panes slide and fold into spines without re-wrapping text, and every gesture settles on a pane. */
// Walks the failure modes written before the trail was built (see the
// assertion labels: M = motion, G = geometry, B = behaviour). Ends by writing
// test-artifacts/reader-trail/trace.json and a screenshot per stage: the same
// run always produces the same trace, so a regression shows up as a diff.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { selectVisibleText } from "../support/visible-selection.mjs";
import { bootWebApp, ROOT } from "../support/web-app-harness.mjs";

const ARTIFACTS = path.join(ROOT, "test-artifacts", "reader-trail");
const trace = { viewport: null, stages: [] };

const words = (seed, count) => Array.from({ length: count }, (_, i) => `${seed}${i}`).join(" ");
const ROOT_DOC = [
  "# Attention Is All You Need",
  "",
  `Sequence models relate positions. ${words("intro", 90)}`,
  "",
  "## Scaled attention",
  "",
  `We divide each dot product by the square root of the dimension. ${words("scaled", 120)}`,
  "",
  "```text",
  `a very long code line that must scroll sideways on its own ${"x".repeat(400)}`,
  "```",
  "",
  `Multi-head attention projects queries several times. ${words("heads", 120)}`,
  "",
  `Positional encodings inject order into the model. ${words("positions", 160)}`,
].join("\n");
const answer = (title, seed) => [`# ${title}\n\n`, `${title} opens here. ${words(seed, 60)}\n\n`, `${words(seed + "b", 200)}\n`];

await fs.rm(ARTIFACTS, { recursive: true, force: true });
const app = await bootWebApp();
try {
  const context = await app.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeProvider(page, {
    streams: [
      answer("Why the square root", "sqrt"),
      answer("Multi-head attention", "multi"),
      answer("Why several subspaces", "sub"),
      answer("Order without recurrence", "order"),
    ],
  });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  trace.viewport = page.viewportSize();
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown), ROOT_DOC);
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });
  await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  const rootId = await page.locator(".reader-pane").first().getAttribute("data-node-id");

  // ---------------------------------------------------------------- lone
  let g = await stage("lone document", page);
  assert.equal(g.panes.length, 1);
  const column = g.panes[0].colW;
  assert(Math.abs(g.panes[0].x + g.panes[0].w / 2 - g.stageW / 2) <= 1, `G5 a lone document sits centred: ${JSON.stringify(g.panes[0])}`);
  assert(column >= 480 && column <= 680, `a comfortable measure: ${column}`);

  // ----------------------------------------------------- ask opens beside
  await scrollPane(page, rootId, 420);
  const rootLines = await lineBoxes(page, rootId, "heads0");
  const placeAtAsk = await ask(page, rootId, "divide each dot product", "Why divide by the square root?");
  g = await stage("answer opens beside", page);
  assert.equal(g.panes.length, 2, "B1 the answer opens in a pane beside its source");
  const [source, sqrt] = g.panes;
  assert.equal(source.id, rootId);
  assert(source.current, "B1 the asking document stays the one you are in");
  assert.equal(source.scrollTop, placeAtAsk, "G6 opening beside never moves the source's place");
  assert.equal(source.colW, column, "G1 the source's measure never changes");
  assert.deepEqual(await lineBoxes(page, rootId, "heads0"), rootLines, "G1 not one line of the source re-wraps");
  assert(source.x + source.w <= sqrt.x + 0.5, `G2 open panes never overlap: ${JSON.stringify(g.panes)}`);
  assert(await paneText(page, sqrt.id, "Why the square root opens here"), "B4 the answer renders in its pane while its source stays current");
  await assertComposerUnder(page, rootId, "B5 the composer sits under the current document");
  await assertComposerFloats(page, "B14 the panes run the full height; the composer floats over the current one");
  const dot = await page.evaluate((id) => {
    const pane = document.querySelector(`.reader-pane[data-node-id="${id}"]`);
    const d = pane.querySelector(".branch-dot");
    const mark = pane.querySelector("mark.mark-open");
    const first = mark.getClientRects()[0];
    const r = d.getBoundingClientRect();
    return { open: d.classList.contains("branch-dot-open"), offLine: Math.abs(r.top + r.height / 2 - (first.top + first.height / 2)), popup: d.getAttribute("aria-haspopup") };
  }, rootId);
  assert(dot.open, "B10 the answer's dot shows it open beside");
  assert(dot.offLine < 2.5, `B10 the dot sits on the line its mark starts on: ${dot.offLine}`);
  assert.equal(dot.popup, null, "B10 a branch dot is not a note popover trigger");

  // ------------------------------------ a new ask replaces the open answer
  await ask(page, rootId, "Multi-head attention projects", "What is multi-head attention?");
  g = await stage("new ask replaces the open answer", page);
  assert.equal(g.panes.length, 2, "B3 asking again from the source replaces the answer beside it");
  const multi = g.panes[1];
  assert(await paneText(page, multi.id, "Multi-head attention opens here"));
  assert.equal(await page.locator(`.reader-pane[data-node-id="${rootId}"] .branch-dot`).count(), 2, "B10 every answer keeps its dot");
  assert.equal(await page.locator(`.reader-pane[data-node-id="${rootId}"] .branch-dot-open`).count(), 1, "only the open answer's dot is ringed");

  // clicking the other dot brings that answer back beside
  await page.locator(`.reader-pane[data-node-id="${rootId}"] .branch-dot:not(.branch-dot-open)`).click();
  g = await stage("dot reopens an answer", page);
  assert.equal(g.panes[1].id, sqrt.id, "B10 a branch dot opens its answer beside");
  assert.equal(await page.locator("#notepop.visible").count(), 0, "B10 a branch dot never opens the note popover");
  await page.locator(`.reader-pane[data-node-id="${rootId}"] .branch-dot:not(.branch-dot-open)`).click();
  g = await stage("multi-head back beside", page);
  assert.equal(g.panes[1].id, multi.id);

  // --------------------------------- asking from the answer slides the trail
  await ask(page, multi.id, "Multi-head attention opens", "Why several subspaces?");
  g = await stage("deeper answer slides the trail", page);
  assert.equal(g.panes.length, 3);
  const [root3, multi3, sub] = g.panes;
  assert(root3.folded, "G3 the root folds into a spine as the trail moves on");
  assert(!multi3.folded && !sub.folded, "the asking document and its answer are both open");
  assert(multi3.current, "B1 the document you asked from stays current");
  assert(multi3.x + multi3.w <= sub.x + 0.5, "G2 no open pane overlaps another");
  assert.equal(multi3.colW, column, "G1 the measure is the same in every slot");
  assert(root3.inertBody, "G4 a folded pane's content is out of reach");

  // ------------------------------- spine click brings the root back
  await page.locator(`.reader-pane[data-node-id="${rootId}"] .pane-spine`).click();
  g = await stage("spine brings the root back", page);
  assert(!g.panes[0].folded && g.panes[0].current, `G3 a spine opens its document: ${JSON.stringify(g.panes)}`);
  assert(g.panes[2].folded, "the deepest answer parks as a spine on the right");

  // -------------------------------------- trackpad: code block scrolls itself
  await page.evaluate((id) => {
    const scroller = document.querySelector(`.reader-pane[data-node-id="${id}"] .pane-scroll`);
    const pre = scroller.querySelector("pre");
    scroller.scrollTop += pre.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 200;
  }, rootId);
  const pre = await page.locator(`.reader-pane[data-node-id="${rootId}"] pre`).first().boundingBox();
  await page.mouse.move(pre.x + 60, pre.y + pre.height / 2);
  const before = await positions(page);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(40, 0);
    await page.waitForTimeout(16);
  }
  await settle(page);
  assert.deepEqual(await positions(page), before, "M6 a sideways swipe over a code block scrolls the code, not the trail");
  assert(await page.evaluate((id) => document.querySelector(`.reader-pane[data-node-id="${id}"] pre`).scrollLeft > 0, rootId), "the code block took the swipe");

  // ------------------------------------------ trackpad: a swipe pages
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 6); // a new gesture, decided vertical — must not move the trail
  await page.waitForTimeout(200);
  assert.deepEqual(await positions(page), before, "M5 a vertical gesture never moves the trail");
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(60, 1);
    await page.waitForTimeout(16);
  }
  const mid = await positions(page);
  assert.notDeepEqual(mid, before, "M8 the trail follows the fingers while they move");
  g = await stage("swipe settles on a pane", page);
  assert(g.panes[1].current && !g.panes[1].folded && !g.panes[2].folded, `M1 a swipe settles with whole panes in view: ${JSON.stringify(g.panes)}`);
  assertOnSlots(g, "M1");
  assert(!errors.length, errors.join("\n"));

  // overscroll past the end gives, then returns
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(90, 0);
    await page.waitForTimeout(16);
  }
  const stretched = await positions(page);
  g = await stage("rubber band returns", page);
  assertOnSlots(g, "M3");
  assert.notDeepEqual(stretched, await positions(page), "M3 past the end the trail gives a little");

  // ------------------------------------------------ keyboard
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
  assert(g.panes[1].current, "B6 after a swipe the document in front of you is current");
  await page.keyboard.press("ArrowRight");
  g = await stage("arrow right walks on", page);
  assert(g.panes[2].current, "→ makes the next document current");
  await page.keyboard.press("ArrowLeft");
  g = await stage("arrow left walks back", page);
  assert(g.panes[1].current, "← makes the previous document current");
  await page.keyboard.press("Escape");
  g = await stage("escape closes the deepest pane", page);
  assert.equal(g.panes.length, 2, "B8 Esc closes the deepest answer first");
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), false);

  // ---------------------------------------- canvas and back keeps the trail
  await page.locator("#reader-restore").click();
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  const currentCard = await page.evaluate(() => document.querySelector(".card.current")?.dataset.id);
  assert.equal(currentCard, g.panes.find((p) => p.current).id, "B9 back to canvas lands on the current document's card");
  await page.evaluate(() => document.querySelector(".card.current [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  g = await stage("re-entering keeps the trail", page);
  assert.equal(g.panes.length, 2, "B9 re-entering the reader keeps the trail");

  // ------------------------------------------------ text size, per pane
  const otherCol = g.panes.find((p) => !p.current);
  const otherSize = await fontSize(page, otherCol.id);
  await page.locator("#r-textup").click();
  g = await stage("text size grows the current pane only", page);
  assert.equal(await fontSize(page, otherCol.id), otherSize, "B12 A+ resizes only the current document");
  await assertDotsOnMarks(page, "B15 a larger text size carries its dots along");

  // ------------------------------------------------ narrow window
  await page.setViewportSize({ width: 1000, height: 900 });
  g = await stage("narrow window shows one pane", page);
  const open = g.panes.filter((p) => !p.folded);
  assert.equal(open.length, 1, "M10 a narrow window shows one document");
  assert(open[0].current, "M10 the document you are in is the one shown");
  assertOnSlots(g, "M10");
  await assertDotsOnMarks(page, "B15 a re-wrapped column carries its dots along");
  await page.setViewportSize({ width: 1440, height: 900 });
  g = await stage("wide again shows two", page);
  assert.equal(g.panes.filter((p) => !p.folded).length, 2, "M10 widening restores the pair");

  // ------------------------------------------------ phone: swipe back
  await page.setViewportSize({ width: 700, height: 900 });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  g = await stage("compact shows one full-bleed pane", page);
  const phonePane = g.panes.find((p) => !p.folded);
  assert.equal(Math.round(phonePane.w), g.stageW, "B13 a phone pane is full bleed");
  assert.equal(await page.locator(".pane-spine:visible").count(), 0, "B13 no spines on a phone");
  const startIndex = g.panes.indexOf(phonePane);
  assert(startIndex > 0, "phone opens on the answer");
  await touchSwipe(cdp, 120, 500, 560);
  g = await stage("phone swipe right reveals the source", page);
  assert.equal(g.panes.findIndex((p) => !p.folded), startIndex - 1, "B13 swiping right returns to the source");
  await assertDotsOnMarks(page, "B15 the source's dots sit on their marks after the phone re-wrap");
  await touchSwipe(cdp, 560, 500, 120);
  g = await stage("phone swipe left returns to the answer", page);
  assert.equal(g.panes.findIndex((p) => !p.folded), startIndex, "B13 swiping left goes back to the answer");

  assert(!errors.length, errors.join("\n"));
  await context.close();
  await fs.writeFile(path.join(ARTIFACTS, "trace.json"), JSON.stringify(trace, null, 2) + "\n");
  console.log(`ok e2e reader trail: ${trace.stages.length} stages, artifact at ${path.relative(ROOT, ARTIFACTS)}/trace.json`);
} finally {
  await app.close();
}

// ---------------------------------------------------------------------------
async function stage(name, page) {
  await settle(page);
  const geometry = await page.evaluate(() => {
    const stageEl = document.getElementById("reader-main");
    const s = stageEl.getBoundingClientRect();
    return {
      stageW: Math.round(s.width),
      panes: [...stageEl.querySelectorAll(".reader-pane:not(.pane-leaving)")].map((el) => {
        const r = el.getBoundingClientRect();
        const col = el.querySelector(".reader-col").getBoundingClientRect();
        const scroll = el.querySelector(".pane-scroll");
        return {
          id: el.dataset.nodeId,
          title: el.getAttribute("aria-label"),
          x: Math.round((r.left - s.left) * 100) / 100,
          w: Math.round(r.width * 100) / 100,
          colW: Math.round(col.width * 100) / 100,
          folded: el.classList.contains("pane-folded"),
          current: el.classList.contains("current"),
          scrollTop: scroll.scrollTop,
          inertBody: scroll.inert,
        };
      }),
    };
  });
  const file = `${String(trace.stages.length + 1).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, file) });
  // Titles and positions, not node ids: ids are random per run, the trace isn't.
  trace.stages.push({
    name,
    screenshot: file,
    stageW: geometry.stageW,
    panes: geometry.panes.map(({ id, ...rest }) => rest),
  });
  return geometry;
}

// Wait until no pane has moved for 250ms: longer than the stage's wheel-idle
// window (140ms), during which a gesture is still live but can be still.
async function settle(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__trailSince = performance.now();
    w.__trailLast = null;
  });
  await page.waitForFunction(() => {
    const now = [...document.querySelectorAll(".reader-pane")].map((p) => p.style.transform).join("|");
    const w = /** @type {any} */ (window);
    if (w.__trailLast !== now) {
      w.__trailLast = now;
      w.__trailSince = performance.now();
    }
    return performance.now() - w.__trailSince >= 250;
  }, null, { polling: "raf", timeout: 5000 });
}

async function positions(page) {
  return page.evaluate(() => [...document.querySelectorAll(".reader-pane:not(.pane-leaving)")].map((p) => p.style.transform));
}

function assertOnSlots(g, label) {
  const open = g.panes.filter((p) => !p.folded);
  for (const pane of open) assert(pane.x >= 0 && pane.x + pane.w <= g.stageW + 0.5, `${label} open panes sit wholly on the stage: ${JSON.stringify(g)}`);
  for (let i = 1; i < open.length; i++) assert(open[i - 1].x + open[i - 1].w <= open[i].x + 0.5, `${label} open panes never overlap`);
}

async function ask(page, paneId, text, question) {
  await selectVisibleText(page, { text, rootSelector: `.reader-pane[data-node-id="${paneId}"] .doc-content` });
  await page.fill("#ask-text", question);
  // The place the reader is at the moment they ask — selecting may have
  // scrolled the text into view; from here on nothing may move it.
  const place = await page.evaluate((id) => document.querySelector(`.reader-pane[data-node-id="${id}"] .pane-scroll`).scrollTop, paneId);
  await page.keyboard.press("Meta+Enter");
  await page.waitForFunction((q) => [...document.querySelectorAll(".reader-context")].some((el) => el.textContent.includes(q)), question);
  return place;
}

async function scrollPane(page, id, top) {
  await page.evaluate(([paneId, value]) => {
    document.querySelector(`.reader-pane[data-node-id="${paneId}"] .pane-scroll`).scrollTop = value;
  }, [id, top]);
}

async function paneText(page, id, text) {
  await page.waitForFunction(([paneId, needle]) => document.querySelector(`.reader-pane[data-node-id="${paneId}"] .doc-content`)?.textContent.includes(needle), [id, text]);
  return true;
}

async function lineBoxes(page, id, needle) {
  return page.evaluate(([paneId, word]) => {
    const doc = document.querySelector(`.reader-pane[data-node-id="${paneId}"] .doc-content`);
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange();
      range.selectNodeContents(node.parentElement);
      // Line count and each line's width: identical iff nothing re-wrapped.
      return [...range.getClientRects()].map((r) => Math.round(r.width));
    }
    return null;
  }, [id, needle]);
}

async function assertComposerUnder(page, paneId, label) {
  const { composer, col } = await page.evaluate((id) => {
    const c = document.getElementById("composer-inner").getBoundingClientRect();
    const colRect = document.querySelector(`.reader-pane[data-node-id="${id}"] .reader-col`).getBoundingClientRect();
    return { composer: { left: c.left, right: c.right }, col: { left: colRect.left, right: colRect.right } };
  }, paneId);
  assert(Math.abs(composer.left - col.left) <= 1 && Math.abs(composer.right - col.right) <= 1, `${label}: ${JSON.stringify({ composer, col })}`);
}

// Panes run the whole height of the window: the composer floats over the foot
// of the current one instead of taking a band of its own.
async function assertComposerFloats(page, label) {
  const m = await page.evaluate(() => {
    const stage = document.getElementById("reader-main").getBoundingClientRect();
    const pane = document.querySelector(".reader-pane.current").getBoundingClientRect();
    const composer = document.getElementById("composer-inner").getBoundingClientRect();
    return { stageBottom: stage.bottom, paneBottom: pane.bottom, windowBottom: innerHeight, composerTop: composer.top, composerBottom: composer.bottom };
  });
  assert(Math.abs(m.paneBottom - m.windowBottom) <= 1 && Math.abs(m.stageBottom - m.windowBottom) <= 1, `${label}: ${JSON.stringify(m)}`);
  assert(m.composerTop > m.windowBottom - 160 && m.composerBottom < m.windowBottom, `${label}: ${JSON.stringify(m)}`);
}

// Every dot in an open pane sits on the first line of the mark it stands for.
async function assertDotsOnMarks(page, label) {
  const misses = await page.evaluate(() => {
    const out = [];
    for (const pane of document.querySelectorAll(".reader-pane:not(.pane-leaving)")) {
      if (getComputedStyle(pane).visibility === "hidden") continue;
      for (const dot of pane.querySelectorAll(".branch-dot[data-note], .note-dot[data-note]")) {
        const mark = pane.querySelector(`mark[data-child="${dot.dataset.note}"]`);
        const line = mark && mark.getClientRects()[0];
        if (!line) continue;
        const d = dot.getBoundingClientRect();
        const drift = Math.abs(d.top + d.height / 2 - (line.top + line.height / 2));
        if (drift > 2) out.push({ note: dot.dataset.note.slice(0, 6), drift: Math.round(drift) });
      }
    }
    return out;
  });
  assert.deepEqual(misses, [], `${label}: ${JSON.stringify(misses)}`);
}

async function fontSize(page, id) {
  return page.evaluate((paneId) => getComputedStyle(document.querySelector(`.reader-pane[data-node-id="${paneId}"] .doc-content`)).fontSize, id);
}

async function touchSwipe(cdp, fromX, y, toX) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y }] });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fromX + ((toX - fromX) * i) / steps, y }] });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
