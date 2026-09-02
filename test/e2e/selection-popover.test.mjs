/** @protects selection popover capability contracts. */
import assert from "node:assert/strict";
import { bootWebApp } from "../support/web-app-harness.mjs";
import { assertSelectionPopoverUsable } from "../support/visible-selection.mjs";

const app = await bootWebApp();
const { browser, baseUrl } = app;

try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => window.__rabbitholeTest.createDocument([
    "# Paragraph selection",
    "",
    "The middle paragraph should open the selection popover.",
    "",
    "The final paragraph should open the selection popover too.",
  ].join("\n")));
  await page.waitForSelector(".card.root .doc-content p:nth-of-type(2)");

  const paragraphs = page.locator(".card.root .doc-content p");
  const wholeParagraph = "The middle paragraph should open the selection popover.";
  const paragraphBox = await paragraphs.nth(0).boundingBox();
  assert.ok(paragraphBox, "the triple-click target must have visible geometry");
  const paragraphPoint = { x: paragraphBox.x + 36, y: paragraphBox.y + 10 };
  const clickOnceWithCount = async (clickCount) => {
    await page.mouse.move(paragraphPoint.x, paragraphPoint.y);
    await page.mouse.down({ clickCount });
    await page.mouse.up({ clickCount });
  };
  await clickOnceWithCount(1);
  await clickOnceWithCount(2);
  await page.waitForSelector("#ask.visible");
  await paragraphs.nth(0).evaluate((paragraph) => {
    paragraph.addEventListener(
      "mouseup",
      () => {
        window.__tripleClickSelection = window.getSelection().toString();
      },
      { once: true },
    );
  });
  await clickOnceWithCount(3);
  assert.equal(
    await page.evaluate(() => window.__tripleClickSelection?.trim() || ""),
    wholeParagraph,
    "a third click through the open Ask surface must select the whole paragraph",
  );
  await page.waitForSelector("#ask.visible");

  await page.keyboard.press("Escape");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });

  await paragraphs.nth(0).click({ clickCount: 3, position: { x: 36, y: 10 } });
  await page.waitForSelector("#ask.visible");

  await page.keyboard.press("Escape");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });

  await paragraphs.nth(1).click({ clickCount: 3, position: { x: 36, y: 10 } });
  await page.waitForSelector("#ask.visible", { timeout: 1_000 });

  await page.keyboard.press("Escape");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  await page.evaluate(() => {
    const paragraphText = document.querySelector(".card.root .doc-content p:last-child").firstChild;
    const controlText = document.querySelector(".card.root .nc-handle").lastChild;
    const range = document.createRange();
    range.setStart(paragraphText, 0);
    range.setEnd(controlText, controlText.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForTimeout(50);
  assert.equal(await page.locator("#ask.visible").count(), 0,
    "a real selection extending into card controls must remain rejected");

  // The popover must stay with its selection while the canvas view moves
  // underneath it — a trackpad wheel-pan repositions the world without any
  // pointer leaving the surface open and stranded in screen space.
  await paragraphs.nth(0).click({ clickCount: 3, position: { x: 36, y: 10 } });
  await page.waitForSelector("#ask.visible");
  const attachment = await page.evaluate(async () => {
    const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const offsetFromAnchor = () => {
      const ask = document.getElementById("ask");
      const range = CSS.highlights.get("rh-ask").values().next().value;
      const anchor = range.getBoundingClientRect();
      return {
        x: Number.parseFloat(ask.style.left) - anchor.left,
        y: Number.parseFloat(ask.style.top) - anchor.bottom,
      };
    };
    await settle();
    const before = offsetFromAnchor();
    document.getElementById("viewport").dispatchEvent(
      new WheelEvent("wheel", { deltaX: 64, deltaY: 48, bubbles: true, cancelable: true }),
    );
    await settle();
    return { before, after: offsetFromAnchor() };
  });
  // getBoundingClientRect() includes the popover's 160 ms opening transform,
  // whose changing scale/translation can add a few visual pixels on a slow
  // runner. Layout attachment is the invariant; 0.01px only covers CSS-number
  // serialization (a stranded surface changes this offset by the 64/48px pan).
  const attachmentEpsilon = 0.01;
  assert.ok(
    Math.abs(attachment.after.x - attachment.before.x) <= attachmentEpsilon &&
      Math.abs(attachment.after.y - attachment.before.y) <= attachmentEpsilon,
    `the selection popover must preserve its anchor offset through a canvas pan ` +
      `(before ${attachment.before.x},${attachment.before.y}; after ${attachment.after.x},${attachment.after.y})`,
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });

  // The popover annotates visible text: pan the card fully off-screen and the
  // surface hides with it (still open, draft intact); pan back and it returns.
  await paragraphs.nth(0).click({ clickCount: 3, position: { x: 36, y: 10 } });
  await page.waitForSelector("#ask.visible");
  const wheelPan = (dx, dy) =>
    page.evaluate(async ([deltaX, deltaY]) => {
      document
        .getElementById("viewport")
        .dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, [dx, dy]);
  await wheelPan(2600, 0);
  await page.waitForSelector("#ask.visible[data-anchor-hidden]");
  await wheelPan(-2600, 0);
  await page.waitForSelector("#ask.visible:not([data-anchor-hidden])");

  // The same rule inside a card: scroll the selection out of the card body and
  // the popover hides; scroll back and it returns.
  await page.evaluate(() => {
    const dc = document.querySelector(".card.root .doc-content");
    for (let i = 0; i < 40; i++) {
      const p = document.createElement("p");
      p.textContent = `Filler paragraph ${i} so the card body scrolls.`;
      dc.appendChild(p);
    }
  });
  const scrollCardBody = (top) =>
    page.evaluate(async (scrollTop) => {
      document.querySelector(".card.root .card-body").scrollTop = scrollTop;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, top);
  await scrollCardBody(4000);
  await page.waitForSelector("#ask.visible[data-anchor-hidden]");
  await scrollCardBody(0);
  await page.waitForSelector("#ask.visible:not([data-anchor-hidden])");
  await assertSelectionPopoverUsable(page);
  await page.fill("#ask-text", "The returned popover still commits");
  await assertSelectionPopoverUsable(page);
  await page.click('#ask .ask-commit[data-commit="note"]', { timeout: 4_000 });
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  await page.waitForSelector(".card.root .note-dot");
  await page.waitForFunction(async () => (await window.__rabbitholeTest.readStoredHole()).nodes.some(
    (node) => node.origin?.kind === "note" && node.markdown === "The returned popover still commits",
  ));

  console.log("ok e2e: selection popover returns from hidden anchors and remains usable");
} finally {
  await app.close();
}
