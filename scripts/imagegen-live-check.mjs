#!/usr/bin/env node
/* Spends real ChatGPT image quota. Run only as an explicit live check. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-imagegen-live-"));
const previousDirectory = process.env.RABBITHOLE_DIR;
const timeout = setTimeout(() => {
  console.error(`image generation live check exceeded ${SCRIPT_TIMEOUT_MS}ms`);
  process.exit(1);
}, SCRIPT_TIMEOUT_MS);

process.env.RABBITHOLE_DIR = directory;
process.env.RABBITHOLE_NO_BROWSER = "1";
// Keep HOME untouched so prepareCodexHome can link the real ~/.codex/auth.json.

let session;
try {
  const { createSession, closeAllSessions } = await import("../src/node/mcp/registry.js");
  const { generateImage } = await import("../src/node/mcp/image-gen.js");
  session = await createSession({
    holeId: "imagegen-live-check",
    title: "Image generation live check",
    rootId: "root",
    nodes: [node("root", "answered"), node("pending", "pending")],
    isResume: false,
    renderPage: () => "",
  });
  session.requests.pending("request", "pending");

  const first = await generateImage({
    sessionId: session.id,
    requestId: "request",
    prompt: "A simple labelled diagram of the water cycle with exactly four labels: evaporation, condensation, precipitation, collection. Clean textbook style.",
    aspect: "landscape",
  });
  const firstBody = successText(first);
  const firstPath = path.join(directory, "assets", session.holeId, firstBody.asset);
  const firstBytes = await fs.readFile(firstPath);
  assertPngLargerThan512(firstBytes, firstBody.asset);
  assert.ok(firstBody.elapsed_ms < 180000, `first image took ${firstBody.elapsed_ms}ms`);

  const firstProvenance = session.nodes.get("pending").extensions.generated_images[firstBody.asset];
  const second = await generateImage({
    sessionId: session.id,
    requestId: "request",
    prompt: "Change only the title text to 'Water cycle'; keep everything else identical.",
    editOf: firstBody.asset,
  });
  const secondBody = successText(second);
  const secondPath = path.join(directory, "assets", session.holeId, secondBody.asset);
  const secondBytes = await fs.readFile(secondPath);
  assertPngLargerThan512(secondBytes, secondBody.asset);
  assert.ok(secondBody.elapsed_ms < 180000, `second image took ${secondBody.elapsed_ms}ms`);

  const secondProvenance = session.nodes.get("pending").extensions.generated_images[secondBody.asset];
  assert.equal(secondProvenance.thread_id, firstProvenance.thread_id);
  assert.equal(secondProvenance.edit_of, firstBody.asset);
  console.log(`first asset: ${firstPath} (${firstBody.width}x${firstBody.height}, ${firstBody.elapsed_ms}ms)`);
  console.log(`second asset: ${secondPath} (${secondBody.width}x${secondBody.height}, ${secondBody.elapsed_ms}ms)`);
  await closeAllSessions("live_check_complete");
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  if (session && !session.isClosed()) await session.close("live_check_complete").catch(() => {});
  await fs.rm(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.RABBITHOLE_DIR;
  else process.env.RABBITHOLE_DIR = previousDirectory;
}

function successText(result) {
  assert.equal(result.content.length, 2, JSON.stringify(result));
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, "ok");
  return body;
}

function assertPngLargerThan512(bytes, asset) {
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR", `${asset} is not a PNG`);
  assert.ok(bytes.readUInt32BE(16) > 512, `${asset} width is not greater than 512`);
  assert.ok(bytes.readUInt32BE(20) > 512, `${asset} height is not greater than 512`);
}

function node(id, status) {
  return {
    id,
    parent_id: id === "root" ? null : "root",
    title: id,
    markdown: status === "pending" ? "" : id,
    base_url: null,
    base_url_source: null,
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    status,
    read: true,
    created_at: new Date().toISOString(),
  };
}
