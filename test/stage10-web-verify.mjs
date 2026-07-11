import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const MOCK_KEY = `sk-or-v1-${"x".repeat(64)}`;
const BAD_KEY = `sk-or-v1-${"y".repeat(64)}`;
const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const MODEL_URL = "https://openrouter.ai/api/v1/models";
const LOCAL_MODEL_URL = "http://localhost:11434/v1/models";
const NOTICE_SOURCE = (await fs.readFile(path.join(ROOT, "src/ui/primitives/notice.js"), "utf8"))
  .replace("export function wireNotice", "window.wireNotice = function wireNotice");

try {
  await fs.access(path.join(WEB_DIST, "index.html"));
} catch {
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout || "build failed\n");
    process.exit(build.status || 1);
  }
}

const server = await serveStatic(WEB_DIST);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  await verifyNoticePrimitive();
  await verifyLandingAndComposer();
  await verifyComboboxCatalogStates();
  await verifyAskKeyUxAndRail();
  await verifyCanvasBranching();
  await verifySharedCanvasDialogs();
  console.log("stage10 web verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
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

  await page.evaluate(() => wireNotice(document.getElementById("toast"), { variant: "toast" }).show({ message: "paused", actionLabel: "Undo", duration: 100 }));
  await page.hover("#toast");
  await page.waitForTimeout(160);
  assert.equal(await page.locator("#toast").evaluate((el) => el.classList.contains("visible")), true, "hover should pause a toast timer");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(120);
  assert.equal(await page.locator("#toast").evaluate((el) => el.classList.contains("visible")), false, "a toast timer should resume after hover");
  await page.close();
}

async function verifyLandingAndComposer() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#composer-modal:not([hidden])");
  assert.deepEqual(await page.locator("#composer-card").evaluate((dialog) => ({
    role: dialog.getAttribute("role"),
    modal: dialog.getAttribute("aria-modal"),
    labelledby: dialog.getAttribute("aria-labelledby"),
  })), { role: "dialog", modal: "true", labelledby: "composer-title" }, "Dialog should enforce the composer modal semantics");
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("rail-open")), false, "sidebar should be closed by default");
  assert.equal(await page.getAttribute("#t-rail", "aria-expanded"), "false", "sidebar toggle should expose its default collapsed state");
  await page.evaluate(() => localStorage.setItem("rh-rail-open", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#composer-modal:not([hidden])");
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("rail-open")), false, "legacy sidebar state should not override the calm default");
  assert.equal(await page.locator(".web-home").count(), 0, "form-based home page must be gone");
  assert.equal(await page.locator("#toolbar .toolbar-brand").count(), 1, "browser toolbar should carry the Rabbithole mark");
  const toolbarConformance = await page.locator("#reader-top button, #toolbar button").evaluateAll((buttons) => buttons.map((button) => ({
    id: button.id,
    type: button.getAttribute("type"),
    name: button.getAttribute("aria-label") || button.textContent.trim(),
  })));
  assert(toolbarConformance.length > 0, "reader and canvas toolbars should render buttons");
  assert(toolbarConformance.every(({ type }) => type === "button"), `every toolbar button should declare type=button (${JSON.stringify(toolbarConformance)})`);
  assert(toolbarConformance.every(({ name }) => name.length > 0), `every toolbar button should have an accessible name (${JSON.stringify(toolbarConformance)})`);
  assert.equal(await page.locator(".composer-path").count(), 3, "new Rabbithole should offer exactly three starting paths");
  assert.equal(await page.locator("#composer-title").innerText(), "Enter a Rabbithole");
  assert.equal(await page.locator(".composer-title-mark svg").count(), 1, "composer title should include the rabbit mark");
  assert.equal(await page.locator(".composer-start-head p").count(), 0, "chooser should not add explanatory copy above the paths");
  assert.deepEqual(await page.locator(".composer-path strong").allTextContents(), [
    "Ask a question",
    "Open PDF or Markdown",
    "Add a link",
  ]);
  assert.equal(await page.locator(".intent-chip, .composer-subline, .composer-examples").count(), 0, "ambiguous intent controls should be gone");
  assert.equal(await page.locator("#composer-entry").isVisible(), false, "text entry should wait until the user chooses a path");
  assert.equal(await page.locator("#composer-stream, #composer-question").count(), 0, "the composer should not contain a separate answer surface");

  await page.click("#composer-path-ask");
  assert.equal(await page.locator("#composer-entry-title").innerText(), "Ask a question");
  assert.equal(await page.getAttribute("#composer-input", "placeholder"), "Type your question…");
  await page.click("#composer-back");
  await page.click("#composer-path-url");
  assert.equal(await page.locator("#composer-entry-title").innerText(), "Add a link");
  assert.equal(await page.getAttribute("#composer-input", "placeholder"), "https://…");
  await page.click("#composer-back");
  assert.match(await page.getAttribute("#file-md", "accept"), /\.pdf/);
  assert.match(await page.getAttribute("#file-md", "accept"), /\.md/);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  const noHoles = await page.evaluate(() => window.__rabbitholeTest.listStoredHoles());
  assert.equal(noHoles.length, 0, "dismissing the composer must not create an Untitled hole");

  await page.waitForSelector("#blank-start:not([hidden])");
  assert.equal(await page.locator("#blank-start-new kbd").innerText(), "N", "blank-state CTA should teach the N shortcut");
  const blankOffset = await page.evaluate(() => {
    const rect = document.getElementById("blank-start").getBoundingClientRect();
    const railOpen = document.body.classList.contains("rail-open");
    const canvasLeft = railOpen ? document.getElementById("web-rail").getBoundingClientRect().right : 0;
    return Math.abs((rect.left + rect.right) / 2 - (canvasLeft + window.innerWidth) / 2);
  });
  assert(blankOffset <= 1, `blank-state CTA should sit centered over the free canvas, off by ${blankOffset.toFixed(1)}px`);
  await page.focus("#blank-start-new");
  await page.keyboard.press("N");
  await page.waitForSelector("#composer-modal:not([hidden])");
  await page.waitForFunction(() => document.activeElement?.id === "composer-card");
  assert.equal(await page.locator(".composer-path:focus").count(), 0, "no starting path should look preselected when the composer opens");
  await page.focus("#composer-path-url");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "composer-path-ask", "Tab should wrap from the last visible composer control to the first");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "composer-path-url", "Shift+Tab should wrap from the first visible composer control to the last");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "blank-start-new", "the N shortcut should restore focus to the visible new-Rabbithole trigger");
  await page.waitForSelector("#blank-start:not([hidden])");

  await page.click("#t-new");
  await page.waitForSelector("#composer-modal:not([hidden])");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-new", "Escape should restore focus to the toolbar trigger");

  await page.click("#blank-start-new");
  await page.waitForSelector("#composer-modal:not([hidden])");
  await page.locator("#composer-modal").click({ position: { x: 2, y: 2 } });
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "blank-start-new", "backdrop dismissal should restore focus to its trigger");

  const first = await createDocument(page, "# First hole\n\nEuler identity $e^{i\\pi}+1=0$.");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);

  const second = await createDocument(page, "# Second hole\n\nA second saved document.");
  assert.notEqual(first, second, "creating a second document should open a distinct hole");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, second);

  await page.goto(`${baseUrl}/?hash-wins=1#hole=${encodeURIComponent(first)}`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);

  await page.evaluate((deletedId) => localStorage.setItem("rh-last-hole", deletedId), second);
  await page.goto(`${baseUrl}/?last=second`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, second);
  await ensureRailOpen(page);
  const railIcon = await page.evaluate(() => ({
    filled: document.getElementById("t-rail").classList.contains("rail-on"),
    expanded: document.getElementById("t-rail").getAttribute("aria-expanded"),
  }));
  assert.equal(railIcon.expanded, "true");
  assert.equal(railIcon.filled, true, "rail toggle icon should switch to its filled state while the rail is open");
  assert.equal(await page.locator(`.rail-row[data-hole="${second}"] .rail-delete`).count(), 1);
  await page.locator(`.rail-row[data-hole="${first}"] .rail-open`).click();
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);
  await ensureRailOpen(page);
  await page.locator(`.rail-row[data-hole="${second}"]`).hover();
  await page.locator(`.rail-row[data-hole="${second}"] .rail-delete`).click();
  await page.waitForSelector("#web-toast.visible");
  assert.equal(await page.locator("#web-toast [data-notice-action]").innerText(), "Undo");
  await page.click("#web-toast [data-notice-action]");
  await page.waitForFunction(async (id) => (await window.__rabbitholeTest.listStoredHoles()).some((hole) => hole.hole_id === id), second);
  assert.equal(await page.locator(`.rail-row[data-hole="${second}"]`).count(), 1, "rail delete Undo should restore the deleted Rabbithole");
  await page.locator(`.rail-row[data-hole="${second}"]`).hover();
  await page.locator(`.rail-row[data-hole="${second}"] .rail-delete`).click();
  await page.waitForFunction(async (id) => !(await window.__rabbitholeTest.listStoredHoles()).some((hole) => hole.hole_id === id), second);
  await page.evaluate((deletedId) => localStorage.setItem("rh-last-hole", deletedId), second);
  await page.goto(`${baseUrl}/?last=deleted`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);

  await context.close();
}

