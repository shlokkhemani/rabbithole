import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { webkit } from "playwright";
import { extractSnapshotPayload } from "../../src/core/portable-import.js";
import { serializeForInlineScript } from "../../src/core/utils.js";
import { assertCodeCopy } from "../support/code-copy.mjs";
import { MOCK_MODEL, corsHeaders, routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { ROOT, bootWebApp } from "../support/web-app-harness.mjs";
import { assertSelectionPopoverUsable, panCanvasBy, selectVisibleText } from "../support/visible-selection.mjs";

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
const group = process.env.RABBITHOLE_E2E_GROUP || "all";
const mobileWebKit = group === "mobile" || group === "all" ? await webkit.launch() : null;
try {
  if (group === "mobile" || group === "all") {
    await verifyMobileCanvasNavigation(browser, "chromium");
    await verifyMobileCanvasNavigation(mobileWebKit, "webkit");
    await verifyDesktopReaderLayout(browser);
    await verifyMobileSelectionSurface(browser, "chromium");
    await verifyMobileSelectionSurface(mobileWebKit, "webkit");
  }
  if (group === "notes" || group === "all") {
    await verifyAnchoredNotes();
    await verifyDockedNoteTextGeometry();
    await verifyDockedNotes();
    await verifyNotePopoverWysiwyg();
    await verifyNotePopoverAnchorStability();
    await verifyStandaloneNotesAndEditing();
  }
  if (group === "branching" || group === "all") {
    await verifyStandaloneImagePaste();
    await verifyNoteToAskConversion();
    await verifyLogicalMarkGrouping();
  }
  if (group === "sharing" || group === "all") {
    await verifyCardMenu();
    await verifyCanvasBranching();
  }
  console.log(`web app ${group} verification passed`);
} finally {
  await mobileWebKit?.close();
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
      const body = document.querySelector(".card.root .card-body");
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

    const contentRoute = await page.locator(".card.root .card-body").evaluate((body) => {
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

    const pinch = await page.locator(".card.root .card-body").evaluate((body) => {
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

    // Touch gestures arm the canvas ghost-click suppressor for up to 450ms —
    // let it lapse before driving the expand control.
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector(".card.current [aria-label='Expand document']").click());
    await page.waitForFunction(() => !document.body.classList.contains("mode-canvas"));
    await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
    assert.deepEqual(await composerRowState(page, "#composer-actions"), { lensesVisible: true, commitsHidden: true },
      `${engineName}: an empty mobile reader composer must rest on the three presets with the commit pair hidden`);
    await page.fill("#composer-text", "Mobile follow-up draft");
    const mobileReader = await page.evaluate(() => {
      const rect = (selector) => {
        const value = document.querySelector(selector).getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom,
          width: value.width, height: value.height };
      };
      const main = document.getElementById("reader-main");
      const input = document.getElementById("composer-text");
      const commits = Array.from(document.querySelectorAll("#composer-actions .ask-commit")).map((button) => {
        const value = button.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom,
          width: value.width, height: value.height };
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        reader: rect("#reader"),
        top: rect("#taskbar"),
        main: { ...rect("#reader-main"), clientWidth: main.clientWidth, scrollWidth: main.scrollWidth,
          clientHeight: main.clientHeight, scrollHeight: main.scrollHeight, touchAction: getComputedStyle(main).touchAction },
        column: rect(".reader-col"),
        composer: rect("#composer"),
        inputFont: parseFloat(getComputedStyle(input).fontSize),
        commits,
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
    assert(mobileReader.commits.every((target) => target.width >= 44 && target.height >= 44),
      `${engineName}: both mobile follow-up commit targets must be at least 44px (${JSON.stringify(mobileReader)})`);
    assert.equal(mobileReader.notesDisplay, "none",
      `${engineName}: margin notes must stay out of the phone reading surface — inline marks carry narrow screens`);

    await page.fill("#composer-text", "");
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
    await page.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
    await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
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
          && !target.closest(".card") && !target.closest("#taskbar")) return { x, y };
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

  const card = await page.locator(".card.root .card-body").evaluate((body) => {
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
  const beforeScrollTop = await page.locator(".card.root .card-body").evaluate((body) => body.scrollTop);
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
  const afterScrollTop = await page.locator(".card.root .card-body").evaluate((body) => body.scrollTop);
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
      const root = document.querySelector(".card .doc-content[data-node-id]");
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
        lensColumns: getComputedStyle(document.getElementById("ask-actions")).gridTemplateColumns.split(" ").length,
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

    await assertSelectionPopoverUsable(canvasPage);
    await canvasPage.click("#ask-text", { timeout: 4_000 });
    await canvasPage.fill("#ask-text", "Why is this reliable?");
    await canvasPage.setViewportSize({ width: 390, height: 430 });
    await canvasPage.waitForFunction(() => {
      const surface = document.getElementById("ask").getBoundingClientRect();
      const viewport = window.visualViewport;
      return document.activeElement?.id === "ask-text" && surface.top >= viewport.offsetTop && surface.bottom <= viewport.offsetTop + viewport.height;
    });
    assert.equal(await canvasPage.evaluate(() => window.visualViewport?.scale), 1, `${engineName}: focusing the mobile question field must not zoom the page`);
    const commitMinHeight = await canvasPage.locator("#ask .ask-commit").evaluateAll((buttons) => Math.min(...buttons.map((button) => button.getBoundingClientRect().height)));
    assert(commitMinHeight >= 44, `${engineName}: mobile Note/Ask targets must be at least 44px tall (got ${commitMinHeight})`);
    assert.deepEqual(await canvasPage.locator("#ask .ask-commit kbd").evaluateAll((chips) => chips.map((chip) => getComputedStyle(chip).display !== "none")),
      [true, true], `${engineName}: mobile commit chips must stay visible`);
    await assertSelectionPopoverUsable(canvasPage);
    await canvasPage.click('#ask .ask-commit[data-commit="ask"]', { timeout: 4_000 });
    await canvasPage.waitForSelector("#ask:not(.visible)");
    await canvasPage.locator(".card:not(.root)", { hasText: "Mobile custom question completed." }).waitFor();
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
    await readerPage.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
    await readerPage.waitForFunction(() => !document.body.classList.contains("mode-flight"));
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
    await readerPage.click('#ask .lens[data-lens="explain"]');
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

async function verifyAnchoredNotes() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  try {
    await routeProvider(page, {
      streams: [
        ["TITLE: Command ask\n", "Command ask completed."],
        ["TITLE: Blank ask\n", "Blank ask completed."],
        ["TITLE: Lens ask\n", "Lens ask completed."],
        ["TITLE: Button ask\n", "Button ask completed."],
      ],
      providerDelayMs: 500,
    });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, [
      "# Anchored notes",
      "",
      "The first anchor belongs to an Enter-created note.",
      "",
      "The command anchor belongs to a keyboard-created ask.",
      "",
      "The restore anchor checks that clearing the draft restores lenses.",
      "",
      "The lens anchor checks the empty numeric shortcut.",
      "",
      "The typed lens anchor keeps numbers in the textarea.",
      "",
      "The click note anchor uses the labeled Note action.",
      "",
      "The click ask anchor uses the labeled Ask action.",
    ].join("\n"));

    await selectText(page, "first anchor");
    await page.waitForSelector("#ask.visible");
    assert.deepEqual(await composerRowState(page, "#ask"), { lensesVisible: true, commitsHidden: true },
      "an empty anchored popover should rest on its preset lenses and reaction pair");
    assert.deepEqual(await page.locator("#ask").evaluate((surface) => ({
      active: document.activeElement?.id,
      hasDraft: surface.classList.contains("has-draft"),
      askHighlight: CSS.highlights?.has("rh-ask") || false,
    })), { active: "ask-text", hasDraft: false, askHighlight: true },
    "an empty anchored popover should focus its input with the selection wash lit");
    await page.fill("#ask-text", "Enter-created marginalia");
    assert.deepEqual(await page.locator("#ask").evaluate((surface) => ({
      hasDraft: surface.classList.contains("has-draft"),
      lensesVisible: Array.from(surface.querySelectorAll(".lens")).every((button) => getComputedStyle(button).display !== "none"),
      commits: Array.from(surface.querySelectorAll(".ask-commit")).map((button) => ({
        label: button.childNodes[0].textContent.trim(),
        hint: button.querySelector("kbd")?.textContent,
        visible: getComputedStyle(button).display !== "none",
      })),
      askHighlight: CSS.highlights?.has("rh-ask") || false,
    })), {
      hasDraft: true,
      lensesVisible: false,
      commits: [
        { label: "Note", hint: "↵", visible: true },
        { label: "Ask", hint: "⌘↵", visible: true },
      ],
      askHighlight: true,
    }, "typing should swap preset lenses for the labeled commit actions");
    await page.keyboard.down("Control");
    await page.keyboard.up("Control");
    assert.equal(await page.evaluate(() => CSS.highlights?.has("rh-ask") || false), true,
      "the selection wash must stay put while typing or holding modifiers");
    const viewBeforeNote = await readCanvasView(page);
    const cardsBeforeNote = await page.locator(".card").count();
    await page.press("#ask-text", "Enter");
    await page.waitForSelector(".card.root .note-dot");
    await page.waitForTimeout(350);
    assert.deepEqual(await readCanvasView(page), viewBeforeNote, "creating an anchored note must preserve the exact canvas viewport");
    // A note about a card docks onto that card: wash, dot, and nothing else.
    assert.equal(await page.locator(".card").count(), cardsBeforeNote, "a docked note must not spawn a card");
    assert.equal(await page.locator(".card-note").count(), 0, "an anchored note is docked, never a window");
    assert.equal(await page.locator(".card.root mark.mark-ready.mark-note").count(), 1, "an HTML note should paint note ink on its parent");
    assert.deepEqual(await page.locator(".card.root .note-dot").evaluate((dot) => ({
      tag: dot.tagName, label: dot.getAttribute("aria-label"), popup: dot.getAttribute("aria-haspopup"),
      target: getComputedStyle(dot, "::before").width + " " + getComputedStyle(dot, "::before").height,
      insideCard: dot.getBoundingClientRect().right <= dot.closest(".card").getBoundingClientRect().right,
    })), {
      tag: "BUTTON", label: "Note: Enter-created marginalia", popup: "dialog",
      target: "24px 24px", insideCard: true,
    }, "the margin dot is a real button with a labelled 24px target inside the card's own padding");

    await selectText(page, "command anchor");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Why is this a command ask?");
    const viewBeforeAsk = await readCanvasView(page);
    await page.press("#ask-text", "Control+Enter");
    const commandAsk = page.locator(".card:not(.root)", { hasText: "Why is this a command ask?" });
    await commandAsk.waitFor();
    await page.waitForTimeout(350);
    assert.notDeepEqual(await readCanvasView(page), viewBeforeAsk, "creating an ask must retain its existing viewport reveal behavior");
    assert.equal(await commandAsk.locator(".loading").count(), 1, "Cmd/Ctrl+Enter should create a pending ask card");

    await selectText(page, "restore anchor");
    await page.waitForSelector("#ask.visible");
    const nodeCountBeforeBlank = await page.locator(".card").count();
    await page.fill("#ask-text", "temporary draft");
    await page.fill("#ask-text", "");
    assert.deepEqual(await composerRowState(page, "#ask"), { lensesVisible: true, commitsHidden: true },
      "emptying the textarea should hide commits while keeping the presets");
    assert.deepEqual(await page.locator("#ask").evaluate((surface) => ({
      hasDraft: surface.classList.contains("has-draft"),
      askHighlight: CSS.highlights?.has("rh-ask") || false,
    })), { hasDraft: false, askHighlight: true }, "emptying the textarea should restore rest state and ask ink");
    await page.press("#ask-text", "Enter");
    assert.equal(await page.locator(".card").count(), nodeCountBeforeBlank, "blank Enter must be inert");
    assert.equal(await page.locator("#ask.visible").count(), 1, "blank Enter must leave the popover open");
    await page.press("#ask-text", "Control+Enter");
    const blankAsk = page.locator(".card:not(.root)", { has: page.locator(".card-title", { hasText: /^…$/ }) });
    await blankAsk.waitFor();
    assert.equal(await blankAsk.locator(".loading").count(), 1, "blank Cmd/Ctrl+Enter should retain the pending ellipsis ask");

    await selectText(page, "lens anchor");
    await page.waitForSelector("#ask.visible");
    const beforeLens = await page.locator(".card").count();
    await page.press("#ask-text", "1");
    await page.waitForFunction((count) => document.querySelectorAll(".card").length === count + 1, beforeLens);
    const lensState = await page.evaluate(() => window.__rabbitholeTest.readStoredHole());
    assert.equal(lensState.nodes.at(-1).origin?.lens, "explain", "1 should submit the Explain lens while the box is empty");

    await selectText(page, "typed lens anchor");
    await page.waitForSelector("#ask.visible");
    const beforeTypedLens = await page.locator(".card").count();
    await page.fill("#ask-text", "draft");
    await page.press("#ask-text", "1");
    assert.equal(await page.inputValue("#ask-text"), "draft1", "lens number keys should type normally once the box is non-empty");
    assert.equal(await page.locator(".card").count(), beforeTypedLens, "a lens key must not submit while text is present");
    await page.keyboard.press("Escape");

    await selectText(page, "click note anchor");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Button-created marginalia");
    await page.click('#ask .ask-commit[data-commit="note"]');
    await page.waitForFunction(() => document.querySelectorAll(".card.root .note-dot").length === 2);

    await selectText(page, "click ask anchor");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Button-created ask");
    await page.click('#ask .ask-commit[data-commit="ask"]');
    await page.locator(".card:not(.root)", { hasText: "Button-created ask" }).waitFor();

    await page.waitForFunction(async () => {
      const hole = await window.__rabbitholeTest.readStoredHole();
      return hole.nodes.filter((node) => node.origin?.kind === "note").length === 2;
    });
    const persisted = await page.evaluate(() => window.__rabbitholeTest.readStoredHole());
    const notes = persisted.nodes.filter((node) => node.origin?.kind === "note");
    assert.deepEqual(notes.map((node) => ({ title: node.title, markdown: node.markdown, status: node.status, read: node.read,
      selected: node.origin.selected_text, docked: node.extensions?.note?.docked, size: node.size })), [
      { title: "Note", markdown: "Enter-created marginalia", status: "answered", read: true, selected: "first anchor", docked: true, size: null },
      { title: "Note", markdown: "Button-created marginalia", status: "answered", read: true, selected: "click note anchor", docked: true, size: null },
    ], "node_create should persist both docked anchored notes with no canvas geometry");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".note-dot");
    await page.waitForFunction(() => document.querySelectorAll(".card.root .note-dot").length === 2);
    assert.equal(await page.locator(".card-note").count(), 0, "docked notes must rehydrate onto their card, not as windows");
    assert.equal(await page.locator(".card.root mark.mark-note").count(), 2, "persisted HTML note marks should rebuild on hydration");
    console.log("ok web app: anchored morphing actions, commit keys, honest preview, docked note ink and dots, and persistence");
  } finally {
    await context.close();
  }
}

/* The docked note's whole life: read it, edit it, walk Escape back out of it,
   write one about the card itself, place it on the canvas, and find every one
   of them again after a reload. */
async function verifyDockedNotes() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await routeProvider(page);
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, [
      "# Docked notes",
      "",
      "The first anchor and the second anchor share one line of this document.",
      "",
      "The third anchor lives one paragraph further down the page.",
    ].join("\n"));
    const rootCard = page.locator(".card.root");
    const popover = page.locator("#notepop");
    const noteIds = async () => page.evaluate(async () =>
      (await window.__rabbitholeTest.readStoredHole()).nodes.filter((node) => node.origin?.kind === "note").map((node) => node.id));

    async function dockNote(selection, markdown) {
      const notesBefore = (await noteIds()).length;
      const dotsBefore = await page.locator(".card.root .note-dot").count();
      await selectText(page, selection);
      await page.waitForSelector("#ask.visible");
      await page.fill("#ask-text", markdown);
      await page.click('#ask .ask-commit[data-commit="note"]');
      await page.waitForFunction((count) => document.querySelectorAll(".card.root .note-dot").length === count, dotsBefore + 1);
      const hole = await waitForStoredHole(page, (stored) => stored.nodes.filter((node) => node.origin?.kind === "note").length === notesBefore + 1,
        "the docked note to persist");
      return hole.nodes.find((node) => node.markdown === markdown).id;
    }

    async function selectPopoverText() {
      await page.locator("#notepop .doc-content").evaluate((surface) => {
        const text = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT).nextNode();
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, text.textContent.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
    }

    // The unadvertised power chord keeps the pre-docking outcome: one note
    // born with geometry and a standard parent edge, never a transient dot.
    await selectText(page, "this document");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "A directly placed selection note");
    assert.deepEqual(await page.locator("#ask").evaluate((surface) => ({
      chips: Array.from(surface.querySelectorAll("kbd")).map((chip) => chip.textContent),
      commitKinds: Array.from(surface.querySelectorAll("[data-commit]")).map((button) => button.dataset.commit),
      advertisesShift: Array.from(surface.querySelectorAll("button")).some((button) => /shift|⇧/i.test(button.title + button.textContent)),
    })), { chips: ["1", "2", "3", "↑", "↓", "↵", "⌘↵"], commitKinds: ["note", "ask"], advertisesShift: false },
    "the selection composer must not advertise the direct-placement chord");
    await page.press("#ask-text", "Control+Shift+Enter");
    const directPlaced = page.locator(".card-note", { hasText: "A directly placed selection note" });
    await directPlaced.waitFor();
    const directPlacedId = await directPlaced.getAttribute("data-id");
    const directStored = await waitForStoredHole(page, (hole) => {
      const note = hole.nodes.find((node) => node.id === directPlacedId);
      return note?.position && note?.size && !note.extensions?.note?.docked;
    }, "the power-chord note to persist with geometry").then((hole) => hole.nodes.find((node) => node.id === directPlacedId));
    assert.deepEqual({ docked: directStored.extensions?.note?.docked ?? false, size: directStored.size,
      edge: await page.locator(`#edges path[data-child="${directPlacedId}"]`).count(),
      dot: await page.locator(`.note-dot[data-note="${directPlacedId}"]`).count(),
      selected: directStored.origin.selected_text },
    { docked: false, size: { w: 420, h: 460 }, edge: 1, dot: 0, selected: "this document" },
    "Cmd/Ctrl+Shift+Enter should create a placed note window with its parent edge in one commit");

    const firstId = await dockNote("first anchor", "The first docked note");
    const secondId = await dockNote("second anchor", "The second docked note");

    // Dots sit on their anchors' lines, in document order, and step apart when
    // two anchors share one line.
    const column = await page.locator(".card.root .note-dot").evaluateAll((dots) => dots.map((dot) => {
      const box = dot.getBoundingClientRect();
      const mark = document.querySelector(`mark[data-child="${dot.dataset.note}"]`).getBoundingClientRect();
      // The visible ink (and its hover grow) lives on ::after; the button's own
      // box is the popover anchor and must stay untransformed.
      const ink = getComputedStyle(dot, "::after");
      const hit = getComputedStyle(dot, "::before");
      return { id: dot.dataset.note, top: parseFloat(dot.style.top),
        offLine: (box.top + box.height / 2) - (mark.top + mark.height / 2),
        size: { width: box.width, height: box.height }, hit: { width: hit.width, height: hit.height },
        transition: { duration: ink.transitionDuration, timing: ink.transitionTimingFunction } };
    }));
    assert.deepEqual(column.map((dot) => dot.id), [firstId, secondId], "dots follow the order of the anchors they mark");
    assert(Math.abs(column[0].offLine) < 2, `the first dot should sit on its anchor's line: ${JSON.stringify(column)}`);
    assert(column[1].top - column[0].top >= 14 && column[1].offLine >= 12,
      `a second dot on the same line should nudge off it, not overlap: ${JSON.stringify(column)}`);
    assert.deepEqual(column.map(({ size, hit }) => ({ size, hit })), [
      { size: { width: 7, height: 7 }, hit: { width: "24px", height: "24px" } },
      { size: { width: 7, height: 7 }, hit: { width: "24px", height: "24px" } },
    ], "anchored note dots should shrink to 7px without shrinking their 24px targets");
    assert(column.every((dot) => dot.transition.duration.startsWith("0.12s")
      && dot.transition.timing.startsWith("cubic-bezier(0.23, 1, 0.32, 1)")),
    `dot motion should use the fast, restrained ease-out transition: ${JSON.stringify(column)}`);

    // Click reads, double click edits — on the dot and on the wash alike.
    await page.locator(`.note-dot[data-note="${firstId}"]`).click();
    await popover.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getElementById("notepop").contains(document.activeElement));
    assert.deepEqual(await popover.evaluate((surface) => ({
      role: surface.getAttribute("role"),
      text: surface.querySelector(".note-pop-view").textContent.trim(),
      focusInside: surface.contains(document.activeElement),
      actions: Array.from(surface.querySelectorAll(".note-pop-actions button"))
        .filter((button) => getComputedStyle(button).display !== "none").map((button) => ({
          label: Array.from(button.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim(),
          chip: button.querySelector("kbd")?.textContent ?? null,
          icon: !!button.querySelector("svg"),
          ariaLabel: button.getAttribute("aria-label"),
          shortcuts: button.getAttribute("aria-keyshortcuts"),
        })),
      viewStyle: (() => {
        const style = getComputedStyle(surface.querySelector(".note-pop-view"));
        return { background: style.backgroundColor, borderLeft: style.borderLeftWidth,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft] };
      })(),
      editors: surface.querySelectorAll(".note-editor").length,
    })), { role: "dialog", text: "The first docked note", focusInside: true,
      actions: [
        { label: "", chip: null, icon: true, ariaLabel: "Delete note", shortcuts: "Backspace Delete" },
        { label: "Ask", chip: null, icon: false, ariaLabel: null, shortcuts: null },
        { label: "Place on canvas", chip: "⌘↵", icon: false, ariaLabel: null, shortcuts: "Meta+Enter Control+Enter" },
      ], viewStyle: { background: "rgba(0, 0, 0, 0)", borderLeft: "0px", padding: ["8px", "10px", "8px", "10px"] },
      editors: 0 },
    "read state: icon-only delete on the left, one-gesture Ask, and Place on canvas on the right");
    await selectPopoverText();
    assert.equal(await page.locator("#ask.visible").count(), 0,
      "selecting text in a docked note's read state must not open the selection popover");
    const chipParity = await popover.evaluate((surface) => {
      const signature = (chip) => {
        const style = getComputedStyle(chip);
        return [style.display.replace(/^inline-/, ""), style.fontFamily, style.fontSize, style.fontWeight, style.minWidth,
          style.height, style.padding, style.lineHeight, style.borderRadius, style.backgroundColor];
      };
      return {
        composer: signature(document.querySelector('#ask .ask-commit[data-commit="ask"] kbd')),
        note: signature(surface.querySelector(".note-pop-place kbd")),
      };
    });
    assert.deepEqual(chipParity.note, chipParity.composer, "read actions must reuse the composer chip pixel for pixel");

    // One footer, constant geometry, and a text origin that never moves: the
    // read state's measurements are the edit state's, glyph for glyph. The
    // popover slides in over --popover-speed, so let the transform settle first.
    await page.waitForFunction(() => {
      const transform = getComputedStyle(document.getElementById("notepop")).transform;
      return transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
    });
    const readState = await popover.evaluate((surface) => {
      const bar = surface.querySelector(".note-pop-actions");
      const barRect = bar.getBoundingClientRect();
      const view = surface.querySelector(".note-pop-view");
      window.__popoverNoteDocument = view.querySelector(".doc-content");
      const viewRect = view.getBoundingClientRect();
      const viewStyle = getComputedStyle(view);
      const range = document.createRange();
      const first = document.createTreeWalker(view, NodeFilter.SHOW_TEXT).nextNode();
      range.setStart(first, 0); range.setEnd(first, 1);
      const glyph = range.getBoundingClientRect();
      const buttons = Array.from(bar.querySelectorAll("button")).map((button) => button.getBoundingClientRect().left);
      return {
        bar: { left: barRect.left, top: barRect.top, width: barRect.width, height: barRect.height },
        hairline: getComputedStyle(bar).borderTopWidth,
        deleteLeftOfPlace: buttons[0] < buttons[1],
        origin: { left: viewRect.left + parseFloat(viewStyle.paddingLeft), top: viewRect.top + parseFloat(viewStyle.paddingTop) },
        glyph: { left: glyph.left, top: glyph.top },
      };
    });
    assert.equal(readState.hairline, "1px", "the read footer wears the composer bar's own hairline");
    assert.equal(readState.deleteLeftOfPlace, true, "destructive sits on the left, the primary verb on the right");

    await popover.locator(".note-pop-view").dblclick();
    await popover.locator(".note-editor").waitFor();
    await selectPopoverText();
    assert.equal(await page.locator("#ask.visible").count(), 0,
      "selecting text in a docked note's edit state must not open the selection popover");
    assert.deepEqual(await popover.locator(".ask-commit").evaluateAll((buttons) => buttons.map((button) => ({
      commit: button.dataset.commit, hint: button.querySelector("kbd")?.textContent }))), [
      { commit: "note", hint: "↵" }, { commit: "ask", hint: "⌘↵" },
    ], "the popover edits with the composer's own bar");
    const editState = await popover.evaluate((surface) => {
      const bar = surface.querySelector(".note-pop-actions");
      const barRect = bar.getBoundingClientRect();
      const editor = surface.querySelector(".note-editor");
      const view = surface.querySelector(".note-pop-view");
      const range = document.createRange();
      const first = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT).nextNode();
      range.setStart(first, 0); range.setEnd(first, 1);
      const glyph = range.getBoundingClientRect();
      const wrapStyle = getComputedStyle(view);
      return {
        bar: { left: barRect.left, top: barRect.top, width: barRect.width, height: barRect.height },
        hairline: getComputedStyle(bar).borderTopWidth,
        bars: surface.querySelectorAll(".ask-actions, .note-pop-actions").length,
        sameSurface: editor === window.__popoverNoteDocument,
        glyph: { left: glyph.left, top: glyph.top },
        chrome: { background: wrapStyle.backgroundColor, borderLeft: wrapStyle.borderLeftWidth, radius: wrapStyle.borderRadius },
      };
    });
    const near = (a, b) => Math.abs(a - b) < 0.6;
    assert(["left", "top", "width", "height"].every((side) => near(editState.bar[side], readState.bar[side])),
      `read→edit must not move or resize the footer bar: ${JSON.stringify({ readState, editState })}`);
    assert.equal(editState.hairline, "1px", "the edit footer keeps the same hairline");
    assert.equal(editState.bars, 1, "one footer bar, never a second");
    assert.equal(editState.sameSurface, true, "the popover must edit its existing rendered document surface");
    assert(near(editState.glyph.left, readState.glyph.left) && near(editState.glyph.top, readState.glyph.top),
      `entering edit must not shift the first glyph: ${JSON.stringify({ readState, editState })}`);
    assert.deepEqual(editState.chrome, { background: "rgba(0, 0, 0, 0)", borderLeft: "0px", radius: "0px" },
      "the edit state is plain: no wash, no left rule, no radius");
    const originalRootLeft = await rootCard.evaluate((card) => {
      const left = card.style.left;
      card.style.left = "733px";
      return left;
    });
    const editor = popover.locator(".note-editor");
    await editor.fill("");
    await editor.focus();
    await page.keyboard.type("t ");
    await page.waitForTimeout(50);
    assert.equal(await rootCard.evaluate((card) => card.style.left), "733px",
      "typing t in a docked-note editor must not tidy the canvas");
    assert.equal((await editor.textContent()).replaceAll("\u00a0", " ").replace(/\n+$/, ""), "t ",
      "single-key shortcuts must type into a docked-note editor");
    await rootCard.evaluate((card, left) => { card.style.left = left; }, originalRootLeft);
    await popover.locator(".note-editor").fill("Text that Escape must throw away");
    await page.keyboard.press("Escape");
    await popover.locator(".note-pop-view").waitFor();
    assert.equal((await popover.locator(".note-pop-view").innerText()).trim(), "The first docked note",
      "Escape from the editor reverts to the note as saved");
    const revertGlyph = await popover.evaluate((surface) => {
      const view = surface.querySelector(".note-pop-view");
      const range = document.createRange();
      const first = document.createTreeWalker(view, NodeFilter.SHOW_TEXT).nextNode();
      range.setStart(first, 0); range.setEnd(first, 1);
      const glyph = range.getBoundingClientRect();
      return { left: glyph.left, top: glyph.top };
    });
    assert(near(revertGlyph.left, readState.glyph.left) && near(revertGlyph.top, readState.glyph.top),
      `a read→edit→read round trip must land the first glyph exactly where it was: ${JSON.stringify({ readState, revertGlyph })}`);
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("note-dot")), true,
      "closing returns focus to the affordance that opened it");

    // Double-clicking the wash edits, Shift+Enter is a newline, and Enter saves
    // and returns to the read state.
    await rootCard.locator(`mark[data-child="${firstId}"]`).dblclick();
    await popover.locator(".note-editor").waitFor();
    await popover.locator(".note-editor").fill("The first docked note, revised");
    await popover.locator(".note-editor").press("Shift+Enter");
    assert.match(await popover.locator(".note-editor").innerText(), /revised\n/, "Shift+Enter creates a new line inside a note");
    await popover.locator(".note-editor").press("Enter");
    await popover.locator(".note-pop-view").waitFor();
    assert.equal((await popover.locator(".note-pop-view").innerText()).trim(), "The first docked note, revised",
      "saving returns to the read state showing what was written");
    await waitForStoredHole(page, (hole) => hole.nodes.find((node) => node.id === firstId)?.markdown === "The first docked note, revised",
      "the edited note to persist");
    await page.keyboard.press("Escape");

    // The dot answers the same grammar as the wash: one click reads, two edit.
    await page.locator(`.note-dot[data-note="${firstId}"]`).dblclick();
    await popover.locator(".note-editor").waitFor();
    assert.equal((await popover.locator(".note-editor").innerText()).trim(), "The first docked note, revised",
      "double-clicking the dot opens the note for editing");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });

    // A note about the whole card: the card's own composer creates a visible
    // child window. The ⋯ menu carries no "Add note" of its own — one entry
    // point, one path.
    await rootCard.locator(".card-more").click();
    assert.equal(await page.locator("#cm-note").count(), 0,
      "the card menu offers no Add note anywhere — the card composer is the way in");
    await page.keyboard.press("Escape");
    await rootCard.locator(".nc-handle").click();
    await rootCard.locator(".nc-inner textarea").fill("A note about this whole card");
    await rootCard.locator('.nc-inner .ask-commit[data-commit="note"]').click();
    const wholeCard = page.locator(".card-note", { hasText: "A note about this whole card" });
    await wholeCard.waitFor();
    const wholeId = await wholeCard.getAttribute("data-id");
    const wholeStored = await waitForStoredHole(page, (hole) => {
      const note = hole.nodes.find((node) => node.id === wholeId);
      return note?.size && !note.extensions?.note?.docked;
    }, "the whole-card note window to persist").then((hole) => hole.nodes.find((node) => node.id === wholeId));
    assert.deepEqual({ size: wholeStored.size, edge: await page.locator(`#edges path[data-child="${wholeId}"]`).count(),
      dot: await page.locator(`.note-dot[data-note="${wholeId}"]`).count() },
    { size: { w: 420, h: 460 }, edge: 1, dot: 0 },
    "the follow-up Note action should create a visible child window with standard canvas geometry");
    await page.keyboard.press("Escape");

    // The 24px hit targets are clipped at the dot layer, never at the pointer:
    // a docked note must not hand the card body a horizontal scrollbar, and
    // the fat target must keep catching clicks beyond the dot's own ink.
    assert.deepEqual(await rootCard.locator(".card-body").evaluate((body) => {
      const dot = body.querySelector(".note-dot");
      const box = dot.getBoundingClientRect();
      const hits = (x, y) => document.elementFromPoint(x, y) === dot;
      return {
        horizontalOverflow: body.scrollWidth - body.clientWidth,
        centerHits: hits(box.left + box.width / 2, box.top + box.height / 2),
        haloHits: hits(box.left - box.width * 0.6, box.top + box.height / 2),
      };
    }), { horizontalOverflow: 0, centerHits: true, haloHits: true },
    "docked dots must add no horizontal scroll to the card body while their 24px targets keep catching the pointer");

    // Reader: the same notes, in the reader's real margin.
    await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
    await page.waitForSelector("body:not(.mode-canvas) #reader-rail");
    await page.waitForFunction(() => document.querySelectorAll("#reader-main .note-dot").length === 2);
    assert.deepEqual(await page.locator("#reader-main .note-dot").evaluateAll((dots) => {
      const column = document.querySelector(".reader-col").getBoundingClientRect();
      return dots.map((dot) => Math.round(dot.getBoundingClientRect().left - column.right));
    }), [12, 12], "reader dots stand in the real margin, 12px past the column edge");
    assert.deepEqual(await page.locator("#reader-main").evaluate((main) => {
      const dot = main.querySelector(".note-dot");
      const box = dot.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { horizontalOverflow: main.scrollWidth - main.clientWidth, centerHits: hit === dot };
    }), { horizontalOverflow: 0, centerHits: true },
    "margin dots must add no horizontal scroll to the reader while staying clickable");
    assert.deepEqual(await page.locator("#margin-notes .side-item").evaluateAll((items) => items.map((item) => item.dataset.child)),
      [directPlacedId, wholeId], "placed notes belong in the branch rail; docked annotations stay out");
    await page.keyboard.press("Escape");
    await page.waitForSelector("body.mode-canvas");
    await page.waitForTimeout(300);

    // Collapsed cards hide the body, and with it the margin.
    await rootCard.locator(".card-collapse").click();
    await page.waitForTimeout(120);
    assert.equal(await page.locator(".note-dot:visible").count(), 0, "a collapsed card shows no dots");
    await rootCard.locator(".card-collapse").click();
    await page.waitForFunction(() => document.querySelectorAll(".card.root .note-dot").length === 2);

    // Place on canvas: the same node, now with a place.
    const cardsBefore = await page.locator(".card").count();
    await page.locator(`.note-dot[data-note="${secondId}"]`).click();
    await popover.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getElementById("notepop").contains(document.activeElement));
    await page.keyboard.press("Control+Enter");
    await page.waitForSelector(`.card[data-id="${secondId}"]`);
    await waitForStoredHole(page, (hole) => {
      const note = hole.nodes.find((node) => node.id === secondId);
      return note?.size && !note.extensions?.note?.docked;
    }, "the read-shortcut placement to persist");
    await page.waitForTimeout(700);
    const placed = await page.evaluate(async (id) => {
      const stored = (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id);
      const card = document.querySelector(`.card[data-id="${id}"]`);
      const root = document.querySelector(".card.root");
      return {
        docked: stored.extensions?.note?.docked ?? false,
        position: stored.position, size: stored.size, markdown: stored.markdown,
        rightOfParent: parseFloat(card.style.left) > parseFloat(root.style.left),
        edges: document.querySelectorAll(`#edges path[data-child="${id}"]`).length,
        dashed: getComputedStyle(document.querySelector(`#edges path[data-child="${id}"]`)).strokeDasharray,
        dots: root.querySelectorAll(`.note-dot[data-note="${id}"]`).length,
        // The FLIP flight animates the real card and must leave no residue.
        flight: (card.style.transform || "") + (card.style.opacity || "") + (card.style.willChange || ""),
        mark: root.querySelectorAll(`mark[data-child="${id}"].mark-note`).length,
      };
    }, secondId);
    assert.deepEqual({ docked: placed.docked, size: placed.size, dots: placed.dots, edges: placed.edges,
      dashed: placed.dashed, flight: placed.flight, mark: placed.mark, rightOfParent: placed.rightOfParent },
    { docked: false, size: { w: 420, h: 460 }, dots: 0, edges: 1, dashed: "none", flight: "", mark: 1, rightOfParent: true },
    `the read-state place shortcut clears the flag, lands a standard-edged card near its parent, and retires the dot: ${JSON.stringify(placed)}`);
    assert.equal(await page.locator(".card").count(), cardsBefore + 1, "placing adds exactly one card");
    assert.equal(placed.markdown, "The second docked note", "placement never touches the note's words");

    // The wash goes back to being an ordinary child mark: it flies the canvas to
    // the card instead of opening the note in place.
    const viewBeforeMark = await readCanvasView(page);
    await rootCard.locator(`mark[data-child="${secondId}"]`).click();
    await page.waitForTimeout(420);
    assert.equal(await page.locator("#notepop.visible").count(), 0, "a placed note's wash no longer opens the note dialog");
    assert.notDeepEqual(await readCanvasView(page), viewBeforeMark,
      "a placed note's mark navigates to its card like any other branch");

    // Delete from the read state, no confirmation.
    await page.locator(`.note-dot[data-note="${firstId}"]`).click();
    await popover.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getElementById("notepop").contains(document.activeElement));
    await page.keyboard.press("Backspace");
    await page.waitForFunction((id) => !document.querySelector(`.note-dot[data-note="${id}"]`), firstId);
    assert.equal(await rootCard.locator(`mark[data-child="${firstId}"]`).count(), 0, "deleting a docked note takes its wash with it");
    // Deletion keeps the product's one exact undo: the removal commits when the
    // toast expires, which is also when the store may forget the note.
    await waitForStoredHole(page, (hole) => !hole.nodes.some((node) => node.id === firstId), "the removal to commit", 15000);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".card-note");
    await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => ({
      dots: document.querySelectorAll(".note-dot").length,
      whole: document.querySelectorAll(".note-dot-whole").length,
      noteCards: document.querySelectorAll(".card-note").length,
    })), { dots: 0, whole: 0, noteCards: 3 },
    "a reload keeps follow-up notes as windows and rebuilds any remaining docked annotations");

    // Asking from the read-state dot popover is one gesture: the note gains a
    // place and becomes the question, so the answer has something to hang from.
    const askId = await dockNote("third anchor", "Should this become a question?");
    await page.locator(`.note-dot[data-note="${askId}"]`).click();
    await popover.locator(".note-pop-ask").click();
    await page.waitForSelector(`.card[data-id="${askId}"]`);
    await page.locator(`.card[data-id="${askId}"]`, { hasText: "Fallback streamed document." }).waitFor();
    assert.equal(await page.locator(`.note-dot[data-note="${askId}"]`).count(), 0, "a note that became an ask leaves the margin");
    const asked = await waitForStoredHole(page, (hole) => {
      const node = hole.nodes.find((entry) => entry.id === askId);
      return node?.origin?.question && node.position.x > 0 && !node.extensions?.note?.docked;
    }, "the converted ask to persist").then((hole) => hole.nodes.find((node) => node.id === askId));
    assert.deepEqual({ question: asked.origin.question, selected: asked.origin.selected_text, docked: asked.extensions?.note?.docked ?? false,
      placed: asked.position.x > 0 }, { question: "Should this become a question?", selected: "third anchor", docked: false, placed: true },
    "the ask keeps the note's anchor, loses the dock, and keeps the place it was just given");
    const treatments = await page.evaluate(({ noteId, askId }) => {
      const html = document.documentElement;
      const previous = html.getAttribute("data-theme");
      const rgb = (value) => {
        const channels = (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        return value.startsWith("color(srgb") ? channels.map((channel) => channel * 255) : channels;
      };
      const luminance = (value) => {
        const channels = rgb(value).map((channel) => {
          channel /= 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const contrast = (a, b) => {
        const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const signature = (card) => ({
        body: getComputedStyle(card).backgroundColor,
        head: getComputedStyle(card.querySelector(".card-head")).backgroundColor,
        border: getComputedStyle(card).borderTopColor,
      });
      const result = ["light", "dark"].map((theme) => {
        html.setAttribute("data-theme", theme);
        const note = document.querySelector(`.card[data-id="${noteId}"]`);
        const noteStyle = signature(note);
        const text = getComputedStyle(note.querySelector(".doc-content")).color;
        return { theme, note: noteStyle, plain: signature(document.querySelector(".card.root")),
          ask: signature(document.querySelector(`.card[data-id="${askId}"]`)),
          contrast: contrast(text, noteStyle.body) };
      });
      if (previous == null) html.removeAttribute("data-theme"); else html.setAttribute("data-theme", previous);
      return result;
    }, { noteId: directPlacedId, askId });
    for (const treatment of treatments) {
      assert.notEqual(treatment.note.body, treatment.plain.body, `${treatment.theme}: a placed note needs its own body wash`);
      assert.notEqual(treatment.note.head, treatment.plain.head, `${treatment.theme}: a placed note needs its own header wash`);
      assert.notEqual(treatment.note.body, treatment.ask.body, `${treatment.theme}: note and ask bodies must not collapse to one treatment`);
      assert.notEqual(treatment.note.head, treatment.ask.head, `${treatment.theme}: note and ask headers must not collapse to one treatment`);
      assert.notEqual(treatment.note.border, treatment.ask.border, `${treatment.theme}: note and ask borders must not collapse to one treatment`);
      assert(treatment.contrast >= 4.5, `${treatment.theme}: placed-note prose contrast should remain accessible (${treatment.contrast})`);
    }
    console.log("ok web app: docked notes read, edit, place, delete, ask, and rehydrate on their card");
  } finally {
    await context.close();
  }
}

/* A dot is annotation chrome, never document geometry. Exercise both hosts
   with prose whose last word really does wrap when an inline mark gains even
   two pixels: this catches the visible reflow, not just a container width. */
async function verifyDockedNoteTextGeometry() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await routeProvider(page);
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, [
      "# Docked note geometry",
      "",
      "Amber bicycles cross deliberate gardens while patient readers follow every branching sentence through quiet graphite margins without surrendering the generous measure of the surrounding document canvas Amber.",
      "",
      "Amber bicycles cross deliberate gardens while patient readers follow every branching sentence through quiet graphite margins without surrendering the generous measure of surrounding document canvas precise overlay.",
    ].join("\n"));
    assert.equal(await page.locator(".card.root .card-body").evaluate((body) => getComputedStyle(body).paddingRight), "12px",
      "document text should use the card measure up to the dot lane");
    const cardBefore = await measureTextGeometry(page, ".card.root .card-body", "surrounding document canvas Amber");
    await selectText(page, "surrendering");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Canvas geometry note");
    await page.click('#ask .ask-commit[data-commit="note"]');
    await page.waitForFunction(() => document.querySelectorAll(".card.root .note-dot").length === 1);
    const cardAfter = await measureTextGeometry(page, ".card.root .card-body", "surrounding document canvas Amber");
    assertDockedNoteGeometry(cardAfter, cardBefore, "canvas card text must not move when its first docked note appears");
    await page.locator(".card.root .note-dot").hover();
    assertDockedNoteGeometry(
      await measureTextGeometry(page, ".card.root .card-body", "surrounding document canvas Amber"),
      cardAfter,
      "hovering a canvas dot must not move card text",
    );

    await page.evaluate(() => document.querySelector(".card.root [aria-label='Expand document']").click());
    await page.waitForSelector("body:not(.mode-canvas) #reader-main .note-dot");
    await page.waitForTimeout(400);
    const readerBefore = await measureTextGeometry(page, "#reader-main .reader-col", "surrounding document canvas precise overlay");
    await selectText(page, "overlay", "#reader-main .doc-content[data-node-id]");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Reader geometry note");
    await page.click('#ask .ask-commit[data-commit="note"]');
    await page.waitForFunction(() => document.querySelectorAll("#reader-main .note-dot").length === 2);
    const readerAfter = await measureTextGeometry(page, "#reader-main .reader-col", "surrounding document canvas precise overlay");
    assertDockedNoteGeometry(readerAfter, readerBefore, "reader text must not move when another docked note appears");
    await page.locator("#reader-main .note-dot").last().hover();
    assertDockedNoteGeometry(
      await measureTextGeometry(page, "#reader-main .reader-col", "surrounding document canvas precise overlay"),
      readerAfter,
      "hovering a reader dot must not move reader text",
    );
    await page.locator("#reader-main .note-dot").last().click();
    await page.waitForSelector("#notepop.visible");
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => document.querySelectorAll("#reader-main .note-dot").length === 1);
    assertDockedNoteGeometry(
      await measureTextGeometry(page, "#reader-main .reader-col", "surrounding document canvas precise overlay"),
      readerBefore,
      "removing a reader dot must not move reader text",
    );
    console.log("ok web app: docked notes have zero text geometry impact in cards and reader");
  } finally {
    await context.close();
  }
}

