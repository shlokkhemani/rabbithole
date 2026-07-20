import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { NEWER_SCHEMA_MESSAGE } from "../../src/core/schema.js";
import { ensureWebDist } from "../support/build.mjs";
import { serveStatic } from "../support/static-server.mjs";
import { corsHeaders, sse } from "../support/provider-mock.mjs";
import { ATTENTION_PDF_PAGE_COUNT, ATTENTION_PDF_SHA256, readAttentionPdf, readAttentionPdfTwoPage } from "../support/attention-pdf.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");

try {
  await fs.access(path.join(WEB_DIST, "index.html"));
} catch {
  try { ensureWebDist(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}

let proxyCalls = 0;
const server = await serveStatic(WEB_DIST, { spaFallback: true, routes: {
  "/proxy": (_req, res) => { proxyCalls += 1; res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }); res.end(articleHtml("Proxy fallback article")); },
  "/dead-proxy": (_req, res) => { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end("proxy unavailable"); },
  "/reject-proxy": (_req, res) => { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end("Host is not allowlisted: arxiv.org"); },
} });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript(() => localStorage.setItem("rh-web-settings", JSON.stringify({
  preset: "custom",
  base_url: "http://localhost:11434/v1",
  model: "llama3.2",
  transcribe_model: "llama3.2-vision",
  session_only: true,
  generation_setup: { version: 1, preset: "custom", base_url: "http://localhost:11434/v1", model: "llama3.2" },
})));
const page = await context.newPage();
page.on("pageerror", (error) => process.stderr.write(`browser page error: ${error.stack || error.message}\n`));
const requests = [];
let directArticleCalls = 0;
const answerBodies = [];

page.on("request", (request) => {
  requests.push(request.url());
});

await page.route(/https:\/\/ar5iv\.labs\.arxiv\.org\/html\/.+/, async (route) => {
  directArticleCalls += 1;
  await route.abort("failed");
});

// Opening settings warms the OpenRouter model catalog; keep this test offline.
await page.route("https://openrouter.ai/api/v1/models", async (route) => {
  await route.fulfill({
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ data: [
      { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" } },
    ] }),
  });
});
const transcribeBodies = [];
let transcribeMode = "stream";
let localVisionAvailable = true;
let holdNextAnswer = false;
let releaseHeldAnswer = null;
let rejectNextInheritedImage = false;
await page.route("http://localhost:11434/v1/models", (route) => route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: [{ id: "llama3.2" }, { id: "llama3.2-vision" }] }) }));
await page.route("http://localhost:11434/api/show", (route) => {
  const model = route.request().postDataJSON()?.model || "";
  return route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ capabilities: localVisionAvailable && model === "llama3.2-vision" ? ["completion", "vision"] : ["completion"] }) });
});
await page.route("http://localhost:11434/v1/chat/completions", async (route) => {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
  const body = route.request().postDataJSON();
  if (JSON.stringify(body.messages).includes("Transcribe the supplied PDF page images")) {
    transcribeBodies.push(body);
    if (transcribeMode === "hang") return; // held open — cancel aborts client-side
    return route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "text/event-stream" }, body: sse([
      "# Converted Doc\n\nClean text section one.\n\n",
      "![Attention diagram](figure:page-002:0.1,0.1,0.8,0.5)\n\nTail text.",
    ]) });
  }
  answerBodies.push(body);
  if (answerBodies.length === 1) return route.fulfill({ status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ error: { message: "model does not support images" } }) });
  if (rejectNextInheritedImage && Array.isArray(body.messages?.at(-1)?.content)) {
    rejectNextInheritedImage = false;
    return route.fulfill({ status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ error: { message: "inherited image unsupported" } }) });
  }
  if (holdNextAnswer) {
    holdNextAnswer = false;
    await new Promise((resolve) => { releaseHeldAnswer = resolve; });
    releaseHeldAnswer = null;
  }
  await route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "text/event-stream" }, body: sse(["# PDF branch\n\n", "Streamed from selected prose."]) });
});

