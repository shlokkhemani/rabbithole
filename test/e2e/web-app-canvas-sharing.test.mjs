import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { webkit } from "playwright";
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
const mobileWebKit = await webkit.launch();
try {
  await verifyMobileCanvasNavigation(browser, "chromium");
  await verifyMobileCanvasNavigation(mobileWebKit, "webkit");
  await verifyDesktopReaderLayout(browser);
  await verifyMobileSelectionSurface(browser, "chromium");
  await verifyMobileSelectionSurface(mobileWebKit, "webkit");
  await verifyCanvasBranching();
  console.log("web app verification passed");
} finally {
  await mobileWebKit.close();
  await app.close();
}

async function verifyMobileCanvasNavigation(browserEngine, engineName) {
  const context = await browserEngine.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await routeProvider(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const paragraphs = Array.from({ length: 42 }, (_, index) =>
      `Paragraph ${index + 1}. Mobile canvas navigation must keep card reading independent from camera movement.`).join("\n\n");
    await createDocument(page, `# Mobile canvas navigation\n\n${paragraphs}`);
    await page.waitForFunction(() => {
      const body = document.querySelector(".node.root .node-body");
      return document.body.classList.contains("mode-canvas")
        && body && body.scrollHeight > body.clientHeight + 100
        && getComputedStyle(document.getElementById("world")).transform !== "none";
    });

    const toolbar = await page.locator("#taskbar").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const controls = ["t-zout", "zoom-label", "t-zin"].map((id) => {
        const item = document.getElementById(id).getBoundingClientRect();
        return { id, width: item.width, height: item.height, right: item.right };
      });
      return { left: rect.left, right: rect.right, width: rect.width, viewportWidth: innerWidth,
        scrollable: element.scrollWidth > element.clientWidth, controls };
    });
    assert(toolbar.left >= 0 && toolbar.right <= toolbar.viewportWidth,
      `${engineName}: mobile taskbar must stay inside the viewport (${JSON.stringify(toolbar)})`);
    for (const control of toolbar.controls) {
      assert(control.width >= 44 && control.height >= 44,
        `${engineName}: ${control.id} must be a reliable mobile touch target (${JSON.stringify(control)})`);
    }
    // Start from a known scale: initial framing may still be settling on a
    // resource-constrained mobile engine, and zoom-in is intentionally a no-op
    // at the 250% ceiling.
    await page.click("#zoom-label");
    await page.waitForFunction(() => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(document.getElementById("world")).transform);
      return Math.abs(matrix.a - 1) < 0.001;
    });
    const scaleBeforeButton = await readCanvasView(page);
    await page.click("#t-zin");
    await page.waitForFunction((previousScale) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(document.getElementById("world")).transform);
      return matrix.a > previousScale + 0.01;
    }, scaleBeforeButton.scale);
    const scaleAfterButton = await readCanvasView(page);
    assert(scaleAfterButton.scale > scaleBeforeButton.scale,
      `${engineName}: mobile zoom-in control must change the canvas scale`);
    await page.click("#zoom-label");
    await page.waitForFunction(() => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(document.getElementById("world")).transform);
      return Math.abs(matrix.a - 1) < 0.001;
    });
    const resetView = await readCanvasView(page);
    assert(Math.abs(resetView.scale - 1) < 0.001,
      `${engineName}: tapping the mobile zoom label must reset to 100%`);

    if (engineName === "chromium") await verifyRealChromiumTouches(context, page);

    const contentRoute = await page.locator(".node.root .node-body").evaluate((body) => {
      const world = document.getElementById("world");
      function view() {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
        return { x: matrix.e, y: matrix.f, scale: matrix.a };
      }
      function fire(type, id, x, y, buttons) {
        const event = new PointerEvent(type, { bubbles: true, cancelable: true,
          pointerId: id, pointerType: "touch", isPrimary: true, button: 0,
          buttons, clientX: x, clientY: y });
        body.dispatchEvent(event);
        return event.defaultPrevented;
      }
      const before = view();
      const downPrevented = fire("pointerdown", 11, 180, 420, 1);
      const movePrevented = fire("pointermove", 11, 180, 350, 1);
      fire("pointerup", 11, 180, 350, 0);
      return { before, after: view(), downPrevented, movePrevented,
        touchAction: getComputedStyle(body).touchAction,
        scrollable: body.scrollHeight > body.clientHeight };
    });
    assert.equal(contentRoute.downPrevented, false,
      `${engineName}: a one-finger card gesture must remain available to the native scroller`);
    assert.equal(contentRoute.movePrevented, false,
      `${engineName}: card scrolling must not be stolen by the canvas camera`);
    assert.equal(contentRoute.scrollable, true, `${engineName}: the mobile card fixture must actually scroll`);
    assert.match(contentRoute.touchAction, /pan-x|pan-y/,
      `${engineName}: card bodies must advertise native one-finger panning`);
    assert.deepEqual(contentRoute.after, contentRoute.before,
      `${engineName}: a one-finger gesture inside a card must not move the canvas`);

    const backgroundPan = await page.locator("#viewport").evaluate((surface) => {
      const world = document.getElementById("world");
      function view() {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
        return { x: matrix.e, y: matrix.f, scale: matrix.a };
      }
      function fire(type, x, y, buttons) {
        surface.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
          pointerId: 21, pointerType: "touch", isPrimary: true, button: 0,
          buttons, clientX: x, clientY: y }));
      }
      const before = view();
      fire("pointerdown", 340, 730, 1);
      fire("pointermove", 292, 668, 1);
      fire("pointerup", 292, 668, 0);
      return { before, after: view(), panning: surface.classList.contains("panning") };
    });
    assert(Math.abs((backgroundPan.after.x - backgroundPan.before.x) + 48) < 0.01,
      `${engineName}: one finger on empty canvas must pan horizontally 1:1 (${JSON.stringify(backgroundPan)})`);
    assert(Math.abs((backgroundPan.after.y - backgroundPan.before.y) + 62) < 0.01,
      `${engineName}: one finger on empty canvas must pan vertically 1:1 (${JSON.stringify(backgroundPan)})`);
    assert.equal(backgroundPan.after.scale, backgroundPan.before.scale,
      `${engineName}: one-finger canvas panning must not alter zoom`);
    assert.equal(backgroundPan.panning, false, `${engineName}: the pan state must clean up after pointerup`);

    const pinch = await page.locator(".node.root .node-body").evaluate((body) => {
      const surface = document.getElementById("viewport");
      const world = document.getElementById("world");
      function view() {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
        return { x: matrix.e, y: matrix.f, scale: matrix.a };
      }
      function fire(type, id, x, y, buttons, primary) {
        body.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
          pointerId: id, pointerType: "touch", isPrimary: primary, button: 0,
          buttons, clientX: x, clientY: y }));
      }
      const before = view();
      const startMid = { x: 160, y: 340 };
      const anchor = { x: (startMid.x - before.x) / before.scale,
        y: (startMid.y - before.y) / before.scale };
      fire("pointerdown", 31, 80, 340, 1, true);
      fire("pointerdown", 32, 240, 340, 1, false);
      fire("pointermove", 31, 50, 320, 1, true);
      fire("pointermove", 32, 310, 380, 1, false);
      const after = view();
      const finalMid = { x: 180, y: 350 };
      const anchoredAt = { x: anchor.x * after.scale + after.x,
        y: anchor.y * after.scale + after.y };
      fire("pointerup", 31, 50, 320, 0, true);
      fire("pointerup", 32, 310, 380, 0, false);
      return { before, after, finalMid, anchoredAt,
        pinching: surface.classList.contains("pinching"),
        panning: surface.classList.contains("panning") };
    });
    assert(pinch.after.scale > pinch.before.scale * 1.5,
      `${engineName}: spreading two fingers must zoom the canvas continuously (${JSON.stringify(pinch)})`);
    assert(Math.abs(pinch.anchoredAt.x - pinch.finalMid.x) < 0.05
      && Math.abs(pinch.anchoredAt.y - pinch.finalMid.y) < 0.05,
      `${engineName}: pinch zoom must keep the original midpoint content under the moving fingers (${JSON.stringify(pinch)})`);
    assert.equal(pinch.pinching, false, `${engineName}: pinch state must clean up after both fingers lift`);
    assert.equal(pinch.panning, false, `${engineName}: pinch-to-pan continuation must clean up after the last finger lifts`);

    await page.click("#t-reader");
    await page.waitForFunction(() => !document.body.classList.contains("mode-canvas"));
    const mobileReader = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector).getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom,
          width: value.width, height: value.height };
      };
      const main = document.getElementById("reader-main");
      const input = document.getElementById("composer-text");
      const send = rect("#composer-send");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        reader: rect("#reader"),
        top: rect("#taskbar"),
        main: { ...rect("#reader-main"), clientWidth: main.clientWidth, scrollWidth: main.scrollWidth,
          clientHeight: main.clientHeight, scrollHeight: main.scrollHeight, touchAction: getComputedStyle(main).touchAction },
        column: rect(".reader-col"),
        composer: rect("#composer"),
        inputFont: parseFloat(getComputedStyle(input).fontSize),
        send,
        notesDisplay: getComputedStyle(document.getElementById("margin-notes")).display,
      };
    });
    assert.equal(mobileReader.reader.width, mobileReader.viewport.width,
      `${engineName}: the mobile reader must own the full viewport width (${JSON.stringify(mobileReader)})`);
    assert(mobileReader.main.width >= mobileReader.viewport.width - 1,
      `${engineName}: the hidden desktop branch rail must not squeeze the document (${JSON.stringify(mobileReader)})`);
    assert(mobileReader.column.width >= mobileReader.viewport.width - 48,
      `${engineName}: the phone reading column must remain comfortably readable (${JSON.stringify(mobileReader)})`);
    assert(mobileReader.main.scrollWidth <= mobileReader.main.clientWidth,
      `${engineName}: the mobile reader must not have page-level horizontal overflow (${JSON.stringify(mobileReader)})`);
    assert(mobileReader.main.scrollHeight > mobileReader.main.clientHeight + 200,
      `${engineName}: the mobile reader fixture must expose a real vertical reading surface`);
    assert.match(mobileReader.main.touchAction, /pan-y/,
      `${engineName}: one-finger swipes must be routed to native vertical reading (${JSON.stringify(mobileReader)})`);
    assert(mobileReader.composer.bottom <= mobileReader.viewport.height + 0.5,
      `${engineName}: the follow-up composer must remain above the phone viewport edge (${JSON.stringify(mobileReader)})`);
    assert(mobileReader.inputFont >= 16,
      `${engineName}: the mobile follow-up field must not trigger iOS focus zoom`);
    assert(mobileReader.send.width >= 44 && mobileReader.send.height >= 44,
      `${engineName}: the mobile follow-up send target must be at least 44px (${JSON.stringify(mobileReader)})`);
    assert.equal(mobileReader.notesDisplay, "none",
      `${engineName}: margin notes must stay out of the phone reading surface — inline marks carry narrow screens`);

    if (engineName === "chromium") await verifyRealChromiumReaderScroll(context, page);

    await page.close();
  } finally {
    await context.close();
  }
}