function assertDockedNoteGeometry(actual, expected, message) {
  assert.equal(actual.columnWidth, expected.columnWidth, `${message}: text column width`);
  assert.deepEqual(actual.edgeLines, expected.edgeLines, `${message}: first and last line rects`);
  assert.deepEqual(actual.lineTexts, expected.lineTexts, `${message}: visual line breaks`);
}

async function measureTextGeometry(page, surfaceSelector, paragraphNeedle) {
  return page.evaluate(({ surfaceSelector, paragraphNeedle }) => {
    const surface = document.querySelector(surfaceSelector);
    const column = surface.querySelector(".doc-content");
    const paragraph = Array.from(column.querySelectorAll("p"))
      .find((candidate) => candidate.textContent.includes(paragraphNeedle));
    if (!paragraph) throw new Error(`Geometry paragraph not found: ${paragraphNeedle}`);
    const characters = [];
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let offset = 0; offset < node.length; offset += 1) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        characters.push({ char: node.data[offset], rect });
      }
    }
    const lines = [];
    for (const character of characters) {
      let line = lines.find((candidate) => Math.abs(candidate.top - character.rect.top) < 0.1);
      if (!line) {
        line = { top: character.rect.top, characters: [] };
        lines.push(line);
      }
      line.characters.push(character);
    }
    const quarterPixel = (value) => Math.round(value * 4) / 4;
    const lineGeometry = (line) => {
      const ink = line.characters.filter(({ char }) => /\S/.test(char));
      const left = Math.min(...ink.map(({ rect }) => rect.left));
      const right = Math.max(...ink.map(({ rect }) => rect.right));
      const top = Math.min(...ink.map(({ rect }) => rect.top));
      const bottom = Math.max(...ink.map(({ rect }) => rect.bottom));
      return { text: line.characters.map(({ char }) => char).join("").trim(),
        left: quarterPixel(left), right: quarterPixel(right), top: quarterPixel(top), bottom: quarterPixel(bottom),
        width: quarterPixel(right - left), height: quarterPixel(bottom - top) };
    };
    return {
      columnWidth: quarterPixel(column.getBoundingClientRect().width),
      edgeLines: [lineGeometry(lines[0]), lineGeometry(lines.at(-1))],
      lineTexts: lines.map((line) => line.characters.map(({ char }) => char).join("").trim()),
    };
  }, { surfaceSelector, paragraphNeedle });
}

/* WYSIWYG between the popover's two states: for plain text the note dialog is
   exactly as tall reading as it is editing — single line, multi-paragraph, and
   at the long-note clamp — and an Enter save leaves no focus ring behind. */