try {
  await gotoReadyApp(page, baseUrl);
  await page.click("#blank-start-new");
  await page.waitForSelector("#composer-path-file");

  requests.length = 0;
  const pdfBytes = await readAttentionPdf();
  await dropPdf(page, pdfBytes, "AtTeNtIoN-Is-AlL-YoU-NeEd.PdF", "");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".node .rh-pdf-canvas-generation canvas");
    return !!canvas && canvas.width > 0 && canvas.height > 0;
  });

  const externalDuringPdf = requests.filter((url) => !url.startsWith(baseUrl) && !url.startsWith("blob:") && !url.startsWith("http://localhost:11434/"));
  assert.deepEqual(externalDuringPdf, [], `PDF ingest made external request(s): ${externalDuringPdf.join(", ")}`);
  assert.equal(answerBodies.length, 0, "PDF import may inspect local model capabilities but must not invoke model inference");

  const pdfState = await page.evaluate(async () => {
    const holeId = window.__rabbitholeTest.currentHoleId();
    const { names: assets, sizes } = await window.__rabbitholeTest.inspectAssets(holeId);
    const raw = await window.__rabbitholeTest.readStoredHole(holeId);
    const root = raw.nodes.find((node) => !node.parent_id);
    const canvas = document.querySelector(".node .rh-pdf-canvas-generation canvas");
    const rect = canvas.getBoundingClientRect();
    return { assets, sizes, root, backingRatio: canvas.width / rect.width, raw: JSON.stringify(raw) };
  });
  assert.equal(pdfState.assets.length, 1, "PDF import must persist exactly one source asset");
  assert.match(pdfState.assets[0], /^pdf-[a-f0-9]{64}\.pdf$/);
  assert.equal(pdfState.sizes[pdfState.assets[0]], pdfBytes.length, "stored source must be byte-identical in size");
  assert.equal(pdfState.root.extensions.pdf.version, 2);
  assert.equal(pdfState.root.extensions.pdf.page_count, ATTENTION_PDF_PAGE_COUNT);
  assert.equal(pdfState.root.extensions.pdf.source.sha256, ATTENTION_PDF_SHA256);
  assert.equal(pdfState.root.extensions.pdf.source.asset, pdfState.assets[0]);
  assert.equal(pdfState.root.extensions.pdf.pages.some((entry) => "asset" in entry), false, "page metadata must not point at raster assets");
  assert(pdfState.backingRatio >= 0.95, `page backing store must match effective on-screen pixels: ${pdfState.backingRatio}`);
  assert(pdfState.raw.includes("Attention Is All You Need"));
  assert(pdfState.raw.includes("The dominant sequence transduction models"));

  const localZoomBefore = await page.evaluate(() => ({
    world: document.querySelector("#world").style.transform,
    width: document.querySelector(".node .rh-pdf-page").getBoundingClientRect().width,
    label: document.querySelector(".node .rh-pdf-zoom-value").textContent,
  }));
  await page.locator(".node .rh-pdf-scroll").hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.waitForFunction((label) => document.querySelector(".node .rh-pdf-zoom-value")?.textContent !== label, localZoomBefore.label);
  const localZoom = { before: localZoomBefore, after: await page.evaluate(() => ({
    world: document.querySelector("#world").style.transform,
    width: document.querySelector(".node .rh-pdf-page").getBoundingClientRect().width,
    label: document.querySelector(".node .rh-pdf-zoom-value").textContent,
  })) };
  assert.equal(localZoom.after.world, localZoom.before.world, "Ctrl+wheel over a PDF must never zoom the canvas camera");
  assert.notEqual(localZoom.after.label, localZoom.before.label, "Ctrl+wheel must update local PDF zoom");
  assert(localZoom.after.width > localZoom.before.width, "local PDF zoom must enlarge the source-rendered page");
  await page.click(".node .rh-pdf-zoom-value");
  const selected = await page.evaluate(() => {
    const span = [...document.querySelectorAll(".node .rh-pdf-textlayer span")].find((el) => el.textContent === "Attention Is All You Need");
    const text = span.firstChild, range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, "Attention".length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const picked = selection.toString(); // the ask box focuses on open, collapsing the native selection
    span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return picked;
  });
  assert.equal(selected, "Attention");
  await page.waitForSelector("#ask.visible");
  await page.click('#ask-lenses .lens[data-lens="explain"]');
  const mark = page.locator(".node .rh-pdf-mark.mark-ready").first();
  await mark.waitFor();
  assert.equal(await page.locator(".node .rh-pdf-convert").count(), 0, "creating the first branch should immediately remove the text-version action");
  assert.equal(answerBodies.length, 2, "vision rejection should trigger exactly one text-only retry");
  assert(Array.isArray(answerBodies[0].messages.at(-1).content), "paper text selection should ship multimodal content parts");
  assert.equal(answerBodies[0].messages.at(-1).content[1].type, "image_url");
  assert.match(answerBodies[0].messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(typeof answerBodies[1].messages.at(-1).content, "string", "fallback attempt must be text-only");
  assert.equal(await mark.getAttribute("role"), "link");
  assert.equal(await mark.getAttribute("tabindex"), "0");
  assert.equal(await page.locator("#edges path").count() > 0, true, "PDF branch should retain an anchored canvas edge");
  const firstClip = await page.evaluate(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    const node = hole.nodes.find((entry) => entry.parent_id);
    return { id: node.id, anchor: node.origin?.anchor, cropAsset: node.origin?.crop_asset, markdown: node.markdown };
  });
  assert.equal(firstClip.anchor.pdf.version, 2);
  assert.equal(firstClip.anchor.pdf.kind, "text");
  assert.equal(firstClip.anchor.pdf.fragments[0].page, 1);
  assert.equal(firstClip.anchor.pdf.source_sha256, pdfState.root.extensions.pdf.source.sha256);
  assert(firstClip.anchor.pdf.fragments[0].quads[0].every((point) => point.every(Number.isFinite)));
  assert.equal(firstClip.cropAsset, undefined, "v2 provenance stores coordinates, never a crop image");
  assert.equal(firstClip.markdown.includes("asset:"), false, "clip provenance must not enter the answer body");

  const boxToggle = page.locator(".node .rh-pdf-box-toggle").first();
  assert.equal(await boxToggle.textContent(), "Ask about an area");
  assert.equal(await boxToggle.getAttribute("aria-label"), "Ask about an area of the PDF");
  await boxToggle.click();
  await page.waitForSelector(".node .rh-pdf.rh-pdf-box-mode");
  assert.equal(await boxToggle.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".node .rh-pdf.rh-pdf-box-mode"));
  assert.equal(await boxToggle.getAttribute("aria-pressed"), "false", "Escape must exit region-select mode");
  await boxToggle.click();
  const secondPage = page.locator(".node .rh-pdf-page[data-page='2']").first();
  await secondPage.scrollIntoViewIfNeeded();
  const pageBox = await secondPage.boundingBox();
  await page.mouse.move(pageBox.x + pageBox.width * .05, pageBox.y + pageBox.height * .65);
  await page.mouse.down();
  await page.mouse.move(pageBox.x + pageBox.width * .95, pageBox.y + pageBox.height * .9);
  await page.mouse.up();
  await page.waitForSelector("#ask.visible");
  holdNextAnswer = true;
  await page.click('#ask-lenses .lens[data-lens="explain"]');
  await page.waitForFunction(() => document.querySelectorAll(".node").length >= 3);
  const pendingBoxClip = await page.evaluate(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    const node = hole.nodes.filter((entry) => entry.parent_id).at(-1);
    const card = document.querySelector(`.node[data-id="${node.id}"]`);
    return {
      id: node.id,
      cropAsset: node.origin?.crop_asset,
      pending: !!card?.querySelector(".loading, .stream-status"),
    };
  });
  assert.equal(pendingBoxClip.cropAsset, undefined, "pending v2 branches must remain coordinate-only");
  assert.equal(pendingBoxClip.pending, true, "provider response should still be held while the clip is visible");
  for (let i = 0; i < 100 && !releaseHeldAnswer; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(releaseHeldAnswer, "box answer route should be held for the pending-origin assertion");
  releaseHeldAnswer();
  await page.waitForFunction(() => document.querySelectorAll(".node .rh-pdf-mark.mark-ready").length >= 2);
  await page.waitForFunction(() => document.querySelectorAll(".rh-pdf-box-draft").length === 0, undefined, { timeout: 5000 });
  assert.equal(answerBodies.length, 3);
  assert(Array.isArray(answerBodies[2].messages.at(-1).content), "box ask should ship its crop as an image part");
  const boxImageUrl = answerBodies[2].messages.at(-1).content[1].image_url.url;
  assert.match(boxImageUrl, /^data:image\/png;base64,/);
  const boxClip = await page.evaluate(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    const node = hole.nodes.filter((entry) => entry.parent_id).at(-1);
    const portable = await window.__rabbitholeTest.exportPortable();
    return { id: node.id, anchor: node.origin.anchor, cropAsset: node.origin.crop_asset, assetNames: Object.keys(portable.assets), markdown: node.markdown };
  });
  assert.equal(boxClip.id, pendingBoxClip.id);
  assert.equal(boxClip.anchor.pdf.version, 2);
  assert.equal(boxClip.anchor.pdf.kind, "region");
  assert.equal(boxClip.anchor.pdf.fragments[0].page, 2);
  const boxQuad = boxClip.anchor.pdf.fragments[0].quads[0];
  assert(Math.max(...boxQuad.map((point) => point[0])) - Math.min(...boxQuad.map((point) => point[0])) > 300, "drawn box should persist a wide exact PDF-space quad");
  assert.equal(boxClip.cropAsset, undefined);
  assert.deepEqual(boxClip.assetNames, [pdfState.root.extensions.pdf.source.asset], "portable state must contain the source PDF, never interaction crops");
  assert.equal(boxClip.markdown.includes("asset:"), false, "answer markdown must stay clean of crop provenance");

  const boxCard = page.locator(`.node[data-id="${boxClip.id}"]`);
  rejectNextInheritedImage = true;
  await boxCard.locator(".nc-handle").evaluate((el) => el.click());
  await boxCard.locator(".nc-inner textarea").fill("What follows from this clip?");
  await boxCard.locator(".send-btn").evaluate((el) => el.click());
  await page.waitForFunction(() => window.__rabbitholeTest && document.querySelectorAll(".node").length >= 4);
  for (let i = 0; i < 100 && answerBodies.length < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(Array.isArray(answerBodies[3].messages.at(-1).content), "follow-up from a clip card must inherit its image");
  assert.equal(answerBodies[3].messages.at(-1).content[1].image_url.url, boxImageUrl, "follow-ups must re-render the same source region deterministically");
  assert.match(answerBodies[3].messages.at(-1).content[0].text, /^Selection region image: attached/);
  assert.equal(typeof answerBodies[4].messages.at(-1).content, "string", "inherited images must use the same text-only retry path");

  await page.evaluate((clipId) => {
    const dc = document.querySelector(`.node[data-id="${clipId}"] .doc-content`);
    const walker = document.createTreeWalker(dc, NodeFilter.SHOW_TEXT);
    let text; while ((text = walker.nextNode()) && !text.data.includes("Streamed")) {}
    const start = text.data.indexOf("Streamed"), range = document.createRange();
    range.setStart(text, start); range.setEnd(text, start + "Streamed".length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    dc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, boxClip.id);
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "What does this wording mean?");
  await page.click("#ask-go");
  for (let i = 0; i < 100 && answerBodies.length < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(Array.isArray(answerBodies[5].messages.at(-1).content), "text selection from a clip card must inherit its image");
  assert.equal(answerBodies[5].messages.at(-1).content[1].image_url.url, boxImageUrl);

  await boxCard.locator(".node-btn.danger").evaluate((el) => el.click());
  await page.click("#cf-remove");
  await page.waitForFunction((id) => !document.querySelector(`.node[data-id="${id}"]`), boxClip.id);
  assert.deepEqual((await page.evaluate(async () => (await window.__rabbitholeTest.inspectAssets()).names)), [pdfState.root.extensions.pdf.source.asset], "deleting a branch must not delete the source still owned by the PDF root");
  await reloadReadyApp(page);
  await page.waitForSelector(".doc-content.rh-pdf .rh-pdf-page[data-page='2']", { state: "attached" });
  await page.waitForSelector(".rh-pdf-mark.mark-ready", { state: "attached" });

  await gotoReadyApp(page, baseUrl);
  await setFetchProxy(page, `${baseUrl}/proxy`);
  await page.click("#t-new");
  await page.click("#composer-path-url");
  await page.fill("#composer-input", "https://arxiv.org/abs/1234.5678");
  await page.click("#composer-primary");
  await waitForCanvasText(page, "Proxy fallback article");
  assert(directArticleCalls >= 1, "direct ar5iv fetch should be attempted before proxy fallback");
  assert(proxyCalls >= 1, "proxy fallback should be used after direct fetch is blocked");
  const urlHole = await page.evaluate(async () => {
    const raw = await window.__rabbitholeTest.readStoredHole();
    return JSON.stringify(raw);
  });
  assert(urlHole.includes("Proxy fallback article"));
  assert(urlHole.includes("https://arxiv.org/abs/1234.5678") || urlHole.includes("ar5iv.labs.arxiv.org"));

  await gotoReadyApp(page, baseUrl);
  await setFetchProxy(page, `${baseUrl}/dead-proxy`);
  await page.click("#t-new");
  await page.click("#composer-path-url");
  await page.fill("#composer-input", "https://arxiv.org/abs/9999.0000");
  await page.click("#composer-primary");
  await page.waitForSelector("#ingest-status.error");
  const deadError = await page.textContent("#ingest-status");
  assert.match(deadError, /Try another link or open a PDF/i);

  await gotoReadyApp(page, baseUrl);
  await setFetchProxy(page, `${baseUrl}/reject-proxy`);
  await page.click("#t-new");
  await page.click("#composer-path-url");
  await page.fill("#composer-input", "https://arxiv.org/abs/7777.7777");
  await page.click("#composer-primary");
  await page.waitForSelector("#ingest-status.error");
  const rejectError = await page.textContent("#ingest-status");
  assert.match(rejectError, /isn't supported by the link relay yet/i);
  assert.match(rejectError, /arXiv links work best/);

  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "broken.HtMl", mimeType: "", buffer: Buffer.from("not a snapshot") });
  await page.waitForSelector("#ingest-status.error");
  assert.match(await page.textContent("#ingest-status"), /Snapshot import failed/i);

  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "Notes.Md", mimeType: "", buffer: Buffer.from("# Mixed-case markdown\n\nEmpty MIME markdown classified.") });
  await waitForCanvasText(page, "Empty MIME markdown classified.");

  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "evil.html.txt", mimeType: "text/plain", buffer: Buffer.from("evil suffix remains text") });
  await waitForCanvasText(page, "evil suffix remains text");

  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  await page.evaluate(() => {
    const file = new File([new Uint8Array(16 * 1024 * 1024 + 1)], "oversized.md", { type: "text/markdown" });
    const data = new DataTransfer();
    data.items.add(file);
    const input = document.querySelector("#file-md");
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForSelector("#ingest-status.error");
  assert.equal(await page.textContent("#ingest-status"), "Import failed: file exceeds 16 MB.");

  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  const futurePortable = JSON.stringify({
    format: "rabbithole",
    format_version: 1,
    hole: { schema_version: 3, hole_id: "future-web", title: "Future", root_id: "root", created_at: null, updated_at: null, view_state: null, nodes: [] },
    assets: {},
  });
  await page.setInputFiles("#file-md", { name: "future.rabbithole", mimeType: "application/json", buffer: Buffer.from(futurePortable) });
  await page.waitForSelector("#ingest-status.error");
  assert.equal(
    await page.textContent("#ingest-status"),
    NEWER_SCHEMA_MESSAGE,
    "web import should surface the exact newer-version refusal",
  );

  // ---- Text version: full journey, figures land as live assets -------------
  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  const attentionTwoPages = await readAttentionPdfTwoPage();
  await dropPdf(page, attentionTwoPages, "attention-convert.pdf");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  await page.click(".node .rh-pdf-convert");
  await page.waitForFunction(() => {
    const dc = document.querySelector(".node .doc-content:not(.rh-pdf)");
    if (!dc || !dc.textContent.includes("Converted Doc")) return false;
    const img = dc.querySelector("img[alt='Attention diagram']");
    return !!img && img.complete && img.naturalWidth > 0;
  });
  assert(transcribeBodies.length >= 1, "convert must call the transcription model");
  assert.equal(transcribeBodies[0].model, "llama3.2-vision", "conversion must use the confirmed local vision model setting");
  const transcribeParts = transcribeBodies[0].messages[0].content;
  assert(Array.isArray(transcribeParts) && transcribeParts.filter((part) => part.type === "image_url").length === 2, "one image part per page in the batch");
  const convertedState = await page.evaluate(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    const { names } = await window.__rabbitholeTest.inspectAssets(hole.hole_id);
    return { root: hole.nodes.find((node) => !node.parent_id), names };
  });
  assert.equal(convertedState.root.extensions.pdf.converted, true);
  assert.match(convertedState.root.extensions.pdf.original_markdown, /Attention Is All You Need/, "the native paper body must stay stashed");
  assert.equal(convertedState.root.extensions.pdf.pages.length, 2, "the page stash must survive conversion");
  assert.match(convertedState.root.markdown, /!\[Attention diagram\]\(asset:fig-p002-1\.png\)/);
  assert(convertedState.names.includes("fig-p002-1.png"));
  await reloadReadyApp(page);
  await page.waitForFunction(() => {
    const dc = document.querySelector(".node .doc-content:not(.rh-pdf)");
    return !!dc && dc.textContent.includes("Converted Doc");
  });

  // ---- Cancel mid-run restores the native paged view -----------------------
  transcribeMode = "hang";
  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  await dropPdf(page, attentionTwoPages, "attention-cancel.pdf");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  await page.click(".node .rh-pdf-convert");
  await page.waitForSelector(".node .rh-pdf-convert-progress");
  assert.match(await page.textContent(".node .rh-pdf-convert-progress"), /Creating text version/);
  assert((await page.locator(".node .rh-pdf-convert-progress .sk-line").count()) > 0, "converting must show the loading skeleton");
  assert(!(await page.textContent(".node .doc-content")).includes("Attention Is All You Need"), "the raw paper extraction must not render while converting");
  await page.click(".node .rh-pdf-convert-cancel");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='1']");
  const abortedState = await page.evaluate(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    return hole.nodes.find((node) => !node.parent_id);
  });
  assert.equal(abortedState.extensions.pdf.converting, false);
  assert.match(abortedState.markdown, /Attention Is All You Need/, "cancel must keep the native paper body");
  transcribeMode = "stream";

  // ---- Convert is disabled once the document has branches ------------------
  await page.waitForFunction(() => [...document.querySelectorAll(".node .rh-pdf-textlayer span")].some((el) => el.textContent === "Attention Is All You Need"));
  const askSelected = await page.evaluate(() => {
    const span = [...document.querySelectorAll(".node .rh-pdf-textlayer span")].find((el) => el.textContent === "Attention Is All You Need");
    const text = span.firstChild, range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 9);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const picked = selection.toString(); // the ask box focuses on open, collapsing the native selection
    span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return picked;
  });
  assert.equal(askSelected, "Attention");
  await page.waitForSelector("#ask.visible");
  await page.click('#ask-lenses .lens[data-lens="explain"]');
  await page.locator(".node .rh-pdf-mark.mark-ready").first().waitFor();
  await reloadReadyApp(page);
  assert.equal(await page.locator(".node .rh-pdf-convert").count(), 0, "the text-version action must stay absent after reloading a branched PDF");

  // ---- Scanned PDFs surface the convert affordance -------------------------
  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  await dropPdf(page, buildTinyPdf(["", ""]), "scanned.pdf");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  assert.equal(await page.locator(".node .rh-pdf-scanned-note").count(), 0, "a scanned PDF must not add explanatory copy to the control bar");
  assert.equal(await page.locator(".node .rh-pdf-box-toggle").isEnabled(), true, "area selection must remain available for a scanned PDF");
  await page.waitForSelector(".node .rh-pdf-convert.primary:not(:disabled)");
  const scannedBody = await page.evaluate(async () => (await window.__rabbitholeTest.readStoredHole()).nodes[0].markdown);
  assert.match(scannedBody, /\*\(page 1: no extractable text\)\*/, "scanned pages must carry the body marker");

  // ---- No local vision model keeps import available but gates conversion ----
  localVisionAvailable = false;
  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  await dropPdf(page, attentionTwoPages, "attention-no-local-vision.pdf");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='1']");
  await page.waitForSelector(".node .rh-pdf-convert:disabled");
  assert.equal(await page.locator(".node .rh-pdf-transcription-note").count(), 0, "model setup guidance must not displace PDF controls");
  assert.equal(await page.locator(".node .rh-pdf-convert").getAttribute("title"), "Install a local model that supports vision to enable PDF transcription.");

  // ---- A corrupt PDF fails with an actionable message, no stranded hole ----
  await gotoReadyApp(page, baseUrl);
  await page.click("#t-new");
  await dropPdf(page, [...Buffer.from("%PDF-1.4\nthis is not really a pdf")], "corrupt.pdf");
  await page.waitForSelector("#ingest-status.error");
  assert.match(await page.textContent("#ingest-status"), /could not be opened by pdf\.js/i);

  // ---- A temporarily unavailable PDF runtime never blames the file and can retry ----
  const retryContext = await browser.newContext();
  try {
    await retryContext.addInitScript(() => localStorage.setItem("rh-web-settings", JSON.stringify({
      preset: "custom",
      base_url: "http://localhost:11434/v1",
      model: "llama3.2",
      session_only: true,
      generation_setup: { version: 1, preset: "custom", base_url: "http://localhost:11434/v1", model: "llama3.2" },
    })));
    const retryPage = await retryContext.newPage();
    let runtimeRequests = 0;
    await retryPage.route(/\/pdf\.mjs(?:\?.*)?$/, async (route) => {
      runtimeRequests += 1;
      if (runtimeRequests === 1) await route.abort("failed");
      else await route.continue();
    });
    await gotoReadyApp(retryPage, baseUrl);
    await retryPage.click("#blank-start-new");
    await retryPage.waitForSelector("#composer-path-file");
    const retryPdf = buildTinyPdf(["Runtime retry"]);
    await dropPdf(retryPage, retryPdf, "runtime-first-attempt.pdf");
    await retryPage.waitForSelector("#ingest-status.error");
    assert.equal(
      await retryPage.textContent("#ingest-status"),
      "PDF import couldn't start because part of Rabbithole failed to load. Reload Rabbithole and try again — your PDF is not the problem.",
    );
    await dropPdf(retryPage, retryPdf, "runtime-second-attempt.pdf");
    await retryPage.waitForSelector(".node .rh-pdf-page[data-page='1']");
    assert(runtimeRequests >= 2, "retry must use a fresh PDF.js module request after a transient load failure");
  } finally {
    await retryContext.close();
  }

  console.log("web ingestion verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function gotoReadyApp(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForReadyApp(page);
}

