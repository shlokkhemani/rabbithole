import { extractNodeAssetRefs } from "../assets.js";
import { createSaveChain } from "../hole-host.js";
import { createHoleState, holeStateToHole, holeStateToHydrationNodes, reduceHoleEvent } from "../hole/reduce.js";
import { assertEnginePort } from "./port.js";

export class HoleEngine {
  /** @param {{ hole: any, port: any, debounceMs?: number, onSaveError?: ((error: any) => unknown) | null }} options */
  constructor({ hole, port, debounceMs = 400, onSaveError = null }) {
    this.port = assertEnginePort(port);
    this.state = createHoleState(hole, { cloneExtensions: false, canonicalNodes: true });
    this.onSaveError = onSaveError;
    // Where the human is reading changes on every scroll pause; the hole
    // itself far less often. A save with nothing but a new view writes only
    // the view (when the store can), so its cost follows the view, not every
    // document. The first save of a session writes the whole hole.
    this.fullSave = true;
    this.saveChain = createSaveChain({
      debounceMs,
      save: () => {
        const store = this.port.store;
        if (!this.fullSave && typeof store.saveViewState === "function") {
          const holeId = this.state.hole_id;
          const viewState = this.state.view_state;
          return () => Promise.resolve(store.saveViewState(holeId, viewState)).catch((error) => this.saveFailed(error));
        }
        this.fullSave = false;
        const snapshot = this.toHole();
        return () => Promise.resolve(store.saveHole(snapshot)).catch((error) => {
          // Whatever this write carried is still unsaved: the next one writes it all.
          this.fullSave = true;
          return this.saveFailed(error);
        });
      },
    });
  }

  /** @param {any} error */
  saveFailed(error) {
    if (this.onSaveError) return this.onSaveError(error);
    throw error;
  }

  get nodes() { return this.state.nodes; }
  get holeId() { return this.state.hole_id; }
  get rootId() { return this.state.root_id; }

  /** @param {any} event @param {any} [options] */
  dispatch(event, options = {}) {
    const reduced = reduceHoleEvent(this.state, event, { ...options, mutate: true });
    this.state = reduced.state;
    if (event.type !== "view_state") this.fullSave = true;
    this.saveChain.markDirty();
    return reduced.effects || {};
  }

  toHole() { return holeStateToHole(this.state); }

  /** @param {{lastEventId?: number, agentAttached?: boolean, contextUsage?: any, suppressRootOrigin?: boolean, cloneExtensions?: boolean}} [options] */
  hydration(options = {}) {
    return {
      title: this.state.title,
      root_id: this.state.root_id,
      last_event_id: options.lastEventId || 0,
      agent_attached: options.agentAttached ?? true,
      ...(options.contextUsage ? { context_usage: options.contextUsage } : {}),
      view_state: this.state.view_state,
      nodes: holeStateToHydrationNodes(this.state, {
        suppressRootOrigin: options.suppressRootOrigin,
        cloneExtensions: options.cloneExtensions,
      }),
    };
  }

  scheduleSave() { this.saveChain.schedule(); }
  flushSave() { return this.saveChain.flush(); }
  cancelSave() { this.saveChain.cancel(); }

  /** @param {any} payload */
  applyPersistedEvent(payload) {
    this.dispatch({ ...payload, type: String(payload?.type ?? "") });
    this.scheduleSave();
    return { ok: true };
  }

  /** @param {any} payload */
  async nodeCreate(payload) {
    const effects = this.dispatch({ ...payload, type: "node_create" }, { now: this.port.clock.iso() });
    if (!effects.createdNode) throw new Error("Node creation produced no node");
    this.scheduleSave();
    await this.flushSave();
    return { ok: true, node_id: effects.createdNode.id };
  }

  /** @param {string} nodeId @param {string} namespace @param {unknown} value */
  patchExtension(nodeId, namespace, value) {
    const event = { type: "node_extensions_patch", node_id: nodeId, namespace, value };
    this.dispatch(event);
    this.port.emit(event);
    this.scheduleSave();
    return { ok: true };
  }

  /** @param {string} nodeId @param {Record<string, any>} pdf */
  restorePdfConversion(nodeId, pdf) {
    this.dispatch({ type: "node_progress", node_id: nodeId, markdown: String(pdf.original_markdown ?? this.state.nodes.get(nodeId)?.markdown ?? "") });
    this.patchExtension(nodeId, "pdf", { ...pdf, converting: false, converted: false });
  }

  /** @param {string} targetId @param {{ protectRoot?: boolean, beforeDelete?: (ids: Set<string>, effects: any) => unknown, afterDelete?: (ids: Set<string>, effects: any) => unknown }} [options] */
  async deleteNode(targetId, options = {}) {
    if (!targetId || (options.protectRoot !== false && targetId === this.state.root_id)) throw new RabbitholeEngineError("The starting document can't be removed", 400);
    if (!this.state.nodes.has(targetId)) return { ok: true, deleted: [] };
    const effects = this.dispatch({ type: "delete_node", node_id: targetId });
    const ids = new Set(effects.deletedNodeIds || []);
    await options.beforeDelete?.(ids, effects);
    await this.deleteOrphanedAssets(effects.deletedNodes || []);
    const event = { type: "node_deleted", node_ids: [...ids] };
    this.port.emit(event);
    this.scheduleSave();
    await options.afterDelete?.(ids, effects);
    return { ok: true, deleted: [...ids] };
  }

  /** @param {Iterable<any>} deletedNodes */
  async deleteOrphanedAssets(deletedNodes) {
    const deletedRefs = new Set();
    for (const node of deletedNodes) for (const name of extractNodeAssetRefs(node)) deletedRefs.add(name);
    for (const node of this.state.nodes.values()) for (const name of extractNodeAssetRefs(node)) deletedRefs.delete(name);
    for (const name of deletedRefs) {
      try {
        await this.port.store.deleteAsset(this.state.hole_id, name);
        await this.port.onAssetDeleted?.(name);
      } catch (error) {
        await this.port.onAssetDeleteError?.(name, error);
      }
    }
    return [...deletedRefs];
  }
}

export class RabbitholeEngineError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) { super(message); this.status = status; }
}