async function verifyNotePopoverWysiwyg() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await routeProvider(page);
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, [
      "# Popover WYSIWYG",
      "",
      "The first anchor and the second anchor share one line of this document.",
      "",
      "The third anchor lives one paragraph further down the page.",
    ].join("\n"));
    const popover = page.locator("#notepop");

    async function dockNote(selection, markdown) {
      const before = await page.evaluate(async () =>
        (await window.__rabbitholeTest.readStoredHole()).nodes.filter((node) => node.origin?.kind === "note").length);
      await selectText(page, selection);
      await page.waitForSelector("#ask.visible");
      await page.fill("#ask-text", markdown);
      await page.click('#ask .ask-commit[data-commit="note"]');
      const hole = await waitForStoredHole(page, (stored) =>
        stored.nodes.filter((node) => node.origin?.kind === "note").length === before + 1, "the docked note to persist");
      return hole.nodes.find((node) => node.markdown === markdown).id;
    }

    async function popoverHeights(id) {
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.locator(`.note-dot[data-note="${id}"]`).click();
      await popover.waitFor({ state: "visible" });
      await popover.locator(".note-pop-view").waitFor();
      // The popover slides in over --popover-speed; measure only once settled.
      await page.waitForFunction(() => {
        const transform = getComputedStyle(document.getElementById("notepop")).transform;
        return transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
      });
      const read = await popover.evaluate((surface) => surface.getBoundingClientRect().height);
      await popover.locator(".note-pop-view").dblclick();
      await popover.locator(".note-editor").waitFor();
      const edit = await popover.evaluate((surface) => surface.getBoundingClientRect().height);
      return { read, edit };
    }

    const singleId = await dockNote("first anchor", "A one line plain note");
    const multiId = await dockNote("second anchor",
      "First paragraph of the note.\n\nSecond paragraph after a blank line.\n\nThird paragraph rounds it out.");
    const longId = await dockNote("third anchor", Array.from({ length: 14 }, (_, index) =>
      `Line ${index + 1} of a very long note that must hit the shared clamp.`).join("\n\n"));

    // Exact WYSIWYG: a plain-text note keeps one popover height across states.
    const single = await popoverHeights(singleId);
    assert(Math.abs(single.edit - single.read) < 1,
      `a single-line note must keep the same popover height in read and edit: ${JSON.stringify(single)}`);

    // Enter returns to the read state with focus alive inside the dialog — the
    // read shortcuts must still fire — but with no visible focus outline.
    await popover.locator(".note-editor").press("Enter");
    await popover.locator(".note-pop-view").waitFor();
    const savedFocus = await page.evaluate(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return { inside: document.getElementById("notepop").contains(active),
        outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
        focusVisible: active.matches(":focus-visible") };
    });
    assert.equal(savedFocus.inside, true, `saving must keep focus inside the popover: ${JSON.stringify(savedFocus)}`);
    assert(savedFocus.outlineStyle === "none" || parseFloat(savedFocus.outlineWidth) === 0 || !savedFocus.focusVisible,
      `saving with Enter must not paint a focus outline: ${JSON.stringify(savedFocus)}`);
    // Proof the keyboard flow survived the ringless focus target: the read
    // state's delete shortcut still lands without touching the mouse.
    await page.keyboard.press("Backspace");
    await page.waitForFunction((id) => !document.querySelector(`.note-dot[data-note="${id}"]`), singleId);
    await popover.waitFor({ state: "hidden" });

    const multi = await popoverHeights(multiId);
    assert(Math.abs(multi.edit - multi.read) < 1,
      `a multi-paragraph plain note must keep the same popover height in read and edit: ${JSON.stringify(multi)}`);
    // Escape from the editor is the same keyboard path as Enter: no outline either.
    await page.keyboard.press("Escape");
    await popover.locator(".note-pop-view").waitFor();
    const escapedFocus = await page.evaluate(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return { inside: document.getElementById("notepop").contains(active),
        outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
        focusVisible: active.matches(":focus-visible") };
    });
    assert.equal(escapedFocus.inside, true, `escaping the editor must keep focus inside the popover: ${JSON.stringify(escapedFocus)}`);
    assert(escapedFocus.outlineStyle === "none" || parseFloat(escapedFocus.outlineWidth) === 0 || !escapedFocus.focusVisible,
      `escaping the editor must not paint a focus outline: ${JSON.stringify(escapedFocus)}`);
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });

    // Both states clamp a long note at one shared ceiling, so the frame never
    // jumps entering or leaving the editor.
    const long = await popoverHeights(longId);
    assert(Math.abs(long.edit - long.read) < 1,
      `a clamped long note must keep the same popover height in read and edit: ${JSON.stringify(long)}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    console.log("ok web app: note popover reads and edits at one height, and Enter leaves no focus ring");
  } finally {
    await context.close();
  }
}

/* The note dialog is pinned to its dot. Ordinary mousing must never move it —
   the anchor's own border box is hover-immune — a wobble near the side-flip
   threshold must never teleport it, and a dot-column re-render must hand the
   open dialog the very same dot back, still tracking. */
async function verifyNotePopoverAnchorStability() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await routeProvider(page);
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const filler = Array.from({ length: 20 }, (_, index) =>
      `Filler paragraph ${index + 1} keeps the card's body taller than its frame so the anchor can scroll.`).join("\n\n");
    await createDocument(page, [
      "# Anchor stability",
      "",
      "The first anchor opens the page with a line of prose to mark.",
      "",
      "One quiet paragraph keeps the dialog's footprint clear of the margin below.",
      "",
      "A second quiet paragraph gives the dialog room to breathe over the prose.",
      "",
      "The second anchor waits here, below the dialog, with a placement anchor nearby.",
      "",
      filler,
    ].join("\n"));
    const popover = page.locator("#notepop");
    const rootCard = page.locator(".card.root");

    async function dockNote(selection, markdown) {
      const before = await page.evaluate(async () =>
        (await window.__rabbitholeTest.readStoredHole()).nodes.filter((node) => node.origin?.kind === "note").length);
      await selectText(page, selection);
      await page.waitForSelector("#ask.visible");
      await page.fill("#ask-text", markdown);
      await page.click('#ask .ask-commit[data-commit="note"]');
      const hole = await waitForStoredHole(page, (stored) =>
        stored.nodes.filter((node) => node.origin?.kind === "note").length === before + 1, "the docked note to persist");
      return hole.nodes.find((node) => node.markdown === markdown).id;
    }

    // A placed note window gives the pointer another card to wander across.
    await selectText(page, "placement anchor");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "A placed neighbour card");
    await page.press("#ask-text", "Control+Shift+Enter");
    const neighbour = page.locator(".card-note", { hasText: "A placed neighbour card" });
    await neighbour.waitFor();

    const firstId = await dockNote("first anchor", "The pinned note under test");
    const secondId = await dockNote("second anchor", "The neighbouring dot");

    await page.locator(`.note-dot[data-note="${firstId}"]`).click();
    await popover.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const transform = getComputedStyle(document.getElementById("notepop")).transform;
      return transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
    });
    const popRect = () => popover.evaluate((surface) => {
      const box = surface.getBoundingClientRect();
      return { left: box.left, top: box.top, placement: surface.dataset.placement };
    });
    const settled = await popRect();
    assert(settled.placement.startsWith("bottom"), `the dialog opens below a dot near the card's top: ${JSON.stringify(settled)}`);
    const still = async (name) => {
      await page.waitForTimeout(160); // outlive the dot ink's 0.12s hover grow
      const now = await popRect();
      assert(Math.abs(now.left - settled.left) < 1 && Math.abs(now.top - settled.top) < 1 && now.placement === settled.placement,
        `${name} must not move the note dialog: ${JSON.stringify({ settled, now })}`);
    };

    // Hovering the wash lights the dot as its partner and grows the ink — but
    // the button box the dialog is anchored to must not move by a pixel.
    await rootCard.locator(`mark[data-child="${firstId}"]`).hover();
    await page.waitForTimeout(160);
    assert.deepEqual(await page.evaluate((id) => {
      const dot = document.querySelector(`.note-dot[data-note="${id}"]`);
      const box = dot.getBoundingClientRect();
      return { partner: dot.classList.contains("note-dot-partner"),
        box: { width: box.width, height: box.height },
        ink: getComputedStyle(dot, "::after").transform };
    }, firstId), { partner: true, box: { width: 7, height: 7 }, ink: "matrix(1.12, 0, 0, 1.12, 0, 0)" },
    "the wash-hover partner grow lives on the ink, never on the anchor's own box");
    await still("hovering the note's wash");
    await page.locator(`.note-dot[data-note="${firstId}"]`).hover();
    await page.waitForTimeout(160);
    assert.deepEqual(await page.evaluate((id) => {
      const dot = document.querySelector(`.note-dot[data-note="${id}"]`);
      const box = dot.getBoundingClientRect();
      return { box: { width: box.width, height: box.height }, ink: getComputedStyle(dot, "::after").transform };
    }, firstId), { box: { width: 7, height: 7 }, ink: "matrix(1.12, 0, 0, 1.12, 0, 0)" },
    "hovering the dot itself grows the ink without touching the anchor's box");
    await still("hovering the note's own dot");
    // Wander the pointer across the rest of the canvas: the sibling dot,
    // another card, and the parent card's prose.
    const stops = await page.evaluate((id) => {
      const center = (el) => { const box = el.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
      const body = document.querySelector(".card.root .card-body").getBoundingClientRect();
      return [
        center(document.querySelector(`.note-dot[data-note="${id}"]`)),
        center(document.querySelector(".card-note .doc-content")),
        { x: body.left + 60, y: body.top + 40 },
        { x: body.left + body.width / 2, y: body.top + body.height / 2 },
      ];
    }, secondId);
    for (const [index, stop] of stops.entries()) {
      await page.mouse.move(stop.x, stop.y, { steps: 4 });
      await still(`wandering the pointer (stop ${index + 1})`);
    }

    // Near the flip threshold, a drift inside the hysteresis margin must nudge
    // the dialog along, never teleport it across its anchor; a real shortfall
    // must still flip it.
    const threshold = await page.evaluate((id) => new Promise((resolve) => {
      const pop = document.getElementById("notepop");
      const dot = document.querySelector(`.note-dot[data-note="${id}"]`);
      const style = getComputedStyle(pop);
      const gap = parseFloat(style.getPropertyValue("--surface-gap")) || 0;
      const edge = parseFloat(style.getPropertyValue("--surface-edge")) || 0;
      const scale = new DOMMatrixReadOnly(getComputedStyle(document.getElementById("world")).transform).a || 1;
      const viewport = window.visualViewport;
      const viewportBottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
      const need = pop.getBoundingClientRect().height + gap + edge;
      const move = (screenDelta) => { dot.style.top = (parseFloat(dot.style.top) + screenDelta / scale) + "px"; };
      // The dialog repositions off its own surface mutations; an inert text
      // node is the cheapest way to ask for one honest update pass.
      const requestUpdate = () => pop.querySelector(".note-pop-body").appendChild(document.createTextNode(""));
      const twoFrames = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
      const reading = () => {
        const box = pop.getBoundingClientRect();
        return { placement: pop.dataset.placement, top: box.top, bottom: box.bottom, dotTop: dot.getBoundingClientRect().top };
      };
      // Park the anchor so the dialog still fits below it — by two pixels.
      move((viewportBottom - need - 2) - dot.getBoundingClientRect().bottom);
      requestUpdate();
      twoFrames(() => {
        const parked = reading();
        move(4); // now 2px short of fitting: inside the hysteresis margin
        requestUpdate();
        twoFrames(() => {
          const nudged = reading();
          move(140); // a real shortfall: the anchor dives for the edge
          requestUpdate();
          twoFrames(() => resolve({ parked, nudged, shortfall: reading() }));
        });
      });
    }), firstId);
    assert(threshold.parked.placement.startsWith("bottom"),
      `the dialog should sit below an anchor it still fits under: ${JSON.stringify(threshold)}`);
    assert.equal(threshold.nudged.placement, threshold.parked.placement,
      `a drift inside the hysteresis margin must never flip the dialog to the other side: ${JSON.stringify(threshold)}`);
    // The anchor moved 4px down but the viewport clamp concedes only 2 of them.
    assert(Math.abs(threshold.nudged.top - threshold.parked.top - 2) < 1,
      `inside the margin the dialog follows its anchor, it does not teleport: ${JSON.stringify(threshold)}`);
    assert(threshold.shortfall.placement.startsWith("top") && threshold.shortfall.bottom < threshold.shortfall.dotTop,
      `a real shortfall must still flip the dialog above its anchor: ${JSON.stringify(threshold)}`);
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });

    // A save re-renders the dot column while the dialog is open: the dialog's
    // anchor must be the very same element afterwards — and still tracking.
    await page.locator(`.note-dot[data-note="${secondId}"]`).click();
    await popover.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getElementById("notepop").contains(document.activeElement));
    await page.evaluate((id) => { window.__testDotBefore = document.querySelector(`.note-dot[data-note="${id}"]`); }, secondId);
    await popover.locator(".note-pop-view").dblclick();
    await popover.locator(".note-editor").waitFor();
    await popover.locator(".note-editor").fill("The neighbouring dot, revised");
    await popover.locator(".note-editor").press("Enter");
    await popover.locator(".note-pop-view").waitFor();
    await waitForStoredHole(page, (hole) => hole.nodes.find((node) => node.id === secondId)?.markdown === "The neighbouring dot, revised",
      "the revised note to persist");
    assert.equal(await page.evaluate((id) => document.querySelector(`.note-dot[data-note="${id}"]`) === window.__testDotBefore, secondId),
      true, "re-rendering the dot column must reuse the open dialog's anchor, not conjure a stranger");
    const tracked = await page.evaluate((id) => new Promise((resolve) => {
      const pop = document.getElementById("notepop");
      const dot = document.querySelector(`.note-dot[data-note="${id}"]`);
      const gap = parseFloat(getComputedStyle(pop).getPropertyValue("--surface-gap")) || 0;
      const geometry = () => {
        const dotBox = dot.getBoundingClientRect();
        const box = pop.getBoundingClientRect();
        return { gap: box.top - dotBox.bottom, endOffset: dotBox.right - box.right, dotTop: dotBox.top };
      };
      const before = geometry();
      // Scroll the card's own body: the mark moves, the dot follows the mark,
      // and the dialog must follow the dot.
      dot.closest(".card-body").scrollTop += 36;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        pop.querySelector(".note-pop-body").appendChild(document.createTextNode(""));
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ before, after: geometry(), expectedGap: gap })));
      }));
    }), secondId);
    assert(tracked.after.dotTop < tracked.before.dotTop - 20,
      `scrolling the body must actually move the anchor: ${JSON.stringify(tracked)}`);
    assert(Math.abs(tracked.after.gap - tracked.expectedGap) < 1 && Math.abs(tracked.after.endOffset) < 1,
      `after a re-render the dialog still rides its dot through an anchor move: ${JSON.stringify(tracked)}`);
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    console.log("ok web app: note popover stays pinned through hover, threshold wobble, and dot-column re-renders");
  } finally {
    await context.close();
  }
}

