import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { renderMarkdownToHtml } from "../src/core/markdown.js";
import { buildCanvasHtml } from "../src/core/html/canvas.js";
import { createSession, closeAllSessions } from "../src/core/sessions.js";
import {
  MAX_ASSET_BYTES,
  addAssetsToHole,
  deleteAsset,
  listAssets,
  resolveAsset,
} from "../src/core/storage.js";
import { toolDefinitions } from "../src/tools/manifest.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage4-"));

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_BYTES_2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);

function assertIncludes(haystack, needle, message) {
  assert(haystack.includes(needle), message || `expected to include ${needle}`);
}

async function rawGet(baseUrl, requestPath) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: requestPath, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function runStorageFixtures() {
  const dir = await fs.mkdtemp(path.join(process.env.RABBITHOLE_DIR, "sources-"));
  const source = path.join(dir, "source.png");
  const source2 = path.join(dir, "source2.png");
  const oversize = path.join(dir, "oversize.png");
  await fs.writeFile(source, PNG_BYTES);
  await fs.writeFile(source2, PNG_BYTES_2);

  const added = await addAssetsToHole("storage-hole", [{ name: "diagram-1.png", file_path: source }]);
  assert.equal(added[0].name, "diagram-1.png");
  assert.deepEqual(await listAssets("storage-hole"), ["diagram-1.png"]);
  assert.deepEqual(await fs.readFile(await resolveAsset("storage-hole", "diagram-1.png")), PNG_BYTES);

  await addAssetsToHole("storage-hole", [{ name: "diagram-1.png", file_path: source2 }]);
  assert.deepEqual(await fs.readFile(await resolveAsset("storage-hole", "diagram-1.png")), PNG_BYTES_2);

  await deleteAsset("storage-hole", "diagram-1.png");
  assert.equal(await resolveAsset("storage-hole", "diagram-1.png"), null);

  await fs.writeFile(oversize, "");
  await fs.truncate(oversize, MAX_ASSET_BYTES + 1);
  await assert.rejects(
    () => addAssetsToHole("bad-hole", [{ name: "Bad.png", file_path: source }]),
    /assets\[0\]\.name/
  );
  await assert.rejects(
    () => addAssetsToHole("bad-hole", [{ name: "../bad.png", file_path: source }]),
    /assets\[0\]\.name/
  );
  await assert.rejects(
    () => addAssetsToHole("bad-hole", [{ name: "missing.png", file_path: path.join(dir, "missing.png") }]),
    /assets\[0\]\.file_path does not exist/
  );
  await assert.rejects(
    () => addAssetsToHole("bad-hole", [{ name: "wrong.bmp", file_path: source }]),
    /assets\[0\]\.name/
  );
  await assert.rejects(
    () => addAssetsToHole("bad-hole", [{ name: "big.png", file_path: oversize }]),
    /assets\[0\]\.file_path exceeds 20 MB/
  );

  console.log("ok assets: storage copy, overwrite, delete, and validation failures");
  return { source, source2 };
}

async function runMarkdownFixtures() {
  const html = await renderMarkdownToHtml("![fig](asset:diagram-1.png)", {
    baseUrl: "https://example.com/docs/page.md",
  });
  assertIncludes(html, 'src="/assets/diagram-1.png"', "asset images should resolve to root-relative asset URLs");
  assert(!html.includes("https://example.com"), "asset images should not resolve against base_url");

  const link = await renderMarkdownToHtml("[fig](asset:diagram-1.png)", {
    baseUrl: "https://example.com/docs/page.md",
  });
  assert(!link.includes("<a "), "asset: should not be accepted for links");
  assertIncludes(link, "fig", "stripping an asset: link should preserve link text");

  const missing = await renderMarkdownToHtml("![missing](asset:missing.png)", {
    assetNames: new Set(["diagram-1.png"]),
  });
  assert(!missing.includes("<img"), "unknown asset names should render like unsafe images");
  assertIncludes(missing, "missing");

  const invalid = await renderMarkdownToHtml("![bad](asset:../diagram-1.png)");
  assert(!invalid.includes("<img"), "invalid asset names should render like unsafe images");
  assertIncludes(invalid, "bad");

  console.log("ok assets: markdown asset: images, link rejection, base_url isolation");
}

