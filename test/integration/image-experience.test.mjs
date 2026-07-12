import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { renderMarkdownToHtml } from "../../src/core/markdown.js";
import { extractSnapshotPayload, SNAPSHOT_PAYLOAD_OPEN } from "../../src/core/portable-import.js";
import { validatePortableProjection } from "../../src/core/portable-projection.js";
import { buildCanvasHtml } from "../../src/node/html/canvas.js";
import { CANVAS_STYLES } from "../../src/core/html/styles.js";
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

    assertIncludes(script, "function mountDocImages", "client should mount markdown image wrappers");
    assertIncludes(script, "function openImageLightbox", "client should include the lightbox");
    assertIncludes(script, "function beginImageResize", "client should include resize handler code");
    assertIncludes(script, "function nearestImageScrollContainer", "resize should discover the actual scroll container");
    assertIncludes(script, "function keepImageHandleAnchored", "resize should compensate scroll while image height changes");
    assertIncludes(script, "afterRect.bottom - beforeRect.bottom", "resize should anchor the handle by the frame-bottom delta");
    assertIncludes(script, "scroller.scrollTop += delta / imageScrollScale(scroller)", "resize should adjust scrollTop in scroller-local pixels");
    assertIncludes(script, "LIGHTBOX_MAX_ZOOM = 6", "lightbox zoom should clamp at the requested upper bound");
    assertIncludes(script, 'img.closest(".viz, .viz-mounted")', "show-fence images should be skipped by image UX mount");
    assertIncludes(liveHtml, 'html[data-theme="dark"] .md .rh-img-frame', "served page should include dark-mode image matte CSS");
    assertIncludes(liveHtml, '.md .rh-img-frame[data-rh-resized="1"] { display: block; margin-left: auto; margin-right: auto; }', "resized images should center in the content column");
    assert(!CANVAS_STYLES.includes('html[data-theme="dark"] .md img'), "matte selector should not target every .md img directly");

    const scriptPath = path.join(process.env.RABBITHOLE_DIR, "image-client.js");
    await fs.writeFile(scriptPath, script, "utf8");
    const check = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const exported = await fetch(`${session.url}/export`);
    assert.equal(exported.status, 200);
    const exportHtml = await exported.text();
    assertIncludes(exportHtml, 'html[data-theme="dark"] .md .rh-img-frame', "export should retain dark-mode image matte CSS");
    console.log("ok image ux: served client, matte CSS, export CSS");
  } finally {
    await closeAllSessions("image_experience_test_complete");
  }
}

async function runLiveSnapshotDownload() {
  const referencedBytes = Buffer.from("referenced snapshot asset");
  const unreferencedBytes = Buffer.from("unreferenced snapshot asset");
  const referencedPath = path.join(process.env.RABBITHOLE_DIR, "diagram.png");
  const unreferencedPath = path.join(process.env.RABBITHOLE_DIR, "unused.png");
  await fs.writeFile(referencedPath, referencedBytes);
  await fs.writeFile(unreferencedPath, unreferencedBytes);
  await addAssetsToHole("image-live-snapshot", [
    { name: "diagram.png", file_path: referencedPath },
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
        markdown: "Referenced asset ![diagram](asset:diagram.png)",
        origin: null, position: { x: 0, y: 0 }, size: null, font_scale: 1,
        collapsed: false, status: "answered", read: true, created_at: now,
      },
      {
        id: "pending", parent_id: "root", title: "Pending",
        markdown: "half-streamed markdown must not escape", question: "Finish this answer",
        origin: null, position: { x: 420, y: 0 }, size: null, font_scale: 1,
        collapsed: false, status: "pending", read: false, created_at: now,
      },
    ],
    assetNames: new Set(await defaultFsStore.listAssets("image-live-snapshot")),
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(session.url);
    await page.waitForSelector("#r-share");
    const liveStyles = await page.locator("head style:first-of-type").textContent();

    await page.click("#r-share");
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
    assert.deepEqual(Object.keys(projection.assets), ["diagram.png"], "snapshot should embed referenced assets only");
    assert.equal(projection.assets["diagram.png"], referencedBytes.toString("base64"));
    assert.equal(projection.hole.nodes.find((node) => node.id === "pending")?.markdown, "", "snapshot endpoint should apply persisted pending-node policy");
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
