/** @protects assets capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { renderMarkdownToHtml } from "../../src/core/markdown.js";
import { MAX_ASSET_BYTES } from "../../src/core/assets.js";
import { extractSnapshotPayload, SNAPSHOT_PAYLOAD_OPEN } from "../../src/core/portable-import.js";
import { validatePortableProjection } from "../../src/core/portable-projection.js";
import { buildCanvasHtml } from "../../src/node/mcp/http/page.js";
import { createSession, closeAllSessions } from "../../src/node/mcp/registry.js";
import {
  addAssetsToHole,
  defaultFsStore,
  resolveAsset,
} from "../../src/node/mcp/store/fs-store.js";
import { toolDefinitions } from "../../src/node/mcp/tools.js";
import { buildSessionExportHtml } from "../support/session-export.mjs";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-assets-"));

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
  assert.deepEqual(await defaultFsStore.listAssets("storage-hole"), ["diagram-1.png"]);
  assert.deepEqual(await fs.readFile(await resolveAsset("storage-hole", "diagram-1.png")), PNG_BYTES);

  await addAssetsToHole("storage-hole", [{ name: "diagram-1.png", file_path: source2 }]);
  assert.deepEqual(await fs.readFile(await resolveAsset("storage-hole", "diagram-1.png")), PNG_BYTES_2);

  await defaultFsStore.deleteAsset("storage-hole", "diagram-1.png");
  assert.equal(await resolveAsset("storage-hole", "diagram-1.png"), null);

  await defaultFsStore.putAsset("atomic-hole", "paste-atomic.png", PNG_BYTES);
  await assert.rejects(() => defaultFsStore.putAsset("atomic-hole", "paste-atomic.png", PNG_BYTES_2), /already exists/);
  assert.deepEqual(await defaultFsStore.getAsset("atomic-hole", "paste-atomic.png"), PNG_BYTES,
    "atomic putAsset must preserve the first file when a name already exists");

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

  console.log("ok assets: storage copy, atomic no-overwrite put, delete, and validation failures");
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

function runToolInputCapFixture() {
  const open = toolDefinitions.find((tool) => tool.name === "open_rabbithole");
  const answer = toolDefinitions.find((tool) => tool.name === "answer_branch");
  assert(open);
  assert(answer);
  const openSchema = z.object(open.input);
  const answerSchema = z.object(answer.input);

  assert.throws(
    () => openSchema.parse({ title: "T".repeat(2001), content: "Body" }),
    (/** @type {any} */ error) => error?.issues?.some((issue) => issue.path.join(".") === "title" && /2000/.test(issue.message)),
    "over-cap title should identify title and its 2000-character maximum",
  );
  assert.throws(
    () => answerSchema.parse({ session_id: "session", request_id: "request", content: "x".repeat(10485761) }),
    (/** @type {any} */ error) => error?.issues?.some((issue) => issue.path.join(".") === "content" && /10485760/.test(issue.message)),
    "over-cap content should identify content and its 10 MB maximum",
  );

  console.log("ok assets: MCP string caps reject oversized title and content legibly");
}