async function reloadReadyApp(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForReadyApp(page);
}

async function waitForReadyApp(page) {
  // The app's test seam is installed only after IndexedDB selection, rail
  // hydration, and the initial canvas/blank state have finished. Waiting for
  // this product-specific milestone is deterministic even when an intentionally
  // held model request keeps the browser from ever reaching `networkidle`.
  await page.waitForFunction(() => !!window.__rabbitholeTest
    && document.body.classList.contains("web-app")
    && !!document.getElementById("viewport"));
}

function pdfLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildTinyPdf(pageTexts) {
  const objects = [];
  objects[1] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const kids = pageTexts.map((_text, index) => `${4 + index * 2} 0 R`).join(" ");
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>\nendobj\n`;
  objects[3] = "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  for (let index = 0; index < pageTexts.length; index += 1) {
    const pageObj = 4 + index * 2;
    const contentObj = pageObj + 1;
    const content = `BT /F1 15 Tf 40 160 Td (${pdfLiteral(pageTexts[index])}) Tj ET\n`;
    objects[pageObj] =
      `${pageObj} 0 obj\n` +
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 220] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>\n` +
      "endobj\n";
    objects[contentObj] = `${contentObj} 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`;
  }

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += objects[id];
  }
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return [...Buffer.from(pdf, "latin1")];
}

async function dropPdf(page, bytes, name = "math-fixture.pdf", type = "application/pdf") {
  await page.setInputFiles("#file-md", { name, mimeType: type, buffer: Buffer.from(bytes) });
}

async function setFetchProxy(page, url) {
  await page.evaluate((value) => {
    const settings = JSON.parse(localStorage.getItem("rh-web-settings") || "{}");
    localStorage.setItem("rh-web-settings", JSON.stringify({ ...settings, fetch_proxy_url: value }));
  }, url);
}

async function waitForCanvasText(page, text) {
  await page.locator(".node", { hasText: text }).first().waitFor();
}

function articleHtml(title) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <article>
      <h1>${title}</h1>
      <p>This article came through the mocked proxy fallback for https://arxiv.org/abs/1234.5678.</p>
      <p>It includes enough body text for conservative extraction and a relative image.</p>
      <img src="/html/assets/figure.png" alt="Relative figure">
    </article>
  </body></html>`;
}
