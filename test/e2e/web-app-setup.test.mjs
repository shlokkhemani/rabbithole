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
const LOCAL_SHOW_URL = "http://localhost:11434/api/show";
const LOCAL_VERSION_URL = "http://localhost:11434/api/version";
const LOCAL_CHAT_URL = "http://localhost:11434/v1/chat/completions";
const GITHUB_REPO_API_URL = "https://api.github.com/repos/shlokkhemani/rabbithole";

const app = await bootWebApp();
const { browser, baseUrl } = app;
try {
  await verifyThemeBeforeAppRuntime();
  await verifyMobileSetupExperience();
  await verifySetupDefaultsToOpenRouterAndGatesLocalGuide();
  await verifyLocalFailureRequiresTroubleshootChoice();
  await verifyLandingAndComposer();
  await verifyReducedMotionOverlays();
  await verifySetupReadinessInvalidation();
  await verifyComboboxCatalogStates();
  await verifyAskKeyUxAndRail();
  console.log("web app verification passed");
} finally {
  await app.close();
}

async function verifyReducedMotionOverlays() {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  await seedConfiguredOpenRouter(context);
  try {
    const page = await context.newPage();
    await routeProvider(page, { streams: [["# Reduced motion root\n\nUsable without animation."]] });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.click("#blank-start-new");
    await page.waitForSelector("#composer-modal:not([hidden])");
    assert.deepEqual(await page.locator("#composer-card").evaluate((card) => {
      const styles = getComputedStyle(card);
      return { opacity: styles.opacity, transform: styles.transform, animationName: styles.animationName };
    }), { opacity: "1", transform: "none", animationName: "none" }, "reduced motion should reveal the composer without relying on its entrance animation");

    await page.click("#composer-path-ask");
    await page.fill("#composer-input", "Check reduced motion");
    await page.click("#composer-primary");
    await waitForCanvasText(page, "Usable without animation.");
    assert.equal(await page.locator(".node.root").evaluate((node) => getComputedStyle(node).opacity), "1", "reduced motion should render the generated root without an entrance transition");

    await page.click("#t-settings");
    await page.waitForSelector("#web-settings-popover");
    assert.equal(await page.locator("#web-settings-popover").evaluate((popover) => getComputedStyle(popover).opacity), "1", "reduced motion should leave settings usable when its entrance animation is disabled");
  } finally {
    await context.close();
  }
}

async function verifySetupDefaultsToOpenRouterAndGatesLocalGuide() {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem("rh-web-settings", JSON.stringify({
    preset: "custom",
    base_url: "http://localhost:11434/v1",
    model: "llama3.2",
    transcribe_model: "llama3.2",
    session_only: true,
  })));
  try {
    const page = await context.newPage();
    let localModelRequests = 0;
    await page.route(LOCAL_MODEL_URL, (route) => {
      localModelRequests += 1;
      return route.fulfill({ status: 502, headers: corsHeaders(), body: "failed" });
    });
    await page.route(LOCAL_VERSION_URL, (route) => route.abort());
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.click("#blank-start-setup");
    await page.waitForSelector("#web-settings-popover");
    await page.waitForTimeout(180);

    assert.equal(localModelRequests, 0, "opening OpenRouter setup must not probe Local");
    assert.equal(await page.getAttribute('[data-provider="openrouter"]', "aria-pressed"), "true", "Set up AI should open the complete OpenRouter path by default");
    assert.equal(await page.locator("#api-key").count(), 1, "default setup should immediately show the OpenRouter form");
    assert.equal(await page.locator("#local-model").count(), 0, "Local controls should stay hidden until Local is selected");
    assert.equal(await page.locator("#ollama-recovery-modal").count(), 0, "opening setup must not force OpenRouter users into Ollama setup");
    assert.deepEqual(await page.locator(".provider-choice button").allTextContents(), ["OpenRouter", "Local"]);

    await page.click('[data-provider="custom"]');
    await page.waitForSelector("#local-model-setup");
    assert.equal(localModelRequests, 1, "choosing Local should start Local model discovery");
    assert.equal(await page.locator("#ollama-recovery-modal").count(), 0, "failed Local discovery should stay in the Local settings screen");
    assert.equal(await page.locator("#local-model-setup").innerText(), "Set up Local", "the Local screen should offer an explicit setup guide");
    assert.equal(await page.locator("#complete-model-setup").isDisabled(), true, "Local setup cannot finish before a model is connected");

    await page.click("#local-model-setup");
    await page.waitForSelector("#ollama-recovery-modal:not([hidden])");
  } finally {
    await context.close();
  }
}

async function verifyLocalFailureRequiresTroubleshootChoice() {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem("rh-web-settings", JSON.stringify({
    preset: "custom",
    base_url: "http://localhost:11434/v1",
    model: "llama3.2",
    transcribe_model: "llama3.2",
    session_only: true,
    generation_setup: { version: 1, preset: "custom", base_url: "http://localhost:11434/v1", model: "llama3.2" },
  })));
  try {
    const page = await context.newPage();
    await page.route(LOCAL_CHAT_URL, (route) => route.abort());
    await page.route(LOCAL_VERSION_URL, (route) => route.abort());
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, "# Local failure\n\nThis selection verifies opt-in troubleshooting.");
    await selectText(page, "opt-in troubleshooting");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Explain this");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#web-toast.visible");

    assert.equal(await page.locator("#ollama-recovery-modal").count(), 0, "a Local generation failure must not auto-open diagnostics");
    assert.equal(await page.locator("#web-toast [data-notice-action]").innerText(), "Troubleshoot", "a Local failure should offer an explicit troubleshooting choice");

    await page.click("#web-toast [data-notice-action]");
    await page.waitForSelector("#ollama-recovery-modal:not([hidden])");
  } finally {
    await context.close();
  }
}

