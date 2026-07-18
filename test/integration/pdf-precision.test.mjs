import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { ensureWebDist } from "../support/build.mjs";
import { serveStatic } from "../support/static-server.mjs";
import { corsHeaders, sse } from "../support/provider-mock.mjs";
import { ATTENTION_PDF_PAGE_COUNT, ATTENTION_PDF_SHA256, ATTENTION_PAGE_VIEW, readAttentionPdf } from "../support/attention-pdf.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
try { await fs.access(path.join(WEB_DIST, "index.html")); } catch { ensureWebDist(); }

const server = await serveStatic(WEB_DIST, { spaFallback: true });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 2 });
await context.addInitScript(() => localStorage.setItem("rh-web-settings", JSON.stringify({
  preset: "custom",
  base_url: "http://localhost:11434/v1",
  model: "llama3.2",
  transcribe_model: "llama3.2-vision",
  session_only: true,
  generation_setup: { version: 1, preset: "custom", base_url: "http://localhost:11434/v1", model: "llama3.2" },
})));
const page = await context.newPage();
const pageErrors = [];
const answerBodies = [];
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
await page.route("http://localhost:11434/v1/models", (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "llama3.2" }, { id: "llama3.2-vision" }] }) }));
await page.route("http://localhost:11434/api/show", (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ capabilities: ["completion", "vision"] }) }));
await page.route("http://localhost:11434/v1/chat/completions", async (route) => {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
  answerBodies.push(route.request().postDataJSON());
  return route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "text/event-stream" }, body: sse(["# Precise answer\n\nCoordinate-safe response."]) });
});

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__rabbitholeTest && document.body.classList.contains("web-app"));
  await page.click("#blank-start-new");
  await page.waitForSelector("#composer-path-file");
  const sourceBytes = await readAttentionPdf();
  await dropPdf(page, sourceBytes);
  await page.waitForSelector(`.node .rh-pdf-page[data-page='${ATTENTION_PDF_PAGE_COUNT}']`);
  await page.waitForFunction(() => [...document.querySelectorAll(".node .rh-pdf-textlayer span")].some((element) => element.textContent === "Attention Is All You Need"));
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".node .rh-pdf-canvas-generation canvas");
    return !!canvas && canvas.width > 0 && canvas.height > 0;
  });

  const imported = await portableState(page);
  const root = imported.hole.nodes.find((node) => !node.parent_id);
  assert.equal(root.extensions.pdf.page_count, ATTENTION_PDF_PAGE_COUNT);
  assert.equal(root.extensions.pdf.pages.length, ATTENTION_PDF_PAGE_COUNT);
  assert.deepEqual(root.extensions.pdf.pages, Array.from({ length: ATTENTION_PDF_PAGE_COUNT }, (_, index) => ({
    n: index + 1,
    view: ATTENTION_PAGE_VIEW,
    rotate: 0,
    user_unit: 1,
  })), "every visible page box in the real paper must survive import exactly");
  assert.equal(root.extensions.pdf.source.sha256, ATTENTION_PDF_SHA256);
  assert.deepEqual(Object.keys(imported.assets), [root.extensions.pdf.source.asset]);
  assert.equal(Buffer.from(imported.assets[root.extensions.pdf.source.asset], "base64").equals(Buffer.from(sourceBytes)), true);
  assert.match(root.markdown, /Attention Is All You Need/);
  assert.match(root.markdown, /The dominant sequence transduction models/);

  const scrollContract = await page.evaluate(() => {
    const body = document.querySelector(".node .node-body");
    const pdfScroll = document.querySelector(".node .rh-pdf-scroll");
    const toolbar = document.querySelector(".node .rh-pdf-toolbar");
    const region = toolbar.querySelector(".rh-pdf-region-actions .node-btn");
    const zoom = toolbar.querySelector(".rh-pdf-zoom-controls");
    const convert = toolbar.querySelector(".rh-pdf-document-actions .node-btn");
    const rect = (element) => element.getBoundingClientRect().toJSON();
    return {
      bodyClass: body.className,
      bodyOverflow: getComputedStyle(body).overflow,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      pdfClientHeight: pdfScroll.clientHeight,
      pdfScrollHeight: pdfScroll.scrollHeight,
      pdfRect: rect(pdfScroll),
      bodyRect: rect(body),
      toolbarRect: rect(toolbar),
      toolbarText: toolbar.textContent,
      regionRect: rect(region),
      zoomRect: rect(zoom),
      convertRect: rect(convert),
      world: document.querySelector("#world").style.transform,
    };
  });
  assert.match(scrollContract.bodyClass, /\bpdf-body\b/, "a canvas PDF must opt into the dedicated PDF reader layout");
  assert.equal(scrollContract.bodyOverflow, "hidden", "the card body must not compete with the PDF for the same trackpad gesture");
  assert.equal(scrollContract.bodyScrollHeight, scrollContract.bodyClientHeight, "the card body must not retain a second vertical scroll range");
  assert(scrollContract.pdfScrollHeight > scrollContract.pdfClientHeight * 5, "the PDF itself must own the document scroll range");
  assert(Math.abs(scrollContract.toolbarRect.top - scrollContract.bodyRect.top) <= 0.5, "the PDF toolbar must start directly beneath the card titlebar");
  assert(Math.abs(scrollContract.toolbarRect.left - scrollContract.bodyRect.left) <= 0.5 && Math.abs(scrollContract.toolbarRect.right - scrollContract.bodyRect.right) <= 0.5,
    "the pinned PDF toolbar must run pixel-perfect edge to edge across the card body");
  assert.equal(/\b(?:pages?|source|loading)\b/i.test(scrollContract.toolbarText), false, `the PDF toolbar must contain controls, not implementation status: ${scrollContract.toolbarText}`);
  assert(scrollContract.regionRect.right < scrollContract.zoomRect.left && scrollContract.zoomRect.right < scrollContract.convertRect.left,
    "the toolbar must keep area, zoom, and conversion actions in distinct left/center/right zones");
  assert(Math.abs((scrollContract.zoomRect.left + scrollContract.zoomRect.right) / 2 - (scrollContract.toolbarRect.left + scrollContract.toolbarRect.right) / 2) <= 0.75,
    "the PDF zoom cluster must be geometrically centered in the toolbar");
  await page.mouse.move(scrollContract.pdfRect.x + scrollContract.pdfRect.width / 2, scrollContract.pdfRect.y + scrollContract.pdfRect.height / 2);
  await page.mouse.wheel(0, 420);
  await page.waitForFunction(() => document.querySelector(".node .rh-pdf-scroll").scrollTop > 300);
  const trackpadResult = await page.evaluate(() => ({
    bodyTop: document.querySelector(".node .node-body").scrollTop,
    pdfTop: document.querySelector(".node .rh-pdf-scroll").scrollTop,
    toolbarTop: document.querySelector(".node .rh-pdf-toolbar").getBoundingClientRect().top,
    world: document.querySelector("#world").style.transform,
  }));
  assert.equal(trackpadResult.bodyTop, 0, "trackpad scrolling over a PDF must never move the outer card body");
  assert(trackpadResult.pdfTop > 300, "trackpad scrolling over a PDF must move its pages");
  assert(Math.abs(trackpadResult.toolbarTop - scrollContract.toolbarRect.top) <= 0.5, "the PDF toolbar must remain pinned while its pages scroll");
  assert.equal(trackpadResult.world, scrollContract.world, "reading the PDF must never pan or zoom the canvas");
  await page.evaluate(() => { document.querySelector(".node .rh-pdf-scroll").scrollTop = 0; });

  await page.click("#t-reader");
  await page.waitForSelector("body:not(.mode-canvas) #tb-document .rh-pdf-reader-toolbar");
  await page.waitForFunction(() => document.querySelector("#reader-main .rh-pdf-canvas-generation[data-ready='true'] canvas"));
  const readerContract = await page.evaluate(() => {
    const rect = (element) => element.getBoundingClientRect().toJSON();
    const main = document.querySelector("#reader-main");
    const col = main.querySelector(".reader-col");
    const pdf = main.querySelector(".doc-content.rh-pdf");
    const scroll = pdf.querySelector(".rh-pdf-scroll");
    const toolbar = document.querySelector("#tb-document .rh-pdf-reader-toolbar");
    return {
      mainClass: main.className,
      colClass: col.className,
      mainOverflow: getComputedStyle(main).overflow,
      mainClientHeight: main.clientHeight,
      mainScrollHeight: main.scrollHeight,
      mainRect: rect(main),
      scrollRect: rect(scroll),
      scrollContentCenter: scroll.getBoundingClientRect().left + scroll.clientWidth / 2,
      scrollClientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      pageRect: rect(scroll.querySelector(".rh-pdf-page")),
      toolbarRect: rect(toolbar),
      toolbarParent: toolbar.parentElement.id,
      toolsRect: rect(document.querySelector("#tb-tools")),
      sessionRect: rect(document.querySelector("#tb-session")),
      composerRect: rect(document.querySelector("#composer")),
      inlineToolbar: !!pdf.querySelector(".rh-pdf-toolbar"),
      canvasZoom: document.querySelector(".node .rh-pdf-scroll").dataset.zoom,
    };
  });
  assert.match(readerContract.mainClass, /\bpdf-reader-viewport\b/, "a standalone Reader PDF must opt into the full reader viewport");
  assert.match(readerContract.colClass, /\bpdf-reader-viewport\b/);
  assert.equal(readerContract.mainOverflow, "hidden", "Reader must not wrap the PDF in a competing outer scroll surface");
  assert.equal(readerContract.mainScrollHeight, readerContract.mainClientHeight, "Reader must expose exactly one vertical PDF scroll range");
  assert.equal(readerContract.toolbarParent, "tb-document", "Reader PDF controls belong to the shared top chrome");
  assert.equal(readerContract.inlineToolbar, false, "Reader must not duplicate the PDF toolbar above the paper");
  assert(Math.abs(readerContract.toolbarRect.top - readerContract.toolsRect.top) <= 0.5, "PDF controls must align with the existing top chrome row");
  assert(Math.abs((readerContract.toolbarRect.left + readerContract.toolbarRect.right) / 2 - readerContract.scrollContentCenter) <= 0.5,
    "the compact PDF controls must center on the PDF's usable viewport, including its scrollbar gutter");
  assert(readerContract.toolbarRect.width < 310, `Reader controls must shrink-wrap their actions instead of recreating a card toolbar: ${readerContract.toolbarRect.width}px`);
  assert(readerContract.toolbarRect.left >= readerContract.toolsRect.right + 8 && readerContract.toolbarRect.right <= readerContract.sessionRect.left - 8,
    "docked PDF controls must never overlap application or session controls");
  assert(Math.abs(readerContract.scrollRect.top - readerContract.mainRect.top) <= 0.5, "the PDF surface must start at the top of the reader viewport");
  assert(Math.abs(readerContract.scrollRect.bottom - readerContract.mainRect.bottom) <= 0.5, "the PDF surface must fill the reader viewport down to the composer");
  assert(Math.abs(readerContract.composerRect.top - readerContract.mainRect.bottom) <= 0.5, "the composer must follow the PDF viewport without a dead band");
  assert(readerContract.pageRect.top - readerContract.scrollRect.top <= 11, "paper must begin immediately below the shared chrome clearance");
  assert(readerContract.scrollHeight > readerContract.scrollClientHeight * 5, "the docked Reader PDF must retain its complete document scroll range");

  await page.mouse.move(readerContract.scrollRect.x + readerContract.scrollRect.width / 2, readerContract.scrollRect.y + readerContract.scrollRect.height / 2);
  await page.mouse.wheel(0, 420);
  await page.waitForFunction(() => document.querySelector("#reader-main .rh-pdf-scroll").scrollTop > 300);
  const readerTrackpad = await page.evaluate(() => ({
    readerTop: document.querySelector("#reader-main").scrollTop,
    pdfTop: document.querySelector("#reader-main .rh-pdf-scroll").scrollTop,
    canvasTop: document.querySelector(".node .rh-pdf-scroll").scrollTop,
    world: document.querySelector("#world").style.transform,
  }));
  assert.equal(readerTrackpad.readerTop, 0, "trackpad reading must not move a hidden outer Reader scroll");
  assert(readerTrackpad.pdfTop > 300, "trackpad reading must scroll the Reader PDF itself");
  assert.equal(readerTrackpad.canvasTop, 0, "Reader scrolling must not mutate the canvas PDF instance");
  assert.equal(readerTrackpad.world, scrollContract.world, "Reader scrolling must not mutate the canvas camera");

  await page.click('#tb-document .rh-pdf-zoom-control[aria-label="Zoom PDF in"]');
  await page.waitForFunction(() => document.querySelector("#tb-document .rh-pdf-zoom-value")?.textContent === "125%");
  assert.equal(await page.locator(".node .rh-pdf-zoom-value").textContent(), "100%", "Reader zoom must remain local to the Reader PDF instance");
  await page.click("#tb-document .rh-pdf-zoom-value");
  await page.click("#t-canvas");
  await page.waitForSelector("body.mode-canvas");
  const restoredCanvas = await page.evaluate(() => ({
    documentChrome: getComputedStyle(document.querySelector("#tb-document")).display,
    canvasToolbarParent: document.querySelector(".node .rh-pdf-toolbar").parentElement.className,
  }));
  assert.equal(restoredCanvas.documentChrome, "none", "Reader PDF controls must disappear completely in Canvas mode");
  assert.match(restoredCanvas.canvasToolbarParent, /\bdoc-content\b/, "Canvas must retain its own in-card PDF toolbar");

  const zoomContinuity = await page.evaluate(async () => {
    const pdfScroll = document.querySelector(".node .rh-pdf-scroll");
    const firstPage = document.querySelector('.node .rh-pdf-page[data-page="1"]');
    const worldBefore = document.querySelector("#world").style.transform;
    const gaps = [], unreadyInsertions = [];
    const titleSpan = [...firstPage.querySelectorAll(".rh-pdf-textlayer span")].find((element) => element.textContent === "Attention Is All You Need");
    let maxGenerations = 0;
    const sample = () => {
      const generations = [...firstPage.querySelectorAll(".rh-pdf-canvas-generation")];
      maxGenerations = Math.max(maxGenerations, generations.length);
      if (!generations.length) gaps.push("no connected generation");
      if (generations.some((generation) => generation.dataset.ready !== "true")) gaps.push("unready generation was paintable");
    };
    sample();
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const added of record.addedNodes) {
        if (added.nodeType === 1 && added.matches?.(".rh-pdf-canvas-generation") && added.dataset.ready !== "true") unreadyInsertions.push("blank overlay inserted");
      }
      sample();
    });
    observer.observe(firstPage.querySelector(".rh-pdf-canvas-layer"), { childList: true });
    for (let index = 0; index < 8; index++) {
      pdfScroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -8, clientX: innerWidth / 2, clientY: innerHeight / 2 }));
      await new Promise((resolve) => requestAnimationFrame(() => { sample(); resolve(); }));
    }
    let settled = false;
    for (let frame = 0; frame < 180; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      sample();
      const generation = firstPage.querySelector(".rh-pdf-canvas-generation");
      if (generation?.dataset.ready === "true" && generation.style.transform === "") { settled = true; break; }
    }
    observer.disconnect();
    return {
      gaps,
      unreadyInsertions,
      settled,
      label: document.querySelector(".node .rh-pdf-zoom-value").textContent,
      maxGenerations,
      titleSpanPreserved: titleSpan === [...firstPage.querySelectorAll(".rh-pdf-textlayer span")].find((element) => element.textContent === "Attention Is All You Need"),
      loadedTextPages: [...document.querySelectorAll(".node .rh-pdf-page")].filter((element) => element.querySelector(".rh-pdf-textlayer span")).length,
      worldBefore,
      worldAfter: document.querySelector("#world").style.transform,
    };
  });
  assert.deepEqual(zoomContinuity.gaps, [], `rapid zoom must keep readable pixels connected: ${JSON.stringify(zoomContinuity)}`);
  assert.deepEqual(zoomContinuity.unreadyInsertions, [], "a blank PDF canvas must never be inserted above the readable generation");
  assert.equal(zoomContinuity.settled, true, "the source-resolution replacement must finish after rapid zoom");
  assert.equal(zoomContinuity.maxGenerations, 1, "rapid zoom must keep exactly one paintable canvas generation connected");
  assert.equal(zoomContinuity.titleSpanPreserved, true, "zoom must reproject existing PDF text spans instead of rebuilding the text DOM");
  assert(zoomContinuity.loadedTextPages <= 4, `initial rendering must stay lazy instead of parsing text layers for all ${ATTENTION_PDF_PAGE_COUNT} pages: ${zoomContinuity.loadedTextPages}`);
  assert.equal(zoomContinuity.label, "190%", "trackpad pinch events must change only the local PDF zoom");
  assert.equal(zoomContinuity.worldAfter, zoomContinuity.worldBefore, "PDF pinch zoom must leave the canvas camera untouched");

  await setPdfZoom(page, 5);
  const tiledScroll = await page.evaluate(async () => {
    const scroll = document.querySelector(".node .rh-pdf-scroll");
    const firstPage = document.querySelector('.node .rh-pdf-page[data-page="1"]');
    for (let frame = 0; frame < 240; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const generation = firstPage.querySelector(".rh-pdf-canvas-generation[data-ready='true']");
      if (generation?.querySelectorAll("canvas[data-tile]").length > 1 && generation.style.transform === "") break;
    }
    const generation = firstPage.querySelector(".rh-pdf-canvas-generation[data-ready='true']");
    const before = [...generation.querySelectorAll("canvas[data-tile]")];
    const beforeKeys = before.map((canvas) => canvas.dataset.tile).join(";");
    scroll.scrollTop = Math.min(firstPage.offsetHeight - scroll.clientHeight, Math.max(900, scroll.scrollTop + 900));
    scroll.dispatchEvent(new Event("scroll"));
    for (let frame = 0; frame < 240; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const keys = [...generation.querySelectorAll("canvas[data-tile]")].map((canvas) => canvas.dataset.tile).join(";");
      if (keys !== beforeKeys) break;
    }
    const after = [...generation.querySelectorAll("canvas[data-tile]")];
    return {
      generationReused: generation === firstPage.querySelector(".rh-pdf-canvas-generation[data-ready='true']"),
      overlappingTilesReused: before.some((canvas) => after.includes(canvas)),
      canvasCount: after.length,
      canvasPixels: after.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
    };
  });
  assert.equal(tiledScroll.generationReused, true, "high-zoom scrolling must retain the active generation instead of rerendering the whole viewport");
  assert.equal(tiledScroll.overlappingTilesReused, true, "high-zoom scrolling must reuse overlapping source-rendered tiles");
  assert(tiledScroll.canvasPixels <= 40 * 1024 * 1024, `high-zoom GPU backing stores must stay bounded below 40 MP: ${JSON.stringify(tiledScroll)}`);

  await setPdfZoom(page, 1);
  const tapRect = await nativeRangeRect(page, "Attention Is All You Need", 0, 9);
  await page.mouse.click(tapRect.x + tapRect.width / 2, tapRect.y + tapRect.height / 2);
  await page.waitForTimeout(100);
  const singleClick = await page.evaluate(() => ({ ask: document.querySelector("#ask").classList.contains("visible"), collapsed: getSelection().isCollapsed }));
  assert.deepEqual(singleClick, { ask: false, collapsed: true }, "one click must place no selection and open no ask surface");

  const pointerSpan = page.locator('.node .rh-pdf-page[data-page="1"] .rh-pdf-textlayer span').filter({ hasText: /^Attention Is All You Need$/ });
  const pointerSpanCount = await pointerSpan.count();
  assert.equal(pointerSpanCount, 1, "the source text layer must contain one title item, not duplicate race output");
  const pointerDrag = await nativeRangeRect(page, "Attention Is All You Need", 0, 9);
  const pointerY = pointerDrag.y + pointerDrag.height / 2;
  await page.mouse.move(pointerDrag.x + 0.5, pointerY);
  await page.mouse.down();
  await page.mouse.move(pointerDrag.x + pointerDrag.width - 0.25, pointerY, { steps: 12 });
  await page.mouse.up();
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Real pointer target");
  await page.click("#ask-go");
  await page.waitForFunction(() => document.querySelectorAll(".node .rh-pdf-mark.mark-ready").length >= 1);
  const pointerState = await portableState(page);
  const pointerChild = pointerState.hole.nodes.find((node) => node.origin?.question === "Real pointer target");
  assert.equal(await page.locator("#tb-document .rh-pdf-convert").count(), 0, "creating a branch in Canvas must retire the hidden Reader conversion action too");
  assert.equal(pointerChild.origin.selected_text, "Attention", "a real mouse drag must select the exact intended word in the paper title");
  const pointerBounds = quadBounds(pointerChild.origin.anchor.pdf.fragments[0].quads[0]);
  assert(Math.abs(pointerBounds[0] - 211.488) <= 0.5 && Math.abs(pointerBounds[2] - 281.296447) <= 0.5, `real pointer selection must map to Poppler's independent title-word bounds: ${pointerBounds}`);

  const zooms = [0.5, 1, 2.5];
  const anchors = [];
  for (const zoom of zooms) {
    await setPdfZoom(page, zoom);
    const question = `Attention title at ${zoom}x`;
    await selectAndAsk(page, "Attention Is All You Need", 0, 9, question);
    const state = await portableState(page);
    const child = state.hole.nodes.find((node) => node.origin?.question === question);
    assert(child, `selection branch at ${zoom}x must persist`);
    anchors.push(child.origin.anchor.pdf);
    const alignment = await selectionMarkAlignment(page, child.id, "Attention Is All You Need", 0, 9);
    assert(alignment.horizontalEdgeError <= 0.75, `highlight horizontal edges must match the native selection at ${zoom}x: ${JSON.stringify(alignment)}`);
  }

  for (const anchor of anchors) {
    assert.equal(anchor.version, 2);
    assert.equal(anchor.kind, "text");
    assert.equal(anchor.source_sha256, root.extensions.pdf.source.sha256);
    assert.equal(anchor.fragments[0].page, 1);
    const bounds = quadBounds(anchor.fragments[0].quads[0]);
    assert(Math.abs(bounds[0] - 211.488) <= 0.35, `title selection must begin at Poppler x=211.488, got ${bounds[0]}`);
    assert(Math.abs(bounds[2] - 281.296447) <= 0.35, `title selection must end at Poppler x=281.296447, got ${bounds[2]}`);
    assert(Math.abs(bounds[1] - 626.359) <= 0.06, `title selection bottom must match the embedded font descent / Poppler y=626.359, got ${bounds[1]}`);
    assert(Math.abs(bounds[3] - 641.834) <= 0.06, `title selection top must match the embedded font ascent / Poppler y=641.834, got ${bounds[3]}`);
  }
  assertQuadsNear(anchors[0].fragments[0].quads[0], anchors[1].fragments[0].quads[0], 0.02, "50% and 100% text coordinates");
  assertQuadsNear(anchors[1].fragments[0].quads[0], anchors[2].fragments[0].quads[0], 0.02, "100% and 250% text coordinates");

  await setPdfZoom(page, 1.75);
  await selectAcrossAndAsk(page, {
    firstText: "The dominant sequence transduction models are based on complex recurrent or",
    firstOffset: 4,
    lastText: "convolutional neural networks that include an encoder and a decoder. The best",
    lastOffset: 13,
    question: "Exact multi-line abstract selection",
  });
  const multiState = await portableState(page);
  const multi = multiState.hole.nodes.find((node) => node.origin?.question === "Exact multi-line abstract selection");
  assert.match(multi.origin.selected_text, /^dominant sequence transduction/);
  assert.match(multi.origin.selected_text, /convolutional$/);
  assert.equal(multi.origin.anchor.pdf.fragments.length, 1);
  assert.equal(multi.origin.anchor.pdf.fragments[0].page, 1);
  assert.equal(multi.origin.anchor.pdf.fragments[0].quads.length, 2, "a two-line native selection must persist one PDF quad per text line");
  const firstLineBounds = quadBounds(multi.origin.anchor.pdf.fragments[0].quads[0]);
  const secondLineBounds = quadBounds(multi.origin.anchor.pdf.fragments[0].quads[1]);
  assert(Math.abs(firstLineBounds[0] - 162.163351) <= 0.45, `multi-line start must match Poppler x=162.163351, got ${firstLineBounds[0]}`);
  assert(Math.abs(firstLineBounds[2] - 468.299304) <= 0.45, `first line must end at Poppler x=468.299304, got ${firstLineBounds[2]}`);
  assert(Math.abs(secondLineBounds[0] - 143.866) <= 0.45, `second line must start at Poppler x=143.866, got ${secondLineBounds[0]}`);
  assert(Math.abs(secondLineBounds[2] - 199.156637) <= 0.45, `second line must end after “convolutional” at Poppler x=199.156637, got ${secondLineBounds[2]}`);
  assert(Math.abs(firstLineBounds[1] - 368.883078) <= 0.08 && Math.abs(firstLineBounds[3] - 377.789643) <= 0.08, `first abstract line must match Poppler's glyph-height bounds: ${firstLineBounds}`);
  assert(Math.abs(secondLineBounds[1] - 357.974078) <= 0.08 && Math.abs(secondLineBounds[3] - 366.880643) <= 0.08, `second abstract line must match Poppler's glyph-height bounds: ${secondLineBounds}`);
  const multiAlignment = await multiSelectionMarkAlignment(page, multi.id, [
    { text: "The dominant sequence transduction models are based on complex recurrent or", start: 4, end: 75 },
    { text: "convolutional neural networks that include an encoder and a decoder. The best", start: 0, end: 13 },
  ]);
  assert(multiAlignment.horizontalEdgeError <= 0.75, `every persisted abstract-line quad must match the native selection horizontally (error ${multiAlignment.horizontalEdgeError}px)`);

  await setPdfZoom(page, 1.3);
  const desiredBounds = [108, 486, 504, 735];
  await page.locator('.node .rh-pdf-box-toggle').evaluate((element) => element.click());
  await drawPdfBounds(page, 4, desiredBounds);
  await page.waitForSelector("#ask.visible");
  await page.locator('.node .rh-pdf-zoom-control[aria-label="Zoom PDF in"]').evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 91, pointerType: "mouse", button: 0, buttons: 1 }));
    element.click();
  });
  await page.waitForFunction(() => Math.abs(Number(document.querySelector(".node .rh-pdf-scroll")?.dataset.zoom) - 1.625) < 0.0001);
  const toolbarZoomPending = await pendingRegionBounds(page);
  assert.equal(toolbarZoomPending.askVisible, true, "PDF zoom controls must not dismiss an uncommitted region");
  for (let index = 0; index < 4; index++) assert(Math.abs(toolbarZoomPending.bounds[index] - desiredBounds[index]) <= 0.35, `pending CropBox coordinate ${index} drifted after toolbar zoom: ${toolbarZoomPending.bounds[index]} vs ${desiredBounds[index]}`);
  for (const pendingZoom of [2.4, 0.65, 1.3]) {
    await wheelPdfZoom(page, pendingZoom);
    const pending = await pendingRegionBounds(page);
    assert.equal(pending.askVisible, true, `pending region ask must survive PDF zoom at ${pendingZoom}x`);
    for (let index = 0; index < 4; index++) assert(Math.abs(pending.bounds[index] - desiredBounds[index]) <= 0.35, `pending CropBox coordinate ${index} drifted at ${pendingZoom}x: ${pending.bounds[index]} vs ${desiredBounds[index]}`);
  }
  await page.fill("#ask-text", "Crop box exact region");
  await page.click("#ask-go");
  await page.waitForFunction(() => document.querySelectorAll(".node .rh-pdf-mark.mark-ready").length >= 6);
  const regionState = await portableState(page);
  const region = regionState.hole.nodes.find((node) => node.origin?.question === "Crop box exact region");
  const regionAnchor = region.origin.anchor.pdf;
  assert.equal(regionAnchor.kind, "region");
  assert.equal(regionAnchor.fragments[0].page, 4);
  const actualBounds = quadBounds(regionAnchor.fragments[0].quads[0]);
  for (let i = 0; i < 4; i++) assert(Math.abs(actualBounds[i] - desiredBounds[i]) <= 0.35, `CropBox coordinate ${i} drifted: ${actualBounds[i]} vs ${desiredBounds[i]}`);
  assert.deepEqual(Object.keys(regionState.assets), [root.extensions.pdf.source.asset], "selections and regions must never add persistent crop assets");

  const regionRequest = answerBodies.find((body) => JSON.stringify(body.messages).includes("Crop box exact region"));
  const dataUrl = regionRequest?.messages?.at(-1)?.content?.find((part) => part.type === "image_url")?.image_url?.url;
  assert.match(dataUrl || "", /^data:image\/png;base64,/);
  const dimensions = pngDimensions(Buffer.from(dataUrl.split(",", 2)[1], "base64"));
  assert(dimensions.width >= 1749 && dimensions.width <= 1751, `Figure 2 crop must render its exact 420-point padded width at 300dpi: ${JSON.stringify(dimensions)}`);
  assert(dimensions.height >= 1137 && dimensions.height <= 1139, `Figure 2 crop must render its exact 273-point padded height at 300dpi: ${JSON.stringify(dimensions)}`);
  assert(Math.abs(dimensions.width / dimensions.height - 420 / 273) < 0.003, `crop dimensions must preserve the exact paper-space box plus 12-point padding: ${JSON.stringify(dimensions)}`);

  assert.deepEqual(pageErrors, [], `browser emitted PDF runtime errors:\n${pageErrors.join("\n")}`);
  console.log("ok PDF precision/performance (Attention paper): native trackpad scrolling, inert single-click and exact drag selection, flicker-free local zoom, stable text DOM, bounded reusable tiles, zoom-invariant pending regions and Poppler coordinates, multi-line quads, exact Figure 2 crop, and source fidelity");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function setPdfZoom(page, zoom) {
  await page.locator(".node .rh-pdf-zoom-value").evaluate((element) => element.click());
  await page.waitForFunction(() => document.querySelector(".node .rh-pdf-zoom-value")?.textContent === "100%");
  if (zoom !== 1) await page.evaluate((target) => {
    const scroll = document.querySelector(".node .rh-pdf-scroll");
    scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(target) * 100 }));
  }, zoom);
  await page.waitForFunction((label) => document.querySelector(".node .rh-pdf-zoom-value")?.textContent === label, `${Math.round(zoom * 100)}%`);
  await page.waitForFunction((target) => Math.abs(Number(document.querySelector(".node .rh-pdf-scroll")?.dataset.zoom) - target) < 0.0001, zoom);
}

