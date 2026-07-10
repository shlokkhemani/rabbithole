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
  await verifyLandingAndComposer();
  await verifyAskKeyUxAndRail();
  await verifyCanvasBranching();
  console.log("stage10 web verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function verifyLandingAndComposer() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#composer-modal:not([hidden])");
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("rail-open")), false, "sidebar should be closed by default");
  assert.equal(await page.getAttribute("#t-rail", "aria-expanded"), "false", "sidebar toggle should expose its default collapsed state");
  await page.evaluate(() => localStorage.setItem("rh-rail-open", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#composer-modal:not([hidden])");
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("rail-open")), false, "legacy sidebar state should not override the calm default");
  assert.equal(await page.locator(".web-home").count(), 0, "form-based home page must be gone");
  assert.equal(await page.locator("#toolbar .toolbar-brand").count(), 1, "browser toolbar should carry the Rabbithole mark");
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
  const noHoles = await page.evaluate(() => window.__rhWebApp.store.listHoles());
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
  await page.click("#blank-start-new");
  await page.waitForSelector("#composer-modal:not([hidden])");
  await page.waitForFunction(() => document.activeElement?.id === "composer-card");
  assert.equal(await page.locator(".composer-path:focus").count(), 0, "no starting path should look preselected when the composer opens");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  await page.waitForSelector("#blank-start:not([hidden])");

  const first = await createDocument(page, "# First hole\n\nEuler identity $e^{i\\pi}+1=0$.");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, first);

  const second = await createDocument(page, "# Second hole\n\nA second saved document.");
  assert.notEqual(first, second, "creating a second document should open a distinct hole");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, second);

  await page.goto(`${baseUrl}/?hash-wins=1#hole=${encodeURIComponent(first)}`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, first);

  await page.evaluate((deletedId) => localStorage.setItem("rh-last-hole", deletedId), second);
  await page.goto(`${baseUrl}/?last=second`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, second);
  await ensureRailOpen(page);
  const railIcon = await page.evaluate(() => ({
    filled: document.getElementById("t-rail").classList.contains("rail-on"),
    expanded: document.getElementById("t-rail").getAttribute("aria-expanded"),
  }));
  assert.equal(railIcon.expanded, "true");
  assert.equal(railIcon.filled, true, "rail toggle icon should switch to its filled state while the rail is open");
  assert.equal(await page.locator(`.rail-row[data-hole="${second}"] .rail-delete`).count(), 1);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 5000 }).catch(() => null),
    page.evaluate((id) => window.__rhWebApp.deleteHoleForTest(id), second),
  ]);
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, first);
  await page.evaluate((deletedId) => localStorage.setItem("rh-last-hole", deletedId), second);
  await page.goto(`${baseUrl}/?last=deleted`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, first);

  await context.close();
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
  const hole = await page.evaluate(async () => window.__rhWebApp.readRawHole());
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
  const snapshotHtml = await page.evaluate(() => window.__rhWebApp.exportSnapshotForTest());
  assert(!snapshotHtml.includes(MOCK_KEY), "snapshot export must not contain provider key");
  assert(
    snapshotHtml.includes("<style>\n\n</style>"),
    "known defect tripwire (C4): web-exported snapshots serialize the page's inline <style>, which the web build does not emit, so they ship unstyled; the styled export path lives in the canvas host. Phase 7's snapshot boundary makes web exports styled and self-contained — retire this tripwire there and recalibrate the snapshot byte budgets."
  );
  const rawJson = JSON.stringify(hole);
  assert(!rawJson.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");

  await page.click("#t-settings");
  await page.waitForSelector("#web-settings-modal:not([hidden])");
  assert.equal(await page.locator("#save-settings, #web-settings-close").count(), 0, "settings should apply live without save or close buttons");
  assert.equal(await page.locator(".settings-section").first().getAttribute("class"), "settings-section provider-section", "provider should be the first settings decision");
  assert.equal(await page.locator("#provider-select").evaluate((select) => select.tagName), "SELECT", "two providers should use the platform dropdown");
  assert.deepEqual(await page.locator("#provider-select option").allTextContents(), ["OpenRouter", "Local"]);
  await page.selectOption("#provider-select", "custom");
  const localDropdownDetail = await page.evaluate(() => {
    const select = document.getElementById("provider-select");
    const icon = select.closest(".native-select-wrap").querySelector("svg");
    const selectRect = select.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const styles = getComputedStyle(select);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = styles.font;
    const textWidth = context.measureText(select.selectedOptions[0].textContent).width;
    return {
      width: selectRect.width,
      textToArrow: iconRect.left - (selectRect.left + parseFloat(styles.paddingLeft) + textWidth),
      colorScheme: styles.colorScheme,
      expectedScheme: document.documentElement.getAttribute("data-theme"),
      optionBackground: getComputedStyle(select.options[0]).backgroundColor,
    };
  });
  assert(localDropdownDetail.width < 90, `Local provider control should size to its label, got ${localDropdownDetail.width}px`);
  assert(localDropdownDetail.textToArrow >= 3 && localDropdownDetail.textToArrow <= 9,
    `Local label-to-arrow spacing should stay intentional, got ${localDropdownDetail.textToArrow.toFixed(2)}px`);
  assert.equal(localDropdownDetail.colorScheme, localDropdownDetail.expectedScheme, "provider menu should follow the active theme");
  assert.notEqual(localDropdownDetail.optionBackground, "rgba(0, 0, 0, 0)", "provider options should not fall back to a white/transparent system menu");
  assert.equal(await page.locator(".endpoint-section #provider-base").count(), 1, "Local should surface its endpoint immediately");
  assert.equal(await page.locator("#api-key").count(), 0, "Local should not show irrelevant credential UI");
  assert.equal(await page.locator("#model-select").count(), 0, "Local should not use the global OpenRouter model picker");
  assert.equal(await page.locator("#local-model").count(), 1, "Local should expose a plain model id field");
  await page.fill("#local-model", "deepseek-r1:7b");
  await page.press("#local-model", "Tab");
  const localSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings") || "{}"));
  assert.equal(localSettings.answer_model, "deepseek-r1:7b");
  assert.equal(localSettings.author_model, "deepseek-r1:7b");
  await page.selectOption("#provider-select", "openrouter");
  assert.equal(await page.inputValue("#api-key"), MOCK_KEY, "returning to a provider should restore only that provider's local key");
  await page.click("#model-select");
  await page.waitForSelector(".model-option[data-id='anthropic/claude-sonnet-5'] .model-chip");
  await page.fill("#model-search", "gpt");
  assert.equal(
    await page.locator(".model-option[data-id='openai/gpt-5'] .model-option-price").innerText(),
    "$1.25 · $10",
    "picker rows should show per-million pricing from the catalog",
  );
  await page.click(".model-option[data-id='openai/gpt-5']");
  await page.waitForSelector("#model-picker", { state: "hidden" });
  assert.equal(await page.locator("#model-select-name").innerText(), "GPT-5");
  const pickedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem("rh-web-settings") || "{}"));
  assert.equal(pickedSettings.answer_model, "openai/gpt-5", "model pick should apply instantly, no save button");
  assert.equal(pickedSettings.author_model, "openai/gpt-5", "one model choice should drive authoring too");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#web-settings-modal[hidden]", { state: "attached" });

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
    const toolbar = document.getElementById("toolbar").getBoundingClientRect();
    const dialog = document.querySelector(".web-settings-dialog").getBoundingClientRect();
    return {
      rightAlignment: Math.abs(dialog.right - button.right),
      leftEdge: dialog.left,
      toolbarGap: dialog.top - toolbar.bottom,
      withinViewport: dialog.left >= 0 && dialog.right <= innerWidth,
    };
  });
  assert(settingsPlacement.rightAlignment < 1 || Math.abs(settingsPlacement.leftEdge - 14) < 1,
    `settings panel should anchor to its gear or the safe page edge, right offset ${settingsPlacement.rightAlignment.toFixed(2)}px, left ${settingsPlacement.leftEdge.toFixed(2)}px`);
  assert(Math.abs(settingsPlacement.toolbarGap - 14) < 1, `settings panel should share the 14px toolbar rhythm, got ${settingsPlacement.toolbarGap.toFixed(2)}px`);
  assert.equal(settingsPlacement.withinViewport, true, "settings panel should stay within the viewport");
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
  await page.fill("#api-key", MOCK_KEY);
  await page.press("#api-key", "Enter");
  await page.waitForSelector("#api-key-status.valid");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#web-settings-modal[hidden]", { state: "attached" });

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

  await page.click("#t-share");
  await page.waitForSelector("#sharemenu.visible");
  await page.waitForTimeout(130);
  const shareStandard = await page.evaluate(() => {
    const menu = document.getElementById("sharemenu");
    const anchor = document.getElementById("t-share").getBoundingClientRect();
    const toolbar = document.getElementById("toolbar").getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const styles = getComputedStyle(menu);
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
      toolbarGap: menuRect.top - toolbar.bottom,
      shellPadding: styles.padding,
      itemPaddingTop: itemStyles.paddingTop,
      itemPaddingBottom: itemStyles.paddingBottom,
      expanded: document.getElementById("t-share").getAttribute("aria-expanded"),
      menuItems: menu.querySelectorAll('[role="menuitem"]').length,
    };
  });
  assert.deepEqual(shareStandard.surface, settingsSurfaceStandard, "Share and Settings should use the same popover surface standard");
  assert(shareStandard.rightAlignment < 1, `Share should anchor to its trigger, off by ${shareStandard.rightAlignment.toFixed(2)}px`);
  assert(Math.abs(shareStandard.toolbarGap - 14) < 1, `Share should use the 14px toolbar rhythm, got ${shareStandard.toolbarGap.toFixed(2)}px`);
  assert.equal(shareStandard.shellPadding, "6px");
  assert.equal(shareStandard.itemPaddingTop, "8px");
  assert.equal(shareStandard.itemPaddingBottom, "8px");
  assert.equal(shareStandard.expanded, "true");
  assert.equal(shareStandard.menuItems, 5);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#sharemenu:not(.visible)", { state: "attached" });
  assert.equal(await page.getAttribute("#t-share", "aria-expanded"), "false");

  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Why does this matter?");
  await page.click("#ask-go");
  await waitForCanvasText(page, "Euler identity connects rotation");
  assert.equal(providerCalls, 1);

  await page.click("#t-reader");
  await page.fill("#composer-text", "Go one layer deeper.");
  await page.click("#composer-send");
  await page.locator("#reader-main", { hasText: "Second branch explains the geometric view" }).waitFor();
  assert.equal(providerCalls, 2);

  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rhWebApp && !!document.querySelector(".node .doc-content[data-node-id]"));
  const reloadedRaw = await page.evaluate(() => window.__rhWebApp.readRawHole().then((hole) => JSON.stringify(hole)));
  assert(reloadedRaw.includes("Euler identity connects rotation"));
  assert(reloadedRaw.includes("Second branch explains the geometric view"));
  assert(!reloadedRaw.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");
  assert(!page.url().includes(MOCK_KEY), "URL must not contain provider key");

  const external = requests.filter((url) => !url.startsWith(baseUrl));
  assert(external.length > 0, "provider and key validation should have been called");
  assert(external.every((url) => url === PROVIDER_URL || url === KEY_URL || url === MODEL_URL), `unexpected external request(s): ${external.join(", ")}`);
  await context.close();
}

async function routeProvider(page, { keyStatus, streams, onProviderCall = null, providerDelayMs = 0 }) {
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
  const previous = await page.evaluate(() => window.__rhWebApp?.currentHoleId?.() || "");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 2500 }).catch(() => null),
    page.evaluate((value) => window.__rhWebApp.createDocumentForTest(value), markdown).catch(() => null),
  ]);
  await page.waitForFunction((oldId) => {
    const id = window.__rhWebApp?.currentHoleId?.();
    return id && id !== oldId;
  }, previous);
  await page.waitForSelector(".node .doc-content[data-node-id]");
  return page.evaluate(() => window.__rhWebApp.currentHoleId());
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
