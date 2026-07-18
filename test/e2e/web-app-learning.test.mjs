import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { extractSnapshotPayload } from "../../src/core/portable-import.js";
import { serializeForInlineScript } from "../../src/core/utils.js";
import { MOCK_MODEL, corsHeaders, routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { ROOT, bootWebApp } from "../support/web-app-harness.mjs";

const MOCK_KEY = `sk-or-v1-${"x".repeat(64)}`;
const BAD_KEY = `sk-or-v1-${"y".repeat(64)}`;
const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const MODEL_URL = "https://openrouter.ai/api/v1/models";
const LOCAL_MODEL_URL = "http://localhost:11434/v1/models";
const NOTICE_SOURCE = (await fs.readFile(path.join(ROOT, "src/ui/primitives/notice.js"), "utf8"))
  .replace("export function wireNotice", "window.wireNotice = function wireNotice");

const app = await bootWebApp();
const { browser, baseUrl } = app;
try {
  await verifyNoticePrimitive();
  await verifyStatefulCheckCycle();
  await verifyBranchContentSizing();
  await verifySharedCanvasDialogs();
  console.log("web app verification passed");
} finally {
  await app.close();
}

async function verifyBranchContentSizing() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const longAnswer = `# Long answer\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} fills the branch with enough rendered content to require scrolling.`).join("\n\n")}`;
  await routeProvider(page, { streams: [["# Brief answer\n\nJust enough."], [longAnswer]] });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rabbitholeTest);
  await createDocument(page, "# Sizing root\n\nAsk two follow-ups from here.");
  await page.click("#t-reader");
  await page.waitForSelector("#composer-text:visible");

  await page.fill("#composer-text", "Give me a brief answer");
  await page.click("#composer-send");
  const shortCard = page.locator(".node:not(.root)", { hasText: "Brief answer" });
  await shortCard.waitFor({ state: "attached" });
  await page.click("#r-canvas");
  await shortCard.waitFor();
  const shortSize = await shortCard.evaluate((el) => ({ height: el.offsetHeight, cap: parseFloat(el.style.maxHeight), bodyClient: el.querySelector(".node-body").clientHeight, bodyScroll: el.querySelector(".node-body").scrollHeight }));
  assert.equal(shortSize.cap, 460, "a branch should retain the saved/default height as its cap");
  assert(shortSize.height < shortSize.cap, `short branch should hug its content (${shortSize.height}px < ${shortSize.cap}px)`);
  assert(shortSize.bodyScroll <= shortSize.bodyClient + 1, "a short branch should not create an empty scrolling viewport");

  await page.click("#t-reader");
  await page.waitForSelector("#composer-text:visible");
  await page.fill("#composer-text", "Give me a long answer");
  await page.click("#composer-send");
  const longCard = page.locator(".node:not(.root)", { hasText: "Long answer" });
  await longCard.waitFor({ state: "attached" });
  await page.click("#r-canvas");
  await longCard.waitFor();
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll(".node:not(.root)"));
    const card = cards.find((el) => el.textContent.includes("Long answer"));
    const body = card?.querySelector(".node-body");
    return !!body && body.scrollHeight > body.clientHeight + 1;
  });
  const longSize = await longCard.evaluate((el) => ({ height: el.offsetHeight, cap: parseFloat(el.style.maxHeight), bodyClient: el.querySelector(".node-body").clientHeight, bodyScroll: el.querySelector(".node-body").scrollHeight }));
  assert.equal(longSize.height, longSize.cap, "a long branch should stop growing at its saved/default height");
  assert(longSize.bodyScroll > longSize.bodyClient + 1, "content beyond the branch cap should remain scrollable");

  await context.close();
  console.log("ok web app: branch cards hug short content and cap long content at the saved height");
}

async function verifyStatefulCheckCycle() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.keyboard.press("Escape");
  await createDocument(page, [
    "# Check cycle", "", "```check", '{"question":"Which is even?","options":["Three","Four"],"answer":1,"explanation":"Four divides by two."}', "```",
  ].join("\n"));
  await page.waitForSelector(".viz-check .rh-check-option:visible");
  const blockId = await page.locator('.doc-content .viz[data-viz="check"]').getAttribute("data-block-id").catch(() => null)
    || await page.evaluate(() => document.querySelector(".viz-check")?.getRootNode()?.host?.dataset?.blockId || "");
  const markdown = await page.evaluate(() => window.__rabbitholeTest.readStoredHole().then((hole) => hole.nodes[0].markdown));
  const durableId = blockId || markdown.match(/```check id=([a-z0-9]{4,8})/)?.[1];
  assert(durableId, "Check should have a durable persisted id");

  const second = page.locator(".viz-check .rh-check-option:visible").nth(1);
  await second.focus();
  await page.keyboard.press("Enter");
  assert.equal(await second.evaluate((button) => button.classList.contains("is-correct")), true, "native Check buttons should answer from the keyboard");
  assert.equal(await page.locator(".viz-check .rh-check-explanation:visible").count() > 0, true);

  const portable = await page.evaluate(() => window.__rabbitholeTest.exportPortable());
  const learned = portable.hole.nodes[0].extensions.learn[durableId];
  assert.deepEqual(learned, { attempts: 1, last: { option: 1, correct: true }, revealed: true }, ".rabbithole export carries learner state");
  const stored = await page.evaluate(() => window.__rabbitholeTest.readStoredHole());
  assert.deepEqual(stored.nodes[0].extensions.learn[durableId], learned, "real UI block_state flushes to IndexedDB");

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".viz-check .rh-check-option.is-correct:visible");
  assert.equal(await page.locator(".viz-check .rh-check-explanation:visible").count() > 0, true, "reload restores answered/revealed Check state");
  assert.equal(await page.locator(".viz-check .rh-check-option:disabled:visible").count(), 2, "restored answer disables selection until reset");

  const snapshot = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const payload = JSON.parse(extractSnapshotPayload(snapshot));
  assert(payload.hole.nodes.every((node) => Object.keys(node.extensions).length === 0), "snapshot payload clears the populated learn bag");
  const frozen = await context.newPage();
  await frozen.setContent(snapshot, { waitUntil: "load" });
  await frozen.waitForSelector(".viz-check .rh-check-option:visible");
  assert.equal(await frozen.locator(".viz-check .rh-check-option:visible").count(), 2, "frozen Check keeps the live DOM structure");
  await frozen.locator(".viz-check .rh-check-option:visible").first().focus();
  await frozen.keyboard.press("Enter");
  assert.equal(await frozen.locator(".viz-check .rh-check-explanation:visible").count() > 0, true, "frozen Check remains interactive offline");
  await frozen.close();
  await context.close();
  console.log("ok web app: Check UI persists, hydrates, exports state portably, strips snapshot progress, and stays keyboard-interactive frozen");
}

