import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMarkdownRenderer, encodeBase64Utf8 } from "../../src/core/markdown.js";
import { NEWER_SCHEMA_MESSAGE } from "../../src/core/schema.js";
import { extractSnapshotPayload, SNAPSHOT_PAYLOAD_OPEN } from "../../src/core/portable-import.js";
import { snapshotProjectionToFrozenHydration } from "../../src/core/snapshot-projection.js";
import { validatePortableProjection } from "../../src/core/portable-projection.js";
import { openRabbithole, answerBranch } from "../../src/node/index.js";
import { closeAllSessions, getSession } from "../../src/node/sessions.js";
import { FsStore } from "../../src/node/fs-store.js";
import { importSnapshotFile } from "../../src/web/portable.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_MAX_BLOCK_MS = "50";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-mcp-markdown-wire-"));

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 8, 8, 8]);

function assertIncludes(haystack, needle, message) {
  assert(haystack.includes(needle), message || `expected to include ${needle}`);
}

function parseHydration(html) {
  const marker = "var hydration = ";
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, "page should include inline hydration");
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";\n", jsonStart);
  assert.notEqual(jsonEnd, -1, "hydration assignment should terminate");
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

function assertNoContentHtml(value, label) {
  assert.equal(JSON.stringify(value).includes("contentHtml"), false, `${label} should not carry contentHtml`);
}

function assertKeepListeningShape(result, session) {
  assert.deepEqual(Object.keys(result).sort(), ["hole_id", "instruction", "session_id", "status"]);
  assert.equal(result.status, "keep_listening");
  assert.equal(result.session_id, session.id);
  assert.equal(result.hole_id, session.holeId);
  assert.match(result.instruction, /open_rabbithole/);
  assert.match(result.instruction, new RegExp(session.holeId));
}

function assertBranchRequestShape(result, session, requestId, nodeId) {
  assert.deepEqual(Object.keys(result).sort(), [
    "lens",
    "lineage",
    "node_id",
    "parent_node_id",
    "parent_node_title",
    "question",
    "request_id",
    "selected_text",
    "session_id",
    "status",
  ]);
  assert.equal(result.status, "branch_request");
  assert.equal(result.session_id, session.id);
  assert.equal(result.request_id, requestId);
  assert.equal(result.node_id, nodeId);
  assert.equal(result.parent_node_id, session.rootId);
  assert.equal(result.parent_node_title, "Markdown Wire Root");
  assert.equal(result.selected_text, "Root");
  assert.equal(result.question, "Explain root");
  assert.equal(result.lens, null);
  assert.deepEqual(result.lineage, ["Markdown Wire Root"]);
}

function assertSessionClosedShape(result, sessionId) {
  assert.deepEqual(result, { status: "session_closed", session_id: sessionId });
}

async function postEvent(session, payload) {
  const res = await fetch(`${session.url}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function runRendererGoldenFixtures() {
  const renderer = createMarkdownRenderer({
    encodeBase64: encodeBase64Utf8,
    resolveAssetUrl: (name) => `/assets/${name}`,
  });
  const fixtures = [
    {
      name: "math",
      markdown: "Inline $x$.\n\n$$\ny=x^2\n$$",
      assert(html) {
        assertIncludes(html, 'class="katex"');
        assertIncludes(html, 'class="katex-display"');
      },
    },
    {
      name: "code",
      markdown: "```js\nconst n = 1 < 2;\n```",
      assert(html) {
        assertIncludes(html, 'class="language-js hljs"');
        assertIncludes(html, "hljs-keyword");
        assertIncludes(html, "&lt;");
      },
    },
    {
      name: "show fence",
      markdown: "```show\n<div onclick=\"bad()\">show</div>\n```",
      assert(html) {
        assertIncludes(html, 'class="viz"');
        assertIncludes(html, 'data-viz="show"');
        assert.equal(Buffer.from(html.match(/data-src="([^"]+)"/)[1], "base64").toString("utf8"), '<div onclick="bad()">show</div>');
      },
    },
    {
      name: "asset ref",
      markdown: "![diagram](asset:diagram-1.png)",
      assert(html) {
        assertIncludes(html, 'src="/assets/diagram-1.png"');
      },
    },
    {
      name: "hostile raw html",
      markdown: '<section onclick="bad()"><script>alert(1)</script></section>',
      assert(html) {
        assertIncludes(html, "&lt;section onclick=&quot;bad()&quot;&gt;");
        assert(!html.includes("<section"));
        assert(!html.includes("<script>"));
      },
    },
    {
      name: "javascript links",
      markdown: "[bad](java\tscript:alert(1))\n\n![bad](javascript:alert(1))",
      assert(html) {
        assert(!html.includes("<a "));
        assert(!html.includes("<img"));
        assertIncludes(html, "bad");
      },
    },
  ];
  for (const fixture of fixtures) fixture.assert(renderer.renderMarkdownToHtml(fixture.markdown));

  const clientBundle = await fs.readFile(new URL("../../dist/client.js", import.meta.url), "utf8");
  assertIncludes(clientBundle, "rabbithole-shared-markdown-renderer-v1", "browser bundle should contain the shared renderer sentinel");
  console.log("ok MCP markdown wire: shared renderer golden/security fixtures and bundle sentinel");
}