async function verifyStandaloneNotesAndEditing() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("rh-film", "1"));
  let providerCalls = 0;
  await routeProvider(page, {
    onProviderCall: () => { providerCalls += 1; },
    providerDelayMs: 220,
    streams: [[
      "TITLE: Standalone canvas ask\n",
      "The standalone two-intent composer reached the existing provider path.",
    ]],
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, [
      "# Phase 3 notes",
      "",
      "This anchored edit target becomes durable marginalia.",
      "",
      "Double-clicking this document must never create a standalone note.",
    ].join("\n"));
    assert.equal(await page.locator("#t-frame").count(), 0, "zoom-to-fit must not have a toolbar surface");

    // An anchored note is born docked; this test is about the note window, so
    // place it on the canvas first and then edit the card it became.
    await selectText(page, "anchored edit target");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Original anchored note\n\n- First list item\n- Second list item");
    await page.click('#ask .ask-commit[data-commit="note"]');
    await page.waitForSelector(".card.root .note-dot");
    const anchoredId = await placeDockedNote(page);
    const anchoredCard = page.locator(`.card-note[data-id="${anchoredId}"]`);
    await anchoredCard.locator(".doc-content", { hasText: "Original anchored note" }).waitFor();
    const rootCard = page.locator(".card.root");
    const rootId = await rootCard.getAttribute("data-id");
    await page.waitForTimeout(350);

    await anchoredCard.locator(".card-more").click();
    assert.equal(await page.locator("#cardmenu #cm-pin").isVisible(), true,
      "a connected note card must offer the same window pinning as every other card");
    const connectedRect = await anchoredCard.boundingBox();
    await page.locator("#cardmenu #cm-pin").click();
    const connectedProjection = page.locator(`[data-pinned-node-id="${anchoredId}"]`);
    await connectedProjection.waitFor();
    const connectedOrigin = page.locator(`[data-pinned-origin-id="${anchoredId}"]`);
    await connectedOrigin.waitFor();
    assert.equal(await connectedProjection.locator(`.card[data-id="${anchoredId}"]`).count(), 1,
      "pinning must move the one live card instead of cloning its interaction state");
    assert.equal(await connectedOrigin.locator(".pinned-origin-card").getAttribute("inert"), "",
      "the graph presentation must be inert");
    assert.match(await connectedOrigin.locator(".pinned-origin-overlay").getAttribute("aria-label"), /^Show pinned window:/,
      "the graph presentation must explain where its live card went");
    for (const label of ["Collapse card", "Expand document", "Card menu", "Focus original on canvas", "Unpin window"]) {
      assert.equal(await connectedProjection.locator(`[aria-label="${label}"]`).count(), 1,
        `the pinned card must retain its ${label} control`);
    }
    assert.equal(await connectedProjection.locator(".card-resize").count(), 1,
      "the pinned card must retain its resize affordance");
    assert.equal(await connectedProjection.locator(".nc-handle").count(), 1,
      "the pinned card must retain its Ask or note composer");
    const pinnedExpand = connectedProjection.locator('[aria-label="Expand document"]');
    await pinnedExpand.click();
    await page.locator("#reader").waitFor({ state: "visible" });
    await page.locator("#reader-restore").click();
    await page.waitForSelector("body.mode-canvas");
    await connectedProjection.waitFor();
    await page.waitForTimeout(350);
    const readConnectedProjection = () => connectedProjection.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const parent = element.parentElement.getBoundingClientRect();
      return { x: rect.x, y: rect.y, styleLeft: element.style.left, transform: getComputedStyle(element).transform,
        parentX: parent.x, scrollLeft: element.parentElement.scrollLeft };
    });
    const connectedProjectionBefore = await readConnectedProjection();
    const connectedEdge = page.locator(`#edges path[data-child="${anchoredId}"]`);
    const normalizePath = (path) => String(path).replace(/-?\d+(?:\.\d+)?/g, (value) => Number(value).toFixed(3));
    const connectedEdgeBefore = normalizePath(await connectedEdge.getAttribute("d"));
    const connectedCamera = await page.evaluate(() => window.__rhFilmCamera.getView());
    await page.evaluate((camera) => window.__rhFilmCamera.setView(camera.x + 137, camera.y - 73, camera.scale * 0.78), connectedCamera);
    const connectedOriginalAfter = await connectedOrigin.boundingBox();
    const connectedProjectionAfter = await readConnectedProjection();
    assert.deepEqual({ x: Math.round(connectedProjectionAfter.x), y: Math.round(connectedProjectionAfter.y) },
      { x: Math.round(connectedProjectionBefore.x), y: Math.round(connectedProjectionBefore.y) },
      `a connected card's viewport projection must stay fixed while its canonical card moves with the graph (${JSON.stringify({ connectedProjectionBefore, connectedProjectionAfter })})`);
    assert.notDeepEqual({ x: Math.round(connectedOriginalAfter.x), y: Math.round(connectedOriginalAfter.y) },
      { x: Math.round(connectedRect.x), y: Math.round(connectedRect.y) });
    assert.equal(normalizePath(await connectedEdge.getAttribute("d")), connectedEdgeBefore,
      "a connected pinned card's parent edge must remain attached to its canonical graph position");
    await connectedProjection.locator('[aria-label="Unpin window"]').click();
    await connectedProjection.waitFor({ state: "detached" });
    await zoomToFit(page);
    await page.waitForTimeout(350);

    const persistedNoteCount = async () => page.evaluate(async () => {
      const hole = await window.__rabbitholeTest.readStoredHole();
      return hole.nodes.filter((node) => node.origin?.kind === "note").length;
    });
    assert.equal(await persistedNoteCount(), 1);

    const noteTitle = anchoredCard.locator(".card-title");
    await noteTitle.dblclick({ position: { x: 5, y: 8 } });
    const noteTitleEditing = await noteTitle.evaluate((title) => ({ editable: title.getAttribute("contenteditable"),
      isEditable: title.isContentEditable, active: document.activeElement === title,
      mode: document.body.className }));
    assert.equal(noteTitleEditing.editable, "plaintext-only", `a note title should become editable in place (${JSON.stringify(noteTitleEditing)})`);
    assert(await page.locator("body.mode-canvas").count(), "renaming a title must not trigger the header's reader dive");
    await noteTitle.fill("Renamed note window");
    await noteTitle.press("Enter");
    assert.equal(await noteTitle.innerText(), "Renamed note window", "Enter should commit an inline note title rename");

    const rootTitle = rootCard.locator(".card-title");
    const originalRootTitle = await rootTitle.innerText();
    await rootTitle.dblclick({ position: { x: 5, y: 8 } });
    await rootTitle.fill("Discard this root title");
    await rootTitle.press("Escape");
    assert.equal(await rootTitle.innerText(), originalRootTitle, "Escape should cancel an inline title rename");
    await rootTitle.dblclick({ position: { x: 5, y: 8 } });
    await rootTitle.fill("   ");
    await rootTitle.press("Enter");
    assert.equal(await rootTitle.innerText(), originalRootTitle, "an empty trimmed title should keep the old title");
    await rootTitle.dblclick({ position: { x: 5, y: 8 } });
    await rootTitle.fill("Renamed answer window");
    await rootTitle.press("Tab");
    assert.equal(await rootTitle.innerText(), "Renamed answer window", "blur should commit a non-note title rename");
    await page.waitForFunction(async ({ rootId, anchoredId }) => {
      const hole = await window.__rabbitholeTest.readStoredHole();
      return hole.nodes.find((node) => node.id === rootId)?.title === "Renamed answer window"
        && hole.nodes.find((node) => node.id === anchoredId)?.title === "Renamed note window";
    }, { rootId, anchoredId });

    await page.locator(".card.root .doc-content p").last().dblclick({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(80);
    assert.equal(await page.locator(".card-note").count(), 1, "double-clicking a card must not create a note");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    await page.locator(".card.root mark.mark-note").dblclick();
    await page.waitForTimeout(350);
    assert.equal(await page.locator(".card-note").count(), 1, "double-clicking a mark must not create a note");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    const anchoredSurface = anchoredCard.locator(".doc-content");
    await anchoredSurface.evaluate((surface) => { window.__anchoredNoteSurface = surface; });
    const renderedBlocks = await anchoredSurface.evaluate((surface) => Array.from(surface.querySelectorAll("p, ul, li"), (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { tag: element.tagName, text: element.textContent, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft], padding: style.padding };
    }));
    assert.equal(await anchoredCard.locator(".origin-quote").count(), 0,
      "an anchored note should rely on its parent highlight instead of repeating the selected text");
    await anchoredSurface.click({ position: { x: 8, y: 8 } });
    assert.equal(await anchoredCard.locator(".note-editor").count(), 0, "a single note-body click should remain ordinary document interaction");
    const clickedWord = await anchoredSurface.evaluate((surface) => {
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf("anchored");
        if (idx === -1) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + "anchored".length);
        const rect = range.getBoundingClientRect();
        const host = surface.getBoundingClientRect();
        return { click: { x: rect.left - host.left + rect.width / 2, y: rect.top - host.top + rect.height / 2 },
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
      }
      return null;
    });
    assert(clickedWord, "the rendered note should contain the word targeted for caret placement");
    await anchoredSurface.dblclick({ position: clickedWord.click });
    const anchoredEditor = anchoredCard.locator(".note-editor");
    await anchoredEditor.waitFor();
    assert.equal(await anchoredEditor.evaluate((editor) => editor === window.__anchoredNoteSurface), true,
      "editing must toggle the exact rendered note surface instead of replacing it");
    const editorSurface = await anchoredEditor.evaluate((editor) => {
      const style = getComputedStyle(editor);
      const selection = window.getSelection();
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node, rect = null;
      while ((node = walker.nextNode())) {
        const at = node.textContent.indexOf("anchored");
        if (at === -1) continue;
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + "anchored".length);
        const box = range.getBoundingClientRect();
        rect = { left: box.left, top: box.top, width: box.width, height: box.height };
        break;
      }
      return { border: style.borderTopWidth, outline: style.outlineStyle, shadow: style.boxShadow,
        sameWordRect: rect, caretInside: editor.contains(selection.focusNode), collapsed: selection.isCollapsed };
    });
    assert.deepEqual({ border: editorSurface.border, outline: editorSurface.outline, shadow: editorSurface.shadow },
      { border: "0px", outline: "none", shadow: "none" }, "the note editor should add no box or focus chrome");
    assert.deepEqual(editorSurface.sameWordRect, clickedWord.rect,
      "the edited word must retain the exact rendered x/y position and dimensions");
    assert.deepEqual(await anchoredEditor.evaluate((surface) => Array.from(surface.querySelectorAll("p, ul, li"), (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { tag: element.tagName, text: element.textContent, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft], padding: style.padding };
    })), renderedBlocks, "paragraph and list DOM geometry must be byte-for-byte identical in read and edit modes");
    assert(editorSurface.caretInside && editorSurface.collapsed, "double-click editing should place a collapsed caret in the shared note surface");
    assert.deepEqual(await anchoredCard.evaluate((card) => {
      const body = card.querySelector(".card-body");
      const surface = body.querySelector(".structured-note");
      const actions = body.querySelector(".note-edit-actions");
      const bodyRect = body.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      return {
        stack: getComputedStyle(body).flexDirection,
        noOriginQuote: !body.querySelector(".origin-quote"),
        surfaceFullWidth: Math.abs(surfaceRect.left - bodyRect.left) < 1 && Math.abs(surfaceRect.right - bodyRect.right) < 1,
        barFullWidth: Math.abs(actionsRect.left - bodyRect.left) < 1 && Math.abs(actionsRect.right - bodyRect.right) < 1,
        barAtBottom: Math.abs(actionsRect.bottom - bodyRect.bottom) < 1,
        noOverflow: body.scrollHeight <= body.clientHeight + 1,
      };
    }), {
      stack: "column", noOriginQuote: true,
      surfaceFullWidth: true, barFullWidth: true, barAtBottom: true, noOverflow: true,
    }, "editing an anchored note should use a full-width editor and action bar without an origin quote");
    assert.match(await anchoredEditor.evaluate((surface) => {
      const item = surface.querySelector("li:last-child");
      item.append(" updated");
      surface.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: " updated" }));
      return surface._rhStructuredNote.markdown;
    }), /- Second list item updated/,
    "editing formatted prose should serialize the existing list structure, not flatten it to text");
    await anchoredEditor.fill(Array.from({ length: 40 }, (_value, index) => `Cap line ${index} of an anchored note that has to wrap.`).join("\n"));
    assert.deepEqual(await anchoredCard.evaluate((card) => {
      const body = card.querySelector(".card-body");
      const editor = body.querySelector(".note-editor");
      return {
        atCap: editor.scrollHeight > editor.clientHeight && getComputedStyle(editor).overflowY === "auto",
        bodyFits: body.scrollHeight <= body.clientHeight + 1,
      };
    }), { atCap: true, bodyFits: true },
    "the anchored note editor should respect its height cap without an origin quote");
    await anchoredEditor.fill("Edited anchored durably");
    await anchoredCard.locator('.note-edit-actions .ask-commit[data-commit="note"]').click();
    await anchoredCard.locator(".doc-content", { hasText: "Edited anchored durably" }).waitFor();
    await page.waitForFunction(async () => {
      const hole = await window.__rabbitholeTest.readStoredHole();
      return hole.nodes.some((node) => node.origin?.kind === "note" && node.markdown === "Edited anchored durably");
    });
    const assertEditedStored = async (label) => {
      const markdown = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id)?.markdown, anchoredId);
      assert.equal(markdown, "Edited anchored durably", label);
    };
    await page.waitForTimeout(1000);
    await assertEditedStored("the edited note must remain durable after pending saves settle");

    // Enter is the editor's save key; Shift+Enter remains available for text.
    await anchoredSurface.dblclick({ position: clickedWord.click });
    await anchoredEditor.waitFor();
    await anchoredEditor.fill("Saved anchored with the save key");
    await anchoredEditor.press("Enter");
    await anchoredCard.locator(".doc-content", { hasText: "Saved anchored with the save key" }).waitFor();
    assert.equal(await anchoredCard.locator(".note-editor").count(), 0,
      "Enter should close the note editor by committing it, not by cancelling");
    await page.waitForFunction(async (id) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return node?.markdown === "Saved anchored with the save key";
    }, anchoredId);

    let point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForSelector(".card-note .note-editor");
    assert.equal(await page.locator(".card-note").count(), 2, "double-click should register one ephemeral note card");
    await page.waitForTimeout(260);
    const clickSpawn = await page.locator(".card-note:has(.note-editor)").evaluate((card) => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    });
    assert(Math.abs(clickSpawn.left - point.x) < 2 && Math.abs(clickSpawn.top - point.y) < 2,
      `a canvas double-click should place the note's top-left at the click (${JSON.stringify({ clickSpawn, point })})`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll(".card-note").length === 1);
    assert.equal(await persistedNoteCount(), 1, "Escape must leave no persisted empty note");
    assert.equal(await page.locator(".card.note-draft").count(), 0, "empty-draft Escape must leave zero draft nodes");

    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    const deletableDraft = page.locator(".card.note-draft");
    await deletableDraft.waitFor();
    const deletableDraftId = await deletableDraft.getAttribute("data-id");
    assert.equal(await deletableDraft.locator(".card-collapse").count(), 1,
      "the draft retains its structural collapse button for committed-card reuse");
    assert.equal(await deletableDraft.locator(".card-collapse").isVisible(), false,
      "collapse must be hidden while a card is an ephemeral draft");
    assert.equal(await deletableDraft.locator(".card-more").count(), 0,
      "an ephemeral draft must not expose the card menu before it becomes a node");
    await deletableDraft.locator(".note-editor").press("Escape");
    await page.waitForSelector(`.card[data-id="${deletableDraftId}"]`, { state: "detached" });
    assert.equal(await page.locator("#branch-undo.visible").count(), 0,
      "deleting an ephemeral draft must discard immediately without an undo toast");
    assert.equal(await persistedNoteCount(), 1, "deleting an ephemeral draft must not create persistence traffic");

    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForSelector(".card-note .note-editor");
    await page.click("#t-theme");
    await page.waitForFunction(() => document.querySelectorAll(".card-note").length === 1);
    assert.equal(await persistedNoteCount(), 1, "blur while empty must leave no persisted note");

    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    const standaloneEditor = page.locator(".card-note .note-editor");
    await standaloneEditor.waitFor();
    const standaloneCard = page.locator(".card-note:has(.note-editor)");
    assert.deepEqual(await standaloneCard.evaluate((card) => {
      const editor = card.querySelector(".note-editor");
      return {
        width: card.offsetWidth,
        height: card.offsetHeight,
        maxHeight: parseFloat(card.style.maxHeight),
        active: document.activeElement === editor,
        caret: [editor.selectionStart, editor.selectionEnd, editor.value.length],
        lenses: card.querySelectorAll(".lens").length,
        collapseVisible: getComputedStyle(card.querySelector(".card-collapse")).display !== "none",
        commits: Array.from(card.querySelectorAll(".ask-commit")).map((button) => ({
          commit: button.dataset.commit,
          title: button.title,
          hint: button.querySelector("kbd")?.textContent,
          disabled: button.disabled,
          visible: getComputedStyle(button).display !== "none",
        })),
      };
    }), {
      width: 300,
      height: 180,
      maxHeight: 460,
      active: true,
      caret: [0, 0, 0],
      lenses: 0,
      collapseVisible: false,
      commits: [
        { commit: "note", title: "Save note (Enter)", hint: "↵", disabled: true, visible: true },
        { commit: "ask", title: "Ask (Command/Control+Enter)", hint: "⌘↵", disabled: true, visible: true },
      ],
    }, "standalone drafts should start compact and focused with honest disabled commit actions but no lenses");
    await standaloneEditor.press("1");
    assert.equal(await standaloneEditor.inputValue(), "1", "a lens-less standalone composer must type 1 as ordinary text");
    await standaloneEditor.fill("Standalone note survives reload");
    assert.deepEqual(await standaloneCard.locator(".ask-commit").evaluateAll((buttons) => buttons.map((button) => button.disabled)), [false, false],
      "typing should enable both standalone commit intents exactly like card composers");
    await standaloneCard.locator('.ask-commit[data-commit="note"]').click();
    const committedStandaloneNote = page.locator("#world .card-note", { hasText: "Standalone note survives reload" });
    await committedStandaloneNote.locator(".doc-content", { hasText: "Standalone note survives reload" }).waitFor();
    await page.waitForFunction(async () => {
      const hole = await window.__rabbitholeTest.readStoredHole();
      return hole.nodes.some((node) => node.parent_id === null && node.origin?.kind === "note" && node.markdown === "Standalone note survives reload");
    });

    const standaloneNoteId = await committedStandaloneNote.getAttribute("data-id");
    await committedStandaloneNote.locator(".card-more").click();
    const pinAction = page.locator("#cardmenu #cm-pin");
    await pinAction.waitFor({ state: "visible" });
    assert.equal(await pinAction.locator(".sm-label").innerText(), "Pin window",
      "a standalone note should offer pinning only in its card menu");
    const pinnedRect = await committedStandaloneNote.boundingBox();
    await pinAction.click();
    const pinnedWindow = page.locator(`[data-pinned-node-id="${standaloneNoteId}"]`);
    const pinnedOrigin = page.locator(`[data-pinned-origin-id="${standaloneNoteId}"]`);
    await pinnedWindow.waitFor();
    await pinnedOrigin.waitFor();
    await page.waitForFunction(async (id) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return Number.isFinite(node?.extensions?.canvas?.pin?.x)
        && Number.isFinite(node?.extensions?.canvas?.pin?.y)
        && Number.isFinite(node?.extensions?.canvas?.pin?.scale);
    }, standaloneNoteId);
    const cameraBeforePinMove = await page.evaluate(() => window.__rhFilmCamera.getView());
    const readEdgeGeometry = () => page.locator("#edges").evaluate((edges) =>
      [...edges.children].map((element) => [...element.attributes].filter((attribute) => ["d", "cx", "cy"].includes(attribute.name))
        .map((attribute) => [attribute.name, attribute.value.replace(/-?\d+(?:\.\d+)?/g, (value) => Number(value).toFixed(3))])));
    const edgeGeometryBeforePinMove = await readEdgeGeometry();
    await page.evaluate((camera) => window.__rhFilmCamera.setView(
      camera.x + 173, camera.y - 91, Math.max(0.2, camera.scale * 0.62)
    ), cameraBeforePinMove);
    const originalAfterCamera = await pinnedOrigin.boundingBox();
    const pinnedAfterCamera = await pinnedWindow.boundingBox();
    assert.deepEqual({
      left: Math.round(pinnedAfterCamera.x - pinnedRect.x),
      top: Math.round(pinnedAfterCamera.y - pinnedRect.y),
      width: Math.round(pinnedAfterCamera.width - pinnedRect.width),
      height: Math.round(pinnedAfterCamera.height - pinnedRect.height),
    }, { left: 0, top: 0, width: 0, height: 0 },
    "a pinned projection should keep its exact screen position and apparent zoom while the camera pans and zooms");
    assert.notDeepEqual({ x: Math.round(originalAfterCamera.x), y: Math.round(originalAfterCamera.y) },
      { x: Math.round(pinnedRect.x), y: Math.round(pinnedRect.y) },
      "the canonical canvas card must continue moving with the graph beneath its pinned projection");
    assert.deepEqual(await readEdgeGeometry(), edgeGeometryBeforePinMove,
      "pinning and camera movement must not rewrite graph-edge geometry");

    const originBeforePinnedResize = await pinnedOrigin.boundingBox();
    const liveCardBeforePinnedResize = await pinnedWindow.locator(`.card[data-id="${standaloneNoteId}"]`).boundingBox();
    const resizeHandle = await pinnedWindow.locator(".card-resize").boundingBox();
    await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeHandle.x + resizeHandle.width / 2 - 50, resizeHandle.y + resizeHandle.height / 2 + 60, { steps: 5 });
    await page.mouse.up();
    const liveCardAfterPinnedResize = await pinnedWindow.locator(`.card[data-id="${standaloneNoteId}"]`).boundingBox();
    const originAfterPinnedResize = await pinnedOrigin.boundingBox();
    assert(liveCardAfterPinnedResize.width < liveCardBeforePinnedResize.width - 40
        && liveCardAfterPinnedResize.height > liveCardBeforePinnedResize.height + 40,
      `resizing a pinned card must resize its viewport presentation (${JSON.stringify({ liveCardBeforePinnedResize, liveCardAfterPinnedResize, resizeHandle })})`);
    assert.deepEqual({ width: Math.round(originAfterPinnedResize.width), height: Math.round(originAfterPinnedResize.height) },
      { width: Math.round(originBeforePinnedResize.width), height: Math.round(originBeforePinnedResize.height) },
      "pinned size must be independent from the original graph card");
    await page.waitForFunction(async (id) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return Number.isFinite(node?.extensions?.canvas?.pin?.w) && node.extensions.canvas.pin.w < node.size.w
        && Number.isFinite(node.extensions.canvas.pin.h) && node.extensions.canvas.pin.h > node.size.h;
    }, standaloneNoteId);

    await pinnedWindow.locator('[aria-label="Collapse card"]').click();
    await page.waitForFunction((id) => document.querySelector(`.card[data-id="${id}"]`)?.classList.contains("collapsed"), standaloneNoteId);
    await pinnedWindow.locator('[aria-label="Expand card"]').click();
    await page.waitForFunction((id) => !document.querySelector(`.card[data-id="${id}"]`)?.classList.contains("collapsed"), standaloneNoteId);

    const pinnedBeforeReload = await pinnedWindow.boundingBox();
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(async (id) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return Number.isFinite(node?.extensions?.canvas?.pin?.x);
    }, standaloneNoteId);
    await pinnedWindow.waitFor({ state: "attached" });
    await pinnedOrigin.waitFor({ state: "attached" });
    if (await page.locator("#reader").isVisible()) await page.locator("#reader-restore").click();
    await page.waitForSelector("body.mode-canvas");
    await pinnedWindow.waitFor();
    const pinnedAfterReload = await pinnedWindow.boundingBox();
    assert.deepEqual({ x: Math.round(pinnedAfterReload.x), y: Math.round(pinnedAfterReload.y),
      width: Math.round(pinnedAfterReload.width), height: Math.round(pinnedAfterReload.height) },
    { x: Math.round(pinnedBeforeReload.x), y: Math.round(pinnedBeforeReload.y),
      width: Math.round(pinnedBeforeReload.width), height: Math.round(pinnedBeforeReload.height) },
    "a pinned window should restore its independent screen position and size");
    assert.equal(await pinnedWindow.getAttribute("role"), "region");
    assert.match(await pinnedWindow.getAttribute("aria-label"), /^Pinned:/,
      "the duplicate presentation must announce its pinned identity");
    await pinnedWindow.locator('[aria-label="Focus original on canvas"]').click();
    await page.waitForFunction((id) => {
      const original = document.querySelector(`[data-pinned-origin-id="${id}"]`);
      if (!original) return false;
      const rect = original.getBoundingClientRect();
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }, standaloneNoteId);
    await pinnedWindow.locator('[aria-label="Unpin window"]').click();
    await page.waitForFunction(async (id) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return !node?.extensions?.canvas?.pin;
    }, standaloneNoteId);
    await pinnedWindow.waitFor({ state: "detached" });
    await committedStandaloneNote.locator(".card-more").click();
    assert.equal(await pinAction.locator(".sm-label").innerText(), "Pin window");
    await pinAction.focus();
    await page.keyboard.press("Enter");
    const keyboardProjection = page.locator(`[data-pinned-node-id="${standaloneNoteId}"]`);
    await keyboardProjection.waitFor();
    await keyboardProjection.locator('[aria-label="Unpin window"]').focus();
    await page.keyboard.press("Enter");
    await keyboardProjection.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("card-more"));

    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    const askDraft = page.locator(".card.note-draft");
    const askEditor = askDraft.locator(".note-editor");
    await askEditor.fill("How does the standalone Ask intent work?");
    const askDraftState = await askDraft.evaluate((card) => {
      card.__standaloneAskIdentity = true;
      const rect = card.getBoundingClientRect();
      return {
        id: card.dataset.id,
        nodeCount: document.querySelectorAll(".card").length,
        edgeCount: document.querySelectorAll("#edges path").length,
        transform: getComputedStyle(document.getElementById("world")).transform,
        position: { x: parseFloat(card.style.left), y: parseFloat(card.style.top) },
        size: { w: card.offsetWidth, h: card.offsetHeight },
        screen: { left: rect.left, top: rect.top, width: rect.width },
      };
    });
    await askDraft.locator('.ask-commit[data-commit="ask"]').click();
    const standaloneAsk = page.locator(`.card[data-id="${askDraftState.id}"]`);
    await page.waitForFunction((id) => {
      const card = document.querySelector(`.card[data-id="${id}"]`);
      return card && !card.classList.contains("note-draft") && card.textContent.includes("Thinking");
    }, askDraftState.id);
    const pendingAskState = await standaloneAsk.evaluate((card) => {
      const rect = card.getBoundingClientRect();
      return {
        sameCard: card.__standaloneAskIdentity === true,
        nodeCount: document.querySelectorAll(".card").length,
        edgeCount: document.querySelectorAll("#edges path").length,
        ownEdges: document.querySelectorAll(`#edges [data-child="${card.dataset.id}"]`).length,
        transform: getComputedStyle(document.getElementById("world")).transform,
        screen: { left: rect.left, top: rect.top, width: rect.width },
        noteClass: card.classList.contains("card-note"),
        text: card.textContent,
      };
    });
    assert.equal(pendingAskState.sameCard, true, "Ask commit must morph the exact draft DOM card into its pending answer surface");
    assert.equal(pendingAskState.nodeCount, askDraftState.nodeCount, "Ask commit must not replace the draft with a second node");
    assert.equal(pendingAskState.edgeCount, askDraftState.edgeCount, "a standalone Ask commit must add zero graph edges");
    assert.equal(pendingAskState.ownEdges, 0, "a standalone Ask must never acquire an edge element");
    assert.equal(pendingAskState.transform, askDraftState.transform, "committing a standalone Ask must not move the viewport");
    assert.deepEqual(pendingAskState.screen, askDraftState.screen, "the pending ask must keep the draft's exact screen position and width");
    assert.equal(pendingAskState.noteClass, false, "the in-place pending surface is an ask card, not a committed note");
    assert.match(pendingAskState.text, /How does the standalone Ask intent work\?/);
    await page.waitForFunction(async ({ id, position, size }) => {
      const stored = (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id);
      return stored?.status === "pending" && stored.parent_id === null
        && stored.position.x === position.x && stored.position.y === position.y
        && stored.size.w === size.w && stored.size.h === size.h;
    }, { id: askDraftState.id, position: askDraftState.position, size: askDraftState.size });
    await standaloneAsk.filter({ hasText: "The standalone two-intent composer reached the existing provider path." }).waitFor();
    assert.equal(providerCalls, 1, "the standalone Ask action should call the configured provider exactly once");
    await standaloneAsk.locator(".card-more").click();
    assert.equal(await page.locator("#cardmenu #cm-pin").isVisible(), true,
      "a standalone answer should offer the same menu-only pin action as a standalone note");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".card.note-draft").count(), 0, "Ask commit should consume the ephemeral note surface");
    assert.deepEqual(await standaloneAsk.evaluate((card) => ({
      sameCard: card.__standaloneAskIdentity === true,
      edgeCount: document.querySelectorAll("#edges path").length,
      ownEdges: document.querySelectorAll(`#edges [data-child="${card.dataset.id}"]`).length,
      transform: getComputedStyle(document.getElementById("world")).transform,
    })), {
      sameCard: true,
      edgeCount: askDraftState.edgeCount,
      ownEdges: 0,
      transform: askDraftState.transform,
    }, "the streamed answer must settle in the same disconnected card without moving the camera");
    await page.waitForFunction(async ({ id, position, size }) => {
      const hole = await window.__rabbitholeTest.readStoredHole();
      return hole.nodes.some((node) => node.id === id && node.parent_id === null
        && node.origin?.question === "How does the standalone Ask intent work?"
        && node.origin?.selected_text === "" && node.origin?.branch_type === "followup"
        && node.position.x === position.x && node.position.y === position.y
        && node.size.w === size.w && node.size.h === size.h
        && node.markdown.includes("existing provider path"));
    }, { id: askDraftState.id, position: askDraftState.position, size: askDraftState.size });

    await page.keyboard.press("Control+K");
    await page.fill("#pal-text", "intent work");
    await page.locator(".pal-item:visible", { hasText: "Standalone canvas ask" }).waitFor();
    await page.keyboard.press("Escape");

    await standaloneAsk.locator('.card-btn[aria-label="Collapse card"]').click();
    assert.equal(await standaloneAsk.evaluate((card) => card.classList.contains("collapsed")), true,
      "standalone asks must use the ordinary collapse path");
    await deleteCardBranch(page, standaloneAsk);
    await page.waitForSelector(`.card[data-id="${askDraftState.id}"]`, { state: "detached" });
    await page.locator("#branch-undo [data-notice-action]").click();
    const restoredStandaloneAsk = page.locator(`.card[data-id="${askDraftState.id}"]`);
    await restoredStandaloneAsk.waitFor();
    assert.equal(await restoredStandaloneAsk.evaluate((card) => card.classList.contains("collapsed")), true,
      "delete undo must restore a parentless ask's collapsed state");
    assert.equal(await page.locator(`#edges [data-child="${askDraftState.id}"]`).count(), 0,
      "delete undo must keep the restored standalone ask disconnected");
    await restoredStandaloneAsk.locator('.card-btn[aria-label="Expand card"]').click();

    const beforeTidy = await restoredStandaloneAsk.evaluate((card) => ({ left: card.style.left, top: card.style.top }));
    await page.click("#t-tidy");
    await page.waitForTimeout(320);
    assert.deepEqual(await restoredStandaloneAsk.evaluate((card) => ({ left: card.style.left, top: card.style.top })), beforeTidy,
      "Tidy must leave parentless asks in place just as it leaves standalone notes");

    await page.waitForTimeout(300);
    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    const growthCard = page.locator(".card.note-draft");
    const growthEditor = growthCard.locator(".note-editor");
    await growthEditor.waitFor();
    const growthStart = await growthCard.evaluate((card) => {
      const rect = card.getBoundingClientRect();
      const row = card.querySelector(".ask-actions").getBoundingClientRect();
      return { top: rect.top, height: card.offsetHeight, rowHeight: row.height, rowBottomGap: rect.bottom - row.bottom };
    });
    await growthEditor.fill(Array.from({ length: 12 }, (_, index) => `Growing line ${index + 1}`).join("\n"));
    const growthMiddle = await growthCard.evaluate((card) => {
      const rect = card.getBoundingClientRect();
      const row = card.querySelector(".ask-actions").getBoundingClientRect();
      return { top: rect.top, height: card.offsetHeight, rowHeight: row.height, rowBottomGap: rect.bottom - row.bottom };
    });
    assert(growthMiddle.height > growthStart.height && growthMiddle.height < 460,
      `typing should grow the card between its compact start and standard cap (${JSON.stringify({ growthStart, growthMiddle })})`);
    assert(Math.abs(growthMiddle.top - growthStart.top) < 0.5,
      `type-to-grow must keep the draft card's top-left fixed (${JSON.stringify({ growthStart, growthMiddle })})`);
    assert(Math.abs(growthMiddle.rowHeight - growthStart.rowHeight) < 0.5
      && Math.abs(growthMiddle.rowBottomGap - growthStart.rowBottomGap) < 0.5,
    "the shared commit row must stay pinned without reflow while the card grows");
    await growthEditor.fill(Array.from({ length: 80 }, (_, index) => `Capped line ${index + 1}`).join("\n"));
    const growthCap = await growthCard.evaluate((card) => {
      const rect = card.getBoundingClientRect();
      const row = card.querySelector(".ask-actions").getBoundingClientRect();
      const editor = card.querySelector(".note-editor");
      return { top: rect.top, height: card.offsetHeight, cap: parseFloat(card.style.maxHeight),
        rowHeight: row.height, rowBottomGap: rect.bottom - row.bottom,
        editorClientHeight: editor.clientHeight, editorScrollHeight: editor.scrollHeight,
        editorOverflow: getComputedStyle(editor).overflowY };
    });
    assert.equal(growthCap.height, growthCap.cap, "the draft card should stop exactly at the standard card height cap");
    assert(growthCap.editorScrollHeight > growthCap.editorClientHeight && growthCap.editorOverflow === "auto",
      `content beyond the card cap should scroll inside the editor (${JSON.stringify(growthCap)})`);
    assert(Math.abs(growthCap.top - growthStart.top) < 0.5, "capped growth must still preserve the card's top edge");
    assert(Math.abs(growthCap.rowHeight - growthStart.rowHeight) < 0.5
      && Math.abs(growthCap.rowBottomGap - growthStart.rowBottomGap) < 0.5,
    "the commit footer must keep its geometry at the growth cap");
    await growthEditor.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".card.note-draft"));
    assert.equal(await persistedNoteCount(), 2, "cancelling a grown draft must create no persistence traffic");

    await page.keyboard.press("Control+K");
    await page.waitForSelector("#palette:not([hidden])");
    const commands = await page.locator(".pal-item").evaluateAll((rows) => rows.map((row) => row.querySelector(".pal-title")?.textContent));
    /* ⌘K holds navigation and actions and nothing else: global preferences live
       behind the gear, per-card ones in the card ⋯ menu. */
    assert.deepEqual(commands.slice(-4), ["New note", "Zoom to fit", "Tidy up layout", "Open settings"],
      `the canvas palette should expose exactly the command set, got ${JSON.stringify(commands)}`);
    assert.equal(commands.some((name) => /reading size/i.test(name)), false, "reading size is a setting and must not appear in ⌘K");
    const zoomCommand = page.locator(".pal-item", { hasText: "Zoom to fit" });
    assert.equal(await zoomCommand.locator("kbd:visible").count(), 0, "Zoom to fit must not advertise the deleted global F shortcut");
    /* An absent badge or status flag must leave the layout entirely: a class
       that sets display beats [hidden], and an empty span still eats its flex
       gap, so every row wore a blank pill and every title sat a gap off. */
    const rowPolish = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".pal-item")].find((item) => {
        const snippet = item.querySelector(".pal-s");
        return snippet && !snippet.hidden && !item.querySelector(".lens-badge")?.textContent;
      });
      if (!row) return null;
      const title = row.querySelector(".pal-title").getBoundingClientRect();
      const snippet = row.querySelector(".pal-s").getBoundingClientRect();
      const badge = row.querySelector(".lens-badge");
      return {
        badgeDisplay: getComputedStyle(badge).display,
        badgeWidth: badge.getBoundingClientRect().width,
        titleLeft: title.left,
        snippetLeft: snippet.left,
      };
    });
    assert(rowPolish, "expected at least one palette node row without a lens badge");
    assert.equal(rowPolish.badgeDisplay, "none", "an empty lens badge must not render as a blank accent pill");
    assert.equal(rowPolish.badgeWidth, 0, "a hidden badge must take no space");
    assert(Math.abs(rowPolish.titleLeft - rowPolish.snippetLeft) < 0.5,
      `a palette row's title and snippet must share one left edge, off by ${(rowPolish.titleLeft - rowPolish.snippetLeft).toFixed(2)}px`);
    /* Open settings is a command, and it opens the one settings surface. */
    await page.fill("#pal-text", "open settings");
    await page.waitForFunction(() => document.querySelector(".pal-item:not([hidden]) .pal-title")?.textContent === "Open settings");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#settings-sheet");
    assert.equal(await page.locator("#settings-pane-title").innerText(), "Appearance");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#settings-sheet", { state: "detached" });

    await ensureRailOpen(page);
    const visibleCenter = await page.evaluate(() => {
      const rail = document.getElementById("web-rail");
      const taskbar = document.getElementById("taskbar");
      const viewport = document.getElementById("viewport");
      const fullW = viewport.clientWidth || innerWidth;
      const fullH = viewport.clientHeight || innerHeight;
      const insetX = rail.classList.contains("open") ? rail.getBoundingClientRect().width : 0;
      const insetY = taskbar.getBoundingClientRect().height;
      return { x: insetX + (fullW - insetX) / 2, y: insetY + (fullH - insetY) / 2 };
    });
    await page.keyboard.press("Control+K");
    await page.fill("#pal-text", "New note");
    await page.press("#pal-text", "Enter");
    await page.waitForFunction(() => document.activeElement?.classList.contains("note-editor"));
    assert.equal(await page.locator("#palette:visible").count(), 0, "New note must close the palette before focusing its editor");
    await page.waitForTimeout(260);
    const paletteCardCenter = await page.locator(".card-note:has(.note-editor)").evaluate((card) => {
      const rect = card.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    assert(Math.abs(paletteCardCenter.x - visibleCenter.x) < 2 && Math.abs(paletteCardCenter.y - visibleCenter.y) < 2,
      `palette notes should center in the rail-adjusted viewport (${JSON.stringify({ paletteCardCenter, visibleCenter })})`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll(".card-note").length === 2);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".card-note", { state: "attached" });
    const reloadedNoteText = await page.locator(".card-note .doc-content").evaluateAll((docs) => docs.map((dc) => dc.textContent).join(" "));
    assert(reloadedNoteText.includes("Saved anchored with the save key") && reloadedNoteText.includes("Standalone note survives reload"),
      `committed note markdown should hydrate after reload (${JSON.stringify(reloadedNoteText)})`);
    assert.equal(await page.locator(`.card[data-id="${anchoredId}"] .card-title`).innerText(), "Renamed note window",
      "a renamed note title should survive reload");
    assert.equal(await page.locator(`.card[data-id="${rootId}"] .card-title`).innerText(), "Renamed answer window",
      "a renamed non-note title should survive reload");
    assert.equal(await page.locator(".card-note").count(), 2, "only committed notes should survive reload");
    console.log("ok web app: connected and standalone viewport projections, editing, title renames, and persistence");
  } finally {
    await context.close();
  }
}

async function verifyStandaloneImagePaste() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const providerBodies = [];
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__revokedObjectUrls = [];
    URL.revokeObjectURL = (url) => { window.__revokedObjectUrls.push(String(url)); revoke(url); };
  });
  await routeProvider(page, {
    onProviderCall: (body) => providerBodies.push(body),
    providerDelayMs: 350,
    streams: [["TITLE: Pasted image answer\n", "The pasted image reached the provider."]],
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, "# Clipboard images\n\nPaste images into a standalone canvas composer.");
    const assets = () => page.evaluate(() => window.__rabbitholeTest.inspectAssets());
    assert.deepEqual((await assets()).names, []);

    let point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    let draft = page.locator(".card.note-draft");
    let editor = draft.locator(".note-editor");
    const removableDraftId = await draft.getAttribute("data-id");
    assert.equal(await pasteSyntheticImage(editor, "remove.png", "#d55"), true, "an image paste should be consumed");
    const removablePreview = draft.locator(".paste-attachment img");
    await removablePreview.waitFor();
    assert.equal(await editor.evaluate((textarea) => document.activeElement === textarea), true,
      "normalizing and rendering a pasted attachment must preserve editor focus");
    assert.equal(await draft.evaluate((card) => card.classList.contains("note-draft")), true,
      "paste busy states must never auto-commit the ephemeral draft");
    assert.equal(await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.some((node) => node.id === id), removableDraftId), false,
      "a pasted attachment must remain uncommitted until Note or Ask is explicitly chosen");
    const removableUrl = await removablePreview.getAttribute("src");
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".card.note-draft .ask-commit")).every((button) => !button.disabled));
    assert.deepEqual(await draft.locator(".ask-commit").evaluateAll((buttons) => buttons.map((button) => button.disabled)), [false, false],
      "an image-only draft should enable Note and Ask");
    assert.deepEqual((await assets()).names, [], "pasting and previewing must not upload an asset");
    await draft.locator(".paste-attachment-remove").click();
    await page.waitForFunction(() => !document.querySelector(".paste-attachment"));
    assert.equal(await page.evaluate((url) => window.__revokedObjectUrls.includes(url), removableUrl), true,
      "removing a preview should revoke its object URL");
    assert.deepEqual(await draft.locator(".ask-commit").evaluateAll((buttons) => buttons.map((button) => button.disabled)), [true, true]);
    await editor.press("Escape");

    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    draft = page.locator(".card.note-draft");
    editor = draft.locator(".note-editor");
    assert.equal(await pasteSyntheticImage(editor, "note.png", "#4a8"), true);
    await draft.locator(".paste-attachment img").waitFor();
    await draft.locator('.ask-commit[data-commit="note"]:not(:disabled)').waitFor();
    await draft.locator('.ask-commit[data-commit="note"]').evaluate((button) => button.click());
    const imageNote = page.locator(".card-note", { has: page.locator(".doc-content img") }).last();
    await imageNote.locator(".rh-img-frame img").waitFor();
    const imageNoteId = await imageNote.getAttribute("data-id");
    const editableImageNote = page.locator(`.card-note[data-id="${imageNoteId}"]`);
    assert.equal(await imageNote.locator(".rh-img-handle").count(), 1, "committed pasted-note images should receive resize UX");
    await imageNote.locator(".rh-img-frame img").evaluate((image) => image.click());
    await page.locator(".rh-lightbox").waitFor();
    await page.keyboard.press("Escape");
    const noteAssets = await assets();
    assert.equal(noteAssets.names.length, 1, "an attachment-only Note commit should upload exactly one asset");
    const noteAsset = noteAssets.names[0];
    assert.match(noteAsset, /^paste-[a-f0-9-]+\.png$/);
    assert.equal(await page.evaluate(async (name) => {
      const hole = await window.__rabbitholeTest.readStoredHole();
      return hole.nodes.some((node) => node.origin?.kind === "note"
        && node.markdown === `![Pasted image](asset:${name})`);
    }, noteAsset), true, "the note should persist an image ref even with empty text");

    const committedSurface = editableImageNote.locator(".doc-content");
    await committedSurface.dispatchEvent("dblclick", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
    let reentryEditor = editableImageNote.locator(".note-editor");
    await reentryEditor.waitFor();
    await reentryEditor.evaluate((editor) => editor._rhStructuredNote.focusAt());
    assert.equal(await pasteSyntheticImage(reentryEditor, "reentry-save.png", "#ea4"), true,
      "a committed-note editor should consume image paste");
    await page.waitForFunction((id) => {
      const editor = document.querySelector(`.card[data-id="${id}"] .note-editor`);
      return editor && Array.from(editor._rhStructuredNote.markdown.matchAll(/asset:paste-[a-f0-9-]+\.png/g)).length === 2;
    }, imageNoteId);
    const savedEditMarkdown = await reentryEditor.evaluate((editor) => editor._rhStructuredNote.markdown);
    const savedEditAsset = savedEditMarkdown.match(/asset:(paste-[a-f0-9-]+\.png)\)$/)?.[1];
    assert(savedEditAsset, "the pasted image link should be inserted at the caret as its own paragraph");
    await reentryEditor.evaluate((textarea) => textarea.blur());
    await editableImageNote.locator('.doc-content img[data-rh-pasted="1"]').nth(1).waitFor({ state: "attached" });
    await page.waitForFunction(async ({ id, markdown }) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return node?.markdown === markdown;
    }, { id: imageNoteId, markdown: savedEditMarkdown });
    assert((await assets()).names.includes(savedEditAsset), "blur-save should retain the newly referenced edit-session asset");

    await editableImageNote.locator(".doc-content").dispatchEvent("dblclick", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
    reentryEditor = editableImageNote.locator(".note-editor");
    await reentryEditor.waitFor();
    const assetsBeforeCancel = (await assets()).names;
    assert.equal(await pasteSyntheticImage(reentryEditor, "reentry-cancel.png", "#b5d"), true);
    await page.waitForFunction((count) => window.__rabbitholeTest.inspectAssets().then((result) => result.names.length === count + 1), assetsBeforeCancel.length);
    // The upload landing in the store and its link landing in the textarea are
    // two steps. Waiting on the store alone reads the editor a beat early.
    await page.waitForFunction((id) => {
      const editor = document.querySelector(`.card[data-id="${id}"] .note-editor`);
      return !!editor && Array.from(editor._rhStructuredNote.markdown.matchAll(/asset:paste-[a-f0-9-]+\.png/g)).length === 3;
    }, imageNoteId);
    const cancelledMarkdown = await reentryEditor.evaluate((editor) => editor._rhStructuredNote.markdown);
    assert.equal(Array.from(cancelledMarkdown.matchAll(/asset:paste-[a-f0-9-]+\.png/g)).length, 3,
      "the cancel case should finish inserting its newly uploaded image before rollback");
    await reentryEditor.press("Escape");
    await editableImageNote.locator(".doc-content").waitFor();
    await page.waitForFunction((expected) => window.__rabbitholeTest.inspectAssets().then((result) =>
      JSON.stringify(result.names) === JSON.stringify(expected)), assetsBeforeCancel);
    assert.equal(await editableImageNote.locator(".doc-content img").count(), 2,
      "Escape should restore the saved note without the cancelled pasted image");

    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    draft = page.locator(".card.note-draft");
    editor = draft.locator(".note-editor");
    assert.equal(await pasteSyntheticImage(editor, "ask.png", "#58c"), true);
    await draft.locator(".paste-attachment img").waitFor();
    await draft.locator('.ask-commit[data-commit="ask"]:not(:disabled)').waitFor();
    const askId = await draft.getAttribute("data-id");
    await draft.locator('.ask-commit[data-commit="ask"]').evaluate((button) => button.click());
    const imageAsk = page.locator(`.card[data-id="${askId}"]`);
    await imageAsk.locator(".origin-quote .origin-attachment-strip img").waitFor();
    assert.equal(await imageAsk.locator(".card-title").innerText(), "Pasted image", "an image-only ask should use the fallback title");
    await page.waitForFunction(() => document.querySelector(".card .origin-attachment-strip img"));
    await page.waitForTimeout(30);
    assert.equal(providerBodies.length, 1);
    const userContent = providerBodies[0].messages.find((message) => message.role === "user").content;
    assert.deepEqual(userContent.map((part) => part.type), ["text", "image_url"],
      "the BYOK provider request should contain the pasted image part");
    assert.match(userContent[1].image_url.url, /^data:image\/png;base64,/);
    await imageAsk.filter({ hasText: "The pasted image reached the provider." }).waitFor();
    assert.equal(await imageAsk.locator(".origin-quote .origin-attachment-strip img").count(), 1,
      "the question thumbnail should remain after the ask is answered");
    const storedAsk = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), askId);
    assert.equal(storedAsk.origin.question, "");
    assert.equal(storedAsk.origin.attachment_assets.length, 1);

    const beforeDiscard = await assets();
    point = await findCanvasBackground(page);
    await page.mouse.dblclick(point.x, point.y);
    draft = page.locator(".card.note-draft");
    editor = draft.locator(".note-editor");
    assert.equal(await pasteSyntheticImage(editor, "discard.png", "#a6c"), true);
    const discardedPreview = draft.locator(".paste-attachment img");
    await discardedPreview.waitFor();
    const discardedUrl = await discardedPreview.getAttribute("src");
    assert.deepEqual((await assets()).names, beforeDiscard.names, "an uncommitted pasted image must remain memory-only");
    await editor.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".card.note-draft"));
    assert.equal(await page.evaluate((url) => window.__revokedObjectUrls.includes(url), discardedUrl), true,
      "discarding the composer should revoke its preview URL");
    assert.deepEqual((await assets()).names, beforeDiscard.names, "discarding must leave no uploaded asset behind");
    console.log("ok web app: standalone clipboard images preview, remove, Note, Ask, provider delivery, and discard");
  } finally {
    await context.close();
  }
}

