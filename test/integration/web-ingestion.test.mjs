import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { NEWER_SCHEMA_MESSAGE } from "../../src/core/schema.js";
import { ensureWebDist } from "../support/build.mjs";
import { serveStatic } from "../support/static-server.mjs";
import { corsHeaders, sse } from "../support/provider-mock.mjs";

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
  await route.fulfill({ status: 200, headers: { ...corsHeaders(), "Content-Type": "text/event-stream" }, body: sse(["# PDF branch\n\n", "Streamed from selected prose."]) });
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#blank-start-new");
  await page.waitForSelector("#composer-path-file");

  requests.length = 0;
  const pdfBytes = buildTinyPdf([
    "Browser PDF page one: Euler math e^(i*pi)+1=0",
    "Browser PDF page two: Integral int_0^1 x dx = 1/2",
  ]);
  await dropPdf(page, pdfBytes, "MaTh-FiXtUrE.PdF", "");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  await page.waitForFunction(() => {
    const img = document.querySelector(".node .doc-content[data-node-id] img");
    return !!img && img.complete && img.naturalWidth > 0;
  });

  const externalDuringPdf = requests.filter((url) => !url.startsWith(baseUrl) && !url.startsWith("blob:") && !url.startsWith("http://localhost:11434/"));
  assert.deepEqual(externalDuringPdf, [], `PDF ingest made external request(s): ${externalDuringPdf.join(", ")}`);
  assert.equal(answerBodies.length, 0, "PDF import may inspect local model capabilities but must not invoke model inference");

  const pdfState = await page.evaluate(async () => {
    const holeId = window.__rabbitholeTest.currentHoleId();
    const { names: assets, sizes } = await window.__rabbitholeTest.inspectAssets(holeId);
    const raw = await window.__rabbitholeTest.readStoredHole(holeId);
    return { assets, sizes, raw: JSON.stringify(raw) };
  });
  assert.deepEqual(pdfState.assets, ["page-001.jpg", "page-002.jpg"]);
  assert(pdfState.sizes["page-001.jpg"] > 100, "page-001.jpg should be stored as a non-empty Blob");
  assert(!pdfState.raw.includes("asset:page-001.jpg"), "model markdown must not contain page-image refs");
  assert(pdfState.raw.includes('"version":1'));
  assert(pdfState.raw.includes("Browser PDF page one"));
  assert(pdfState.raw.includes("Integral int_0^1"));
  const selected = await page.evaluate(() => {
    const span = [...document.querySelectorAll(".node .rh-pdf-textlayer span")].find((el) => el.textContent.includes("e^(i*pi)+1=0"));
    const text = span.firstChild, start = text.data.indexOf("e^(i*pi)+1=0"), range = document.createRange();
    range.setStart(text, start); range.setEnd(text, start + "e^(i*pi)+1=0".length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const picked = selection.toString(); // the ask box focuses on open, collapsing the native selection
    span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return picked;
  });
  assert.equal(selected, "e^(i*pi)+1=0");
  await page.waitForSelector("#ask.visible");
  await page.click('#ask-lenses .lens[data-lens="explain"]');
  const mark = page.locator(".node .rh-pdf-mark.mark-ready").first();
  await mark.waitFor();
  assert.equal(await page.locator(".node .rh-pdf-convert").count(), 0, "creating the first branch should immediately remove the text-version action");
  assert.equal(answerBodies.length, 2, "vision rejection should trigger exactly one text-only retry");
  assert(Array.isArray(answerBodies[0].messages.at(-1).content), "equation selection should ship multimodal content parts");
  assert.equal(answerBodies[0].messages.at(-1).content[1].type, "image_url");
  assert.match(answerBodies[0].messages.at(-1).content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(typeof answerBodies[1].messages.at(-1).content, "string", "fallback attempt must be text-only");
  assert.equal(await mark.getAttribute("role"), "link");
  assert.equal(await mark.getAttribute("tabindex"), "0");
  assert.equal(await page.locator("#edges path").count() > 0, true, "PDF branch should retain an anchored canvas edge");
  const storedAnchor = await page.evaluate(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    return hole.nodes.find((node) => node.parent_id)?.origin?.anchor;
  });
  assert.equal(storedAnchor.pdf.page, 1);
  assert(storedAnchor.offset_end > storedAnchor.offset_start);
  assert(storedAnchor.pdf.rect.w > 0 && storedAnchor.pdf.rect.h > 0);

  const boxToggle = page.locator(".node .rh-pdf-box-toggle").first();
  assert.equal(await boxToggle.textContent(), "Ask about an area");
  assert.equal(await boxToggle.getAttribute("aria-label"), "Ask about an area of the PDF");
  const pdfToolbar = page.locator(".node .rh-pdf-toolbar").first();
  await pdfToolbar.evaluate((el) => { const body = el.closest(".node-body"); body.scrollTop = 0; body.dispatchEvent(new Event("scroll")); });
  assert.equal(await pdfToolbar.evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "the resting PDF toolbar should have no dark container");
  const toolbarScroll = await pdfToolbar.evaluate((el) => { const body = el.closest(".node-body"); body.scrollTop = 40; body.dispatchEvent(new Event("scroll")); return { top: body.scrollTop, height: body.clientHeight, content: body.scrollHeight }; });
  assert(toolbarScroll.top > 8, `PDF body should be scrollable for sticky-toolbar coverage: ${JSON.stringify(toolbarScroll)}`);
  await page.waitForFunction(() => document.querySelector(".node .rh-pdf-toolbar")?.classList.contains("is-stuck"));
  assert.equal(await pdfToolbar.evaluate((el) => el.getAnimations().some((animation) => animation.id === "pdf-toolbar-dock" && animation.effect.getTiming().duration === 140)), true, "docking should use the restrained position transition");
  await page.waitForFunction(() => !Array.from(document.querySelector(".node .rh-pdf-toolbar").getAnimations()).some((animation) => animation.id === "pdf-toolbar-dock" && animation.playState === "running"));
  const dockedGeometry = await pdfToolbar.evaluate((el) => {
    const node = el.closest(".node"), body = node.querySelector(".node-body"), head = node.querySelector(".node-head");
    const barRect = el.getBoundingClientRect(), headRect = head.getBoundingClientRect();
    return { directChild: el.parentElement === node, topGap: barRect.top - headRect.bottom, leftGap: barRect.left - headRect.left, rightGap: headRect.right - barRect.right };
  });
  assert.equal(dockedGeometry.directChild, true, "the compact toolbar should dock outside the scrollbar-bearing body");
  assert(Math.abs(dockedGeometry.topGap) < 1 && Math.abs(dockedGeometry.leftGap) < 1 && Math.abs(dockedGeometry.rightGap) < 1, `docked toolbar should be flush and symmetric: ${JSON.stringify(dockedGeometry)}`);
  await pdfToolbar.evaluate((el) => { const body = el.closest(".node").querySelector(".node-body"); body.scrollTop = 0; body.dispatchEvent(new Event("scroll")); });
  await page.waitForFunction(() => !document.querySelector(".node .rh-pdf-toolbar.is-stuck"));
  assert.equal(await pdfToolbar.evaluate((el) => el.parentElement.classList.contains("rh-pdf")), true, "the toolbar should return to the PDF at the top");
  await boxToggle.click();
  await page.waitForSelector(".node .rh-pdf-box-hint.visible");
  assert.equal(await boxToggle.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".node .rh-pdf-box-hint.visible"));
  assert.equal(await boxToggle.getAttribute("aria-pressed"), "false", "Escape must exit region-select mode");
  await boxToggle.click();
  const secondPage = page.locator(".node .rh-pdf-page[data-page='2']").first();
  const pageBox = await secondPage.boundingBox();
  await page.mouse.move(pageBox.x + pageBox.width * .05, pageBox.y + pageBox.height * .65);
  await page.mouse.down();
  await page.mouse.move(pageBox.x + pageBox.width * .95, pageBox.y + pageBox.height * .9);
  await page.mouse.up();
  await page.waitForSelector("#ask.visible");
  await page.click('#ask-lenses .lens[data-lens="explain"]');
  await page.waitForFunction(() => document.querySelectorAll(".node .rh-pdf-mark.mark-ready").length >= 2);
  await page.waitForFunction(() => document.querySelectorAll(".rh-pdf-box-draft").length === 0, undefined, { timeout: 5000 });
  assert.equal(answerBodies.length, 3);
  assert(Array.isArray(answerBodies[2].messages.at(-1).content), "box ask should ship its crop as an image part");
  const boxAnchor = await page.evaluate(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    return hole.nodes.filter((node) => node.parent_id).at(-1).origin.anchor;
  });
  assert.equal(boxAnchor.pdf.page, 2); assert(boxAnchor.pdf.rect.w > .8, "drawn box should persist normalized geometry");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".doc-content.rh-pdf .rh-pdf-page[data-page='2']", { state: "attached" });
  await page.waitForSelector(".rh-pdf-mark.mark-ready", { state: "attached" });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
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

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await setFetchProxy(page, `${baseUrl}/dead-proxy`);
  await page.click("#t-new");
  await page.click("#composer-path-url");
  await page.fill("#composer-input", "https://arxiv.org/abs/9999.0000");
  await page.click("#composer-primary");
  await page.waitForSelector("#ingest-status.error");
  const deadError = await page.textContent("#ingest-status");
  assert.match(deadError, /Try another link or open a PDF/i);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await setFetchProxy(page, `${baseUrl}/reject-proxy`);
  await page.click("#t-new");
  await page.click("#composer-path-url");
  await page.fill("#composer-input", "https://arxiv.org/abs/7777.7777");
  await page.click("#composer-primary");
  await page.waitForSelector("#ingest-status.error");
  const rejectError = await page.textContent("#ingest-status");
  assert.match(rejectError, /isn't supported by the link relay yet/i);
  assert.match(rejectError, /arXiv links work best/);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "broken.HtMl", mimeType: "", buffer: Buffer.from("not a snapshot") });
  await page.waitForSelector("#ingest-status.error");
  assert.match(await page.textContent("#ingest-status"), /Snapshot import failed/i);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "Notes.Md", mimeType: "", buffer: Buffer.from("# Mixed-case markdown\n\nEmpty MIME markdown classified.") });
  await waitForCanvasText(page, "Empty MIME markdown classified.");

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await page.setInputFiles("#file-md", { name: "evil.html.txt", mimeType: "text/plain", buffer: Buffer.from("evil suffix remains text") });
  await waitForCanvasText(page, "evil suffix remains text");

  await page.goto(baseUrl, { waitUntil: "networkidle" });
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

  await page.goto(baseUrl, { waitUntil: "networkidle" });
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
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await dropPdf(page, buildTinyPdf(["Convert journey page one", "Convert journey page two"]), "convert-journey.pdf");
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
  assert.match(convertedState.root.extensions.pdf.original_markdown, /Convert journey page one/, "the native body must stay stashed");
  assert.equal(convertedState.root.extensions.pdf.pages.length, 2, "the page stash must survive conversion");
  assert.match(convertedState.root.markdown, /!\[Attention diagram\]\(asset:fig-p002-1\.jpg\)/);
  assert(convertedState.names.includes("fig-p002-1.jpg"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const dc = document.querySelector(".node .doc-content:not(.rh-pdf)");
    return !!dc && dc.textContent.includes("Converted Doc");
  });

  // ---- Cancel mid-run restores the native paged view -----------------------
  transcribeMode = "hang";
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await dropPdf(page, buildTinyPdf(["Abort page one", "Abort page two"]), "abort-journey.pdf");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  await page.click(".node .rh-pdf-convert");
  await page.waitForSelector(".node .rh-pdf-convert-progress");
  assert.match(await page.textContent(".node .rh-pdf-convert-progress"), /Creating text version/);
  assert((await page.locator(".node .rh-pdf-convert-progress .sk-line").count()) > 0, "converting must show the loading skeleton");
  assert(!(await page.textContent(".node .doc-content")).includes("Abort page one"), "the raw extraction must not render while converting");
  await page.click(".node .rh-pdf-convert-cancel");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='1']");
  const abortedState = await page.evaluate(async () => {
    const hole = await window.__rabbitholeTest.readStoredHole();
    return hole.nodes.find((node) => !node.parent_id);
  });
  assert.equal(abortedState.extensions.pdf.converting, false);
  assert.match(abortedState.markdown, /Abort page one/, "cancel must keep the native body");
  transcribeMode = "stream";

  // ---- Convert is disabled once the document has branches ------------------
  const askSelected = await page.evaluate(() => {
    const span = [...document.querySelectorAll(".node .rh-pdf-textlayer span")].find((el) => el.textContent.includes("Abort page one"));
    const text = span.firstChild, range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 5);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const picked = selection.toString(); // the ask box focuses on open, collapsing the native selection
    span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return picked;
  });
  assert.equal(askSelected, "Abort");
  await page.waitForSelector("#ask.visible");
  await page.click('#ask-lenses .lens[data-lens="explain"]');
  await page.locator(".node .rh-pdf-mark.mark-ready").first().waitFor();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator(".node .rh-pdf-convert").count(), 0, "the text-version action must stay absent after reloading a branched PDF");

  // ---- Scanned PDFs surface the convert affordance -------------------------
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await dropPdf(page, buildTinyPdf(["", ""]), "scanned.pdf");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='2']");
  await page.waitForSelector(".node .rh-pdf-scanned-note");
  assert.match(await page.textContent(".node .rh-pdf-scanned-note"), /No selectable text/);
  await page.waitForSelector(".node .rh-pdf-convert.primary:not(:disabled)");
  const scannedBody = await page.evaluate(async () => (await window.__rabbitholeTest.readStoredHole()).nodes[0].markdown);
  assert.match(scannedBody, /\*\(page 1: no extractable text\)\*/, "scanned pages must carry the body marker");

  // ---- No local vision model keeps import available but gates conversion ----
  localVisionAvailable = false;
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await dropPdf(page, buildTinyPdf(["Local text-only model PDF"]), "no-local-vision.pdf");
  await page.waitForSelector(".node .doc-content.rh-pdf .rh-pdf-page[data-page='1']");
  await page.waitForSelector(".node .rh-pdf-convert:disabled");
  assert.equal(await page.locator(".node .rh-pdf-transcription-note").innerText(), "Install a local model that supports vision to enable PDF transcription.");

  // ---- A corrupt PDF fails with an actionable message, no stranded hole ----
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.click("#t-new");
  await dropPdf(page, [...Buffer.from("%PDF-1.4\nthis is not really a pdf")], "corrupt.pdf");
  await page.waitForSelector("#ingest-status.error");
  assert.match(await page.textContent("#ingest-status"), /could not be opened by pdf\.js/i);

  console.log("web ingestion verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
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
