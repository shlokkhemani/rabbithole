import assert from "node:assert/strict";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { bootWebApp } from "../support/web-app-harness.mjs";

const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";

const app = await bootWebApp();
const { browser, baseUrl } = app;
try {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const providerBodies = [];
  page.on("request", (request) => {
    if (request.url() === PROVIDER_URL && request.method() === "POST") {
      providerBodies.push(request.postDataJSON());
    }
  });
  await routeProvider(page, {
    streams: [
      ["TITLE: Reader IME\n", "Reader follow-up answer."],
      ["TITLE: Card IME\n", "Card follow-up answer."],
    ],
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  await createDocument(page, "# IME follow-up probe\n\nA document for Korean input composition.");

  await page.click("#t-reader");
  await dispatchComposingEnter(page, "#composer-text", "트");
  assert.equal(await page.locator("#thread .turn").count(), 0,
    "reader composing Enter must not create an intermediate follow-up branch");
  assert.equal(providerBodies.length, 0,
    "reader composing Enter must not make a follow-up request");

  await finishCompositionAndSubmit(page, "#composer-text", "테스트");
  await page.waitForSelector("#thread .turn");
  assert.equal(await page.locator("#thread .turn").count(), 1,
    "reader normal Enter after composition must create exactly one follow-up branch");
  assert.equal(await page.locator("#thread .turn-q").innerText(), "테스트");
  await waitForRequestCount(page, providerBodies, 1);
  assert.match(JSON.stringify(providerBodies[0]), /테스트/,
    "reader follow-up request must contain the complete composed text");

  await page.click("#r-canvas");
  const cardSelector = ".node.root .nc-inner textarea";
  const nodeCountBefore = await page.locator(".node").count();
  await page.locator(".node.root .nc-handle").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".node.root .nc-inner textarea"));
  await dispatchComposingEnter(page, cardSelector, "트");
  assert.equal(await page.locator(".node").count(), nodeCountBefore,
    "card composing Enter must not create an intermediate follow-up branch");
  assert.equal(providerBodies.length, 1,
    "card composing Enter must not make a follow-up request");

  await finishCompositionAndSubmit(page, cardSelector, "테스트");
  await page.waitForFunction((count) => document.querySelectorAll(".node").length === count + 1, nodeCountBefore);
  assert.equal(await page.locator(".node").count(), nodeCountBefore + 1,
    "card normal Enter after composition must create exactly one follow-up branch");
  const newCard = page.locator(".node").nth(nodeCountBefore);
  assert.equal(await newCard.locator(".origin-quote").innerText(), "테스트",
    "card follow-up origin must retain the complete composed text");
  await waitForRequestCount(page, providerBodies, 2);
  assert.match(JSON.stringify(providerBodies[1]), /테스트/,
    "card follow-up request must contain the complete composed text");

  await context.close();
  console.log("ok follow-up IME: composing Enter is ignored and completed Korean text submits once in reader and card composers");
} finally {
  await app.close();
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rabbitholeTest?.currentHoleId?.() || "");
  await page.evaluate((value) => window.__rabbitholeTest.createDocument(value), markdown);
  await page.waitForFunction((oldId) => {
    const id = window.__rabbitholeTest?.currentHoleId?.();
    return id && id !== oldId;
  }, previous);
  await page.waitForSelector(".node .doc-content[data-node-id]");
}

async function dispatchComposingEnter(page, selector, value) {
  await page.locator(selector).evaluate((textarea, nextValue) => {
    textarea.focus();
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    textarea.value = nextValue;
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: nextValue,
      inputType: "insertCompositionText",
      isComposing: true,
    }));
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });
    if (!event.isComposing) throw new Error("test browser did not preserve KeyboardEvent.isComposing");
    textarea.dispatchEvent(event);
  }, value);
}

async function finishCompositionAndSubmit(page, selector, value) {
  await page.locator(selector).evaluate((textarea, nextValue) => {
    textarea.value = nextValue;
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: nextValue,
      inputType: "insertCompositionText",
      isComposing: true,
    }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: nextValue }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
    }));
  }, value);
}

async function waitForRequestCount(page, providerBodies, count) {
  for (let attempt = 0; attempt < 50 && providerBodies.length < count; attempt += 1) {
    await page.waitForTimeout(10);
  }
  assert.equal(providerBodies.length, count);
}
