import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { renderMarkdownToHtml } from "../../src/core/markdown.js";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import { createNoraSnapshotProjection } from "../../src/core/snapshot-projection.js";
import { CANVAS_STYLES } from "../../src/core/html/styles.js";
import { baseHydration, bootNoraWebview } from "../support/webview-harness.mjs";
import { createTestNoraWebviewHtml, readWebviewAsset } from "../support/nora-webview-assets.mjs";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const LARGE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAYAAADl5PURAAAE0ElEQVR4nO3UMXIQMRBEUW7HQTg4KbeAwoETu7CNpO3d6Re8fFSt+t9+/vr9G6DRt/QBACkCCNQSQKCWAAK1BBCoJYBALQEEagkgUEsAgVoCCNQSQKCWAAK1BBCoJYBALQEEagkgUEsAgVoCCNQSQKCWAAK1BBCoJYBALQEEagkgUEsAgVoCCNQSQKCWAAK1BBCoJYBALQEEagkgUEsAgVoCSNT3H/kb6CWAHPM3bruk38JMAsg2O4MniFxBAFlyZfTEkN0EkC9LB08M2UUA+bR03ISQ3QSQD6VjJoScIoD8UzpgIshJAsi70tESQq4ggLyRDpUIchUB5FU6TkLI1QSQF+kgiSAJAkg8RCJIigCWSwfoDtIbkCOAxdLhuZP0FmQIYKl0cO4ovQnXE8BC6dDcWXobriWAZdKBeYL0RlxHAIukw/Ik6a24hgCWSAflidKbcZ4AlkjH5InSm3GeABZIh+TJ0ttxlgAOlw7IBOkNOUcAh0vHY4L0hpwjgIOlwzFJekvOEMCh0sGYKL0p+wngUOlYTJTelP0EcKB0KCZLb8teAjhQOhKTpbdlLwEcJh2IBumN2UcAh0nHoUF6Y/YRwGHScWiQ3ph9BHCQdBiapLdmDwEcJB2FJumt2UMAB0lHoUl6a/YQwCHSQWiU3px1AjhEOgaN0puzTgCHSMegUXpz1gngEOkYNEpvzjoBHCAdgmbp7VkjgAOkI9AsvT1rBHCAdASapbdnjQAOkI5As/T2rBHAAdIRaJbenjUCOEA6As3S27NGAAdIR6BZenvWCOAA6Qg0S2/PGgEcIB2BZuntWSOAD5cOAPk/wP8TwAHSAWiW3p41AjhAOgLN0tuzRgAHSEegWXp71gjgAOkINEtvzxoBHCAdgWbp7VkjgAOkI9AsvT1rBHCAdASapbdnjQAOkI5As/T2rBHAAdIRaJbenjUCOEQ6BI3Sm7NOAIdIx6BRenPWCeAQ6Rg0Sm/OOgEcIh2DRunNWSeAg6SD0CS9NXsI4CDpKDRJb80eAjhIOgpN0luzhwAOkw5Dg/TG7COAw6Tj0CC9MfsI4DDpODRIb8w+AjhQOhCTpbdlLwEcKB2JydLbspcADpUOxUTpTdlPAIdKx2Ki9KbsJ4CDpYMxSXpLzhDA4dLhmCC9IecI4HDpeEyQ3pBzBLBAOiBPlt6OswSwRDokT5TejPMEsEQ6Jk+U3ozzBLBIOihPkt6KawhgmXRYniC9EdcRwELpwNxZehuuJYCl0qG5o/QmXE8Ai6WDcyfpLcgQwHLp8NxBegNyBJB4gMSPFAHkRTpE4keCAPIqHSTx42oCyBvpOAkfVxFA3pUOlfhxBQHkn9LREj5OEkA+lA6Y+HGKAPJp6ZgJH7sJIF+WjpvwsYsAsiQdPNFjhQCyjejxNALIMYLH3QkgUeJGkgACtQQQqCWAQC0BBGoJIFBLAIFaAgjUEkCglgACtQQQqCWAQC0BBGoJIFBLAIFaAgjUEkCglgACtQQQqCWAQC0BBGoJIFBLAIFaAgjUEkCglgACtQQQqCWAQC0BBGoJIFBLAIFaAgjUEkCglgACtf4A65r2uDsnOqsAAAAASUVORK5CYII=";

function assertIncludes(haystack, needle, message) {
  assert(haystack.includes(needle), message || `expected to include ${needle}`);
}