async function verifyMobileSetupExperience() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await routeProvider(page);
    await page.route(GITHUB_REPO_API_URL, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stargazers_count: 230 }) }));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.click("#t-project");
    await page.waitForSelector("#project-menu:not([hidden])");
    const projectMenuBounds = await page.locator("#project-menu").evaluate((surface) => {
      const rect = surface.getBoundingClientRect();
      const viewport = window.visualViewport;
      return {
        surface: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        viewport: { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || innerWidth, height: viewport?.height || innerHeight },
      };
    });
    assert(projectMenuBounds.surface.left >= projectMenuBounds.viewport.left && projectMenuBounds.surface.right <= projectMenuBounds.viewport.left + projectMenuBounds.viewport.width, `project menu must fit the mobile viewport horizontally (${JSON.stringify(projectMenuBounds)})`);
    assert(projectMenuBounds.surface.top >= projectMenuBounds.viewport.top && projectMenuBounds.surface.bottom <= projectMenuBounds.viewport.top + projectMenuBounds.viewport.height, `project menu must fit the mobile viewport vertically (${JSON.stringify(projectMenuBounds)})`);
    await page.keyboard.press("Escape");
    await page.waitForSelector("#project-menu[hidden]", { state: "attached" });
    await page.click("#blank-start-setup");
    await page.waitForSelector("#web-settings-popover");

    const initial = await page.locator("#web-settings-popover").evaluate((surface) => {
      const input = document.getElementById("api-key");
      const rect = surface.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      const viewport = window.visualViewport;
      return {
        surface: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        viewport: { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || innerWidth, height: viewport?.height || innerHeight },
        inputFontSize: parseFloat(getComputedStyle(input).fontSize),
        inputHeight: inputRect.height,
        attributes: [input.autocapitalize, input.getAttribute("autocorrect"), input.inputMode, input.enterKeyHint],
      };
    });
    assert(initial.inputFontSize >= 16, `mobile API key text must stay at least 16px to prevent iOS focus zoom (got ${initial.inputFontSize}px)`);
    assert(initial.inputHeight >= 44, `mobile API key field must meet the touch target floor (got ${initial.inputHeight}px)`);
    assert.deepEqual(initial.attributes, ["none", "off", "text", "done"], "mobile key entry should disable destructive text transformations and expose a Done key");
    assert(initial.surface.left >= initial.viewport.left && initial.surface.right <= initial.viewport.left + initial.viewport.width, `setup surface must fit the mobile visual viewport (${JSON.stringify(initial)})`);

    await page.focus("#api-key");
    const pasteAllowed = await page.locator("#api-key").evaluate((input, key) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", key);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
      const allowed = input.dispatchEvent(event);
      if (allowed) {
        input.setRangeText(transfer.getData("text/plain"), input.selectionStart || 0, input.selectionEnd || 0, "end");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: key }));
      }
      return allowed;
    }, MOCK_KEY);
    assert.equal(pasteAllowed, true, "the key field must not cancel native paste");
    await page.waitForSelector("#api-key-status.valid");
    assert.equal(await page.inputValue("#api-key"), MOCK_KEY, "a pasted OpenRouter key must remain intact");

    await page.setViewportSize({ width: 390, height: 430 });
    await page.waitForFunction(() => {
      const surface = document.getElementById("web-settings-popover");
      const viewport = window.visualViewport;
      return surface && viewport && surface.getBoundingClientRect().height <= viewport.height - 15;
    });
    const keyboardSized = await page.locator("#web-settings-popover").evaluate((surface) => {
      const rect = surface.getBoundingClientRect();
      const viewport = window.visualViewport;
      return { top: rect.top, bottom: rect.bottom, viewportTop: viewport.offsetTop, viewportBottom: viewport.offsetTop + viewport.height, scrollable: surface.scrollHeight > surface.clientHeight };
    });
    assert(keyboardSized.top >= keyboardSized.viewportTop && keyboardSized.bottom <= keyboardSized.viewportBottom, `setup surface must remain reachable when the keyboard shrinks the visual viewport (${JSON.stringify(keyboardSized)})`);
    assert.equal(keyboardSized.scrollable, true, "keyboard-sized setup should scroll internally instead of escaping the viewport");
  } finally {
    await context.close();
  }
}

async function verifyThemeBeforeAppRuntime() {
  const cases = [
    { system: "dark", saved: "", expected: "dark", background: "rgb(26, 25, 24)" },
    { system: "light", saved: "", expected: "light", background: "rgb(245, 243, 238)" },
    { system: "light", saved: "dark", expected: "dark", background: "rgb(26, 25, 24)" },
    { system: "dark", saved: "light", expected: "light", background: "rgb(245, 243, 238)" },
  ];
  for (const testCase of cases) {
    const context = await browser.newContext({ colorScheme: testCase.system });
    try {
      await context.addInitScript((saved) => {
        if (saved) localStorage.setItem("rh-theme", saved);
      }, testCase.saved);
      const page = await context.newPage();
      await page.route("**/app.js*", (route) => route.abort());
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const initialTheme = await page.evaluate(() => ({
        attribute: document.documentElement.getAttribute("data-theme"),
        background: getComputedStyle(document.documentElement).backgroundColor,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        appStarted: !!window.__rabbitholeTest,
      }));
      assert.deepEqual(initialTheme, {
        attribute: testCase.expected,
        background: testCase.background,
        colorScheme: testCase.expected,
        appStarted: false,
      }, `theme should be correct before app.js for ${JSON.stringify(testCase)}`);
    } finally {
      await context.close();
    }
  }
}

