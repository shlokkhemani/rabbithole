/** @protects image experience capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as esbuild from "esbuild";
import { chromium } from "playwright";
import { renderMarkdownToHtml } from "../../src/core/markdown.js";
import { extractSnapshotPayload, SNAPSHOT_PAYLOAD_OPEN } from "../../src/core/portable-import.js";
import { validatePortableProjection } from "../../src/core/portable-projection.js";
import { buildCanvasHtml } from "../../src/node/html/canvas.js";
import { getUiAssets } from "../../src/node/html/built-assets.js";
import { CANVAS_STYLES } from "../support/design-css.mjs";
import { addAssetsToHole, defaultFsStore } from "../../src/node/fs-store.js";
import { createSession, closeAllSessions } from "../../src/node/sessions.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-image-experience-"));

function assertIncludes(haystack, needle, message) {
  assert(haystack.includes(needle), message || `expected to include ${needle}`);
}

function extractScript(html) {
  const match = html.match(/<script>\n([\s\S]*)\n<\/script>/);
  assert(match, "assembled HTML should contain one inline script");
  return match[1];
}

async function buildSourceClient() {
  const built = await esbuild.build({
    entryPoints: [path.resolve("src/ui/entry.js")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "RabbitholeClient",
    target: "es2018",
    loader: { ".css": "text" },
    define: {
      __RABBITHOLE_VERSION__: JSON.stringify("test"),
      __RABBITHOLE_COMMIT__: JSON.stringify(""),
    },
    external: ["pdfjs-dist/build/pdf.mjs"],
    legalComments: "none",
    logLevel: "silent",
  });
  return built.outputFiles[0].text.replace(/<script/gi, "<scr\\x69pt").replace(/<\/script/gi, "<\\/script");
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
  const markdown = [
    "Root image:",
    "",
    "![diagram](asset:diagram-1.png)",
    "",
    "```show",
    '<img src="https://example.com/in-show.png">',
    "```",
  ].join("\n");
  const root = {
    id: "root",
    parent_id: null,
    title: "Root",
    markdown,
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: new Date().toISOString(),
  };

  const session = await createSession({
    holeId: "image-experience",
    title: "Image Experience",
    rootId: "root",
    nodes: [root],
    assetNames: new Set(["diagram-1.png"]),
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  try {
    const live = await fetch(session.url);
    assert.equal(live.status, 200);
    const liveHtml = await live.text();
    const script = extractScript(liveHtml);
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
    assertIncludes(CANVAS_STYLES, 'html[data-theme="dark"] .md .rh-img-frame', "canvas CSS should define the dark-mode image matte");
    assertIncludes(CANVAS_STYLES, '.md .rh-img-frame[data-rh-resized="1"] { display: block; margin-left: auto; margin-right: auto; }', "resized images should center in the content column");
    assertIncludes(CANVAS_STYLES, ".rh-lightbox-caption", "canvas CSS should style generated-image provenance");
    assertIncludes(liveHtml, "--image-matte", "served page should carry the bundled image-matte CSS");
    assert(!CANVAS_STYLES.includes('html[data-theme="dark"] .md img'), "matte selector should not target every .md img directly");

    const scriptPath = path.join(process.env.RABBITHOLE_DIR, "image-client.js");
    await fs.writeFile(scriptPath, script, "utf8");
    const check = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const exported = await fetch(`${session.url}/export`);
    assert.equal(exported.status, 200);
    const exportHtml = await exported.text();
    assertIncludes(exportHtml, "--image-matte", "export should retain bundled image-matte CSS");
    console.log("ok image ux: served client, matte CSS, export CSS");
  } finally {
    await closeAllSessions("image_experience_test_complete");
  }
}

async function runLiveSnapshotDownload() {
  const referencedBytes = Buffer.from("referenced snapshot asset");
  const pastedBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const generatedBytes = Buffer.from(pastedBytes);
  const unreferencedBytes = Buffer.from("unreferenced snapshot asset");
  const referencedPath = path.join(process.env.RABBITHOLE_DIR, "diagram.png");
  const pastedPath = path.join(process.env.RABBITHOLE_DIR, "paste-deadbeef.png");
  const generatedPath = path.join(process.env.RABBITHOLE_DIR, "gen-abcdefgh.png");
  const unreferencedPath = path.join(process.env.RABBITHOLE_DIR, "unused.png");
  await fs.writeFile(referencedPath, referencedBytes);
  await fs.writeFile(pastedPath, pastedBytes);
  await fs.writeFile(generatedPath, generatedBytes);
  await fs.writeFile(unreferencedPath, unreferencedBytes);
  await addAssetsToHole("image-live-snapshot", [
    { name: "diagram.png", file_path: referencedPath },
    { name: "paste-deadbeef.png", file_path: pastedPath },
    { name: "gen-abcdefgh.png", file_path: generatedPath },
    { name: "unused.png", file_path: unreferencedPath },
  ]);

  const now = new Date().toISOString();
  const session = await createSession({
    holeId: "image-live-snapshot",
    title: "Image Live Snapshot",
    rootId: "root",
    nodes: [
      {
        id: "root", parent_id: null, title: "Root",
        markdown: "Referenced asset ![diagram](asset:diagram.png)\n\n![Pasted image](asset:paste-deadbeef.png)\n\n![Water mill](asset:gen-abcdefgh.png)",
        origin: null, position: { x: 0, y: 0 }, size: null, font_scale: 1,
        collapsed: false, status: "answered", read: true, created_at: now,
        extensions: {
          generated_images: {
            "gen-abcdefgh.png": {
              prompt: "A water mill",
              revised_prompt: "A cutaway of a water mill",
              thread_id: "thread-1",
              aspect: "landscape",
              edit_of: null,
              created_at: now,
            },
          },
        },
      },
      {
        id: "pending", parent_id: "root", title: "Pending",
        markdown: "half-streamed markdown must not escape", question: "Finish this answer",
        origin: null, position: { x: 420, y: 0 }, size: null, font_scale: 1,
        collapsed: false, status: "pending", read: false, created_at: now,
      },
      {
        id: "pending-stream", parent_id: "root", title: "Pending stream",
        markdown: "", question: "Stream then draw",
        origin: null, position: { x: 840, y: 0 }, size: null, font_scale: 1,
        collapsed: false, status: "pending", read: false, created_at: now,
      },
    ],
    assetNames: new Set(await defaultFsStore.listAssets("image-live-snapshot")),
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  const browser = await chromium.launch({ headless: true });
  try {
    assert.equal(
      session.buildHydration().nodes.find((node) => node.id === "root")?.extensions?.generated_images?.[
        "gen-abcdefgh.png"
      ]?.revised_prompt,
      "A cutaway of a water mill",
      "generated-image provenance should reach browser hydration",
    );
    const page = await browser.newPage({ acceptDownloads: true });
    page.on("pageerror", (error) => process.stderr.write(`browser page error: ${error.stack || error.message}\n`));
    const liveResponse = await fetch(session.url);
    const liveHtml = await liveResponse.text();
    const sourceClient = await buildSourceClient();
    const distClient = (await getUiAssets()).clientSource;
    const clientIndex = liveHtml.lastIndexOf(distClient);
    assert(clientIndex >= 0, "served page should contain the committed client bundle");
    const sourceLiveHtml = liveHtml.slice(0, clientIndex) + sourceClient + liveHtml.slice(clientIndex + distClient.length);
    assert.notEqual(sourceLiveHtml, liveHtml, "source client should replace the committed bundle in the browser harness");
    const sourceScriptPath = path.join(process.env.RABBITHOLE_DIR, "source-image-client.js");
    await fs.writeFile(sourceScriptPath, extractScript(sourceLiveHtml), "utf8");
    const sourceCheck = spawnSync(process.execPath, ["--check", sourceScriptPath], { encoding: "utf8" });
    assert.equal(sourceCheck.status, 0, sourceCheck.stderr || sourceCheck.stdout);
    await page.route(session.url, (route) => route.fulfill({ status: 200, contentType: "text/html", body: sourceLiveHtml }));
    await page.goto(session.url);
    await page.waitForSelector("#t-share");
    await page.waitForSelector(".rh-img-frame .rh-img-handle");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    const sourceImage = page.locator('.rh-img-frame img[alt="diagram"]');
    const pastedImage = page.locator('.rh-img-frame img[alt="Pasted image"]');
    const generatedImage = page.locator('.rh-img-frame img[alt="Water mill"]');
    assert.equal(await generatedImage.count(), 1,
      "an existing generated image must render when the AI images preference is absent");
    await page.waitForFunction(() => {
      const image = document.querySelector('.rh-img-frame img[alt="Water mill"]');
      return image?.complete && image.naturalWidth > 0;
    });
    assert.deepEqual(await sourceImage.locator("..").evaluate((frame) => {
      const style = getComputedStyle(frame);
      return { pasted: frame.dataset.rhPasted || null, padding: style.paddingTop,
        background: style.backgroundColor, border: style.borderTopWidth };
    }), { pasted: null, padding: "8px", background: "rgb(244, 244, 241)", border: "1px" },
    "ordinary asset images should retain the dark-theme matte");
    assert.deepEqual(await pastedImage.locator("..").evaluate((frame) => {
      const style = getComputedStyle(frame);
      return { pasted: frame.dataset.rhPasted || null, padding: style.paddingTop,
        background: style.backgroundColor, border: style.borderTopWidth };
    }), { pasted: "1", padding: "0px", background: "rgba(0, 0, 0, 0)", border: "0px" },
    "pasted asset images should not receive the dark-theme matte");
    await sourceImage.click();
    await page.waitForSelector(".rh-lightbox:not([hidden])");
    assert.equal(await page.locator(".rh-lightbox-caption").count(), 0, "ordinary asset images should have no provenance caption");
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
    await pastedImage.evaluate((img) => img.click());
    assert.deepEqual(await page.locator(".rh-lightbox-img").evaluate((img) => {
      const style = getComputedStyle(img);
      return { pasted: img.dataset.rhPasted || null, padding: style.paddingTop,
        background: style.backgroundColor, border: style.borderTopWidth };
    }), { pasted: "1", padding: "0px", background: "rgba(0, 0, 0, 0)", border: "0px" },
    "the pasted marker should exempt the lightbox image from the dark-theme matte");
    await page.keyboard.press("Escape");
    await generatedImage.evaluate((img) => img.click());
    await page.waitForSelector(".rh-lightbox:not([hidden])");
    assert.equal(await page.locator(".rh-lightbox-caption").count(), 1);
    assert.equal(await page.locator(".rh-lightbox-caption-alt").textContent(), "Water mill");
    assert.equal(await page.locator(".rh-lightbox-caption-prompt").textContent(), "A cutaway of a water mill");
    await page.keyboard.press("Escape");

    session.broadcast({ type: "node_work_state", node_id: "pending", state: "drawing" });
    await page.locator('.card[data-id="pending"] .ll-live', { hasText: "Drawing…" }).waitFor();
    session.broadcast({ type: "node_progress", node_id: "pending-stream", markdown: "Prose before pixels." });
    await page.locator('.card[data-id="pending-stream"] .stream-status .ll-live', { hasText: "Writing" }).waitFor();
    session.broadcast({ type: "node_work_state", node_id: "pending-stream", state: "drawing" });
    await page.locator('.card[data-id="pending-stream"] .stream-status .ll-live', { hasText: "Drawing…" }).waitFor();

    const liveStyles = await page.locator("head style:first-of-type").textContent();

    await page.click("#t-share");
    await page.waitForSelector("#sharemenu.visible");
    const downloadPromise = page.waitForEvent("download");
    await page.click("#sm-export");
    const download = await downloadPromise;
    const downloadPath = await download.path();
    assert(downloadPath, "snapshot download should expose artifact bytes");
    const snapshotHtml = await fs.readFile(downloadPath, "utf8");

    const payloadText = extractSnapshotPayload(snapshotHtml);
    const projection = validatePortableProjection(JSON.parse(payloadText));
    assert.equal(snapshotHtml.split(SNAPSHOT_PAYLOAD_OPEN).length - 1, 1, "snapshot should contain exactly one inert payload");
    assertIncludes(snapshotHtml, `<style>\n${liveStyles}\n</style>`, "snapshot should embed the canonical served stylesheet");
    assertIncludes(snapshotHtml, "RabbitholeFrozenClient.startPortableSnapshot", "snapshot should use derived portable hydration");
    assert.deepEqual(Object.keys(projection.assets), ["diagram.png", "gen-abcdefgh.png", "paste-deadbeef.png"], "snapshot should embed referenced assets only");
    assert.equal(projection.assets["diagram.png"], referencedBytes.toString("base64"));
    assert.equal(projection.assets["gen-abcdefgh.png"], generatedBytes.toString("base64"));
    assert.equal(projection.assets["paste-deadbeef.png"], pastedBytes.toString("base64"));
    assert.equal(projection.hole.nodes.find((node) => node.id === "pending")?.markdown, "", "snapshot endpoint should apply persisted pending-node policy");

    const frozenPage = await browser.newPage();
    try {
      await frozenPage.setContent(snapshotHtml, { waitUntil: "load" });
      await frozenPage.waitForSelector('.rh-img-frame img[alt="Pasted image"]', { state: "attached" });
      await frozenPage.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      assert.deepEqual(await frozenPage.locator('.rh-img-frame img[alt="Pasted image"]').locator("..").evaluate((frame) => {
        const style = getComputedStyle(frame);
        return { pasted: frame.dataset.rhPasted || null, padding: style.paddingTop,
          background: style.backgroundColor, border: style.borderTopWidth };
      }), { pasted: "1", padding: "0px", background: "rgba(0, 0, 0, 0)", border: "0px" },
      "the frozen/share runtime should mount the pasted marker and preserve the matte exemption");
      assert.equal(await frozenPage.locator('.rh-img-frame img[alt="diagram"]').locator("..").evaluate((frame) =>
        getComputedStyle(frame).paddingTop), "8px", "the frozen/share runtime should retain ordinary-image mattes");
    } finally {
      await frozenPage.close();
    }
    console.log("ok image ux: live MCP share snapshot download is canonical and portable");
  } finally {
    await browser.close();
    await closeAllSessions("image_snapshot_test_complete");
  }
}

await runMarkdownSmoke();
await runPageFixtures();
await runLiveSnapshotDownload();
console.log("image experience verification passed");
