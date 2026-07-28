/*
 * The custom OpenAI-compatible endpoint, driven the way a person drives it: type a URL,
 * maybe a key, watch the status line, pick a model, generate. Also pins the two things
 * that must not regress — Local stays Ollama-shaped, and provider settings are not
 * clobbered by switching providers.
 */
import assert from "node:assert/strict";
import { corsHeaders, sse } from "../support/provider-mock.mjs";
import { bootWebApp } from "../support/web-app-harness.mjs";

const ENDPOINT = "https://api.example.com/v1";
const MODELS_URL = `${ENDPOINT}/models`;
const CHAT_URL = `${ENDPOINT}/chat/completions`;
const KEY = "sk-custom-endpoint-key";

const app = await bootWebApp();
const { browser, baseUrl } = app;
try {
  await verifyConnectStatesAndAuth();
  await verifyGenerationSendsTheKey();
  await verifySettingsSurviveProviderSwitching();
  console.log("custom endpoint verification passed");
} finally {
  await app.close();
}

async function routeEndpoint(page, { requireKey = false, models = ["my-model", "my-vision"], onModels = null, onChat = null } = {}) {
  await page.route(MODELS_URL, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
    const key = (route.request().headers().authorization || "").replace(/^Bearer\s+/i, "");
    onModels?.(key);
    if (requireKey && key !== KEY) {
      return route.fulfill({ status: 401, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ error: { message: "missing key" } }) });
    }
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ data: models.map((id) => ({ id })) }),
    });
  });
  await page.route(CHAT_URL, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
    onChat?.({
      authorization: route.request().headers().authorization || "",
      body: route.request().postDataJSON(),
    });
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" },
      body: sse(["# Custom endpoint\n\nStreamed from a self-hosted server."]),
    });
  });
}

async function openSettingsOnCustom(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#blank-start:not([hidden])");
  await page.click("#blank-start-setup");
  await page.waitForSelector("#web-settings-popover");
  await page.click('[data-provider="custom_endpoint"]');
  await page.waitForSelector("#provider-base");
}

async function fillEndpoint(page, value) {
  await page.fill("#provider-base", value);
  await page.locator("#provider-base").blur();
}

async function waitForEndpointStatus(page, text) {
  await page.waitForFunction(
    (expected) => document.getElementById("endpoint-status")?.textContent === expected,
    text,
    { timeout: 10000 },
  ).catch(async () => {
    assert.equal(await page.locator("#endpoint-status").innerText(), text);
  });
  assert.equal(await page.locator("#endpoint-status").innerText(), text);
}

async function verifyConnectStatesAndAuth() {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => process.stderr.write(`browser page error: ${error.stack || error.message}\n`));
    await routeEndpoint(page, { requireKey: true });
    await openSettingsOnCustom(page);

    assert.deepEqual(await page.locator(".provider-choice button").allTextContents(), ["OpenRouter", "Local", "Custom"]);
    assert.equal(await page.locator("#api-key").count(), 1, "a custom endpoint must be able to authenticate");
    assert.equal(await page.locator("#api-key-status").innerText(), "Optional. Stored only in this browser, sent only to your endpoint.");
    assert.equal(await page.locator("#local-model").count(), 0, "the Ollama model picker belongs to Local");
    assert.equal(await page.locator("#local-model-setup").count(), 0, "the Ollama setup guide belongs to Local");
    // One line under the field carries both the instruction and every later state, so an
    // empty endpoint must not reserve a second blank row.
    assert.equal(await page.locator("#endpoint-status").innerText(), "OpenAI-compatible base URL.");
    assert.equal(await page.locator("#provider-base-hint").count(), 0);
    assert.equal(
      await page.locator("#endpoint-model").evaluate((el) => Math.round(el.getBoundingClientRect().width) < Math.round(el.parentElement.getBoundingClientRect().width * 0.75)),
      true,
      "the model trigger must hug its label instead of filling the row",
    );
    assert.equal(await page.locator("#complete-model-setup").isDisabled(), true);

    // A bare host would otherwise be fetched against this origin.
    await fillEndpoint(page, "api.example.com/v1");
    await waitForEndpointStatus(page, "Enter a full URL, like https://api.example.com/v1.");

    // An unreachable or CORS-blocked endpoint has to name both likely causes.
    await fillEndpoint(page, "https://nothing-here.example/v1");
    await waitForEndpointStatus(page, "Couldn't reach nothing-here.example. Check the URL, and that the server allows requests from this page.");

    /* A denied local-network prompt fails identically to an unreachable host, and it is the
       far likelier cause when the endpoint is a machine on the same network. */
    await page.route("http://192.168.0.198:11434/v1/models", (route) => route.abort("failed"));
    await fillEndpoint(page, "http://192.168.0.198:11434/v1");
    await waitForEndpointStatus(page, "Couldn't reach 192.168.0.198:11434. Allow local network access if your browser asked, and check that the server accepts requests from this page.");

    await fillEndpoint(page, ENDPOINT);
    await waitForEndpointStatus(page, "This endpoint needs an API key.");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "api-key", "a 401 with no key should land the cursor in the key field");
    assert.equal(await page.locator("#complete-model-setup").isDisabled(), true);

    await page.fill("#api-key", "wrong-key");
    await waitForEndpointStatus(page, "This endpoint rejected the key.");

    await page.fill("#api-key", KEY);
    await waitForEndpointStatus(page, "Connected · 2 models");
    assert.equal(await page.locator("#endpoint-model-value").innerText(), "my-model", "connecting should choose a usable model");
    assert.equal(await page.locator("#transcribe-model-help").innerText(), "Uses a vision model to turn PDF pages into searchable Markdown. Page images go to your custom endpoint.");
    assert.equal(await page.locator("#transcribe-model").isDisabled(), false, "a custom endpoint must not inherit Local's vision gate");
    assert.equal(await page.locator("#complete-model-setup").isDisabled(), false);

    /* The picker lists what the endpoint reported, and still takes a name it never listed. */
    await page.click("#endpoint-model");
    await page.waitForSelector(".model-option");
    assert.deepEqual(await page.locator(".model-option .model-option-name").allTextContents(), ["my-model", "my-vision"]);
    await page.fill(".combobox-surface input", "unlisted-model");
    await page.waitForSelector(".model-use-custom");
    await page.click(".model-use-custom");
    assert.equal(await page.locator("#endpoint-model-value").innerText(), "unlisted-model", "endpoints that do not list models must still be usable");

    /* An endpoint that answers but lists nothing is connected, not broken. */
    await page.unroute(MODELS_URL);
    await routeEndpoint(page, { models: [] });
    await fillEndpoint(page, `${ENDPOINT}/`);
    await waitForEndpointStatus(page, "Connected · no models listed");
  } finally {
    await context.close();
  }
}

