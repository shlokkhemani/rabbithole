import { collectAllNotes, collectRelevantNotes } from "../../../core/hole/ask.js";
import { openBrowser } from "../../shared/process.js";
import { log } from "../../shared/logger.js";
import { SessionBase } from "./session-base.js";

const ANSWER_WATCHDOG_MS = 4 * 60 * 1000;

/** Agent listener lease, request delivery, and attachment state. */
export class SessionListener extends SessionBase {
  // ---- agent-facing event queue ------------------------------------------

  /**
   * Block until the next browser event. `signal` (the MCP request's
   * AbortSignal) fires when the human cancels the tool call in the terminal —
   * the waiter is removed and the browser is told the agent detached, so
   * pending asks stop pretending an answer is coming.
   */
  waitForEvent(signal) {
    if (this.closed) return Promise.resolve(this.deliverToAgent({
      status: "session_closed", session_id: this.id, reason: this.closeReason,
    }));
    this.setContextBusy(false);
    this.markAgentAttached();
    if (this.queue.length > 0) return Promise.resolve(this.deliverToAgent(this.queue.shift()));
    const inFlight = this.nextInFlightBranchRequest();
    if (inFlight) return Promise.resolve(this.deliverToAgent(inFlight));
    // An idle listener stays blocked until a real browser event, close, or host
    // cancellation. There is intentionally no periodic keepalive result: a
    // passive canvas costs zero model turns.
    if (this.waiter) return Promise.resolve(this.listenerActiveResult());
    return new Promise((resolve) => {
      let done = false;
      let waiter = null;
      const finish = (event) => {
        if (done) return;
        done = true;
        if (this.waiter === waiter) this.waiter = null;
        waiter?.cleanup?.();
        resolve(event);
      };
      const onAbort = () => {
        this.clearAnswerWatchdog();
        this.setAgentAttached(false, "cancelled");
        finish(this.deliverToAgent({ status: "cancelled", session_id: this.id }));
      };
      const cleanup = () => {
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
      this.waiter = waiter;
    });
  }

  pushEvent(event) {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.cleanup?.();
      waiter.resolve(this.deliverToAgent(event));
      return;
    }
    this.queue.push(event);
  }

  // Every branch_request handed to the agent arms the watchdog; any subsequent
  // agent activity (answer_branch, another waitForEvent) clears or re-arms it.
  deliverToAgent(event) {
    // Branch work carries both identities: session_id routes answers to this
    // live process, while hole_id lets a coordinator restore the listener after
    // a delegated call returns. Terminal response shapes stay unchanged.
    if (event?.status === "branch_request" || event?.status === "convert_request") event.hole_id = this.holeId;
    if (event?.status === "branch_request") {
      const notes = collectRelevantNotes(this.nodes, event.parent_node_id, { includeLineage: true });
      if (notes.length) event.notes = notes;
      else delete event.notes;
    } else if (event?.status === "session_closed") {
      const notes = collectAllNotes(this.nodes);
      if (notes.length) event.notes = notes;
      else delete event.notes;
    }
    if (event && (event.status === "branch_request" || event.status === "convert_request")) {
      this.requests.deliver(event.request_id, event);
      this.startAnswerWatchdog(event.request_id);
    }
    if (event && (event.status === "branch_request" || event.status === "convert_request")) {
      this.setContextBusy(true);
    }
    return event;
  }

  nextInFlightBranchRequest() {
    for (const record of this.requests.records()) {
      const event = record.inFlight;
      if (!event || record.delegated) continue;
      // A conversion has no pending node — it stays redeliverable for as long
      // as its run is live, so a real host cancellation/retry cannot drop it.
      if (event.status === "convert_request") {
        if (record.conversion) return event;
        record.inFlight = null;
        continue;
      }
      const node = record.nodeId ? this.nodes.get(record.nodeId) : null;
      if (node && node.status === "pending") return event;
      record.inFlight = null;
    }
    return null;
  }

  listenerActiveResult() {
    return {
      status: "already_listening",
      session_id: this.id,
      hole_id: this.holeId,
      instruction:
        "This session already has an active background listener. Do not attach another one; " +
        "the existing call will receive the next canvas event.",
    };
  }

  startAnswerWatchdog(requestId) {
    this.clearAnswerWatchdog(requestId);
    const record = this.requests.ensure(requestId);
    const timer = setTimeout(() => {
      record.watchdog = null;
      if (!this.closed) this.setAgentAttached(false, "stalled");
    }, ANSWER_WATCHDOG_MS);
    record.watchdog = timer;
  }

  clearAnswerWatchdog(requestId) {
    if (requestId !== undefined) {
      const record = this.requests.get(requestId);
      if (record?.watchdog) clearTimeout(record.watchdog);
      if (record) record.watchdog = null;
      return;
    }
    this.requests.clearWatchdogs();
  }

  markAgentAttached() {
    this.setAgentAttached(true);
  }

  focusBrowser() {
    if (!this.url || this.closed) return false;
    // Opening an already-connected loopback URL creates another browser tab on
    // common desktop browsers. The existing tab is already wired to this
    // session and will receive every replay/live event, so reuse it silently.
    if (this.sseClients.size > 0) {
      log(`Session ${this.id} already has a live browser tab; not opening another`);
      return false;
    }
    openBrowser(this.url);
    return true;
  }

  setAgentAttached(attached, reason = null) {
    if (this.closed || this.agentAttached === attached) return;
    this.agentAttached = attached;
    if (!attached) {
      for (const record of this.requests.records()) {
        if (record.conversion?.markdown) this.restoreNodeConversion(record.nodeId);
      }
    }
    this.broadcast({ type: "agent_status", attached, reason });
  }

}