async function verifyLandingAndComposer() {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const documentKeydowns = new Set();
    const intervals = new Set();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function(type, callback, options) {
      if (this === document && type === "keydown") documentKeydowns.add(callback);
      return add.call(this, type, callback, options);
    };
    EventTarget.prototype.removeEventListener = function(type, callback, options) {
      if (this === document && type === "keydown") documentKeydowns.delete(callback);
      return remove.call(this, type, callback, options);
    };
    const createInterval = window.setInterval;
    const clearInterval = window.clearInterval;
    window.setInterval = (...args) => {
      const id = createInterval(...args);
      intervals.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      intervals.delete(id);
      return clearInterval(id);
    };
    window.__rabbitholeOwnedResourceCounts = () => ({
      documentKeydowns: documentKeydowns.size,
      intervals: intervals.size,
    });
  });
  const page = await context.newPage();
  await page.route(KEY_URL, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { label: "test key" } }) }));
  await page.route(GITHUB_REPO_API_URL, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stargazers_count: 230 }) }));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#blank-start:not([hidden])");
  assert.equal(await page.locator("#composer-modal").isVisible(), false, "first load should wait for model setup instead of opening the composer");
  assert.equal(await page.locator("#blank-start-new").isDisabled(), true, "New Rabbithole should be disabled before setup");
  assert.equal(await page.locator("#blank-start-setup").innerText(), "Set up AI");
  assert.equal(await page.locator(".blank-project-link").count(), 0, "the blank canvas should leave project links to the toolbar menu");
  assert.match(await page.getAttribute("#blank-start-new", "aria-describedby"), /blank-start-status/);
  assert.equal(await page.locator("#blank-start-status").isVisible(), false, "setup guidance should not remain as persistent copy");
  await page.hover("#blank-start-new-wrap");
  assert.deepEqual(await page.locator("#blank-start-status").evaluate((tooltip) => ({
    role: tooltip.getAttribute("role"),
    opacity: getComputedStyle(tooltip).opacity,
    visibility: getComputedStyle(tooltip).visibility,
    transitionDuration: getComputedStyle(tooltip).transitionDuration,
    transitionDelay: getComputedStyle(tooltip).transitionDelay,
  })), { role: "tooltip", opacity: "1", visibility: "visible", transitionDuration: "0s", transitionDelay: "0s" }, "disabled New Rabbithole guidance should appear immediately as a tooltip");
  await page.keyboard.press("N");
  await page.waitForSelector("#web-settings-popover");
  assert.deepEqual(await page.locator(".provider-choice button").allTextContents(), ["OpenRouter", "Local"]);
  assert.equal(await page.getAttribute('[data-provider="openrouter"]', "aria-pressed"), "true", "setup should select OpenRouter by default");
  assert.equal(await page.locator("#api-key").count(), 1, "setup should open the full OpenRouter form immediately");
  assert.equal(await page.locator(".settings-info-trigger").count(), 1);
  assert.equal(await page.locator("#transcribe-model-help").textContent(), "Uses a vision model to turn PDF pages into searchable Markdown. Page images go to OpenRouter.");
  await page.locator(".settings-info-trigger").focus();
  assert.equal(await page.locator("#transcribe-model-help").evaluate((tooltip) => getComputedStyle(tooltip).visibility), "visible", "PDF transcription help should appear immediately for keyboard focus");
  assert.equal(await page.getAttribute('[data-provider="openrouter"]', "aria-pressed"), "true");
  assert.equal(await page.locator("#composer-modal").isVisible(), false, "N should open setup, not the composer, before readiness");
  await page.fill("#api-key", MOCK_KEY);
  await page.waitForSelector("#api-key-status.valid");
  assert.equal(await page.locator("#blank-start-new").isDisabled(), true, "a validated key should not bypass explicit setup completion");
  await page.click("#complete-model-setup");
  await page.waitForSelector("#web-settings-popover", { state: "detached" });
  assert.equal(await page.locator("#blank-start-new").isDisabled(), false);
  assert.equal(await page.locator("#blank-start-setup").innerText(), "Model settings");
  assert.equal(await page.locator("#blank-start-status").isVisible(), false, "setup tooltip should stay hidden once creation is enabled");
  await page.keyboard.press("N");
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
  await page.waitForSelector("#blank-start:not([hidden])");
  await page.keyboard.press("N");
  await page.waitForSelector("#composer-modal:not([hidden])");
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("rail-open")), false, "the sidebar should start closed");
  assert.equal(await page.locator(".web-home").count(), 0, "form-based home page must be gone");
  assert.equal(await page.locator("#tb-tools .toolbar-brand").count(), 1, "browser toolbar should carry the Rabbithole mark");
  const toolbarConformance = await page.locator("#taskbar button").evaluateAll((buttons) => buttons.map((button) => ({
    id: button.id,
    type: button.getAttribute("type"),
    name: button.getAttribute("aria-label") || button.textContent.trim(),
  })));
  assert(toolbarConformance.length > 0, "reader and canvas toolbars should render buttons");
  assert(toolbarConformance.every(({ type }) => type === "button"), `every toolbar button should declare type=button (${JSON.stringify(toolbarConformance)})`);
  assert(toolbarConformance.every(({ name }) => name.length > 0), `every toolbar button should have an accessible name (${JSON.stringify(toolbarConformance)})`);
  const toolbarIconSystem = await page.locator("#taskbar .tool-icon svg").evaluateAll((icons) => icons.map((icon) => ({ width: icon.getAttribute("width"), height: icon.getAttribute("height") })));
  assert(toolbarIconSystem.length >= 8, "toolbar actions should use the shared SVG icon system");
  assert(toolbarIconSystem.every(({ width, height }) => width === "16" && height === "16"), `toolbar glyph boxes should stay 16×16: ${JSON.stringify(toolbarIconSystem)}`);
  assert.equal(await page.locator("#t-new svg path").count(), 2, "New Rabbithole should use a compose silhouette with no plus glyph");
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
  assert.equal(await page.getAttribute("#t-project", "aria-haspopup"), "menu", "the bunny mark should expose the project menu");
  assert.equal(await page.getAttribute("#t-project", "aria-expanded"), "false");
  await page.click("#t-project");
  await page.waitForSelector("#project-menu:not([hidden])");
  await page.waitForFunction(() => document.getElementById("project-github-stars")?.title === "230 GitHub stars");
  assert.equal(await page.getAttribute("#t-project", "aria-expanded"), "true");
  assert.deepEqual(await page.locator("#project-menu [role=menuitem]").allTextContents(), [
    "About Rabbithole↗",
    "Install & self-host↗",
    "GitHub★ 230↗",
  ]);
  assert.equal(await page.getAttribute('#project-menu [href="/about/"]', "target"), "_blank");
  assert.equal(await page.getAttribute('#project-menu [href="/about/#install"]', "target"), "_blank");
  assert.equal(await page.getAttribute("#project-github-stars", "aria-label"), "230 GitHub stars");
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), "About Rabbithole↗");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), "Install & self-host↗", "project menu arrows should move between links");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#project-menu[hidden]", { state: "attached" });
  assert.equal(await page.getAttribute("#t-project", "aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-project", "closing the project menu should restore focus to the bunny mark");
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
  await page.waitForSelector(".node.root .node-badge svg");
  assert.equal(await page.locator(".node.root .node-badge").innerText(), "", "root document badge should use the shared bunny SVG, not emoji");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);

  const second = await createDocument(page, "# Second hole\n\nA second saved document.");
  assert.notEqual(first, second, "creating a second document should open a distinct hole");
  assert.equal(await page.locator(".rail-row").first().getAttribute("data-hole"), second, "a newly created Rabbithole should appear at the top immediately");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, second);

  await page.goto(`${baseUrl}/${first}?path-wins=1`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);

  await page.evaluate((deletedId) => localStorage.setItem("rh-last-hole", deletedId), second);
  await page.goto(`${baseUrl}/?last=second`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, second);
  await ensureRailOpen(page);
  const railIcon = await page.evaluate(() => ({
    active: document.getElementById("t-rail").classList.contains("rail-on"),
    expanded: document.getElementById("t-rail").getAttribute("aria-expanded"),
    fillCount: document.querySelectorAll("#t-rail .rail-fill").length,
    background: getComputedStyle(document.getElementById("t-rail")).backgroundColor,
  }));
  assert.equal(railIcon.expanded, "true");
  assert.equal(railIcon.active, true, "rail toggle should expose its active state while the rail is open");
  assert.equal(railIcon.fillCount, 0, "rail toggle should keep one unchanged icon in both states");
  assert.notEqual(railIcon.background, "rgba(0, 0, 0, 0)", "open rail toggle should be visibly highlighted");
  const zoomGeometry = await page.evaluate(() => {
    const out = document.getElementById("t-zout").getBoundingClientRect();
    const label = document.getElementById("zoom-label").getBoundingClientRect();
    const inside = document.getElementById("t-zin").getBoundingClientRect();
    return { outWidth: out.width, inWidth: inside.width, labelWidth: label.width, leftGap: label.left - out.right, rightGap: inside.left - label.right };
  });
  assert(zoomGeometry.outWidth === 24 && zoomGeometry.inWidth === 24 && zoomGeometry.labelWidth <= 40, `zoom controls should share the toolbar's icon target while staying compact: ${JSON.stringify(zoomGeometry)}`);
  assert(Math.abs(zoomGeometry.leftGap) <= 1 && Math.abs(zoomGeometry.rightGap) <= 1, `zoom controls should keep a tight, even internal rhythm: ${JSON.stringify(zoomGeometry)}`);
  assert.equal(await page.locator(`.rail-row[data-hole="${second}"] .rail-delete`).count(), 1);
  let postBaselineLoads = 0;
  page.on("load", () => { postBaselineLoads += 1; });
  const documentToken = await page.evaluate(() => {
    window.__rabbitholeDocumentToken = crypto.randomUUID();
    return window.__rabbitholeDocumentToken;
  });
  const ownedResourceBaseline = await page.evaluate(() => window.__rabbitholeOwnedResourceCounts());
  await page.locator(`.rail-row[data-hole="${first}"] .rail-open`).click();
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);
  await ensureRailOpen(page);
  await page.locator(`.rail-row[data-hole="${second}"] .rail-open`).click();
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, second);
  await ensureRailOpen(page);
  await page.locator(`.rail-row[data-hole="${first}"] .rail-open`).click();
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);
  await page.goBack({ waitUntil: "commit" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, second);
  await page.goForward({ waitUntil: "commit" });
  await page.waitForFunction((id) => window.__rabbitholeTest?.currentHoleId() === id, first);
  assert.equal(postBaselineLoads, 0, "rail switching must not navigate or reload the document");
  assert.equal(await page.evaluate(() => window.__rabbitholeDocumentToken), documentToken, "rail switching must preserve document identity");
  assert.deepEqual(
    await page.evaluate(() => window.__rabbitholeOwnedResourceCounts()),
    ownedResourceBaseline,
    "repeated switching must retain one stable set of document key handlers and intervals",
  );
  assert.equal(ownedResourceBaseline.intervals, 1, "one hole runtime must own exactly one loading-status interval");
  assert.equal(new URL(page.url()).pathname, `/${first}`);
  assert.equal(await page.locator(".rail-row.current").getAttribute("data-hole"), first);
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
    { id: MOCK_MODEL, name: "Anthropic: Claude Sonnet 5", pricing: { prompt: "0.000003", completion: "0.000015" } },
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
  assert.equal((await delayedPage.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings")))).model, "openai/gpt-5");
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
  assert.equal((await emptyPage.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings")))).model, "vendor/exact-model", "empty catalogs should commit free text");
  await empty.close();

  await verifyLocalComboboxStates(fixture);
}

async function verifySetupReadinessInvalidation() {
  const catalog = { data: [
    { id: MOCK_MODEL, name: "Anthropic: Claude Sonnet 5", pricing: { prompt: "0.000003", completion: "0.000015" } },
    { id: "openai/gpt-5", name: "OpenAI: GPT-5", pricing: { prompt: "0.00000125", completion: "0.00001" } },
  ] };
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await page.route(KEY_URL, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { label: "test key" } }) }));
  await page.route(MODEL_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(catalog) }));
  await page.route(LOCAL_MODEL_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "llama3.2" }] }) }));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert.equal(await page.locator("#blank-start-new").isDisabled(), false, "matching setup fingerprint should unlock creation");

  await page.click("#blank-start-setup");
  await page.click('[data-provider="custom"]');
  assert.equal(await page.locator("#blank-start-new").isDisabled(), true, "changing provider should invalidate completed setup");
  await page.click('[data-provider="openrouter"]');
  assert.equal(await page.locator("#blank-start-new").isDisabled(), false, "returning to the completed provider fingerprint should restore readiness");

  await page.click("#model-select");
  await page.waitForSelector(".model-option[data-value='openai/gpt-5']");
  await page.click(".model-option[data-value='openai/gpt-5']");
  assert.equal(await page.locator("#blank-start-new").isDisabled(), true, "changing model should invalidate completed setup");
  assert.equal(await page.locator("#complete-model-setup").count(), 1, "model invalidation should immediately offer setup completion");
  await page.click("#model-select");
  await page.waitForSelector(`.model-option[data-value='${MOCK_MODEL}']`);
  await page.click(`.model-option[data-value='${MOCK_MODEL}']`);
  assert.equal(await page.locator("#blank-start-new").isDisabled(), false, "restoring the completed model fingerprint should restore readiness");
  await context.close();

  const local = await browser.newContext();
  await local.addInitScript(() => localStorage.setItem("rh-web-settings", JSON.stringify({
    preset: "custom",
    base_url: "http://localhost:11434/v1",
    model: "llama3.2",
    model: "llama3.2",
    session_only: true,
    generation_setup: { version: 1, preset: "custom", base_url: "http://localhost:11434/v1", model: "llama3.2" },
  })));
  const localPage = await local.newPage();
  await localPage.route(LOCAL_MODEL_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "llama3.2" }] }) }));
  await localPage.route(LOCAL_SHOW_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ capabilities: ["completion"] }) }));
  await localPage.goto(baseUrl, { waitUntil: "networkidle" });
  assert.equal(await localPage.locator("#blank-start-new").isDisabled(), false, "matching local endpoint fingerprint should unlock creation");
  await localPage.click("#blank-start-setup");
  await localPage.waitForFunction(() => document.querySelector(".local-model-section .field-hint")?.textContent.includes("installed model"));
  await localPage.locator(".settings-advanced summary").click();
  await localPage.fill("#provider-base", "http://localhost:12345/v1");
  await localPage.press("#provider-base", "Tab");
  assert.equal(await localPage.locator("#blank-start-new").isDisabled(), true, "changing endpoint should invalidate completed setup");
  await local.close();

  console.log("ok web app: provider, endpoint, and model changes invalidate completed setup fingerprints");
}

