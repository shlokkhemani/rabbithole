/** @protects mcp rearm capability contracts. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-mcp-rearm-"));

const { openRabbithole, answerBranch, sendToRabbithole } = await import("../../src/node/rabbithole.js");
const { closeAllSessions, getSession } = await import("../../src/node/sessions.js");
const { defaultFsStore } = await import("../../src/node/fs-store.js");
const { SERVER_INSTRUCTIONS } = await import("../../src/node/mcp/instructions.js");
const { toolDefinitions } = await import("../../src/node/tools/manifest.js");
const { RabbitholeSession } = await import("../../src/node/transport/session.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortAfter(ms = 25) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
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

function useFakeTimeouts() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0;
  let nextId = 1;

  (/** @type {any} */ (globalThis)).setTimeout = (callback, delay = 0, ...args) => {
    const id = nextId++;
    timers.set(id, { at: now + Number(delay), callback: () => callback(...args) });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);

  return {
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

class FakeSseRequest extends EventEmitter {
  constructor(url = "/sse") {
    super();
    this.method = "GET";
    this.url = url;
    this.headers = {};
  }
}

class FakeSseResponse {
  constructor() {
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {}
}

async function runIdleSessionLifetimeFixture() {
  const fakeTimeouts = useFakeTimeouts();
  let session;
  try {
    session = new RabbitholeSession({
      holeId: "idle-session-lifetime",
      title: "Idle Session Lifetime",
      rootId: "root",
      nodes: [rootNode()],
      isResume: false,
      renderPage: () => "",
    });
    const listener = session.waitForEvent();
    assert(session.waiter, "the connected agent listener must remain blocked while the canvas is idle");
    fakeTimeouts.advance(3 * 60 * 60 * 1000);
    await Promise.resolve();
    assert.equal(session.closed, false, "a connected client must keep its session open after three idle hours");
    const askPending = session.handleBrowserEvent({
      type: "branch_request",
      parent_id: session.rootId,
      request_id: "three-hour-request",
      node_id: "three-hour-node",
      selected_text: "Root",
      question: "Are you still listening?",
    });
    fakeTimeouts.advance(401);
    const ask = await askPending;
    const branch = await listener;
    assert.equal(branch.status, "branch_request");
    assert.equal(branch.request_id, ask.request_id);
    assert.equal(branch.node_id, ask.node_id);
  } finally {
    fakeTimeouts.restore();
    await session?.close("idle_session_lifetime_test_complete");
  }

  console.log("ok session lifetime: a blocked listener survives three idle hours and receives the next ask");
}

async function runAgentPublishFixture() {
  const publishTool = toolDefinitions.find((tool) => tool.name === "send_to_rabbithole");
  assert(publishTool, "the MCP manifest must expose send_to_rabbithole");
  assert.throws(
    () => publishTool.validateInput({ hole_id: "", operation_id: "", content: "" }),
    /hole_id is required/
  );
  const dormantHoleId = "agent-publish-dormant";
  await defaultFsStore.saveHole({
    hole_id: dormantHoleId,
    title: "Agent publish dormant",
    root_id: "root",
    created_at: new Date().toISOString(),
    view_state: null,
    nodes: [rootNode()],
  });

  const standalone = await publishTool.run({
    hole_id: dormantHoleId,
    operation_id: "standalone-note-1",
    title: "Incoming thought",
    content: "Keep this for later.",
  });
  assert.equal(standalone.status, "stored");
  assert.equal(standalone.duplicate, false);

  const duplicate = await sendToRabbithole({
    holeId: dormantHoleId,
    operationId: "standalone-note-1",
    title: "A retry must not replace the first write",
    content: "Different retry body.",
  });
  assert.equal(duplicate.node_id, standalone.node_id);
  assert.equal(duplicate.duplicate, true);

  const attached = await sendToRabbithole({
    holeId: dormantHoleId,
    operationId: "attached-note-1",
    content: "Attach this beneath the root.",
    parentNodeId: "root",
  });
  const dormant = await defaultFsStore.loadHole(dormantHoleId);
  assert.equal(dormant.nodes.length, 3, "a retry must not duplicate the standalone note");
  const standaloneNode = dormant.nodes.find((node) => node.id === standalone.node_id);
  const attachedNode = dormant.nodes.find((node) => node.id === attached.node_id);
  assert.equal(standaloneNode.markdown, "Keep this for later.");
  assert.equal(standaloneNode.parent_id, null);
  assert.equal(standaloneNode.origin, null, "default publishes are answer documents, not notes");
  assert.deepEqual(standaloneNode.size, { w: 420, h: 460 }, "standalone answers use standard document sizing");
  assert.equal(standaloneNode.read, false);
  assert.equal(attachedNode.parent_id, "root");
  assert.equal(attachedNode.origin, null);

  const note = await sendToRabbithole({
    holeId: dormantHoleId,
    operationId: "explicit-note-1",
    content: "This is genuinely an annotation.",
    kind: "note",
  });
  assert.match(note.node_id, /^agent-note-[a-f0-9]{8}$/,
    "agent-published note ids keep their stable hash form with an eight-hex digest");
  const withNote = await defaultFsStore.loadHole(dormantHoleId);
  assert.deepEqual(withNote.nodes.find((node) => node.id === note.node_id).origin, { kind: "note", author: "agent" },
    "explicit notes retain note presentation with agent attribution");
  await assert.rejects(
    () => sendToRabbithole({ holeId: dormantHoleId, operationId: "bad-parent", content: "No.", parentNodeId: "missing" }),
    /Parent node missing not found/
  );

  const cancelled = await openRabbithole({
    title: "Agent publish live",
    content: "Root",
    signal: abortAfter(),
  });
  const live = getSession(cancelled.session_id);
  assert(live && !live.isClosed());
  const request = new FakeSseRequest();
  await live.handleRequest(request, new FakeSseResponse());
  const queuedBefore = live.queue.length;
  const published = await sendToRabbithole({
    holeId: live.holeId,
    operationId: "live-note-1",
    content: "Arrive without waking or replacing the listener.",
    parentNodeId: live.rootId,
  });
  assert.equal(published.status, "delivered");
  assert.equal(live.queue.length, queuedBefore, "publishing a note must not create an agent-facing event");
  assert(live.outboundEvents.some((event) => event.data.type === "node_answered" && event.data.node_id === published.node_id));
  assert.equal((await defaultFsStore.loadHole(live.holeId)).nodes.some((node) => node.id === published.node_id), true);
  request.emit("close");
  await live.close("agent_publish_test_complete");

  console.log("ok agent publish: answer documents default, explicit notes are attributed, and both remain durable and listener-free");
}

async function runTransientSseReconnectFixture() {
  const fakeTimeouts = useFakeTimeouts();
  let session;
  let firstRequest;
  let reconnectRequest;
  try {
    session = new RabbitholeSession({
      holeId: "transient-sse-reconnect",
      title: "Transient SSE Reconnect",
      rootId: "root",
      nodes: [rootNode()],
      isResume: false,
      renderPage: () => "",
    });
    session.url = "http://127.0.0.1";

    let waiterSettled = false;
    const durableWaiter = session.waitForEvent().then((event) => {
      waiterSettled = true;
      return event;
    });
    firstRequest = new FakeSseRequest();
    const firstResponse = new FakeSseResponse();
    await session.handleRequest(firstRequest, firstResponse);
    assert.equal(firstResponse.status, 200);
    assert.equal(session.sseClients.size, 1);

    firstRequest.emit("close");
    assert.equal(session.sseClients.size, 0, "losing the last SSE client marks the browser disconnected");
    fakeTimeouts.advance(60_001);
    await Promise.resolve();
    assert.equal(session.closed, false, "SSE loss must not close the session after the former grace window");
    assert.equal(waiterSettled, false, "SSE loss must not resolve the durable agent waiter");

    reconnectRequest = new FakeSseRequest("/sse?after=0");
    const reconnectResponse = new FakeSseResponse();
    await session.handleRequest(reconnectRequest, reconnectResponse);
    session.broadcast({ type: "agent_status", attached: true, reason: "reconnect_test" });
    assert.match(reconnectResponse.chunks.join(""), /"type":"agent_status"/, "a reconnected SSE client receives later events");

    await session.handleBrowserEvent({
      type: "branch_request",
      parent_id: session.rootId,
      request_id: "request-after-reconnect",
      node_id: "node-after-reconnect",
      selected_text: "Root",
      question: "Does delivery survive the reconnect?",
    });
    const delivered = await durableWaiter;
    assert.equal(delivered.status, "branch_request");
    assert.equal(delivered.request_id, "request-after-reconnect");
  } finally {
    firstRequest?.emit("close");
    reconnectRequest?.emit("close");
    fakeTimeouts.restore();
    await session?.close("sse_reconnect_test_complete");
  }

  console.log("ok SSE reconnect: transient loss stays live past 60s and preserves bidirectional delivery");
}

async function runZeroIdleTurnsAndSingleListenerFixture() {
  const openingController = new AbortController();
  const opening = openRabbithole({ title: "MCP Listener", content: "Root", signal: openingController.signal });
  await sleep(25);
  openingController.abort();
  const opened = await opening;
  assert.equal(opened.status, "cancelled");

  const session = getSession(opened.session_id);
  assert(session, "cancelled host wait should leave the durable canvas session live");
  assert.equal(session.agentAttached, false);

  // Even a legacy local override must not be able to reintroduce model
  // polling. This makes the zero-idle-turn invariant fast to test.
  process.env.RABBITHOLE_MAX_BLOCK_MS = "50";
  const idle = session.waitForEvent();
  const idleOutcome = await Promise.race([idle.then(() => "resolved"), sleep(125).then(() => "pending")]);
  delete process.env.RABBITHOLE_MAX_BLOCK_MS;
  assert.equal(idleOutcome, "pending", "an idle canvas must not periodically resolve its model listener");
  assert(session.waiter, "one background listener should remain attached during idle time");
  assert.equal(session.agentAttached, true);

  const overlapping = await session.waitForEvent();
  assert.deepEqual(overlapping, {
    status: "already_listening",
    session_id: session.id,
    hole_id: session.holeId,
    instruction: "This session already has an active background listener. Do not attach another one; the existing call will receive the next canvas event.",
  });
  assert(session.waiter, "a redundant attach must not replace the owning listener");

  await defaultFsStore.putAsset(session.holeId, "paste-live.png", Buffer.from([1, 2, 3, 4]));
  session.assetNames.add("paste-live.png");
  const ask = await session.handleBrowserEvent({
    type: "branch_request",
    parent_id: session.rootId,
    request_id: "req-live",
    node_id: "node-live",
    selected_text: "Root",
    question: "Explain this",
    attachment_assets: ["paste-live.png"],
  });
  assert.equal(session.queue.length, 0, "the active listener should receive the ask directly");

  const branch = await idle;
  assert.equal(branch.status, "branch_request");
  assert.equal(branch.request_id, ask.request_id);
  assert.equal(branch.node_id, ask.node_id);
  assert.equal(branch.session_id, session.id);
  assert.equal(branch.attachments.length, 1);
  assert.equal(branch.attachments[0].kind, "image");
  assert.equal(branch.attachments[0].source, "pasted_image");
  assert.equal(path.isAbsolute(branch.attachments[0].image_path), true);
  await fs.realpath(branch.attachments[0].image_path);
  assert.deepEqual(await fs.readFile(branch.attachments[0].image_path), Buffer.from([1, 2, 3, 4]));
  assert.equal(session.waiter, null);

  const answerController = new AbortController();
  setTimeout(() => answerController.abort(), 25);
  const afterAnswer = await answerBranch({
    sessionId: branch.session_id,
    requestId: branch.request_id,
    title: "Answer",
    content: "Answered.",
    signal: answerController.signal,
  });
  assert.equal(afterAnswer.status, "cancelled");
  assert.equal([...session.requests.records()].filter((record) => record.nodeId).length, 0);
  assert.equal([...session.requests.records()].filter((record) => record.inFlight).length, 0);

  const duplicate = await answerBranch({
    sessionId: branch.session_id,
    requestId: branch.request_id,
    title: "Duplicate answer",
    content: "Must not be written twice.",
  });
  assert.deepEqual(duplicate, {
    ok: true, node_id: ask.node_id, request_id: ask.request_id, duplicate: true, completed: true,
  }, "a retried completed request should be an idempotent acknowledgement");
  assert.equal(session.nodes.get(ask.node_id).markdown, "Answered.");

  const liveController = new AbortController();
  const liveListener = openRabbithole({ holeId: session.holeId, signal: liveController.signal });
  await sleep(20);
  const redundantLiveAttach = await openRabbithole({ holeId: session.holeId });
  assert.equal(redundantLiveAttach.status, "already_listening");
  liveController.abort();
  assert.equal((await liveListener).status, "cancelled");
  assert.equal(session.waiter, null, "hard cancellation should release the sole listener");
  assert.equal(detachEvents(session).at(-1)?.data.reason, "cancelled");

  console.log("ok listener: zero idle turns, one delivery lease, idempotent completion, and cancellation cleanup");
}

async function runOrphanedWaiterRecoveryFixture() {
  const opened = await openRabbithole({ title: "MCP orphan recovery", content: "Root", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);

  const orphaned = session.waitForEvent();
  assert.equal((await openRabbithole({ holeId: session.holeId })).status, "already_listening");
  const ask = await session.handleBrowserEvent({
    type: "branch_request",
    parent_id: session.rootId,
    request_id: "req-orphaned",
    node_id: "node-orphaned",
    selected_text: "Root",
    question: "Can this ask recover?",
  });
  const lostDelivery = await orphaned;
  assert.equal(lostDelivery.request_id, ask.request_id, "the orphaned waiter receives the first delivery");
  assert.equal(session.waiter, null, "delivery clears the orphaned waiter before resolving it");
  const storedBaseEvent = session.requests.get(ask.request_id).inFlight;
  assert.notEqual(storedBaseEvent, lostDelivery, "the request table keeps a base event, not its delivery projection");
  assert.equal(Object.hasOwn(storedBaseEvent, "hole_id"), false);
  assert.equal(Object.hasOwn(storedBaseEvent, "map"), false);
  assert.equal(Object.hasOwn(storedBaseEvent, "notes"), false);
  assert.equal(Object.hasOwn(storedBaseEvent, "thread"), false);
  await session.flushSave();
  assert.equal((await defaultFsStore.loadHole(session.holeId)).nodes.find((node) => node.id === ask.node_id)?.status, "pending");

  const recovered = await openRabbithole({ holeId: session.holeId });
  assert.equal(recovered.status, "branch_request");
  assert.equal(recovered.request_id, ask.request_id, "the next attach redelivers the exact in-flight ask");
  assert.equal(recovered.node_id, ask.node_id);
  assert.notEqual(recovered, lostDelivery, "redelivery creates a fresh decorated event");
  assert.deepEqual(recovered, lostDelivery, "unchanged context produces the same wire payload");
  const afterAnswer = await answerBranch({
    sessionId: recovered.session_id,
    requestId: recovered.request_id,
    title: "Recovered answer",
    content: "Recovered.",
    signal: abortAfter(),
  });
  assert.equal(afterAnswer.status, "cancelled");
  assert.equal(session.nodes.get(ask.node_id).markdown, "Recovered.");
  assert.equal([...session.requests.records()].filter((record) => record.nodeId).length, 0);
  assert.equal([...session.requests.records()].filter((record) => record.inFlight).length, 0);
  assert.equal(session.waiter, null);

  console.log("ok listener recovery: an orphan-delivered ask persists, redelivers, answers, and re-arms once");
}

async function runProgressKeepaliveFixture() {
  const openTool = toolDefinitions.find((tool) => tool.name === "open_rabbithole");
  const answerTool = toolDefinitions.find((tool) => tool.name === "answer_branch");
  assert(openTool && answerTool);
  assert.match(SERVER_INSTRUCTIONS, /"Rabbithole" or "rabbit hole" in a request means use this server/,
    "server discovery must recognize the product name as an explicit MCP request");
  assert.match(SERVER_INSTRUCTIONS, /The pending call is the listener: never poll or re-call while one is running/,
    "the shared instructions must explain the one-listener rule for both blocking tools");
  assert.equal([SERVER_INSTRUCTIONS, openTool.description, answerTool.description]
    .filter((text) => text.includes("The pending call is the listener")).length, 1,
  "the listener rule must have one agent-facing home");
  assert.match(SERVER_INSTRUCTIONS, /never claim you are listening unless a blocking call is running/,
    "the shared instructions must forbid false listener claims");
  assert.match(answerTool.input.delegated.description,
    /true right after spawning a sub-agent[\s\S]*restore the listener with open_rabbithole \{hole_id\}/,
    "the delegated parameter must carry the restore-listener rule");
  assert.doesNotMatch(answerTool.input.partial.description, /protocol\s+step/i,
    "the partial parameter must not refer to a deleted numbered protocol");
  assert.doesNotMatch(answerTool.input.delegated.description, /protocol\s+step/i,
    "the delegated parameter must not refer to a deleted numbered protocol");
  process.env.RABBITHOLE_PROGRESS_INTERVAL_MS = "10";
  try {
    const openingController = new AbortController();
    const openNotifications = [];
    const opened = await openTool.run(
      { title: "MCP progress", content: "Root" },
      {
        signal: openingController.signal,
        _meta: { progressToken: "open-token" },
        async sendNotification(notification) {
          openNotifications.push(notification);
          openingController.abort();
        },
      }
    );
    assert.equal(opened.status, "cancelled");
    assert.deepEqual(openNotifications, [{
      method: "notifications/progress",
      params: { progressToken: "open-token", progress: 1, message: "Waiting for canvas activity." },
    }]);

    const session = getSession(opened.session_id);
    const waiting = session.waitForEvent();
    await session.handleBrowserEvent({
      type: "branch_request",
      parent_id: session.rootId,
      request_id: "req-progress",
      node_id: "node-progress",
      selected_text: "Root",
      question: "Keep waiting?",
    });
    const branch = await waiting;
    const answerController = new AbortController();
    const answerNotifications = [];
    const answered = await answerTool.run(
      {
        session_id: branch.session_id,
        request_id: branch.request_id,
        title: "Progress answer",
        content: "Yes.",
      },
      {
        signal: answerController.signal,
        _meta: { progressToken: 47 },
        async sendNotification(notification) {
          answerNotifications.push(notification);
          answerController.abort();
        },
      }
    );
    assert.equal(answered.status, "cancelled");
    assert.deepEqual(answerNotifications, [{
      method: "notifications/progress",
      params: { progressToken: 47, progress: 1, message: "Waiting for canvas activity." },
    }]);

    let tokenlessNotifications = 0;
    const tokenlessController = new AbortController();
    const tokenlessWait = openTool.run(
      { hole_id: session.holeId },
      {
        signal: tokenlessController.signal,
        _meta: {},
        async sendNotification() { tokenlessNotifications += 1; },
      }
    );
    setTimeout(() => tokenlessController.abort(), 30);
    assert.equal((await tokenlessWait).status, "cancelled");
    assert.equal(tokenlessNotifications, 0, "a client without a progress token gets no fabricated notification");
  } finally {
    delete process.env.RABBITHOLE_PROGRESS_INTERVAL_MS;
  }

  console.log("ok progress: token-gated keepalives cover open and final-answer waits");
}

async function runSavedAskRequeueFixture() {
  const holeId = "mcp-rearm-saved";
  const root = rootNode();
  const child = {
    id: "saved-child",
    parent_id: null,
    title: "Saved question",
    markdown: "",
    base_url: null,
    base_url_source: null,
    origin: {
      selected_text: "stale standalone selection",
      question: "Saved while away?",
      lens: null,
      anchor: null,
      branch_type: "followup",
      attachment_assets: ["../escape.png", "source.pdf", "paste-saved.png"],
    },
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "pending",
    read: false,
    created_at: "2026-08-13T00:00:00.000Z",
  };
  const laterChild = {
    ...child,
    id: "saved-child-later",
    title: "Later saved question",
    origin: { ...child.origin, question: "Does the next saved ask still arrive?", attachment_assets: [] },
    created_at: "2026-08-13T00:00:01.000Z",
  };

  await defaultFsStore.putAsset(holeId, "paste-saved.png", Buffer.from([5, 6, 7, 8]));

  await defaultFsStore.saveHole({
    hole_id: holeId,
    title: "MCP Rearm Saved",
    root_id: "root",
    created_at: new Date().toISOString(),
    nodes: [
      root,
      child,
      laterChild,
    ],
  });

  const saved = await openRabbithole({ holeId });
  assert.equal(saved.status, "branch_request");
  assert.equal(saved.saved, true);
  assert.equal(saved.node_id, "saved-child");
  assert.equal(saved.parent_node_id, "root", "saved standalone asks resume with root as their context source");
  assert.equal(saved.parent_node_title, "Root");
  assert.equal(saved.selected_text, "", "saved standalone asks retain whole-hole selection semantics");
  assert.deepEqual(saved.lineage, ["Root"]);
  assert.equal(saved.attachments.length, 1, "saved asks re-resolve their pasted images after restart");
  assert.equal(saved.attachments[0].kind, "image");
  assert.equal(saved.attachments[0].source, "pasted_image");
  assert.equal(path.isAbsolute(saved.attachments[0].image_path), true);
  await fs.realpath(saved.attachments[0].image_path);
  assert.deepEqual(await fs.readFile(saved.attachments[0].image_path), Buffer.from([5, 6, 7, 8]));
  assert.deepEqual(saved.thread, [{ id: "root", title: "Root", markdown: "Root", notes: [] }],
    "the first cold-resume ask carries its undelivered lineage");
  assert.deepEqual(saved.map.nodes.map((node) => [node.id, node.status]), [
    ["root", "answered"],
    ["saved-child", "pending"],
    ["saved-child-later", "pending"],
  ], "saved asks are ordinary pending nodes in the map");
  assert.equal(JSON.stringify(saved).includes("rehydration"), false);
  assert.equal(JSON.stringify(saved).includes("saved_asks"), false);

  const session = getSession(saved.session_id);
  assert(session, "cold resume should create a live session");
  assert.equal(session.queue.length, 1, "the later saved ask should already be queued behind the first delivery");

  const afterAnswer = await answerBranch({
    sessionId: saved.session_id,
    requestId: saved.request_id,
    title: "Saved answer",
    content: "Saved answer.",
  });
  assert.equal(afterAnswer.status, "branch_request", "a bad saved attachment name must not wedge the later saved-ask requeue");
  assert.equal(afterAnswer.node_id, "saved-child-later");
  assert.equal(afterAnswer.question, "Does the next saved ask still arrive?");
  assert.equal(Object.hasOwn(afterAnswer, "thread"), false, "the delivered root lineage is not repeated");
  const afterLaterAnswer = await answerBranch({
    sessionId: afterAnswer.session_id,
    requestId: afterAnswer.request_id,
    title: "Later saved answer",
    content: "Later saved answer.",
    signal: abortAfter(),
  });
  assert.equal(afterLaterAnswer.status, "cancelled");
  assert.equal([...session.nodes.values()].filter((node) => node.status === "pending").length, 0);
  assert.equal(session.nodes.get("saved-child").parent_id, null, "answering a saved standalone ask keeps it disconnected");
  assert.equal([...session.requests.records()].filter((record) => record.nodeId).length, 0);
  assert.equal([...session.requests.records()].filter((record) => record.inFlight).length, 0);

  const liveAgain = await openRabbithole({ holeId, signal: abortAfter() });
  assert.equal(liveAgain.status, "cancelled");
  assert.equal(session.queue.length, 0, "live reattach should not requeue saved asks again");
  assert.equal(session.waiter, null);

  console.log("ok rearm: invalid saved attachment names do not block valid delivery or later saved asks");
}

// The wire entry a note node should produce (standalone by default; anchored
// entries override on_node_id/on_selected_text, lineage entries add the flag).
function noteEntry(session, id, content, extra = {}) {
  return { note_id: id, on_node_id: null, on_selected_text: null, content, created_at: session.nodes.get(id).created_at, ...extra };
}

async function runNotesContextFixture() {
  const opened = await openRabbithole({ title: "MCP notes context", content: "Root note target", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);

  await session.handleBrowserEvent({
    type: "node_create",
    id: "replied-note",
    markdown: "Keep the target caveat in mind.",
    origin: { kind: "note" },
  });
  await session.handleBrowserEvent({
    type: "node_create",
    id: "ambient-note-one",
    markdown: "Relate this to the broader argument.",
    origin: { kind: "note" },
  });
  await session.handleBrowserEvent({
    type: "node_create",
    id: "ambient-note-two",
    markdown: "Compare this with the appendix.",
    origin: { kind: "note" },
  });
  assert.deepEqual(session.queue, [], "note creation must remain pull-only for the agent");

  await session.handleBrowserEvent({
    type: "branch_request",
    request_id: "notes-request",
    node_id: "notes-branch",
    parent_id: "replied-note",
    selected_text: "",
    question: "Expand on this note",
  });
  const branch = await openRabbithole({ holeId: session.holeId });
  const expectedNotes = [
    noteEntry(session, "replied-note", "Keep the target caveat in mind.", { on_lineage: true }),
    noteEntry(session, "ambient-note-one", "Relate this to the broader argument."),
    noteEntry(session, "ambient-note-two", "Compare this with the appendix."),
  ];
  assert.deepEqual(branch.notes, expectedNotes, "a live follow-up inside one of three notes delivers all three with the replied-to note flagged first");
  assert.deepEqual(branch.map.notes.map((note) => [note.id, note.new]), [
    ["replied-note", true],
    ["ambient-note-one", true],
    ["ambient-note-two", true],
  ]);

  const holeId = session.holeId;
  await session.close("notes_context_cold_resume");
  const resumed = await openRabbithole({ holeId });
  assert.equal(resumed.status, "branch_request");
  assert.equal(resumed.saved, true);
  assert.deepEqual(resumed.notes, expectedNotes, "saved branch delivery recomputes lineage-aware note context after cold resume");
  assert.equal(resumed.map.nodes.some((node) => node.id === "replied-note"), false, "notes stay out of map.nodes");
  assert.deepEqual(resumed.map.notes.map((note) => [note.id, note.new]), [
    ["replied-note", true],
    ["ambient-note-one", true],
    ["ambient-note-two", true],
  ], "a cold session starts with no delivered note hashes");
  assert.equal(JSON.stringify(resumed).includes("rehydration"), false);
  assert.equal(JSON.stringify(resumed).includes("saved_asks"), false);

  console.log("ok rearm notes: three-note reply thread, lineage flag, cold-resume map, and fresh deltas");
}

async function runNoteDeltaAndReactionFixture() {
  const opened = await openRabbithole({ title: "MCP note deltas", content: "Root note delta target", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);

  await session.handleBrowserEvent({
    type: "node_create",
    id: "delta-note",
    markdown: "Original note text.",
    origin: { kind: "note" },
  });
  await session.handleBrowserEvent({
    type: "node_create",
    id: "reaction-note",
    parent_id: session.rootId,
    markdown: "👍",
    origin: { kind: "note", instruction: "Preserve the concrete example." },
    docked: true,
  });
  await session.handleBrowserEvent({
    type: "node_extensions_patch",
    node_id: "reaction-note",
    namespace: "note",
    value: { docked: true, reaction: true },
  });

  await session.handleBrowserEvent({
    type: "branch_request", request_id: "delta-request-one", node_id: "delta-branch-one", parent_id: session.rootId,
    selected_text: "Root", question: "First note delivery",
  });
  const first = await openRabbithole({ holeId: session.holeId });
  assert.equal(Object.hasOwn(first, "thread"), false, "content supplied on open makes the root already delivered");
  assert.equal(first.notes.find((entry) => entry.note_id === "reaction-note")?.content, "Preserve the concrete example.",
    "reaction notes resolve to their instruction when sent in full");
  assert.equal(first.map.notes.find((entry) => entry.id === "reaction-note")?.preview, "Preserve the concrete example.",
    "reaction map previews use the same resolved instruction");
  assert(first.map.notes.every((entry) => entry.new), "new notes are flagged before their first full delivery");
  assert.equal((await answerBranch({
    sessionId: session.id, requestId: first.request_id, title: "First", content: "First answer.", signal: abortAfter(),
  })).status, "cancelled");

  await session.handleBrowserEvent({ type: "node_update", node_id: "delta-note", markdown: "Edited note text." });
  await session.handleBrowserEvent({
    type: "branch_request", request_id: "delta-request-two", node_id: "delta-branch-two", parent_id: session.rootId,
    selected_text: "Root", question: "Second note delivery",
  });
  const second = await openRabbithole({ holeId: session.holeId });
  assert.deepEqual(second.map.notes.map((entry) => [entry.id, entry.new]), [
    ["delta-note", true],
    ["reaction-note", false],
  ]);
  assert.deepEqual(second.notes.map((entry) => [entry.note_id, entry.content]), [["delta-note", "Edited note text."]],
    "an edited note ships in full exactly once");
  assert.equal((await answerBranch({
    sessionId: session.id, requestId: second.request_id, title: "Second", content: "Second answer.", signal: abortAfter(),
  })).status, "cancelled");

  await session.handleBrowserEvent({
    type: "branch_request", request_id: "delta-request-three", node_id: "delta-branch-three", parent_id: session.rootId,
    selected_text: "Root", question: "Third note delivery",
  });
  const third = await openRabbithole({ holeId: session.holeId });
  assert(third.map.notes.every((entry) => entry.new === false));
  assert.equal(Object.hasOwn(third, "notes"), false, "the unchanged third delivery omits all full note entries");

  console.log("ok rearm note deltas: edited notes ship once and reaction previews use resolved instructions");
}

async function runDoneNotesDeliveryFixture() {
  const opened = await openRabbithole({ title: "MCP notes on Done", content: "Root feedback target", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);

  await session.handleBrowserEvent({
    type: "node_create",
    id: "done-anchored-note",
    parent_id: session.rootId,
    markdown: "Tighten this paragraph.",
    origin: { kind: "note", selected_text: "feedback target", anchor: { offset_start: 5, offset_end: 20 } },
  });
  await session.handleBrowserEvent({
    type: "node_create",
    id: "done-standalone-note",
    markdown: "Check the conclusion too.",
    origin: { kind: "note" },
  });

  await session.handleBrowserEvent({
    type: "branch_request", request_id: "done-prime-request", node_id: "done-prime-branch", parent_id: session.rootId,
    selected_text: "feedback target", question: "Prime note delivery",
  });
  const primed = await openRabbithole({ holeId: session.holeId });
  assert.equal(primed.notes.length, 2, "the first branch delivery records both note hashes");
  assert.equal((await answerBranch({
    sessionId: session.id, requestId: primed.request_id, title: "Primed", content: "Primed.", signal: abortAfter(),
  })).status, "cancelled");
  await session.handleBrowserEvent({
    type: "node_update", node_id: "done-anchored-note", markdown: "Tighten this paragraph and its example.",
  });

  const blocked = session.waitForEvent();
  assert(session.waiter, "the agent call should be blocked before Done");
  assert.deepEqual(await session.handleBrowserEvent({ type: "done" }), { ok: true });
  assert.deepEqual(await blocked, {
    status: "session_closed",
    session_id: session.id,
    reason: "done",
    notes: [
      noteEntry(session, "done-anchored-note", "Tighten this paragraph and its example.", { on_node_id: session.rootId, on_selected_text: "feedback target" }),
    ],
  }, "Done resolves the blocked agent call with only notes new since their last delivery");
  assert.equal([...session.requests.records()].filter((record) => record.watchdog).length, 0,
    "session_closed delivery must not arm the answer watchdog");
  assert.equal([...session.requests.records()].filter((record) => record.inFlight).length, 0,
    "session_closed delivery must not enter branch request tracking");

  console.log("ok rearm notes: Done delivers only new notes without arming branch lifecycle state");
}

async function runDelegatedConcurrencyFixture() {
  const answerTool = toolDefinitions.find((tool) => tool.name === "answer_branch");
  assert(answerTool);
  assert.doesNotThrow(() => answerTool.validateInput({ session_id: "s", request_id: "r", delegated: true }));
  assert.throws(
    () => answerTool.validateInput({ session_id: "s", request_id: "r", delegated: true, content: "No" }),
    /state-only update/
  );
  assert.throws(
    () => answerTool.validateInput({ session_id: "s", request_id: "r" }),
    /content is required/
  );

  const opened = await openRabbithole({ title: "Delegated concurrency", content: "Root", signal: abortAfter() });
  const session = getSession(opened.session_id);
  assert(session);

  const listenForA = session.waitForEvent();
  await session.handleBrowserEvent({
    type: "branch_request", request_id: "req-a", node_id: "node-a", parent_id: session.rootId,
    selected_text: "Root", question: "Delegate A",
  });
  const requestA = await listenForA;
  assert.equal(requestA.hole_id, session.holeId, "every delivered request carries the stable hole id needed to resume its listener");

  assert.deepEqual(await answerBranch({ sessionId: session.id, requestId: "req-a", delegated: true }), {
    ok: true, node_id: "node-a", request_id: "req-a", delegated: true,
  });
  assert.equal(!!session.requests.get("req-a").watchdog, false,
    "delegated work is owned by the coordinator, not the answer watchdog");
  assert.equal(session.buildHydration().nodes.find((node) => node.id === "node-a")?.delegated, true,
    "a live-page reload rehydrates transient delegation state");

  const listenForB = session.waitForEvent();
  const stillWaiting = await Promise.race([listenForB.then(() => false), sleep(20).then(() => true)]);
  assert.equal(stillWaiting, true, "a delegated request must not redeliver and monopolize the listener");
  await session.handleBrowserEvent({
    type: "branch_request", request_id: "req-b", node_id: "node-b", parent_id: session.rootId,
    selected_text: "Root", question: "Delegate B",
  });
  assert.equal((await listenForB).request_id, "req-b");
  await answerBranch({ sessionId: session.id, requestId: "req-b", delegated: true });

  const reclaimedListener = session.waitForEvent();
  assert(session.waiter, "the listener can remain attached while the coordinator reclaims work");
  assert.deepEqual(await answerBranch({ sessionId: session.id, requestId: "req-b", delegated: false }), {
    ok: true, node_id: "node-b", request_id: "req-b", delegated: false,
  });
  assert.equal((await reclaimedListener).request_id, "req-b", "reclaimed work immediately wakes the attached listener");
  await answerBranch({ sessionId: session.id, requestId: "req-b", delegated: true });

  const listenForC = session.waitForEvent();
  const partialB = await answerBranch({
    sessionId: session.id, requestId: "req-b", content: "B finished", partial: true,
  });
  assert.equal(partialB.partial, true);
  assert.equal(!!session.requests.get("req-b").watchdog, true,
    "a delegated stream keeps request-scoped stall protection while its final remains non-blocking");
  assert.equal(session.buildHydration().nodes.find((node) => node.id === "node-b")?.delegated, undefined,
    "answer-start state is truthful on reload without a redundant work-state broadcast");
  assert(session.waiter, "streaming delegated work leaves the independent listener available");

  await session.handleBrowserEvent({
    type: "branch_request", request_id: "req-c", node_id: "node-c", parent_id: session.rootId,
    selected_text: "Root", question: "Ordinary C",
  });
  assert.equal((await listenForC).request_id, "req-c");
  assert.equal(!!session.requests.get("req-c").watchdog, true);

  const completedB = await answerBranch({
    sessionId: session.id, requestId: "req-b", title: "B", content: " first.",
  });
  assert.deepEqual(completedB, {
    ok: true, node_id: "node-b", request_id: "req-b", completed: true, delegated: true,
  }, "a delegated completion returns immediately instead of taking the listener lease");
  assert.equal(!!session.requests.get("req-c").watchdog, true,
    "finishing one streamed request cannot clear another request's watchdog");

  const completedA = await answerBranch({
    sessionId: session.id, requestId: "req-a", title: "A", content: "A finished later.",
  });
  assert.equal(completedA.completed, true);
  assert.equal(completedA.delegated, true);
  assert.equal(!!session.requests.get("req-c").watchdog, true,
    "finishing one request cannot clear another request's watchdog");
  assert.equal(session.buildHydration().nodes.some((node) => node.delegated), false,
    "completed delegated work leaves no transient marker behind");

  const ordinary = await answerBranch({
    sessionId: session.id, requestId: "req-c", title: "C", content: "C stays backward compatible.", signal: abortAfter(),
  });
  assert.equal(ordinary.status, "cancelled", "ordinary final answers retain the legacy blocking listener contract");
  assert.equal([...session.requests.records()].filter((record) => record.watchdog).length, 0);

  const listenForD = session.waitForEvent();
  await session.handleBrowserEvent({
    type: "branch_request", request_id: "req-d", node_id: "node-d", parent_id: session.rootId,
    selected_text: "Root", question: "Delete delegated D",
  });
  assert.equal((await listenForD).request_id, "req-d");
  await answerBranch({ sessionId: session.id, requestId: "req-d", delegated: true });
  await session.handleBrowserEvent({ type: "delete_node", node_id: "node-d" });
  assert.equal(session.requests.get("req-d").nonBlocking, false,
    "browser cancellation moves response mode into its tombstone instead of retaining active non-blocking state");
  assert.deepEqual(await answerBranch({
    sessionId: session.id, requestId: "req-d", title: "Deleted D", content: "Late answer.",
  }), {
    ok: true, node_id: null, request_id: "req-d", cancelled: true, completed: true, delegated: true,
  }, "a cancelled delegated final still returns immediately and cannot steal the listener");
  assert.deepEqual(
    session.outboundEvents.filter((event) => event.data.type === "node_work_state").map((event) => [event.data.node_id, event.data.state]),
    [["node-a", "delegated"], ["node-b", "delegated"], ["node-b", "thinking"], ["node-b", "delegated"]],
    "work-state events cover explicit delegation and reclaim; progress and completion clear delegated UI state"
  );

  console.log("ok sub-agent lifecycle: parallel delegation, reclaim, reload, out-of-order completion, and listener isolation");
}

async function runQueuedAskLifecycleFixture() {
  const opened = await openRabbithole({
    title: "Queued ask lifecycle",
    content: "Root",
    signal: abortAfter(),
  });
  const session = getSession(opened.session_id);
  assert(session);

  const listenForA = session.waitForEvent();
  await session.handleBrowserEvent({
    type: "branch_request", request_id: "queued-req-a", node_id: "queued-node-a", parent_id: session.rootId,
    selected_text: "Root", question: "Answer A first",
  });
  const requestA = await listenForA;
  assert.equal(requestA.request_id, "queued-req-a");

  await session.handleBrowserEvent({
    type: "branch_request", request_id: "queued-req-b", node_id: "queued-node-b", parent_id: session.rootId,
    selected_text: "Root", question: "Wait behind A",
  });
  const workStatesBeforeAnswer = session.outboundEvents
    .filter((event) => event.data.type === "node_work_state" && event.data.node_id === "queued-node-b")
    .map((event) => event.data.state);
  assert.deepEqual(workStatesBeforeAnswer, ["queued"], "a second ask broadcasts queued while the listener owns A");

  let hydration = session.buildHydration();
  assert.equal(hydration.nodes.find((node) => node.id === "queued-node-a")?.queued, undefined,
    "the delivered request is not marked queued during hydration");
  assert.equal(hydration.nodes.find((node) => node.id === "queued-node-b")?.queued, true,
    "a live-page reload preserves the queued label");

  await session.flushSave();
  const saved = await defaultFsStore.loadHole(session.holeId);
  assert(saved, "the pending asks are durable");
  assert.equal(JSON.stringify(saved).includes('"queued"'), false,
    "queued coordination state never enters the saved hole JSON");

  const requestB = await answerBranch({
    sessionId: session.id,
    requestId: requestA.request_id,
    title: "Answer A",
    content: "A is complete.",
  });
  assert.equal(requestB.request_id, "queued-req-b", "A's final re-arms the listener with queued request B");
  const workStatesAfterAnswer = session.outboundEvents
    .filter((event) => event.data.type === "node_work_state" && event.data.node_id === "queued-node-b")
    .map((event) => event.data.state);
  assert.deepEqual(workStatesAfterAnswer, ["queued", "thinking"],
    "delivery broadcasts thinking after the queued marker");

  hydration = session.buildHydration();
  assert.equal(hydration.nodes.find((node) => node.id === "queued-node-b")?.queued, undefined,
    "delivery removes queued state from hydration before streaming begins");

  console.log("ok queued ask lifecycle: queue, reload, delivery, and persistence stay truthful");
}

try {
  await runIdleSessionLifetimeFixture();
  await runAgentPublishFixture();
  await runTransientSseReconnectFixture();
  await runZeroIdleTurnsAndSingleListenerFixture();
  await runOrphanedWaiterRecoveryFixture();
  await runProgressKeepaliveFixture();
  await runSavedAskRequeueFixture();
  await runNotesContextFixture();
  await runNoteDeltaAndReactionFixture();
  await runDoneNotesDeliveryFixture();
  await runQueuedAskLifecycleFixture();
  await runDelegatedConcurrencyFixture();
} finally {
  await closeAllSessions("mcp_rearm_test_complete");
}

console.log("MCP rearm verification passed");
