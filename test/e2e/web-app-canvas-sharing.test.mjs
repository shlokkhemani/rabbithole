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

const hostilePayloadValue = { text: "</script><>&\u2028\u2029" };
const hostilePayloadJson = serializeForInlineScript(hostilePayloadValue);
assert(!/[<>&\u2028\u2029]/u.test(hostilePayloadJson), "portable payload escaping must neutralize HTML delimiters and JavaScript line separators");
assert.deepEqual(JSON.parse(hostilePayloadJson), hostilePayloadValue, "escaped inert payload text must JSON.parse byte-exactly");

const app = await bootWebApp();
const { browser, baseUrl } = app;
try {
  await verifyCanvasBranching();
  console.log("web app verification passed");
} finally {
  await app.close();
}

async function verifyCanvasBranching() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const requests = [];
  let providerCalls = 0;
  page.on("request", (request) => requests.push(request.url()));
  await routeProvider(page, {
    keyStatus: () => 200,
    onProviderCall: () => { providerCalls += 1; },
    streams: [
      [
        "TITLE: Card follow-up\n",
        "Card drawer keyboard submission created this follow-up child.",
      ],
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
    providerDelayMs: 220,
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
  assert.match(await page.locator("#settings-panel").innerText(), /Connected|Stored only in this browser/i);
  assert.equal(await page.locator("#model-select").count(), 1, "settings should expose one model picker");
  assert.equal(await page.locator(".settings-advanced").count(), 0, "OpenRouter settings should not duplicate model choices or expose link-relay plumbing");
  assert.deepEqual(await page.evaluate(() => ["api-key"].map((id) => {
    const input = document.getElementById(id);
    const label = document.querySelector(`label[for="${id}"]`);
    const described = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    return { id, named: !!label?.textContent.trim(), described: described.length > 0 && described.every((ref) => !!document.getElementById(ref)) };
  })), [
    { id: "api-key", named: true, described: true },
  ], "OpenRouter key should have a label and connected status");
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

  const rootDrawer = page.locator(".node.root .nc-handle");
  const rootDrawerId = await rootDrawer.getAttribute("aria-controls");
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "false", "card drawer handle should expose its closed disclosure state");
  assert(rootDrawerId, "card drawer handle should reference its input region");
  assert.equal(await page.locator(`#${rootDrawerId}`).count(), 1, "card drawer aria-controls should resolve to the input region");
  const canvasModeBeforeDrawer = await page.locator("body").getAttribute("class");
  await rootDrawer.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".node.root .nc-inner textarea"));
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "true", "opening a card drawer should expand its disclosure state");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.matches(".node.root .nc-handle"));
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "false", "Escape should close the card drawer disclosure");
  assert.equal(await page.locator("body").getAttribute("class"), canvasModeBeforeDrawer, "drawer Escape should not change the canvas mode class");
  await rootDrawer.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".node.root .nc-inner textarea"));
  await page.evaluate(() => document.querySelector(".node.root").matches = () => false);
  await page.focus("#t-reader");
  await page.waitForFunction(() => !document.querySelector(".node.root .node-composer").classList.contains("open"));
  await page.evaluate(() => delete document.querySelector(".node.root").matches);
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "false", "empty-draft blur should close an unhovered card drawer");

  await rootDrawer.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".node.root .nc-inner textarea"));
  await page.keyboard.type("Create a card follow-up child");
  await page.keyboard.press("Enter");
  await waitForCanvasText(page, "Card drawer keyboard submission created this follow-up child");
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "false", "submitting a card follow-up should close its drawer");
  assert.equal(providerCalls, 1, "card keyboard submission should use the follow-up request path once");

  const childCard = page.locator(".node:not(.root)", { hasText: "Card drawer keyboard submission" }).first();
  const cardControls = await childCard.locator(".node-head .node-btn").evaluateAll((buttons) => buttons.map((button) => ({
    type: button.getAttribute("type"),
    name: button.getAttribute("aria-label") || button.textContent.trim(),
  })));
  assert.deepEqual(cardControls, [
    { type: "button", name: "Remove this branch" },
    { type: "button", name: "Smaller text" },
    { type: "button", name: "Larger text" },
    { type: "button", name: "Collapse document" },
    { type: "button", name: "Expand document" },
  ], "all five card controls should use Button kit semantics and accessible names");
  const childPosition = await childCard.evaluate((card) => ({ left: card.style.left, top: card.style.top }));
  const smallerBox = await childCard.locator('.node-btn[aria-label="Smaller text"]').boundingBox();
  await page.mouse.move(smallerBox.x + smallerBox.width / 2, smallerBox.y + smallerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(smallerBox.x + 50, smallerBox.y + 40);
  await page.mouse.up();
  assert.deepEqual(await childCard.evaluate((card) => ({ left: card.style.left, top: card.style.top })), childPosition, "card controls should remain excluded from card dragging");
  await childCard.locator(".node-btn.danger").click();
  await page.waitForSelector("#confirm.visible");
  await page.click("#cf-remove");
  await childCard.waitFor({ state: "detached" });

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
  assert(frozenHtml.includes("#toolbar"), "web-exported snapshots should embed durable canvas styling");
  assert(frozenHtml.includes(".katex"), "web-exported snapshots should embed self-contained KaTeX styling");
  assert(!frozenHtml.includes(".web-rail"), "web-exported snapshots must exclude web-only rail styling");
  const frozenPage = await context.newPage();
  await frozenPage.setContent(frozenHtml, { waitUntil: "load" });
  const frozenStyles = await frozenPage.evaluate(() => ({
    surfaceGap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-gap")),
    toolbarPosition: getComputedStyle(document.getElementById("toolbar")).position,
  }));
  assert(frozenStyles.surfaceGap > 0, "web-exported snapshots should preserve positive shared surface spacing");
  assert.equal(frozenStyles.toolbarPosition, "fixed", "web-exported snapshots should apply structural toolbar styling");
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

  const frozenPayloadMatch = frozenHtml.match(/<script type="application\/vnd\.rabbithole\+json" id="rabbithole-portable">([\s\S]*?)<\/script>/);
  assert.equal(extractSnapshotPayload(frozenHtml), frozenPayloadMatch[1], "second real snapshot payload extraction should match the shipped extractor");
  const legacyProjection = JSON.parse(frozenPayloadMatch[1]);
  const legacyHole = legacyProjection.hole;
  const legacyHydration = {
    session_id: `legacy-${legacyHole.hole_id}`,
    hole_id: legacyHole.hole_id,
    title: legacyHole.title,
    root_id: legacyHole.root_id,
    last_event_id: 0,
    agent_attached: false,
    view_state: legacyHole.view_state,
    frozen: true,
    asset_data: {},
    nodes: legacyHole.nodes,
  };
  const legacyHtml = frozenHtml
    .replace(/<script type="application\/vnd\.rabbithole\+json" id="rabbithole-portable">[\s\S]*?<\/script>\n/, "")
    .replace(/  var payload = document\.getElementById\("rabbithole-portable"\);\n  RabbitholeFrozenClient\.startPortableSnapshot\(JSON\.parse\(payload\.textContent\)\);/, `  RabbitholeFrozenClient.startRabbithole(${JSON.stringify(legacyHydration)});`);
  const legacyPage = await context.newPage();
  await legacyPage.setContent(legacyHtml, { waitUntil: "load" });
  assert.equal(await legacyPage.locator(".doc-content[data-node-id]").count() > 0, true, "legacy direct-hydration snapshots should still boot the frozen client");
  await legacyPage.close();

  await page.evaluate(() => {
    window.__askFocusBefore = document.activeElement;
    window.__askRangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function() {
      return { left: -24, right: 76, top: innerHeight - 24, bottom: innerHeight - 4, width: 100, height: 20, x: -24, y: innerHeight - 24 };
    };
  });
  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => document.activeElement === window.__askFocusBefore), true, "opening the selection bar must not steal document focus");
  const askEdge = await page.evaluate(() => {
    const anchor = window.getSelection().getRangeAt(0).getBoundingClientRect();
    const bar = document.getElementById("ask").getBoundingClientRect();
    const styles = getComputedStyle(document.documentElement);
    return { placement: document.getElementById("ask").dataset.placement, gap: anchor.top - bar.bottom,
      tokenGap: parseFloat(styles.getPropertyValue("--surface-gap")), left: bar.left,
      edge: parseFloat(styles.getPropertyValue("--surface-edge")), right: bar.right, width: innerWidth };
  });
  assert.equal(askEdge.placement, "top-start", "a virtual selection anchor should flip above at the viewport bottom");
  assert(Math.abs(askEdge.gap - askEdge.tokenGap) < 1, `a flipped virtual selection anchor should preserve the token gap, got ${askEdge.gap.toFixed(2)}px vs ${askEdge.tokenGap.toFixed(2)}px`);
  assert(askEdge.left >= askEdge.edge - 1 && askEdge.right <= askEdge.width - askEdge.edge + 1, "the selection bar should clamp inside token viewport edges");
  await page.evaluate(() => { Range.prototype.getBoundingClientRect = window.__askRangeRect; delete window.__askRangeRect; });
  await page.keyboard.press("Escape");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  await page.waitForFunction(() => document.activeElement?.matches(".node.root"));
  assert.equal(await page.evaluate(() => window.getSelection().toString()), "Euler identity", "selection-bar Escape should preserve the live text selection");
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true, "selection-bar Escape must not leak to the canvas reader shortcut");

  await page.evaluate(() => { window.__askFocusBefore = document.activeElement; });
  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  assert.equal(await page.evaluate(() => document.activeElement === window.__askFocusBefore), true, "reopening the selection bar should retain selection-context focus");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.activeElement?.id === "ask-text");
  await page.keyboard.type("Why does this matter?");
  await page.keyboard.press("Enter");
  await page.click("#t-reader");
  await page.waitForSelector('.side-item.pending[role="link"]');
  const pendingSidebarContract = await page.locator('.side-item.pending[role="link"]').evaluate((tile) => {
    tile.__s9Identity = "pending-stream-tile";
    return { id: tile.dataset.child, tabIndex: tile.tabIndex, name: tile.getAttribute("aria-label") };
  });
  assert.equal(pendingSidebarContract.tabIndex, 0, "pending sidebar branches should be tabbable links");
  assert.match(pendingSidebarContract.name, /^Open branch: .+, pending$/, "pending sidebar links should name the branch and pending state");
  const streamedSidebarTile = page.locator(`.side-item[data-child="${pendingSidebarContract.id}"][role="link"]`);
  await page.waitForFunction((id) => !document.querySelector(`.side-item[data-child="${id}"]`)?.classList.contains("pending"), pendingSidebarContract.id);
  assert.equal(await streamedSidebarTile.evaluate((tile) => tile.__s9Identity),
    "pending-stream-tile", "stream updates should patch the pending sidebar tile without replacing it");
  assert.equal(await page.locator('.side-item[role="link"] .si-live').count(), 0, "settling a streamed sidebar branch should remove its one live pane");
  assert.equal(providerCalls, 2);

  const sidebarTile = streamedSidebarTile;
  assert.deepEqual(await sidebarTile.evaluate((tile) => ({ role: tile.getAttribute("role"), tabIndex: tile.tabIndex, name: tile.getAttribute("aria-label") })),
    { role: "link", tabIndex: 0, name: "Open branch: Why does this matter?, new" }, "settled sidebar tiles should expose named link semantics and new state");
  await sidebarTile.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('.crumb[aria-current="page"]')?.textContent === "Euler branch");

  const breadcrumbContract = await page.locator("#breadcrumb").evaluate((nav) => {
    const crumbs = [...nav.querySelectorAll(".crumb")];
    crumbs[0].__s9Identity = "root-crumb";
    crumbs[1].__s9Identity = "child-crumb";
    return {
      tag: nav.tagName,
      label: nav.getAttribute("aria-label"),
      prior: { role: crumbs[0].getAttribute("role"), tabIndex: crumbs[0].tabIndex },
      current: { current: crumbs[1].getAttribute("aria-current"), tabIndex: crumbs[1].getAttribute("tabindex") },
    };
  });
  assert.deepEqual(breadcrumbContract, {
    tag: "NAV", label: "Breadcrumb", prior: { role: "link", tabIndex: 0 }, current: { current: "page", tabIndex: null },
  }, "breadcrumbs should expose a landmark, linked ancestors, and a non-focusable current page");
  await page.locator('.crumb[role="link"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('.crumb[aria-current="page"]')?.textContent === "Web Smoke");
  assert.equal(await page.locator('.crumb[aria-current="page"]').evaluate((crumb) => crumb.__s9Identity), "root-crumb", "breadcrumb nodes should be reused when their state changes");
  assert.equal(await streamedSidebarTile.evaluate((tile) => tile.__s9Identity),
    "pending-stream-tile", "sidebar nodes should be reused after navigating away and back");
  await streamedSidebarTile.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('.crumb[aria-current="page"]')?.textContent === "Euler branch");
  assert.equal(await page.locator('.crumb[aria-current="page"]').evaluate((crumb) => crumb.__s9Identity), "child-crumb", "breadcrumb child identity should survive lineage removal and restoration");

  const contextStrip = page.locator('.reader-context[role="link"]');
  assert.deepEqual(await contextStrip.evaluate((strip) => ({ tabIndex: strip.tabIndex, name: strip.getAttribute("aria-label") })),
    { tabIndex: 0, name: "See this in its original context" }, "linked reader context should be a named tabbable link");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    window.__s9OriginFlashObserver = new MutationObserver(() => {
      if (document.querySelector('mark[data-child].mark-flash')) window.__s9OriginFlashed = true;
    });
    window.__s9OriginFlashObserver.observe(document.getElementById("reader-main"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  await contextStrip.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('.crumb[aria-current="page"]')?.textContent === "Web Smoke");
  await page.waitForFunction(() => window.__s9OriginFlashed === true);
  assert.equal(await page.evaluate(() => { window.__s9OriginFlashObserver.disconnect(); return window.__s9OriginFlashed; }), true,
    "reader-context Enter should jump to and flash the origin");
  await page.click("#r-canvas");
  await waitForCanvasText(page, "Euler identity connects rotation");

  const branchMark = page.locator('.node mark[data-child].mark-ready').first();
  assert.deepEqual(await branchMark.evaluate((mark) => ({ tabIndex: mark.tabIndex, role: mark.getAttribute("role"), name: mark.getAttribute("aria-label") })),
    { tabIndex: 0, role: "link", name: "Open branch: Euler branch" }, "branch marks should expose keyboard navigation semantics and the branch title");
  await branchMark.hover();
  await page.waitForSelector("#peek.visible");
  assert.equal(await page.locator("#peek [data-peek-title]").innerText(), "Euler branch");
  await page.mouse.move(2, 2);
  await page.waitForSelector("#peek:not(.visible)", { state: "attached" });

  await page.focus("#r-theme");
  const visitedTabStops = new Set([await page.evaluate(() => {
    const start = document.querySelector("#r-theme");
    return start?.id || `${start?.tagName}:${[...document.querySelectorAll(start?.tagName || "*")].indexOf(start)}`;
  })]);
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const tabStop = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        isBranchMark: active?.matches('mark[data-child]') || false,
        key: active?.id || `${active?.tagName}:${[...document.querySelectorAll(active?.tagName || "*")].indexOf(active)}`,
      };
    });
    if (tabStop.isBranchMark) break;
    if (visitedTabStops.has(tabStop.key)) break;
    visitedTabStops.add(tabStop.key);
  }
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
    const mark = document.querySelector('.node mark[data-child].mark-ready');
    mark.__probeRect = mark.getBoundingClientRect;
    mark.getBoundingClientRect = () => ({ left: 4, right: 84, top: innerHeight - 22, bottom: innerHeight - 2, width: 80, height: 20, x: 4, y: innerHeight - 22 });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(50);
  const peekEdge = await page.evaluate(() => {
    const mark = document.querySelector('.node mark[data-child].mark-ready').getBoundingClientRect();
    const peek = document.getElementById("peek").getBoundingClientRect();
    const edge = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-edge"));
    return { placement: document.getElementById("peek").dataset.placement, gap: mark.top - peek.bottom,
      tokenGap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-gap")), left: peek.left, edge, right: peek.right, width: innerWidth };
  });
  assert.equal(peekEdge.placement, "top-start", "peek should flip above a mark at the viewport bottom");
  assert(Math.abs(peekEdge.gap - peekEdge.tokenGap) < 1, "flipped peek should preserve the token gap");
  assert(peekEdge.left >= peekEdge.edge - 1 && peekEdge.right <= peekEdge.width - peekEdge.edge + 1, "peek should clamp inside token viewport edges");
  await page.evaluate(() => {
    const mark = document.querySelector('.node mark[data-child].mark-ready');
    mark.getBoundingClientRect = mark.__probeRect; delete mark.__probeRect;
  });
  await branchMark.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("body:not(.mode-canvas)");
  await page.locator("#reader-main", { hasText: "Euler identity connects rotation" }).waitFor();
  assert.equal(await page.locator("#peek.visible").count(), 0, "Enter on a mark should open its branch and dismiss peek");

  if (!await page.evaluate(() => document.body.classList.contains("mode-canvas"))) await page.click("#r-canvas");
  const childDelete = page.locator('.node:not(.root)', { hasText: "Euler identity connects rotation" }).locator('.node-btn.danger');
  await childDelete.focus();
  await page.evaluate(() => { window.__deleteTrigger = document.activeElement; });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#confirm.visible");
  await page.waitForFunction(() => document.activeElement?.id === "cf-keep");
  await page.waitForTimeout(140);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "cf-keep", "delete confirmation should initially focus Keep");
  const confirmAnchor = await page.evaluate(() => {
    const trigger = window.__deleteTrigger.getBoundingClientRect();
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
  await branchFrozenPage.click("#t-reader");
  assert.deepEqual(await branchFrozenPage.locator("#breadcrumb").evaluate((nav) => ({ tag: nav.tagName, label: nav.getAttribute("aria-label") })),
    { tag: "NAV", label: "Breadcrumb" }, "frozen reader should preserve breadcrumb landmark semantics");
  await branchFrozenPage.locator('.crumb[role="link"]').focus();
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => document.querySelectorAll("#breadcrumb .crumb").length === 1);
  const frozenSidebar = branchFrozenPage.locator('.side-item[role="link"]').first();
  assert.equal(await frozenSidebar.evaluate((tile) => tile.tabIndex), 0,
    "frozen sidebar branches should remain keyboard navigable");
  await frozenSidebar.focus();
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => document.querySelectorAll("#breadcrumb .crumb").length > 1);
  await branchFrozenPage.locator('.crumb[role="link"]').focus();
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => document.querySelectorAll("#breadcrumb .crumb").length === 1);
  await branchFrozenPage.click("#r-canvas");
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
  assert.equal(providerCalls, 3);

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