async function verifyNoteToAskConversion() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const providerBodies = [];
  let rejectProvider = false;
  await routeProvider(page, {
    providerDelayMs: 260,
    onProviderCall: (body) => providerBodies.push(body),
    streams: [
      ["TITLE: Anchored conversion\n", "The anchored note became this streamed answer."],
      ["TITLE: Follow-up conversion\n", "The follow-up note became this streamed answer."],
      ["TITLE: Standalone conversion\n", "The standalone note borrowed the root context."],
      ["TITLE: Image conversion\n", "The converted note delivered its pasted image."],
    ],
  });
  await page.route(PROVIDER_URL, (route) => {
    if (!rejectProvider) return route.fallback();
    rejectProvider = false;
    return route.fulfill({ status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Conversion rejected for rollback coverage" } }) });
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, [
      "# Conversion root context sentinel",
      "",
      "Anchored conversion phrase lives here.",
      "",
      "Protected note phrase lives here.",
    ].join("\n"));
    const rootCard = page.locator(".card.root");
    const rootId = await rootCard.getAttribute("data-id");

    // Conversion belongs to note *cards*, so each anchored fixture is written
    // as a docked note and then placed — the ordinary route to a note window.
    async function createAnchoredNote(selection, markdown) {
      await selectText(page, selection);
      const ask = page.locator("#ask");
      await ask.locator("#ask-text").fill(markdown);
      await ask.locator('.ask-commit[data-commit="note"]').click();
      await page.waitForSelector(".note-dot");
      const id = await placeDockedNote(page);
      const card = page.locator(`.card[data-id="${id}"]`);
      await card.locator(".doc-content", { hasText: markdown }).waitFor();
      return { card, id };
    }
    async function createStandaloneNote(markdown, withImage = false) {
      await page.keyboard.press("Control+K");
      await page.fill("#pal-text", "New note");
      await page.press("#pal-text", "Enter");
      const draft = page.locator(".card.note-draft");
      const editor = draft.locator(".note-editor");
      await editor.fill(markdown);
      if (withImage) {
        assert.equal(await pasteSyntheticImage(editor, "convert-note.png", "#397"), true);
        await draft.locator(".paste-attachment img").waitFor();
      }
      const id = await draft.getAttribute("data-id");
      await draft.locator('.ask-commit[data-commit="note"]:not(:disabled)').click();
      const createdCard = page.locator(`.card-note[data-id="${id}"]`);
      await createdCard.locator(".doc-content").waitFor();
      return { card: page.locator(`.card[data-id="${id}"]`), id };
    }
    async function openNoteEditor(card) {
      await card.locator(".doc-content").dispatchEvent("dblclick", {
        bubbles: true, cancelable: true, clientX: 0, clientY: 0,
      });
      const editor = card.locator(".note-editor");
      await editor.waitFor();
      return editor;
    }
    async function convertFromMenu(card) {
      await card.evaluate((element) => {
        element.__noteEditorAppeared = false;
        element.__noteEditorObserver = new MutationObserver(() => {
          if (element.querySelector(".note-editor")) element.__noteEditorAppeared = true;
        });
        element.__noteEditorObserver.observe(element, { childList: true, subtree: true });
      });
      await card.locator(".card-more").focus();
      await page.keyboard.press("Enter");
      await page.locator("#cardmenu #cm-convert").click();
      return card.evaluate((element) => {
        element.__noteEditorObserver.disconnect();
        const appeared = element.__noteEditorAppeared;
        delete element.__noteEditorObserver;
        delete element.__noteEditorAppeared;
        return { appeared, count: element.querySelectorAll(".note-editor").length };
      });
    }

    const anchored = await createAnchoredNote("Anchored conversion phrase", "Anchored note draft");

    // A card-composer note has no anchor and is born as a child window.
    await rootCard.locator(".nc-handle").click();
    await rootCard.locator(".nc-inner textarea").fill("Follow-up note draft");
    await rootCard.locator('.nc-inner .ask-commit[data-commit="note"]').click();
    let followupCard = page.locator(".card-note", { hasText: "Follow-up note draft" });
    await followupCard.locator(".doc-content", { hasText: "Follow-up note draft" }).waitFor();
    const followupId = await followupCard.getAttribute("data-id");
    followupCard = page.locator(`.card[data-id="${followupId}"]`);

    // Entering edit ADDS the bar under the text — it never carves the bar out
    // of the card: for a plain note the first line keeps its exact rect on the
    // way in, and every line lands back where it was on the way out.
    const measureFirstLine = (card) => {
      const dc = card.querySelector(".doc-content");
      const range = document.createRange();
      const first = document.createTreeWalker(dc, NodeFilter.SHOW_TEXT).nextNode();
      range.setStart(first, 0); range.setEnd(first, 1);
      const glyph = range.getBoundingClientRect();
      const rect = dc.getBoundingClientRect();
      return { glyph: { left: glyph.left, top: glyph.top },
        origin: { left: rect.left, top: rect.top },
        height: card.getBoundingClientRect().height };
    };
    // Playwright's auto-scroll can leave the overflow-hidden canvas viewport
    // displaced; the product owns that scroll at zero, so measure from zero.
    await page.evaluate(() => { const viewport = document.getElementById("viewport"); viewport.scrollTop = 0; viewport.scrollLeft = 0; });
    const restLine = await followupCard.evaluate(measureFirstLine);
    await followupCard.locator(".doc-content").dispatchEvent("dblclick", {
      bubbles: true, cancelable: true, clientX: 0, clientY: 0,
    });
    await followupCard.locator(".note-editor").waitFor();
    const editLine = await followupCard.evaluate((card) => {
      const editor = card.querySelector(".note-editor");
      const rect = editor.getBoundingClientRect();
      const style = getComputedStyle(editor);
      return { origin: { left: rect.left + parseFloat(style.paddingLeft), top: rect.top + parseFloat(style.paddingTop) },
        height: card.getBoundingClientRect().height,
        bar: card.querySelector(".ask-actions").getBoundingClientRect().height };
    });
    const stable = (a, b) => Math.abs(a - b) < 0.6;
    assert(stable(editLine.origin.left, restLine.origin.left) && stable(editLine.origin.top, restLine.origin.top),
      `entering edit must keep the text column's origin: ${JSON.stringify({ restLine, editLine })}`);
    assert(Math.abs(editLine.height - (restLine.height + editLine.bar)) < 1.5,
      `while editing, the card grows by exactly the bar's height: ${JSON.stringify({ restLine, editLine })}`);
    await followupCard.locator(".note-editor").press("Escape");
    await followupCard.locator(".doc-content").waitFor();
    const settledLine = await followupCard.evaluate(measureFirstLine);
    assert(stable(settledLine.glyph.left, restLine.glyph.left) && stable(settledLine.glyph.top, restLine.glyph.top)
      && Math.abs(settledLine.height - restLine.height) < 1,
      `leaving edit must land every line back where it was: ${JSON.stringify({ restLine, settledLine })}`);

    const protectedNote = await createAnchoredNote("Protected note phrase", "Note with a child");
    await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
    await protectedNote.card.locator(".nc-handle").focus();
    await page.keyboard.press("Enter");
    const protectedComposer = protectedNote.card.locator(".nc-inner textarea");
    await protectedComposer.fill("Child note blocks conversion");
    await protectedComposer.press("Enter");
    await page.locator(".card-note", { hasText: "Child note blocks conversion" }).waitFor();

    const standalone = await createStandaloneNote("Standalone note question");
    const imageNote = await createStandaloneNote("What does this pasted diagram show?", true);
    const rejected = await createStandaloneNote("Rejected note exactly as first written.");
    const emptyNote = await createStandaloneNote("Empty body menu fixture");
    await zoomToFit(page);
    await page.waitForTimeout(350);

    const cardMenu = page.locator("#cardmenu");
    await anchored.card.locator(".card-more").click();
    assert.equal(await cardMenu.locator("#cm-convert").isVisible(), true,
      "Convert to Ask should appear for an eligible note");
    await page.keyboard.press("Escape");
    await rootCard.locator(".card-more").click();
    assert.equal(await cardMenu.locator("#cm-convert").isVisible(), false,
      "Convert to Ask should be absent on the non-note root");
    await page.keyboard.press("Escape");
    await protectedNote.card.locator(".card-more").click();
    assert.equal(await cardMenu.locator("#cm-convert").isVisible(), false,
      "Convert to Ask should be absent when a note has children");
    await page.keyboard.press("Escape");
    const frozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
    const frozenPage = await context.newPage();
    await frozenPage.setContent(frozenHtml, { waitUntil: "load" });
    const frozenCard = frozenPage.locator(`.card[data-id="${anchored.id}"]`);
    await frozenCard.locator(".card-more").click();
    assert.equal(await frozenPage.locator("#cardmenu").locator("#cm-convert").isVisible(), false,
      "Convert to Ask should be absent in a frozen snapshot");
    await frozenPage.close();

    const emptyPortable = await page.evaluate(() => window.__rabbitholeTest.exportPortable());
    emptyPortable.hole.nodes = emptyPortable.hole.nodes.filter((node) => node.id === emptyPortable.hole.root_id || node.id === emptyNote.id);
    emptyPortable.hole.nodes.find((node) => node.id === emptyNote.id).markdown = " \n ";
    emptyPortable.assets = {};
    const emptyPage = await context.newPage();
    await routeProvider(emptyPage);
    await emptyPage.goto(baseUrl, { waitUntil: "networkidle" });
    const emptyPagePreviousHole = await emptyPage.evaluate(() => window.__rabbitholeTest.currentHoleId());
    await emptyPage.setInputFiles("#file-md", {
      name: "empty-note-menu.rabbithole", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(emptyPortable)),
    });
    await emptyPage.waitForFunction((previous) => window.__rabbitholeTest.currentHoleId() !== previous, emptyPagePreviousHole);
    const importedEmptyCard = emptyPage.locator(`.card[data-id="${emptyNote.id}"]`);
    await importedEmptyCard.locator(".card-more").click();
    assert.equal(await emptyPage.locator("#cardmenu #cm-convert").isVisible(), false,
      "Convert to Ask should be absent when an otherwise eligible note body is empty");
    await emptyPage.close();

    let editor = await openNoteEditor(followupCard);
    assert.deepEqual(await followupCard.locator(".note-edit-actions").evaluate((actions) => {
      const surface = actions.closest(".card-body");
      const commits = Array.from(actions.querySelectorAll(".ask-commit"));
      const actionsRect = actions.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const card = actions.closest(".card");
      const body = actions.closest(".card-body");
      // The canvas paints through one scaled transform, so screen rects and
      // computed border widths only agree once the borders are scaled too.
      const cardRect = card.getBoundingClientRect();
      const cardStyle = getComputedStyle(card);
      const bodyStyle = getComputedStyle(body);
      const surfaceStyle = getComputedStyle(surface);
      const scale = cardRect.width / card.offsetWidth;
      const cardInner = {
        left: cardRect.left + parseFloat(cardStyle.borderLeftWidth) * scale,
        right: cardRect.right - parseFloat(cardStyle.borderRightWidth) * scale,
        bottom: cardRect.bottom - parseFloat(cardStyle.borderBottomWidth) * scale,
      };
      const originalWidth = card.style.width;
      card.style.width = "300px";
      const narrowActionsRect = actions.getBoundingClientRect();
      const narrowCommitRects = commits.map((button) => button.getBoundingClientRect());
      const narrowFits = actions.scrollWidth <= actions.clientWidth + 1 && commits.every((button) => button.scrollWidth <= button.clientWidth + 1)
        && narrowCommitRects.every((rect) => rect.left >= narrowActionsRect.left - 1 && rect.right <= narrowActionsRect.right + 1);
      const narrowSplit = Math.abs(narrowCommitRects[0].width - narrowCommitRects[1].width) < 1;
      card.style.width = originalWidth;
      return {
        focused: document.activeElement === surface.querySelector(".note-editor"),
        composerBar: actions.classList.contains("ask-actions") && getComputedStyle(actions).borderTopWidth === "1px"
          && Math.abs(actionsRect.width - surfaceRect.width) < 1,
        // The same flush footer the standalone note composer wears: pinned to
        // the card's bottom edge, full-bleed to its sides, no body padding
        // left to inset it, and rounded into the card's own bottom corners.
        bodyPadding: [bodyStyle.paddingTop, bodyStyle.paddingRight, bodyStyle.paddingBottom, bodyStyle.paddingLeft].join(" "),
        flushBottom: Math.abs(actionsRect.bottom - cardInner.bottom) < 1,
        flushSides: Math.abs(actionsRect.left - cardInner.left) < 1 && Math.abs(actionsRect.right - cardInner.right) < 1,
        footerCorners: surfaceStyle.overflow === "hidden"
          && surfaceStyle.borderBottomLeftRadius === cardStyle.borderBottomLeftRadius
          && surfaceStyle.borderBottomRightRadius === cardStyle.borderBottomRightRadius,
        resizeHidden: getComputedStyle(card.querySelector(".card-resize")).display === "none",
        hintCount: actions.querySelectorAll(".note-edit-hint").length,
        commitsVisible: getComputedStyle(actions.querySelector(".commit-actions")).display === "flex"
          && commits.every((button) => getComputedStyle(button).display !== "none"),
        narrowFits, narrowSplit,
        commits: commits.map((button) => ({
          kind: button.dataset.commit, hint: button.querySelector("kbd")?.textContent,
          label: button.textContent.replace(button.querySelector("kbd")?.textContent ?? "", "").trim(),
          title: button.title,
        })),
      };
    }), {
      focused: true, composerBar: true, bodyPadding: "0px 0px 0px 0px",
      flushBottom: true, flushSides: true, footerCorners: true, resizeHidden: true,
      hintCount: 0, commitsVisible: true, narrowFits: true, narrowSplit: true,
      commits: [
        { kind: "note", hint: "↵", label: "Note", title: "Save note (Enter)" },
        { kind: "ask", hint: "⌘↵", label: "Ask", title: "Ask (Command/Control+Enter)" },
      ],
    }, "editing an existing note should use the standalone composer's flush footer and its verbatim Note/Ask bar");
    await editor.fill("");
    assert.equal(await followupCard.locator('.note-edit-actions [data-commit="ask"]').isDisabled(), true,
      "an empty note question should disable Ask");
    await editor.fill("Saved follow-up note edit");
    await followupCard.locator('.note-edit-actions .ask-commit[data-commit="note"]').click();
    await page.waitForFunction(async (id) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return node?.origin?.kind === "note" && node.markdown === "Saved follow-up note edit";
    }, followupId);
    assert.equal(providerBodies.length, 0, "the Note commit should save the edit without asking");

    const anchoredBefore = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), anchored.id);
    assert.deepEqual(await convertFromMenu(anchored.card), { appeared: false, count: 0 },
      "the menu should convert immediately without creating a note editor");
    await page.waitForFunction(async (id) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return node?.status === "pending" && node.origin?.question === "Anchored note draft";
    }, anchored.id);
    assert.equal(await rootCard.locator(`mark[data-child="${anchored.id}"].mark-pending:not(.mark-note)`).count(), 1,
      "converting an anchored note should replace note ink with a pending mark");
    assert.equal(await anchored.card.locator(".doc-content", { hasText: "Anchored note draft" }).count(), 0,
      "the pending answer body should no longer contain the note");
    await anchored.card.locator(".doc-content", { hasText: "The anchored note became this streamed answer." }).waitFor();
    const anchoredAfter = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), anchored.id);
    assert.deepEqual({ parent_id: anchoredAfter.parent_id, branch_type: anchoredAfter.origin.branch_type,
      selected_text: anchoredAfter.origin.selected_text, anchor: anchoredAfter.origin.anchor },
    { parent_id: rootId, branch_type: "selection", selected_text: anchoredBefore.origin.selected_text, anchor: anchoredBefore.origin.anchor },
    "an anchored note should retain its parent, selection, and exact anchor as an ask");
    assert.equal(await rootCard.locator(`mark[data-child="${anchored.id}"].mark-ready:not(.mark-note)`).count(), 1,
      "the converted note mark should become ordinary ready ink after answering");
    await anchored.card.locator(".card-more").click();
    assert.equal(await cardMenu.locator("#cm-convert").isVisible(), false,
      "Convert to Ask should disappear once the card is an ask");
    await page.keyboard.press("Escape");

    editor = await openNoteEditor(followupCard);
    await editor.fill("Follow-up conversion via Ask button");
    await followupCard.locator('.note-edit-actions [data-commit="ask"]').click();
    await followupCard.locator(".doc-content", { hasText: "The follow-up note became this streamed answer." }).waitFor();
    const storedFollowup = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), followupId);
    assert.deepEqual({ parent_id: storedFollowup.parent_id, branch_type: storedFollowup.origin.branch_type,
      selected_text: storedFollowup.origin.selected_text, anchor: storedFollowup.origin.anchor },
    { parent_id: rootId, branch_type: "followup", selected_text: "", anchor: null },
    "an anchorless child note should become a follow-up ask on the same parent");

    editor = await openNoteEditor(standalone.card);
    // The composer's own Enter contract, kept verbatim by the editor: ⌘↵ asks.
    await editor.press("Control+Enter");
    await standalone.card.locator(".doc-content", { hasText: "The standalone note borrowed the root context." }).waitFor();
    const storedStandalone = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), standalone.id);
    assert.equal(storedStandalone.parent_id, null, "a standalone note should remain parentless after conversion");
    assert.equal(storedStandalone.origin.branch_type, "followup");
    const standalonePrompt = providerBodies[2].messages.at(-1).content;
    assert.match(typeof standalonePrompt === "string" ? standalonePrompt : standalonePrompt[0].text,
      /Conversion root context sentinel/, "a parentless converted ask should still receive the root document as context");

    editor = await openNoteEditor(imageNote.card);
    const imageMarkdown = await editor.evaluate((surface) => surface._rhStructuredNote.markdown);
    const imageAsset = imageMarkdown.match(/asset:(paste-[a-f0-9-]+\.png)/)?.[1];
    assert(imageAsset, "the image-note fixture should contain a durable pasted asset ref");
    await editor.press("Control+Enter");
    await imageNote.card.locator(".origin-attachment-strip img").waitFor();
    await imageNote.card.locator(".doc-content", { hasText: "The converted note delivered its pasted image." }).waitFor();
    const imageUserContent = providerBodies[3].messages.find((message) => message.role === "user").content;
    assert.deepEqual(imageUserContent.map((part) => part.type), ["text", "image_url"],
      "converted note images should use the existing provider attachment contract");
    const storedImageAsk = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), imageNote.id);
    assert.deepEqual(storedImageAsk.origin.attachment_assets, [imageAsset]);
    assert((await page.evaluate(() => window.__rabbitholeTest.inspectAssets())).names.includes(imageAsset),
      "a converted note attachment should remain live after its markdown body is cleared");

    editor = await openNoteEditor(rejected.card);
    await editor.fill("Rejected note exactly as edited.");
    const rejectedBefore = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), rejected.id);
    rejectProvider = true;
    await editor.press("Control+Enter");
    await rejected.card.locator(".doc-content", { hasText: "Rejected note exactly as edited." }).waitFor();
    await page.waitForTimeout(900);
    await page.waitForFunction(async (id) => {
      const node = (await window.__rabbitholeTest.readStoredHole()).nodes.find((entry) => entry.id === id);
      return node?.origin?.kind === "note" && node.markdown === "Rejected note exactly as edited.";
    }, rejected.id);
    const rejectedAfter = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), rejected.id);
    assert.deepEqual({ ...rejectedAfter, markdown: rejectedBefore.markdown }, rejectedBefore,
      "a rejected conversion should restore every note field while preserving the reviewed edit text");
    assert.equal(await rejected.card.evaluate((card) => card.classList.contains("card-note")), true,
      "provider rejection should restore the exact card as a note");

    console.log("ok web app: note-to-ask availability, commit intents, all shapes, marks, attachments, and rollback");
  } finally {
    await context.close();
  }
}

async function pasteSyntheticImage(editor, fileName, color) {
  return editor.evaluate(async (textarea, { fileName, color }) => {
    textarea.focus();
    const canvas = document.createElement("canvas"); canvas.width = 12; canvas.height = 8;
    const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], fileName, { type: "image/png" }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    if (!event.clipboardData) Object.defineProperty(event, "clipboardData", { value: transfer });
    const consumed = !textarea.dispatchEvent(event);
    return consumed;
  }, { fileName, color });
}

