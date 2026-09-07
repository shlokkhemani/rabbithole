/** @protects generate_image materialization and session orchestration. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-generate-image-integration-"));
const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-generate-image-home-"));
const fixture = path.join(root, "test/integration/fixtures/fake-codex-image.mjs");
const fixtureLog = path.join(directory, "fake-image.json");
process.env.RABBITHOLE_DIR = directory;
process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_CODEX_BIN = fixture;
process.env.FAKE_CODEX_IMAGE_LOG = fixtureLog;
process.env.HOME = homeDirectory;

const { createSession, closeAllSessions } = await import("../../src/node/mcp/registry.js");
const { generateImage } = await import("../../src/node/mcp/image-gen.js");

const session = await createSession({
  holeId: "generate-image-integration",
  title: "Images",
  rootId: "root",
  nodes: [node("root", "answered"), node("pending", "pending")],
  isResume: false,
  renderPage: () => "",
});
session.requests.pending("request", "pending");

try {
  const beforeHappy = session.outboundEvents.length;
  const happy = await generateImage({
    sessionId: session.id,
    requestId: "request",
    prompt: "A labelled water cycle. Keep it clear.",
    aspect: "landscape",
    caption: "The water cycle",
  });
  const happyText = successText(happy);
  assert.match(happyText.asset, /^gen-[a-z0-9]{8}\.png$/);
  assert.equal(happyText.markdown, `![The water cycle](asset:${happyText.asset})`);
  assert.equal(happyText.width, 2);
  assert.equal(happyText.height, 3);
  assert.equal(happy.content[1].type, "image");
  assert.equal(happy.content[1].mimeType, "image/png");
  const storedPath = path.join(directory, "assets", session.holeId, happyText.asset);
  assert.deepEqual(await fs.readFile(storedPath), Buffer.from(happy.content[1].data, "base64"));
  assert.equal(session.assetNames.has(happyText.asset), true);
  const provenance = session.nodes.get("pending").extensions.generated_images[happyText.asset];
  assert.equal(provenance.prompt, "A labelled water cycle. Keep it clear.");
  assert.equal(provenance.aspect, "landscape");
  assert.equal(provenance.revised_prompt, "I will draw a labelled diagram.");
  assert.equal(typeof provenance.thread_id, "string");
  assert.equal(Number.isNaN(Date.parse(provenance.created_at)), false);
  assert.deepEqual(workStates(beforeHappy), ["drawing", "thinking"]);
  const happyLog = await readLog();
  assert.equal(happyLog.CODEX_HOME, path.join(directory, "codex-image-home"));
  assert.match(happyLog.stdin, /^Use your built-in image generation tool to generate exactly one image\./);
  assert.match(happyLog.stdin, /A labelled water cycle\. Keep it clear\./);
  assert.match(happyLog.stdin, /Make it a landscape \(wide\) image\./);
  assert.match(happyLog.stdin, /single word DONE\.$/);

  const edit = await generateImage({
    sessionId: session.id,
    requestId: "request",
    prompt: "Make only the labels larger.",
    editOf: happyText.asset,
  });
  successText(edit);
  const editLog = await readLog();
  assert.deepEqual(editLog.argv.slice(0, 3), ["exec", "resume", provenance.thread_id]);
  assert.deepEqual(editLog.argv.slice(3, 7), ["--skip-git-repo-check", "--json", "-c", "mcp_servers={}"]);
  assert.equal(editLog.argv.at(-1), "-");

  const reference = await generateImage({
    sessionId: session.id,
    requestId: "request",
    prompt: "Redraw this cleanly.",
    reference: happyText.asset,
  });
  successText(reference);
  const referenceLog = await readLog();
  const imageIndex = referenceLog.argv.indexOf("-i");
  assert(imageIndex > 0);
  assert.equal(referenceLog.argv[imageIndex + 1], storedPath);
  assert.equal(referenceLog.argv[imageIndex + 2], "-");

  process.env.FAKE_CODEX_IMAGE_MODE = "signed_out";
  assertErrorCode(await call(), "codex_signed_out");

  process.env.FAKE_CODEX_IMAGE_MODE = "quota";
  const quota = assertErrorCode(await call(), "image_quota");
  assert.equal(quota.resets_at, "2026-09-08T00:00:00Z");

  process.env.FAKE_CODEX_IMAGE_MODE = "nopng";
  assertErrorCode(await call(), "generation_failed");

  process.env.FAKE_CODEX_IMAGE_MODE = "hang";
  process.env.RABBITHOLE_IMAGE_DEADLINE_MS = "40";
  assertErrorCode(await call(), "timeout");
  const hangLog = await readLog();
  assert.throws(() => process.kill(hangLog.pid, 0), { code: "ESRCH" });

  delete process.env.FAKE_CODEX_IMAGE_MODE;
  delete process.env.RABBITHOLE_IMAGE_DEADLINE_MS;
  process.env.RABBITHOLE_CODEX_BIN = path.join(directory, "codex-does-not-exist");
  assertErrorCode(await call(), "codex_missing");

  process.env.RABBITHOLE_CODEX_BIN = fixture;
  process.env.FAKE_CODEX_IMAGE_MODE = "hang";
  const closingLogPath = path.join(directory, "fake-image-closing.json");
  process.env.FAKE_CODEX_IMAGE_LOG = closingLogPath;
  const closingSession = await createSession({
    holeId: "generate-image-closing",
    title: "Closing",
    rootId: "root",
    nodes: [node("root", "answered"), node("pending", "pending")],
    isResume: false,
    renderPage: () => "",
  });
  closingSession.requests.pending("request", "pending");
  const closingCall = generateImage({
    sessionId: closingSession.id,
    requestId: "request",
    prompt: "Draw until the session closes.",
  });
  await waitForFile(closingLogPath);
  const closingLog = JSON.parse(await fs.readFile(closingLogPath, "utf8"));
  await closingSession.close("test_close_during_generation");
  assertErrorCode(await closingCall, "session_closed");
  assert.throws(() => process.kill(closingLog.pid, 0), { code: "ESRCH" });

  console.log("ok generate_image integration: storage, provenance, work state, generate/edit/reference CLI, and typed failures");
} finally {
  delete process.env.FAKE_CODEX_IMAGE_MODE;
  delete process.env.RABBITHOLE_IMAGE_DEADLINE_MS;
  await session.close("test_complete");
  await closeAllSessions("test_complete");
  await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(homeDirectory, { recursive: true, force: true });
}

function call() {
  return generateImage({
    sessionId: session.id,
    requestId: "request",
    prompt: "Draw a test image.",
  });
}

function successText(result) {
  assert.equal(result.content.length, 2, JSON.stringify(result));
  assert.equal(result.content[0].type, "text");
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, "ok");
  return body;
}

function assertErrorCode(result, code) {
  assert.equal(result.content.length, 1, JSON.stringify(result));
  assert.equal(result.content[0].type, "text");
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, "error");
  assert.equal(body.code, code);
  return body;
}

function workStates(start) {
  return session.outboundEvents.slice(start)
    .map((event) => event.data)
    .filter((event) => event.type === "node_work_state" && event.node_id === "pending")
    .map((event) => event.state);
}

async function readLog() {
  return JSON.parse(await fs.readFile(fixtureLog, "utf8"));
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await fs.access(filePath); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
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