async function runMarkdownSmoke() {
  const html = await renderMarkdownToHtml("Before\n\n![diagram](asset:diagram-1.png)\n\nAfter", {
    assetNames: new Set(["diagram-1.png"]),
  });
  assertIncludes(html, '<img src="/assets/diagram-1.png" alt="diagram">');
  assert(!html.includes("rh-img-frame"), "markdown sanitizer should emit plain safe img tags");

  const showHtml = await renderMarkdownToHtml(["```show", '<img src="https://example.com/diagram.png">', "```"].join("\n"));
  assertIncludes(showHtml, 'class="viz"');
  assert(!showHtml.includes("rh-img-frame"), "show fences should remain visual placeholders before client mount");
  console.log("ok image ux: markdown image smoke");
}

async function runPageFixtures() {
  const liveHtml = await createTestNoraWebviewHtml();
  const canvasCss = await readWebviewAsset("canvas.css");
  const noraEntry = await readWebviewAsset("nora-entry.js");
  const frozenClient = await readWebviewAsset("frozen-client.js");
  const imageUxSource = await fs.readFile(path.resolve("src/ui/image-ux.js"), "utf8");
  const lightboxSource = await fs.readFile(path.resolve("src/ui/lightbox.js"), "utf8");

  assertIncludes(imageUxSource, "function mountDocImages", "image UX should mount markdown image wrappers");
  assertIncludes(imageUxSource, "function openImageLightbox", "image UX should include the lightbox");
  assertIncludes(imageUxSource, "function beginImageResize", "image UX should include resize handler code");
  assertIncludes(imageUxSource, "function nearestImageScrollContainer", "resize should discover the actual scroll container");
  assertIncludes(imageUxSource, "function keepImageHandleAnchored", "resize should compensate scroll while image height changes");
  assertIncludes(imageUxSource, "afterRect.bottom - beforeRect.bottom", "resize should anchor the handle by the frame-bottom delta");
  assertIncludes(imageUxSource, "scroller.scrollTop += delta / imageScrollScale(scroller)", "resize should adjust scrollTop in scroller-local pixels");
  assertIncludes(lightboxSource, "LIGHTBOX_MAX_ZOOM = 6", "shared lightbox zoom should clamp at the requested upper bound");
  assertIncludes(imageUxSource, "openLightbox({", "image UX should delegate previews to the shared lightbox");
  assertIncludes(imageUxSource, 'img.closest(".viz, .viz-mounted")', "show-fence images should be skipped by image UX mount");
  assertIncludes(canvasCss, 'html[data-theme="dark"] .md .rh-img-frame', "Nora webview CSS should include dark-mode image matte CSS");
  assertIncludes(canvasCss, '.md .rh-img-frame[data-rh-resized="1"] { display: block; margin-left: auto; margin-right: auto; }', "resized images should center in the content column");
  assert(!CANVAS_STYLES.includes('html[data-theme="dark"] .md img'), "matte selector should not target every .md img directly");
  assertIncludes(liveHtml, 'src="vscode-resource:/out/webview/nora-entry.js"', "Nora webview should load the browser entry asset");
  assertIncludes(noraEntry, "mountDocImages", "Nora webview bundle should include image UX");
  assertIncludes(frozenClient, "mountDocImages", "Nora frozen client should retain image UX");
  console.log("ok image ux: Nora webview assets, matte CSS, and frozen CSS");
}

async function runLiveWebviewImages() {
  const app = await bootNoraWebview();
  const { page } = app;
  const assetName = "image-diagram.png";
  try {
    await app.hydrate(baseHydration({
      title: "Image Live Webview",
      nodes: [{
        ...baseHydration().nodes[0],
        title: "Root",
        markdown: `Referenced asset ![diagram](asset:${assetName})`,
      }],
      asset_data: {
        [assetName]: `data:image/png;base64,${LARGE_PNG_BASE64}`,
      },
    }));
    await page.waitForSelector(".rh-img-frame .rh-img-handle");
    const sourceImage = page.locator(".rh-img-frame img").first();
    await sourceImage.click();
    await page.waitForSelector(".rh-lightbox:not([hidden])");
    assert.equal(await page.locator('.rh-lightbox-close[aria-label="Close"]').count(), 1);
    await page.locator(".rh-lightbox-img").dblclick();
    assert.equal(await page.locator(".rh-lightbox-img").evaluate((img) => img.style.getPropertyValue("--rh-zoom")), "2");
    await page.locator(".rh-lightbox-img").dblclick();
    assert.equal(await page.locator(".rh-lightbox-img").evaluate((img) => img.style.getPropertyValue("--rh-zoom")), "1");
    await page.locator(".rh-lightbox-img").hover();
    await page.mouse.wheel(0, -100);
    assert(Number(await page.locator(".rh-lightbox-img").evaluate((img) => img.style.getPropertyValue("--rh-zoom"))) > 1, "image wheel zoom should remain active");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".rh-lightbox", { state: "detached" });
    assert.equal(await sourceImage.evaluate((img) => img === img.getRootNode().activeElement), true, "image Escape should restore source focus");
    await sourceImage.click();
    await page.waitForSelector(".rh-lightbox:not([hidden])");
    await page.click('.rh-lightbox-close[aria-label="Close"]');
    await page.waitForSelector(".rh-lightbox", { state: "detached" });
    assert.equal(await sourceImage.evaluate((img) => img === img.getRootNode().activeElement), true, "image close button should restore source focus");
    console.log("ok image ux: Nora webview markdown image lightbox and focus behavior");
  } finally {
    await app.close();
  }
}