async function verifyLogicalMarkGrouping() {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  let providerCalls = 0;
  await routeProvider(page, {
    keyStatus: () => 200,
    onProviderCall: () => { providerCalls += 1; },
    streams: [
      ["TITLE: Grouped mark branch\n", "The answer reached from every fragment of the grouped mark."],
      ["TITLE: Overlapping mark branch\n", "The nested answer proves overlapping mark discovery."],
      ["TITLE: Unrelated mark branch\n", "A separate answer used to prove hover isolation."],
    ],
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, [
      "# Logical mark groups",
      "",
      "This paragraph begins before the grouped selection and continues through a distinctive phrase.",
      "",
      "- This list item carries the selection through its unmistakable ending.",
      "",
      "A separate paragraph contains an unrelated anchor for isolation.",
    ].join("\n"));

    await selectAcrossBlocks(page, "grouped selection", "unmistakable ending");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Why should this whole range highlight?");
    await page.click('#ask .ask-commit[data-commit="ask"]');
    const groupedCanvasMark = page.locator('.card.root mark[aria-label="Open branch: Grouped mark branch"].mark-ready');
    await groupedCanvasMark.first().waitFor();
    const groupedId = await groupedCanvasMark.first().getAttribute("data-child");

    await selectText(page, "distinctive phrase");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "How does this overlap the larger range?");
    await page.click('#ask .ask-commit[data-commit="ask"]');
    const overlappingCanvasMark = page.locator('.card.root mark[aria-label="Open branch: Overlapping mark branch"].mark-ready');
    await overlappingCanvasMark.waitFor();
    const overlappingId = await overlappingCanvasMark.getAttribute("data-child");

    await selectText(page, "unrelated anchor");
    await page.waitForSelector("#ask.visible");
    await page.fill("#ask-text", "Why is this mark separate?");
    await page.click('#ask .ask-commit[data-commit="ask"]');
    const unrelatedCanvasMark = page.locator('.card.root mark[aria-label="Open branch: Unrelated mark branch"].mark-ready');
    await unrelatedCanvasMark.waitFor();
    const unrelatedId = await unrelatedCanvasMark.getAttribute("data-child");
    assert.equal(providerCalls, 3, "the mark-group fixture should create its grouped, overlapping, and unrelated branches");

    const blockCoverage = await groupedCanvasMark.evaluateAll((marks) => ({
      count: marks.length,
      blocks: [...new Set(marks.map((mark) => mark.closest("p, li")?.tagName).filter(Boolean))],
    }));
    assert(blockCoverage.count >= 2, `the cross-block selection must render at least two mark fragments: ${JSON.stringify(blockCoverage)}`);
    assert(blockCoverage.blocks.includes("P") && blockCoverage.blocks.includes("LI"),
      `the grouped mark must span paragraph and list-item ancestors: ${JSON.stringify(blockCoverage)}`);

    assert.equal(await overlappingCanvasMark.evaluate((mark, parentId) => {
      let ancestor = mark.parentElement;
      while (ancestor && !ancestor.classList.contains("doc-content")) {
        if (ancestor.matches("mark[data-child]") && ancestor.dataset.child === parentId) return true;
        ancestor = ancestor.parentElement;
      }
      return false;
    }, groupedId), true, "the overlapping fixture must render as a nested logical mark");
    await exerciseOverlappingMarkHover(page, groupedId, overlappingId, unrelatedId);
    await exerciseGroupedMarkHover(page, ".card.root .doc-content", groupedId, unrelatedId, true);

    await page.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
    await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
    await page.waitForSelector("body:not(.mode-canvas) #reader-main");
    await exerciseGroupedMarkHover(page, "#reader-main .doc-content", groupedId, unrelatedId, false);
    const readerMarks = page.locator(`#reader-main mark[data-child="${groupedId}"]`);
    await page.keyboard.press("Shift");
    await readerMarks.nth(1).focus();
    await assertStrongMarkGroup(page, "#reader-main .doc-content", groupedId, unrelatedId, "Reader DOM focus");
    assert.equal(await readerMarks.evaluateAll((marks) => marks.every((mark) => mark.classList.contains("mark-dom-focus"))), true,
      "Reader DOM focus must apply its state to every fragment in the logical group");
    assert.notEqual(await readerMarks.nth(1).evaluate((mark) => getComputedStyle(mark).outlineStyle), "none",
      "the actually focused Reader fragment must retain its visible focus ring");

    await page.evaluate(() => document.getElementById("reader-restore").click());
    await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
    await page.waitForSelector("body.mode-canvas");
    await verifyNonFirstFragmentCanvasNavigation(page, groupedId);

    const frozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
    const frozenPage = await context.newPage();
    await frozenPage.setContent(frozenHtml, { waitUntil: "load" });
    await frozenPage.waitForSelector(".card.root .doc-content");
    await frozenPage.waitForSelector("body.mode-canvas");
    await exerciseGroupedMarkHover(frozenPage, ".card.root .doc-content", groupedId, unrelatedId, true);
    await verifyNonFirstFragmentCanvasNavigation(frozenPage, groupedId);
    await frozenPage.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
    await frozenPage.waitForFunction(() => !document.body.classList.contains("mode-flight"));
    await frozenPage.waitForSelector("body:not(.mode-canvas) #reader-main");
    await exerciseGroupedMarkHover(frozenPage, "#reader-main .doc-content", groupedId, unrelatedId, false);
    const frozenReaderMarks = frozenPage.locator(`#reader-main mark[data-child="${groupedId}"]`);
    await frozenPage.keyboard.press("Shift");
    await frozenReaderMarks.nth(1).focus();
    await assertStrongMarkGroup(frozenPage, "#reader-main .doc-content", groupedId, unrelatedId, "frozen Reader DOM focus");
    assert.notEqual(await frozenReaderMarks.nth(1).evaluate((mark) => getComputedStyle(mark).outlineStyle), "none",
      "the focused frozen Reader fragment must retain its visible focus ring");
    await frozenPage.close();
  } finally {
    await context.close();
  }
}

async function exerciseOverlappingMarkHover(page, groupedId, overlappingId, unrelatedId) {
  const overlapping = page.locator(`.card.root mark[data-child="${overlappingId}"]`).first();
  await overlapping.hover();
  await page.waitForFunction(({ groupedId, overlappingId }) => {
    const marks = [...document.querySelectorAll(".card.root .doc-content mark[data-child]")];
    const active = marks.filter((mark) => mark.dataset.child === groupedId || mark.dataset.child === overlappingId);
    return active.length >= 3 && active.every((mark) => mark.classList.contains("mark-hover"));
  }, { groupedId, overlappingId });
  const state = await page.evaluate(({ groupedId, overlappingId, unrelatedId }) => {
    const marks = [...document.querySelectorAll(".card.root .doc-content mark[data-child]")];
    return {
      grouped: marks.filter((mark) => mark.dataset.child === groupedId).every((mark) => mark.classList.contains("mark-hover")),
      overlapping: marks.filter((mark) => mark.dataset.child === overlappingId).every((mark) => mark.classList.contains("mark-hover")),
      unrelated: marks.filter((mark) => mark.dataset.child === unrelatedId).some((mark) => mark.classList.contains("mark-hover")),
    };
  }, { groupedId, overlappingId, unrelatedId });
  assert.deepEqual(state, { grouped: true, overlapping: true, unrelated: false },
    "hovering a nested mark must activate every represented logical group without affecting unrelated marks");
  await page.locator("#t-theme").hover();
  assert.equal(await page.locator(".card.root .doc-content mark.mark-hover").count(), 0,
    "leaving nested marks must clear every represented logical group");
}

async function exerciseGroupedMarkHover(page, scope, groupedId, unrelatedId, expectEdge) {
  const marks = page.locator(`${scope} mark[data-child="${groupedId}"]`);
  const last = marks.nth((await marks.count()) - 1);
  await marks.first().hover();
  await assertStrongMarkGroup(page, scope, groupedId, unrelatedId, "mark hover");
  assert.equal(await marks.evaluateAll((fragments) => fragments.every((mark) => mark.classList.contains("mark-hover"))), true,
    "hovering one fragment must apply mark-hover to its whole logical group");
  if (expectEdge) assert.equal(await edgeHighlightState(page, groupedId), true,
    "Canvas mark hover must highlight the matching branch edge");

  await marks.first().evaluate((first) => {
    const root = first.closest(".doc-content");
    const peers = [...root.querySelectorAll("mark[data-child]")].filter((mark) => mark.dataset.child === first.dataset.child);
    first.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: peers[peers.length - 1] }));
  });
  assert.equal(await marks.evaluateAll((fragments) => fragments.every((mark) => mark.classList.contains("mark-hover"))), true,
    "moving directly between fragments of one logical mark must preserve group hover state");
  if (expectEdge) assert.equal(await edgeHighlightState(page, groupedId), true,
    "moving within one logical mark must preserve its Canvas edge highlight");
  await last.hover();
  await assertStrongMarkGroup(page, scope, groupedId, unrelatedId, "mark hover after an intra-group move");

  await page.locator("#t-theme").hover();
  await page.waitForFunction(({ scope, groupedId, unrelatedId }) => {
    const root = document.querySelector(scope);
    const marks = [...root.querySelectorAll("mark[data-child]")];
    const group = marks.filter((mark) => mark.dataset.child === groupedId)
      .map((mark) => getComputedStyle(mark).backgroundColor);
    const unrelated = marks.find((mark) => mark.dataset.child === unrelatedId);
    const normal = unrelated && getComputedStyle(unrelated).backgroundColor;
    return group.length > 0 && group.every((color) => color === normal);
  }, { scope, groupedId, unrelatedId });
  const cleared = await readMarkBackgrounds(page, scope, groupedId, unrelatedId);
  assert.equal(cleared.group.every((color) => color === cleared.unrelated), true,
    `leaving the logical mark must restore every fragment's normal background: ${JSON.stringify(cleared)}`);
  assert.equal(await marks.evaluateAll((fragments) => fragments.every((mark) => !mark.classList.contains("mark-hover"))), true,
    "leaving the logical mark must clear group hover state");
  if (expectEdge) assert.equal(await edgeHighlightState(page, groupedId), false,
    "leaving a Canvas logical mark must clear its branch edge highlight");
}

async function assertStrongMarkGroup(page, scope, groupedId, unrelatedId, label) {
  await page.waitForFunction(({ scope, groupedId, unrelatedId }) => {
    const root = document.querySelector(scope);
    const marks = [...root.querySelectorAll("mark[data-child]")];
    const group = marks.filter((mark) => mark.dataset.child === groupedId)
      .map((mark) => getComputedStyle(mark).backgroundColor);
    const unrelated = marks.find((mark) => mark.dataset.child === unrelatedId);
    const normal = unrelated && getComputedStyle(unrelated).backgroundColor;
    return group.length >= 2 && group.every((color) => color === group[0]) && group[0] !== normal;
  }, { scope, groupedId, unrelatedId });
  const state = await readMarkBackgrounds(page, scope, groupedId, unrelatedId);
  assert(state.group.length >= 2, `${label}: the fixture must expose multiple fragments`);
  assert.equal(state.group.every((color) => color === state.group[0]), true,
    `${label}: every logical fragment must receive the same strong background: ${JSON.stringify(state)}`);
  assert.notEqual(state.group[0], state.unrelated,
    `${label}: an unrelated mark must retain its normal background: ${JSON.stringify(state)}`);
}

async function readMarkBackgrounds(page, scope, groupedId, unrelatedId) {
  return page.evaluate(({ scope, groupedId, unrelatedId }) => {
    const root = document.querySelector(scope);
    const marks = [...root.querySelectorAll("mark[data-child]")];
    const group = marks.filter((mark) => mark.dataset.child === groupedId)
      .map((mark) => getComputedStyle(mark).backgroundColor);
    const unrelated = marks.find((mark) => mark.dataset.child === unrelatedId);
    return { group, unrelated: unrelated && getComputedStyle(unrelated).backgroundColor };
  }, { scope, groupedId, unrelatedId });
}

async function edgeHighlightState(page, childId) {
  return page.evaluate((id) => {
    const edge = [...document.querySelectorAll("#edges path[data-child]")]
      .find((path) => path.dataset.child === id);
    return !!edge && edge.classList.contains("edge-hl");
  }, childId);
}

async function verifyNonFirstFragmentCanvasNavigation(page, childId) {
  const marks = page.locator(`.card.root mark[data-child="${childId}"]`);
  const nonFirst = marks.nth((await marks.count()) - 1);
  const armFlashProbe = () => page.evaluate(() => {
    window.__logicalMarkDiveFlashed = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".card:not(.root).flash")) {
        window.__logicalMarkDiveFlashed = true;
        observer.disconnect();
      }
    });
    observer.observe(document.getElementById("world"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  });

  await armFlashProbe();
  await nonFirst.click();
  await page.waitForFunction(() => window.__logicalMarkDiveFlashed === true);
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true,
    "clicking a non-first mark fragment must dive to the branch in Canvas");
  await page.waitForTimeout(400);
  await zoomToFit(page);
  await page.waitForTimeout(400);

  await nonFirst.focus();
  await armFlashProbe();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__logicalMarkDiveFlashed === true);
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true,
    "pressing Enter on a non-first mark fragment must dive to the branch in Canvas");
  await page.waitForTimeout(400);
  await zoomToFit(page);
  await page.waitForTimeout(400);
}

