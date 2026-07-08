import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderMarkdownToHtml } from "../src/core/markdown.js";
import { buildCanvasHtml } from "../src/core/html/canvas.js";
import { CANVAS_STYLES } from "../src/core/html/styles.js";
import { createSession, closeAllSessions } from "../src/core/sessions.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage6-"));

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
    holeId: "stage6-image-ux",
    title: "Stage 6 Image UX",
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

    const scriptPath = path.join(process.env.RABBITHOLE_DIR, "stage6-client.js");
    await fs.writeFile(scriptPath, script, "utf8");
    const check = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const exported = await fetch(`${session.url}/export`);
    assert.equal(exported.status, 200);
    const exportHtml = await exported.text();
    assertIncludes(exportHtml, 'html[data-theme="dark"] .md .rh-img-frame', "export should retain dark-mode image matte CSS");
    console.log("ok image ux: served client, matte CSS, export CSS");
  } finally {
    await closeAllSessions("stage6_test_complete");
  }
}

await runMarkdownSmoke();
await runPageFixtures();
console.log("stage6 image ux verification passed");
