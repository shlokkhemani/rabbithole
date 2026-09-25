/** @protects pinning, unpinning and resizing text keep a card's reading place. */
import assert from "node:assert/strict";
import { seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { bootWebApp } from "../support/web-app-harness.mjs";

const app = await bootWebApp();
try {
  const context = await app.browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  const paragraphs = Array.from({ length: 80 }, (_, index) =>
    `Paragraph ${index} carries enough words to fill a whole line of the card body.`);
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown),
    ["# Long read", "", ...paragraphs.flatMap((paragraph) => [paragraph, ""])].join("\n"));
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });
  const scrolled = await page.evaluate(() => {
    const body = document.querySelector(".card.root .card-body");
    body.scrollTop = 600;
    return body.scrollTop;
  });
  assert(scrolled > 300, `the card body must scroll: ${scrolled}`);

  await page.evaluate(() => document.querySelector(".card.root .card-more").click());
  await page.locator("#cm-pin").evaluate((button) => button.click());
  await page.waitForSelector(".pinned-window-card .card-body");
  assert.equal(await page.evaluate(() => document.querySelector(".pinned-window-card .card-body").scrollTop), scrolled,
    "pinning moves the live card without throwing away its scroll position");

  await page.locator(".pinned-window-card .pinned-pin").evaluate((button) => button.click());
  await page.waitForSelector(".pinned-window-card", { state: "detached" });
  assert.equal(await page.evaluate(() => document.querySelector(".card.root .card-body").scrollTop), scrolled,
    "unpinning returns the card to the canvas on the same line");

  // Resizing text reflows every line; the line at the top edge must not move.
  // Long paragraphs make block-level anchoring drift, so this pins the line.
  const longRead = Array.from({ length: 40 }, (_, index) =>
    `Section ${index}. ` + Array.from({ length: 60 }, (_, word) => `w${index}x${word}`).join(" "));
  await page.evaluate((markdown) => window.__rabbitholeTest.createDocument(markdown),
    ["# Wrapped read", "", ...longRead.flatMap((paragraph) => [paragraph, ""])].join("\n"));
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });
  await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));

  // The oracle names a character by (text node index, offset) so it can be
  // found again after the reflow, whatever word it sits in.
  const topLine = (scrollerSelector) => page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    const edge = scroller.getBoundingClientRect().top;
    const walker = document.createTreeWalker(scroller.querySelector(".doc-content"), NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let index = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode(), index++) {
      for (let i = 0; i < node.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.height && rect.top >= edge - 0.5) return { index, char: i, offset: rect.top - edge };
      }
    }
    return null;
  }, scrollerSelector);
  const charOffset = (scrollerSelector, at) => page.evaluate(([selector, { index, char }]) => {
    const scroller = document.querySelector(selector);
    const walker = document.createTreeWalker(scroller.querySelector(".doc-content"), NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    for (let i = 0; i < index; i++) node = walker.nextNode();
    const range = document.createRange();
    range.setStart(node, char);
    range.setEnd(node, char + 1);
    return range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [scrollerSelector, at]);

  await page.evaluate(() => {
    const main = document.querySelector(".reader-pane.current .pane-scroll");
    main.scrollTop = main.scrollHeight * 0.45 + 37;
  });
  const readerLine = await topLine(".reader-pane.current .pane-scroll");
  for (const button of ["#r-textup", "#r-textup", "#r-textdown", "#r-textdown", "#r-textdown"]) {
    await page.locator(button).click();
    const offset = await charOffset(".reader-pane.current .pane-scroll", readerLine);
    assert(Math.abs(offset - readerLine.offset) <= 1,
      `reader: the top line stays at ${readerLine.offset}px after ${button}, got ${offset}`);
  }

  await page.locator("#reader-restore").click();
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await page.evaluate(() => {
    const body = document.querySelector(".card.root .card-body");
    body.scrollTop = body.scrollHeight * 0.4 + 23;
  });
  const cardLine = await topLine(".card.root .card-body");
  await page.evaluate(() => document.querySelector(".card.root .card-more").click());
  for (const button of ["#cm-textup", "#cm-textup", "#cm-textdown"]) {
    await page.locator(button).evaluate((element) => element.click());
    const offset = await charOffset(".card.root .card-body", cardLine);
    assert(Math.abs(offset - cardLine.offset) <= 1,
      `card: the top line stays at ${cardLine.offset}px after ${button}, got ${offset}`);
  }

  await context.close();
  console.log("ok e2e pinned scroll: pinning and text size keep a card's reading place");
} finally {
  await app.close();
}