async function runNoraSnapshotProjection() {
  const assetName = "image-diagram.png";
  const projection = createNoraSnapshotProjection(noraImageDocument(assetName), { mode: "reader", node_id: "root", scroll: 0 }, {
    [assetName]: PNG_BASE64,
    "unused.png": Buffer.from("unused image").toString("base64"),
  });
  const snapshotHtml = buildSnapshotHtml({
    title: "Image Live Snapshot",
    stylesheetText: await readWebviewAsset("canvas.css"),
    dompurifySource: "globalThis.DOMPurify={sanitize:function(value){return value},addHook:function(){}};",
    frozenClientSource: "globalThis.NoraFrozenClient={startPortableSnapshot:function(){}};",
    snapshotProjection: projection,
  });

  const payloadText = extractNoraSnapshotPayload(snapshotHtml);
  const parsed = JSON.parse(payloadText);
  assert.equal(snapshotHtml.split('<script type="application/vnd.nora+json" id="nora-snapshot">').length - 1, 1, "snapshot should contain exactly one inert Nora payload");
  assertIncludes(snapshotHtml, "<style>\n", "snapshot should embed stylesheet text");
  assertIncludes(snapshotHtml, "NoraFrozenClient", "snapshot should use Nora frozen hydration");
  assert.deepEqual(Object.keys(parsed.assets), [assetName], "snapshot should embed referenced assets only");
  assert.equal(parsed.assets[assetName], PNG_BASE64);
  assert.equal(parsed.document.nodes.find((node) => node.id === "pending")?.state, "running", "snapshot should retain interrupted Nora node state");
  console.log("ok image ux: Nora snapshot projection is canonical and referenced-asset only");
}

function noraImageDocument(assetName) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    documentId: "image-live-snapshot",
    title: "Image Live Snapshot",
    rootNodeId: "root",
    createdAt: now,
    updatedAt: now,
    viewState: { mode: "reader", node_id: "root", scroll: 0 },
    selection: null,
    selectedProfileId: null,
    nodes: [
      {
        id: "root",
        parentId: null,
        title: "Root",
        markdown: `Referenced asset ![diagram](asset:${assetName})`,
        baseUrl: null,
        baseUrlSource: null,
        origin: null,
        position: { x: 0, y: 0 },
        size: null,
        fontScale: 1,
        collapsed: false,
        state: "complete",
        read: true,
        createdAt: now,
        updatedAt: now,
        sourceIds: [],
        evidenceIds: [],
        attachmentIds: [],
        runId: null,
        extensions: {},
      },
      {
        id: "pending",
        parentId: "root",
        title: "Pending",
        markdown: "half-streamed markdown remains visible in Nora snapshots",
        baseUrl: null,
        baseUrlSource: null,
        origin: null,
        position: { x: 420, y: 0 },
        size: null,
        fontScale: 1,
        collapsed: false,
        state: "running",
        read: false,
        createdAt: now,
        updatedAt: now,
        sourceIds: [],
        evidenceIds: [],
        attachmentIds: [],
        runId: null,
        extensions: {},
      },
    ],
    edges: [{
      id: "edge:root:pending",
      fromNodeId: "root",
      toNodeId: "pending",
      kind: "branch",
      createdAt: now,
      extensions: {},
    }],
    sources: [],
    evidence: [],
    attachments: [],
    runs: [],
    checks: [],
    extensions: {},
  };
}

function extractNoraSnapshotPayload(html) {
  const open = '<script type="application/vnd.nora+json" id="nora-snapshot">';
  const start = html.indexOf(open);
  assert.notEqual(start, -1, "Nora snapshot payload should be present");
  const end = html.indexOf("</script>", start + open.length);
  assert.notEqual(end, -1, "Nora snapshot payload should be closed");
  return html.slice(start + open.length, end);
}

await runMarkdownSmoke();
await runPageFixtures();
await runLiveWebviewImages();
await runNoraSnapshotProjection();
console.log("image experience verification passed");
