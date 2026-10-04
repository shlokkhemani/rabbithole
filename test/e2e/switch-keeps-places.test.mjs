/** @protects one place per document: switching between the canvas and the reader keeps every document where it was read to, not only the one switched through. */
// Failure modes, written before the fix; assertion messages carry the labels.
//   P1 leaving the reader, a card whose document was read in a pane but is not
//      the one collapsed into opens at its old canvas place (or the top)
//   P2 entering the reader, a pane opens at its old reader place instead of
//      where its card was read to on the canvas
//   P3 switching back and forth without reading creeps: every switch moves
//      the place by a few pixels (rounding, the browser's scroll anchoring)
//   P4 a document read from its top does not open at its top
// A place is compared by content: the block at the top of the view and how
// far into it the view begins (a card and a pane wrap text differently).
// Ends by writing test-artifacts/switch-keeps-places/trace.json.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { selectVisibleText } from "../support/visible-selection.mjs";
import { bootWebApp, ROOT } from "../support/web-app-harness.mjs";

const ARTIFACTS = path.join(ROOT, "test-artifacts", "switch-keeps-places");
const trace = [];
const words = (seed, n) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
const paragraphs = (seed) =>
  Array.from({ length: 30 }, (_, j) => `${seed.toUpperCase()}P${j} ${words(`${seed}${j}w`, 70)}`).join("\n\n");
const ROOT_DOC = `# Root document\n\nThe root opens here. ${words("r", 40)}\n\n${paragraphs("root")}`;
const answer = (title, seed) => [`# ${title}\n\n${title} opens here. ${words(seed, 40)}\n\n`, `${paragraphs(seed)}\n`];

await fs.rm(ARTIFACTS, { recursive: true, force: true });
const app = await bootWebApp();
try {
  const context = await app.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeProvider(page, { streams: [answer("First answer", "aa"), answer("Second answer", "bb")] });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown), ROOT_DOC);
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });
  await expandCard(page, await page.locator(".card.root").getAttribute("data-id"));
  const rootId = await page.locator(".reader-pane").first().getAttribute("data-node-id");
  await ask(page, rootId, "The root opens here", "First?", "AAP29");
  const firstId = await page.locator(".reader-pane").nth(1).getAttribute("data-node-id");
  await ask(page, firstId, "First answer opens here", "Second?", "BBP29");
  const secondId = await page.locator(".reader-pane").nth(2).getAttribute("data-node-id");
  const ids = [rootId, firstId, secondId];

  // ------------------------------------------------ reader → canvas
  await scrollAll(page, "pane", { [rootId]: 2000, [firstId]: 1500, [secondId]: 1000 });
  const read = await places(page, "pane", ids);
  await leaveReader(page);
  const cards = await places(page, "card", ids);
  record("reader → canvas", { read, cards });
  for (const id of ids) assertSamePlace(cards[id], read[id], `P1 leaving the reader, every card opens where its document was read (${id === secondId ? "current" : "not current"})`);

  // ------------------------------------------------ canvas → reader
  await scrollAll(page, "card", { [rootId]: 900, [firstId]: 0, [secondId]: 500 });
  const onCanvas = await places(page, "card", ids);
  await expandCard(page, secondId);
  const panes = await places(page, "pane", ids);
  record("canvas → reader", { onCanvas, panes });
  for (const id of ids) {
    if (id === firstId) continue;
    assertSamePlace(panes[id], onCanvas[id], `P2 entering the reader, every pane opens where its card was read (${id === secondId ? "current" : "not current"})`);
  }
  assert.equal(panes[firstId].top, 0, "P4 a document read from its top opens at its top");

  // ------------------------------------------------ back and forth, reading nothing
  const pixels = await pixelsOf(page, "pane", ids);
  for (let i = 0; i < 5; i++) {
    await leaveReader(page);
    await expandCard(page, secondId);
  }
  const after = await pixelsOf(page, "pane", ids);
  await leaveReader(page);
  const cardPixels = await pixelsOf(page, "card", ids);
  record("five round trips", { pixels, after, cardPixels });
  assert.deepEqual(after, pixels, "P3 five round trips leave every pane exactly where it was");
  assert.deepEqual(cardPixels, { [rootId]: 900, [firstId]: 0, [secondId]: 500 }, "P3 ... and every card");

  assert.deepEqual(errors, [], "no page errors");
} finally {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.writeFile(path.join(ARTIFACTS, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`);
  await app.close();
}
console.log("ok e2e switch keeps places: every document keeps its place across canvas and reader");

function record(step, data) {
  trace.push({ step, ...data });
}

function scrollerSelector(kind, id) {
  return kind === "pane" ? `.reader-pane[data-node-id="${id}"] .pane-scroll` : `.card[data-id="${id}"] > .card-body`;
}

async function scrollAll(page, kind, tops) {
  await page.evaluate(
    ([entries]) => {
      for (const [selector, top] of entries) document.querySelector(selector).scrollTop = top;
    },
    [Object.entries(tops).map(([id, top]) => [scrollerSelector(kind, id), top])],
  );
  // Scroll events are delivered with the next frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// The block at the top of each view, and how far into it the view begins.
async function places(page, kind, ids) {
  return page.evaluate(
    (selectors) => {
      const out = {};
      for (const [id, selector] of selectors) {
        const scroller = document.querySelector(selector);
        const top = scroller.getBoundingClientRect().top;
        let place = null;
        for (const block of scroller.querySelectorAll(".doc-content > *")) {
          const rect = block.getBoundingClientRect();
          if (rect.bottom > top + 0.5) {
            place = { block: block.textContent.slice(0, 8), into: (top - rect.top) / rect.height, top: scroller.scrollTop };
            break;
          }
        }
        out[id] = place;
      }
      return out;
    },
    ids.map((id) => [id, scrollerSelector(kind, id)]),
  );
}

async function pixelsOf(page, kind, ids) {
  return page.evaluate(
    (selectors) => Object.fromEntries(selectors.map(([id, selector]) => [id, document.querySelector(selector).scrollTop])),
    ids.map((id) => [id, scrollerSelector(kind, id)]),
  );
}

function assertSamePlace(now, before, label) {
  assert(
    now && before && now.block === before.block && Math.abs(now.into - before.into) < 0.05,
    `${label}: ${JSON.stringify({ before, now })}`,
  );
}

async function expandCard(page, id) {
  await page.evaluate((cardId) => document.querySelector(`.card[data-id="${cardId}"] [aria-label='Expand document']`).click(), id);
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await settleFrames(page);
}

async function leaveReader(page) {
  await page.locator("#reader-restore").click();
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await settleFrames(page);
}

// Places are set under a hold released a couple of frames later.
async function settleFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const tick = () => (++n >= 6 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
  );
}

async function ask(page, paneId, text, question, lastWords) {
  await selectVisibleText(page, { text, rootSelector: `.reader-pane[data-node-id="${paneId}"] .doc-content` });
  await page.fill("#ask-text", question);
  await page.keyboard.press("Meta+Enter");
  await page.waitForFunction(
    (needle) => [...document.querySelectorAll(".reader-pane .doc-content")].some((doc) => doc.textContent.includes(needle)),
    lastWords,
  );
  // The answer has finished once its composer returns.
  await page.waitForFunction(() => !document.querySelector(".composer-waiting"));
  await settleFrames(page);
}