async function runMarkdownWireFixture() {
  const sourceDir = await fs.mkdtemp(path.join(process.env.RABBITHOLE_DIR, "assets-"));
  const imagePath = path.join(sourceDir, "diagram-1.png");
  await fs.writeFile(imagePath, PNG_BYTES);

  const rootMarkdown = [
    "# Root",
    "",
    "Inline $a+b$ and display:",
    "",
    "$$",
    "a^2+b^2=c^2",
    "$$",
    "",
    "```js",
    "const n = 1 < 2;",
    "```",
    "",
    "```show",
    "<div>diagram</div>",
    "```",
    "",
    "```check",
    '{"question":"Which number is even?","options":["3","4"],"answer":1,"explanation":"Four is divisible by two."}',
    "```",
    "",
    "![diagram](asset:diagram-1.png)",
  ].join("\n");

  const opened = await openRabbithole({
    title: "Markdown Wire Root",
    content: rootMarkdown,
    assets: [{ name: "diagram-1.png", file_path: imagePath }],
  });
  const session = getSession(opened.session_id);
  assert(session, "open_rabbithole should leave a live session");
  assertKeepListeningShape(opened, session);

  const liveRes = await fetch(session.url);
  assert.equal(liveRes.status, 200);
  const liveHtml = await liveRes.text();
  const liveHydration = parseHydration(liveHtml);
  assertNoContentHtml(liveHydration, "live hydration");
  assert.match(liveHydration.nodes[0].markdown, /```show id=[a-z0-9]{4,8}\n/);
  const checkId = liveHydration.nodes[0].markdown.match(/```check id=([a-z0-9]{4,8})\n/)?.[1];
  assert(checkId, "completed authoring should mint Check identity");
  assert(!liveHtml.includes('<h1 id="root">Root</h1>'), "live page should not include server-rendered root markdown HTML");

  assert.deepEqual(await postEvent(session, {
    type: "block_state", node_id: session.rootId, block_id: checkId,
    state: { attempts: 1, last: { option: 1, correct: true }, revealed: true },
  }), { ok: true });
  await session.flushSave();
  const persistedCheck = await new FsStore().loadHole(session.holeId);
  assert.deepEqual(persistedCheck.nodes.find((node) => node.id === session.rootId).extensions.learn[checkId], {
    attempts: 1, last: { option: 1, correct: true }, revealed: true,
  });
  assert.equal(JSON.stringify(session.buildRehydrationPayload()).includes("extensions"), false, "agent rehydration stays lean");
  assert.equal(JSON.stringify(session.buildRehydrationPayload()).includes("attempts"), false, "learner state never enters agent rehydration");

  const requestId = "req-markdown-wire";
  const nodeId = "node-markdown-wire";
  const postResult = await postEvent(session, {
    type: "branch_request",
    request_id: requestId,
    node_id: nodeId,
    parent_id: session.rootId,
    selected_text: "Root",
    question: "Explain root",
    lens: null,
    anchor: { offset_start: 2, offset_end: 6 },
    branch_type: "selection",
    position: { x: 500, y: 0 },
    size: { w: 420, h: 460 },
  });
  assert.deepEqual(postResult, { ok: true, node_id: nodeId, request_id: requestId });

  const branch = await openRabbithole({ holeId: session.holeId });
  assertBranchRequestShape(branch, session, requestId, nodeId);

  const partialOne = await answerBranch({
    sessionId: session.id,
    requestId,
    content: "Partial $x$",
    partial: true,
  });
  assert.deepEqual(partialOne, { ok: true, node_id: nodeId, request_id: requestId, partial: true });
  let progress = session.outboundEvents.at(-1).data;
  assert.equal(progress.type, "node_progress");
  assert.equal(progress.node_id, nodeId);
  assert.equal(progress.markdown, "Partial $x$");
  assert.equal(Object.hasOwn(progress, "contentHtml"), false);

  await answerBranch({
    sessionId: session.id,
    requestId,
    content: "\n\n```show\n<div>open",
    partial: true,
  });
  progress = session.outboundEvents.at(-1).data;
  assert.equal(progress.markdown, "Partial $x$\n\n```show\n<div>open");
  assertNoContentHtml(progress, "node_progress");

  const afterFinal = await answerBranch({
    sessionId: session.id,
    requestId,
    title: "Markdown Wire Answer",
    content: "\n</div>\n```\n\nDone.",
  });
  assertKeepListeningShape(afterFinal, session);
  const answered = session.outboundEvents.find((event) => event.data.type === "node_answered" && event.data.node_id === nodeId)?.data;
  assert(answered, "node_answered event should be broadcast");
  assertNoContentHtml(answered, "node_answered");
  assertIncludes(answered.markdown, "Done.");
  assert.match(answered.markdown, /```show id=[a-z0-9]{4,8}\n/, "completed generation mints block identity before persistence");
  await session.flushSave();
  const persistedAfterAnswer = await new FsStore().loadHole(session.holeId);
  assert.equal(persistedAfterAnswer.nodes.find((node) => node.id === nodeId).markdown, answered.markdown);

  const reloaded = await fetch(session.url);
  const rehydration = parseHydration(await reloaded.text());
  assertNoContentHtml(rehydration, "reloaded hydration");
  assert.equal(rehydration.nodes.find((node) => node.id === nodeId).markdown, answered.markdown);

  const exported = await fetch(`${session.url}/export`);
  assert.equal(exported.status, 200);
  const exportHtml = await exported.text();
  const projection = validatePortableProjection(JSON.parse(extractSnapshotPayload(exportHtml)));
  const exportHydration = snapshotProjectionToFrozenHydration(projection);
  assert.equal(exportHtml.split(SNAPSHOT_PAYLOAD_OPEN).length - 1, 1, "export should contain exactly one inert payload");
  assertNoContentHtml(projection, "export projection");
  assert(projection.hole.nodes.every((node) => Object.keys(node.extensions).length === 0), "snapshot payload clears learner extensions");
  assertIncludes(exportHtml, "RabbitholeFrozenClient.startPortableSnapshot", "export should use the portable snapshot bootstrap");
  assert.deepEqual(Object.keys(projection.assets), ["diagram-1.png"], "export should include referenced assets only");
  assert.equal(projection.assets["diagram-1.png"], PNG_BYTES.toString("base64"));
  assert(!exportHtml.includes("new EventSource"), "export should not include EventSource wiring");
  assert(!exportHtml.includes("/sse"), "export should not include SSE routes");
  assert(!exportHtml.includes("/assets/"), "export should not include live asset routes");

  const frozenRenderer = createMarkdownRenderer({
    encodeBase64: encodeBase64Utf8,
    resolveAssetUrl: (name) => exportHydration.asset_data[name] || "data:,",
  });
  const frozenRootHtml = frozenRenderer.renderMarkdownToHtml(exportHydration.nodes[0].markdown);
  assertIncludes(frozenRootHtml, 'class="katex-display"', "frozen markdown should render math");
  assertIncludes(frozenRootHtml, 'class="language-js hljs"', "frozen markdown should render highlighted code");
  assertIncludes(frozenRootHtml, 'class="viz"', "frozen markdown should render show placeholders");
  assertIncludes(frozenRootHtml, 'data-viz="check"', "frozen markdown should retain interactive Check placeholders without learner state");
  assertIncludes(frozenRootHtml, `src="data:image/png;base64,${PNG_BYTES.toString("base64")}"`, "frozen markdown should render data URI images");

  const importStore = new FsStore();
  const imported = await importSnapshotFile(importStore, exportHtml);
  assert.equal(imported.asset_count, 1, "web import should restore the MCP snapshot asset");
  const importedHole = await importStore.loadHole(imported.hole_id);
  assert.equal(importedHole.nodes.find((node) => node.id === nodeId).markdown, answered.markdown, "web import should restore the MCP-authored branch");

  session.close("markdown_wire_done");
  assertSessionClosedShape(await answerBranch({ sessionId: session.id, requestId, content: "late" }), session.id);
  console.log("ok MCP markdown wire: markdown-only hydration/SSE, tool shapes, streaming, canonical export, and web-import round trip");
}

try {
  await runRendererGoldenFixtures();
  await runMarkdownWireFixture();
  await fs.writeFile(path.join(process.env.RABBITHOLE_DIR, "future-mcp.json"), JSON.stringify({ schema_version: 3 }));
  await assert.rejects(
    () => openRabbithole({ holeId: "future-mcp" }),
    (error) => error?.message === NEWER_SCHEMA_MESSAGE,
  );
  console.log("ok MCP markdown wire: resume refuses newer schemas with the update-to-open message");
} finally {
  await closeAllSessions("markdown_wire_test_complete");
}

console.log("MCP markdown wire verification passed");
