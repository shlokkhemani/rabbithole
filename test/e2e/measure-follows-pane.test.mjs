/** @protects one motion, not two: a document's text widens and narrows with its pane as the pane moves, never re-wrapping once it has landed, and the line being read stays put. */
// Failure modes, written before the fix; assertion messages carry the labels.
//   X1 closing the pane beside, the document left alone slides to the whole
//      window and only then re-wraps wider: the text jumps after the motion
//   X2 the measure jumps inside a motion (a second pane arriving narrows the
//      text in one frame) instead of following its pane's width
//   X3 mid-motion the text is wider than its pane, and is cut at its edges
//   X4 the line being read drifts while the text re-wraps under it
// Each motion is recorded frame by frame on a long document: the pane's
// width, its text's width, where the line being read sits, and when the frame
// ran (a whole 25,000-word document re-wrapping every frame still stays
// under 20ms a frame here, so frame times are kept, not asserted). Ends by writing
// test-artifacts/measure-follows-pane/trace.json.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { selectVisibleText } from "../support/visible-selection.mjs";
import { bootWebApp, ROOT } from "../support/web-app-harness.mjs";

const ARTIFACTS = path.join(ROOT, "test-artifacts", "measure-follows-pane");
const PAD = 40;
const trace = {};
const words = (seed, n) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
// About 25,000 words. One paragraph is long, and read from its middle: a re-wrap moves its later
// lines far, so a place that is not held shows.
const paragraph = (j) => (j === 120 ? `ROOTP120 ${words("long", 300)} MIDDLE MARKER ${words("tail", 300)}` : `ROOTP${j} ${words(`r${j}w`, 100)}`);
const ROOT_DOC = `# A long document\n\n${Array.from({ length: 250 }, (_, j) => paragraph(j)).join("\n\n")}`;
const ANSWER = ["# The answer\n\n", `The answer opens here. ${words("a", 300)}\n`];

