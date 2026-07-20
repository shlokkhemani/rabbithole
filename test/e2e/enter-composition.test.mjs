import assert from "node:assert/strict";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { bootWebApp } from "../support/web-app-harness.mjs";

const app = await bootWebApp();
const { browser, baseUrl } = app;

try {
  await verifyEnterCompositionAndNewlines();
  console.log("enter composition verification passed");
} finally {
  await app.close();
}

async function verifyEnterCompositionAndNewlines() {
  const start = await openTestPage([["TITLE: Composer Enter\n", "Composer Enter completed."]]);
  try {
    await verifyStartComposer(start.page, () => start.providerCalls);
    assert.equal(start.providerCalls, 1, "plain Enter should submit the start composer exactly once");
  } finally {
    await start.context.close();
  }

  const documentPage = await openTestPage([
    ["TITLE: Selection Enter\n", "Selection Enter completed."],
    ["TITLE: Reader Enter\n", "Reader Enter completed."],
    ["TITLE: Card Enter\n", "Card Enter completed."],
  ]);
  try {
    await createDocument(documentPage.page, "# Enter handling\n\nEuler identity lets us test selection and follow-up inputs.");
    await documentPage.page.locator(".node .doc-content", { hasText: "Euler identity" }).first().waitFor();
    await verifySelectionAsk(documentPage.page, () => documentPage.providerCalls);
    await verifyReaderComposer(documentPage.page, () => documentPage.providerCalls);
    await verifyCardComposer(documentPage.page, () => documentPage.providerCalls);
    assert.equal(documentPage.providerCalls, 3, "each in-document plain Enter submit should call the provider exactly once");
  } finally {
    await documentPage.context.close();
  }
}

async function openTestPage(streams) {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const state = { providerCalls: 0 };
  await routeProvider(page, {
    streams,
    onProviderCall: () => { state.providerCalls += 1; },
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rabbitholeTest);
  return {
    context,
    page,
    get providerCalls() { return state.providerCalls; },
  };
}

async function verifyStartComposer(page, calls) {
  await page.click("#blank-start-new");
  await page.click("#composer-path-ask");
  await page.fill("#composer-input", "composing start");
  assert.equal((await dispatchComposingEnter(page, "#composer-input")).defaultPrevented, false);
  assert.equal(calls(), 0, "IME Enter must not submit the start composer");
  assert.equal(await page.locator("#composer-modal:not([hidden])").count(), 1);

  await page.fill("#composer-input", "line one");
  await page.focus("#composer-input");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue("#composer-input"), "line one\nline two", "Shift+Enter should insert a newline in the start composer");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__rabbitholeTest?.currentHoleId?.());
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  assert.equal(calls(), 1, "plain Enter should submit the start composer once");
}

async function verifySelectionAsk(page, calls) {
  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "composing selection");
  assert.equal((await dispatchComposingEnter(page, "#ask-text")).defaultPrevented, false);
  assert.equal(calls(), 0, "IME Enter must not submit the selection ask composer");
  assert.equal(await page.locator("#ask.visible").count(), 1);

  await page.fill("#ask-text", "line one");
  await page.focus("#ask-text");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue("#ask-text"), "line one\nline two", "Shift+Enter should insert a newline in the selection ask composer");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  await page.locator(".node:not(.root)", { hasText: "Selection Enter completed." }).waitFor();
  assert.equal(calls(), 1, "plain Enter should submit the selection ask once");
}

async function verifyReaderComposer(page, calls) {
  await page.click("#t-reader");
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas"));
  await page.fill("#composer-text", "composing reader");
  assert.equal((await dispatchComposingEnter(page, "#composer-text")).defaultPrevented, false);
  assert.equal(calls(), 1, "IME Enter must not submit the reader follow-up composer");

  await page.fill("#composer-text", "line one");
  await page.focus("#composer-text");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue("#composer-text"), "line one\nline two", "Shift+Enter should insert a newline in the reader follow-up composer");
  await page.keyboard.press("Enter");
  await page.locator("body", { hasText: "Reader Enter completed." }).waitFor();
  assert.equal(calls(), 2, "plain Enter should submit the reader follow-up once");
}

async function verifyCardComposer(page, calls) {
  await page.click("#t-canvas");
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas"));
  await page.locator(".node.root .nc-handle").evaluate((button) => button.click());
  const selector = ".node.root .nc-inner textarea";
  await page.fill(selector, "composing card");
  assert.equal((await dispatchComposingEnter(page, selector)).defaultPrevented, false);
  assert.equal(calls(), 2, "IME Enter must not submit the card follow-up composer");

  await page.fill(selector, "line one");
  await page.focus(selector);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  assert.equal(await page.inputValue(selector), "line one\nline two", "Shift+Enter should insert a newline in the card follow-up composer");
  await page.keyboard.press("Enter");
  await page.locator(".node:not(.root)", { hasText: "Card Enter completed." }).waitFor();
  assert.equal(calls(), 3, "plain Enter should submit the card follow-up once");
}

async function dispatchComposingEnter(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    const allowed = element.dispatchEvent(event);
    return { allowed, defaultPrevented: event.defaultPrevented };
  });
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rabbitholeTest?.currentHoleId?.() || "");
  await page.evaluate((value) => window.__rabbitholeTest.createDocument(value), markdown);
  await page.waitForFunction((oldId) => {
    const id = window.__rabbitholeTest?.currentHoleId?.();
    return id && id !== oldId && document.querySelector(".doc-content");
  }, previous);
  return page.evaluate(() => window.__rabbitholeTest.currentHoleId());
}

async function selectText(page, text) {
  await page.evaluate((targetText) => {
    const root = document.querySelector(".node .doc-content[data-node-id]");
    if (!root) throw new Error("No document content to select");
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