async function wheelPdfZoom(page, zoom) {
  await page.evaluate((target) => {
    const scroll = document.querySelector(".node .rh-pdf-scroll");
    const current = Number(scroll.dataset.zoom || 1);
    const rect = scroll.getBoundingClientRect();
    scroll.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -Math.log(target / current) * 100,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  }, zoom);
  await page.waitForFunction((target) => Math.abs(Number(document.querySelector(".node .rh-pdf-scroll")?.dataset.zoom) - target) < 0.0001, zoom);
}

async function pendingRegionBounds(page) {
  return page.evaluate(() => {
    const draft = document.querySelector(".node .rh-pdf-box-draft.settled");
    const pdfPage = draft?.closest(".rh-pdf-page");
    if (!draft || !pdfPage?._pdfViewport) throw new Error("Pending PDF region is missing");
    const viewport = pdfPage._pdfViewport, pageRect = pdfPage.getBoundingClientRect(), draftRect = draft.getBoundingClientRect();
    const toPdf = (clientX, clientY) => viewport.convertToPdfPoint(
      (clientX - pageRect.left) * viewport.width / pageRect.width,
      (clientY - pageRect.top) * viewport.height / pageRect.height,
    );
    const points = [toPdf(draftRect.left, draftRect.top), toPdf(draftRect.right, draftRect.top), toPdf(draftRect.right, draftRect.bottom), toPdf(draftRect.left, draftRect.bottom)];
    const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
    return { askVisible: document.querySelector("#ask").classList.contains("visible"), bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
}

async function selectAndAsk(page, itemText, start, end, question) {
  const picked = await page.evaluate(({ itemText, start, end }) => {
    const span = [...document.querySelectorAll(".node .rh-pdf-textlayer span")].find((element) => element.textContent === itemText);
    if (!span?.firstChild) throw new Error(`Text item not found: ${itemText}`);
    span.scrollIntoView({ block: "center", inline: "center" });
    const range = document.createRange(); range.setStart(span.firstChild, start); range.setEnd(span.firstChild, end);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const value = selection.toString(); span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return value;
  }, { itemText, start, end });
  assert.equal(picked, itemText.slice(start, end));
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", question);
  const expected = await page.locator(".node").count() + 1;
  await page.click("#ask-go");
  await page.waitForFunction((count) => document.querySelectorAll(".node").length >= count, expected);
  await page.waitForFunction((count) => document.querySelectorAll(".node .rh-pdf-mark.mark-ready").length >= count, expected - 1);
}

async function selectAcrossAndAsk(page, { firstText, firstOffset, lastText, lastOffset, question }) {
  const picked = await page.evaluate(({ firstText, firstOffset, lastText, lastOffset }) => {
    const spans = [...document.querySelectorAll(".node .rh-pdf-textlayer span")];
    const first = spans.find((element) => element.textContent === firstText);
    const last = spans.find((element) => element.textContent === lastText);
    if (!first?.firstChild || !last?.firstChild) throw new Error("Multi-line PDF text items were not found");
    first.scrollIntoView({ block: "center", inline: "center" });
    const range = document.createRange();
    range.setStart(first.firstChild, firstOffset);
    range.setEnd(last.firstChild, lastOffset);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const value = selection.toString().trim();
    last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return value;
  }, { firstText, firstOffset, lastText, lastOffset });
  assert.match(picked, /^dominant sequence transduction/);
  assert.match(picked, /convolutional$/);
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", question);
  const expected = await page.locator(".node").count() + 1;
  await page.click("#ask-go");
  await page.waitForFunction((count) => document.querySelectorAll(".node").length >= count, expected);
  await page.waitForFunction((count) => document.querySelectorAll(".node .rh-pdf-mark.mark-ready").length >= count, expected - 1);
}

async function portableState(page) {
  return page.evaluate(() => window.__rabbitholeTest.exportPortable());
}

async function selectionMarkAlignment(page, childId, itemText, start, end) {
  return page.evaluate(({ childId, itemText, start, end }) => {
    const span = [...document.querySelectorAll(".node .rh-pdf-textlayer span")].find((element) => element.textContent === itemText);
    const range = document.createRange(); range.setStart(span.firstChild, start); range.setEnd(span.firstChild, end);
    const selected = range.getBoundingClientRect();
    const marked = document.querySelector(`.node [data-child="${childId}"] polygon`).getBoundingClientRect();
    const horizontal = [Math.abs(selected.left - marked.left), Math.abs(selected.right - marked.right)];
    const vertical = [Math.abs(selected.top - marked.top), Math.abs(selected.bottom - marked.bottom)];
    return { horizontalEdgeError: Math.max(...horizontal), verticalInkAdjustment: Math.max(...vertical), selected: { x: selected.x, y: selected.y, width: selected.width, height: selected.height }, marked: { x: marked.x, y: marked.y, width: marked.width, height: marked.height } };
  }, { childId, itemText, start, end });
}

async function nativeRangeRect(page, itemText, start, end) {
  return page.evaluate(({ itemText, start, end }) => {
    const span = [...document.querySelectorAll(".node .rh-pdf-textlayer span")].find((element) => element.textContent === itemText);
    if (!span?.firstChild) throw new Error(`Text item not found: ${itemText}`);
    span.scrollIntoView({ block: "center", inline: "center" });
    const range = document.createRange(); range.setStart(span.firstChild, start); range.setEnd(span.firstChild, end);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, { itemText, start, end });
}

async function multiSelectionMarkAlignment(page, childId, selections) {
  return page.evaluate(({ childId, selections }) => {
    const spans = [...document.querySelectorAll(".node .rh-pdf-textlayer span")];
    const expected = selections.map(({ text, start, end }) => {
      const span = spans.find((element) => element.textContent === text);
      const range = document.createRange(); range.setStart(span.firstChild, start); range.setEnd(span.firstChild, end);
      return range.getBoundingClientRect();
    });
    const marked = [...document.querySelectorAll(`.node [data-child="${childId}"] polygon`)].map((polygon) => polygon.getBoundingClientRect());
    if (marked.length !== expected.length) throw new Error(`Expected ${expected.length} polygons, found ${marked.length}`);
    const horizontal = expected.flatMap((selected, index) => {
      const mark = marked[index];
      return [Math.abs(selected.left - mark.left), Math.abs(selected.right - mark.right)];
    });
    return { horizontalEdgeError: Math.max(...horizontal), polygonCount: marked.length };
  }, { childId, selections });
}

async function drawPdfBounds(page, pageNumber, [x0, y0, x1, y1]) {
  await page.locator(`.node .rh-pdf-page[data-page="${pageNumber}"]`).scrollIntoViewIfNeeded();
  await page.waitForFunction((number) => !!document.querySelector(`.node .rh-pdf-page[data-page="${number}"]`)?._pdfViewport, pageNumber);
  return page.evaluate(({ pageNumber, x0, y0, x1, y1 }) => {
    const element = document.querySelector(`.node .rh-pdf-page[data-page="${pageNumber}"]`);
    const viewport = element._pdfViewport, rect = element.getBoundingClientRect();
    const toClient = ([x, y]) => ({ x: rect.left + x * rect.width / viewport.width, y: rect.top + y * rect.height / viewport.height });
    const start = toClient(viewport.convertToViewportPoint(x0, y1)), end = toClient(viewport.convertToViewportPoint(x1, y0));
    const init = (type, point, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 77, pointerType: "mouse", button: 0, buttons, clientX: point.x, clientY: point.y });
    const capture = element.setPointerCapture; element.setPointerCapture = () => {};
    element.dispatchEvent(init("pointerdown", start, 1));
    element.dispatchEvent(init("pointermove", end, 1));
    element.dispatchEvent(init("pointerup", end, 0));
    element.setPointerCapture = capture;
  }, { pageNumber, x0, y0, x1, y1 });
}

function quadBounds(quad) {
  const xs = quad.map((point) => point[0]), ys = quad.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function assertQuadsNear(left, right, tolerance, label) {
  for (let i = 0; i < left.length; i++) for (let j = 0; j < 2; j++) {
    assert(Math.abs(left[i][j] - right[i][j]) <= tolerance, `${label} differ at point ${i}, coordinate ${j}: ${left[i][j]} vs ${right[i][j]}`);
  }
}

function pngDimensions(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function dropPdf(page, bytes) {
  await page.evaluate((base64) => {
    const binary = atob(base64), values = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) values[index] = binary.charCodeAt(index);
    const file = new File([values], "attention-is-all-you-need.pdf", { type: "application/pdf" });
    const data = new DataTransfer(); data.items.add(file);
    document.querySelector("#composer-card").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, Buffer.from(bytes).toString("base64"));
}