async function verifyRealChromiumReaderScroll(context, page) {
  const client = await context.newCDPSession(page);
  const main = await page.locator("#reader-main").evaluate((element) => {
    element.scrollTop = 0;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, startY: rect.bottom - 70, endY: rect.top + 70 };
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchStart",
    touchPoints: [{ id: 61, x: main.x, y: main.startY, radiusX: 4, radiusY: 4, force: 1 }] });
  for (let step = 1; step <= 6; step += 1) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 61,
      x: main.x, y: main.startY + (main.endY - main.startY) * step / 6,
      radiusX: 4, radiusY: 4, force: 1 }] });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(100);
  const scrollTop = await page.locator("#reader-main").evaluate((element) => element.scrollTop);
  assert(scrollTop > 80, `chromium: a physical one-finger reader swipe must scroll the document (got ${scrollTop})`);
  await client.detach();
}

async function verifyDesktopReaderLayout(browserEngine) {
  const context = await browserEngine.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await routeProvider(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, "# Desktop reader invariant\n\nThe established desktop layout must remain unchanged.");
    await page.click("#t-reader");
    const desktop = await page.evaluate(() => {
      const notes = document.getElementById("margin-notes");
      const main = document.getElementById("reader-main");
      const mainStyle = getComputedStyle(main);
      const column = document.querySelector(".reader-col").getBoundingClientRect();
      const notesRect = notes.getBoundingClientRect();
      const rail = document.getElementById("reader-rail").getBoundingClientRect();
      const workspaceStyle = getComputedStyle(document.getElementById("reader-workspace"));
      const bar = document.getElementById("taskbar").getBoundingClientRect();
      const session = document.getElementById("tb-session").getBoundingClientRect();
      const readerTop = document.getElementById("reader").getBoundingClientRect().top
        + parseFloat(getComputedStyle(document.getElementById("reader")).paddingTop);
      return { notesDisplay: getComputedStyle(notes).display, notesLeft: notesRect.left, notesRight: notesRect.right, columnRight: column.right,
        mainWidth: main.getBoundingClientRect().width, mainRight: main.getBoundingClientRect().right,
        railLeft: rail.left, railRight: rail.right, railWidth: rail.width,
        viewportWidth: innerWidth, barHeight: bar.height, barBottom: bar.bottom, contentTop: readerTop,
        workspaceBorderTopStyle: workspaceStyle.borderTopStyle,
        workspaceBorderTopWidth: parseFloat(workspaceStyle.borderTopWidth),
        sessionRight: session.right,
        doneDisplay: getComputedStyle(document.getElementById("tb-done-pill")).display,
        mainPaddingLeft: parseFloat(mainStyle.paddingLeft) };
    });
    assert.equal(desktop.notesDisplay, "flex", `desktop: the branch rail must be live beside the document (${JSON.stringify(desktop)})`);
    assert(Math.abs(desktop.mainRight - desktop.railLeft) <= 1, `desktop: the document and branch rail must meet without a dead strip (${JSON.stringify(desktop)})`);
    assert(desktop.notesLeft >= desktop.railLeft && desktop.notesRight <= desktop.railRight,
      `desktop: branch cards must stay inside the right rail (${JSON.stringify(desktop)})`);
    assert(desktop.columnRight < desktop.railLeft, `desktop: prose must stay inside the remaining document pane (${JSON.stringify(desktop)})`);
    assert(Math.abs(desktop.mainWidth + desktop.railWidth - desktop.viewportWidth) <= 1,
      `desktop: document plus branch rail must consume exactly the viewport (${JSON.stringify(desktop)})`);
    assert(Math.abs(desktop.viewportWidth - desktop.railRight) <= 1, `desktop: the branch rail must hug the physical right edge (${JSON.stringify(desktop)})`);
    assert(desktop.barHeight < 52, `desktop: the shared taskbar must remain a single compact row (${JSON.stringify(desktop)})`);
    assert(desktop.contentTop >= desktop.barBottom, `desktop: reader content must clear the floating taskbar (${JSON.stringify(desktop)})`);
    assert.equal(desktop.workspaceBorderTopStyle, "solid", `desktop: the Reader workspace must have a continuous top boundary (${JSON.stringify(desktop)})`);
    assert(desktop.workspaceBorderTopWidth > 0, `desktop: the Reader workspace top boundary must remain visible (${JSON.stringify(desktop)})`);
    assert(desktop.viewportWidth - desktop.sessionRight <= 20, `desktop: the session cluster must hug the top-right corner (${JSON.stringify(desktop)})`);
    assert.equal(desktop.doneDisplay, "none", `desktop: Done ends an agent session — it must never render in the web app (${JSON.stringify(desktop)})`);
    assert.equal(desktop.mainPaddingLeft, 48, `desktop: the established reading gutter must stay at 48px`);
    await page.close();
  } finally {
    await context.close();
  }
}