async function verifyGenerationSendsTheKey() {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => process.stderr.write(`browser page error: ${error.stack || error.message}\n`));
    const chatCalls = [];
    await routeEndpoint(page, { requireKey: true, onChat: (call) => chatCalls.push(call) });
    await openSettingsOnCustom(page);
    await fillEndpoint(page, ENDPOINT);
    await page.fill("#api-key", KEY);
    await page.waitForSelector("#endpoint-status.valid");
    await page.click("#complete-model-setup");
    await page.waitForSelector("#web-settings-popover", { state: "detached" });

    assert.equal(await page.locator("#blank-start-new").isDisabled(), false, "finishing setup should unlock the app");
    await page.click("#blank-start-new");
    await page.waitForSelector("#composer-modal:not([hidden])");
    await page.click("#composer-path-ask");
    await page.fill("#composer-input", "What is a custom endpoint?");
    await page.click("#composer-primary");
    await page.locator(".node", { hasText: "Streamed from a self-hosted server." }).first().waitFor();

    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0].authorization, `Bearer ${KEY}`, "the key must reach the endpoint as a bearer token");
    assert.equal(chatCalls[0].body.model, "my-model");
    assert.equal(chatCalls[0].body.stream, true);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings") || "{}"));
    assert.equal(stored.preset, "custom_endpoint");
    assert.equal(stored.base_url, ENDPOINT);
    assert.equal(stored.api_key, undefined, "the key is never written into the settings blob");
    const keys = await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-api-keys") || "{}"));
    assert.equal(keys.custom_endpoint, KEY, "the key is stored under its own provider");
  } finally {
    await context.close();
  }
}

async function verifySettingsSurviveProviderSwitching() {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => process.stderr.write(`browser page error: ${error.stack || error.message}\n`));
    let localModelCalls = 0;
    await routeEndpoint(page);
    await page.route("http://localhost:11434/v1/models", (route) => {
      localModelCalls += 1;
      return route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "llama3.2" }] }) });
    });
    await page.route("http://localhost:11434/api/show", (route) => route.fulfill({
      status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ capabilities: ["completion"] }),
    }));
    await openSettingsOnCustom(page);
    await fillEndpoint(page, ENDPOINT);
    await page.waitForSelector("#endpoint-status.valid");
    assert.equal(localModelCalls, 0, "configuring a custom endpoint must never probe Ollama");

    await page.click('[data-provider="local"]');
    await page.waitForSelector("#local-model");
    assert.equal(await page.locator("#provider-base").inputValue(), "http://localhost:11434/v1", "Local keeps its own endpoint");
    assert.equal(await page.locator("#endpoint-status").count(), 0, "the Custom status line belongs to Custom");
    assert.equal(await page.locator("#api-key").count(), 0, "Local still asks for no key");
    await page.waitForFunction(() => document.querySelector(".local-model-section .field-hint")?.textContent?.length > 0);

    await page.click('[data-provider="openrouter"]');
    await page.waitForSelector("#model-select");

    await page.click('[data-provider="custom_endpoint"]');
    await page.waitForSelector("#endpoint-status.valid");
    assert.equal(await page.locator("#provider-base").inputValue(), ENDPOINT, "a typed endpoint survives the trip through other providers");
    assert.equal(await page.locator("#endpoint-model-value").innerText(), "my-model");
  } finally {
    await context.close();
  }
}
