import http from "node:http";
import { systemClock } from "../../../core/clock.js";
import { HoleEngine } from "../../../core/engine/hole-engine.js";
import { openBrowser } from "../../shared/process.js";
import { log, error as logError } from "../../shared/logger.js";
import { closeServerGracefully } from "../../shared/http.js";
import { assertHttpRequest, HttpGuardError } from "../../shared/http-guard.js";
import { defaultFsStore } from "../store/fs-store.js";
import { sweepPdfRegionFiles } from "../pdf/crop.js";
import { unavailableContextUsage } from "../../context-gauge/usage.js";
import { RequestTable } from "./request-table.js";
import { SessionCrops } from "./crops.js";
import { shortId } from "../../shared/ids.js";

const SAVE_DEBOUNCE_MS = 400;

/** Local server, lifetime, and owned state for one MCP-backed Rabbithole. */
export class SessionBase {
  /**
   * @param {{
   *   holeId?: string,
   *   title?: string,
   *   rootId?: string | null,
   *   createdAt?: string | null,
   *   sessionId?: string,
   *   nodes?: any[],
   *   assetNames?: Iterable<string>,
   *   viewState?: any,
   *   isResume?: boolean,
   *   deliveredNodeIds?: Iterable<string>,
   *   renderPage?: (hydration: any) => string,
   *   onClose?: (session: SessionBase) => void,
   *   onContextClose?: (session: SessionBase) => void,
   *   mintRunId?: () => string,
   * }} options
   */
  constructor({ holeId, title, rootId, createdAt, sessionId, nodes, assetNames, viewState, isResume, deliveredNodeIds, renderPage, onClose, onContextClose, mintRunId = shortId }) {
    this.id = sessionId || shortId();
    this.holeId = holeId || shortId();
    this.title = title || "Untitled";
    this.rootId = rootId || null;
    this.createdAt = createdAt || new Date().toISOString();
    this.assetNames = new Set(assetNames || []);
    this.renderPage = renderPage;
    this.onClose = onClose;
    this.onContextClose = onContextClose;
    this.mintRunId = mintRunId;

    this.engine = new HoleEngine({
      hole: {
        hole_id: this.holeId,
        title: this.title,
        root_id: this.rootId,
        created_at: this.createdAt,
        view_state: viewState ?? null,
        nodes,
      },
      debounceMs: SAVE_DEBOUNCE_MS,
      port: {
        store: {
          saveHole: (snapshot) => defaultFsStore.saveHole({
            ...snapshot,
            nodes: snapshot.nodes.map((node) => node.status === "pending" ? { ...node, markdown: "" } : node),
          }),
          deleteAsset: (savedHoleId, name) => defaultFsStore.deleteAsset(savedHoleId, name),
        },
        emit: (event) => this.broadcast(event),
        clock: systemClock,
        ids: { newId: () => this.mintRunId() },
        onAssetDeleted: (name) => { this.assetNames.delete(name); },
        onAssetDeleteError: (name, error) => { logError(`Asset GC failed for ${name}: ${error?.message || error}`); },
      },
      onSaveError: (err) => { logError(`Save failed: ${err.message}`); },
    });
    this.state = this.engine.state;
    this.nodes = this.state.nodes;
    this.viewState = this.state.view_state;

    // One record owns every request-scoped transition: delivery, delegation,
    // streaming ingress, cancellation, completion, conversion, and watchdog.
    this.requests = new RequestTable();
    // Context delivery state is process-local coordination state. It is never
    // persisted or projected into browser hydration.
    this.delivered = new Set(deliveredNodeIds || []);
    /** @type {Map<string, string>} */
    this.deliveredNoteHashes = new Map();

    this.server = null;
    this.url = null;
    this.closed = false;
    this.closeReason = null;
    this.closePromise = null;

    this.queue = []; // agent-facing events awaiting consumption
    // Queue position is live coordination state, never document state. Only
    // branch requests have a pending card that can surface this distinction.
    this.queuedNodeIds = new Set();
    // Exactly one long-lived listener owns agent delivery. Transport liveness
    // must never be implemented as model polling, and overlapping listeners
    // must never receive the same branch request.
    this.waiter = null; // {resolve, cleanup} for the blocked waitForEvent() call
    this.agentAttached = true; // false once the agent cancels/stalls; browser is told
    // Request-scoped watchdogs are essential once several branches may be in
    // flight. Progress on one branch must never clear another branch's stall
    // protection.
    // Delegation is live coordination state, never document state. A delegated
    // request remains pending and answerable, but no longer monopolizes
    // redelivery. Its eventual completion also returns immediately so it cannot
    // steal the main coordinator's listener lease.
    this.crops = new SessionCrops();
    this.regionSweep = isResume ? sweepPdfRegionFiles(this.holeId).catch(() => {}) : Promise.resolve();

    this.sseClients = new Set();
    this.everConnected = false;
    this.outboundEvents = [];
    this.lastOutboundEventId = 0;
    this.contextUsage = unavailableContextUsage();
    this.contextBusy = false;
    // Unavailable is the silent/default state: do not perturb existing event
    // ordering merely because an agent turn starts before correlation succeeds.
    this.lastContextBroadcast = this.contextUsage;
    this.lastContextBroadcastAt = 0;
    this.contextBroadcastTimer = null;

    this.saveChain = this.engine.saveChain;
    this.shutdownScheduled = false;

    // Saved asks: questions the human asked while no agent was listening are
    // persisted as pending nodes; a resume re-queues each one (oldest first,
    // under a fresh request_id) so the agent answers them right away.
    if (isResume) { this.requeueSavedAsks(); this.requeueSavedConversions(); }

  }

