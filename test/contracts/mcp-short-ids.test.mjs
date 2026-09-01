/** @protects MCP short-id, legacy-id, and copied-id boundary contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-short-ids-"));

const { listRabbitholes } = await import("../../src/node/rabbithole.js");
const { closeAllSessions, getSession } = await import("../../src/node/sessions.js");
const { defaultFsStore } = await import("../../src/node/fs-store.js");
const { toolDefinitions } = await import("../../src/node/tools/manifest.js");

function abortAfter(ms = 25) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function tool(name) {
  const definition = toolDefinitions.find((candidate) => candidate.name === name);
  assert(definition, `missing ${name} tool`);
  return definition;
}

const openTool = tool("open_rabbithole");
const answerTool = tool("answer_branch");

try {
  const newInput = { title: "Short id contract", content: "Root" };
  openTool.validateInput(newInput);
  const opened = await openTool.run(newInput, { signal: abortAfter() });
  assert.equal(opened.status, "cancelled");
  const session = getSession(opened.session_id);
  assert(session);
  assert.match(session.id, /^[a-f0-9]{8}$/);
  assert.match(session.holeId, /^[a-f0-9]{8}$/);
  assert.match(session.rootId, /^[a-f0-9]{8}$/);
  await session.flushSave();
  assert((await listRabbitholes()).holes.some((hole) => hole.hole_id === session.holeId));

  await session.handleBrowserEvent({
    type: "branch_request",
    parent_id: session.rootId,
    request_id: "deadcafe",
    node_id: "c001cafe",
    selected_text: "Root",
    question: "Does copied id cleanup work?",
  });
  const branch = await openTool.run({ hole_id: ` \"${session.holeId}\" ` }, {});
  assert.equal(branch.status, "branch_request");
  const spacedRequestId = `'${branch.request_id.slice(0, 4)} ${branch.request_id.slice(4)}'`;
  const answerInput = {
    session_id: ` \"${session.id}\" `,
    request_id: spacedRequestId,
    content: "Yes.",
    partial: true,
  };
  answerTool.validateInput(answerInput);
  const partial = await answerTool.run(answerInput, {});
  assert.equal(partial.ok, true);
  assert.equal(partial.request_id, branch.request_id);
  assert.equal(session.nodes.get(branch.node_id).markdown, "Yes.");
  await session.close("short_id_contract_complete");

  const legacyHoleId = "12345678-1234-1234-1234-123456789abc";
  const legacyRootId = "abcdefab-cdef-cdef-cdef-abcdefabcdef";
  await defaultFsStore.saveHole({
    hole_id: legacyHoleId,
    title: "Legacy UUID hole",
    root_id: legacyRootId,
    created_at: new Date().toISOString(),
    view_state: null,
    nodes: [{
      id: legacyRootId,
      parent_id: null,
      title: "Legacy root",
      markdown: "Legacy content",
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
    }],
  });
  const legacyInput = { hole_id: `\`${legacyHoleId}\`` };
  openTool.validateInput(legacyInput);
  const resumed = await openTool.run(legacyInput, { signal: abortAfter() });
  assert.equal(resumed.status, "cancelled");
  assert.equal(getSession(resumed.session_id)?.holeId, legacyHoleId);

  console.log("ok MCP ids: new ids are short, copied ids normalize, and legacy UUID holes resume");
} finally {
  await closeAllSessions("short_id_contract_cleanup");
}