function runToolValidationFixture(source) {
  const open = toolDefinitions.find((tool) => tool.name === "open_rabbithole");
  const answer = toolDefinitions.find((tool) => tool.name === "answer_branch");
  assert(open);
  assert(answer);

  open.validateInput({
    title: "Doc",
    content: "![fig](asset:diagram-1.png)",
    assets: [{ name: "diagram-1.png", file_path: source }],
  });
  answer.validateInput({
    session_id: "session",
    request_id: "request",
    content: "![fig](asset:diagram-1.png)",
    assets: [{ name: "diagram-1.png", file_path: source }],
  });
  assert.throws(
    () =>
      open.validateInput({
        title: "Doc",
        content: "Body",
        assets: [{ name: "bad.bmp", file_path: source }],
      }),
    /assets\[0\]\.name/
  );

  console.log("ok assets: tool manifest accepts assets and reports offending entries");
}

async function runSessionFixtures(source, source2) {
  await addAssetsToHole("session-hole", [{ name: "diagram-1.png", file_path: source }]);
  const assetNames = new Set(await listAssets("session-hole"));
  const markdown = "Root asset ![fig](asset:diagram-1.png)";
  const root = {
    id: "root",
    parent_id: null,
    title: "Root",
    markdown,
    contentHtml: await renderMarkdownToHtml(markdown, { assetNames }),
    base_url: null,
    base_url_source: null,
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
    holeId: "session-hole",
    title: "Stage 4 Assets",
    rootId: "root",
    nodes: [root],
    assetNames,
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  try {
    const live = await fetch(session.url);
    assert.equal(live.status, 200);
    assertIncludes(await live.text(), "/assets/diagram-1.png", "live hydration should keep asset URLs");

    const asset = await fetch(`${session.url}/assets/diagram-1.png`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "image/png");
    assert.equal(asset.headers.get("cache-control"), "no-store");
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), PNG_BYTES);

    for (const requestPath of [
      "/assets/../diagram-1.png",
      "/assets/%2e%2e/diagram-1.png",
      "/assets/foo%5Cbar.png",
      "/assets/nested/diagram-1.png",
      "/assets/unknown.png",
    ]) {
      const res = await rawGet(session.url, requestPath);
      assert.equal(res.status, 404, `${requestPath} should be rejected`);
    }

    const exported = await fetch(`${session.url}/export`);
    assert.equal(exported.status, 200);
    const exportHtml = await exported.text();
    assertIncludes(exportHtml, `data:image/png;base64,${PNG_BYTES.toString("base64")}`);
    assert(!exportHtml.includes("/assets/"), "export should not keep live asset URLs");

    const ask = session.handleBranchRequest({
      parent_id: "root",
      request_id: "req-assets",
      node_id: "child-assets",
      question: "Show the asset",
    });
    session.queue.length = 0;
    const partial = await session.answerBranch({
      requestId: ask.request_id,
      content: "Streaming asset ![answer](asset:answer.png)",
      partial: true,
      assets: [{ name: "answer.png", file_path: source2 }],
    });
    assert.equal(partial.partial, true);
    const child = session.nodes.get("child-assets");
    assertIncludes(child.contentHtml, "/assets/answer.png", "streamed HTML should keep asset URLs");
    const progress = session.outboundEvents.at(-1).data;
    assert.equal(progress.type, "node_progress");
    assertIncludes(progress.contentHtml, "/assets/answer.png", "SSE progress should carry asset URLs");

    const streamedAsset = await fetch(`${session.url}/assets/answer.png`);
    assert.equal(streamedAsset.status, 200);
    assert.deepEqual(Buffer.from(await streamedAsset.arrayBuffer()), PNG_BYTES_2);
  } finally {
    await closeAllSessions("stage4_test_complete");
  }

  console.log("ok assets: route serving, route rejection, export inlining, SSE progress");
}

const { source, source2 } = await runStorageFixtures();
await runMarkdownFixtures();
runToolValidationFixture(source);
await runSessionFixtures(source, source2);
console.log("stage4 assets verification passed");
