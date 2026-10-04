/** @protects mermaid rendering capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import { buildCanvasHtml } from "../../src/node/mcp/http/page.js";
import { answerBranch } from "../../src/node/mcp/open.js";
import { createSession, closeAllSessions } from "../../src/node/mcp/registry.js";
import { ensureWebDist } from "../support/build.mjs";
import { serveStatic } from "../support/static-server.mjs";
import { buildSessionExportHtml } from "../support/session-export.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-mermaid-"));
process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = path.join(tmp, "store");
const fixturePath = path.join(tmp, "mermaid.rabbithole");
await fs.writeFile(fixturePath, JSON.stringify(portableFixture()), "utf8");

ensureWebDist();
const server = await serveStatic(WEB_DIST, { spaFallback: true });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  const snapshot = await verifyWebApp();
  await verifyOfflineSnapshot(snapshot);
  const blockSnapshot = await verifySelfContainedMcpPage();
  await verifyOfflineBlockAsks(blockSnapshot);
  verifyConditionalSnapshotAssembly();
  console.log("ok Mermaid: fullscreen controls, strict rendering, theme refresh, and offline snapshots");
} finally {
  await browser.close();
  await closeAllSessions("mermaid_test_complete");
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}

async function verifySelfContainedMcpPage() {
  const oversizedShowSelection = "Show selection target " + "x".repeat(2100);
  const rootMarkdown = [
    "```mermaid id=flow1",
    "flowchart LR",
    "  Start --> Safe",
    "```",
    "",
    "```show id=show1",
    `<div><strong>${oversizedShowSelection}</strong></div>`,
    "```",
  ].join("\n");
  const session = await createSession({
    holeId: "mermaid-mcp-live",
    title: "Mermaid MCP live",
    rootId: "root",
    nodes: [node("root", null, "Root", rootMarkdown, 0)],
    assetNames: new Set(),
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.on("request", (request) => requests.push(request.url()));
  await page.goto(session.url, { waitUntil: "load" });
  // The inline diagram contract below describes the reader column — expand the
  // current card into the reader first (canvas is the landing surface).
  await page.evaluate(() => document.querySelector(".card.current [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await page.waitForFunction(() => !!document.querySelector("#reader-main .viz-mermaid")?.shadowRoot?.querySelector("svg"));
  const peerPage = await context.newPage();
  await peerPage.goto(session.url, { waitUntil: "load" });
  await peerPage.evaluate(() => document.querySelector(".card.current [aria-label='Expand document']").click());
  await peerPage.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await peerPage.waitForFunction(() => !!document.querySelector("#reader-main .viz-mermaid")?.shadowRoot?.querySelector("svg"));
  assert(requests.some((url) => url.startsWith(session.url)), "MCP request capture must observe the canvas");
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 0, "MCP canvas must not fetch an external Mermaid asset");
  assert.equal(await page.locator('#rabbithole-mermaid-runtime[type="application/vnd.rabbithole+mermaid"]').count(), 1);

  await page.bringToFront();
  await selectVisualText(page, "flow1", "Safe");
  await page.waitForSelector("#ask.visible");
  assert.equal(await page.locator(".rh-lightbox").count(), 0, "drag-selecting Mermaid text must not open fullscreen");
  await clickMermaidVisual(page, "flow1");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  assert.equal(await page.locator(".rh-lightbox").count(), 0,
    "the first diagram click outside a selection popover must dismiss it without opening fullscreen");
  await selectVisualText(page, "flow1", "Safe");
  await page.waitForSelector("#ask.visible");
  await page.click('#ask .lens[data-lens="explain"]');
  await page.waitForFunction(() => {
    const mount = document.querySelector('.viz-mermaid[data-block-id="flow1"]');
    return mount?.shadowRoot?.querySelector(".rh-viz-mark")?.textContent === "1";
  });
  const flowAsk = [...session.nodes.values()].find((entry) => entry.origin?.anchor?.block?.block_id === "flow1");
  const flowRequest = [...session.requests.records()].find((entry) => entry.nodeId === flowAsk.id);
  const answerAbort = new AbortController();
  setTimeout(() => answerAbort.abort(), 100);
  await answerBranch({
    sessionId: session.id,
    requestId: flowRequest.requestId,
    title: "Flow answer",
    content: "Answered from the connected peer test.",
    signal: answerAbort.signal,
  });
  await peerPage.waitForFunction((id) => !!document.querySelector(`.card[data-id="${id}"]`), flowAsk.id, { timeout: 2000 });
  assert.equal(await peerPage.evaluate(() => document.querySelector('.viz-mermaid[data-block-id="flow1"]')?.shadowRoot?.querySelector(".rh-viz-mark")?.textContent || ""), "1",
    "a connected peer that received the branch must refresh the visual's chip without remounting it");

  await selectVisualText(page, "show1", oversizedShowSelection);
  await page.waitForSelector("#ask.visible");
  await clickShowVisual(page, "show1");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  assert.equal(await page.locator(".rh-lightbox").count(), 0,
    "the first HTML visual click outside a selection popover must dismiss it without opening fullscreen");
  await clickShowVisual(page, "show1");
  await page.waitForSelector(".rh-lightbox .rh-lightbox-show");
  await selectVisualText(page, "show1", oversizedShowSelection, { lightbox: true });
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Why is this target important?");
  await page.click('#ask .ask-commit[data-commit="ask"]');
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  await page.waitForFunction(() => {
    const mount = document.querySelector('.viz-show[data-block-id="show1"]');
    return mount?.shadowRoot?.querySelector(".rh-viz-mark")?.textContent === "1";
  });

  const blockAsks = [...session.nodes.values()].filter((entry) => entry.parent_id === "root" && entry.origin?.anchor?.block);
  assert.deepEqual(blockAsks.map((entry) => ({
    block: entry.origin.anchor.block,
    question: entry.origin.question,
    lens: entry.origin.lens,
    instruction: typeof entry.origin.instruction === "string" && entry.origin.instruction.length > 0,
  })), [
    { block: { block_id: "flow1", selected_text: "Safe" }, question: "", lens: "explain", instruction: true },
    { block: { block_id: "show1", selected_text: oversizedShowSelection.slice(0, 2000) }, question: "Why is this target important?", lens: null, instruction: false },
  ], "visual asks persist block identity while preset instructions remain separate from typed human questions");
  // The canvas waits behind the reader, unrendered: read what the card says.
  assert.equal(await page.locator(`.card[data-id="${blockAsks[1].id}"] .origin-quote`).textContent(),
    "“Why is this target important?”",
    "an answer window must quote the human's question instead of the selected source text");

  for (const blockId of ["flow1", "show1"]) {
    assert.equal(await visualExpandOpacity(page, blockId), "0",
      `${blockId} expand control must stay hidden until its visual is hovered`);
    await hoverVisual(page, blockId);
    await page.waitForFunction((id) => {
      const host = document.querySelector(`#reader-main [data-block-id="${id}"]`);
      const button = host?.shadowRoot?.querySelector(".rh-show-expand, .rh-mermaid-expand");
      return button && getComputedStyle(button).opacity === "1";
    }, blockId);
    await page.mouse.move(0, 0);
    await page.waitForFunction((id) => {
      const host = document.querySelector(`#reader-main [data-block-id="${id}"]`);
      const button = host?.shadowRoot?.querySelector(".rh-show-expand, .rh-mermaid-expand");
      return button && getComputedStyle(button).opacity === "0";
    }, blockId);
  }
  const html = await buildSessionExportHtml(session);
  assert(html.includes('id="rabbithole-mermaid-runtime"'), "MCP export should carry its Mermaid runtime offline");
  await context.close();
  return html;
}

async function verifyOfflineBlockAsks(snapshot) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(snapshot, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const ids = ["flow1", "show1"];
    return ids.every((id) => {
      const mount = document.querySelector(`[data-block-id="${id}"]`);
      return mount?.shadowRoot?.querySelector(".rh-viz-mark")?.textContent === "1";
    });
  });
  await selectVisualText(page, "flow1", "Safe");
  await page.waitForTimeout(50);
  assert.equal(await page.locator("#ask.visible").count(), 0, "a frozen visual keeps its branch chip without exposing an ask surface");
  await page.evaluate(() => document.querySelector('.viz-show[data-block-id="show1"]')?.shadowRoot?.querySelector(".rh-viz-mark")?.click());
  await page.waitForFunction(() => document.querySelector("#reader-main .reader-context")?.textContent.includes("Show selection target"));
  await context.close();
}

async function selectVisualText(page, blockId, needle, options = {}) {
  await page.evaluate(({ blockId, needle, lightbox }) => {
    const host = lightbox
      ? document.querySelector(".rh-lightbox-show")
      : document.querySelector(`[data-block-id="${blockId}"]`);
    const root = lightbox ? host?.shadowRoot?.querySelector(".rh-viz-content") : host?.shadowRoot?.querySelector(".rh-viz-content");
    if (!root) throw new Error(`Visual ${blockId} is not mounted`);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) {
      if (walker.currentNode.data.includes(needle)) {
        textNode = walker.currentNode;
        break;
      }
    }
    if (!textNode) throw new Error(`Text ${needle} is not rendered in ${blockId}`);
    const start = textNode.data.indexOf(needle);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + needle.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const rect = range.getBoundingClientRect();
    const target = textNode.parentElement;
    const event = (type, x) => new PointerEvent(type, {
      bubbles: true, composed: true, pointerId: 91, button: 0, isPrimary: true,
      clientX: x, clientY: rect.top + Math.max(1, rect.height / 2),
    });
    target.dispatchEvent(event("pointerdown", rect.left + 1));
    target.dispatchEvent(event("pointerup", rect.left + 11));
  }, { blockId, needle, lightbox: options.lightbox === true });
}

async function clickShowVisual(page, blockId) {
  await page.evaluate((id) => {
    const root = document.querySelector(`.viz-show[data-block-id="${id}"]`)?.shadowRoot?.querySelector(".rh-viz-content");
    const target = root?.querySelector("strong") || root?.firstElementChild;
    if (!target) throw new Error(`Show visual ${id} is not mounted`);
    window.getSelection()?.removeAllRanges();
    const rect = target.getBoundingClientRect();
    for (const type of ["pointerdown", "pointerup"]) target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, composed: true, pointerId: 92, button: 0, isPrimary: true,
      clientX: rect.left + 2, clientY: rect.top + 2,
    }));
  }, blockId);
}

async function clickMermaidVisual(page, blockId) {
  await page.evaluate((id) => {
    const host = document.querySelector(`#reader-main .viz-mermaid[data-block-id="${id}"]`);
    const target = host?.shadowRoot?.querySelector(".rh-mermaid svg");
    if (!target) throw new Error(`Mermaid visual ${id} is not mounted`);
    window.getSelection()?.removeAllRanges();
    const rect = target.getBoundingClientRect();
    for (const type of ["pointerdown", "pointerup"]) target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, composed: true, pointerId: 93, button: 0, isPrimary: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
  }, blockId);
}

async function visualExpandOpacity(page, blockId) {
  return page.evaluate((id) => {
    const host = document.querySelector(`#reader-main [data-block-id="${id}"]`);
    const button = host?.shadowRoot?.querySelector(".rh-show-expand, .rh-mermaid-expand");
    return button ? getComputedStyle(button).opacity : null;
  }, blockId);
}

async function hoverVisual(page, blockId) {
  await page.locator(
    `#reader-main [data-block-id="${blockId}"] .rh-mermaid, #reader-main [data-block-id="${blockId}"] .rh-viz-content`,
  ).first().hover();
}

async function verifyWebApp() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.continue();
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert(requests.some((url) => url.startsWith(baseUrl)), "web request capture must observe the app");
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 0, "blank web app must not load Mermaid");

  await page.setInputFiles("#file-md", fixturePath);
  try {
    await page.waitForFunction(() => {
      const mounts = [...document.querySelectorAll(".viz-mermaid")];
      const rendered = mounts.filter((mount) => mount.shadowRoot?.querySelector(".rh-mermaid svg")).length;
      const fallback = mounts.filter((mount) => mount.shadowRoot?.querySelector(".viz-fallback code")?.textContent.includes("this is not valid mermaid")).length;
      return rendered >= 2 && fallback >= 1;
    });
  } catch (error) {
    const state = await page.evaluate(() => [...document.querySelectorAll(".viz-mermaid")].map((mount) => ({
      svg: !!mount.shadowRoot?.querySelector("svg"),
      fallback: mount.shadowRoot?.querySelector(".viz-fallback code")?.textContent || "",
      text: mount.shadowRoot?.textContent || "",
    })));
    throw new Error(`Mermaid mounts did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
  // The inline diagram contract describes the reader column — expand the
  // current card into the reader first (canvas is the landing surface).
  await page.evaluate(() => document.querySelector(".card.current [aria-label='Expand document']").click());
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas") && !document.body.classList.contains("mode-flight"));
  await page.waitForFunction(() => !!document.querySelector("#reader-main .viz-mermaid")?.shadowRoot?.querySelector("svg"));
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 1, "all live diagrams should share one lazy runtime load");

  const safe = await page.evaluate(() => {
    const mounts = [...document.querySelectorAll(".viz-mermaid")];
    const elements = mounts.flatMap((mount) => [...(mount.shadowRoot?.querySelectorAll("*") || [])]);
    return {
      pwned: window.__mermaidProbePwned || 0,
      scripts: elements.filter((element) => /^(?:SCRIPT|IFRAME|OBJECT|EMBED|FORM)$/.test(element.tagName)).length,
      handlers: elements.flatMap((element) => [...element.attributes]).filter((attribute) => /^on/i.test(attribute.name)).length,
      javascriptUrls: elements.flatMap((element) => [...element.attributes]).filter((attribute) => /^(?:href|src|xlink:href)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value)).length,
      italicLabel: elements.some((element) => element.tagName === "tspan"
        && element.textContent === "draw a peach hibiscus"
        && [...element.querySelectorAll(":scope > tspan")].every((part) => part.getAttribute("font-style") === "italic")),
      foreignObjects: elements.filter((element) => element.tagName.toLowerCase() === "foreignobject").length,
      rendered: mounts.filter((mount) => mount.shadowRoot?.querySelector("svg")).length,
      fallbackText: mounts.map((mount) => mount.shadowRoot?.querySelector(".viz-fallback code")?.textContent || "").find(Boolean) || "",
    };
  });
  assert.deepEqual({ pwned: safe.pwned, scripts: safe.scripts, handlers: safe.handlers, javascriptUrls: safe.javascriptUrls }, { pwned: 0, scripts: 0, handlers: 0, javascriptUrls: 0 });
  assert.equal(safe.italicLabel, true, "strict Mermaid Markdown labels should render semantic emphasis without HTML labels");
  assert.equal(safe.foreignObjects, 0, "Markdown label formatting should remain native SVG rather than embedding HTML");
  assert(safe.rendered >= 2);
  assert.equal(safe.fallbackText, "this is not valid mermaid");

  const affordances = await page.evaluate(() => [...document.querySelectorAll(".viz-mermaid")].map((mount) => ({
    rendered: !!mount.shadowRoot?.querySelector(".rh-mermaid svg"),
    fallback: !!mount.shadowRoot?.querySelector(".viz-fallback"),
    expand: !!mount.shadowRoot?.querySelector('button.rh-mermaid-expand[aria-label="Open diagram fullscreen"][title="Open fullscreen"]'),
  })));
  assert(affordances.filter((item) => item.rendered && item.expand).length >= 2, "successful Mermaid renders should expose expand controls");
  assert(affordances.filter((item) => item.fallback).every((item) => !item.expand), "Mermaid fallbacks must not expose expand controls");

  const inlineLayout = await page.evaluate(() => {
    const mount = [...document.querySelectorAll(".viz-mermaid")].find((item) => item.shadowRoot?.querySelector(".rh-mermaid svg"));
    const frame = mount.shadowRoot.querySelector(".rh-viz-frame");
    const svgRect = mount.shadowRoot.querySelector(".rh-mermaid svg").getBoundingClientRect();
    const buttonRect = mount.shadowRoot.querySelector(".rh-mermaid-expand").getBoundingClientRect();
    return {
      intersects: buttonRect.left < svgRect.right && buttonRect.right > svgRect.left
        && buttonRect.top < svgRect.bottom && buttonRect.bottom > svgRect.top,
      svgWidth: svgRect.width,
      clientWidth: frame.clientWidth,
      hostContain: getComputedStyle(mount).contain,
    };
  });
  assert.equal(inlineLayout.intersects, false, `inline expand control must not cover the rendered SVG (${JSON.stringify(inlineLayout)})`);
  assert(inlineLayout.svgWidth > 0 && inlineLayout.svgWidth <= inlineLayout.clientWidth + 1, `fitted Mermaid SVG should not require frame scrolling (${JSON.stringify(inlineLayout)})`);
  assert(!inlineLayout.hostContain.includes("paint"), "Mermaid host paint containment must not clip the elevated expand control");

  const expand = page.locator(".rh-mermaid-expand:visible").first();
  await expand.focus();
  await expand.press("Enter");
  await page.waitForSelector(".rh-lightbox .rh-lightbox-diagram");
  await page.waitForTimeout(200);
  const fullscreen = await page.locator(".rh-lightbox").evaluate((overlay) => {
    const svg = overlay.querySelector(".rh-lightbox-diagram");
    const close = overlay.querySelector(".rh-lightbox-close");
    const viewport = overlay.querySelector(".rh-lightbox-diagram-viewport");
    const rect = svg.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const viewportStyle = getComputedStyle(viewport);
    const insetWidth = parseFloat(viewportStyle.paddingLeft) + parseFloat(viewportStyle.paddingRight);
    const insetHeight = parseFloat(viewportStyle.paddingTop) + parseFloat(viewportStyle.paddingBottom);
    const viewBox = svg.viewBox.baseVal;
    return {
      tag: svg.tagName,
      width: rect.width,
      height: rect.height,
      viewportBoxWidth: viewportRect.width,
      viewportBoxHeight: viewportRect.height,
      viewportContentAspect: (viewportRect.width - insetWidth) / (viewportRect.height - insetHeight),
      viewBoxAspect: viewBox.width / viewBox.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      fullscreenBackground: getComputedStyle(overlay).backgroundColor,
      fittedBackground: viewportStyle.backgroundColor,
      fittedBorderWidth: viewportStyle.borderWidth,
      fittedBorderRadius: viewportStyle.borderRadius,
      closeGap: closeRect.left - rect.right,
      widthAttr: svg.getAttribute("width"),
      heightAttr: svg.getAttribute("height"),
      preserveAspectRatio: svg.getAttribute("preserveAspectRatio"),
      label: overlay.querySelector(".rh-lightbox-dialog").getAttribute("aria-label"),
    };
  });
  assert.equal(fullscreen.tag.toLowerCase(), "svg");
  assert(
    Math.abs(fullscreen.viewportContentAspect - fullscreen.viewBoxAspect) / fullscreen.viewBoxAspect < 0.01,
    `fullscreen fitted viewport should match the Mermaid viewBox aspect (${JSON.stringify(fullscreen)})`,
  );
  assert(
    fullscreen.viewportBoxWidth >= Math.min(fullscreen.viewportWidth * 0.96, fullscreen.viewportWidth - 112) - 1
      || fullscreen.viewportBoxHeight >= Math.min(fullscreen.viewportHeight * 0.92, fullscreen.viewportHeight - 32) - 1,
    `fullscreen Mermaid should scale up to the largest aspect-fitted viewport budget (${JSON.stringify(fullscreen)})`,
  );
  assert.notEqual(fullscreen.fullscreenBackground, "rgba(0, 0, 0, 0)", "diagram background should cover the fullscreen overlay");
  assert.equal(fullscreen.fittedBackground, "rgba(0, 0, 0, 0)", "the fitted diagram viewport should not leave behind its own background");
  assert.equal(fullscreen.fittedBorderWidth, "0px", "fullscreen diagrams should not retain a card border");
  assert.equal(fullscreen.fittedBorderRadius, "0px", "fullscreen diagrams should not retain rounded card corners");
  assert(fullscreen.closeGap >= 0, "fullscreen close control should not overlap diagram content");
  assert.equal(fullscreen.widthAttr, null);
  assert.equal(fullscreen.heightAttr, null);
  assert.equal(fullscreen.preserveAspectRatio, "xMidYMid meet");
  assert.equal(fullscreen.label, "Mermaid diagram");

  await page.locator(".rh-lightbox-diagram").dblclick();
  assert.equal(await page.locator(".rh-lightbox-diagram").evaluate((svg) => svg.style.getPropertyValue("--rh-zoom")), "2");
  const zoomedLayout = await page.locator(".rh-lightbox").evaluate((overlay) => {
    const svg = overlay.querySelector(".rh-lightbox-diagram");
    const viewport = overlay.querySelector(".rh-lightbox-diagram-viewport");
    const close = overlay.querySelector(".rh-lightbox-close");
    const svgRect = svg.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    const sample = { x: viewportRect.left - 2, y: viewportRect.top + viewportRect.height / 2 };
    const diagramHitOutsideViewport = document.elementsFromPoint(sample.x, sample.y).some((element) => element === svg || svg.contains(element));
    const closeHit = document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2);
    return {
      overflow: getComputedStyle(viewport).overflow,
      svgExceedsViewport: svgRect.left < viewportRect.left && svgRect.right > viewportRect.right,
      diagramHitOutsideViewport,
      closeHit: close === closeHit || close.contains(closeHit),
      closeZ: parseInt(getComputedStyle(close).zIndex, 10),
      viewportZ: parseInt(getComputedStyle(viewport).zIndex, 10),
      closeBackground: getComputedStyle(close).backgroundColor,
      closeShadow: getComputedStyle(close).boxShadow,
    };
  });
  assert.equal(zoomedLayout.overflow, "visible", "fitted viewport should let zoomed content use the fullscreen canvas");
  assert.equal(zoomedLayout.svgExceedsViewport, true, "2x diagram geometry should exceed its initial fitted viewport");
  assert.equal(zoomedLayout.diagramHitOutsideViewport, true, "zoomed diagram should paint and remain interactive across the fullscreen canvas");
  assert(zoomedLayout.closeZ > zoomedLayout.viewportZ, `close control must stack above the diagram (${JSON.stringify(zoomedLayout)})`);
  assert.equal(zoomedLayout.closeHit, true, `close control must remain hit-testable at 2x zoom (${JSON.stringify(zoomedLayout)})`);
  assert(!zoomedLayout.closeBackground.endsWith(", 0)"), "close control should have an opaque theme surface");
  assert.notEqual(zoomedLayout.closeShadow, "none", "close control should retain elevation over diagram content");
  const beforeTheme = await firstMermaidSvg(page);
  const beforeFullscreen = await page.locator(".rh-lightbox-diagram").evaluate((svg) => svg.outerHTML);
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
  await page.waitForFunction((before) => {
    const mount = document.querySelector(".viz-mermaid");
    return !!mount?.shadowRoot?.querySelector("svg") && mount.shadowRoot.querySelector("svg").outerHTML !== before;
  }, beforeTheme);
  await page.waitForFunction((before) => document.querySelector(".rh-lightbox-diagram")?.outerHTML !== before, beforeFullscreen);
  assert.equal(await page.locator(".rh-lightbox-diagram").evaluate((svg) => svg.style.getPropertyValue("--rh-zoom")), "2", "theme refresh should preserve fullscreen zoom");
  // A trackpad pinch arrives as a burst of small ctrl+wheel events: zoom must
  // follow the fingers' travel, not the event count, and hold the point under
  // the cursor still.
  await page.locator(".rh-lightbox-diagram").dblclick();
  const pinch = await page.locator(".rh-lightbox-diagram").evaluate((svg) => {
    const before = svg.getBoundingClientRect();
    const at = { x: before.left + before.width * 0.3, y: before.top + before.height * 0.4 };
    for (let i = 0; i < 30; i++) {
      svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -2, ctrlKey: true, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
    }
    const after = svg.getBoundingClientRect();
    return {
      zoom: Number(svg.style.getPropertyValue("--rh-zoom")),
      drift: Math.hypot(after.left + after.width * 0.3 - at.x, after.top + after.height * 0.4 - at.y),
    };
  });
  assert(pinch.zoom > 1.5 && pinch.zoom < 2.2, `a small pinch zooms in proportion to its travel (${JSON.stringify(pinch)})`);
  assert(pinch.drift < 2, `zoom holds the point under the cursor (${JSON.stringify(pinch)})`);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  assert.equal(await page.evaluate(() => {
    const mount = document.activeElement;
    return mount?.shadowRoot?.activeElement?.classList.contains("rh-mermaid-expand") || false;
  }), true, "Mermaid Escape should restore focus to the expand control");

  await expand.press("Enter");
  await page.waitForSelector(".rh-lightbox");
  await page.click('.rh-lightbox-close[aria-label="Close"]');
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  assert.equal(await page.evaluate(() => {
    const mount = document.activeElement;
    return mount?.shadowRoot?.activeElement?.classList.contains("rh-mermaid-expand") || false;
  }), true, "Mermaid close button should restore focus to the expand control");

  const surfaceBox = await page.locator(".rh-mermaid svg:visible").first().boundingBox();
  assert(surfaceBox, "rendered Mermaid should have a clickable surface");
  await page.mouse.click(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height / 2);
  await page.waitForSelector(".rh-lightbox .rh-lightbox-diagram");
  await page.mouse.click(5, 5);
  await page.waitForSelector(".rh-lightbox", { state: "detached" });

  await page.mouse.move(surfaceBox.x + surfaceBox.width / 2, surfaceBox.y + surfaceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(surfaceBox.x + surfaceBox.width / 2 + 10, surfaceBox.y + surfaceBox.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(50);
  assert.equal(await page.locator(".rh-lightbox").count(), 0, "dragging across a Mermaid diagram must not open fullscreen");

  const snapshot = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  assert(snapshot.includes('type="application/vnd.rabbithole+mermaid"'), "Mermaid snapshots should carry an inert offline runtime");
  assert(snapshot.includes('globalThis["mermaid"]'), "Mermaid snapshots should contain the pinned runtime source");
  assert.equal(requests.filter((url) => /\/mermaid\.js(?:\?|$)/.test(url)).length, 2, "snapshot export should fetch the runtime source once after the live script load");
  await context.close();
  return snapshot;
}

async function firstMermaidSvg(page) {
  return page.evaluate(() => document.querySelector(".viz-mermaid")?.shadowRoot?.querySelector("svg")?.outerHTML || "");
}

async function verifyOfflineSnapshot(snapshot) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  const captureProbe = "https://rabbithole-mermaid-capture-probe.invalid/";
  await page.evaluate((url) => fetch(url).catch(() => null), captureProbe);
  assert(requests.includes(captureProbe), "offline request capture must observe the probe");
  requests.length = 0;
  await page.setContent(snapshot, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const mounts = [...document.querySelectorAll(".viz-mermaid")];
    return mounts.filter((mount) => mount.shadowRoot?.querySelector("svg")).length >= 2
      && mounts.filter((mount) => mount.shadowRoot?.querySelector(".viz-fallback")).length >= 1;
  });
  assert.deepEqual(requests, [], "offline Mermaid snapshots must make zero network requests");
  assert.equal(await page.evaluate(() => window.__mermaidProbePwned || 0), 0);
  const expand = page.locator(".rh-mermaid-expand:visible").first();
  await expand.focus();
  await expand.press("Enter");
  await page.waitForSelector(".rh-lightbox .rh-lightbox-diagram");
  await page.click('.rh-lightbox-close[aria-label="Close"]');
  await page.waitForSelector(".rh-lightbox", { state: "detached" });
  await context.close();
}

function verifyConditionalSnapshotAssembly() {
  const common = {
    title: "No diagrams",
    stylesheetText: "body{}",
    dompurifySource: "window.DOMPurify={sanitize:function(value){return value},addHook:function(){}};",
    frozenClientSource: "window.RabbitholeFrozenClient={startPortableSnapshot:function(){}};",
  };
  const without = buildSnapshotHtml({ ...common, snapshotProjection: projectionWith("Plain prose") });
  assert(!without.includes("rabbithole-mermaid-runtime"), "ordinary snapshots must not embed Mermaid");
  assert.throws(
    () => buildSnapshotHtml({ ...common, snapshotProjection: projectionWith("```mermaid\nflowchart LR\nA-->B\n```") }),
    /Mermaid runtime is unavailable/,
  );
  const nestedExample = buildSnapshotHtml({
    ...common,
    snapshotProjection: projectionWith("````markdown\n```mermaid\nA-->B\n```\n````"),
  });
  assert(!nestedExample.includes("rabbithole-mermaid-runtime"), "Mermaid examples inside outer code fences must not opt into the runtime");
}

function projectionWith(markdown) {
  return {
    format: "rabbithole",
    format_version: 1,
    hole: {
      schema_version: 2,
      hole_id: "conditional-snapshot",
      title: "Conditional snapshot",
      root_id: "root",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      view_state: null,
      nodes: [node("root", null, "Root", markdown, 0)],
    },
    assets: {},
  };
}

function portableFixture() {
  const hostileLabel = '<img src=x onerror="window.__mermaidProbePwned=1">';
  return {
    format: "rabbithole",
    format_version: 1,
    hole: {
      schema_version: 2,
      hole_id: "mermaid-rendering",
      title: "Mermaid rendering",
      root_id: "root",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      view_state: null,
      nodes: [
        node("root", null, "Flowchart", [
          "# Flowchart",
          "",
          "```mermaid",
          "flowchart LR",
          `  A[\"${hostileLabel}\"] --> B[Safe]`,
          '  click A "javascript:window.__mermaidProbePwned=2"',
          "```",
        ].join("\n"), 0),
        node("sequence", "root", "Sequence", [
          "# Sequence",
          "",
          "```mermaid",
          "sequenceDiagram",
          "  participant Human",
          "  participant Rabbithole",
          "  Human->>Rabbithole: Ask",
          "  Rabbithole-->>Human: Branch",
          "```",
        ].join("\n"), 440),
        node("formatted-label", "root", "Formatted label", [
          "# Formatted label",
          "",
          "```mermaid",
          "flowchart LR",
          '  Prompt["`Prompt',
          '',
          '  *draw a peach hibiscus*',
          '',
          '  in watercolour`"] --> Result[Result]',
          "```",
        ].join("\n"), 660),
        node("invalid", "root", "Invalid", "```mermaid\nthis is not valid mermaid\n```", 880),
      ],
    },
    assets: {},
  };
}

function node(id, parentId, title, markdown, x) {
  return {
    id,
    parent_id: parentId,
    title,
    markdown,
    base_url: null,
    base_url_source: null,
    origin: null,
    position: { x, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: "2026-01-01T00:00:00.000Z",
    extensions: {},
  };
}
