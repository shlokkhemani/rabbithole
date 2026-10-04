/** @protects a long ask reads as its first lines in the reader: More opens the rest in place, and the strip stays as the reader left it. */
// Failure modes, written before the fix; assertion messages carry the labels.
//   L1 a long question fills the strip above the answer, however long it is
//   L2 a clamped ask leaves no way to read the rest of it
//   L3 opening the rest jumps to the origin instead (the strip is a link)
//   L4 Enter on the toggle jumps to the origin instead
//   L5 the strip snaps shut when the answer renders again (a new mark, the
//      canvas and back)
//   L6 Less does not clamp it again
//   L7 a short question grows a toggle it has no use for
// Ends by writing test-artifacts/long-ask-strip/{trace.json,clamped.png,opened.png}.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { selectVisibleText } from "../support/visible-selection.mjs";
import { bootWebApp, ROOT } from "../support/web-app-harness.mjs";

const ARTIFACTS = path.join(ROOT, "test-artifacts", "long-ask-strip");
const trace = [];
const words = (seed, n) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
const ROOT_DOC = `# Root document\n\nThe asked sentence sits here. ${words("r", 60)}\n\n${words("s", 200)}`;
const LONG_QUESTION = `Explain this carefully. ${words("q", 160)} LASTWORD`;
const answer = (title, seed) => [`# ${title}\n\n${title} opens here. ${words(seed, 40)}\n\n`, `${words(`${seed}x`, 200)}\n`];
const failures = [];
const check = (ok, label, data) => {
  trace.push({ label, ok, ...data });
  if (!ok) failures.push(`${label}: ${JSON.stringify(data)}`);
};

await fs.rm(ARTIFACTS, { recursive: true, force: true });
const app = await bootWebApp();
try {
  const context = await app.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeProvider(page, { streams: [answer("Long answer", "aa"), answer("Short answer", "bb")] });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown), ROOT_DOC);
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });
  await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  const rootId = await page.locator(".reader-pane").first().getAttribute("data-node-id");
  await ask(page, rootId, "The asked sentence sits here", LONG_QUESTION, "Long answer opens here");
  const answerId = await page.locator(".reader-pane").nth(1).getAttribute("data-node-id");

  const clamped = await strip(page, answerId);
  check(clamped.lines <= 4.05, "L1 a long question shows at most four lines", clamped);
  check(clamped.more === "visible", "L2 a clamped ask offers More", clamped);
  await shoot(page, answerId, "clamped.png");

  await page.locator(`.reader-pane[data-node-id="${answerId}"] .rc-more`).click();
  await settleFrames(page);
  const opened = await strip(page, answerId);
  check(opened.lastWordShown && opened.lines > 4, "L2 More shows the whole question", opened);
  check(opened.current === answerId, "L3 More stays in the answer (no jump to the origin)", opened);
  await shoot(page, answerId, "opened.png");

  await page.locator(`.reader-pane[data-node-id="${answerId}"] .rc-more`).focus();
  await page.keyboard.press("Enter");
  await settleFrames(page);
  const keyed = await strip(page, answerId);
  check(keyed.current === answerId && keyed.lines <= 4.05, "L4 Enter on the toggle closes it and stays in the answer", keyed);
  await page.keyboard.press("Enter");
  await settleFrames(page);

  // Asking from the answer marks it; the reader renders it again once back
  // from the canvas.
  await ask(page, answerId, "Long answer opens here", "Short?", "Short answer opens here");
  const shortId = await page.locator(".reader-pane").last().getAttribute("data-node-id");
  await page.evaluate((id) => { document.querySelector(`.reader-pane[data-node-id="${id}"] .reader-context`).dataset.before = "1"; }, answerId);
  await page.locator("#reader-restore").click();
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await page.evaluate((id) => document.querySelector(`.card[data-id="${id}"] [aria-label='Expand document']`).click(), shortId);
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await settleFrames(page);
  const rerendered = await page.evaluate((id) => !document.querySelector(`.reader-pane[data-node-id="${id}"] .reader-context`).dataset.before, answerId);
  assert(rerendered, "the answer was rendered again (the setup L5 needs)");
  const afterRender = await strip(page, answerId);
  check(afterRender.lastWordShown, "L5 the strip stays open across a re-render", afterRender);

  await page.locator(`.reader-pane[data-node-id="${answerId}"] .rc-more`).click();
  await settleFrames(page);
  const closed = await strip(page, answerId);
  check(closed.lines <= 4.05 && !closed.lastWordShown, "L6 Less clamps it again", closed);

  const short = await strip(page, shortId);
  check(short.more === "hidden" && short.lines <= 1.05, "L7 a short question shows no toggle", short);

  assert.deepEqual(failures, []);
  assert.deepEqual(errors, [], "no page errors");
} finally {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.writeFile(path.join(ARTIFACTS, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`);
  await app.close();
}
console.log("ok e2e long ask strip: a long ask clamps, opens in place, and stays as left");

// How many lines the strip's text shows, whether its last word is on screen,
// the toggle's state, and which pane is current.
async function strip(page, id) {
  return page.evaluate((paneId) => {
    const ctx = document.querySelector(`.reader-pane[data-node-id="${paneId}"] .reader-context`);
    const text = ctx.querySelector(".rc-text");
    const more = ctx.querySelector(".rc-more");
    const box = text.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
    let lastWordShown = false;
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf("LASTWORD");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 8);
      const rect = range.getBoundingClientRect();
      lastWordShown = rect.height > 0 && rect.bottom <= box.bottom + 0.5;
    }
    return {
      lines: box.height / lineHeight,
      lastWordShown,
      more: !more ? "absent" : more.hidden || !more.getClientRects().length ? "hidden" : "visible",
      current: document.querySelector(".reader-pane.current")?.getAttribute("data-node-id") || null,
    };
  }, id);
}

async function shoot(page, id, name) {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  const box = await page.locator(`.reader-pane[data-node-id="${id}"] .reader-context`).boundingBox();
  await page.screenshot({ path: path.join(ARTIFACTS, name), clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 120 } });
}

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

async function ask(page, paneId, text, question, arrived) {
  await selectVisibleText(page, { text, rootSelector: `.reader-pane[data-node-id="${paneId}"] .doc-content` });
  await page.fill("#ask-text", question);
  await page.keyboard.press("Meta+Enter");
  await page.waitForFunction(
    (needle) => [...document.querySelectorAll(".reader-pane .doc-content")].some((doc) => doc.textContent.includes(needle)),
    arrived,
  );
  await page.waitForFunction(() => !document.querySelector(".composer-waiting"));
  // The trail slides the new answer in.
  await page.waitForTimeout(900);
  await settleFrames(page);
}