async function verifyRealChromiumTouches(context, page) {
  const client = await context.newCDPSession(page);
  const surfacePoint = await page.locator("#viewport").evaluate((surface) => {
    for (let y = innerHeight - 36; y >= 100; y -= 36) {
      for (let x = innerWidth - 28; x >= 28; x -= 36) {
        const target = document.elementFromPoint(x, y);
        if (target && surface.contains(target)
          && !target.closest(".node") && !target.closest("#taskbar")) return { x, y };
      }
    }
    return null;
  });
  assert(surfacePoint, "chromium: the real-touch fixture needs visible empty canvas");
  const beforePan = await readCanvasView(page);
  const panDelta = { x: -42, y: -58 };
  await client.send("Input.dispatchTouchEvent", { type: "touchStart",
    touchPoints: [{ id: 41, x: surfacePoint.x, y: surfacePoint.y, radiusX: 4, radiusY: 4, force: 1 }] });
  for (let step = 1; step <= 6; step += 1) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 41,
      x: surfacePoint.x + panDelta.x * step / 6, y: surfacePoint.y + panDelta.y * step / 6,
      radiusX: 4, radiusY: 4, force: 1 }] });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const afterPan = await readCanvasView(page);
  assert(Math.abs(afterPan.x - beforePan.x - panDelta.x) < 1
    && Math.abs(afterPan.y - beforePan.y - panDelta.y) < 1,
    `chromium: a physical one-finger drag on empty canvas must pan 1:1 (${JSON.stringify({ beforePan, afterPan })})`);

  const card = await page.locator(".node.root .node-body").evaluate((body) => {
    const rect = body.getBoundingClientRect();
    const left = Math.max(24, rect.left + 24);
    const right = Math.min(innerWidth - 24, rect.right - 24);
    const top = Math.max(90, rect.top + 24);
    const bottom = Math.min(innerHeight - 24, rect.bottom - 24);
    return { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2 };
  });
  assert(card.right - card.left > 120 && card.bottom - card.top > 120,
    `chromium: the real-touch fixture needs a visible card body (${JSON.stringify(card)})`);

  const beforeScrollView = await readCanvasView(page);
  const beforeScrollTop = await page.locator(".node.root .node-body").evaluate((body) => body.scrollTop);
  const scrollStartY = Math.min(card.bottom - 20, card.y + 60);
  const scrollEndY = Math.max(card.top + 20, scrollStartY - 120);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart",
    touchPoints: [{ id: 42, x: card.x, y: scrollStartY, radiusX: 4, radiusY: 4, force: 1 }] });
  for (let step = 1; step <= 6; step += 1) {
    const y = scrollStartY + (scrollEndY - scrollStartY) * step / 6;
    await client.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ id: 42, x: card.x, y, radiusX: 4, radiusY: 4, force: 1 }] });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(80);
  const afterScrollTop = await page.locator(".node.root .node-body").evaluate((body) => body.scrollTop);
  const afterScrollView = await readCanvasView(page);
  assert(afterScrollTop > beforeScrollTop + 30,
    `chromium: a physical one-finger swipe inside a card must scroll it (${beforeScrollTop} -> ${afterScrollTop})`);
  assert(Math.abs(afterScrollView.x - beforeScrollView.x) < 0.01
    && Math.abs(afterScrollView.y - beforeScrollView.y) < 0.01
    && Math.abs(afterScrollView.scale - beforeScrollView.scale) < 0.001,
    `chromium: a physical card swipe must not move the camera`);

  const beforePinch = await readCanvasView(page);
  const centerX = card.x;
  const centerY = card.y;
  const startHalfSpan = Math.min(42, (card.right - card.left) / 4);
  const endHalfSpan = Math.min(65, (card.right - card.left) / 2 - 8);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
    { id: 51, x: centerX - startHalfSpan, y: centerY, radiusX: 4, radiusY: 4, force: 1 },
    { id: 52, x: centerX + startHalfSpan, y: centerY, radiusX: 4, radiusY: 4, force: 1 },
  ] });
  for (let step = 1; step <= 6; step += 1) {
    const halfSpan = startHalfSpan + (endHalfSpan - startHalfSpan) * step / 6;
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { id: 51, x: centerX - halfSpan, y: centerY, radiusX: 4, radiusY: 4, force: 1 },
      { id: 52, x: centerX + halfSpan, y: centerY, radiusX: 4, radiusY: 4, force: 1 },
    ] });
  }
  const afterPinch = await readCanvasView(page);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert(afterPinch.scale > beforePinch.scale * 1.35,
    `chromium: a physical two-finger spread inside a card must zoom the canvas (${beforePinch.scale} -> ${afterPinch.scale})`);
  const anchorX = (centerX - beforePinch.x) / beforePinch.scale;
  const anchorY = (centerY - beforePinch.y) / beforePinch.scale;
  assert(Math.abs(anchorX * afterPinch.scale + afterPinch.x - centerX) < 1
    && Math.abs(anchorY * afterPinch.scale + afterPinch.y - centerY) < 1,
    `chromium: a physical pinch must keep the content under its midpoint stable`);
  await client.detach();
}

