import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_MAX_BLOCK_MS = "50";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-stage7-"));

const { openRabbithole, answerBranch } = await import("../../src/node/index.js");
const { closeAllSessions, getSession } = await import("../../src/node/sessions.js");
const { saveHole } = await import("../../src/node/fs-store.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detachEvents(session) {
  return session.outboundEvents.filter((event) => event.data.type === "agent_status" && event.data.attached === false);
}

function rootNode(id = "root") {
  return {
    id,
    parent_id: null,
    title: "Root",
    markdown: "Root",
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
}

async function runKeepListeningAndLiveReattachFixture() {
  const first = await openRabbithole({ title: "Stage 7 Rearm", content: "Root" });
  assert.equal(first.status, "keep_listening");
  assert(first.hole_id, "keep_listening should include hole_id");
  assert(first.session_id, "keep_listening should include session_id");
  assert.match(first.instruction, /open_rabbithole/);
  assert.match(first.instruction, new RegExp(first.hole_id));

  const session = getSession(first.session_id);
  assert(session, "new hole should still have a live session after rearm");
  const originalUrl = session.url;
  assert.equal(session.agentAttached, true, "rearm should not detach immediately");
  assert.equal(session.waiters.length, 0, "rearm should remove the waiter it released");
  assert.equal(detachEvents(session).length, 0, "rearm should not broadcast detach immediately");
  await sleep(20);
  assert.equal(detachEvents(session).length, 0, "detach should not broadcast inside the grace window");

  const ask = session.handleBranchRequest({
    parent_id: session.rootId,
    request_id: "req-live",
    node_id: "node-live",
    selected_text: "Root",
    question: "Explain this",
  });
  assert.equal(session.queue.length, 1, "ask during rearm gap should stay queued");

  const branch = await openRabbithole({ holeId: first.hole_id });
  assert.equal(branch.status, "branch_request");
  assert.equal(branch.request_id, ask.request_id);
  assert.equal(branch.node_id, ask.node_id);
  assert.equal(branch.session_id, session.id);
  assert.equal(session.url, originalUrl, "live reattach should not open a new local session");
  assert.equal(session.queue.length, 0, "reattach should drain the queued branch request");
  assert.equal(session.waiters.length, 0);
  assert.equal(session.rearmDetachTimer, null, "reattach should clear the grace timer");

  const afterAnswer = await answerBranch({
    sessionId: branch.session_id,
    requestId: branch.request_id,
    title: "Answer",
    content: "Answered.",
  });
  assert.equal(afterAnswer.status, "keep_listening");
  assert.equal(session.pendingByRequest.size, 0);
  assert.equal(session.inFlightBranchRequests.size, 0);
  assert.equal(session.waiters.length, 0, "answer_branch rearm should not leak waiters");
  assert.equal(detachEvents(session).length, 0, "answer_branch rearm should stay attached during grace");

  const second = await openRabbithole({ holeId: first.hole_id });
  assert.equal(second.status, "keep_listening");
  assert.equal(session.queue.length, 0);
  assert.equal(session.waiters.length, 0, "repeated rearm should not leak waiters");
  assert.equal(detachEvents(session).length, 0, "repeated rearm should not broadcast detach inside grace");

  const controller = new AbortController();
  const cancelledWait = session.waitForEvent(controller.signal);
  controller.abort();
  const cancelled = await cancelledWait;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(session.agentAttached, false, "hard MCP cancellation should still detach");
  assert.equal(detachEvents(session).at(-1)?.data.reason, "cancelled");
  assert.equal(session.waiters.length, 0, "hard cancellation should remove its waiter");

  console.log("ok rearm: keep_listening shape, grace, live reattach, and waiter cleanup");
}

async function runSavedAskRequeueFixture() {
  const holeId = "stage7-saved";
  const root = rootNode();
  const child = {
    id: "saved-child",
    parent_id: "root",
    title: "Saved question",
    markdown: "",
    base_url: null,
    base_url_source: null,
    origin: {
      selected_text: "Root",
      question: "Saved while away?",
      lens: null,
      synthesis: false,
      anchor: null,
      branch_type: "selection",
    },
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "pending",
    read: false,
    created_at: new Date().toISOString(),
  };

  await saveHole({
    hole_id: holeId,
    title: "Stage 7 Saved",
    root_id: "root",
    created_at: new Date().toISOString(),
    nodes: [
      root,
      child,
    ],
  });

  const saved = await openRabbithole({ holeId });
  assert.equal(saved.status, "branch_request");
  assert.equal(saved.saved, true);
  assert.equal(saved.node_id, "saved-child");
  assert(saved.rehydration, "first saved ask should include rehydration");

  const session = getSession(saved.session_id);
  assert(session, "cold resume should create a live session");
  assert.equal(session.queue.length, 0);

  const afterAnswer = await answerBranch({
    sessionId: saved.session_id,
    requestId: saved.request_id,
    title: "Saved answer",
    content: "Saved answer.",
  });
  assert.equal(afterAnswer.status, "keep_listening");
  assert.equal([...session.nodes.values()].filter((node) => node.status === "pending").length, 0);
  assert.equal(session.pendingByRequest.size, 0);
  assert.equal(session.inFlightBranchRequests.size, 0);

  const liveAgain = await openRabbithole({ holeId });
  assert.equal(liveAgain.status, "keep_listening");
  assert.equal(session.queue.length, 0, "live reattach should not requeue saved asks again");
  assert.equal(session.waiters.length, 0);

  console.log("ok rearm: live reattach does not duplicate saved-ask requeues");
}

try {
  await runKeepListeningAndLiveReattachFixture();
  await runSavedAskRequeueFixture();
} finally {
  await closeAllSessions("stage7_test_complete");
}

console.log("stage7 rearm verification passed");