async function runSessionFixtures(source, source2) {
  await addAssetsToHole("session-hole", [
    { name: "diagram-1.png", file_path: source },
    { name: "unused.png", file_path: source2 },
  ]);
  const assetNames = new Set(await defaultFsStore.listAssets("session-hole"));
  const markdown = "Root asset ![fig](asset:diagram-1.png)";
  const root = {
    id: "root",
    parent_id: null,
    title: "Root",
    markdown,
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
    title: "Asset Contract",
    rootId: "root",
    nodes: [root],
    assetNames,
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  try {
    const live = await fetch(session.url);
    assert.equal(live.status, 200);
    const liveHtml = await live.text();
    assertIncludes(liveHtml, "asset:diagram-1.png", "live hydration should carry markdown asset refs");
    assert(!liveHtml.includes('"contentHtml"'), "live hydration should not carry rendered HTML");

    const asset = await fetch(`${session.url}/assets/diagram-1.png`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "image/png");
    assert.equal(asset.headers.get("cache-control"), "private, max-age=0, must-revalidate");
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    assert.equal(asset.headers.get("accept-ranges"), "bytes");
    assert.equal(Number(asset.headers.get("content-length")), PNG_BYTES.length);
    const assetEtag = asset.headers.get("etag");
    assert(assetEtag, "served assets should expose a stable validator");
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), PNG_BYTES);

    const unchanged = await fetch(`${session.url}/assets/diagram-1.png`, { headers: { "If-None-Match": assetEtag } });
    assert.equal(unchanged.status, 304, "unchanged assets should reuse the browser's cached body");
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);

    const assetRange = await fetch(`${session.url}/assets/diagram-1.png`, { headers: { Range: "bytes=2-5", "If-Range": assetEtag } });
    assert.equal(assetRange.status, 206);
    assert.equal(assetRange.headers.get("content-range"), `bytes 2-5/${PNG_BYTES.length}`);
    assert.equal(Number(assetRange.headers.get("content-length")), 4);
    assert.deepEqual(Buffer.from(await assetRange.arrayBuffer()), PNG_BYTES.subarray(2, 6));
    const staleRange = await fetch(`${session.url}/assets/diagram-1.png`, { headers: { Range: "bytes=2-5", "If-Range": '"stale"' } });
    assert.equal(staleRange.status, 200, "a stale range validator should fall back to the complete current asset");
    assert.deepEqual(Buffer.from(await staleRange.arrayBuffer()), PNG_BYTES);
    const assetHead = await fetch(`${session.url}/assets/diagram-1.png`, { method: "HEAD" });
    assert.equal(assetHead.status, 200);
    assert.equal(Number(assetHead.headers.get("content-length")), PNG_BYTES.length);
    assert.equal((await assetHead.arrayBuffer()).byteLength, 0);

    const uploaded = await fetch(`${session.url}/assets/paste-contract.png`, {
      method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_BYTES_2,
    });
    assert.equal(uploaded.status, 200);
    assert.deepEqual(await uploaded.json(), { ok: true, name: "paste-contract.png" });
    assert.equal(session.assetNames.has("paste-contract.png"), true, "PUT should register the asset on the live hole");
    const uploadedGet = await fetch(`${session.url}/assets/paste-contract.png`);
    assert.equal(uploadedGet.headers.get("content-type"), "image/png", "served content type comes from the validated extension");
    assert.deepEqual(Buffer.from(await uploadedGet.arrayBuffer()), PNG_BYTES_2);

    const duplicate = await fetch(`${session.url}/assets/paste-contract.png`, {
      method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_BYTES,
    });
    assert.equal(duplicate.status, 409, "PUT must reject an existing pasted-image name");
    assert.deepEqual(await defaultFsStore.getAsset(session.holeId, "paste-contract.png"), PNG_BYTES_2,
      "a rejected duplicate PUT must not overwrite the original asset");
    const nonPaste = await fetch(`${session.url}/assets/figure.png`, {
      method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_BYTES,
    });
    assert.equal(nonPaste.status, 400, "the browser PUT seam must be restricted to paste- image names");

    const wrongType = await fetch(`${session.url}/assets/paste-wrong.png`, {
      method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: PNG_BYTES,
    });
    assert.equal(wrongType.status, 415);
    assert.match((await wrongType.json()).error, /Content-Type must be image\/png/);
    const badName = await fetch(`${session.url}/assets/Bad.png`, {
      method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_BYTES,
    });
    assert.equal(badName.status, 400);
    const tooLarge = await fetch(`${session.url}/assets/paste-too-large.png`, {
      method: "PUT", headers: { "Content-Type": "image/png" }, body: Buffer.alloc(MAX_ASSET_BYTES + 1),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(await defaultFsStore.getAsset(session.holeId, "paste-too-large.png"), null);

    const forbiddenDelete = await fetch(`${session.url}/assets/diagram-1.png`, { method: "DELETE" });
    assert.equal(forbiddenDelete.status, 400, "DELETE must not remove non-pasted assets");
    assert.deepEqual(await defaultFsStore.getAsset(session.holeId, "diagram-1.png"), PNG_BYTES);
    const deleted = await fetch(`${session.url}/assets/paste-contract.png`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true, name: "paste-contract.png" });
    assert.equal(session.assetNames.has("paste-contract.png"), false);
    assert.equal((await fetch(`${session.url}/assets/paste-contract.png`)).status, 404);
    const deletedAgain = await fetch(`${session.url}/assets/paste-contract.png`, { method: "DELETE" });
    assert.equal(deletedAgain.status, 200, "valid pasted-image DELETE is idempotent");

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

    const exportHtml = await buildSessionExportHtml(session);
    const projection = validatePortableProjection(JSON.parse(extractSnapshotPayload(exportHtml)));
    assert.equal(exportHtml.split(SNAPSHOT_PAYLOAD_OPEN).length - 1, 1, "export should contain exactly one inert payload");
    assertIncludes(exportHtml, "RabbitholeFrozenClient.startPortableSnapshot", "export should use the canonical portable bootstrap");
    assert.deepEqual(Object.keys(projection.assets), ["diagram-1.png"], "export should include referenced assets only");
    assert.equal(projection.assets["diagram-1.png"], PNG_BYTES.toString("base64"));
    assert(!exportHtml.includes(PNG_BYTES_2.toString("base64")), "export should omit unreferenced session assets");
    assert(!/\b(?:src|href)=["']\/assets\//.test(exportHtml), "export should not keep live asset URLs in rendered attributes");

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
    const childHtml = await renderMarkdownToHtml(child.markdown, { assetNames: session.assetNames });
    assertIncludes(childHtml, "/assets/answer.png", "streamed markdown should render asset URLs");
    const progress = session.outboundEvents.at(-1).data;
    assert.equal(progress.type, "node_progress");
    assertIncludes(progress.markdown, "asset:answer.png", "SSE progress should carry markdown asset refs");
    assert.equal(Object.hasOwn(progress, "contentHtml"), false, "SSE progress should not carry rendered HTML");

    const streamedAsset = await fetch(`${session.url}/assets/answer.png`);
    assert.equal(streamedAsset.status, 200);
    assert.deepEqual(Buffer.from(await streamedAsset.arrayBuffer()), PNG_BYTES_2);
  } finally {
    await closeAllSessions("asset_contract_test_complete");
  }

  console.log("ok assets: GET/PUT/DELETE validation, no-overwrite storage, canonical referenced-only export, SSE progress");
}

const { source, source2 } = await runStorageFixtures();
await runMarkdownFixtures();
runToolValidationFixture(source);
runToolInputCapFixture();
await runSessionFixtures(source, source2);
console.log("asset contract verification passed");
