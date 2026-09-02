/** @protects delta thread delivery: published nodes are delivered, delegated finals are not, and thread carries only undelivered lineage. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-thread-delta-"));

const { openRabbithole, answerBranch, sendToRabbithole } = await import("../../src/node/rabbithole.js");
const { closeAllSessions, getSession } = await import("../../src/node/sessions.js");

try {
  await runPublishedNodeIsDelivered();
  await runDelegatedFinalStaysUndelivered();
  await runThreadCarriesOnlyUndelivered();
  console.log("ok thread delta: publish marks delivered, delegated finals ride as thread, thread is the undelivered lineage only");
} finally {
  await closeAllSessions("thread_delta_contract_complete");
}

async function runPublishedNodeIsDelivered() {
  const opened = await openRabbithole({ title: "Publish", content: "Root text", signal: abortAfter() });
  const session = getSession(opened.session_id);
  const published = await sendToRabbithole({
    holeId: session.holeId, operationId: "pub-1", title: "Published", content: "Agent-written body", parentNodeId: session.rootId,
  });
  assert(session.delivered.has(published.node_id), "send_to_rabbithole on a live session marks its node delivered");
  const note = await sendToRabbithole({
    holeId: session.holeId, operationId: "pub-note", content: "Agent-written note", parentNodeId: published.node_id, kind: "note",
  });

  const branch = await fireAsk(session, published.node_id, "ask-on-published", "Follow up on what you published");
  assert.equal(Object.hasOwn(branch, "thread"), false, "no thread: the agent wrote every node on this lineage");
  assert.equal(Object.hasOwn(branch, "notes"), false, "an agent-published note is not re-sent as new");
  assert.equal(branch.map.notes.find((entry) => entry.id === note.node_id)?.new, false);
}

async function runDelegatedFinalStaysUndelivered() {
  const opened = await openRabbithole({ title: "Delegate", content: "Root text", signal: abortAfter() });
  const session = getSession(opened.session_id);
  const first = await fireAsk(session, session.rootId, "delegated-ask", "Delegate this");
  await answerBranch({ sessionId: session.id, requestId: first.request_id, delegated: true });
  const done = await answerBranch({ sessionId: session.id, requestId: first.request_id, title: "Sub-agent answer", content: "Written by a sub-agent" });
  assert.equal(done.delegated, true);
  assert.equal(session.delivered.has(done.node_id), false, "a delegated final is not something the listener received");

  const followup = await fireAsk(session, done.node_id, "ask-on-delegated", "What did the sub-agent say?");
  assert.deepEqual(followup.thread, [{ id: done.node_id, title: "Sub-agent answer", markdown: "Written by a sub-agent", notes: [] }],
    "the delegated answer rides as thread, and only it: the root was delivered as content");
  assert(session.delivered.has(done.node_id));
}

async function runThreadCarriesOnlyUndelivered() {
  const filePath = path.join(process.env.RABBITHOLE_DIR, "root.md");
  await fs.writeFile(filePath, "# File root\n\nBody the agent may not have read.", "utf8");
  const opened = await openRabbithole({ title: "File", filePath, signal: abortAfter() });
  const session = getSession(opened.session_id);

  const first = await fireAsk(session, session.rootId, "ask-1", "First ask");
  assert.deepEqual(first.thread.map((entry) => entry.id), [session.rootId], "a file root is auto-sent once");
  const answered = await answerBranch({ sessionId: session.id, requestId: first.request_id, title: "A1", content: "Answer one", signal: abortAfter() });
  assert.equal(answered.status, "cancelled");

  const child = await sendToRabbithole({
    holeId: session.holeId, operationId: "deep", title: "Deep", content: "x".repeat(30000), parentNodeId: first.node_id,
  });
  session.delivered.delete(child.node_id);
  session.handleBrowserEvent({
    type: "node_create", id: "human-note", parent_id: child.node_id, markdown: "Margin note on the deep node",
    origin: { kind: "note", selected_text: "x" }, docked: true,
  });

  const deep = await fireAsk(session, child.node_id, "ask-2", "Ask on the oversized node");
  assert.deepEqual(deep.thread, [{ id: child.node_id, title: "Deep", chars: 30000, omitted: true }],
    "delivered ancestors are skipped and an over-budget node is stubbed, not truncated");
  assert.equal(session.delivered.has(child.node_id), false, "an omitted stub is not a delivery");
  assert.deepEqual(deep.notes.map((note) => note.note_id), ["human-note"], "the note on the omitted node still ships in full");
  assert(JSON.stringify(deep).length < 8000);
}

async function fireAsk(session, parentId, requestId, question) {
  await session.handleBrowserEvent({
    type: "branch_request", request_id: requestId, node_id: `${requestId}-node`, parent_id: parentId, selected_text: "", question,
  });
  const event = await openRabbithole({ holeId: session.holeId });
  assert.equal(event.status, "branch_request");
  assert.equal(event.request_id, requestId);
  return event;
}

function abortAfter(ms = 25) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