await fs.rm(ARTIFACTS, { recursive: true, force: true });
const app = await bootWebApp();
try {
  const context = await app.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeProvider(page, { streams: [ANSWER] });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown), ROOT_DOC);
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });
  await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await settle(page);
  const rootId = await page.locator(".reader-pane").first().getAttribute("data-node-id");
  const rootText = `.reader-pane[data-node-id="${rootId}"] .doc-content`;

  // Read into the middle of the long paragraph, then ask about a line in view.
  await page.evaluate((selector) => {
    const block = [...document.querySelectorAll(`${selector} > p`)].find((p) => p.textContent.startsWith("ROOTP120 "));
    block.scrollIntoView({ block: "start" });
    const scroll = block.closest(".pane-scroll");
    scroll.scrollTop += block.getBoundingClientRect().height * 0.3;
  }, rootText);
  await settle(page);
  await selectVisibleText(page, { text: "MIDDLE MARKER", rootSelector: rootText });
  await page.fill("#ask-text", "Why?");
  await record(page, rootId);
  await page.keyboard.press("Meta+Enter");
  await page.waitForFunction(() => document.querySelectorAll(".reader-pane:not(.pane-leaving)").length === 2);
  await settle(page);
  const opening = await stopRecording(page);
  trace.opening = opening;
  await page.waitForFunction(() => !document.querySelector(".composer-waiting"));
  await settle(page);

  const answerId = await page.locator(".reader-pane:not(.pane-leaving)").nth(1).getAttribute("data-node-id");
  await record(page, rootId);
  await page.locator(`.reader-pane[data-node-id="${answerId}"] .pane-close`).click();
  await page.waitForFunction(() => document.querySelectorAll(".reader-pane:not(.pane-leaving)").length === 1);
  await settle(page);
  const closing = await stopRecording(page);
  trace.closing = closing;

  const lineHeight = await page.evaluate((selector) => parseFloat(getComputedStyle(document.querySelector(`${selector} > p`)).lineHeight), rootText);
  // Every check runs, so a regression names every way it fails.
  const failures = [];
  const check = (ok, label) => {
    if (!ok) failures.push(label);
    return ok;
  };
  for (const [name, frames] of Object.entries({ opening, closing })) {
    const root = frames.map((f) => f.root);
    const last = root.at(-1);
    assert(root.length > 5, `${name}: the motion was recorded: ${root.length} frames`);
    assert(Math.abs(root[0].col - last.col) > 100, `${name}: the measure changes across the motion: ${root[0].col} → ${last.col}`);
    // A spring spends a long, slow tail on its last few pixels: to the eye the
    // pane has landed once it has covered 95% of its way. The text must be at
    // its measure by then, not re-wrapping through the tail or after it.
    const landing = root.findIndex((f) => Math.abs(f.box - root[0].box) >= 0.95 * Math.abs(last.box - root[0].box));
    const late = root.slice(landing).filter((f) => Math.abs(f.col - last.col) > 0.5);
    check(late.length === 0, `X1 ${name}: by the time the pane lands its text is already at its measure: ${JSON.stringify(late.slice(0, 4))}`);
    for (let i = 1; i < root.length; i++) {
      const dCol = Math.abs(root[i].col - root[i - 1].col);
      const dBox = Math.abs(root[i].box - root[i - 1].box);
      if (!check(dCol <= dBox + 1, `X2 ${name}: the text's width follows its pane's, frame by frame: ${JSON.stringify(root.slice(i - 1, i + 1))}`)) break;
    }
    const overflowing = root.filter((f) => f.col > f.box - 2 * PAD + 1);
    check(!overflowing.length, `X3 ${name}: the text always fits inside its pane: ${JSON.stringify(overflowing.slice(0, 2))}`);
    // Only one character can be held to the pixel while words move between
    // lines; the line it was on, or the next, is where the reader still is.
    const drift = Math.max(...root.map((f) => Math.abs(f.line - root[0].line)));
    check(drift <= lineHeight + 2, `X4 ${name}: the line being read stays put while the text re-wraps: ${drift}px ${JSON.stringify(root.map((f) => f.line))}`);
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, [], "no page errors");
} finally {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.writeFile(path.join(ARTIFACTS, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`);
  await app.close();
}
console.log("ok e2e measure follows pane: text widens and narrows with its pane, in one motion");

// On every frame: the root pane's width, its text's width, and the height of
// the line that was at the top of its view when recording began.
async function record(page, rootId) {
  await page.evaluate((id) => {
    const w = /** @type {any} */ (window);
    const scroll = document.querySelector(`.reader-pane[data-node-id="${id}"] .pane-scroll`);
    const top = () => scroll.getBoundingClientRect().top;
    // The first character at or below the top edge: the line being read.
    const walker = document.createTreeWalker(scroll.querySelector(".doc-content"), NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let anchor = null;
    for (let node = walker.nextNode(); node && !anchor; node = walker.nextNode()) {
      if (!node.data.trim()) continue;
      range.selectNodeContents(node);
      const whole = range.getBoundingClientRect();
      if (!whole.height || whole.bottom <= top()) continue;
      for (let i = 0; i < node.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.height && rect.top >= top() - 0.5 && node.data[i].trim()) {
          anchor = { node, i };
          break;
        }
      }
    }
    const lineY = () => {
      range.setStart(anchor.node, anchor.i);
      range.setEnd(anchor.node, anchor.i + 1);
      return Math.round((range.getBoundingClientRect().top - top()) * 10) / 10;
    };
    const pane = scroll.closest(".reader-pane");
    w.__frames = [];
    w.__recording = true;
    const tick = (t) => {
      w.__frames.push({
        t,
        root: {
          box: Math.round(pane.getBoundingClientRect().width * 10) / 10,
          col: Math.round(pane.querySelector(".reader-col").getBoundingClientRect().width * 10) / 10,
          line: lineY(),
        },
      });
      if (w.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, rootId);
}

async function stopRecording(page) {
  return page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__recording = false;
    return w.__frames;
  });
}

// Until no pane has moved or re-wrapped for 250ms.
async function settle(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__since = performance.now();
    w.__last = null;
  });
  await page.waitForFunction(() => {
    const now = [...document.querySelectorAll(".reader-pane")]
      .map((p) => p.style.transform + p.style.width + p.querySelector(".reader-col").getBoundingClientRect().width)
      .join("|");
    const w = /** @type {any} */ (window);
    if (w.__last !== now) {
      w.__last = now;
      w.__since = performance.now();
    }
    return performance.now() - w.__since >= 250;
  }, null, { polling: "raf", timeout: 8000 });
}