async function verifyComboboxCatalogStates() {
  const fixture = { data: [
    { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", pricing: { prompt: "0.000003", completion: "0.000015" } },
    { id: "openai/gpt-5", name: "OpenAI: GPT-5", pricing: { prompt: "0.00000125", completion: "0.00001" } },
  ] };

  const delayed = await browser.newContext();
  const delayedPage = await delayed.newPage();
  await delayedPage.route(MODEL_URL, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(fixture) });
  });
  await openFreshSettings(delayedPage);
  await delayedPage.focus("#model-select");
  await delayedPage.keyboard.press("Enter");
  assert.match(await delayedPage.locator("#model-select-listbox").innerText(), /Loading models/);
  const comboA11y = await delayedPage.locator("#model-select-input").evaluate((input) => ({
    role: input.getAttribute("role"), expanded: input.getAttribute("aria-expanded"), controls: input.getAttribute("aria-controls"),
  }));
  assert.deepEqual(comboA11y, { role: "combobox", expanded: "true", controls: "model-select-listbox" });
  await delayedPage.waitForSelector("#model-select-listbox [role=option]");
  assert.equal(await delayedPage.getAttribute("#model-select-listbox", "role"), "listbox");
  await delayedPage.waitForTimeout(180);
  const comboGap = await delayedPage.evaluate(() => {
    const trigger = document.getElementById("model-select").getBoundingClientRect();
    const surface = document.querySelector(".model-combobox-surface");
    const box = surface.getBoundingClientRect();
    const token = parseFloat(getComputedStyle(surface).getPropertyValue("--surface-gap"));
    return { actual: box.top >= trigger.bottom ? box.top - trigger.bottom : trigger.top - box.bottom, token };
  });
  assert(Math.abs(comboGap.actual - comboGap.token) <= 1, `Combobox should consume the surface gap token, got ${comboGap.actual}px`);
  await delayedPage.fill("#model-select-input", "gpt");
  const activeId = await delayedPage.getAttribute("#model-select-input", "aria-activedescendant");
  assert(activeId && await delayedPage.locator(`#${activeId}[role=option].active`).count() === 1, "editable Combobox should track its visual option with aria-activedescendant");
  await delayedPage.keyboard.press("ArrowDown");
  assert.equal(await delayedPage.evaluate(() => document.activeElement?.id), "model-select-input", "arrow navigation should keep focus in the search input");
  await delayedPage.keyboard.press("Enter");
  assert.equal(await delayedPage.locator("#model-select-listbox").count(), 0);
  assert.equal(await delayedPage.evaluate(() => document.activeElement?.id), "model-select", "keyboard commit should restore trigger focus");
  assert.equal((await delayedPage.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings")))).answer_model, "openai/gpt-5");
  await delayed.close();

  const failed = await browser.newContext();
  const failedPage = await failed.newPage();
  let catalogAttempts = 0;
  await failedPage.route(MODEL_URL, async (route) => {
    catalogAttempts += 1;
    await route.fulfill(catalogAttempts === 1
      ? { status: 503, headers: corsHeaders(), body: "unavailable" }
      : { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(fixture) });
  });
  await openFreshSettings(failedPage);
  await failedPage.click("#model-select");
  await failedPage.waitForSelector(".combobox-error");
  await failedPage.fill("#model-select-input", "vendor/exact-model");
  assert.equal(await failedPage.locator("[role=option][data-free-text=true]").count(), 1, "failed catalogs should retain the exact-id path");
  await failedPage.fill("#model-select-input", "");
  await failedPage.click("[data-combobox-retry]");
  await failedPage.waitForSelector(".model-option[data-value='openai/gpt-5']");
  assert.equal(catalogAttempts, 2, "retry should invoke load again and recover");
  await failed.close();

  const empty = await browser.newContext();
  const emptyPage = await empty.newPage();
  await emptyPage.route(MODEL_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [] }) }));
  await openFreshSettings(emptyPage);
  await emptyPage.click("#model-select");
  await emptyPage.waitForSelector(".combobox-empty");
  assert.match(await emptyPage.locator(".combobox-empty").innerText(), /returned no models/i);
  await emptyPage.fill("#model-select-input", "vendor/exact-model");
  await emptyPage.keyboard.press("Enter");
  assert.equal((await emptyPage.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings")))).author_model, "vendor/exact-model", "empty catalogs should commit free text");
  await empty.close();

  await verifyLocalComboboxStates(fixture);
}

async function verifyLocalComboboxStates(openRouterFixture) {
  const run = async (handler) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(MODEL_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(openRouterFixture) }));
    await page.route(LOCAL_MODEL_URL, handler);
    await openFreshSettings(page);
    await switchSettingsToLocal(page);
    return { context, page };
  };

  const found = await run((route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "llama3.2" }, { id: "qwen3:8b" }] }) }));
  await found.page.click("#local-model");
  assert.match(await found.page.locator("#local-model-listbox").innerText(), /Looking for installed models/);
  await found.page.waitForSelector(".model-option[data-value='qwen3:8b']");
  await found.page.click(".model-option[data-value='qwen3:8b']");
  const foundSettings = await found.page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings")));
  assert.equal(foundSettings.answer_model, "qwen3:8b"); assert.equal(foundSettings.author_model, "qwen3:8b");
  await found.context.close();

  const none = await run((route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [] }) }));
  await none.page.click("#local-model");
  await none.page.waitForSelector(".combobox-empty");
  assert.match(await none.page.locator(".combobox-empty").innerText(), /No models are installed.*ollama list/is);
  await none.context.close();

  let attempts = 0;
  const failed = await run((route) => {
    attempts += 1;
    return route.fulfill(attempts === 1 ? { status: 500, headers: corsHeaders(), body: "failed" }
      : { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "recovered:latest" }] }) });
  });
  await failed.page.click("#local-model");
  await failed.page.waitForSelector(".combobox-error");
  await failed.page.fill("#local-model-input", "typed:exact");
  assert.equal(await failed.page.locator("[role=option][data-value='typed:exact']").count(), 1);
  await failed.page.fill("#local-model-input", "");
  await failed.page.click("[data-combobox-retry]");
  await failed.page.waitForSelector("[role=option][data-value='recovered:latest']");
  assert.equal(attempts, 2);
  await failed.context.close();

  const free = await run((route) => route.fulfill({ status: 502, headers: corsHeaders(), body: "failed" }));
  await free.page.click("#local-model");
  await free.page.waitForSelector(".combobox-error");
  await free.page.fill("#local-model-input", "manual:7b");
  await free.page.keyboard.press("Enter");
  assert.equal((await free.page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings")))).answer_model, "manual:7b", "failed local discovery should commit an exact id");
  await free.context.close();
}

async function openFreshSettings(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.keyboard.press("Escape");
  await page.click("#t-settings");
  await page.waitForSelector("#web-settings-popover");
  assert.equal(await page.getAttribute("#t-settings", "aria-expanded"), "true", "settings trigger must expose the open popover state");
  assert.equal(await page.getAttribute("#t-settings", "aria-controls"), "web-settings-popover", "settings trigger must control only the live surface");
}

async function switchSettingsToLocal(page) {
  await page.click("#provider-select");
  await page.click("#provider-select-listbox [role=option]:has-text('Local')");
  await page.waitForSelector("#local-model");
}

async function verifyAskKeyUxAndRail() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await routeProvider(page, {
    keyStatus: (key) => key === MOCK_KEY ? 200 : 401,
    providerDelayMs: 750,
    streams: [[
      "# Attention mechanism\n\n",
      "Attention compares tokens, scores their relevance, and mixes information according to those scores.",
    ]],
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#composer-path-ask");
  await page.fill("#composer-input", "Explain the attention mechanism");
  await page.click("#composer-primary");
  await page.waitForSelector("#composer-key-panel:not([hidden])");
  assert.equal(await page.inputValue("#composer-input"), "Explain the attention mechanism");
  assert.equal(await page.locator("#composer-key").count(), 1, "ask flow should expose the OpenRouter key input");
  assert.equal(await page.getAttribute("#composer-key-toggle", "aria-pressed"), "false");
  await page.click("#composer-key-toggle");
  assert.equal(await page.getAttribute("#composer-key", "type"), "text", "inline key eye should reveal the key");
  assert.equal(await page.getAttribute("#composer-key-toggle", "aria-pressed"), "true", "inline key eye should expose its pressed state");
  await page.click("#composer-key-toggle");
  assert.equal(await page.getAttribute("#composer-key", "type"), "password", "inline key eye should hide the key again");
  assert.equal(await page.getAttribute("#composer-key-toggle", "aria-pressed"), "false");
  assert.match(await page.locator("#composer-key-panel").innerText(), /Stored only in this browser/i);
  assert.equal(await page.locator("#composer-model").count(), 0, "first-run key moment should not demand a model decision");
  assert.equal(await page.isChecked("#composer-remember"), true, "remember-on-this-device should default on");

  await page.fill("#composer-key", "sk-ant-fake-key");
  await page.waitForSelector("text=That looks like an Anthropic key");
  await page.fill("#composer-key", BAD_KEY);
  await page.waitForSelector(".key-status.invalid");
  await page.fill("#composer-key", MOCK_KEY);
  await page.waitForSelector(".node .doc-content[data-node-id] .loading");
  const rootIdWhileLoading = await page.getAttribute(".node .doc-content[data-node-id]", "data-node-id");
  assert.equal(await page.locator(".node").count(), 1, "the first answer should begin in the real root node");
  assert.match(await page.locator(".node .loading-status").innerText(), /Thinking/, "the root should use the regular pending-node loading state");
  assert.equal(await page.locator("#composer-modal").isVisible(), false, "the composer should close before the root begins streaming");
  assert(!/creating (?:the )?(?:root|first)|creating your starting point/i.test(await page.locator("body").innerText()), "root creation status copy should be absent");
  await waitForCanvasText(page, "Attention compares tokens");
  await page.waitForTimeout(1200); // view-state debounce + IndexedDB save debounce
  const hole = await page.evaluate(async () => window.__rabbitholeTest.readStoredHole());
  assert.equal(hole.root_id, rootIdWhileLoading, "the loading node should remain the root after streaming completes");
  assert.equal(hole.title, "Attention mechanism");
  assert.equal(!!hole.view_state?.view, false, "composer-created hole must not persist a camera before user interaction");
  assert.equal(await page.locator(".rail-thumb").count(), 0, "rail should not spend space on map previews");
  assert.equal(await page.locator(".rail-footer").count(), 0, "rail should contain only saved Rabbitholes");
  assert.equal(await page.locator(".rail-wordmark, .rail-count, [data-copy-agent]").count(), 0, "rail should omit redundant branding, counts, and agent setup");
  assert(!/\bnode(s)?\b/i.test(await page.locator("#web-rail").innerText()), "rail metadata should not show node counts");
  assert.equal(await page.locator(".rail-current-dot, .rail-meta").count(), 0, "rows should not spend title space on status ornaments or timestamps");
  assert.match(await page.getAttribute(".rail-row.current .rail-open", "title"), /^Updated /, "updated time should remain available on hover");
  const railPadding = await page.locator(".rail-list").evaluate((list) => {
    const styles = getComputedStyle(list);
    return { top: styles.paddingTop, bottom: styles.paddingBottom };
  });
  assert.equal(railPadding.top, railPadding.bottom, "sidebar content should have balanced top and bottom breathing room");
  assert.equal(railPadding.top, "12px", "sidebar content should not crowd the top edge");
  const railDetailGeometry = await page.evaluate(() => {
    const toolbar = document.getElementById("toolbar").getBoundingClientRect();
    const rail = document.getElementById("web-rail").getBoundingClientRect();
    const button = document.querySelector(".rail-row.current .rail-open");
    const title = button.querySelector(".rail-title");
    const actions = document.querySelector(".rail-row.current .rail-actions");
    const icon = actions.querySelector(".rail-icon");
    const buttonRect = button.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const buttonStyles = getComputedStyle(button);
    const actionStyles = getComputedStyle(actions);
    const iconStyles = getComputedStyle(icon);
    return {
      toolbarGap: rail.top - toolbar.bottom,
      bottomGap: innerHeight - rail.bottom,
      textTopGap: titleRect.top - buttonRect.top,
      textBottomGap: buttonRect.bottom - titleRect.bottom,
      paddingTop: buttonStyles.paddingTop,
      paddingBottom: buttonStyles.paddingBottom,
      actionBackground: actionStyles.backgroundImage,
      iconBackground: iconStyles.backgroundColor,
    };
  });
  assert(Math.abs(railDetailGeometry.toolbarGap - railDetailGeometry.bottomGap) <= 1, "sidebar should use one outer gap above and below");
  assert.equal(railDetailGeometry.paddingTop, "8px");
  assert.equal(railDetailGeometry.paddingBottom, "8px", "row should consume the shared row-padding token symmetrically");
  assert(Math.abs(railDetailGeometry.textTopGap - railDetailGeometry.textBottomGap) <= 1, "row label should sit optically centered");
  assert.equal(railDetailGeometry.actionBackground, "none", "row actions should not sit on a dark backing plate");
  assert.equal(railDetailGeometry.iconBackground, "rgba(0, 0, 0, 0)", "row icons should remain unboxed");
  const railGeometry = await page.locator("#web-rail").evaluate((rail) => {
    const rect = rail.getBoundingClientRect();
    return {
      height: rect.height,
      bottomGap: window.innerHeight - rect.bottom,
      width: rect.width,
    };
  });
  assert(railGeometry.height > 300, `open rail should read as a full-height sidebar, got ${railGeometry.height}px`);
  assert.equal(Math.round(railGeometry.bottomGap), 14, "sidebar should stay anchored to the bottom canvas edge");
  assert(railGeometry.width <= 226, `sidebar should remain compact, got ${railGeometry.width}px`);
  await page.keyboard.press("s");
  await page.waitForSelector("#web-rail.open");
  const railFocusTreatment = await page.evaluate(() => {
    const rail = document.getElementById("web-rail");
    return { focused: document.activeElement === rail, outline: getComputedStyle(rail).outlineStyle };
  });
  assert.equal(railFocusTreatment.focused, true, "keyboard-opened rail should hold focus so keys flow into its rows");
  assert.equal(railFocusTreatment.outline, "none", "keyboard-opened rail must use container emphasis, not a focus ring around the panel");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#web-rail:not(.open)", { state: "attached" });
  assert.equal(
    await page.evaluate(() => document.body.classList.contains("mode-canvas")),
    true,
    "Escape with the rail focused must close only the rail, not fall through to the canvas client's open-the-reader shortcut"
  );
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-api-keys") || "{}").openrouter), MOCK_KEY, "remembered key should stay in this browser's provider-key map");
  assert.equal(await page.evaluate(() => localStorage.getItem("rh-web-api-key")), null, "legacy single-key storage should stay retired");
  const snapshotHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  assert(!snapshotHtml.includes(MOCK_KEY), "snapshot export must not contain provider key");
  assert(
    snapshotHtml.includes("<style>\n\n</style>"),
    "known defect tripwire (C4): web-exported snapshots serialize the page's inline <style>, which the web build does not emit, so they ship unstyled; the styled export path lives in the canvas host. Phase 7's snapshot boundary makes web exports styled and self-contained — retire this tripwire there and recalibrate the snapshot byte budgets."
  );
  const rawJson = JSON.stringify(hole);
  assert(!rawJson.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");

  await page.click("#t-settings");
  await page.waitForSelector("#web-settings-popover");
  assert.equal(await page.locator("#save-settings, #web-settings-close").count(), 0, "settings should apply live without save or close buttons");
  assert.equal(await page.locator(".settings-section").first().getAttribute("class"), "settings-section provider-section", "provider should be the first settings decision");
  assert.equal(await page.locator("#provider-select").evaluate((select) => select.tagName), "BUTTON", "provider should use the owned Select trigger");
  assert.equal(await page.getAttribute("#provider-select", "aria-haspopup"), "listbox");
  assert.equal(await page.getAttribute("#provider-select", "aria-expanded"), "false");
  assert.match(await page.getAttribute("#provider-select", "aria-labelledby"), /provider-select-label/);
  await page.focus("#provider-select");
  await page.keyboard.press("Enter");
  assert.equal(await page.getAttribute("#provider-select", "aria-expanded"), "true");
  assert.deepEqual(await page.locator("#provider-select-listbox [role=option]").allTextContents(), ["OpenRouter", "Local"]);
  assert.deepEqual(await page.locator("#provider-select-listbox [role=option]").evaluateAll((options) => options.map((option) => option.getAttribute("aria-selected"))), ["true", "false"]);
  await page.waitForTimeout(180);
  const selectGap = await page.evaluate(() => {
    const trigger = document.getElementById("provider-select").getBoundingClientRect();
    const list = document.getElementById("provider-select-listbox");
    const surface = list.getBoundingClientRect();
    return { actual: surface.top - trigger.bottom, token: parseFloat(getComputedStyle(list).getPropertyValue("--surface-gap")) };
  });
  assert(Math.abs(selectGap.actual - selectGap.token) <= 1, `Select listbox should use the surface gap token, got ${selectGap.actual}px`);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#provider-select-listbox").count(), 0, "first Escape should close only the child Select layer");
  assert.equal(await page.locator("#web-settings-popover").isVisible(), true, "settings should remain after child Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "provider-select", "Escape should restore Select trigger focus");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), "Local", "ArrowDown should open and rove to the next option");
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), "OpenRouter");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#provider-select-listbox").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "provider-select", "commit should restore focus to the re-rendered trigger");
  assert.equal(await page.getAttribute("#provider-select", "data-value"), "custom");
  assert.equal(await page.locator(".endpoint-section #provider-base").count(), 1, "Local should surface its endpoint immediately");
  assert.equal(await page.locator("#api-key").count(), 0, "Local should not show irrelevant credential UI");
  assert.equal(await page.locator("#model-select").count(), 0, "Local should not use the global OpenRouter model picker");
  assert.equal(await page.locator("#local-model").evaluate((control) => control.tagName), "BUTTON", "Local should use the owned Combobox trigger");
  assert.deepEqual(await page.evaluate(() => ["provider-base"].map((id) => {
    const input = document.getElementById(id);
    const label = document.querySelector(`label[for="${id}"]`);
    const described = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    return { id, named: !!label?.textContent.trim(), described: described.length > 0 && described.every((ref) => !!document.getElementById(ref)) };
  })), [
    { id: "provider-base", named: true, described: true },
  ], "Local endpoint Field should have a label name and connected hint");
  await page.focus("#local-model");
  await page.keyboard.press("Enter");
  await page.fill("#local-model-input", "deepseek-r1:7b");
  await page.waitForSelector("#local-model-listbox [role=option][data-value='deepseek-r1:7b']");
  await page.keyboard.press("Enter");
  const localSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings") || "{}"));
  assert.equal(localSettings.answer_model, "deepseek-r1:7b");
  assert.equal(localSettings.author_model, "deepseek-r1:7b");
  await page.focus("#provider-select");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
  await page.keyboard.press("Home");
  await page.keyboard.press(" ");
  assert.equal(await page.inputValue("#api-key"), MOCK_KEY, "returning to a provider should restore only that provider's local key");
  await page.click("#model-select");
  await page.waitForSelector(".model-option[data-value='anthropic/claude-sonnet-5'] .model-chip");
  await page.fill("#model-select-input", "gpt");
  assert.equal(
    await page.locator(".model-option[data-value='openai/gpt-5'] .model-option-price").innerText(),
    "$1.25 · $10",
    "picker rows should show per-million pricing from the catalog",
  );
  await page.click(".model-option[data-value='openai/gpt-5']");
  await page.waitForSelector("#model-select-listbox", { state: "detached" });
  assert.equal(await page.locator("#model-select-name").innerText(), "GPT-5");
  const pickedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings") || "{}"));
  assert.equal(pickedSettings.answer_model, "openai/gpt-5", "model pick should apply instantly, no save button");
  assert.equal(pickedSettings.author_model, "openai/gpt-5", "one model choice should drive authoring too");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#web-settings-popover", { state: "detached" });
  assert.equal(await page.locator("#web-settings-popover").count(), 0, "Escape must remove the settings surface from the DOM");
  assert.equal(await page.getAttribute("#t-settings", "aria-expanded"), "false", "settings trigger must expose the closed state");
  assert.equal(await page.getAttribute("#t-settings", "aria-controls"), null, "closed settings must not reference a dead surface");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-settings", "settings Escape should restore its trigger after the Select child closes first");
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true, "nested Escapes must not reach the canvas shortcut");

  await context.close();

  const sessionContext = await browser.newContext();
  const sessionPage = await sessionContext.newPage();
  await routeProvider(sessionPage, {
    keyStatus: () => 200,
    streams: [["# Session key\n\nThis root verifies session-only storage."]],
  });
  await sessionPage.goto(baseUrl, { waitUntil: "networkidle" });
  await sessionPage.click("#composer-path-ask");
  await sessionPage.fill("#composer-input", "Check session-only storage");
  await sessionPage.click("#composer-primary");
  await sessionPage.waitForSelector("#composer-key-panel:not([hidden])");
  await sessionPage.locator("#composer-remember").setChecked(false, { force: true });
  await sessionPage.fill("#composer-key", MOCK_KEY);
  await waitForCanvasText(sessionPage, "This root verifies session-only storage");
  assert.equal(await sessionPage.evaluate(() => localStorage.getItem("rh-web-api-key")), null, "opting out of remember must keep the key out of localStorage");
  assert.equal(await sessionPage.evaluate(() => JSON.parse(localStorage.getItem("rh-web-api-keys") || "{}").openrouter), undefined, "opting out of remember must keep the provider-key map clean");
  await sessionContext.close();
}

async function verifyCanvasBranching() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  let providerCalls = 0;
  page.on("request", (request) => requests.push(request.url()));
  await routeProvider(page, {
    keyStatus: () => 200,
    onProviderCall: () => { providerCalls += 1; },
    streams: [
      [
        "TITLE: Euler branch\n",
        "Euler identity connects rotation, growth, and zero in one compact statement.\n\n",
        "```show\n<style>.flow{display:grid;gap:8px}.box{border:1px solid var(--border);padding:8px;border-radius:6px}</style><div class='flow'><div class='box'>rotation</div><div class='box'>cancellation</div></div>\n```\n",
      ],
      [
        "TITLE: Deeper link\n",
        "Second branch explains the geometric view: multiplication by $e^{i\\theta}$ rotates a point on the complex plane.",
      ],
    ],
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  await page.click("#t-settings");
  await page.waitForTimeout(140);
  const toolbarAlignment = await page.evaluate(() => {
    const settings = document.getElementById("t-settings").getBoundingClientRect();
    const theme = document.getElementById("t-theme").getBoundingClientRect();
    return { settingsTop: settings.top, themeTop: theme.top, settingsHeight: settings.height, themeHeight: theme.height };
  });
  assert(Math.abs(toolbarAlignment.settingsTop - toolbarAlignment.themeTop) < 0.5, "settings control should align with toolbar peers");
  assert.equal(toolbarAlignment.settingsHeight, toolbarAlignment.themeHeight, "settings control should match toolbar peer height");
  const settingsPlacement = await page.evaluate(() => {
    const button = document.getElementById("t-settings").getBoundingClientRect();
    const dialog = document.querySelector(".web-settings-dialog").getBoundingClientRect();
    const styles = getComputedStyle(document.documentElement);
    const edge = parseFloat(styles.getPropertyValue("--surface-edge"));
    const gap = parseFloat(styles.getPropertyValue("--surface-gap"));
    return {
      rightAlignment: Math.abs(dialog.right - button.right),
      leftEdge: dialog.left,
      triggerGap: dialog.top - button.bottom,
      edge,
      gap,
      withinViewport: dialog.left >= edge && dialog.right <= innerWidth - edge && dialog.top >= edge && dialog.bottom <= innerHeight - edge,
    };
  });
  assert(settingsPlacement.rightAlignment < 1 || Math.abs(settingsPlacement.leftEdge - settingsPlacement.edge) < 1,
    `settings panel should anchor to its gear or the safe page edge, right offset ${settingsPlacement.rightAlignment.toFixed(2)}px, left ${settingsPlacement.leftEdge.toFixed(2)}px`);
  assert(Math.abs(settingsPlacement.triggerGap - settingsPlacement.gap) < 1, `settings panel should use the token gap from its trigger, got ${settingsPlacement.triggerGap.toFixed(2)}px`);
  assert.equal(settingsPlacement.withinViewport, true, "settings panel should stay within the viewport");
  await page.evaluate(() => {
    const trigger = document.getElementById("t-settings");
    trigger.style.position = "fixed";
    trigger.style.bottom = "8px";
    trigger.style.right = "14px";
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(50);
  const flipped = await page.evaluate(() => {
    const trigger = document.getElementById("t-settings").getBoundingClientRect();
    const dialog = document.querySelector(".web-settings-dialog").getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-gap"));
    return { placement: document.querySelector(".web-settings-dialog").dataset.placement, gap: trigger.top - dialog.bottom, tokenGap: gap };
  });
  assert.equal(flipped.placement, "top-end", "settings should flip above when below-space cannot fit the rendered surface");
  assert(Math.abs(flipped.gap - flipped.tokenGap) < 1, "flipped settings should preserve the token gap");
  await page.evaluate(() => {
    document.getElementById("t-settings").removeAttribute("style");
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(50);
  const growthBefore = await page.locator(".web-settings-dialog").boundingBox();
  await page.evaluate(() => {
    const growth = document.createElement("div");
    growth.id = "anchor-growth-probe";
    growth.style.height = "120px";
    document.getElementById("settings-panel").appendChild(growth);
  });
  await page.waitForTimeout(50);
  const growthAfter = await page.evaluate(() => {
    const dialog = document.querySelector(".web-settings-dialog").getBoundingClientRect();
    const edge = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-edge"));
    return { top: dialog.top, height: dialog.height, bottom: dialog.bottom, limit: innerHeight - edge };
  });
  assert(growthAfter.height > growthBefore.height || growthAfter.top < growthBefore.y,
    "content growth should resize or reposition the measured settings surface");
  assert(growthAfter.bottom <= growthAfter.limit + 1, "content growth should re-clamp settings within the token edge");
  await page.evaluate(() => document.getElementById("anchor-growth-probe").remove());
  const settingsSurfaceStandard = await page.evaluate(() => {
    const styles = getComputedStyle(document.querySelector(".web-settings-dialog"));
    return {
      background: styles.backgroundColor,
      border: styles.border,
      radius: styles.borderRadius,
      shadow: styles.boxShadow,
      backdrop: styles.backdropFilter,
    };
  });
  const gearOffset = await page.evaluate(() => {
    const button = document.getElementById("t-settings");
    const glyph = button.querySelector("svg g");
    const box = glyph.getBBox();
    const ctm = glyph.getScreenCTM();
    const cx = ctm.a * (box.x + box.width / 2) + ctm.c * (box.y + box.height / 2) + ctm.e;
    const cy = ctm.b * (box.x + box.width / 2) + ctm.d * (box.y + box.height / 2) + ctm.f;
    const rect = button.getBoundingClientRect();
    return { dx: cx - (rect.left + rect.width / 2), dy: cy - (rect.top + rect.height / 2) };
  });
  assert(Math.abs(gearOffset.dx) < 0.25 && Math.abs(gearOffset.dy) < 0.25,
    `settings gear glyph should be optically centered in its button, off by ${gearOffset.dx.toFixed(2)},${gearOffset.dy.toFixed(2)}px`);
  assert.match(await page.locator("#settings-panel").innerText(), /Stored only in this browser/i);
  assert.equal(await page.locator("#model-select").count(), 1, "settings should expose the model picker without opening Advanced");
  await page.locator(".settings-advanced summary").click();
  assert.deepEqual(await page.evaluate(() => ["api-key", "answer-model", "author-model", "fetch-proxy-url"].map((id) => {
    const input = document.getElementById(id);
    const label = document.querySelector(`label[for="${id}"]`);
    const described = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    return { id, named: !!label?.textContent.trim(), described: described.length > 0 && described.every((ref) => !!document.getElementById(ref)) };
  })), [
    { id: "api-key", named: true, described: true },
    { id: "answer-model", named: true, described: true },
    { id: "author-model", named: true, described: true },
    { id: "fetch-proxy-url", named: true, described: true },
  ], "OpenRouter text fields should have label names and connected Field hints or status");
  assert.equal(await page.getAttribute("#api-key-status", "aria-live"), "polite", "API key Field status should remain a polite live region");
  await page.click("#api-key");
  const pointerFieldFocus = await page.evaluate(() => ({
    outline: getComputedStyle(document.getElementById("api-key")).outlineStyle,
    halo: getComputedStyle(document.querySelector(".key-input-wrap")).boxShadow,
  }));
  assert.equal(pointerFieldFocus.outline, "none", "pointer-focused fields should not show the keyboard ring");
  assert.notEqual(pointerFieldFocus.halo, "none", "composite field focus should show the field halo");
  await page.locator("#api-key-toggle").focus();
  await page.keyboard.press("Shift+Tab");
  const keyboardFieldFocus = await page.evaluate(() => ({
    focused: document.activeElement?.id,
    outline: getComputedStyle(document.getElementById("api-key")).outlineStyle,
    halo: getComputedStyle(document.querySelector(".key-input-wrap")).boxShadow,
  }));
  assert.equal(keyboardFieldFocus.focused, "api-key");
  assert.notEqual(keyboardFieldFocus.outline, "none", "keyboard-focused fields should show the focus-visible ring");
  assert.notEqual(keyboardFieldFocus.halo, "none", "keyboard-focused composite fields should retain the field halo");
  await page.click("#model-select");
  await page.waitForSelector("#model-select-listbox");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#model-select-listbox").count(), 0, "first Escape should close only the nested model combobox");
  assert.equal(await page.locator("#web-settings-popover").getAttribute("hidden"), null, "settings should remain open after its child closes");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#web-settings-popover", { state: "detached" });
  assert.equal(await page.locator("#web-settings-popover").count(), 0, "outside pointer must remove the settings surface from the DOM");
  assert.equal(await page.getAttribute("#t-settings", "aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-settings", "closing settings should restore focus to its trigger");
  await page.click("#t-settings");
  await page.waitForSelector("#web-settings-popover");
  await page.mouse.click(4, 300);
  await page.waitForSelector("#web-settings-popover", { state: "detached" });
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-settings", "outside-pointer close should restore settings focus");
  await page.click("#t-settings");
  await page.fill("#api-key", MOCK_KEY);
  await page.press("#api-key", "Enter");
  await page.waitForSelector("#api-key-status.valid");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#web-settings-popover", { state: "detached" });

  const markdown = [
    "# Web Smoke",
    "",
    "Euler identity $e^{i\\pi}+1=0$ ties exponentials to geometry.",
    "",
    "```js",
    "console.log('math branch');",
    "```",
    "",
    "```show",
    "<style>.flow{display:grid;gap:8px}.box{border:1px solid var(--border);padding:8px;border-radius:6px}</style>",
    "<div class='flow'><div class='box'>Select</div><div class='box' style='background:var(--hl)'>Ask</div></div>",
    "```",
  ].join("\n");

  await createDocument(page, markdown);
  await page.waitForSelector(".node .katex");
  await page.waitForSelector(".node .hljs");
  await page.waitForSelector(".node .viz-show");

  await page.click("#t-reader");
  await page.waitForSelector("body:not(.mode-canvas)");
  await page.focus("#r-textup");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "r-canvas");
  const readerFocusRing = await page.evaluate(() => getComputedStyle(document.getElementById("r-canvas")).outlineStyle);
  assert.notEqual(readerFocusRing, "none", "keyboard focus should show the reader-toolbar focus-visible ring");
  await page.keyboard.press("Enter");
  await page.waitForSelector("body.mode-canvas");
  await page.focus("#t-new");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-reader");
  const canvasFocusRing = await page.evaluate(() => getComputedStyle(document.getElementById("t-reader")).outlineStyle);
  assert.notEqual(canvasFocusRing, "none", "keyboard focus should show the canvas-toolbar focus-visible ring");
  await page.keyboard.press("Space");
  await page.waitForSelector("body:not(.mode-canvas)");
  await page.focus("#r-canvas");
  await page.keyboard.press("Enter");
  await page.waitForSelector("body.mode-canvas");

  await page.focus("#t-share");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#sharemenu.visible");
  await page.waitForFunction(() => document.activeElement?.id === "sm-trail");
  await page.waitForTimeout(130);
  const shareStandard = await page.evaluate(() => {
    const menu = document.getElementById("sharemenu");
    const anchor = document.getElementById("t-share").getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const styles = getComputedStyle(menu);
    const rootStyles = getComputedStyle(document.documentElement);
    const itemStyles = getComputedStyle(menu.querySelector(".sm-item"));
    return {
      surface: {
        background: styles.backgroundColor,
        border: styles.border,
        radius: styles.borderRadius,
        shadow: styles.boxShadow,
        backdrop: styles.backdropFilter,
      },
      rightAlignment: Math.abs(menuRect.right - anchor.right),
      triggerGap: menuRect.top - anchor.bottom,
      tokenGap: parseFloat(rootStyles.getPropertyValue("--surface-gap")),
      shellPadding: styles.padding,
      itemPaddingTop: itemStyles.paddingTop,
      itemPaddingBottom: itemStyles.paddingBottom,
      expanded: document.getElementById("t-share").getAttribute("aria-expanded"),
      menuItems: menu.querySelectorAll('[role="menuitem"]').length,
    };
  });
  assert.deepEqual(shareStandard.surface, settingsSurfaceStandard, "Share and Settings should use the same popover surface standard");
  assert(shareStandard.rightAlignment < 1, `Share should anchor to its trigger, off by ${shareStandard.rightAlignment.toFixed(2)}px`);
  assert(Math.abs(shareStandard.triggerGap - shareStandard.tokenGap) < 1, `Share should use the token gap from its trigger, got ${shareStandard.triggerGap.toFixed(2)}px`);
  assert.equal(shareStandard.shellPadding, "6px");
  assert.equal(shareStandard.itemPaddingTop, "8px");
  assert.equal(shareStandard.itemPaddingBottom, "8px");
  assert.equal(shareStandard.expanded, "true");
  assert.equal(shareStandard.menuItems, 5);
  assert.deepEqual(await page.locator('#sharemenu [role="menuitem"]').evaluateAll((items) => items.map((item) => item.tabIndex)), [0, -1, -1, -1, -1], "Share should expose one item in the Tab sequence");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sm-synth", "ArrowUp should wrap to the last visible Share item");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sm-trail", "ArrowDown should wrap to the first visible Share item");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sm-synth");
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sm-trail");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#sharemenu:not(.visible)", { state: "attached" });
  await page.waitForFunction(() => document.activeElement?.id === "t-share").catch(() => {
    assert.fail("Enter should activate the focused Share item and restore its trigger");
  });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "sm-trail");
  await page.keyboard.press("Tab");
  await page.waitForSelector("#sharemenu:not(.visible)", { state: "attached" });
  assert.equal(await page.locator("#sharemenu:focus-within").count(), 0, "Tab should close Share and continue outside the menu");
  await page.focus("#t-share");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "sm-trail");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#sharemenu:not(.visible)", { state: "attached" });
  assert.equal(await page.getAttribute("#t-share", "aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-share", "closing Share should restore focus to its trigger");

  const frozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const frozenPage = await context.newPage();
  await frozenPage.setContent(frozenHtml, { waitUntil: "load" });
  await frozenPage.focus("#t-share");
  await frozenPage.keyboard.press("Enter");
  await frozenPage.waitForSelector("#sharemenu.visible");
  await frozenPage.waitForFunction(() => document.activeElement?.id === "sm-trail");
  assert.deepEqual(await frozenPage.locator('#sharemenu [role="menuitem"]:visible').evaluateAll((items) => items.map((item) => item.id)), ["sm-trail", "sm-doc"], "Frozen Share should suppress export, portable export, and synthesis");
  assert.deepEqual(await frozenPage.locator('#sharemenu [role="menuitem"]').evaluateAll((items) => items.map((item) => ({ id: item.id, tabIndex: item.tabIndex, visible: item.style.display !== "none" }))), [
    { id: "sm-trail", tabIndex: 0, visible: true },
    { id: "sm-doc", tabIndex: -1, visible: true },
    { id: "sm-export", tabIndex: -1, visible: false },
    { id: "sm-portable", tabIndex: -1, visible: false },
    { id: "sm-synth", tabIndex: -1, visible: false },
  ], "Frozen roving tabindex should cover exactly the remaining items");
  await frozenPage.keyboard.press("ArrowDown");
  assert.equal(await frozenPage.evaluate(() => document.activeElement?.id), "sm-doc");
  await frozenPage.keyboard.press("ArrowDown");
  assert.equal(await frozenPage.evaluate(() => document.activeElement?.id), "sm-trail", "Frozen ArrowDown should wrap across only visible items");
  await frozenPage.keyboard.press("ArrowUp");
  assert.equal(await frozenPage.evaluate(() => document.activeElement?.id), "sm-doc", "Frozen ArrowUp should wrap across only visible items");
  await frozenPage.keyboard.press("Escape");
  assert.equal(await frozenPage.evaluate(() => document.activeElement?.id), "t-share", "Frozen Share Escape should restore its trigger");
  await frozenPage.close();

  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Why does this matter?");
  await page.click("#ask-go");
  await waitForCanvasText(page, "Euler identity connects rotation");
  assert.equal(providerCalls, 1);

  const branchMark = page.locator('mark[data-child].mark-ready').first();
  assert.deepEqual(await branchMark.evaluate((mark) => ({ tabIndex: mark.tabIndex, role: mark.getAttribute("role"), name: mark.getAttribute("aria-label") })),
    { tabIndex: 0, role: "link", name: "Open branch: Euler branch" }, "branch marks should expose keyboard navigation semantics and the branch title");
  await branchMark.hover();
  await page.waitForSelector("#peek.visible");
  assert.equal(await page.locator("#peek [data-peek-title]").innerText(), "Euler branch");
  await page.mouse.move(2, 2);
  await page.waitForSelector("#peek:not(.visible)", { state: "attached" });

  await page.focus("#r-theme");
  for (let i = 0; i < 8 && !await page.evaluate(() => document.activeElement?.matches('mark[data-child]')); i += 1) await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.matches('mark[data-child]')), true, "branch marks should be reachable in the shared document Tab order");
  await page.waitForSelector("#peek.visible");
  assert.equal(await page.evaluate(() => document.activeElement?.matches('mark[data-child]')), true, "keyboard peek must not steal mark focus");
  assert.notEqual(await branchMark.evaluate((mark) => getComputedStyle(mark).outlineStyle), "none", "focused branch marks should show a keyboard ring");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#peek:not(.visible)", { state: "attached" });
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true, "peek Escape must not leak to canvas shortcuts or change views");
  assert.equal(await page.evaluate(() => document.activeElement?.matches('mark[data-child]')), true, "peek Escape should leave focus on its mark");
  await page.focus("#t-reader");
  assert.equal(await page.locator("#peek.visible").count(), 0, "moving focus away should dismiss peek");

  await branchMark.focus();
  await page.waitForSelector("#peek.visible");
  await page.evaluate(() => {
    const mark = document.querySelector('mark[data-child].mark-ready');
    mark.__probeRect = mark.getBoundingClientRect;
    mark.getBoundingClientRect = () => ({ left: 4, right: 84, top: innerHeight - 22, bottom: innerHeight - 2, width: 80, height: 20, x: 4, y: innerHeight - 22 });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(50);
  const peekEdge = await page.evaluate(() => {
    const mark = document.querySelector('mark[data-child].mark-ready').getBoundingClientRect();
    const peek = document.getElementById("peek").getBoundingClientRect();
    const edge = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-edge"));
    return { placement: document.getElementById("peek").dataset.placement, gap: mark.top - peek.bottom,
      tokenGap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-gap")), left: peek.left, edge, right: peek.right, width: innerWidth };
  });
  assert.equal(peekEdge.placement, "top-start", "peek should flip above a mark at the viewport bottom");
  assert(Math.abs(peekEdge.gap - peekEdge.tokenGap) < 1, "flipped peek should preserve the token gap");
  assert(peekEdge.left >= peekEdge.edge - 1 && peekEdge.right <= peekEdge.width - peekEdge.edge + 1, "peek should clamp inside token viewport edges");
  await page.evaluate(() => {
    const mark = document.querySelector('mark[data-child].mark-ready');
    mark.getBoundingClientRect = mark.__probeRect; delete mark.__probeRect;
  });
  await branchMark.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("body:not(.mode-canvas)");
  await page.locator("#reader-main", { hasText: "Euler identity connects rotation" }).waitFor();
  assert.equal(await page.locator("#peek.visible").count(), 0, "Enter on a mark should open its branch and dismiss peek");

  if (!await page.evaluate(() => document.body.classList.contains("mode-canvas"))) await page.click("#r-canvas");
  const childDelete = page.locator('.node:not(.root) .node-btn.danger').first();
  await childDelete.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#confirm.visible");
  await page.waitForFunction(() => document.activeElement?.id === "cf-keep");
  await page.waitForTimeout(140);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "cf-keep", "delete confirmation should initially focus Keep");
  const confirmAnchor = await page.evaluate(() => {
    const trigger = document.querySelector('.node:not(.root) .node-btn.danger').getBoundingClientRect();
    const confirm = document.getElementById("confirm").getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-gap"));
    return { placement: document.getElementById("confirm").dataset.placement, delta: confirm.top - trigger.bottom, gap };
  });
  assert.equal(confirmAnchor.placement, "bottom-end");
  assert(Math.abs(confirmAnchor.delta - confirmAnchor.gap) < 1, "confirmation should use the token gap from the delete control");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.node:not(.root) .node-btn.danger')), true, "confirmation Escape should restore delete-control focus");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#confirm.visible");
  await page.mouse.click(3, 300);
  await page.waitForSelector("#confirm:not(.visible)", { state: "attached" });
  await page.waitForTimeout(20);
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.node:not(.root) .node-btn.danger')), true, "outside-pointer dismissal should restore delete-control focus");

  const branchFrozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const branchFrozenPage = await context.newPage();
  await branchFrozenPage.setContent(branchFrozenHtml, { waitUntil: "load" });
  await branchFrozenPage.click('.node.root .node-acts .node-btn:last-child');
  const frozenMark = branchFrozenPage.locator('mark[data-child].mark-ready').first();
  await frozenMark.focus();
  await branchFrozenPage.waitForSelector("#peek.visible");
  await branchFrozenPage.keyboard.press("Escape");
  await branchFrozenPage.waitForSelector("#peek:not(.visible)", { state: "attached" });
  await branchFrozenPage.close();

  await page.click("#t-reader");
  await page.fill("#composer-text", "Go one layer deeper.");
  await page.click("#composer-send");
  await page.locator("#reader-main", { hasText: "Second branch explains the geometric view" }).waitFor();
  assert.equal(providerCalls, 2);

  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rabbitholeTest && !!document.querySelector(".node .doc-content[data-node-id]"));
  const reloadedRaw = await page.evaluate(() => window.__rabbitholeTest.readStoredHole().then((hole) => JSON.stringify(hole)));
  assert(reloadedRaw.includes("Euler identity connects rotation"));
  assert(reloadedRaw.includes("Second branch explains the geometric view"));
  assert(!reloadedRaw.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");
  assert(!page.url().includes(MOCK_KEY), "URL must not contain provider key");

  if (!await page.evaluate(() => document.body.classList.contains("mode-canvas"))) await page.click("#r-canvas");
  const removeTrigger = page.locator('.node:not(.root) .node-btn.danger').first();
  await removeTrigger.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "cf-keep");
  await page.focus("#cf-remove");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".node:not(.root)", { state: "detached" });
  assert.equal(await page.locator("#confirm.visible").count(), 0, "Enter on Remove should close confirmation and delete the branch subtree");

  const external = requests.filter((url) => !url.startsWith(baseUrl));
  assert(external.length > 0, "provider and key validation should have been called");
  assert(external.every((url) => url === PROVIDER_URL || url === KEY_URL || url === MODEL_URL || url === LOCAL_MODEL_URL), `unexpected external request(s): ${external.join(", ")}`);
  await context.close();
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

async function routeProvider(page, { keyStatus, streams, onProviderCall = null, providerDelayMs = 0 }) {
  await page.route(LOCAL_MODEL_URL, async (route) => {
    await route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [
      { id: "llama3.2", name: "llama3.2" }, { id: "deepseek-r1:7b", name: "deepseek-r1:7b" },
    ] }) });
  });
  await page.route(MODEL_URL, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ data: [
        { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" } },
        { id: "openai/gpt-5", name: "OpenAI: GPT-5", context_length: 400000, pricing: { prompt: "0.00000125", completion: "0.00001" } },
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek: DeepSeek V4 Flash", context_length: 164000, pricing: { prompt: "0", completion: "0" } },
      ] }),
    });
  });
  await page.route(KEY_URL, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
      return;
    }
    const auth = route.request().headers().authorization || "";
    const key = auth.replace(/^Bearer\s+/i, "");
    const status = keyStatus ? keyStatus(key) : 200;
    await route.fulfill({
      status,
      headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
      body: status === 200 ? JSON.stringify({ data: { label: "test key" } }) : JSON.stringify({ error: { message: "invalid key" } }),
    });
  });
  await page.route(PROVIDER_URL, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
      return;
    }
    onProviderCall?.();
    const chunks = streams.shift() || ["# Fallback\n\nFallback streamed document."];
    if (providerDelayMs) await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
    await route.fulfill({
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: sse(chunks),
    });
  });
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rabbitholeTest?.currentHoleId?.() || "");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 2500 }).catch(() => null),
    page.evaluate((value) => window.__rabbitholeTest.createDocument(value), markdown).catch(() => null),
  ]);
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

function sse(chunks) {
  return chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, http-referer, x-title",
  };
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

async function serveStatic(rootDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(rootDir, rel);
    if (!file.startsWith(rootDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
      res.end(bytes);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}