async function verifyNoticePrimitive() {
  const page = await browser.newPage();
  await page.setContent(`<div id="banner"><span data-notice-title></span><span data-notice-message></span><button data-notice-dismiss>Dismiss</button></div>
    <div id="hint" data-notice-message></div>
    <div id="toast"><span data-notice-message></span><button data-notice-action hidden>Action</button></div>`);
  await page.addScriptTag({ content: NOTICE_SOURCE });
  const attrs = await page.evaluate(() => {
    const hint = wireNotice(document.getElementById("hint"), { variant: "hint" });
    const toast = wireNotice(document.getElementById("toast"), { variant: "toast" });
    const banner = wireNotice(document.getElementById("banner"), { variant: "banner" });
    banner.show({ title: "Offline", message: "Reading stays available." });
    return ["hint", "toast", "banner"].map((id) => {
      const el = document.getElementById(id);
      return [el.getAttribute("role"), el.getAttribute("aria-live"), el.getAttribute("aria-atomic")];
    });
  });
  assert.deepEqual(attrs, [["status", "polite", "true"], ["status", "polite", "true"], ["status", "polite", "true"]], "Notice variants should expose polite atomic live regions");
  await page.click("[data-notice-dismiss]");
  assert.equal(await page.locator("#banner").evaluate((el) => el.classList.contains("visible")), false, "banner dismiss should hide the wired shell");

  await page.evaluate(() => {
    const toast = wireNotice(document.getElementById("toast"), { variant: "toast" });
    toast.show({ message: "first", duration: 80 });
    setTimeout(() => toast.show({ message: "second", duration: 220 }), 30);
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#toast").innerText(), "second", "a replacement notice should own the single visible message");
  assert.equal(await page.locator("#toast").evaluate((el) => el.classList.contains("visible")), true, "the replaced timer must not hide the newer notice early");
  await page.waitForTimeout(180);
  assert.equal(await page.locator("#toast").evaluate((el) => el.classList.contains("visible")), false, "the replacement timer should eventually hide the notice");

  await page.evaluate(() => {
    const toast = document.getElementById("toast");
    wireNotice(toast, { variant: "toast" }).show({ message: "paused", actionLabel: "Undo", duration: 1200 });
    toast.querySelector("[data-notice-action]").focus();
  });
  await page.waitForTimeout(1600);
  const visibleWhileFocused = await page.locator("#toast").evaluate((el) => el.classList.contains("visible"));
  assert.equal(visibleWhileFocused, true, `focus inside should pause a toast timer (visible=${visibleWhileFocused})`);
  await page.hover("#toast");
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(1600);
  const visibleWhileHovered = await page.locator("#toast").evaluate((el) => el.classList.contains("visible"));
  assert.equal(visibleWhileHovered, true, `hover should keep a toast timer paused after focus leaves (visible=${visibleWhileHovered})`);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.getElementById("toast").classList.contains("visible"), { timeout: 4000 });
  const visibleAfterMouseleave = await page.locator("#toast").evaluate((el) => el.classList.contains("visible"));
  assert.equal(visibleAfterMouseleave, false, `a toast timer should resume after hover (visible=${visibleAfterMouseleave})`);
  await page.close();
}


async function verifySharedCanvasDialogs() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const imageUrl = "https://dialog-probe.invalid/palette-lightbox.png";
  await page.route(imageUrl, (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#8faaf0"/><circle cx="320" cy="180" r="100" fill="#f5f3ee"/></svg>',
  }));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rabbitholeTest);
  await createDocument(page, `# Palette target\n\nSearchable dialog content.\n\n![Dialog probe](${imageUrl})`);
  await page.waitForSelector('.doc-content img[alt="Dialog probe"]:visible');

  await page.keyboard.press("Meta+k");
  await page.waitForSelector("#palette.visible");
  await page.waitForFunction(() => document.activeElement?.id === "pal-text");
  await page.fill("#pal-text", "Palette");
  await page.waitForSelector('#pal-results [role="option"]:visible');
  assert.equal(await page.getAttribute("#pal-results", "role"), "listbox");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "pal-text", "palette navigation should retain input focus");
  const firstActive = await page.getAttribute("#pal-text", "aria-activedescendant");
  assert(firstActive && await page.locator(`#${firstActive}[role="option"][aria-selected="true"]`).count() === 1, "aria-activedescendant should identify the selected option");
  await page.keyboard.press("ArrowDown");
  const movedActive = await page.getAttribute("#pal-text", "aria-activedescendant");
  assert(movedActive && await page.locator(`#${movedActive}[aria-selected="true"]`).count() === 1, "ArrowDown should keep active-descendant selection synchronized");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "pal-text");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#palette:not(.visible)", { state: "attached" });

  await page.keyboard.press("Meta+k");
  await page.waitForSelector("#palette.visible");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#palette:not(.visible)", { state: "attached" });
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("mode-canvas")), true, "palette Escape must not leak into the canvas reader shortcut");

  const sourceImage = page.locator('.doc-content img[alt="Dialog probe"]:visible').first();
  await sourceImage.click();
  await page.waitForSelector(".rh-lightbox");
  assert.equal(await page.getAttribute(".rh-lightbox-dialog", "role"), "dialog");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("alt")), "Dialog probe", "lightbox Escape should restore the source image");
  await sourceImage.click();
  await page.waitForSelector(".rh-lightbox");
  await page.mouse.click(5, 5);
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("alt")), "Dialog probe", "lightbox backdrop close should restore the source image");

  const frozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const frozenPage = await context.newPage();
  await frozenPage.route(imageUrl, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#8faaf0"/></svg>' }));
  await frozenPage.setContent(frozenHtml, { waitUntil: "load" });
  await frozenPage.keyboard.press("Meta+k");
  await frozenPage.waitForSelector("#palette.visible");
  assert.equal(await frozenPage.evaluate(() => document.activeElement?.id), "pal-text", "frozen palette should use Dialog initial focus");
  await frozenPage.keyboard.press("Escape");
  await frozenPage.locator('.doc-content img[alt="Dialog probe"]:visible').first().click();
  await frozenPage.waitForSelector(".rh-lightbox");
  await frozenPage.keyboard.press("Escape");
  await frozenPage.waitForSelector(".rh-lightbox", { state: "detached" });
  await frozenPage.close();
  await context.close();
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rabbitholeTest?.currentHoleId?.() || "");
  await page.evaluate((value) => window.__rabbitholeTest.createDocument(value), markdown);
  await page.waitForFunction((oldId) => {
    const id = window.__rabbitholeTest?.currentHoleId?.();
    return id && id !== oldId;
  }, previous);
  await page.waitForSelector(".node .doc-content[data-node-id]");
  return page.evaluate(() => window.__rabbitholeTest.currentHoleId());
}

async function ensureRailOpen(page) {
  if (await page.getAttribute("#t-rail", "aria-expanded") !== "true") {
    await page.click("#t-rail");
  }
  await page.waitForSelector("#web-rail.open");
}

async function waitForCanvasText(page, text) {
  await page.locator(".node", { hasText: text }).first().waitFor();
}

async function selectText(page, needle) {
  await page.evaluate((text) => {
    const root = document.querySelector(".node .doc-content[data-node-id]");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(text);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 120, clientY: 160 }));
      return;
    }
    throw new Error(`Text not found: ${text}`);
  }, needle);
}