async function readCanvasView(page) {
  return page.locator("#world").evaluate((world) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(world).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
}

async function verifyMobileSelectionSurface(browserEngine, engineName) {
  const context = await browserEngine.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  await seedConfiguredOpenRouter(context);
  try {
    const canvasPage = await context.newPage();
    await routeProvider(canvasPage, {
      streams: [["TITLE: Mobile custom branch\n", "Mobile custom question completed."]],
      providerDelayMs: 220,
    });
    await canvasPage.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(canvasPage, "# Mobile selection\n\nLong-press selection should open a reliable action sheet.");

    await canvasPage.evaluate(() => {
      const root = document.querySelector(".node .doc-content[data-node-id]");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const start = node.nodeValue.indexOf("Long-press selection");
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + "Long-press selection".length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      throw new Error("Mobile selection fixture text not found");
    });
    await canvasPage.waitForSelector("#ask.visible.mobile-sheet");

    const initial = await canvasPage.locator("#ask").evaluate((surface) => {
      const rect = surface.getBoundingClientRect();
      const viewport = window.visualViewport;
      const input = document.getElementById("ask-text");
      const lenses = Array.from(surface.querySelectorAll(".lens"));
      return {
        active: document.activeElement?.id || "",
        placement: surface.dataset.placement,
        selection: window.getSelection().toString(),
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        viewport: { left: viewport.offsetLeft, right: viewport.offsetLeft + viewport.width, top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height },
        inputFont: parseFloat(getComputedStyle(input).fontSize),
        lensColumns: getComputedStyle(document.getElementById("ask-lenses")).gridTemplateColumns.split(" ").length,
        lensMinHeight: Math.min(...lenses.map((lens) => lens.getBoundingClientRect().height)),
        keyHintsHidden: lenses.every((lens) => getComputedStyle(lens.querySelector("kbd")).display === "none"),
      };
    });
    assert.notEqual(initial.active, "ask-text", `${engineName}: mobile selection must not summon the keyboard before the user asks a custom question`);
    assert.equal(initial.placement, "top-center", `${engineName}: mobile selection actions should anchor to the visual viewport bottom`);
    assert.equal(initial.selection, "Long-press selection", `${engineName}: opening the mobile sheet must preserve the selected text`);
    assert(initial.rect.left >= initial.viewport.left && initial.rect.right <= initial.viewport.right, `${engineName}: mobile selection sheet must fit the visual viewport (${JSON.stringify(initial)})`);
    assert(initial.rect.top >= initial.viewport.top && initial.rect.bottom <= initial.viewport.bottom, `${engineName}: mobile selection sheet must stay visible (${JSON.stringify(initial)})`);
    assert(initial.inputFont >= 16, `${engineName}: mobile custom-question input must not trigger iOS focus zoom`);
    assert.equal(initial.lensColumns, 2, `${engineName}: mobile lenses should use a thumb-friendly two-column grid`);
    assert(initial.lensMinHeight >= 44, `${engineName}: mobile lens targets must be at least 44px tall (got ${initial.lensMinHeight})`);
    assert.equal(initial.keyHintsHidden, true, `${engineName}: desktop keyboard shortcut hints should be hidden on touch surfaces`);

    await canvasPage.click("#ask-text");
    await canvasPage.fill("#ask-text", "Why is this reliable?");
    await canvasPage.setViewportSize({ width: 390, height: 430 });
    await canvasPage.waitForFunction(() => {
      const surface = document.getElementById("ask").getBoundingClientRect();
      const viewport = window.visualViewport;
      return document.activeElement?.id === "ask-text" && surface.top >= viewport.offsetTop && surface.bottom <= viewport.offsetTop + viewport.height;
    });
    assert.equal(await canvasPage.evaluate(() => window.visualViewport?.scale), 1, `${engineName}: focusing the mobile question field must not zoom the page`);
    await canvasPage.keyboard.press("Enter");
    await canvasPage.waitForSelector("#ask:not(.visible)");
    await canvasPage.locator(".node:not(.root)", { hasText: "Mobile custom question completed." }).waitFor();
    await canvasPage.close();

    // WebKit's automation layer cannot attach a synthetic Selection inside the
    // overflowed reader (native long-press handles are not exposed). Its true-
    // mobile canvas flow above still covers the shared sheet and iOS viewport;
    // Chromium exercises the reader's touchend path end to end below.
    if (engineName === "webkit") return;

    const readerPage = await context.newPage();
    await routeProvider(readerPage, {
      streams: [["TITLE: Mobile lens branch\n", "Mobile lens action completed."]],
      providerDelayMs: 220,
    });
    await readerPage.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(readerPage, "# Mobile reader selection\n\nTouch selection should open a **reliable action sheet**.");
    await readerPage.click("#t-reader");
    await readerPage.waitForFunction(() => !document.body.classList.contains("mode-canvas"));
    await readerPage.evaluate(() => {
      const node = document.querySelector("#reader-main strong")?.firstChild;
      if (!node) throw new Error("Mobile reader selection fixture text not found");
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      node.parentElement.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    await readerPage.waitForSelector("#ask.visible.mobile-sheet");
    assert.equal(await readerPage.evaluate(() => window.getSelection().toString()), "reliable action sheet", `${engineName}: reader selection should open the sheet without collapsing the range`);
    const sidebarBranchCount = await readerPage.locator(".side-item").count();
    await readerPage.click('.lens[data-lens="explain"]');
    await readerPage.waitForSelector("#ask:not(.visible)");
    await readerPage.waitForFunction((before) => document.querySelectorAll(".side-item").length > before, sidebarBranchCount);
    await readerPage.waitForFunction(() => Array.from(document.querySelectorAll(".side-item")).some((item) => !item.classList.contains("pending")));
    // Margin notes stay off the phone reading surface, but the note still
    // carries its lens and selected context for wider screens.
    assert.match(await readerPage.locator("#margin-notes .side-item").last().evaluate((tile) => tile.textContent),
      /Explain[\s\S]*reliable action sheet/i, `${engineName}: the reader lens action should retain its lens and selected context`);
    assert(await readerPage.locator("#reader-main mark[data-child]").count() >= 1,
      `${engineName}: the lens branch must leave an inline mark as the phone affordance`);
    await readerPage.close();
  } finally {
    await context.close();
  }
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
  await page.click("#t-settings");
  await page.waitForSelector("#web-settings-popover", { state: "detached" });
  assert.equal(await page.getAttribute("#t-settings", "aria-expanded"), "false", "clicking the gear while settings is open must close it");
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
    ...Array.from({ length: 12 }, (_, index) => [
      "",
      `## Reading position ${index + 1}`,
      "A deliberately long section keeps both reading surfaces scrollable so mode transitions can preserve the same semantic location.",
    ].join("\n")),
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

  const canvasReadingPosition = await page.evaluate(() => {
    const scroller = document.querySelector(".node.root .node-body");
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.4;
    const top = scroller.getBoundingClientRect().top;
    const blocks = Array.from(scroller.querySelector(".doc-content").children);
    const block = blocks.findIndex((item) => item.getBoundingClientRect().bottom > top);
    const rect = blocks[block].getBoundingClientRect();
    return { block, offset: (top - rect.top) / rect.height };
  });
  await page.click("#t-reader");
  await page.waitForSelector("body:not(.mode-canvas)");
  const readerReadingPosition = await page.locator("#reader-main").evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    const blocks = Array.from(scroller.querySelector(".doc-content").children);
    const block = blocks.findIndex((item) => item.getBoundingClientRect().bottom > top);
    const rect = blocks[block].getBoundingClientRect();
    return { block, offset: (top - rect.top) / rect.height };
  });
  assert.equal(readerReadingPosition.block, canvasReadingPosition.block, "canvas-to-reader should preserve the visible content block");
  assert(Math.abs(readerReadingPosition.offset - canvasReadingPosition.offset) < 0.2, `canvas-to-reader should preserve the position within the visible block: ${JSON.stringify({ canvasReadingPosition, readerReadingPosition })}`);
  await page.focus("#r-textup");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-share", "reader tools should tab straight into the session cluster");
  const readerFocusRing = await page.evaluate(() => getComputedStyle(document.getElementById("t-share")).outlineStyle);
  assert.notEqual(readerFocusRing, "none", "keyboard focus should show the taskbar focus-visible ring");
  const readerReturnPosition = await page.locator("#reader-main").evaluate((scroller) => {
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.35;
    const top = scroller.getBoundingClientRect().top;
    const blocks = Array.from(scroller.querySelector(".doc-content").children);
    const block = blocks.findIndex((item) => item.getBoundingClientRect().bottom > top);
    const rect = blocks[block].getBoundingClientRect();
    return { block, offset: (top - rect.top) / rect.height };
  });
  await page.focus("#t-canvas");
  await page.keyboard.press("Enter");
  await page.waitForSelector("body.mode-canvas");
  await page.waitForTimeout(50);
  const canvasReturnPosition = await page.locator(".node.root .node-body").evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    const blocks = Array.from(scroller.querySelector(".doc-content").children);
    const block = blocks.findIndex((item) => item.getBoundingClientRect().bottom > top);
    const rect = blocks[block].getBoundingClientRect();
    return { block, offset: (top - rect.top) / rect.height };
  });
  assert.equal(canvasReturnPosition.block, readerReturnPosition.block, "reader-to-canvas should preserve the visible content block");
  assert(Math.abs(canvasReturnPosition.offset - readerReturnPosition.offset) < 0.2, `reader-to-canvas should preserve the position within the visible block: ${JSON.stringify({ readerReturnPosition, canvasReturnPosition })}`);
  await page.focus("#t-new");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-reader");
  const canvasFocusRing = await page.evaluate(() => getComputedStyle(document.getElementById("t-reader")).outlineStyle);
  assert.notEqual(canvasFocusRing, "none", "keyboard focus should show the canvas-toolbar focus-visible ring");
  await page.keyboard.press("Space");
  await page.waitForSelector("body:not(.mode-canvas)");
  await page.focus("#t-canvas");
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
  assert(frozenHtml.includes("#taskbar"), "web-exported snapshots should embed durable canvas styling");
  assert(frozenHtml.includes(".katex"), "web-exported snapshots should embed self-contained KaTeX styling");
  assert(!frozenHtml.includes(".web-rail"), "web-exported snapshots must exclude web-only rail styling");
  const frozenPage = await context.newPage();
  await frozenPage.setContent(frozenHtml, { waitUntil: "load" });
  const frozenStyles = await frozenPage.evaluate(() => ({
    surfaceGap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-gap")),
    toolbarPosition: getComputedStyle(document.getElementById("taskbar")).position,
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
  await page.evaluate(() => {
    window.__askRangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function() {
      return { left: -24, right: 76, top: innerHeight - 24, bottom: innerHeight - 4, width: 100, height: 20, x: -24, y: innerHeight - 24 };
    };
  });
  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ask-text", "opening the selection bar must focus its input for immediate typing");
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

  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.waitForFunction(() => document.activeElement?.id === "ask-text", null, { timeout: 5000 })
    .catch(() => { throw new Error("the selection bar must focus its input on open"); });
  await page.keyboard.type("Why does this matter?");
  await page.keyboard.press("Enter");
  await page.click("#t-reader");
  await page.waitForSelector('.side-item.pending[role="link"]');
  const pendingSidebarContract = await page.locator('.side-item.pending[role="link"]').evaluate((tile) => {
    tile.__s9Identity = "pending-stream-tile";
    return { id: tile.dataset.child, tabIndex: tile.tabIndex, name: tile.getAttribute("aria-label") };
  });
  assert.equal(pendingSidebarContract.tabIndex, 0, "pending margin notes should be tabbable links");
  assert.match(pendingSidebarContract.name, /^Open branch: .+, pending$/, "pending margin notes should name the branch and pending state");
  const pendingAlignment = await page.evaluate((id) => {
    const tile = document.querySelector(`#margin-notes .side-item[data-child="${id}"]`);
    const mark = document.querySelector(`#reader-main mark[data-child="${id}"]`);
    const rail = document.getElementById("reader-rail").getBoundingClientRect();
    const card = tile.getBoundingClientRect();
    return { tileLeft: card.left, tileRight: card.right, railLeft: rail.left, railRight: rail.right, hasMark: !!mark };
  }, pendingSidebarContract.id);
  assert(pendingAlignment.hasMark && pendingAlignment.tileLeft >= pendingAlignment.railLeft && pendingAlignment.tileRight <= pendingAlignment.railRight,
    `anchored branches must retain their inline mark while their card stays in the persistent rail (${JSON.stringify(pendingAlignment)})`);
  const streamedSidebarTile = page.locator(`.side-item[data-child="${pendingSidebarContract.id}"][role="link"]`);
  await page.waitForFunction((id) => !document.querySelector(`.side-item[data-child="${id}"]`)?.classList.contains("pending"), pendingSidebarContract.id);
  assert.equal(await streamedSidebarTile.evaluate((tile) => tile.__s9Identity),
    "pending-stream-tile", "stream updates should patch the pending sidebar tile without replacing it");
  assert.equal(await page.locator('.side-item[role="link"] .si-live').count(), 0, "settling a streamed sidebar branch should remove its one live pane");
  assert.equal(providerCalls, 2);

  const sidebarTile = streamedSidebarTile;
  assert.deepEqual(await sidebarTile.evaluate((tile) => ({ role: tile.getAttribute("role"), tabIndex: tile.tabIndex, name: tile.getAttribute("aria-label") })),
    { role: "link", tabIndex: 0, name: "Open branch: Why does this matter?" }, "settled sidebar tiles should expose named link semantics without activity state");
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
  await page.click("#t-canvas");
  await waitForCanvasText(page, "Euler identity connects rotation");

  const branchMark = page.locator('.node mark[data-child].mark-ready').first();
  assert.deepEqual(await branchMark.evaluate((mark) => ({ tabIndex: mark.tabIndex, role: mark.getAttribute("role"), name: mark.getAttribute("aria-label") })),
    { tabIndex: 0, role: "link", name: "Open branch: Euler branch" }, "branch marks should expose keyboard navigation semantics and the branch title");
  await branchMark.hover();
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#peek").count(), 0, "hovering a mark must not raise any peek surface — marks are plain links");

  await page.focus("#t-theme");
  const visitedTabStops = new Set([await page.evaluate(() => {
    const start = document.querySelector("#t-theme");
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
  assert.notEqual(await branchMark.evaluate((mark) => getComputedStyle(mark).outlineStyle), "none", "focused branch marks should show a keyboard ring");

  // Enter (and click) on a canvas mark dives the canvas to the answer card —
  // it stays in canvas mode and flashes the card, never opening a popup.
  // The flash class lives a single frame, so watch for it with an observer.
  const armFlashProbe = () => page.evaluate(() => {
    window.__markDiveFlashed = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".node:not(.root).flash")) { window.__markDiveFlashed = true; observer.disconnect(); }
    });
    observer.observe(document.getElementById("world"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  await armFlashProbe();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__markDiveFlashed === true);
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true, "Enter on a canvas mark must stay in canvas and dive to the card");
  await page.waitForTimeout(400);
  await page.click("#t-frame"); // the dive moved the parent's mark off-screen — refit first
  await page.waitForTimeout(400);
  await armFlashProbe();
  await branchMark.click();
  await page.waitForFunction(() => window.__markDiveFlashed === true);
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true, "clicking a canvas mark must stay in canvas and dive to the card");

  if (!await page.evaluate(() => document.body.classList.contains("mode-canvas"))) await page.click("#t-canvas");
  await page.click("#t-frame"); // leave the mark-dive zoom behind so popover geometry is measured from a neutral view
  await page.waitForTimeout(400);
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

  // Export while the child is the current node so the frozen reader opens with
  // a parent crumb (mark clicks no longer change the current node).
  await page.click("#t-reader");
  await page.locator('.side-item[role="link"]').first().click();
  await page.locator("#reader-main", { hasText: "Euler identity connects rotation" }).waitFor();
  await page.click("#t-canvas");
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
    "frozen margin notes should remain keyboard navigable");
  await frozenSidebar.focus();
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => document.querySelectorAll("#breadcrumb .crumb").length > 1);
  await branchFrozenPage.locator('.crumb[role="link"]').focus();
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => document.querySelectorAll("#breadcrumb .crumb").length === 1);
  await branchFrozenPage.click("#t-canvas");
  const frozenMark = branchFrozenPage.locator('.node mark[data-child].mark-ready').first();
  await frozenMark.focus();
  await branchFrozenPage.evaluate(() => {
    window.__markDiveFlashed = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".node:not(.root).flash")) { window.__markDiveFlashed = true; observer.disconnect(); }
    });
    observer.observe(document.getElementById("world"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => window.__markDiveFlashed === true);
  assert.equal(await branchFrozenPage.evaluate(() => document.body.classList.contains("mode-canvas")), true,
    "Enter on a frozen canvas mark should dive to the card in place");
  await branchFrozenPage.close();

  await page.click("#t-reader");
  await page.fill("#composer-text", "Go one layer deeper.");
  await page.click("#composer-send");
  const followupRailCard = page.locator("#margin-notes .side-item", { hasText: "Go one layer deeper." });
  await followupRailCard.waitFor();
  await followupRailCard.click();
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

  if (!await page.evaluate(() => document.body.classList.contains("mode-canvas"))) await page.click("#t-canvas");
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
