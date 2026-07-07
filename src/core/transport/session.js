import http from "node:http";
import { randomUUID } from "node:crypto";
import { openBrowser } from "./browser.js";
import { log, error as logError } from "../logger.js";
import { renderMarkdownToHtml } from "../markdown.js";
import { saveHole } from "../storage.js";
import { buildJsonError, parseRequestBody, closeServerGracefully, CLOSE_TIMEOUT_MS } from "./http.js";
import { writeSseEvent } from "./sse.js";

const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const SAVE_DEBOUNCE_MS = 400;
// Once the browser has connected at least once, treat a sustained loss of every
// SSE client as the human having closed the tab — close after a grace window.
// Kept generous so a reload, a network blip, or a laptop sleep/wake (all of
// which EventSource recovers from automatically) never kills a live session the
// human is still reading; the only cost of waiting is that the already-blocking
// agent call releases a little later after a genuine tab close.
const DISCONNECT_GRACE_MS = 60 * 1000;
// Cap on retained SSE events for reconnect replay, so a long-lived session
// doesn't grow this array without bound.
const MAX_REPLAY_EVENTS = 500;
// After a branch_request is handed to the agent, expect answer_branch within
// this window. If nothing comes back the agent likely died mid-generation
// (cancelled without an MCP request in flight) — tell the browser so pending
// asks don't shimmer forever. Self-heals: any later agent call re-attaches.
const ANSWER_WATCHDOG_MS = 4 * 60 * 1000;

/**
 * One live Rabbithole: the node tree, the browser transport, and the
 * agent-facing event queue. The agent blocks on waitForEvent(); the browser
 * drives the canvas and posts branch requests / node updates.
 */
export class RabbitHoleSession {
  constructor({ holeId, title, rootId, createdAt, nodes, viewState, isResume, renderPage, onClose }) {
    this.id = randomUUID();
    this.holeId = holeId || randomUUID();
    this.title = title || "Untitled";
    this.rootId = rootId || null;
    this.createdAt = createdAt || new Date().toISOString();
    this.viewState = viewState ?? null;
    this.renderPage = renderPage;
    this.onClose = onClose;

    /** @type {Map<string, object>} */
    this.nodes = new Map();
    for (const node of nodes || []) {
      this.nodes.set(node.id, node);
    }

    this.pendingByRequest = new Map(); // request_id -> node_id
    // Requests whose node was deleted mid-answer: a late answer_branch for one
    // of these is absorbed gracefully instead of erroring at the agent.
    this.cancelledRequests = new Set();
    this.needsRehydration = !!isResume;

    this.server = null;
    this.url = null;
    this.closed = false;

    this.queue = []; // agent-facing events awaiting consumption
    this.waiters = []; // FIFO of {resolve, cleanup} for blocked waitForEvent() calls
    this.agentAttached = true; // false once the agent cancels/stalls; browser is told
    this.watchdogTimer = null;

    this.sseClients = new Set();
    this.everConnected = false;
    this.disconnectTimer = null;
    this.outboundEvents = [];
    this.lastOutboundEventId = 0;

    this.timeoutHandle = null;
    this.saveTimer = null;
    this.savingChain = Promise.resolve();
    this.shutdownScheduled = false;

    // Saved asks: questions the human asked while no agent was listening are
    // persisted as pending nodes; a resume re-queues each one (oldest first,
    // under a fresh request_id) so the agent answers them right away.
    if (isResume) this.requeueSavedAsks();

    this.handleRequest = this.handleRequest.bind(this);
  }

  // ---- lifecycle ----------------------------------------------------------

