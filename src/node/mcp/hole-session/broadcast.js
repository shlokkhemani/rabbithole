import { systemClock } from "../../../core/clock.js";
import { lineageTitlesFromMap } from "../../../core/hole/tree.js";
import { buildNodeAnsweredEvent } from "../../../core/hole-host.js";
import { writeSseEvent } from "../../shared/sse.js";
import { unavailableContextUsage } from "../../context-gauge/usage.js";
import { SessionListener } from "./listener.js";

const MAX_REPLAY_EVENTS = 500;
const CONTEXT_BROADCAST_THROTTLE_MS = 2000;

function sanitizeContextUsage(usage) {
  if (!usage || usage.type !== "context_usage" || usage.quality === "unavailable") {
    return unavailableContextUsage(
      usage?.agent === "claude" || usage?.agent === "codex" ? usage.agent : null,
      typeof usage?.model === "string" ? usage.model : null
    );
  }
  const valid = usage.quality === "reported" &&
    (usage.agent === "claude" || usage.agent === "codex") &&
    typeof usage.used_tokens === "number" && Number.isFinite(usage.used_tokens) && usage.used_tokens >= 0 &&
    typeof usage.window_tokens === "number" && Number.isFinite(usage.window_tokens) && usage.window_tokens > 0 &&
    usage.used_tokens <= usage.window_tokens &&
    typeof usage.percent === "number" && Number.isFinite(usage.percent) && usage.percent >= 0 && usage.percent <= 100 &&
    typeof usage.measured_at === "string";
  if (!valid) return unavailableContextUsage();
  return {
    type: "context_usage",
    quality: "reported",
    agent: usage.agent,
    model: typeof usage.model === "string" ? usage.model : null,
    used_tokens: usage.used_tokens,
    window_tokens: usage.window_tokens,
    percent: usage.percent,
    measured_at: usage.measured_at,
  };
}

function sameContextUsage(left, right) {
  return !!left && !!right && left.type === right.type && left.quality === right.quality && left.agent === right.agent &&
    left.model === right.model && left.used_tokens === right.used_tokens && left.window_tokens === right.window_tokens &&
    left.percent === right.percent && left.measured_at === right.measured_at;
}

/** SSE replay, hydration, context gauges, and persistence projection. */
export class SessionBroadcast extends SessionListener {
  // ---- SSE (server -> browser) -------------------------------------------

  broadcast(data) {
    // A streaming answer emits many node_progress events, but each one carries
    // the full accumulated content — only the latest matters for replay. Drop
    // the superseded one so chunks never crowd real events out of the buffer.
    if (data.type === "node_progress" || data.type === "pdf_convert_progress") {
      this.dropLatestReplayEvent((event) => event.data.type === data.type && event.data.node_id === data.node_id);
    }
    if (data.type === "node_answered") {
      this.dropLatestReplayEvent((event) => (event.data.type === "node_progress" || event.data.type === "pdf_convert_progress")
        && event.data.node_id === data.node_id);
    }
    // Context usage is transient latest-state, just like streaming progress:
    // reconnect replay needs one current reading, never a history of counters.
    if (data.type === "context_usage") {
      this.dropLatestReplayEvent((event) => event.data.type === "context_usage");
    }
    const event = { id: ++this.lastOutboundEventId, data };
    this.outboundEvents.push(event);
    if (this.outboundEvents.length > MAX_REPLAY_EVENTS) {
      this.outboundEvents.splice(0, this.outboundEvents.length - MAX_REPLAY_EVENTS);
    }
    for (const client of this.sseClients) writeSseEvent(client, event);
  }

  dropLatestReplayEvent(predicate) {
    for (let index = this.outboundEvents.length - 1; index >= 0; index -= 1) {
      if (!predicate(this.outboundEvents[index])) continue;
      this.outboundEvents.splice(index, 1);
      return;
    }
  }

  // ---- node tree ----------------------------------------------------------

  dispatchHoleEvent(event, options = {}) {
    const effects = this.engine.dispatch(event, options);
    this.state = this.engine.state;
    this.nodes = this.state.nodes;
    this.viewState = this.state.view_state;
    return effects;
  }

  lineageTitles(nodeId) {
    return lineageTitlesFromMap(this.nodes, nodeId);
  }

  buildHydration() {
    const delegatedNodeIds = new Set(
      [...this.requests.records()].filter((record) => record.delegated && record.nodeId).map((record) => record.nodeId),
    );
    const hydration = this.engine.hydration({
      // The highest event id reflected in this snapshot — the client passes it
      // back on its first /sse connect so any event broadcast in the gap between
      // serving this page and the EventSource connecting gets replayed.
      lastEventId: this.lastOutboundEventId,
      agentAttached: this.agentAttached,
      contextUsage: this.projectContextUsage(),
      cloneExtensions: false,
    });
    // The MCP page immediately serializes this projection into its isolated
    // HTML response, so its extension bags are already crossing by value.
    hydration.nodes = hydration.nodes.map((node) => delegatedNodeIds.has(node.id) ? { ...node, delegated: true } : node);
    return hydration;
  }

  setContextUsage(usage) {
    const next = sanitizeContextUsage(usage);
    if (sameContextUsage(next, this.contextUsage)) return;
    this.contextUsage = next;
    this.scheduleContextBroadcast();
  }

  setContextBusy(busy) {
    busy = !!busy;
    if (busy === this.contextBusy) return;
    this.contextBusy = busy;
    this.scheduleContextBroadcast();
  }

  projectContextUsage() {
    return {
      ...this.contextUsage,
      quality: this.contextBusy && this.contextUsage.quality === "reported" ? "stale" : this.contextUsage.quality,
    };
  }

  scheduleContextBroadcast() {
    if (this.closed) return;
    const next = this.projectContextUsage();
    if (sameContextUsage(next, this.lastContextBroadcast)) return;
    const elapsed = systemClock.now() - this.lastContextBroadcastAt;
    if (!this.lastContextBroadcastAt || elapsed >= CONTEXT_BROADCAST_THROTTLE_MS) {
      this.flushContextBroadcast();
      return;
    }
    if (!this.contextBroadcastTimer) {
      this.contextBroadcastTimer = setTimeout(() => {
        this.contextBroadcastTimer = null;
        this.flushContextBroadcast();
      }, CONTEXT_BROADCAST_THROTTLE_MS - elapsed);
      this.contextBroadcastTimer.unref?.();
    }
  }

  flushContextBroadcast() {
    if (this.closed) return;
    const next = this.projectContextUsage();
    if (sameContextUsage(next, this.lastContextBroadcast)) return;
    this.lastContextBroadcast = next;
    this.lastContextBroadcastAt = systemClock.now();
    this.broadcast(next);
  }

  toHole() {
    // Answered nodes persist in full. Pending nodes persist as durable asks —
    // the question and its anchor survive, but any half-streamed markdown is
    // dropped: on resume the question is re-asked and answered fresh.
    const hole = this.engine.toHole();
    return {
      ...hole,
      nodes: hole.nodes.map((n) => (n.status === "pending" ? { ...n, markdown: "" } : n)),
    };
  }

  scheduleSave() {
    this.engine.scheduleSave();
  }

  flushSave() {
    return this.engine.flushSave();
  }

  /** Add an explicit agent-published document without consuming or creating an agent listener. */
  async publishNode(event) {
    const effects = this.dispatchHoleEvent(event, { now: new Date().toISOString() });
    const node = effects.createdNode;
    this.scheduleSave();
    await this.flushSave();
    this.broadcast(buildNodeAnsweredEvent(node));
    return node;
  }

}