async function verifyLocalComboboxStates(openRouterFixture) {
  const run = async (handler) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(MODEL_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(openRouterFixture) }));
    await page.route(LOCAL_MODEL_URL, handler);
    await page.route(LOCAL_VERSION_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ version: "0.24.0" }) }));
    await page.route(LOCAL_CHAT_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ choices: [{ message: { content: "ready" } }] }) }));
    await page.route(LOCAL_SHOW_URL, (route) => {
      const model = route.request().postDataJSON()?.model || "";
      return route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ capabilities: model === "llava:7b" ? ["completion", "vision"] : ["completion"] }) });
    });
    await openFreshSettings(page);
    await switchSettingsToLocal(page);
    return { context, page };
  };

  const found = await run((route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "nomic-embed-text:latest" }, { id: "llama3.2" }, { id: "qwen3:8b" }, { id: "llava:7b" }] }) }));
  await found.page.waitForFunction(() => document.querySelector(".local-model-section .field-hint")?.textContent.includes("3 installed models"));
  await found.page.waitForFunction(() => document.querySelector("#transcribe-model-status")?.textContent.includes("1 installed vision model"));
  assert.equal(await found.page.locator("#transcribe-model-help").textContent(), "Uses a vision model to turn PDF pages into searchable Markdown. Page images stay on your local endpoint.");
  assert.equal(await found.page.locator("#transcribe-model").isDisabled(), false);
  assert.equal(await found.page.locator("#transcribe-model").getAttribute("data-value"), "llava:7b");
  assert.equal(await found.page.locator("#ollama-recovery-modal").count(), 0, "a healthy existing Ollama connection must never enter recovery");
  await found.page.click("#local-model");
  assert.equal(await found.page.locator(".model-option[data-value='nomic-embed-text:latest']").count(), 0, "embedding-only Ollama models should not be offered for generation");
  await found.page.waitForSelector(".model-option[data-value='qwen3:8b']");
  assert.equal(await found.page.locator(".model-option[data-value='qwen3:8b'] .model-option-price").innerText(), "", "local model rows should not claim to be free");
  await found.page.click(".model-option[data-value='qwen3:8b']");
  const foundSettings = await found.page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings")));
  assert.equal(foundSettings.model, "qwen3:8b"); assert.equal(foundSettings.transcribe_model, "llava:7b");
  await found.context.close();

  const none = await run((route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [] }) }));
  await none.page.waitForFunction(() => document.querySelector(".local-model-section .field-hint")?.textContent.includes("No installed models"));
  assert.equal(await none.page.locator("#local-model-setup").innerText(), "Set up Local");
  assert.equal(await none.page.locator("#ollama-recovery-modal").count(), 0, "an empty Local install should offer guidance without auto-opening it");
  assert.equal(await none.page.locator("#complete-model-setup").isDisabled(), true);
  assert.equal(await none.page.locator("#transcribe-model").isDisabled(), true);
  assert.match(await none.page.locator("#transcribe-model-status").innerText(), /disabled.*no local models/i);
  await none.context.close();

  let attempts = 0;
  const failed = await run((route) => {
    attempts += 1;
    return route.fulfill(attempts === 1 ? { status: 500, headers: corsHeaders(), body: "failed" }
      : { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "recovered:latest" }] }) });
  });
  await failed.page.waitForSelector("#local-model-setup");
  assert.equal(await failed.page.locator("#ollama-recovery-modal").count(), 0, "a failed Local probe must not auto-open the guide");
  await failed.page.click("#local-model-setup");
  await failed.page.waitForSelector("#ollama-recovery-modal:not([hidden])");
  await failed.page.click("#ollama-primary-action");
  await failed.page.waitForSelector("#ollama-recovery-modal", { state: "detached" });
  assert.equal(attempts, 2);
  assert.equal((await failed.page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings")))).model, "recovered:latest");
  await failed.context.close();

  const free = await run((route) => route.fulfill({ status: 502, headers: corsHeaders(), body: "failed" }));
  await free.page.waitForSelector("#local-model-setup");
  assert.equal(await free.page.locator("#ollama-recovery-modal").count(), 0, "Local connection errors should remain inline until setup is requested");
  await free.page.click("#local-model-setup");
  await free.page.waitForSelector("#ollama-recovery-modal:not([hidden])");
  await free.page.click("#ollama-primary-action");
  await free.page.waitForFunction(() => /Allow rabbithole\.ing|list models/i.test(document.querySelector("#ollama-recovery-content")?.textContent || ""));
  assert.match(await free.page.locator("#ollama-recovery-content").innerText(), /Allow rabbithole\.ing|list models/i, "a local endpoint failure should stay inside the focused Ollama recovery guide");
  assert.deepEqual(await free.page.locator("#ollama-recovery-card").evaluate((dialog) => ({
    role: dialog.getAttribute("role"), modal: dialog.getAttribute("aria-modal"), labelledby: dialog.getAttribute("aria-labelledby"),
  })), { role: "dialog", modal: "true", labelledby: "ollama-recovery-title" }, "Ollama recovery should be a real accessible modal");
  assert.equal(await free.page.locator("#ollama-recovery-card svg, #ollama-recovery-card details, #ollama-recovery-card footer").count(), 0, "recovery should stay concise without diagrams, technical disclosures, or footer copy");
  await free.context.close();

  const absentContext = await browser.newContext();
  await absentContext.addInitScript(() => {
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => ({ state: "granted" }) } });
  });
  const absentPage = await absentContext.newPage();
  await absentPage.route(MODEL_URL, (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(openRouterFixture) }));
  await absentPage.route(LOCAL_MODEL_URL, (route) => route.abort());
  await absentPage.route(LOCAL_VERSION_URL, (route) => route.abort());
  await openFreshSettings(absentPage);
  await absentPage.click('[data-provider="custom"]');
  await absentPage.waitForSelector("#local-model-setup");
  assert.equal(await absentPage.locator("#ollama-recovery-modal").count(), 0, "missing Ollama should first produce an inline setup action");
  await absentPage.click("#local-model-setup");
  await absentPage.waitForSelector("#ollama-recovery-modal:not([hidden])");
  await absentPage.waitForSelector("#ollama-recovery-content >> text=Start Ollama");
  assert.equal(await absentPage.getAttribute(`a[href="https://ollama.com/download/mac"]`, "target"), "_blank", "missing Ollama guidance should offer the official Mac download");
  assert.doesNotMatch(await absentPage.locator("#ollama-recovery-content").innerText(), /OLLAMA_ORIGINS/, "an unreachable endpoint must not receive origin guidance");
  await absentContext.close();
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
  await page.click('[data-provider="custom"]');
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
  await page.click("#blank-start-setup");
  assert.equal(await page.getAttribute("#api-key-toggle", "aria-pressed"), "false");
  await page.click("#api-key-toggle");
  assert.equal(await page.getAttribute("#api-key", "type"), "text", "shared settings should reveal the key");
  assert.equal(await page.getAttribute("#api-key-toggle", "aria-pressed"), "true");
  await page.click("#api-key-toggle");
  assert.equal(await page.getAttribute("#api-key", "type"), "password", "shared settings should hide the key again");
  assert.equal(await page.isChecked("#session-only"), true, "remember-on-this-device should default on");
  await page.fill("#api-key", "sk-ant-fake-key");
  await page.waitForSelector("text=That looks like an Anthropic key");
  await page.fill("#api-key", BAD_KEY);
  await page.waitForSelector(".key-status.invalid");
  await page.fill("#api-key", MOCK_KEY);
  await page.waitForSelector("#api-key-status.valid");
  await page.click("#complete-model-setup");
  await page.waitForSelector("#web-settings-popover", { state: "detached" });
  await page.click("#blank-start-new");
  await page.click("#composer-path-ask");
  await page.fill("#composer-input", "Explain the attention mechanism");
  await page.click("#composer-primary");
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
    const toolbar = document.getElementById("tb-tools").getBoundingClientRect();
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
  assert.match(railDetailGeometry.actionBackground, /linear-gradient/, "overlaid row actions should fade title text cleanly beneath them");
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
  await page.click('.node-btn[aria-label="Collapse document"]');
  assert.equal(await page.locator(".node").first().evaluate((node) => node.classList.contains("collapsed")), true, "real UI mutation should collapse the document immediately");
  const mutationSnapshot = JSON.parse(extractSnapshotPayload(await page.evaluate(() => window.__rabbitholeTest.exportSnapshot())));
  assert.equal(mutationSnapshot.hole.nodes.find((node) => node.id === rootIdWhileLoading)?.collapsed, true,
    `immediate snapshot export must flush the canonical document mutation (root=${rootIdWhileLoading}, nodes=${JSON.stringify(mutationSnapshot.hole.nodes)})`);
  await page.click('.node-btn[aria-label="Larger text"]');
  const mutationPortable = await page.evaluate(() => window.__rabbitholeTest.exportPortable());
  assert.equal(mutationPortable.hole.nodes.find((node) => node.id === rootIdWhileLoading)?.font_scale, 1.1,
    `immediate portable export must flush the canonical document mutation (root=${rootIdWhileLoading}, nodes=${JSON.stringify(mutationPortable.hole.nodes)})`);
  const persistedViewBeforeLiveChange = await page.evaluate(async () => (await window.__rabbitholeTest.readStoredHole()).view_state);
  await page.dblclick(`.node[data-id="${rootIdWhileLoading}"] .node-head`);
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas"));
  const snapshotHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const liveViewSnapshot = JSON.parse(extractSnapshotPayload(snapshotHtml));
  assert.equal(liveViewSnapshot.hole.view_state.mode, "reader", `snapshot must capture the live view at export time (persistedBefore=${JSON.stringify(persistedViewBeforeLiveChange)}, exported=${JSON.stringify(liveViewSnapshot.hole.view_state)})`);
  assert.notDeepEqual(liveViewSnapshot.hole.view_state, persistedViewBeforeLiveChange, `live snapshot view must not reuse the previously persisted view (persistedBefore=${JSON.stringify(persistedViewBeforeLiveChange)}, exported=${JSON.stringify(liveViewSnapshot.hole.view_state)})`);
  assert(!snapshotHtml.includes(MOCK_KEY), "snapshot export must not contain provider key");
  const payloadMatches = [...snapshotHtml.matchAll(/<script type="application\/vnd\.rabbithole\+json" id="rabbithole-portable">([\s\S]*?)<\/script>/g)];
  assert.equal(payloadMatches.length, 1, "snapshot HTML should contain exactly one self-identifying inert portable payload");
  assert.equal(extractSnapshotPayload(snapshotHtml), payloadMatches[0][1], "real snapshot payload extraction should match the shipped extractor");
  const snapshotProjection = JSON.parse(payloadMatches[0][1]);
  const portableProjection = await page.evaluate(() => window.__rabbitholeTest.exportPortable());
  const referencedAssets = new Set(portableProjection.hole.nodes.flatMap((node) =>
    [...String(node.markdown || "").matchAll(/\basset:([a-z0-9][a-z0-9_-]*\.[a-z0-9]+)/gi)].map((match) => match[1])
  ));
  const normalizedPortable = structuredClone(portableProjection);
  normalizedPortable.hole.view_state = snapshotProjection.hole.view_state;
  normalizedPortable.hole.updated_at = snapshotProjection.hole.updated_at;
  for (const node of normalizedPortable.hole.nodes) node.extensions = {};
  normalizedPortable.assets = Object.fromEntries(Object.entries(normalizedPortable.assets).filter(([name]) => referencedAssets.has(name)));
  assert.deepEqual(
    snapshotProjection,
    normalizedPortable,
    "snapshot payload should equal buildRabbitholeExport modulo live view_state, referenced-only assets, and the documented extension-bag stripping normalization"
  );
  assert.equal(snapshotProjection.hole.created_at, portableProjection.hole.created_at, "hole timestamps must survive the portable snapshot projection");
  assert.deepEqual(
    snapshotProjection.hole.nodes.map((node) => node.created_at),
    portableProjection.hole.nodes.map((node) => node.created_at),
    "canonical node timestamps must survive snapshot projection"
  );
  assert(!snapshotHtml.includes('var hydration = {"session_id"'), "new snapshots must not execute an embedded document hydration object");
  assert.match(snapshotHtml, /startPortableSnapshot\(JSON\.parse\(payload\.textContent\)\)/, "bootstrap should derive hydration from inert DOM text");
  const rawJson = JSON.stringify(hole);
  assert(!rawJson.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");

  await page.click("#t-canvas");
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas"));
  await page.click("#t-settings");
  await page.waitForSelector("#web-settings-popover");
  await page.waitForFunction(() => {
    const popover = document.getElementById("web-settings-popover");
    return popover && !popover.getAnimations({ subtree: true }).some((animation) => animation.playState === "running");
  }, null, { timeout: 5000 });
  assert.equal(await page.locator("#save-settings, #web-settings-close").count(), 0, "settings should apply live without save or close buttons");
  assert.equal(await page.locator(".settings-section").first().getAttribute("class"), "settings-section provider-section", "provider should be the first settings decision");
  assert.deepEqual(await page.locator(".provider-choice button").allTextContents(), ["OpenRouter", "Local"]);
  assert.equal(await page.getAttribute('[data-provider="openrouter"]', "aria-pressed"), "true");
  await page.click('[data-provider="custom"]');
  assert.equal(await page.getAttribute('[data-provider="custom"]', "aria-pressed"), "true");
  await page.waitForSelector(".local-model-section .field-hint");
  await page.waitForFunction(() => document.querySelector(".local-model-section .field-hint")?.textContent.includes("installed models"));
  assert.equal(await page.locator("#provider-base").count(), 1, "Local endpoint should remain available in Connection settings");
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
  await page.click("#local-model");
  await page.fill("#local-model-input", "deepseek-r1:7b");
  await page.waitForSelector("#local-model-listbox [role=option][data-value='deepseek-r1:7b']");
  await page.keyboard.press("Enter");
  const localSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings") || "{}"));
  assert.equal(localSettings.model, "deepseek-r1:7b");
  assert.equal(localSettings.model, "deepseek-r1:7b");
  await page.click('[data-provider="openrouter"]');
  assert.equal(await page.inputValue("#api-key"), MOCK_KEY, "returning to a provider should restore only that provider's local key");
  await page.click("#model-select");
  await page.waitForSelector(`.model-option[data-value='${MOCK_MODEL}'] .model-chip`);
  await page.fill("#model-select-input", "gpt");
  assert.equal(
    await page.locator(".model-option[data-value='openai/gpt-5'] .model-option-price").innerText(),
    "$1.25 · $10",
    "picker rows should show per-million pricing from the catalog",
  );
  await page.fill("#model-select-input", "auto router");
  assert.equal(await page.locator(".model-option[data-value='openrouter/auto'] .model-option-price").innerText(), "Varies", "router pricing should explain that the routed model determines cost");
  await page.fill("#model-select-input", "gpt");
  await page.click(".model-option[data-value='openai/gpt-5']");
  await page.waitForSelector("#model-select-listbox", { state: "detached" });
  assert.equal(await page.locator("#model-select-name").innerText(), "GPT-5");
  const pickedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings") || "{}"));
  assert.equal(pickedSettings.model, "openai/gpt-5", "model pick should apply instantly, no save button");
  assert.equal(pickedSettings.model, "openai/gpt-5", "one model choice should drive authoring too");
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
  await sessionPage.click("#blank-start-setup");
  await sessionPage.locator("#session-only").setChecked(false, { force: true });
  await sessionPage.fill("#api-key", MOCK_KEY);
  await sessionPage.waitForSelector("#api-key-status.valid");
  await sessionPage.click("#complete-model-setup");
  await sessionPage.waitForSelector("#web-settings-popover", { state: "detached" });
  await sessionPage.click("#blank-start-new");
  await sessionPage.click("#composer-path-ask");
  await sessionPage.fill("#composer-input", "Check session-only storage");
  await sessionPage.click("#composer-primary");
  await waitForCanvasText(sessionPage, "This root verifies session-only storage");
  assert.equal(await sessionPage.evaluate(() => JSON.parse(localStorage.getItem("rh-web-api-keys") || "{}").openrouter), undefined, "opting out of remember must keep the provider-key map clean");
  await sessionContext.close();
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
