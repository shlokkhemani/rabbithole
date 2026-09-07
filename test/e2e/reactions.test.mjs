/** @protects selection reaction composition, wash-only rendering, deletion, and frozen behavior. */
import assert from "node:assert/strict";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { bootWebApp } from "../support/web-app-harness.mjs";

const app = await bootWebApp();
const { browser, baseUrl } = app;

try {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const providerBodies = [];
  await routeProvider(page, {
    onProviderCall: (body) => providerBodies.push(body),
    streams: [["TITLE: Fourth preset\n", "Digit four used the configured custom question."]],
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await createDocument(page, [
    "# Reaction layout probe",
    "",
    "The exact marked passage should accept a reaction without moving this prose.",
    "",
    "A distant paragraph keeps identical layout metrics throughout the interaction.",
  ].join("\n"));
  await page.waitForSelector(".card.root .doc-content", { state: "visible" });

  await selectText(page, "exact marked passage");
  await page.waitForSelector("#ask.visible");
  assert.deepEqual(await page.locator("#ask-actions").evaluate((row) => {
    const lenses = Array.from(row.querySelectorAll(".lens"));
    const pair = row.querySelector(".thumb-pair");
    const groups = [...lenses, pair];
    const gaps = groups.slice(1).map((group, index) => group.getBoundingClientRect().left - groups[index].getBoundingClientRect().right);
    const style = getComputedStyle(row);
    return {
      lensTextNodes: lenses.map((button) => button.firstChild.nodeValue),
      popoverWidth: parseFloat(getComputedStyle(row.closest("#ask")).width),
      thumbCount: pair.querySelectorAll(".thumb").length,
      display: style.display,
      justify: style.justifyContent,
      gap: style.gap,
      presetDisplay: getComputedStyle(row.querySelector(".preset-actions")).display,
      equalGaps: Math.max(...gaps) - Math.min(...gaps) < 1.1,
      ownWidths: new Set(lenses.map((button) => Math.round(button.getBoundingClientRect().width))).size > 1,
    };
  }), {
    lensTextNodes: ["Explain ", "ELI5 ", "Go deeper "],
    popoverWidth: 372,
    thumbCount: 2,
    display: "flex",
    justify: "space-between",
    gap: "2px",
    presetDisplay: "contents",
    equalGaps: true,
    ownWidths: true,
  }, "the 372px selection row keeps three presets and the reaction pair as four content-hugging groups with equal slack");
  assert.equal(await page.locator("#composer-actions .thumb-pair").count(), 0,
    "the follow-up composer stays byte-for-byte reaction-free");
  assert.deepEqual(await page.locator("#composer-actions .lens").evaluateAll((buttons) =>
    buttons.map((button) => button.firstChild.nodeValue)),
  ["Explain ", "ELI5 ", "Go deeper "],
  "the follow-up default uses the same three single-text-node presets");

  await page.fill("#ask-text", "first line\nsecond line");
  assert.deepEqual(await page.locator("#ask-actions").evaluate((row) => ({
    lensesHidden: Array.from(row.querySelectorAll(".lens")).every((button) => getComputedStyle(button).display === "none"),
    pairHidden: getComputedStyle(row.querySelector(".thumb-pair")).display === "none",
    commitsVisible: Array.from(row.querySelectorAll(".ask-commit")).every((button) => getComputedStyle(button).display !== "none"),
  })), { lensesHidden: true, pairHidden: true, commitsVisible: true },
  "typing swaps lenses and thumbs for the shared Note/Ask commits");
  await page.locator("#ask-text").evaluate((text) => text.setSelectionRange(text.value.length, text.value.length));
  const reactionsBeforeDraftArrows = await page.locator(".mark-reaction").count();
  const caretBefore = await page.locator("#ask-text").evaluate((text) => text.selectionStart);
  await page.press("#ask-text", "ArrowUp");
  const caretAfterUp = await page.locator("#ask-text").evaluate((text) => text.selectionStart);
  await page.press("#ask-text", "ArrowDown");
  assert.equal(caretAfterUp < caretBefore, true, "ArrowUp keeps its native caret movement while a draft exists");
  assert.equal(await page.locator(".mark-reaction").count(), reactionsBeforeDraftArrows,
    "draft ArrowUp/ArrowDown place no reactions");

  await page.fill("#ask-text", "");
  assert.deepEqual(await page.locator("#ask-actions").evaluate((row) => ({
    lensesVisible: Array.from(row.querySelectorAll(".lens")).every((button) => getComputedStyle(button).display !== "none"),
    pairVisible: getComputedStyle(row.querySelector(".thumb-pair")).display === "flex",
    commitsHidden: Array.from(row.querySelectorAll(".ask-commit")).every((button) => getComputedStyle(button).display === "none"),
  })), { lensesVisible: true, pairVisible: true, commitsHidden: true },
  "clearing the draft restores the three presets and reaction pair");

  await page.press("#ask-text", "Escape");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  await page.click("#t-settings");
  await page.click('[data-settings-section="asking"]');
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-add]');
  await page.fill("#asking-selection-custom-label", "Counterpoint");
  await page.fill("#asking-selection-custom-instruction", "Challenge this claim from another angle.");
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-done]');
  await page.click('[data-asking-surface][data-set="selection"] [data-reaction-button="up"]');
  await page.fill('[data-reaction-prompt="up"] [data-reaction-instruction]',
    "Keep the exact concrete shape that worked here.");
  await page.click("[data-settings-close]");
  await page.waitForSelector("#settings-sheet", { state: "detached" });

  await selectText(page, "exact marked passage");
  await page.waitForSelector("#ask.visible");
  assert.deepEqual(await page.locator("#ask-actions").evaluate((row) => {
    const lenses = Array.from(row.querySelectorAll(".lens"));
    const pair = row.querySelector(".thumb-pair");
    const rowRect = row.getBoundingClientRect();
    const pairRect = pair.getBoundingClientRect();
    const tops = lenses.map((lens) => Math.round(lens.getBoundingClientRect().top));
    return {
      hints: lenses.map((lens) => lens.querySelector("kbd").textContent),
      popoverWidth: parseFloat(getComputedStyle(row.closest("#ask")).width),
      display: getComputedStyle(row).display,
      twoLines: new Set(tops).size === 2,
      fourthSharesLastLine: tops[3] === Math.round(pairRect.top),
      thumbsRightAligned: Math.abs(pairRect.right - (rowRect.right - 5)) < 1,
    };
  }), {
    hints: ["1", "2", "3", "4"],
    popoverWidth: 372,
    display: "grid",
    twoLines: true,
    fourthSharesLastLine: true,
    thumbsRightAligned: true,
  }, "the fourth pill wraps without widening and shares a right-anchored last line with the thumbs");
  assert.deepEqual(await page.locator("#composer-actions .lens kbd").allTextContents(), ["1", "2", "3", "4"],
    "the linked follow-up composer exposes the same positional fourth preset without gaining reactions");

  const distantBefore = await rectOf(page, ".card.root .doc-content p:last-of-type");
  await page.press("#ask-text", "ArrowUp");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  const mark = page.locator(".card.root .mark-reaction").first();
  await mark.waitFor();
  const reactionId = await mark.getAttribute("data-child");
  assert.ok(reactionId);
  assert.equal(await mark.evaluate((element) => element.classList.contains("mark-note") && element.classList.contains("mark-ready")), true);
  assert.equal(await page.locator(`.note-dot[data-note="${reactionId}"]`).count(), 0, "a reaction paints no note dot");
  assert.equal(await page.locator(`#margin-notes [data-child="${reactionId}"]`).count(), 0, "a reaction paints no reader rail entry");
  assert.deepEqual(await rectOf(page, ".card.root .doc-content p:last-of-type"), distantBefore,
    "the absolute reaction wash leaves distant prose layout metrics unchanged");
  await page.waitForFunction(async (id) => {
    const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
    return node?.markdown === "👍"
      && node.origin?.instruction === "Keep the exact concrete shape that worked here."
      && node.extensions?.note?.docked === true && node.extensions.note.reaction === true;
  }, reactionId);

  await selectText(page, "distant paragraph");
  await page.waitForSelector("#ask.visible");
  await page.press("#ask-text", "4");
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".card .doc-content"))
    .some((node) => node.textContent.includes("Digit four used the configured custom question.")));
  assert.equal(providerBodies.length, 1, "digit 4 submits the positional fourth preset once");
  const modelContext = providerBodies[0].messages.find((message) => message.role === "user").content;
  assert.match(modelContext,
    /- Human: Anchored to "exact marked passage": Keep the exact concrete shape that worked here\./,
    "the configured reaction instruction reaches the browser provider's model-context projection");
  assert.doesNotMatch(modelContext, /Anchored to "exact marked passage": 👍/,
    "the context substitution does not require changing the stored glyph markdown");
  assert.deepEqual(await page.evaluate(async () => {
    const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.origin?.lens === "custom");
    return node ? { lens: node.origin.lens, instruction: node.origin.instruction } : null;
  }), { lens: "custom", instruction: "Challenge this claim from another angle." },
  "digit 4 carries the custom key and instruction through the ordinary ask wire");

  const frozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const frozenPage = await context.newPage();
  await frozenPage.route(baseUrl + "/reaction-snapshot", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: frozenHtml,
  }));
  await frozenPage.goto(baseUrl + "/reaction-snapshot", { waitUntil: "load" });
  assert.deepEqual(await frozenPage.locator("#ask-actions").evaluate((row) => {
    const lenses = Array.from(row.querySelectorAll(".lens"));
    const pair = row.querySelector(".thumb-pair").getBoundingClientRect();
    return {
      count: lenses.length,
      width: parseFloat(getComputedStyle(row.closest("#ask")).width),
      lastLineShared: Math.round(lenses.at(-1).getBoundingClientRect().top) === Math.round(pair.top),
    };
  }), { count: 4, width: 372, lastLineShared: true },
  "the frozen client keeps the four-pill wrap in the same fixed-width shell");
  const frozenMark = frozenPage.locator(`.mark-reaction[data-child="${reactionId}"]`).first();
  await frozenMark.waitFor();
  await frozenMark.hover();
  await frozenPage.waitForSelector(".reaction-tooltip");
  assert.equal((await frozenPage.locator(".reaction-tooltip").first().innerText()).trim(), "👍",
    "a frozen reaction tooltip contains the glyph only");
  assert.equal(await frozenPage.locator(".reaction-delete").count(), 0, "a frozen reaction exposes no mutation control");
  await frozenPage.close();

  const touchPoint = await mark.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.4, y: rect.top + rect.height / 2 };
  });
  await mark.evaluate((element, point) => element.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true, cancelable: true, pointerType: "touch", clientX: point.x, clientY: point.y,
  })), touchPoint);
  assert.equal(await page.locator(".reaction-tooltip").count(), 1, "touching a wash opens its tooltip");
  await mark.evaluate((element, point) => element.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true, cancelable: true, pointerType: "touch", clientX: point.x, clientY: point.y,
  })), touchPoint);
  assert.equal(await page.locator(".reaction-tooltip").count(), 0, "touching the wash again closes its tooltip");

  const entry = await mark.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.73, y: rect.top + rect.height / 2, top: rect.top };
  });
  await page.mouse.move(entry.x, entry.y);
  const tooltip = page.locator(".reaction-tooltip").first();
  await tooltip.waitFor();
  const positioned = await tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { center: rect.left + rect.width / 2, bottom: rect.bottom };
  });
  assert.equal(Math.abs(positioned.center - entry.x) < 1.5, true, "the tooltip centers on the pointer-entry x position");
  assert.equal(Math.abs(positioned.bottom - (entry.top - 5)) < 1.5, true, "the tooltip sits five pixels above the entered line");
  await tooltip.locator(".reaction-delete").click();
  assert.deepEqual(await page.evaluate((id) => ({
    wash: document.querySelectorAll(`.mark-reaction[data-child="${id}"]`).length,
    tooltip: document.querySelectorAll(".reaction-tooltip").length,
  }), reactionId), { wash: 0, tooltip: 0 }, "deletion removes the wash and tooltip synchronously in the click frame");

  await context.close();
  console.log("ok e2e reactions: row swap, arrows, wash-only layout, tooltip deletion, touch, and frozen read-only rendering");
} finally {
  await app.close();
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rabbitholeTest?.currentHoleId?.() || "");
  await page.evaluate((value) => window.__rabbitholeTest.createDocument(value), markdown);
  await page.waitForFunction((oldId) => {
    const id = window.__rabbitholeTest?.currentHoleId?.();
    return id && id !== oldId && document.querySelector(".doc-content");
  }, previous);
}

async function selectText(page, text) {
  await page.evaluate((targetText) => {
    const root = document.querySelector(".card.root .doc-content[data-node-id]");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.nodeValue.indexOf(targetText);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + targetText.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 120, clientY: 160 }));
      return;
    }
    throw new Error(`Text not found: ${targetText}`);
  }, text);
}

async function rectOf(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}
