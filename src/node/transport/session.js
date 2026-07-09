import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openBrowser } from "./browser.js";
import { log, error as logError } from "../logger.js";
import { addAssetsToHole, defaultFsStore, getAssetContentType, resolveAsset } from "../fs-store.js";
import { maybeUpgradeBaseUrlFromFrontmatter, normalizeBaseUrl } from "../../core/base-url.js";
import { extractAssetRefsFromMarkdown } from "../../core/assets.js";
import { createHoleState, holeStateToHole, reduceHoleEvent } from "../../core/reducer.js";
import { lineageTitlesFromMap } from "../../core/model.js";
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
const DEFAULT_MAX_BLOCK_MS = 240 * 1000;
const REARM_GRACE_MS = 20 * 1000;
// Cap on retained SSE events for reconnect replay, so a long-lived session
// doesn't grow this array without bound.
const MAX_REPLAY_EVENTS = 500;
// After a branch_request is handed to the agent, expect answer_branch within
// this window. If nothing comes back the agent likely died mid-generation
// (cancelled without an MCP request in flight) — tell the browser so pending
// asks don't shimmer forever. Self-heals: any later agent call re-attaches.
const ANSWER_WATCHDOG_MS = 4 * 60 * 1000;

function maxBlockMs() {
  const value = Number(process.env.RABBITHOLE_MAX_BLOCK_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_BLOCK_MS;
}

/**
 * One live Rabbithole: the node tree, the browser transport, and the
 * agent-facing event queue. The agent blocks on waitForEvent(); the browser
 * drives the canvas and posts branch requests / node updates.
 */
export class RabbitHoleSession {
  constructor({ holeId, title, rootId, createdAt, nodes, assetNames, viewState, isResume, renderPage, onClose }) {
    this.id = randomUUID();
    this.holeId = holeId || randomUUID();
    this.title = title || "Untitled";
    this.rootId = rootId || null;
    this.createdAt = createdAt || new Date().toISOString();
    this.assetNames = new Set(assetNames || []);
    this.renderPage = renderPage;
    this.onClose = onClose;

    this.state = createHoleState({
      hole_id: this.holeId,
      title: this.title,
      root_id: this.rootId,
      created_at: this.createdAt,
      view_state: viewState ?? null,
      nodes,
    });
    this.nodes = this.state.nodes;
    this.viewState = this.state.view_state;

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
    this.rearmDetachTimer = null;
    this.inFlightBranchRequests = new Map(); // request_id -> last delivered branch_request not yet answered

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
    this.clearRearmDetach();
    this.clearDisconnectClose();
    this.flushSave();

    this.broadcast({ type: "session_closed", reason });

    // Drop any queued (now unanswerable) branch requests and release every
    // blocked agent call with session_closed.
    this.queue.length = 0;
    this.inFlightBranchRequests.clear();
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
    this.markAgentAttached();
    if (this.queue.length > 0) return Promise.resolve(this.deliverToAgent(this.queue.shift()));
    const inFlight = this.nextInFlightBranchRequest();
    if (inFlight) return Promise.resolve(this.deliverToAgent(inFlight));
    // FIFO of waiters so concurrent waitForEvent() calls never orphan each other.
    return new Promise((resolve) => {
      let done = false;
      let budgetTimer = null;
      let waiter = null;
      const finish = (event, { deliver = true } = {}) => {
        if (done) return;
        done = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        waiter?.cleanup?.();
        resolve(deliver ? this.deliverToAgent(event) : event);
      };
      const onAbort = () => {
        this.clearAnswerWatchdog();
        this.setAgentAttached(false, "cancelled");
        finish({ status: "cancelled", session_id: this.id }, { deliver: false });
      };
      const cleanup = () => {
        if (budgetTimer) {
          clearTimeout(budgetTimer);
          budgetTimer = null;
        }
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      waiter = { resolve: (event) => finish(event), cleanup };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      budgetTimer = setTimeout(() => {
        this.scheduleRearmDetach();
        finish(this.keepListeningResult(), { deliver: false });
      }, maxBlockMs());
      budgetTimer.unref?.();
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
    if (event && event.status === "branch_request") {
      this.inFlightBranchRequests.set(event.request_id, event);
      this.startAnswerWatchdog();
    }
    return event;
  }

  nextInFlightBranchRequest() {
    for (const [requestId, event] of this.inFlightBranchRequests) {
      const nodeId = this.pendingByRequest.get(requestId);
      const node = nodeId ? this.nodes.get(nodeId) : null;
      if (node && node.status === "pending") return event;
      this.inFlightBranchRequests.delete(requestId);
    }
    return null;
  }

  keepListeningResult() {
    return {
      status: "keep_listening",
      session_id: this.id,
      hole_id: this.holeId,
      instruction:
        `Immediately call open_rabbithole with {"hole_id":"${this.holeId}"} to keep listening. ` +
        "Do not re-send content; pending asks are saved and will be delivered on re-attach.",
    };
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

  scheduleRearmDetach() {
    this.clearRearmDetach();
    this.rearmDetachTimer = setTimeout(() => {
      this.rearmDetachTimer = null;
      if (!this.closed) this.setAgentAttached(false, "cancelled");
    }, REARM_GRACE_MS);
    this.rearmDetachTimer.unref?.();
  }

  clearRearmDetach() {
    if (this.rearmDetachTimer) {
      clearTimeout(this.rearmDetachTimer);
      this.rearmDetachTimer = null;
    }
  }

  markAgentAttached() {
    this.clearRearmDetach();
    this.setAgentAttached(true);
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

  dispatchHoleEvent(event, options = {}) {
    const reduced = reduceHoleEvent(this.state, event, options);
    this.state = reduced.state;
    this.nodes = this.state.nodes;
    this.viewState = this.state.view_state;
    return reduced.effects || {};
  }

  lineageTitles(nodeId) {
    return lineageTitlesFromMap(this.nodes, nodeId);
  }

  // For the browser page. Markdown is canonical on the wire; the page derives
  // safe HTML through the shared browser-bundled renderer.
  serializeNodes() {
    return [...this.nodes.values()].map((n) => ({
      id: n.id,
      parent_id: n.parent_id ?? null,
      title: n.title ?? "",
      markdown: n.markdown ?? "",
      base_url: n.base_url ?? null,
      base_url_source: n.base_url_source ?? null,
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

  async buildExportHydration() {
    const hydration = { ...this.buildHydration(), frozen: true, asset_data: {} };
    const dataUriCache = new Map();
    for (const name of [...this.assetNames].sort()) {
      hydration.asset_data[name] = await this.assetDataUri(name, dataUriCache);
    }
    return hydration;
  }

  async assetDataUri(name, dataUriCache) {
    if (dataUriCache.has(name)) return dataUriCache.get(name);
    let dataUri = "data:,";
    try {
      const filePath = await resolveAsset(this.holeId, name);
      if (filePath) {
        const bytes = await fs.readFile(filePath);
        dataUri = `data:${getAssetContentType(name)};base64,${bytes.toString("base64")}`;
      }
    } catch {}
    dataUriCache.set(name, dataUri);
    return dataUri;
  }

  toHole() {
    // Answered nodes persist in full. Pending nodes persist as durable asks —
    // the question and its anchor survive, but any half-streamed markdown is
    // dropped: on resume the question is re-asked and answered fresh.
    const hole = holeStateToHole(this.state);
    return {
      ...hole,
      nodes: hole.nodes
        .filter((n) => (n.status ?? "answered") === "answered" || n.status === "pending")
        .map((n) => (n.status === "pending" ? { ...n, markdown: "" } : n)),
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
      .then(() => defaultFsStore.saveHole(snapshot))
      .catch((err) => logError(`Save failed: ${err.message}`));
    return this.savingChain;
  }

  // ---- the answer path (agent -> server -> browser) -----------------------

  async answerBranch({ requestId, title, content, partial, baseUrl, assets, signal }) {
    this.touch();
    if (this.closed) throw new Error("Rabbithole session is already closed");
    this.clearAnswerWatchdog();
    this.markAgentAttached();
    this.inFlightBranchRequests.delete(requestId);

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

    const addedAssets = await addAssetsToHole(this.holeId, assets);
    for (const asset of addedAssets) this.assetNames.add(asset.name);

    const explicitBaseUrl = normalizeBaseUrl(baseUrl);
    const baseUrlFields = explicitBaseUrl
      ? { base_url: explicitBaseUrl, base_url_source: "explicit" }
      : { base_url: node.base_url, base_url_source: node.base_url_source };

    // A partial call streams a chunk into the pending node and returns right
    // away — the request stays claimable, the watchdog stays armed (a death
    // mid-stream should still surface as stalled), and nothing persists yet.
    if (partial) {
      const markdown = (node.markdown || "") + String(content ?? "");
      this.dispatchHoleEvent({
        type: "node_progress",
        node_id: node.id,
        markdown,
        ...baseUrlFields,
      });
      const updated = this.nodes.get(node.id);
      this.startAnswerWatchdog();
      this.broadcast({
        type: "node_progress",
        node_id: updated.id,
        markdown: updated.markdown,
        base_url: updated.base_url,
        base_url_source: updated.base_url_source,
      });
      return { ok: true, node_id: updated.id, request_id: requestId, partial: true };
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
    const answered = {
      ...node,
      ...baseUrlFields,
      markdown: buffered && !tail.startsWith(buffered) ? buffered + tail : tail,
      title: String(title ?? node.title ?? "Untitled").trim() || "Untitled",
      status: "answered",
      // Fresh answers land unread; the client flips this the moment the human
      // actually opens them (and immediately if they're watching it stream).
      read: false,
    };
    if (!explicitBaseUrl) maybeUpgradeBaseUrlFromFrontmatter(answered);
    this.dispatchHoleEvent({
      type: "node_answered",
      node_id: answered.id,
      parent_id: answered.parent_id,
      title: answered.title,
      markdown: answered.markdown,
      base_url: answered.base_url,
      base_url_source: answered.base_url_source,
      origin: answered.origin,
      position: answered.position,
      size: answered.size,
      font_scale: answered.font_scale,
      read: answered.read,
    });
    const finalNode = this.nodes.get(nodeId);

    this.broadcast({
      type: "node_answered",
      node_id: finalNode.id,
      parent_id: finalNode.parent_id,
      title: finalNode.title,
      markdown: finalNode.markdown,
      base_url: finalNode.base_url,
      base_url_source: finalNode.base_url_source,
      origin: finalNode.origin,
      position: finalNode.position,
      size: finalNode.size,
      font_scale: finalNode.font_scale,
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
        ...(node.origin.synthesis ? { synthesis: true } : {}),
        ...(node.origin.synthesis_mode ? { synthesis_mode: node.origin.synthesis_mode } : {}),
        ...(node.origin.synthesis_sources ? { synthesis_sources: node.origin.synthesis_sources } : {}),
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
    const effects = this.dispatchHoleEvent(
      { ...payload, type: "branch_request", request_id: requestId, node_id: nodeId, parent_id: parentId },
      { now: new Date().toISOString() }
    );
    const node = effects.createdNode;
    this.pendingByRequest.set(requestId, nodeId);

    const event = {
      status: "branch_request",
      session_id: this.id,
      request_id: requestId,
      node_id: nodeId,
      parent_node_id: parentId,
      parent_node_title: parent.title || "Untitled",
      selected_text: node.origin.selected_text,
      question: node.origin.question,
      lens: node.origin.lens,
      ...(node.origin.synthesis ? { synthesis: true } : {}),
      ...(node.origin.synthesis_mode ? { synthesis_mode: node.origin.synthesis_mode } : {}),
      ...(node.origin.synthesis_sources ? { synthesis_sources: node.origin.synthesis_sources } : {}),
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

  // Remove a branch and its whole subtree. Any in-flight ask targeting a doomed
  // node is cancelled (a late answer is absorbed, not errored), queued requests
  // the agent never saw are dropped, and the SSE replay buffer is scrubbed so a
  // reconnect can't resurrect a deleted node via node_answered self-healing.
  async handleDeleteNode(payload) {
    const targetId = String(payload.node_id || "");
    if (!targetId || targetId === this.rootId) throw buildJsonError("Cannot delete the root document", 400);
    if (!this.nodes.has(targetId)) return { ok: true, deleted: [] };

    const effects = this.dispatchHoleEvent({ type: "delete_node", node_id: targetId });
    const doomed = new Set(effects.deletedNodeIds || []);
    for (const [reqId, nodeId] of [...this.pendingByRequest]) {
      if (doomed.has(nodeId)) {
        this.pendingByRequest.delete(reqId);
        this.cancelledRequests.add(reqId);
        this.inFlightBranchRequests.delete(reqId);
      }
    }
    this.queue = this.queue.filter((ev) => !(ev.node_id && doomed.has(ev.node_id)));
    this.outboundEvents = this.outboundEvents.filter((e) => !(e.data.node_id && doomed.has(e.data.node_id)));
    await this.gcAssetsForDeletedNodes(effects.deletedNodes || []);
    this.broadcast({ type: "node_deleted", node_ids: [...doomed] });
    this.scheduleSave();
    return { ok: true, deleted: [...doomed] };
  }

  async gcAssetsForDeletedNodes(deletedNodes) {
    const deletedRefs = new Set();
    for (const node of deletedNodes) {
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) deletedRefs.add(name);
    }
    if (!deletedRefs.size) return;

    const remainingRefs = new Set();
    for (const node of this.nodes.values()) {
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) remainingRefs.add(name);
    }

    for (const name of deletedRefs) {
      if (remainingRefs.has(name)) continue;
      try {
        await defaultFsStore.deleteAsset(this.holeId, name);
        this.assetNames.delete(name);
      } catch (err) {
        logError(`Asset GC failed for ${name}: ${err.message}`);
      }
    }
  }

  handleNodeUpdate(payload) {
    if (!this.nodes.has(String(payload.node_id || ""))) return { ok: true }; // tolerate updates for transient nodes
    this.dispatchHoleEvent({ ...payload, type: "node_update" });
    this.scheduleSave();
    return { ok: true };
  }

  // Batched layout update (e.g. Tidy) — one request, one debounced save.
  handleNodesUpdate(payload) {
    this.dispatchHoleEvent({ ...payload, type: "nodes_update" });
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
        this.dispatchHoleEvent({ ...payload, type: "view_state" });
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
    const assetRequestName = rawAssetRequestName(req.url);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      res.end(this.renderPage(this.buildHydration()));
      return;
    }

    if (req.method === "GET" && assetRequestName !== undefined) {
      await this.serveAsset(assetRequestName, res);
      return;
    }

    // A read-only single-file snapshot of the whole hole: the same page with
    // Compatibility shim for saved links/tests. The in-app Download snapshot flow
    // generates the same frozen page in the browser; this route only packages the
    // current server state with data-URI assets and the frozen client bundle.
    if (req.method === "GET" && url.pathname === "/export") {
      const hydration = await this.buildExportHydration();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(this.title)}"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      res.end(this.renderPage(hydration));
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

  async serveAsset(name, res) {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (!name) {
      res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    let filePath = null;
    try {
      filePath = await resolveAsset(this.holeId, name);
    } catch {
      filePath = null;
    }
    if (!filePath) {
      res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    try {
      const bytes = await fs.readFile(filePath);
      res.writeHead(200, { ...headers, "Content-Type": getAssetContentType(name) });
      res.end(bytes);
    } catch {
      res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }
}

function rawAssetRequestName(reqUrl) {
  const rawPath = String(reqUrl || "").split(/[?#]/, 1)[0];
  if (!rawPath.startsWith("/assets/")) return undefined;
  const name = rawPath.slice("/assets/".length);
  if (!name || /[\/\\%]/.test(name)) return null;
  return name;
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