async function verifyCardMenu() {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await routeProvider(page, {
    streams: [
      ["TITLE: Alpha branch\n", "Alpha branch markdown body."],
      ["TITLE: Beta branch\n", "Beta branch markdown body."],
      ["TITLE: Alpha descendant\n", "The descendant stays tidy under its parent."],
    ],
  });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await createDocument(page, "# Card menu fixture\n\nAlpha anchor starts one branch.\n\nBeta anchor starts its sibling.");
    const rootCard = page.locator(".card.root");
    const rootId = await rootCard.getAttribute("data-id");

    await selectText(page, "Alpha anchor");
    await page.locator("#ask").locator("#ask-text").fill("Why alpha?");
    await page.locator("#ask").locator('[data-commit="ask"]').click();
    const alphaCard = page.locator('.card:not(.root)', { hasText: "Alpha branch markdown body." });
    await alphaCard.waitFor();
    const alphaId = await alphaCard.getAttribute("data-id");

    await selectText(page, "Beta anchor");
    await page.locator("#ask").locator("#ask-text").fill("Why beta?");
    await page.locator("#ask").locator('[data-commit="ask"]').click();
    const betaCard = page.locator('.card:not(.root)', { hasText: "Beta branch markdown body." });
    await betaCard.waitFor();
    const betaId = await betaCard.getAttribute("data-id");

    await zoomToFit(page);
    await page.waitForTimeout(350);
    await alphaCard.locator(".nc-handle").focus();
    await page.keyboard.press("Enter");
    await alphaCard.locator(".nc-inner textarea").fill("Add one descendant.");
    await alphaCard.locator(".nc-inner textarea").press("Control+Enter");
    const descendantCard = page.locator('.card:not(.root)', { hasText: "The descendant stays tidy under its parent." });
    await descendantCard.waitFor();
    const descendantId = await descendantCard.getAttribute("data-id");
    await zoomToFit(page);
    await page.waitForTimeout(350);

    const cardMenu = page.locator("#cardmenu");
    const alphaTrigger = alphaCard.locator(".card-more");
    assert.deepEqual(await alphaCard.locator(".card-head .card-btn").evaluateAll((buttons) => buttons.map((button) => ({
      name: button.getAttribute("aria-label"), glyph: button.querySelector("svg")?.getBoundingClientRect().width,
    }))), [
      { name: "Collapse card", glyph: 16 },
      { name: "Expand document", glyph: 16 },
      { name: "Card menu", glyph: 16 },
    ], "card headers should expose three size-matched controls with the ⋮ menu last, in real DOM order");
    await alphaTrigger.focus();
    await page.keyboard.press("Enter");
    await cardMenu.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.id === "cm-textdown");
    await page.waitForTimeout(160);
    const anchorState = await page.evaluate((id) => {
      const trigger = document.querySelector(`.card[data-id="${id}"] .card-more`);
      const menu = document.getElementById("cardmenu");
      const a = trigger.getBoundingClientRect(), m = menu.getBoundingClientRect();
      return { controls: trigger.getAttribute("aria-controls"), expanded: trigger.getAttribute("aria-expanded"),
        placement: menu.dataset.placement, endOffset: Math.abs(a.right - m.right),
        gap: menu.dataset.placement.startsWith("top") ? a.top - m.bottom : m.top - a.bottom,
        tokenGap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--surface-gap")) };
    }, alphaId);
    assert.equal(anchorState.controls, "cardmenu");
    assert.equal(anchorState.expanded, "true");
    assert.match(anchorState.placement, /^(?:top|bottom)-end$/);
    assert(anchorState.endOffset < 1 && Math.abs(anchorState.gap - anchorState.tokenGap) < 1,
      `card menu should stay end-aligned to its card trigger (${JSON.stringify(anchorState)})`);
    await page.keyboard.press("Escape");
    await cardMenu.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("card-more")), true,
      "Card menu Escape should restore focus to its own trigger");

    await rootCard.locator(".card-more").click();
    await cardMenu.waitFor({ state: "visible" });
    assert.equal(await cardMenu.locator("#cm-delete").isVisible(), false, "the root card menu should omit Delete branch");
    assert.equal(await cardMenu.locator("#cm-pin").isVisible(), true, "the root card must offer window pinning");
    await page.keyboard.press("Escape");

    await alphaTrigger.click();
    await cardMenu.waitFor({ state: "visible" });
    assert.equal(await cardMenu.locator("#cm-pin").isVisible(), true, "a connected branch card must offer window pinning");
    await page.keyboard.press("Escape");

    await alphaTrigger.click();
    await cardMenu.locator("#cm-textup").click();
    assert.deepEqual(await page.evaluate(({ alphaId, betaId }) => [alphaId, betaId].map((id) =>
      parseFloat(getComputedStyle(document.querySelector(`.card[data-id="${id}"] .doc-content`)).fontSize)), { alphaId, betaId }), [15, 14],
    "A+ should enlarge only the card whose menu is open");
    assert.equal(await page.evaluate(() => localStorage.getItem("rh-reading-scale")), null,
      "per-node text size should create no global localStorage override");
    await page.keyboard.press("Escape");
    await page.waitForFunction(async ({ alphaId, betaId }) => {
      const hole = await window.__rabbitholeTest.readStoredHole();
      return hole.nodes.find((node) => node.id === alphaId)?.font_scale === 1.1
        && hole.nodes.find((node) => node.id === betaId)?.font_scale === 1;
    }, { alphaId, betaId });
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id)?.font_scale, alphaId), 1.1,
      "the node scale should remain stable after debounced saves settle");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(`.card[data-id="${alphaId}"] .doc-content`);
    const reloadedScaleState = await page.evaluate(async ({ alphaId, betaId }) => ({
      rendered: [alphaId, betaId].map((id) => parseFloat(getComputedStyle(document.querySelector(`.card[data-id="${id}"] .doc-content`)).fontSize)),
      stored: (await window.__rabbitholeTest.readStoredHole()).nodes.filter((node) => node.id === alphaId || node.id === betaId).map((node) => ({ id: node.id, scale: node.font_scale })),
      portable: (await window.__rabbitholeTest.exportPortable()).hole.nodes.filter((node) => node.id === alphaId || node.id === betaId).map((node) => ({ id: node.id, scale: node.font_scale })),
    }), { alphaId, betaId });
    assert.deepEqual(reloadedScaleState.rendered, [15, 14],
      `the selected card's font_scale should survive reload without affecting its sibling (${JSON.stringify(reloadedScaleState)})`);

    await page.locator(`.card[data-id="${alphaId}"]`).locator('[aria-label="Expand document"]').click();
    await page.waitForSelector("body:not(.mode-canvas)");
    assert.equal(await page.locator("#reader-main").locator(".doc-content").evaluate((doc) => parseFloat(getComputedStyle(doc).fontSize)), 19,
      "the reader should render the maximized card's font_scale");
    await page.locator("#taskbar").locator("#r-textdown").click();
    assert.equal(await page.locator("#reader-main").locator(".doc-content").evaluate((doc) => parseFloat(getComputedStyle(doc).fontSize)), 17,
      "the reader taskbar should edit the same node font_scale");
    await page.waitForFunction(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id)?.font_scale === 1, alphaId);
    await page.locator("#taskbar").locator("#reader-restore").click();
    await page.waitForSelector("body.mode-canvas");

    const storedAlpha = await page.evaluate(async (id) => (await window.__rabbitholeTest.readStoredHole()).nodes.find((node) => node.id === id), alphaId);
    const expectedMarkdown = "# " + storedAlpha.title + "\n\n> Asked about: “" + storedAlpha.origin.selected_text + "” — " + storedAlpha.origin.question + "\n\n" + storedAlpha.markdown.trim() + "\n";
    await page.locator(`.card[data-id="${alphaId}"]`).locator(".card-more").click();
    await cardMenu.locator("#cm-copy").click();
    await page.waitForFunction(async (expected) => (await navigator.clipboard.readText()) === expected, expectedMarkdown);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedMarkdown,
      "Copy as Markdown should copy only the menu's node through the shared document builder");

    await page.locator(`.card[data-id="${alphaId}"]`).locator(".card-more").click();
    await cardMenu.locator("#cm-rename").click();
    const alphaTitle = page.locator(`.card[data-id="${alphaId}"]`).locator(".card-title");
    assert.deepEqual(await alphaTitle.evaluate((title) => ({ editable: title.getAttribute("contenteditable"), focused: document.activeElement === title })),
      { editable: "plaintext-only", focused: true }, "Rename should enter the existing title editor with its caret focused");
    await page.keyboard.press("Escape");

    const renderedFlags = () => page.evaluate(({ alphaId, descendantId }) => [alphaId, descendantId].map((id) =>
      document.querySelector(`.card[data-id="${id}"]`).classList.contains("collapsed")), { alphaId, descendantId });
    const waitStored = (alpha, descendant) => waitForStoredHole(page, (hole) =>
      !!hole.nodes.find((node) => node.id === alphaId)?.collapsed === alpha
        && !!hole.nodes.find((node) => node.id === descendantId)?.collapsed === descendant,
    `collapse state ${alpha}/${descendant}`);
    const openCardMenuOn = async (id) => {
      await page.locator(`.card[data-id="${id}"]`).locator(".card-more").click();
      await cardMenu.waitFor({ state: "visible" });
      return cardMenu.locator('[id^="cm-collapse"]:visible .sm-label').allInnerTexts();
    };
    const pickCollapse = async (menu, id) => {
      await menu.locator(`#${id}`).click();
      await menu.waitFor({ state: "hidden" });
    };

    const branchScreenPositions = () => page.evaluate(({ alphaId, descendantId, betaId }) =>
      Object.fromEntries([alphaId, descendantId, betaId].map((id) => {
        const rect = document.querySelector(`.card[data-id="${id}"]`).getBoundingClientRect();
        return [id, { x: rect.x, y: rect.y }];
      })), { alphaId, descendantId, betaId });

    // Shift extends a header drag from one window to its whole descendant tree.
    // An unrelated sibling remains exactly where it was.
    const beforeBranchDrag = await branchScreenPositions();
    const alphaHeadBox = await page.locator(`.card[data-id="${alphaId}"] .card-head`).boundingBox();
    await page.keyboard.down("Shift");
    await page.mouse.move(alphaHeadBox.x + 70, alphaHeadBox.y + alphaHeadBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(alphaHeadBox.x + 130, alphaHeadBox.y + alphaHeadBox.height / 2 + 45, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    const afterBranchDrag = await branchScreenPositions();
    const alphaDelta = { x: afterBranchDrag[alphaId].x - beforeBranchDrag[alphaId].x,
      y: afterBranchDrag[alphaId].y - beforeBranchDrag[alphaId].y };
    const descendantDelta = { x: afterBranchDrag[descendantId].x - beforeBranchDrag[descendantId].x,
      y: afterBranchDrag[descendantId].y - beforeBranchDrag[descendantId].y };
    assert(Math.abs(alphaDelta.x - 60) < 2 && Math.abs(alphaDelta.y - 45) < 2,
      `Shift-drag should move the grabbed parent with the pointer (${JSON.stringify(alphaDelta)})`);
    assert(Math.abs(descendantDelta.x - alphaDelta.x) < 1 && Math.abs(descendantDelta.y - alphaDelta.y) < 1,
      `Shift-drag should preserve every descendant's offset (${JSON.stringify({ alphaDelta, descendantDelta })})`);
    assert.deepEqual(afterBranchDrag[betaId], beforeBranchDrag[betaId], "Shift-drag should leave unrelated windows fixed");

    const collapseButton = page.locator(`.card[data-id="${alphaId}"] .card-collapse`);
    assert.deepEqual(await collapseButton.evaluate((button) => ({
      popup: button.getAttribute("aria-haspopup"), controls: button.getAttribute("aria-controls"),
    })), { popup: null, controls: null }, "the direct collapse control should no longer advertise a context menu");

    // An ordinary click remains scoped to this card only.
    await collapseButton.click();
    assert.deepEqual(await renderedFlags(), [true, false], "Collapse should fold the card and nothing under it");
    assert.equal(await page.locator(`.card[data-id="${descendantId}"]`).isVisible(), true,
      "collapsing one card should leave its descendants visible");
    assert.deepEqual(await page.evaluate(({ alphaId, descendantId }) => ({
      parent: document.querySelectorAll(`#edges path[data-child="${alphaId}"]`).length,
      child: document.querySelectorAll(`#edges path[data-child="${descendantId}"]`).length,
      overflow: getComputedStyle(document.querySelector(`.card[data-id="${alphaId}"]`)).overflow,
    }), { alphaId, descendantId }), { parent: 1, child: 1, overflow: "hidden" },
    "a collapsed card should retain both chain connectors and clip its header to the rounded border");
    await waitStored(true, false);
    await page.locator(`.card[data-id="${alphaId}"] .card-collapse`).click();
    assert.deepEqual(await renderedFlags(), [false, false], "Expand should restore the card only");
    await waitStored(false, false);

    // Right-click directly toggles the entire branch. Its descendant headers
    // become a compact, depth-indented stack while the root stays anchored.
    const arrangedPositions = await page.evaluate(({ alphaId, descendantId }) => Object.fromEntries(
      [alphaId, descendantId].map((id) => {
        const card = document.querySelector(`.card[data-id="${id}"]`);
        return [id, { left: card.style.left, top: card.style.top }];
      })), { alphaId, descendantId });
    await collapseButton.click({ button: "right" });
    assert.equal(await page.locator("#collapsemenu").count(), 0, "right-click collapse should have no menu surface");
    assert.deepEqual(await renderedFlags(), [true, true], "right-click should fold the card and its descendant");
    const compactState = await page.evaluate(({ alphaId, descendantId }) => {
      const parent = document.querySelector(`.card[data-id="${alphaId}"]`);
      const child = document.querySelector(`.card[data-id="${descendantId}"]`);
      return {
        parent: { x: parseFloat(parent.style.left), y: parseFloat(parent.style.top), h: parent.offsetHeight },
        child: { x: parseFloat(child.style.left), y: parseFloat(child.style.top) },
      };
    }, { alphaId, descendantId });
    assert.equal(compactState.child.x - compactState.parent.x, 24, "the compact stack should indent one hierarchy level by 24px");
    assert.equal(compactState.child.y - compactState.parent.y - compactState.parent.h, 12,
      "collapsed headers should retain a deliberate 12px breathing gap");
    await waitStored(true, true);
    await waitForStoredHole(page, (hole) => hole.nodes.find((entry) => entry.id === alphaId)
      ?.extensions?.canvas?.collapse_stack?.version === 1, "compact branch restore point");

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(`.card[data-id="${alphaId}"].collapsed`);
    assert.deepEqual(await renderedFlags(), [true, true], "the compact collapsed branch should survive a reload");
    await collapseButton.click({ button: "right" });
    assert.deepEqual(await renderedFlags(), [false, false], "a second right-click should expand the entire branch");
    assert.deepEqual(await page.evaluate(({ alphaId, descendantId }) => Object.fromEntries(
      [alphaId, descendantId].map((id) => {
        const card = document.querySelector(`.card[data-id="${id}"]`);
        return [id, { left: card.style.left, top: card.style.top }];
      })), { alphaId, descendantId }), arrangedPositions,
    "expanding the branch should restore its hand-arranged coordinates exactly");
    await waitStored(false, false);

    // The three explicit scopes remain in the ⋯ menu as the keyboard and touch
    // path, in their own divider-fenced group.
    assert.deepEqual(await openCardMenuOn(alphaId), ["Collapse", "Collapse branch", "Collapse children"],
      "the card menu should retain all three collapse scopes");
    assert.deepEqual(await page.evaluate(() => ({
      before: document.getElementById("cm-collapse").previousElementSibling.className,
      after: document.getElementById("cm-collapse-children").nextElementSibling.className,
    })), { before: "sm-sep", after: "sm-sep cm-delete-sep" },
    "the fold group should sit in its own section between menu dividers");
    await pickCollapse(cardMenu, "cm-collapse-children");
    assert.deepEqual(await renderedFlags(), [false, true], "the card menu's children fold should be descendants-only too");
    await waitStored(false, true);
    assert.deepEqual(await openCardMenuOn(alphaId), ["Collapse", "Collapse branch", "Expand children"]);
    await pickCollapse(cardMenu, "cm-collapse-children");
    await waitStored(false, false);
    await openCardMenuOn(alphaId);
    await pickCollapse(cardMenu, "cm-collapse-branch");
    assert.deepEqual(await renderedFlags(), [true, true], "the menu's branch row should use the same compact deep-collapse path");
    await openCardMenuOn(alphaId);
    assert.deepEqual(await cardMenu.locator('[id^="cm-collapse"]:visible .sm-label').allInnerTexts(),
      ["Expand", "Expand branch", "Expand children"], "the fully collapsed branch should expose symmetric expansion labels");
    await pickCollapse(cardMenu, "cm-collapse-branch");
    assert.deepEqual(await renderedFlags(), [false, false]);
    await openCardMenuOn(alphaId);
    await pickCollapse(cardMenu, "cm-collapse");
    assert.deepEqual(await renderedFlags(), [true, false], "the card menu's first row should fold the card alone");
    await waitStored(true, false);
    assert.deepEqual(await openCardMenuOn(alphaId), ["Expand", "Collapse branch", "Collapse children"]);
    await pickCollapse(cardMenu, "cm-collapse");
    await waitStored(false, false);
    assert.deepEqual(await openCardMenuOn(descendantId), ["Collapse"],
      "a childless card menu should keep only the row about the card itself");
    await page.keyboard.press("Escape");
    await cardMenu.waitFor({ state: "hidden" });

    // The ⋮ is a permanent part of the header, not a hover reveal.
    assert.deepEqual(await page.evaluate((id) => {
      const card = document.querySelector(`.card[data-id="${id}"]`);
      return [card.querySelector(".card-more"), card.querySelector(".card-act-divider")]
        .map((el) => getComputedStyle(el).opacity);
    }, alphaId), ["1", "1"],
    "the card menu button and its divider should be fully opaque without hover");

    const alphaCollapse = page.locator(`.card[data-id="${alphaId}"]`).locator('[aria-label="Collapse card"]');
    await alphaCollapse.click({ modifiers: ["Alt"] });
    assert.deepEqual(await renderedFlags(), [true, false], "every left-click modifier should keep collapse scoped to one card");
    await page.locator(`.card[data-id="${alphaId}"]`).locator('[aria-label="Expand card"]').click();

    await page.locator(`.card[data-id="${betaId}"]`).locator(".card-more").click();
    await cardMenu.locator("#cm-delete").click();
    await page.waitForSelector(`.card[data-id="${betaId}"]`, { state: "detached" });
    const undoToast = page.locator("#branch-undo");
    await undoToast.waitFor({ state: "visible" });
    await undoToast.locator("[data-notice-action]").click();
    await page.waitForSelector(`.card[data-id="${betaId}"]`);
    assert.equal(await page.locator(`.card[data-id="${betaId}"]`).count(), 1,
      "Delete branch should remove through the existing undoable branch lifecycle");

    const frozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
    const frozenPage = await context.newPage();
    await frozenPage.setContent(frozenHtml, { waitUntil: "load" });
    const frozenCard = frozenPage.locator(`.card[data-id="${alphaId}"]`);
    const frozenMenu = frozenPage.locator("#cardmenu");
    await frozenCard.locator(".card-more").focus();
    await frozenPage.keyboard.press("Enter");
    await frozenMenu.waitFor({ state: "visible" });
    assert.equal(await frozenMenu.locator(".cm-size-label").innerText(), "Text size");
    assert.deepEqual(await frozenMenu.locator('[role="menuitem"]:visible').evaluateAll((items) => items.map((item) => item.id)),
      ["cm-textdown", "cm-textreset", "cm-textup", "cm-copy", "cm-collapse", "cm-collapse-branch", "cm-collapse-children"],
      "a frozen card menu keeps the ways of looking — the whole fold group included — and drops the ways of changing");
    await frozenPage.close();

    assert(rootId && descendantId, "the card-menu fixture should retain its root and descendant identities");
    console.log("ok web app: shared card menu, direct reversible branch collapse, Shift-drag, frozen visibility, and undo");
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
  /* Settings is a centered modal sheet, not an anchored popover: fixed 640px
     width, 176px sidebar, one fixed height every section shares, and a scrim
     you can still read the canvas through while appearance changes land
     behind it. */
  const sheetStandard = await page.evaluate(() => {
    const sheet = document.getElementById("settings-sheet");
    const scrim = document.getElementById("settings-sheet-scrim");
    const rect = sheet.getBoundingClientRect();
    const styles = getComputedStyle(sheet);
    const scrimStyles = getComputedStyle(scrim);
    return {
      width: Math.round(rect.width),
      sidebar: Math.round(document.querySelector(".settings-sheet-side").getBoundingClientRect().width),
      offCenterX: Math.abs((rect.left + rect.right) / 2 - innerWidth / 2),
      offCenterY: Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2),
      height: rect.height,
      expectedHeight: Math.min(480, innerHeight - 96),
      radius: styles.borderTopLeftRadius,
      shadow: styles.boxShadow,
      role: sheet.getAttribute("role"),
      modal: sheet.getAttribute("aria-modal"),
      labelledby: sheet.getAttribute("aria-labelledby"),
      title: document.getElementById("settings-sheet-title").textContent,
      scrimBackdrop: scrimStyles.backdropFilter || scrimStyles.webkitBackdropFilter,
      scrimBackground: scrimStyles.backgroundColor,
      nav: [...document.querySelectorAll("[data-settings-section]")].map((item) => item.textContent),
      identity: [...document.querySelectorAll(".settings-sheet-identity span")].map((span) => span.textContent),
      paneTitle: document.getElementById("settings-pane-title").textContent,
    };
  });
  assert.equal(sheetStandard.width, 640, "the settings sheet is a fixed 640px column");
  assert.equal(sheetStandard.sidebar, 176, "the settings sidebar is 176px");
  assert(sheetStandard.offCenterX < 1 && sheetStandard.offCenterY < 1, `settings should be centered, off by ${sheetStandard.offCenterX},${sheetStandard.offCenterY}px`);
  assert(Math.abs(sheetStandard.height - sheetStandard.expectedHeight) < 1, `the sheet keeps one fixed height so no section can move the frame (got ${sheetStandard.height}, wanted ${sheetStandard.expectedHeight})`);
  assert.equal(sheetStandard.radius, "12px", "the sheet uses the popover radius token");
  assert.notEqual(sheetStandard.shadow, "none", "the sheet carries the modal shadow");
  assert.equal(sheetStandard.role, "dialog");
  assert.equal(sheetStandard.modal, "true");
  assert.equal(sheetStandard.labelledby, "settings-sheet-title");
  assert.equal(sheetStandard.title, "Settings");
  assert.match(sheetStandard.scrimBackdrop, /blur/, "the scrim blurs the canvas behind it");
  assert.match(sheetStandard.scrimBackground, /^rgba\(/, "the scrim stays translucent so appearance changes read through");
  assert.deepEqual(sheetStandard.nav, ["Appearance", "Quick questions", "Model"], "the web host registers Model beside the shared Appearance and Quick questions sections");
  assert.deepEqual(sheetStandard.identity, ["Rabbithole", "Web"], "the sidebar footer names the product and the host");
  assert.equal(sheetStandard.paneTitle, "Appearance", "the gear lands on Appearance");
  assert.equal(await page.getAttribute("#t-settings", "aria-haspopup"), "dialog");

  // Appearance: three-state theme and a global reading size that composes with
  // each card's own font scale.
  assert.deepEqual(await page.locator("[data-theme-choice]").allTextContents(), ["Light", "Dark", "System"]);
  // Every row carries a one-line sub describing the effect, not the mechanism.
  assert.equal(await page.locator("#settings-theme-row .settings-sheet-sub").innerText(), "What the canvas follows.");
  assert.equal(await page.locator("#settings-reading-size-row .settings-sheet-sub").innerText(), "Scales every card; each can fine-tune.");
  assert.equal(await page.locator("[data-reading-reset]").isVisible(), false, "Reset appears only when the size is not 100%");
  await page.click('[data-reading-step="1"]');
  assert.equal(await page.locator("[data-reading-value]").innerText(), "110%");
  assert.equal(await page.locator("[data-reading-reset]").isVisible(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem("rh-reading-scale")), "1.1", "the global reading size lives in localStorage, never in the hole");
  await page.click("[data-reading-reset]");
  assert.equal(await page.locator("[data-reading-value]").innerText(), "100%");
  await page.click('[data-theme-choice="dark"]');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  assert.equal(await page.evaluate(() => localStorage.getItem("rh-theme")), "dark");
  await page.click('[data-theme-choice="system"]');
  assert.equal(await page.evaluate(() => localStorage.getItem("rh-theme")), "system");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
  // The taskbar button stays a quick toggle: it always writes an explicit
  // choice, so pressing it leaves "system" behind.
  await page.keyboard.press("Escape");
  await page.waitForSelector("#settings-sheet", { state: "detached" });
  await page.click("#t-theme");
  assert.equal(await page.evaluate(() => localStorage.getItem("rh-theme")), "light", "the taskbar toggle leaves system behind");
  await page.emulateMedia({ colorScheme: null });
  await page.click("#t-settings");
  await page.waitForSelector("#settings-sheet");
  await page.click('[data-settings-section="asking"]');
  assert.equal(await page.locator("#settings-pane-title").innerText(), "Quick questions");
  // The section is the product wearing its own clothes: full-width replicas of
  // the real surfaces, assembled from the real .ask-input/.ask-actions parts.
  const pillTexts = (set) => page.locator(`[data-asking-surface][data-set="${set}"] [data-preset-button]`)
    .evaluateAll((buttons) => buttons.map((button) => button.firstChild.nodeValue));
  const defaultPillTexts = ["Explain ", "ELI5 ", "Go deeper "];
  assert.deepEqual(await pillTexts("selection"), defaultPillTexts,
    "the selection replica renders three label pills, each in one text node");
  assert.deepEqual(await pillTexts("followup"), defaultPillTexts,
    "the follow-up replica has the same three slots even while its linked surface is collapsed");
  assert.equal(await page.locator(".asking-editor.open").count(), 0, "no editor is open until a pill is clicked");
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-add]').innerText(), "Add question",
    "an absent optional slot exposes one verb-first Add affordance");
  assert.deepEqual(await page.locator("[data-reaction-prompt] .asking-reaction-glyph").allInnerTexts(), ["👍", "👎"],
    "reaction glyphs are the two fixed row labels");
  assert.equal(await page.locator("[data-reaction-prompt] textarea").count(), 2,
    "each reaction row exposes one multiline instruction field");
  assert.equal(await page.locator("[data-reaction-prompt] input").count(), 0,
    "reaction labels have no editable or emoji-specific field");
  const fidelity = await page.evaluate(() => {
    const mock = document.querySelector('[data-asking-surface][data-set="selection"] .asking-mock');
    const row = mock.querySelector(".ask-actions");
    const rowStyle = getComputedStyle(row);
    return {
      width: Math.round(mock.getBoundingClientRect().width),
      sectionWidth: Math.round(document.querySelector(".asking-settings").getBoundingClientRect().width),
      justify: rowStyle.justifyContent,
      rowPadding: rowStyle.padding,
      radius: getComputedStyle(mock).borderRadius,
      glass: getComputedStyle(mock).backdropFilter,
      shadow: getComputedStyle(mock).boxShadow,
      linkRole: document.querySelector("[data-asking-link]").getAttribute("role"),
      linkChecked: document.querySelector("[data-asking-link]").checked,
      followupVisible: getComputedStyle(document.querySelector("[data-asking-reveal]")).visibility,
    };
  });
  assert.equal(fidelity.width, fidelity.sectionWidth, "the replica runs the full section width");
  assert.equal(fidelity.justify, "space-between", "pill slack is handed out exactly like the real ask row");
  assert.equal(fidelity.rowPadding, "5px", "the replica row keeps the real ask row's padding");
  assert.equal(fidelity.radius, "12px", "the selection replica wears the popover's radius");
  assert.match(fidelity.glass, /blur/, "the selection replica wears the popover's glass");
  assert.equal(fidelity.shadow, "none", "the replica keeps the popover's skin but not its elevation — nothing floats here");
  assert.equal(fidelity.linkRole, "switch", "the link control is the product's own switch, not a bare checkbox");
  assert.equal(fidelity.linkChecked, true, "fresh Quick questions settings start linked");
  assert.equal(fidelity.followupVisible, "hidden", "the linked default collapses the duplicate follow-up surface");

  // The optional slot is created in place, edits through the same two fields,
  // and removal returns to Add instead of making a restore chip.
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-add]');
  await page.waitForSelector('[data-asking-surface][data-set="selection"] .asking-editor.open');
  assert.equal(await page.evaluate(() => document.activeElement.id), "asking-selection-custom-label");
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] .asking-editor-fields > input').count(), 1,
    "the custom editor has Label and Instruction only");
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-reset]').count(), 0,
    "an optional slot has no imaginary built-in default");
  await page.fill("#asking-selection-custom-label", "Counterpoint");
  await page.fill("#asking-selection-custom-instruction", "Challenge this claim.");
  assert.deepEqual(await pillTexts("selection"), [...defaultPillTexts, "Counterpoint "],
    "the custom question becomes the positional fourth pill");
  assert.deepEqual(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-button] kbd').allTextContents(),
    ["1", "2", "3", "4"], "four position hints remain truthful");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("rh-ask-presets-v1")).selection.custom), {
    label: "Counterpoint", instruction: "Challenge this claim.", removed: false,
  });
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-remove]');
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-add]').isVisible(), true,
    "removing custom brings Add question back");
  assert.equal(await page.locator('[data-preset-restore="custom"]').count(), 0,
    "a removed custom slot never becomes a restore chip");
  assert.equal(await page.evaluate(() => Object.hasOwn(
    JSON.parse(localStorage.getItem("rh-ask-presets-v1")).selection, "custom")), false,
  "custom removal persists as an absent slot");

  const upInstruction = page.locator('[data-reaction-prompt="up"] [data-reaction-instruction]');
  await upInstruction.fill("Keep the concrete opening.");
  assert.equal(await page.locator('[data-reaction-prompt="up"] [data-reaction-reset]').isVisible(), true,
    "a reaction reset appears only after its instruction changes");
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("rh-reaction-prompts-v1"))).up.instruction,
    "Keep the concrete opening.");
  await page.click('[data-reaction-prompt="up"] [data-reaction-reset]');
  assert.equal(await upInstruction.inputValue(), "This landed well — use a similar approach.");
  assert.equal(await page.locator('[data-reaction-prompt="up"] [data-reaction-reset]').isVisible(), false);

  // Click-to-edit: the pill expands its editor in place and hands over focus.
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-button="explain"]');
  await page.waitForSelector('[data-asking-surface][data-set="selection"] .asking-editor.open');
  assert.equal(await page.evaluate(() => document.activeElement.id), "asking-selection-explain-label",
    "opening an editor moves focus into the label field");
  assert.equal(await page.inputValue("#asking-selection-explain-label"), "Explain");
  assert.equal(await page.inputValue("#asking-selection-explain-instruction"), "Explain this further.",
    "default instructions stay minimal — the preset names the move, nothing more");
  assert.equal(await page.getAttribute('[data-asking-surface][data-set="selection"] [data-preset-button="explain"]', "aria-expanded"), "true");
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-reset]').isVisible(), false,
    "Reset appears only once the slot differs from its default");
  await page.fill("#asking-selection-explain-label", "Clarify");
  await page.fill("#asking-selection-explain-instruction", "Lead with the key distinction.");
  assert.deepEqual(await pillTexts("selection"), ["Clarify ", "ELI5 ", "Go deeper "],
    "the pill is a live preview — a label edit lands on it as it is typed");
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-reset]').isVisible(), true);
  assert.deepEqual(await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("rh-ask-presets-v1"));
    return { version: saved.version, linked: saved.linked, selection: saved.selection.explain, followup: saved.followup.explain };
  }), {
    version: 1,
    linked: true,
    selection: { label: "Clarify", instruction: "Lead with the key distinction.", removed: false },
    followup: { label: "Explain", instruction: "Explain this further.", removed: false },
  }, "label, instruction, and the linked default persist in the versioned preference key");

  // Unlink before editing the independent follow-up set. One editor stays open
  // at a time, and Escape gives back one level before the sheet.
  await page.uncheck("input[data-asking-link]");
  await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-asking-reveal]")).visibility === "visible");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("rh-ask-presets-v1")).linked), false,
    "only an explicit switch-off unlinks follow-up presets");
  await page.click('[data-asking-surface][data-set="followup"] [data-preset-button="explain"]');
  await page.waitForSelector('[data-asking-surface][data-set="followup"] .asking-editor.open');
  assert.equal(await page.locator(".asking-editor.open").count(), 1, "opening a second editor closes the first");
  await page.fill("#asking-followup-explain-label", "Recap");
  assert.deepEqual(await pillTexts("followup"), ["Recap ", "ELI5 ", "Go deeper "]);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".asking-editor.open").count(), 0);
  assert.equal(await page.locator("#settings-sheet").count(), 1, "Escape collapses the editor; the sheet stays");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.presetButton), "explain",
    "Escape hands focus back to the pill it came from");

  // The link toggle folds the two sets into one without destroying either: the
  // follow-up surface disappears instead of repeating the row it now shares.
  await page.check("input[data-asking-link]");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("rh-ask-presets-v1")).linked), true,
    "the link lives in the same versioned preference key");
  await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-asking-reveal]")).visibility === "hidden");
  assert.equal(await page.locator('[data-asking-surface][data-set="followup"] [data-preset-button="explain"]').isVisible(), false,
    "one set everywhere: the follow-up surface folds away rather than mirroring");
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-button="explain"]');
  await page.fill("#asking-selection-explain-label", "Compare");
  await page.uncheck("input[data-asking-link]");
  assert.equal(await page.locator(".asking-editor.open").count(), 0, "a click outside the editor collapses it");
  await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-asking-reveal]")).visibility === "visible");
  assert.deepEqual(await pillTexts("followup"), ["Recap ", "ELI5 ", "Go deeper "],
    "unticking brings the follow-up set back exactly as it looked before the tick");

  // Per-slot reset, from inside the open editor.
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-button="explain"]');
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-reset]');
  assert.equal(await page.inputValue("#asking-selection-explain-label"), "Explain", "Reset restores only that slot to its minimal default");
  assert.deepEqual(await pillTexts("selection"), defaultPillTexts);
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-reset]').isVisible(), false);
  await page.keyboard.press("Escape");

  // Remove and restore: Remove takes the pill off the row, hints renumber so
  // every number stays truthful, and a ghost chip below waits to bring it back.
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-button="eli5"]');
  await page.waitForSelector('[data-asking-surface][data-set="selection"] .asking-editor.open');
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-remove]');
  assert.deepEqual(await pillTexts("selection"), ["Explain ", "Go deeper "], "Remove takes the pill off the row");
  assert.deepEqual(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-button] kbd').allTextContents(), ["1", "2"],
    "the remaining number hints close ranks");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("rh-ask-presets-v1")).selection.eli5.removed), true,
    "removal is a flag on the same slot — the words survive for old branches and restore");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.presetRestore), "eli5",
    "focus lands on the way back in");
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] [data-preset-restore="eli5"]').innerText(), "ELI5",
    "the removed chip keeps the preset label");
  await page.click('[data-asking-surface][data-set="selection"] [data-preset-restore="eli5"]');
  assert.deepEqual(await pillTexts("selection"), defaultPillTexts, "the ghost chip restores the pill in place");
  assert.equal(await page.locator('[data-asking-surface][data-set="selection"] [data-asking-removed]').isVisible(), false,
    "the removed row disappears when all three supported slots are restored");
  assert.equal(await page.locator("#settings-sheet").evaluate((sheet) => Math.round(sheet.getBoundingClientRect().height)), Math.round(sheetStandard.height),
    "Quick questions renders inside the shared fixed sheet silhouette");
  await page.click('[data-settings-section="model"]');
  assert.equal(await page.locator("#settings-pane-title").innerText(), "Model");
  await page.waitForSelector("#settings-panel");

  const gearOffset = await page.evaluate(() => {
    const button = document.getElementById("t-settings");
    const glyph = button.querySelector("svg");
    const box = glyph.getBBox();
    const ctm = glyph.getScreenCTM();
    const cx = ctm.a * (box.x + box.width / 2) + ctm.c * (box.y + box.height / 2) + ctm.e;
    const cy = ctm.b * (box.x + box.width / 2) + ctm.d * (box.y + box.height / 2) + ctm.f;
    const rect = button.getBoundingClientRect();
    return { dx: cx - (rect.left + rect.width / 2), dy: cy - (rect.top + rect.height / 2) };
  });
  assert(Math.abs(gearOffset.dx) < 0.25 && Math.abs(gearOffset.dy) < 0.25,
    `settings gear glyph should be optically centered in its button, off by ${gearOffset.dx.toFixed(2)},${gearOffset.dy.toFixed(2)}px`);
  await page.waitForFunction(() => /Connected|Stored only in this browser/i.test(document.getElementById("settings-panel")?.innerText || ""));
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
  assert.equal(await page.locator("#settings-sheet").count(), 1, "settings should remain open after its child closes");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#settings-sheet", { state: "detached" });
  assert.equal(await page.locator("#settings-sheet").count(), 0, "Escape must remove the settings sheet from the DOM");
  assert.equal(await page.getAttribute("#t-settings", "aria-expanded"), "false");
  assert.equal(await page.getAttribute("#t-settings", "aria-controls"), null, "a closed sheet must not be referenced by the gear");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-settings", "closing settings should restore focus to its trigger");
  // Esc, the ×, and the scrim all close, and all three hand the gear back.
  await page.click("#t-settings");
  await page.waitForSelector("#settings-sheet");
  assert.equal(await page.getAttribute("#t-settings", "aria-controls"), "settings-sheet", "the gear should point at the live sheet");
  await page.click("[data-settings-close]");
  await page.waitForSelector("#settings-sheet", { state: "detached" });
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-settings", "the close button should restore settings focus");
  await page.click("#t-settings");
  await page.waitForSelector("#settings-sheet");
  await page.mouse.click(4, 300);
  await page.waitForSelector("#settings-sheet", { state: "detached" });
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "t-settings", "outside-pointer close should restore settings focus");
  await page.click("#t-settings");
  await page.waitForSelector("#settings-sheet");
  await page.click('[data-settings-section="model"]');
  await page.fill("#api-key", MOCK_KEY);
  await page.press("#api-key", "Enter");
  await page.waitForSelector("#api-key-status.valid");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#settings-sheet", { state: "detached" });

  const smokeCode = "console.log('math branch');";
  const markdown = [
    "# Web Smoke",
    "",
    "Euler identity $e^{i\\pi}+1=0$ ties exponentials to geometry.",
    "",
    "```js",
    smokeCode,
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
  await page.waitForSelector(".card .katex");
  await page.waitForSelector(".card .hljs");
  await page.waitForSelector(".card .viz-show");
  await assertCodeCopy(page, { scope: ".card.root .doc-content", rawCode: smokeCode, label: "web Canvas" });

  const rootDrawer = page.locator(".card.root .nc-handle");
  const rootDrawerId = await rootDrawer.getAttribute("aria-controls");
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "false", "card drawer handle should expose its closed disclosure state");
  assert(rootDrawerId, "card drawer handle should reference its input region");
  assert.equal(await page.locator(`#${rootDrawerId}`).count(), 1, "card drawer aria-controls should resolve to the input region");
  const canvasModeBeforeDrawer = await page.locator("body").getAttribute("class");
  await rootDrawer.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".card.root .nc-inner textarea"));
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "true", "opening a card drawer should expand its disclosure state");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.matches(".card.root .nc-handle"));
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "false", "Escape should close the card drawer disclosure");
  assert.equal(await page.locator("body").getAttribute("class"), canvasModeBeforeDrawer, "drawer Escape should not change the canvas mode class");
  await rootDrawer.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".card.root .nc-inner textarea"));
  await page.evaluate(() => document.querySelector(".card.root").matches = () => false);
  await page.focus("#t-theme");
  await page.waitForFunction(() => !document.querySelector(".card.root .card-composer").classList.contains("open"));
  await page.evaluate(() => delete document.querySelector(".card.root").matches);
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "false", "empty-draft blur should close an unhovered card drawer");

  await rootDrawer.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".card.root .nc-inner textarea"));
  await page.keyboard.type("Create a card follow-up child");
  await page.keyboard.press("Control+Enter");
  await waitForCanvasText(page, "Card drawer keyboard submission created this follow-up child");
  assert.equal(await rootDrawer.getAttribute("aria-expanded"), "false", "submitting a card follow-up should close its drawer");
  assert.equal(providerCalls, 1, "card Cmd/Ctrl+Enter should use the follow-up request path once");

  const childCard = page.locator(".card:not(.root)", { hasText: "Card drawer keyboard submission" }).first();
  const cardControls = await childCard.locator(".card-head .card-btn").evaluateAll((buttons) => buttons.map((button) => ({
    type: button.getAttribute("type"),
    name: button.getAttribute("aria-label") || button.textContent.trim(),
  })));
  assert.deepEqual(cardControls, [
    { type: "button", name: "Collapse card" },
    { type: "button", name: "Expand document" },
    { type: "button", name: "Card menu" },
  ], "card headers should keep only collapse, document, and menu controls, with the menu at the outer edge");
  await childCard.locator('.card-btn[aria-label="Collapse card"]').click();
  assert.equal(await childCard.evaluate((card) => card.classList.contains("collapsed")), true, "the branch fixture should collapse");
  assert.equal(await childCard.locator(".card-font-btn").count(), 0, "a collapsed card header must not expose font controls");
  await childCard.locator('.card-btn[aria-label="Expand card"]').click();
  const childPosition = await childCard.evaluate((card) => ({ left: card.style.left, top: card.style.top }));
  const collapseBox = await childCard.locator('.card-btn[aria-label="Collapse card"]').boundingBox();
  await page.mouse.move(collapseBox.x + collapseBox.width / 2, collapseBox.y + collapseBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(collapseBox.x + 50, collapseBox.y + 40);
  await page.mouse.up();
  assert.deepEqual(await childCard.evaluate((card) => ({ left: card.style.left, top: card.style.top })), childPosition, "card controls should remain excluded from card dragging");
  /* Per-card text size lives in the card ⋯ menu — the palette holds navigation
     and actions, never settings. */
  await page.keyboard.press("Control+K");
  await page.fill("#pal-text", "Zoom to fit");
  await page.press("#pal-text", "Enter");
  await page.waitForSelector("#palette[hidden]", { state: "attached" });
  await page.locator(".card.root .card-more").click();
  await page.locator("#cardmenu").locator("#cm-textup").click();
  await page.keyboard.press("Escape");
  assert.deepEqual(await page.locator(".card").evaluateAll((cards) => cards.map((card) => ({
    root: card.classList.contains("root"), fontSize: parseFloat(getComputedStyle(card.querySelector(".doc-content")).fontSize),
  }))), [{ root: true, fontSize: 15 }, { root: false, fontSize: 14 }],
  "the card menu should update only that card's document");
  assert.equal(await page.evaluate(() => Number(localStorage.getItem("rh-reading-scale") ?? 1)), 1, "per-card text size must not move the reader's global preference");
  assert.deepEqual((await page.evaluate(() => window.__rabbitholeTest.exportPortable())).hole.nodes.map((node) => node.font_scale), [1.1, 1],
    "the card menu should rewrite only that node's font_scale");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".card:not(.root)");
  assert.deepEqual(await page.locator(".card .doc-content").evaluateAll((docs) => docs.map((doc) => parseFloat(getComputedStyle(doc).fontSize))), [15, 14],
    "the current node's saved font_scale should apply when the Rabbithole reloads");

  /* The global reading size composes with each card's own scale instead of
     replacing it — effective = base x global x font_scale — and it belongs to
     the reader, so it never enters the document, the wire, or an export. */
  await page.click("#t-settings");
  await page.waitForSelector("#settings-sheet");
  assert.deepEqual(await page.locator(".settings-sheet-identity span").allTextContents(), ["Rabbithole", "Web"],
    "an open hole must not relabel the host the sheet already belongs to");
  await page.click('[data-reading-step="1"]');
  await page.click('[data-reading-step="1"]');
  assert.equal(await page.locator("[data-reading-value]").innerText(), "120%");
  assert.deepEqual(await page.locator(".card .doc-content").evaluateAll((docs) => docs.map((doc) => parseFloat(getComputedStyle(doc).fontSize))), [18, 17],
    "a global 120% must compose live with the root card's own 110% (14 x 1.2 x 1.1 = 18, 14 x 1.2 x 1 = 17)");
  assert.deepEqual((await page.evaluate(() => window.__rabbitholeTest.exportPortable())).hole.nodes.map((node) => node.font_scale), [1.1, 1],
    "the reader's global size must stay out of the document and its export");
  assert.equal(await page.evaluate(() => localStorage.getItem("rh-reading-scale")), "1.2");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#settings-sheet", { state: "detached" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".card:not(.root)");
  assert.deepEqual(await page.locator(".card .doc-content").evaluateAll((docs) => docs.map((doc) => parseFloat(getComputedStyle(doc).fontSize))), [18, 17],
    "the global reading size should survive a reload");
  await page.click("#t-settings");
  await page.waitForSelector("#settings-sheet");
  await page.click("[data-reading-reset]");
  assert.equal(await page.locator("[data-reading-value]").innerText(), "100%");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#settings-sheet", { state: "detached" });

  await page.locator(".card.root .card-more").click();
  await page.locator("#cardmenu").locator("#cm-textreset").click();
  await page.keyboard.press("Escape");
  assert.deepEqual(await page.locator(".card .doc-content").evaluateAll((docs) => docs.map((doc) => parseFloat(getComputedStyle(doc).fontSize))), [14, 14],
    "the card menu percentage should reset only that card to 100%");
  await deleteCardBranch(page, childCard);
  await childCard.waitFor({ state: "detached" });
  await page.waitForSelector("#branch-undo.visible");
  assert.match(await page.locator("#branch-undo").innerText(), /Branch removed\s+Undo/, "removing a branch should immediately offer one undo action");

  const canvasReadingPosition = await page.evaluate(() => {
    const scroller = document.querySelector(".card.root .card-body");
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.4;
    const top = scroller.getBoundingClientRect().top;
    const blocks = Array.from(scroller.querySelector(".doc-content").children);
    const block = blocks.findIndex((item) => item.getBoundingClientRect().bottom > top);
    const rect = blocks[block].getBoundingClientRect();
    return { block, offset: (top - rect.top) / rect.height };
  });
  await page.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  await page.waitForSelector("body:not(.mode-canvas)");
  assert.deepEqual(await page.evaluate(() => {
    const restore = document.getElementById("reader-restore");
    const home = document.querySelector("#breadcrumb .crumb-canvas");
    return {
      restoreName: restore.getAttribute("aria-label"),
      restoreShown: getComputedStyle(restore).display !== "none",
      homeRole: home.getAttribute("role"),
      homeText: home.textContent.trim(),
    };
  }), { restoreName: "Back to canvas", restoreShown: true, homeRole: "link", homeText: "Canvas" },
  "the reader should expose the mirrored restore control and lead its trail with the canvas");
  const readerReadingPosition = await page.locator("#reader-main").evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    const blocks = Array.from(scroller.querySelector(".doc-content").children);
    const block = blocks.findIndex((item) => item.getBoundingClientRect().bottom > top);
    const rect = blocks[block].getBoundingClientRect();
    return { block, offset: (top - rect.top) / rect.height };
  });
  assert.equal(readerReadingPosition.block, canvasReadingPosition.block, "canvas-to-reader should preserve the visible content block");
  assert(Math.abs(readerReadingPosition.offset - canvasReadingPosition.offset) < 0.2, `canvas-to-reader should preserve the position within the visible block: ${JSON.stringify({ canvasReadingPosition, readerReadingPosition })}`);
  await assertCodeCopy(page, { scope: "#reader-main .doc-content", rawCode: smokeCode, hover: false, label: "web Reader" });
  await page.focus("#r-textup");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "reader-restore", "reader tools should tab straight into the session cluster, Back to canvas first");
  const readerFocusRing = await page.evaluate(() => getComputedStyle(document.getElementById("reader-restore")).outlineStyle);
  assert.notEqual(readerFocusRing, "none", "keyboard focus should show the taskbar focus-visible ring");
  const readerReturnPosition = await page.locator("#reader-main").evaluate((scroller) => {
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.35;
    const top = scroller.getBoundingClientRect().top;
    const blocks = Array.from(scroller.querySelector(".doc-content").children);
    const block = blocks.findIndex((item) => item.getBoundingClientRect().bottom > top);
    const rect = blocks[block].getBoundingClientRect();
    return { block, offset: (top - rect.top) / rect.height };
  });
  await page.focus("#reader-restore");
  await page.keyboard.press("Enter");
  await page.waitForSelector("body.mode-canvas");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Expand document",
    "keyboard restore should hand focus to the mirrored expand control on the current card");
  await page.waitForTimeout(50);
  const canvasReturnPosition = await page.locator(".card.root .card-body").evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    const blocks = Array.from(scroller.querySelector(".doc-content").children);
    const block = blocks.findIndex((item) => item.getBoundingClientRect().bottom > top);
    const rect = blocks[block].getBoundingClientRect();
    return { block, offset: (top - rect.top) / rect.height };
  });
  assert.equal(canvasReturnPosition.block, readerReturnPosition.block, "reader-to-canvas should preserve the visible content block");
  assert(Math.abs(canvasReturnPosition.offset - readerReturnPosition.offset) < 0.2, `reader-to-canvas should preserve the position within the visible block: ${JSON.stringify({ readerReturnPosition, canvasReturnPosition })}`);
  await assertCodeCopy(page, { scope: ".card.root .doc-content", rawCode: smokeCode, hover: false, label: "web Canvas after Reader" });
  // Quick Look: Space expands the current card, Escape collapses it back.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Space");
  await page.waitForSelector("body:not(.mode-canvas)");
  await page.keyboard.press("Escape");
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
  assert.equal(shareStandard.surface.radius, "12px", "anchored surfaces share the popover radius token");
  assert.match(shareStandard.surface.backdrop, /blur\(16px\)/, "anchored surfaces share the popover blur token");
  assert.match(shareStandard.surface.border, /^1px solid/, "anchored surfaces share the popover border token");
  assert.notEqual(shareStandard.surface.shadow, "none", "anchored surfaces carry the popover shadow");
  assert(shareStandard.rightAlignment < 1, `Share should anchor to its trigger, off by ${shareStandard.rightAlignment.toFixed(2)}px`);
  assert(Math.abs(shareStandard.triggerGap - shareStandard.tokenGap) < 1, `Share should use the token gap from its trigger, got ${shareStandard.triggerGap.toFixed(2)}px`);
  assert.equal(shareStandard.shellPadding, "6px");
  assert.equal(shareStandard.itemPaddingTop, "8px");
  assert.equal(shareStandard.itemPaddingBottom, "8px");
  assert.equal(shareStandard.expanded, "true");
  assert.equal(shareStandard.menuItems, 4);
  assert.deepEqual(await page.locator('#sharemenu [role="menuitem"]').evaluateAll((items) => items.map((item) => item.tabIndex)), [0, -1, -1, -1], "Share should expose one item in the Tab sequence");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sm-portable", "ArrowUp should wrap to the last visible Share item");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sm-trail", "ArrowDown should wrap to the first visible Share item");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sm-portable");
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
  await assertCodeCopy(frozenPage, { scope: ".card.root .doc-content", rawCode: smokeCode, hover: false, label: "web frozen snapshot" });
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
  assert.deepEqual(await frozenPage.locator('#sharemenu [role="menuitem"]:visible').evaluateAll((items) => items.map((item) => item.id)), ["sm-trail", "sm-doc"], "Frozen Share should suppress export and portable export");
  assert.deepEqual(await frozenPage.locator('#sharemenu [role="menuitem"]').evaluateAll((items) => items.map((item) => ({ id: item.id, tabIndex: item.tabIndex, visible: item.style.display !== "none" }))), [
    { id: "sm-trail", tabIndex: 0, visible: true },
    { id: "sm-doc", tabIndex: -1, visible: true },
    { id: "sm-export", tabIndex: -1, visible: false },
    { id: "sm-portable", tabIndex: -1, visible: false },
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
      return new DOMRect(-24, innerHeight - 24, 100, 20);
    };
  });
  const edgeSelection = await selectVisibleText(page, {
    text: "Euler identity",
    anchorMovesWithCanvas: false,
  });
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
  await page.evaluate(() => {
    Range.prototype.getBoundingClientRect = window.__askRangeRect;
    delete window.__askRangeRect;
  });
  await page.keyboard.press("Escape");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  await page.waitForFunction(() => document.activeElement?.matches(".card.root"));
  assert.equal(await page.evaluate(() => window.getSelection().toString()), "Euler identity", "selection-bar Escape should preserve the live text selection");
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true, "selection-bar Escape must stay inside the selection bar");
  await panCanvasBy(page, { x: -edgeSelection.pan.x, y: -edgeSelection.pan.y });

  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.waitForFunction(() => document.activeElement?.id === "ask-text", null, { timeout: 5000 })
    .catch(() => { throw new Error("the selection bar must focus its input on open"); });
  await page.keyboard.type("Why does this matter?");
  await page.keyboard.press("Control+Enter");
  await page.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
  // No flight wait here: the .pending state is transient and the tile must be
  // caught before the mock provider finishes streaming.
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
    const crumbs = [...nav.querySelectorAll(".crumb:not(.crumb-canvas)")];
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
  await page.locator('.crumb[role="link"]:not(.crumb-canvas)').focus();
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
  await page.evaluate(() => document.getElementById("reader-restore").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  await waitForCanvasText(page, "Euler identity connects rotation");

  const branchMark = page.locator('.card mark[data-child].mark-ready').first();
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
      if (document.querySelector(".card:not(.root).flash")) { window.__markDiveFlashed = true; observer.disconnect(); }
    });
    observer.observe(document.getElementById("world"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  await armFlashProbe();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__markDiveFlashed === true);
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true, "Enter on a canvas mark must stay in canvas and dive to the card");
  await page.waitForTimeout(400);
  await zoomToFit(page); // the dive moved the parent's mark off-screen — refit first
  await page.waitForTimeout(400);
  await armFlashProbe();
  await branchMark.click();
  await page.waitForFunction(() => window.__markDiveFlashed === true);
  assert.equal(await page.evaluate(() => document.body.classList.contains("mode-canvas")), true, "clicking a canvas mark must stay in canvas and dive to the card");

  await page.waitForSelector("body.mode-canvas");
  await zoomToFit(page); // leave the mark-dive zoom behind so removal is measured from a neutral view
  await page.waitForTimeout(400);
  const undoChild = page.locator('.card:not(.root)', { hasText: "Euler identity connects rotation" });
  const undoChildId = await undoChild.getAttribute("data-id");
  await undoChild.locator('.card-btn[aria-label="Collapse card"]').click();
  const branchBeforeUndo = await undoChild.evaluate((card) => ({
    left: card.style.left, top: card.style.top, width: card.style.width,
    collapsed: card.classList.contains("collapsed"), text: card.textContent,
  }));
  await undoChild.locator(".card-more").focus();
  await page.keyboard.press("Enter");
  const undoCardMenu = page.locator("#cardmenu");
  await undoCardMenu.locator("#cm-delete").focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(`.card[data-id="${undoChildId}"]`, { state: "detached" });
  await page.waitForSelector("#branch-undo.visible");
  assert.equal(await page.locator("#confirm").count(), 0, "the old branch confirmation surface must be removed entirely");
  const undoToastCraft = await page.locator("#branch-undo").evaluate((toast) => {
    const style = getComputedStyle(toast);
    return {
      role: toast.getAttribute("role"), live: toast.getAttribute("aria-live"), message: toast.querySelector("[data-notice-message]").textContent,
      action: toast.querySelector("[data-notice-action]").textContent, shadow: style.boxShadow, radius: style.borderRadius,
    };
  });
  assert.deepEqual({ role: undoToastCraft.role, live: undoToastCraft.live, message: undoToastCraft.message, action: undoToastCraft.action },
    { role: "status", live: "polite", message: "Branch removed", action: "Undo" },
    "the undo toast should be a concise accessible status surface");
  assert.notEqual(undoToastCraft.shadow, "none", "the undo toast should use the shared elevated-surface craft");
  assert(Number.parseFloat(undoToastCraft.radius) > 0, "the undo toast should use the shared rounded-surface craft");
  await page.locator("#branch-undo [data-notice-action]").click();
  await page.waitForSelector(`.card[data-id="${undoChildId}"]`);
  assert.deepEqual(await page.locator(`.card[data-id="${undoChildId}"]`).evaluate((card) => ({
    left: card.style.left, top: card.style.top, width: card.style.width,
    collapsed: card.classList.contains("collapsed"), text: card.textContent,
  })), branchBeforeUndo, "Undo should restore the branch position, collapsed state, and content exactly");
  assert.equal(await page.locator(`path[data-child="${undoChildId}"]`).count(), 1, "Undo should restore the branch edge");
  assert.equal(await page.locator(`mark[data-child="${undoChildId}"]`).count(), 1, "Undo should restore the branch origin mark");
  await page.locator(`.card[data-id="${undoChildId}"] .card-btn[aria-label="Expand card"]`).click();

  // Export while the child is the current node so the frozen reader opens with
  // a parent crumb (mark clicks no longer change the current node).
  await page.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  await page.locator('.side-item[role="link"]').first().click();
  await page.locator("#reader-main", { hasText: "Euler identity connects rotation" }).waitFor();
  await page.evaluate(() => document.getElementById("reader-restore").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  const branchFrozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const branchFrozenPage = await context.newPage();
  await branchFrozenPage.setContent(branchFrozenHtml, { waitUntil: "load" });
  await branchFrozenPage.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
  await branchFrozenPage.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  assert.deepEqual(await branchFrozenPage.locator("#breadcrumb").evaluate((nav) => ({ tag: nav.tagName, label: nav.getAttribute("aria-label") })),
    { tag: "NAV", label: "Breadcrumb" }, "frozen reader should preserve breadcrumb landmark semantics");
  await branchFrozenPage.locator('.crumb[role="link"]:not(.crumb-canvas)').focus();
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => document.querySelectorAll("#breadcrumb .crumb:not(.crumb-canvas)").length === 1);
  const frozenSidebar = branchFrozenPage.locator('.side-item[role="link"]').first();
  assert.equal(await frozenSidebar.evaluate((tile) => tile.tabIndex), 0,
    "frozen margin notes should remain keyboard navigable");
  await frozenSidebar.focus();
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => document.querySelectorAll("#breadcrumb .crumb:not(.crumb-canvas)").length > 1);
  await branchFrozenPage.locator('.crumb[role="link"]:not(.crumb-canvas)').focus();
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => document.querySelectorAll("#breadcrumb .crumb:not(.crumb-canvas)").length === 1);
  await branchFrozenPage.evaluate(() => document.getElementById("reader-restore").click());
  await branchFrozenPage.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  const frozenMark = branchFrozenPage.locator('.card mark[data-child].mark-ready').first();
  await frozenMark.focus();
  await branchFrozenPage.evaluate(() => {
    window.__markDiveFlashed = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".card:not(.root).flash")) { window.__markDiveFlashed = true; observer.disconnect(); }
    });
    observer.observe(document.getElementById("world"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  await branchFrozenPage.keyboard.press("Enter");
  await branchFrozenPage.waitForFunction(() => window.__markDiveFlashed === true);
  assert.equal(await branchFrozenPage.evaluate(() => document.body.classList.contains("mode-canvas")), true,
    "Enter on a frozen canvas mark should dive to the card in place");
  await branchFrozenPage.close();

  await page.evaluate(() => document.querySelector(".card.current [aria-label=\'Expand document\']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-flight"));
  await page.fill("#composer-text", "Go one layer deeper.");
  await page.click('#composer-actions [data-commit="ask"]');
  const followupRailCard = page.locator("#margin-notes .side-item", { hasText: "Go one layer deeper." });
  await followupRailCard.waitFor();
  await followupRailCard.click();
  await page.locator("#reader-main", { hasText: "Second branch explains the geometric view" }).waitFor();
  assert.equal(providerCalls, 3);

  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rabbitholeTest && !!document.querySelector(".card .doc-content[data-node-id]"));
  const reloadedRaw = await page.evaluate(() => window.__rabbitholeTest.readStoredHole().then((hole) => JSON.stringify(hole)));
  assert(reloadedRaw.includes("Euler identity connects rotation"));
  assert(reloadedRaw.includes("Second branch explains the geometric view"));
  assert(!reloadedRaw.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");
  assert(!page.url().includes(MOCK_KEY), "URL must not contain provider key");

  await page.waitForSelector("body.mode-canvas");
  const finalBranch = page.locator('.card:not(.root)', { hasText: "Euler identity connects rotation" });
  const finalBranchId = await finalBranch.getAttribute("data-id");
  const subtreeBeforeKeyboardUndo = await readCanvasSubtree(page, finalBranchId);
  assert.equal(subtreeBeforeKeyboardUndo.length, 2, "the deletion fixture should contain a branch and its descendant");
  await deleteCardBranch(page, finalBranch);
  await page.waitForFunction((ids) => ids.every((id) => !document.querySelector(`.card[data-id="${id}"]`)), subtreeBeforeKeyboardUndo.map((node) => node.id));
  await page.waitForSelector("#branch-undo.visible");
  await page.keyboard.press("Control+z");
  await page.waitForFunction((ids) => ids.every((id) => document.querySelector(`.card[data-id="${id}"]`)), subtreeBeforeKeyboardUndo.map((node) => node.id));
  assert.deepEqual(await readCanvasSubtree(page, finalBranchId), subtreeBeforeKeyboardUndo,
    "Cmd+Z should restore every node in the subtree with exact content, positions, sizes, and collapsed state");
  assert.equal(await page.locator("#branch-undo.visible").count(), 0, "Cmd+Z should dismiss the active undo toast");
  for (const node of subtreeBeforeKeyboardUndo) {
    assert.equal(await page.locator(`path[data-child="${node.id}"]`).count(), 1, `Undo should restore the edge for ${node.id}`);
  }

  const descendantId = subtreeBeforeKeyboardUndo.find((node) => node.parent_id === finalBranchId).id;
  await deleteCardBranch(page, page.locator(`.card[data-id="${descendantId}"]`));
  await page.waitForSelector("#branch-undo.visible");
  await deleteCardBranch(page, page.locator(`.card[data-id="${finalBranchId}"]`));
  await page.waitForSelector(`.card[data-id="${finalBranchId}"]`, { state: "detached" });
  await page.locator("#branch-undo [data-notice-action]").click();
  await page.waitForSelector(`.card[data-id="${finalBranchId}"]`);
  assert.equal(await page.locator(`.card[data-id="${descendantId}"]`).count(), 0,
    "removing a second branch should commit the first removal and offer Undo only for the newest one");

  await deleteCardBranch(page, page.locator(`.card[data-id="${finalBranchId}"]`));
  await page.waitForSelector("#branch-undo.visible");
  await page.waitForSelector("#branch-undo:not(.visible)", { state: "attached", timeout: 8000 });
  await page.waitForFunction(async () => (await window.__rabbitholeTest.readStoredHole()).nodes.every((node) => node.parent_id === null));
  assert.equal(await page.locator(".card:not(.root)").count(), 0, "an expired undo toast should leave the subtree deletion final");

  const external = requests.filter((url) => !url.startsWith(baseUrl));
  assert(external.length > 0, "provider and key validation should have been called");
  assert(external.every((url) => url === PROVIDER_URL || url === KEY_URL || url === MODEL_URL || url === LOCAL_MODEL_URL), `unexpected external request(s): ${external.join(", ")}`);
  await context.close();
}

// The composer action row's rest/draft swap, read from computed styles.
async function composerRowState(page, selector) {
  return page.locator(selector).evaluate((row) => ({
    lensesVisible: Array.from(row.querySelectorAll(".lens")).every((button) => getComputedStyle(button).display !== "none"),
    commitsHidden: Array.from(row.querySelectorAll(".ask-commit")).every((button) => getComputedStyle(button).display === "none"),
  }));
}

async function zoomToFit(page) {
  await page.keyboard.press("Control+K");
  await page.fill("#pal-text", "Zoom to fit");
  await page.press("#pal-text", "Enter");
  await page.waitForSelector("#palette", { state: "hidden" });
}

/* Playwright's waitForFunction resolves on a returned Promise rather than its
   value, so anything that must observe the persisted store polls it here. */
async function waitForStoredHole(page, predicate, what, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let hole = null;
  while (Date.now() < deadline) {
    hole = await page.evaluate(() => window.__rabbitholeTest.readStoredHole());
    if (hole && predicate(hole)) return hole;
    await page.waitForTimeout(120);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(hole?.nodes?.map((node) => [node.id, node.markdown]))}`);
}

/* Promote a docked note to a card through its own popover, the way a human
   does: click the dot, click Place on canvas, wait for the flight to land. */
async function placeDockedNote(page, selector = ".note-dot") {
  const dot = page.locator(selector).last();
  const id = await dot.getAttribute("data-note");
  await dot.click();
  await page.waitForSelector("#notepop.visible");
  await page.click("#notepop .note-pop-place");
  await page.waitForSelector(`.card[data-id="${id}"]`);
  await page.waitForTimeout(600);
  return id;
}

async function deleteCardBranch(page, card) {
  await card.locator(".card-more").click();
  const cardMenu = page.locator("#cardmenu");
  await cardMenu.waitFor({ state: "visible" });
  await cardMenu.locator("#cm-delete").click();
}

async function readCanvasSubtree(page, rootId) {
  return page.evaluate(async (targetId) => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    const byParent = new Map();
    for (const node of hole.nodes) {
      const siblings = byParent.get(node.parent_id) || [];
      siblings.push(node);
      byParent.set(node.parent_id, siblings);
    }
    const ids = [];
    const visit = (id) => {
      ids.push(id);
      for (const child of byParent.get(id) || []) visit(child.id);
    };
    visit(targetId);
    return ids.map((id) => {
      const node = hole.nodes.find((candidate) => candidate.id === id);
      const card = document.querySelector(`.card[data-id="${id}"]`);
      return {
        id: node.id, parent_id: node.parent_id, title: node.title, markdown: node.markdown,
        origin: node.origin, position: node.position, size: node.size, collapsed: node.collapsed,
        status: node.status, extensions: node.extensions,
        card: { left: card.style.left, top: card.style.top, width: card.style.width, collapsed: card.classList.contains("collapsed") },
      };
    });
  }, rootId);
}

async function findCanvasBackground(page) {
  return page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    // Leave room for the 180px draft and its resize handle so pointer-driven
    // card tests never ask Playwright to drag outside the browser viewport.
    for (let y = innerHeight - 220; y >= 90; y -= 70) {
      for (let x = innerWidth - 70; x >= 70; x -= 70) {
        const target = document.elementFromPoint(x, y);
        if (target && viewport.contains(target) && !target.closest(".card")) return { x, y };
      }
    }
    throw new Error("No empty canvas point found");
  });
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rabbitholeTest?.currentHoleId?.() || "");
  await page.evaluate((value) => window.__rabbitholeTest.createDocument(value), markdown);
  await page.waitForFunction((oldId) => {
    const id = window.__rabbitholeTest?.currentHoleId?.();
    return id && id !== oldId;
  }, previous);
  await page.waitForSelector(".card .doc-content[data-node-id]");
  return page.evaluate(() => window.__rabbitholeTest.currentHoleId());
}

async function ensureRailOpen(page) {
  if (await page.getAttribute("#t-rail", "aria-expanded") !== "true") {
    await page.click("#t-rail");
  }
  await page.waitForSelector("#web-rail.open");
}

async function waitForCanvasText(page, text) {
  await page.locator(".card", { hasText: text }).first().waitFor();
}

async function selectText(page, needle, rootSelector = ".card .doc-content[data-node-id]") {
  await selectVisibleText(page, { text: needle, rootSelector });
}

async function selectAcrossBlocks(page, startNeedle, endNeedle) {
  await page.evaluate(({ startNeedle, endNeedle }) => {
    const root = document.querySelector(".card.root .doc-content[data-node-id]");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let startNode, startOffset, endNode, endOffset, node;
    while ((node = walker.nextNode())) {
      if (!startNode) {
        const index = node.nodeValue.indexOf(startNeedle);
        if (index !== -1) { startNode = node; startOffset = index; }
      }
      const index = node.nodeValue.indexOf(endNeedle);
      if (index !== -1) { endNode = node; endOffset = index + endNeedle.length; }
    }
    if (!startNode || !endNode) throw new Error(`Cross-block range not found: ${startNeedle} → ${endNeedle}`);
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 160, clientY: 180 }));
  }, { startNeedle, endNeedle });
}
