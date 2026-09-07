/** @protects generate_image MCP contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-generate-image-contract-"));
process.env.RABBITHOLE_DIR = directory;
process.env.RABBITHOLE_NO_BROWSER = "1";

const { validateImageAssetName } = await import("../../src/core/assets.js");
const { mintGeneratedImageName } = await import("../../src/node/mcp/image-gen.js");
const { toolDefinitions } = await import("../../src/node/mcp/tools.js");
const { createSession, closeAllSessions } = await import("../../src/node/mcp/registry.js");
const { formatToolSuccess } = await import("../../src/node/mcp/tool-result.js");

const tool = toolDefinitions.find((definition) => definition.name === "generate_image");
assert(tool, "generate_image must be registered");
const schema = z.object(tool.input);

assert.equal(schema.parse({ session_id: "s", request_id: "r", prompt: "p" }).prompt, "p");
assert.throws(() => schema.parse({ session_id: "s", request_id: "r", prompt: "x".repeat(4001) }));
assert.throws(() => schema.parse({ session_id: "s", request_id: "r", prompt: "p", caption: "x".repeat(141) }));
assert.throws(() => schema.parse({ session_id: "s", request_id: "r", prompt: "p", aspect: "wide" }));
for (const aspect of ["square", "landscape", "portrait"]) {
  assert.equal(schema.parse({ session_id: "s", request_id: "r", prompt: "p", aspect }).aspect, aspect);
}
assert.throws(
  () => tool.validateInput({ session_id: "s", request_id: "r", prompt: "p", edit_of: "old.png", reference: "ref.png" }),
  /mutually exclusive/,
);

const closed = await tool.run({ session_id: "gone", request_id: "request", prompt: "Draw it" });
assertErrorCode(closed, "session_closed");

const session = await createSession({
  holeId: "generate-image-contract",
  title: "Contract",
  rootId: "root",
  nodes: [node("root", "answered"), node("pending", "pending")],
  isResume: false,
  renderPage: () => "",
});
try {
  const notPending = await tool.run({ session_id: session.id, request_id: "missing", prompt: "Draw it" });
  assertErrorCode(notPending, "request_not_pending");
  session.requests.pending("request", "pending");
  const badReference = await tool.run({
    session_id: session.id,
    request_id: "request",
    prompt: "Draw it",
    reference: "/tmp/not-issued-by-rabbithole.png",
  });
  assertErrorCode(badReference, "bad_reference");

  session.engine.patchExtension("pending", "generated_images", {
    "gen-old00001.png": { thread_id: "thread-old" },
  });
  const current = session.engine.nodes.get("pending").extensions.generated_images;
  session.engine.patchExtension("pending", "generated_images", {
    ...current,
    "gen-new00001.png": { thread_id: "thread-new" },
  });
  assert.deepEqual(Object.keys(session.engine.nodes.get("pending").extensions.generated_images).sort(), [
    "gen-new00001.png", "gen-old00001.png",
  ]);
} finally {
  await session.close("test_complete");
}

for (let index = 0; index < 50; index += 1) {
  assert.equal(validateImageAssetName(mintGeneratedImageName()).startsWith("gen-"), true);
}

const explicit = { content: [{ type: "text", text: "ok" }, { type: "image", data: "AA==", mimeType: "image/png" }] };
assert.equal(formatToolSuccess({ explicitContent: true }, explicit), explicit);
assert.deepEqual(formatToolSuccess({ name: "list_rabbitholes" }, { holes: [], total: 0 }), {
  content: [{ type: "text", text: '{"holes":[],"total":0}' }],
});

await closeAllSessions("test_complete");
await fs.rm(directory, { recursive: true, force: true });
console.log("ok generate_image contracts: schema, typed failures, names, extension merge, and result passthrough");

function assertErrorCode(result, code) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(JSON.parse(result.content[0].text).code, code);
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