  async start() {
    if (this.server) return this.url;

    const server = http.createServer(this.handleRequest);
    this.server = server;
    server.on("error", (err) => {
      logError(`Session ${this.id} server error: ${err.message}`);
      this.close("server_error");
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to determine session address"));
          return;
        }
        this.url = `http://127.0.0.1:${address.port}`;
        log(`Rabbithole "${this.title}" listening at ${this.url}`);
        resolve();
      });
    });

    this.touch();
    // Persist right away so the hole is resumable even if the process dies
    // before the first answer (durable asks depend on the file existing).
    this.scheduleSave();
    openBrowser(this.url);
    return this.url;
  }

  isClosed() {
    return this.closed;
  }

  touch() {
    if (this.closed) return;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => {
      log(`Session ${this.id} timed out`);
      this.close("timeout");
    }, SESSION_TIMEOUT_MS);
  }

  // Close the session a short while after the browser disconnects (tab closed),
  // unless it reconnects (reload) within the grace window.
  scheduleDisconnectClose() {
    if (this.closed || this.disconnectTimer) return;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (!this.closed && this.sseClients.size === 0) {
        log(`Session ${this.id} closing — browser disconnected`);
        this.close("disconnected");
      }
    }, DISCONNECT_GRACE_MS);
  }

  clearDisconnectClose() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  close(reason = "session_closed") {
    if (this.closed) return;
    this.closed = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.clearAnswerWatchdog();
    this.clearDisconnectClose();
    this.flushSave();

    this.broadcast({ type: "session_closed", reason });

    // Drop any queued (now unanswerable) branch requests and release every
    // blocked agent call with session_closed.
    this.queue.length = 0;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup?.();
      waiter.resolve({ status: "session_closed", session_id: this.id });
    }

    if (this.shutdownScheduled) return;
    this.shutdownScheduled = true;
    setTimeout(() => {
      for (const client of this.sseClients) {
        try {
          client.end();
        } catch {}
      }
      this.sseClients.clear();
      if (!this.server) {
        this.onClose?.(this);
        return;
      }
      const server = this.server;
      this.server = null;
      closeServerGracefully(server, {
        timeoutMs: CLOSE_TIMEOUT_MS,
        onClosed: () => {
          this.onClose?.(this);
          log(`Session ${this.id} closed (${reason})`);
        },
      });
    }, 0);
  }

  // ---- agent-facing event queue ------------------------------------------

  /**
   * Block until the next browser event. `signal` (the MCP request's
   * AbortSignal) fires when the human cancels the tool call in the terminal —
   * the waiter is removed and the browser is told the agent detached, so
   * pending asks stop pretending an answer is coming.
   */
  waitForEvent(signal) {
    if (this.closed) return Promise.resolve({ status: "session_closed", session_id: this.id });
    this.touch();
    this.setAgentAttached(true);
    if (this.queue.length > 0) return Promise.resolve(this.deliverToAgent(this.queue.shift()));
    // FIFO of waiters so concurrent waitForEvent() calls never orphan each other.
    return new Promise((resolve) => {
      const waiter = { resolve: (event) => resolve(this.deliverToAgent(event)) };
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        this.clearAnswerWatchdog();
        this.setAgentAttached(false, "cancelled");
        resolve({ status: "cancelled", session_id: this.id });
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.waiters.push(waiter);
    });
  }

  pushEvent(event) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.cleanup?.();
      waiter.resolve(event);
      return;
    }
    this.queue.push(event);
  }

  // Every branch_request handed to the agent arms the watchdog; any subsequent
  // agent activity (answer_branch, another waitForEvent) clears or re-arms it.
  deliverToAgent(event) {
    if (event && event.status === "branch_request") this.startAnswerWatchdog();
    return event;
  }

  startAnswerWatchdog() {
    this.clearAnswerWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (!this.closed) this.setAgentAttached(false, "stalled");
    }, ANSWER_WATCHDOG_MS);
  }

  clearAnswerWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  setAgentAttached(attached, reason = null) {
    if (this.closed || this.agentAttached === attached) return;
    this.agentAttached = attached;
    this.broadcast({ type: "agent_status", attached, reason });
  }

  // ---- SSE (server -> browser) -------------------------------------------

  broadcast(data) {
    // A streaming answer emits many node_progress events, but each one carries
    // the full accumulated content — only the latest matters for replay. Drop
    // the superseded one so chunks never crowd real events out of the buffer.
    if (data.type === "node_progress") {
      const stale = this.outboundEvents.findIndex(
        (e) => e.data.type === "node_progress" && e.data.node_id === data.node_id
      );
      if (stale !== -1) this.outboundEvents.splice(stale, 1);
    }
    const event = { id: ++this.lastOutboundEventId, data };
    this.outboundEvents.push(event);
    if (this.outboundEvents.length > MAX_REPLAY_EVENTS) {
      this.outboundEvents.splice(0, this.outboundEvents.length - MAX_REPLAY_EVENTS);
    }
    for (const client of this.sseClients) writeSseEvent(client, event);
  }

  // ---- node tree ----------------------------------------------------------

  lineageTitles(nodeId) {
    const titles = [];
    let current = this.nodes.get(nodeId);
    const guard = new Set();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      titles.push(current.title || "Untitled");
      current = current.parent_id ? this.nodes.get(current.parent_id) : null;
    }
    return titles.reverse();
  }

  // For the browser page. Carries both contentHtml (what the client renders)
  // and the raw markdown — the source feeds "copy as Markdown" in the page, and
  // for a local page the payload cost is noise.
  serializeNodes() {
    return [...this.nodes.values()].map((n) => ({
      id: n.id,
      parent_id: n.parent_id ?? null,
      title: n.title ?? "",
      contentHtml: n.contentHtml ?? "",
      markdown: n.markdown ?? "",
      base_url: n.base_url ?? null,
      origin: n.origin ?? null,
      position: n.position ?? { x: 0, y: 0 },
      size: n.size ?? null,
      font_scale: n.font_scale ?? 1,
      collapsed: !!n.collapsed,
      status: n.status ?? "answered",
      read: !!n.read,
    }));
  }

  buildHydration() {
    return {
      session_id: this.id,
      hole_id: this.holeId,
      title: this.title,
      root_id: this.rootId,
      // The highest event id reflected in this snapshot — the client passes it
      // back on its first /sse connect so any event broadcast in the gap between
      // serving this page and the EventSource connecting gets replayed.
      last_event_id: this.lastOutboundEventId,
      agent_attached: this.agentAttached,
      view_state: this.viewState,
      nodes: this.serializeNodes(),
    };
  }

  toHole() {
    // Answered nodes persist in full. Pending nodes persist as durable asks —
    // the question and its anchor survive, but any half-streamed markdown is
    // dropped: on resume the question is re-asked and answered fresh.
    return {
      hole_id: this.holeId,
      title: this.title,
      root_id: this.rootId,
      created_at: this.createdAt,
      view_state: this.viewState,
      nodes: [...this.nodes.values()]
        .filter((n) => (n.status ?? "answered") === "answered" || n.status === "pending")
        .map((n) => (n.status === "pending" ? { ...n, markdown: "", contentHtml: "" } : n)),
    };
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Snapshot now (synchronously) but serialize the actual writes so overlapping
    // saves can't race; each save persists the state as of when it was requested.
    const snapshot = this.toHole();
    this.savingChain = this.savingChain
      .catch(() => {})
      .then(() => saveHole(snapshot))
      .catch((err) => logError(`Save failed: ${err.message}`));
    return this.savingChain;
  }

  // ---- the answer path (agent -> server -> browser) -----------------------

  async answerBranch({ requestId, title, content, partial, signal }) {
    this.touch();
    if (this.closed) throw new Error("Rabbithole session is already closed");
    this.clearAnswerWatchdog();
    this.setAgentAttached(true);

    // The human deleted this branch while the agent was writing it — absorb the
    // answer quietly: partials ack, the final call just blocks for the next event.
    if (this.cancelledRequests.has(requestId)) {
      if (partial) return { ok: true, node_id: null, request_id: requestId, partial: true, cancelled: true };
      this.cancelledRequests.delete(requestId);
      return this.waitForEvent(signal);
    }

    const nodeId = this.pendingByRequest.get(requestId);
    if (!nodeId) throw buildJsonError(`No pending branch request ${requestId}`, 404);
    const node = this.nodes.get(nodeId);
    if (!node) throw buildJsonError(`Node ${nodeId} not found`, 404);

    // A partial call streams a chunk into the pending node and returns right
    // away — the request stays claimable, the watchdog stays armed (a death
    // mid-stream should still surface as stalled), and nothing persists yet.
    if (partial) {
      node.markdown = (node.markdown || "") + String(content ?? "");
      node.contentHtml = await renderMarkdownToHtml(node.markdown, { baseUrl: node.base_url });
      this.startAnswerWatchdog();
      this.broadcast({ type: "node_progress", node_id: node.id, contentHtml: node.contentHtml });
      return { ok: true, node_id: node.id, request_id: requestId, partial: true };
    }

    // Claim the request before the async render boundary so a concurrent
    // duplicate answer for the same request_id is rejected (404) rather than
    // both rendering and double-broadcasting the node.
    this.pendingByRequest.delete(requestId);

    // A final call after partials may carry just the remaining tail (or repeat
    // the whole answer — accept both: if the buffer already starts what content
    // finishes, append; if content restates everything, replace).
    const tail = String(content ?? "");
    const buffered = node.markdown || "";
    node.markdown = buffered && !tail.startsWith(buffered) ? buffered + tail : tail;
    node.title = String(title ?? node.title ?? "Untitled").trim() || "Untitled";
    node.contentHtml = await renderMarkdownToHtml(node.markdown, { baseUrl: node.base_url });
    node.status = "answered";
    // Fresh answers land unread; the client flips this the moment the human
    // actually opens them (and immediately if they're watching it stream).
    node.read = false;

    this.broadcast({
      type: "node_answered",
      node_id: node.id,
      parent_id: node.parent_id,
      title: node.title,
      contentHtml: node.contentHtml,
      markdown: node.markdown,
      origin: node.origin,
      position: node.position,
      size: node.size,
      font_scale: node.font_scale,
    });
    this.flushSave();

    return this.waitForEvent(signal);
  }

  buildRehydrationPayload() {
    const saved = [...this.nodes.values()].filter((n) => n.status === "pending" && n.origin);
    return {
      title: this.title,
      nodes: [...this.nodes.values()]
        .filter((n) => n.status === "answered")
        .map((n) => ({ id: n.id, parent_id: n.parent_id, title: n.title, markdown: n.markdown })),
      ...(saved.length
        ? {
            saved_asks: saved.map((n) => ({
              node_id: n.id,
              question: n.origin.question || "",
              selected_text: n.origin.selected_text || "",
            })),
          }
        : {}),
    };
  }

  // Re-queue every persisted pending ask for the agent, oldest first. Runs at
  // construction on resume, before the agent's first waitForEvent, so saved
  // questions are answered before anything new.
  requeueSavedAsks() {
    const saved = [...this.nodes.values()]
      .filter((n) => n.status === "pending" && n.origin)
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    for (const node of saved) {
      const requestId = randomUUID();
      this.pendingByRequest.set(requestId, node.id);
      const parent = this.nodes.get(node.parent_id);
      const event = {
        status: "branch_request",
        session_id: this.id,
        request_id: requestId,
        node_id: node.id,
        parent_node_id: node.parent_id,
        parent_node_title: parent?.title || "Untitled",
        selected_text: node.origin.selected_text || "",
        question: node.origin.question || "",
        lens: node.origin.lens || null,
        lineage: this.lineageTitles(node.parent_id),
        saved: true, // asked while the agent was away; answer it like any other
      };
      if (this.needsRehydration) {
        this.needsRehydration = false;
        event.rehydration = this.buildRehydrationPayload();
      }
      this.queue.push(event);
    }
  }

  // ---- browser events (browser -> server) ---------------------------------

  handleBranchRequest(payload) {
    const parentId = String(payload.parent_id || "");
    const parent = this.nodes.get(parentId);
    if (!parent) throw buildJsonError(`Parent node ${parentId} not found`, 404);

    const requestId = String(payload.request_id || randomUUID());
    const nodeId = String(payload.node_id || randomUUID());
    const selectedText = String(payload.selected_text ?? "").trim();
    const question = String(payload.question ?? "").trim();
    // A lens ask carries the full crafted question for the agent plus a short
    // lens key so every UI surface can show a tidy badge instead of the prompt.
    const lens = normalizeLens(payload.lens);
    // A synthesis ask ("summarize this whole journey") is a whole-document ask
    // that the UI renders as a distinct branch node, not a chat turn.
    const synthesis = payload.synthesis === true;
    const anchor = normalizeAnchor(payload.anchor);
    const branchType = normalizeBranchType(payload.branch_type, selectedText);

    const node = {
      id: nodeId,
      parent_id: parentId,
      title: synthesis ? "Synthesis" : lens ? LENS_LABELS[lens] : question ? truncate(question, 48) : "…",
      markdown: "",
      base_url: parent.base_url ?? null,
      contentHtml: "",
      origin: { selected_text: selectedText, question, lens, synthesis, anchor, branch_type: branchType },
      position: normalizePosition(payload.position),
      size: normalizeSize(payload.size),
      font_scale: 1,
      collapsed: false,
      status: "pending",
      read: false,
      created_at: new Date().toISOString(),
    };
    this.nodes.set(nodeId, node);
    this.pendingByRequest.set(requestId, nodeId);

    const event = {
      status: "branch_request",
      session_id: this.id,
      request_id: requestId,
      node_id: nodeId,
      parent_node_id: parentId,
      parent_node_title: parent.title || "Untitled",
      selected_text: selectedText,
      question,
      lens,
      ...(synthesis ? { synthesis: true } : {}),
      lineage: this.lineageTitles(parentId),
    };

    if (this.needsRehydration) {
      this.needsRehydration = false;
      event.rehydration = this.buildRehydrationPayload();
    }

    // Persist the ask immediately (not just on answer/close) so a crash or
    // SIGKILL between ask and answer can't lose the question.
    this.scheduleSave();

    this.pushEvent(event);
    return { ok: true, node_id: nodeId, request_id: requestId };
  }

  applyNodeFields(node, payload) {
    if (payload.position) node.position = normalizePosition(payload.position);
    if (payload.size) node.size = normalizeSize(payload.size);
    if (typeof payload.collapsed === "boolean") node.collapsed = payload.collapsed;
    if (Number.isFinite(payload.font_scale)) node.font_scale = payload.font_scale;
    if (typeof payload.read === "boolean") node.read = payload.read;
  }

  // Remove a branch and its whole subtree. Any in-flight ask targeting a doomed
  // node is cancelled (a late answer is absorbed, not errored), queued requests
  // the agent never saw are dropped, and the SSE replay buffer is scrubbed so a
  // reconnect can't resurrect a deleted node via node_answered self-healing.
  handleDeleteNode(payload) {
    const targetId = String(payload.node_id || "");
    if (!targetId || targetId === this.rootId) throw buildJsonError("Cannot delete the root document", 400);
    if (!this.nodes.has(targetId)) return { ok: true, deleted: [] };

    const doomed = new Set([targetId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.nodes.values()) {
        if (n.parent_id && doomed.has(n.parent_id) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
      }
    }
    for (const id of doomed) this.nodes.delete(id);
    for (const [reqId, nodeId] of [...this.pendingByRequest]) {
      if (doomed.has(nodeId)) {
        this.pendingByRequest.delete(reqId);
        this.cancelledRequests.add(reqId);
      }
    }
    this.queue = this.queue.filter((ev) => !(ev.node_id && doomed.has(ev.node_id)));
    this.outboundEvents = this.outboundEvents.filter((e) => !(e.data.node_id && doomed.has(e.data.node_id)));
    this.broadcast({ type: "node_deleted", node_ids: [...doomed] });
    this.scheduleSave();
    return { ok: true, deleted: [...doomed] };
  }

  handleNodeUpdate(payload) {
    const node = this.nodes.get(String(payload.node_id || ""));
    if (!node) return { ok: true }; // tolerate updates for transient nodes
    this.applyNodeFields(node, payload);
    this.scheduleSave();
    return { ok: true };
  }

  // Batched layout update (e.g. Tidy) — one request, one debounced save.
  handleNodesUpdate(payload) {
    const updates = Array.isArray(payload.nodes) ? payload.nodes : [];
    for (const u of updates) {
      const node = this.nodes.get(String(u?.node_id || ""));
      if (node) this.applyNodeFields(node, u);
    }
    this.scheduleSave();
    return { ok: true };
  }

  async handleBrowserEvent(payload) {
    const type = String(payload?.type ?? "");
    switch (type) {
      case "branch_request":
        return this.handleBranchRequest(payload);
      case "node_update":
        return this.handleNodeUpdate(payload);
      case "nodes_update":
        return this.handleNodesUpdate(payload);
      case "delete_node":
        return this.handleDeleteNode(payload);
      case "view_state":
        this.viewState = normalizeViewState(payload.state);
        this.scheduleSave();
        return { ok: true };
      case "done":
        this.close("done");
        return { ok: true };
      default:
        throw buildJsonError(`Unsupported browser event: ${type}`, 400);
    }
  }

  // ---- HTTP routing -------------------------------------------------------

  async handleRequest(req, res) {
    this.touch();
    const url = new URL(req.url || "/", this.url || "http://127.0.0.1");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      res.end(this.renderPage(this.buildHydration()));
      return;
    }

    // A read-only single-file snapshot of the whole hole: the same page with
    // `frozen: true` hydration (no SSE, no asking) and markdown baked in, served
    // as a download. The page is already self-contained, so this is the export.
    if (req.method === "GET" && url.pathname === "/export") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(this.title)}"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      res.end(this.renderPage({ ...this.buildHydration(), frozen: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      res.end(JSON.stringify({ ok: true, attached: this.agentAttached, closed: this.closed }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Connection: "keep-alive",
      });
      res.write("\n");
      // Replay anything newer than the client's checkpoint: the Last-Event-ID
      // header on reconnect, or the ?after= query (hydration's last_event_id) on
      // the first connect, so no broadcast is lost in either gap.
      const after = Number(req.headers["last-event-id"] || url.searchParams.get("after") || 0);
      for (const event of this.outboundEvents) {
        if (event.id > after) writeSseEvent(res, event);
      }
      this.everConnected = true;
      this.clearDisconnectClose();
      this.sseClients.add(res);
      req.on("close", () => {
        this.sseClients.delete(res);
        // If the browser is gone (tab closed) and doesn't reconnect within the
        // grace window, close the session instead of blocking until timeout.
        if (this.everConnected && this.sseClients.size === 0) this.scheduleDisconnectClose();
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/events") {
      try {
        const payload = await parseRequestBody(req, res);
        const result = await this.handleBrowserEvent(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        if (err?.statusCode === 413) return;
        const status = err?.statusCode || 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

// The preset lenses the ask popup offers. Keys travel in origin.lens; labels
// name the node so a lens branch reads "ELI5", not its canned prompt.
const LENS_LABELS = { explain: "Explain", eli5: "ELI5", example: "Example", deeper: "Go Deeper" };

function normalizeLens(lens) {
  const key = String(lens ?? "").trim();
  return Object.prototype.hasOwnProperty.call(LENS_LABELS, key) ? key : null;
}

function normalizeBranchType(type, selectedText) {
  const key = String(type ?? "").trim();
  if (key === "selection" || key === "followup") return key;
  return selectedText ? "selection" : "followup";
}

function normalizePosition(pos) {
  return {
    x: Number(pos?.x) || 0,
    y: Number(pos?.y) || 0,
  };
}

function normalizeSize(size) {
  if (!size) return null;
  const w = Number(size.w);
  const h = Number(size.h);
  if (!w || !h) return null;
  return { w, h };
}

function normalizeAnchor(anchor) {
  if (!anchor) return null;
  const start = Math.max(0, Number(anchor.offset_start) || 0);
  const end = Math.max(start, Number(anchor.offset_end) || start);
  return { offset_start: start, offset_end: end };
}

// The persisted "where was I" blob — kept tiny and strictly shaped so a
// malformed client post can't bloat the hole file.
function normalizeViewState(s) {
  if (!s || typeof s !== "object") return null;
  const out = {
    mode: s.mode === "canvas" ? "canvas" : "reader",
    node_id: typeof s.node_id === "string" ? s.node_id.slice(0, 128) : null,
    scroll: Math.max(0, Number(s.scroll) || 0),
  };
  if (s.view && typeof s.view === "object") {
    out.view = {
      x: Number(s.view.x) || 0,
      y: Number(s.view.y) || 0,
      scale: Math.min(2.5, Math.max(0.15, Number(s.view.scale) || 1)),
    };
  }
  return out;
}

// Download filename for /export — slug of the title, safe for a header.
function exportFilename(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `rabbithole-${slug || "export"}.html`;
}
