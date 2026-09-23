/** @protects pinning and unpinning a card keep its reading place. */
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

  await context.close();
  console.log("ok e2e pinned scroll: pin and unpin keep a card's reading place");
} finally {
  await app.close();
}