  // These seams are implemented by the successively narrower session layers.
  // Declaring them here makes the cross-layer contract visible to checkJs;
  // dynamic dispatch still reaches the final subclass during construction.
  broadcast(_event) {}
  requeueSavedAsks() {}
  requeueSavedConversions() {}
  scheduleSave() {}
  restoreNodeConversion(_nodeId) {}
  clearAnswerWatchdog(_requestId) {}
  setContextBusy(_busy) {}
  /** @returns {Promise<unknown>} */
  flushSave() { return Promise.resolve(); }
  deliverToAgent(event) { return event; }
  async queueBranchEvent(_event, _node, _parent, _preparedCrop = null) {}
  async handleRequest(_req, _res) { throw new Error("Session request router is unavailable"); }

  // ---- lifecycle ----------------------------------------------------------

  async start() {
    if (this.server) return this.url;

    const server = http.createServer(async (req, res) => {
      try {
        const port = req.socket.localPort;
        assertHttpRequest(req, {
          allowedHosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]),
        });
        await this.handleRequest(req, res);
      } catch (error) {
        if (res.writableEnded) return;
        const statusCode = error instanceof HttpGuardError ? error.statusCode : 500;
        const code = error instanceof HttpGuardError ? error.code : "internal_error";
        res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), code } }));
      }
    });
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

    // Persist right away so the hole is resumable even if the process dies
    // before the first answer (durable asks depend on the file existing).
    this.scheduleSave();
    openBrowser(this.url);
    return this.url;
  }

  isClosed() {
    return this.closed;
  }

  close(reason = "session_closed") {
    if (this.closed) return this.closePromise;
    for (const record of this.requests.records()) if (record.conversion?.markdown) this.restoreNodeConversion(record.nodeId);
    // Only this session's own crops — a successor session for the same hole may
    // already be writing fresh ones under different request ids.
    this.crops.releaseAll().catch(() => {});
    this.closed = true;
    this.closeReason = reason;
    this.onContextClose?.(this);
    this.contextBusy = false;
    if (this.contextBroadcastTimer) {
      clearTimeout(this.contextBroadcastTimer);
      this.contextBroadcastTimer = null;
    }
    this.clearAnswerWatchdog();
    this.closePromise = this.flushSave();

    this.broadcast({ type: "session_closed", reason });

    // Drop any queued (now unanswerable) branch requests and release every
    // blocked agent call with session_closed.
    this.queue.length = 0;
    this.queuedNodeIds.clear();
    this.requests.clearActive();
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      waiter.cleanup?.();
      waiter.resolve(this.deliverToAgent({ status: "session_closed", session_id: this.id, reason }));
    }

    if (this.shutdownScheduled) return this.closePromise;
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
        onClosed: () => {
          this.onClose?.(this);
          log(`Session ${this.id} closed (${reason})`);
        },
      });
    }, 0);
    return this.closePromise;
  }

}
