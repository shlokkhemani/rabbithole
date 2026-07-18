import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openBrowser } from "./browser.js";
import { log, error as logError } from "../logger.js";
import { addAssetsToHole, defaultFsStore, resolveAsset } from "../fs-store.js";
import { maybeUpgradeBaseUrlFromFrontmatter, normalizeBaseUrl } from "../../core/base-url.js";
import { extractNodeAssetRefs } from "../../core/assets.js";
import { createHoleState, holeStateToHole, holeStateToHydrationNodes, reduceHoleEvent } from "../../core/reducer.js";
import { toPersistedHole } from "../../core/schema.js";
import { lineageTitlesFromMap, normalizePdfAnchor } from "../../core/model.js";
import { buildJsonError, closeServerGracefully, CLOSE_TIMEOUT_MS } from "./http.js";
import { writeSseEvent } from "./sse.js";
import { handleSessionRequest } from "./session-router.js";
import { GenerationIngress } from "./generation-ingress.js";
import { applyPersistedBrowserEvent, assetsOrphanedByDeletion, buildNodeAnsweredEvent, createSaveChain, dispatchBrowserEvent } from "../../core/hole-host.js";
import { MAX_PDF_FIGURE_ASSET_BYTES, normalizePdfExtension, parseFigureRefs, rewriteFigureRefs } from "../../core/pdf-shared.js";
import { TRANSCRIBE_V1_RULES } from "../../core/prompts/transcribe-v1.js";
import { cropPdfFigureToAsset, cropPdfRegionToFile, renderPdfPageToFile, sweepPdfRegionFiles } from "../pdf-crop.js";

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
  constructor({ holeId, title, rootId, createdAt, nodes, assetNames, viewState, isResume, renderPage, onClose, mintGenerationRunId = randomUUID }) {
    this.id = randomUUID();
    this.holeId = holeId || randomUUID();
    this.title = title || "Untitled";
    this.rootId = rootId || null;
    this.createdAt = createdAt || new Date().toISOString();
    this.assetNames = new Set(assetNames || []);
    this.renderPage = renderPage;
    this.onClose = onClose;
    this.mintGenerationRunId = mintGenerationRunId;

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
    this.generationByRequest = new Map(); // request_id -> active MCP generation ingress
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
    this.convertRequests = new Map();
    // Legacy/failure-fallback transient region JPEGs (request_id -> path).
    // Successful region asks use branch-owned crop-* assets instead.
    this.regionFiles = new Map();
    this.regionSweep = isResume ? sweepPdfRegionFiles(this.holeId).catch(() => {}) : Promise.resolve();

    this.sseClients = new Set();
    this.everConnected = false;
    this.disconnectTimer = null;
    this.outboundEvents = [];
    this.lastOutboundEventId = 0;

    this.timeoutHandle = null;
    this.saveTimer = null;
    this.saveChain = createSaveChain({
      debounceMs: SAVE_DEBOUNCE_MS,
      onTimerChange: (timer) => { this.saveTimer = timer; },
      save: () => {
        const snapshot = this.toHole();
        return () => defaultFsStore.saveHole(snapshot).catch((err) => logError(`Save failed: ${err.message}`));
      },
    });
    this.savingChain = Promise.resolve();
    this.shutdownScheduled = false;

    // Saved asks: questions the human asked while no agent was listening are
    // persisted as pending nodes; a resume re-queues each one (oldest first,
    // under a fresh request_id) so the agent answers them right away.
    if (isResume) { this.requeueSavedAsks(); this.requeueSavedConversions(); }

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
    for (const request of this.convertRequests.values()) if (request.markdown) this.restoreNodeConversion(request.node_id);
    // Only this session's own crops — a successor session for the same hole may
    // already be writing fresh ones under different request ids.
    for (const filePath of this.regionFiles.values()) fs.unlink(filePath).catch(() => {});
    this.regionFiles.clear();
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
    this.generationByRequest.clear();
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
    if (event && (event.status === "branch_request" || event.status === "convert_request")) {
      this.inFlightBranchRequests.set(event.request_id, event);
      this.startAnswerWatchdog();
    }
    return event;
  }

  nextInFlightBranchRequest() {
    for (const [requestId, event] of this.inFlightBranchRequests) {
      // A conversion has no pending node — it stays redeliverable for as long
      // as its run is live, so a keep_listening re-arm can't drop it.
      if (event.status === "convert_request") {
        if (this.convertRequests.has(requestId)) return event;
        this.inFlightBranchRequests.delete(requestId);
        continue;
      }
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
    if (!attached) for (const request of this.convertRequests.values()) if (request.markdown) this.restoreNodeConversion(request.node_id);
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
    const reduced = reduceHoleEvent(this.state, event, { ...options, mutate: true });
    this.state = reduced.state;
    this.nodes = this.state.nodes;
    this.viewState = this.state.view_state;
    return reduced.effects || {};
  }

  lineageTitles(nodeId) {
    return lineageTitlesFromMap(this.nodes, nodeId);
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
      nodes: holeStateToHydrationNodes(this.state),
    };
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
    this.saveChain.schedule();
  }

  flushSave() {
    this.savingChain = this.saveChain.flush();
    return this.savingChain;
  }

  // ---- the answer path (agent -> server -> browser) -----------------------

  createGenerationIngress(node) {
    return new GenerationIngress({
      id: this.mintGenerationRunId(),
      nodeId: node.id,
      fallbackTitle: node.title || "Untitled",
    });
  }

  async answerBranch({ requestId, title, content, partial, baseUrl, assets, signal }) {
    this.touch();
    if (this.closed) throw new Error("Rabbithole session is already closed");
    this.clearAnswerWatchdog();
    this.markAgentAttached();
    this.inFlightBranchRequests.delete(requestId);
    if (!partial) this.discardRegionFile(requestId);
    if (this.convertRequests.has(requestId)) return this.answerConversion({ requestId, content, partial, signal });

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
    let ingress = this.generationByRequest.get(requestId);
    if (!ingress) {
      ingress = this.createGenerationIngress(node);
      this.generationByRequest.set(requestId, ingress);
    }

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
      const progress = ingress.acceptChunk(content, { progressFields: baseUrlFields });
      this.dispatchHoleEvent(progress);
      const updated = this.nodes.get(node.id);
      this.startAnswerWatchdog();
      // Deliberately untagged outbound projection: `progress` already passed
      // through the reducer with its GenerationRun tag; the SSE payload mirrors
      // canonical node state and is never reducer input.
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
    this.generationByRequest.delete(requestId);

    // GenerationIngress accepts both final tails and repeated full answers;
    // the session remains responsible only for node metadata and lifecycle.
    const answeredFields = {
      parent_id: node.parent_id,
      ...baseUrlFields,
      origin: node.origin,
      position: node.position,
      size: node.size,
      font_scale: node.font_scale,
      // Fresh answers land unread; the client flips this the moment the human
      // actually opens them (and immediately if they're watching it stream).
      read: false,
    };
    const answered = ingress.acceptChunk(content, { final: true, title, answeredFields });
    if (!explicitBaseUrl) maybeUpgradeBaseUrlFromFrontmatter(answered);
    this.dispatchHoleEvent(answered);
    const finalNode = this.nodes.get(nodeId);

    this.broadcast(buildNodeAnsweredEvent(finalNode));
    this.flushSave();

    return this.waitForEvent(signal);
  }

  async answerConversion({ requestId, content, partial, signal }) {
    const request = this.convertRequests.get(requestId), node = this.nodes.get(request.node_id);
    if (!node) throw buildJsonError("Conversion node not found", 404);
    request.markdown += String(content || "");
    // request.pdf was validated at convert start against the original body —
    // the live body is the stream itself, so re-normalizing here would fail.
    const pdf = request.pdf;
    this.dispatchHoleEvent({ type: "node_progress", node_id: node.id, markdown: request.markdown });
    this.broadcast({ type: "pdf_convert_progress", node_id: node.id, markdown: request.markdown, page_done: pdf.pages.at(-1)?.n || 0, page_total: pdf.pages.length });
    if (partial) { this.startAnswerWatchdog(); this.scheduleSave(); return { ok: true, node_id: node.id, request_id: requestId, partial: true }; }
    const materialized = await this.materializeNodeFigures(request.markdown, pdf);
    this.dispatchHoleEvent({ ...buildNodeAnsweredEvent(this.nodes.get(node.id)), markdown: materialized });
    this.patchNodePdf(node.id, { ...pdf, converting: false, converted: true, convert_request: false });
    this.convertRequests.delete(requestId); await this.flushSave(); this.broadcast(buildNodeAnsweredEvent(this.nodes.get(node.id)));
    return this.waitForEvent(signal);
  }

  discardRegionFile(requestId) {
    const filePath = this.regionFiles.get(requestId);
    if (!filePath) return;
    this.regionFiles.delete(requestId);
    fs.unlink(filePath).catch(() => {});
  }

  async materializeNodeFigures(markdown, pdf, figureBudget = { bytes: 0 }) {
    const replacements = []; let ordinal = 0;
    for (const ref of parseFigureRefs(markdown)) {
      let replacement = `*${ref.caption || "Figure"}*`; const page = pdf.pages.find((entry) => entry.n === ref.page);
      // Figures share the export headroom — past the byte budget or asset cap
      // they degrade to caption text, never fail the conversion.
      if (page && ref.rect && this.assetNames.size < 200 && figureBudget.bytes < MAX_PDF_FIGURE_ASSET_BYTES) try {
        const name = `fig-p${String(ref.page).padStart(3, "0")}-${++ordinal}.png`;
        const { bytes } = await cropPdfFigureToAsset({ holeId: this.holeId, asset: pdf.source.asset, pageNumber: page.n, rect: ref.rect, name });
        if (figureBudget.bytes + bytes > MAX_PDF_FIGURE_ASSET_BYTES) { await defaultFsStore.deleteAsset(this.holeId, name).catch(() => {}); throw new Error("figure budget"); }
        figureBudget.bytes += bytes; this.assetNames.add(name); replacement = `![${ref.caption}](asset:${name})`;
      } catch {}
      replacements.push({ ref, markdown: replacement });
    }
    return rewriteFigureRefs(markdown, replacements);
  }

  patchNodePdf(nodeId, value) { this.dispatchHoleEvent({ type: "node_extensions_patch", node_id: nodeId, namespace: "pdf", value }); this.broadcast({ type: "node_extensions_patch", node_id: nodeId, namespace: "pdf", value }); this.scheduleSave(); }

  // Restore reads the RAW extension: mid-run the node body is the streamed
  // output, so normalizePdfExtension (which validates offsets against the live
  // body) would reject exactly the state this method exists to repair.
  restoreNodeConversion(nodeId) {
    const raw = this.nodes.get(nodeId)?.extensions?.pdf;
    if (!raw || raw.version !== 2) return;
    this.dispatchHoleEvent({ type: "node_progress", node_id: nodeId, markdown: String(raw.original_markdown ?? this.nodes.get(nodeId).markdown ?? "") });
    this.patchNodePdf(nodeId, { ...raw, converting: false, converted: false, convert_request: false });
    for (const [id, request] of this.convertRequests) if (request.node_id === nodeId) this.convertRequests.delete(id);
  }

  async handleConvertPdf(payload, { saved = false } = {}) {
    const nodeId = String(payload.node_id || ""), node = this.nodes.get(nodeId), pdf = normalizePdfExtension(node);
    if (!pdf) throw buildJsonError("This node is not a native PDF", 400);
    if ([...this.nodes.values()].some((candidate) => candidate.parent_id === nodeId)) throw buildJsonError("Create a text version before asking follow-ups", 409);
    if (pdf.converting && !saved) throw buildJsonError("Conversion is already running", 409);
    const requestId = randomUUID();
    if (!pdf.converting) this.patchNodePdf(nodeId, { ...pdf, converting: true, converted: false, original_markdown: node.markdown, convert_request: true });
    const activePdf = normalizePdfExtension({ markdown: node.markdown, extensions: { pdf: this.nodes.get(nodeId).extensions?.pdf } });
    this.convertRequests.set(requestId, { node_id: nodeId, markdown: "", pdf: activePdf });
    const pages = await Promise.all(activePdf.pages.map(async (page) => {
      const key = `convert-${requestId}-${page.n}`;
      const imagePath = await renderPdfPageToFile({ holeId: this.holeId, asset: activePdf.source.asset, pageNumber: page.n, requestId: key });
      this.regionFiles.set(key, imagePath);
      return { n: page.n, image_path: imagePath };
    }));
    const event = { status: "convert_request", session_id: this.id, request_id: requestId, node_id: nodeId, page_count: activePdf.pages.length,
      pages, rules: TRANSCRIBE_V1_RULES, ...(saved ? { saved: true } : {}) };
    this.pushEvent(event); await this.flushSave(); return { ok: true, node_id: nodeId, request_id: requestId };
  }

  requeueSavedConversions() {
    for (const node of this.nodes.values()) {
      const raw = node?.extensions?.pdf;
      if (!raw || raw.version !== 2 || !raw.converting) continue;
      // Mid-run saves persist the streamed body — put the original back before
      // deciding anything else, then re-issue the request as a saved convert.
      this.restoreNodeConversion(node.id);
      if (raw.convert_request) queueMicrotask(() => this.handleConvertPdf({ node_id: node.id }, { saved: true }).catch((error) => logError(error.message)));
    }
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
    let enqueue = Promise.resolve();
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
      enqueue = enqueue.then(() => this.queueBranchEvent(event, node, parent));
    }
    enqueue.catch((error) => logError(`Saved branch requeue failed: ${error.message}`));
  }

  // ---- browser events (browser -> server) ---------------------------------

  handleBranchRequest(payload, preparedCrop = null) {
    const parentId = String(payload.parent_id || "");
    const parent = this.nodes.get(parentId);
    if (!parent) throw buildJsonError(`Parent node ${parentId} not found`, 404);
    // Raw flag, not normalizePdfExtension: mid-run the body is the stream and
    // normalization rejects it — which would drop the lock exactly when it matters.
    if (parent.extensions?.pdf?.converting) throw buildJsonError("This PDF is being converted", 409);

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
      lineage: this.lineageTitles(parentId),
    };

    if (this.needsRehydration) {
      this.needsRehydration = false;
      event.rehydration = this.buildRehydrationPayload();
    }

    // Persist the ask immediately (not just on answer/close) so a crash or
    // SIGKILL between ask and answer can't lose the question.
    this.scheduleSave();

    this.queueBranchEvent(event, node, parent, preparedCrop).catch((error) => {
      logError(`PDF region attachment failed: ${error.message}`);
      this.pushEvent(event);
    });
    return { ok: true, node_id: nodeId, request_id: requestId };
  }

  async preparePdfCrop(payload) {
    const parent = this.nodes.get(String(payload.parent_id || ""));
    const anchor = normalizePdfAnchor(payload.anchor?.pdf);
    const pdf = normalizePdfExtension(parent);
    const pageNumber = anchor?.fragments?.[0]?.page;
    if (!pdf || !pageNumber || !pdf.pages.some((entry) => entry.n === pageNumber)) return null;
    await this.regionSweep;
    const imagePath = await cropPdfRegionToFile({ holeId: this.holeId, asset: pdf.source.asset, anchor, pageNumber, requestId: payload.request_id });
    this.regionFiles.set(String(payload.request_id), imagePath);
    return { imagePath, page: pageNumber };
  }

  async queueBranchEvent(event, node, parent, preparedCrop = null) {
    if (preparedCrop?.imagePath) {
      event.region = { page: preparedCrop.page, image_path: preparedCrop.imagePath };
      this.pushEvent(event);
      return;
    }

    const anchor = node?.origin?.anchor?.pdf || parent?.origin?.anchor?.pdf;
    let sourceNode = parent;
    while (sourceNode && !normalizePdfExtension(sourceNode)) sourceNode = this.nodes.get(sourceNode.parent_id);
    const pdf = anchor ? normalizePdfExtension(sourceNode) : null;
    const pageNumber = anchor?.fragments?.[0]?.page;
    if (pdf && pageNumber && pdf.pages.some((entry) => entry.n === pageNumber)) try {
      await this.regionSweep;
      const imagePath = await cropPdfRegionToFile({ holeId: this.holeId, asset: pdf.source.asset, anchor, pageNumber, requestId: event.request_id });
      event.region = { page: pageNumber, image_path: imagePath };
      this.regionFiles.set(event.request_id, imagePath);
    } catch (error) {
      logError(`PDF region crop failed: ${error.message}`);
    }
    this.pushEvent(event);
  }

  // Remove a branch and its whole subtree. Any in-flight ask targeting a doomed
  // node is cancelled (a late answer is absorbed, not errored), queued requests
  // the agent never saw are dropped, and the SSE replay buffer is scrubbed so a
  // reconnect can't resurrect a deleted node via node_answered self-healing.
  async handleDeleteNode(payload) {
    const targetId = String(payload.node_id || "");
    if (!targetId || targetId === this.rootId) throw buildJsonError("The starting document can't be removed", 400);
    if (!this.nodes.has(targetId)) return { ok: true, deleted: [] };

    const effects = this.dispatchHoleEvent({ type: "delete_node", node_id: targetId });
    const doomed = new Set(effects.deletedNodeIds || []);
    for (const [reqId, nodeId] of [...this.pendingByRequest]) {
      if (doomed.has(nodeId)) {
        this.pendingByRequest.delete(reqId);
        this.generationByRequest.delete(reqId);
        this.cancelledRequests.add(reqId);
        this.inFlightBranchRequests.delete(reqId);
        this.discardRegionFile(reqId);
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
    const orphaned = assetsOrphanedByDeletion({ deletedNodes, remainingNodes: this.nodes.values(), extractRefs: extractNodeAssetRefs });
    for (const name of orphaned) {
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
    return this.applyPersistedBrowserEvent(payload);
  }

  // Batched layout update (e.g. Tidy) — one request, one debounced save.
  handleNodesUpdate(payload) {
    return this.applyPersistedBrowserEvent(payload);
  }

  applyPersistedBrowserEvent(payload) {
    return applyPersistedBrowserEvent(payload, {
      dispatch: (event) => this.dispatchHoleEvent(event),
      scheduleSave: () => this.scheduleSave(),
    });
  }

  async handleBrowserEvent(payload) {
    return dispatchBrowserEvent(payload, {
      handlers: {
        branch_request: async (event) => {
          let preparedCrop = null;
          try { preparedCrop = await this.preparePdfCrop(event); }
          catch (error) { logError(`PDF crop persistence failed: ${error.message}`); }
          const result = this.handleBranchRequest(event, preparedCrop);
          await this.flushSave();
          return result;
        },
        node_update: (event) => this.handleNodeUpdate(event),
        nodes_update: (event) => this.handleNodesUpdate(event),
        block_state: (event) => this.applyPersistedBrowserEvent(event),
        node_extensions_patch: (event) => {
          const result = this.applyPersistedBrowserEvent(event);
          this.broadcast({ type: "node_extensions_patch", node_id: event.node_id, namespace: event.namespace, value: event.value });
          return result;
        },
        convert_pdf: (event) => this.handleConvertPdf(event),
        convert_cancel: (event) => { this.restoreNodeConversion(String(event.node_id || "")); return { ok: true }; },
        delete_node: (event) => this.handleDeleteNode(event),
        view_state: (event) => this.applyPersistedBrowserEvent(event),
        done: () => { this.close("done"); return { ok: true }; },
      },
      unsupported: (type) => { throw buildJsonError(`Unsupported browser event: ${type}`, 400); },
    });
  }

  // ---- HTTP routing -------------------------------------------------------

  async handleRequest(req, res) {
    return handleSessionRequest(this, req, res);
  }
}
