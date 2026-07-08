import { createHoleState, holeStateToHole, reduceHoleEvent } from "../../core/reducer.js";
import { lineageNodesFromMap, truncate } from "../../core/model.js";
import { extractAssetRefsFromMarkdown } from "../../core/assets.js";
import { TitleSentinelParser, fallbackTitleForNode, normalizeProviderError } from "../brain/index.js";

const SAVE_DEBOUNCE_MS = 400;

export class DirectRabbitholeHost {
  constructor({ store, hole, brain = null, onEvent = null, onToast = null, onDone = null, onRestore = null } = {}) {
    this.store = store;
    this.brain = brain;
    this.onEvent = onEvent;
    this.onToast = onToast;
    this.onDone = onDone;
    this.onRestore = onRestore;
    this.state = createHoleState(hole);
    this.holeId = this.state.hole_id;
    this.title = this.state.title;
    this.saveTimer = 0;
    this.savingChain = Promise.resolve();
    this.abortByNode = new Map();
    this.lastEventId = 0;
  }

  hydration() {
    return {
      session_id: `web-${this.holeId}`,
      hole_id: this.holeId,
      title: this.title,
      root_id: this.state.root_id,
      last_event_id: this.lastEventId,
      agent_attached: true,
      view_state: this.state.view_state,
      nodes: this.serializeNodes(),
    };
  }

  adapter() {
    return {
      connect: ({ onOpen, onMessage }) => {
        this.onEvent = (event) => {
          onMessage?.(event);
        };
        setTimeout(() => onOpen?.(), 0);
        return { close: () => {} };
      },
      post: (payload) => this.handleBrowserEvent(payload),
    };
  }

  serializeNodes() {
    return [...this.state.nodes.values()].map((n) => ({
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

  async handleBrowserEvent(payload) {
    const type = String(payload?.type ?? "");
    try {
      switch (type) {
        case "branch_request":
          return await this.handleBranchRequest(payload);
        case "retry_branch":
          return this.handleRetry(payload);
        case "node_update":
          this.dispatch({ ...payload, type: "node_update" });
          this.scheduleSave();
          return { ok: true };
        case "nodes_update":
          this.dispatch({ ...payload, type: "nodes_update" });
          this.scheduleSave();
          return { ok: true };
        case "delete_node":
          return await this.handleDeleteNode(payload);
        case "view_state":
          this.dispatch({ ...payload, type: "view_state" });
          this.scheduleSave();
          return { ok: true };
        case "done":
          await this.flushSave();
          this.onDone?.();
          return { ok: true };
        default:
          throw new Error(`Unsupported browser event: ${type}`);
      }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async handleBranchRequest(payload) {
    const result = this.dispatch({ ...payload, type: "branch_request" }, { now: new Date().toISOString() });
    const node = result.createdNode;
    await this.flushSave();
    this.startAnswer(node.id, { reset: false });
    return { ok: true, node_id: node.id, request_id: payload.request_id };
  }

  handleRetry(payload) {
    const node = this.state.nodes.get(String(payload.node_id || ""));
    if (!node || node.status !== "pending") return { ok: true };
    this.startAnswer(node.id, { reset: true });
    return { ok: true };
  }

  async handleDeleteNode(payload) {
    const targetId = String(payload.node_id || "");
    if (!targetId || targetId === this.state.root_id) return { ok: false, error: "Cannot delete the root document" };
    if (!this.state.nodes.has(targetId)) return { ok: true, deleted: [] };

    const reduced = reduceHoleEvent(this.state, { type: "delete_node", node_id: targetId });
    const deletedNodes = (reduced.effects?.deletedNodes || []).map((node) => ({ ...node }));
    const deletedIds = deletedNodes.map((node) => node.id);
    const parentId = deletedNodes[0]?.parent_id || null;
    const deletedAssets = await this.snapshotAssetsForDeletedNodes(deletedNodes);
    for (const id of deletedIds) {
      const controller = this.abortByNode.get(id);
      if (controller) controller.abort();
      this.abortByNode.delete(id);
    }
    this.state = reduced.state;
    await this.gcAssetsForDeletedNodes(deletedNodes);
    this.scheduleSave();
    this.emit({ type: "node_deleted", node_ids: deletedIds });

    const title = deletedNodes[0]?.title || "Untitled";
    this.onToast?.({
      message: deletedIds.length > 1
        ? `Removed "${truncate(title, 40)}" and ${deletedIds.length - 1} inside it`
        : `Removed "${truncate(title, 40)}"`,
      actionLabel: "Undo",
      timeoutMs: 10000,
      onAction: async () => {
        await this.restoreDeletedNodes(deletedNodes, deletedAssets);
        this.onRestore?.({ parentId });
      },
    });
    return { ok: true, deleted: deletedIds };
  }

  async restoreDeletedNodes(deletedNodes, deletedAssets = []) {
    const nodes = new Map(this.state.nodes);
    for (const node of deletedNodes) nodes.set(node.id, { ...node });
    this.state = { ...this.state, nodes };
    for (const asset of deletedAssets) {
      if (asset.blob) await this.store.putAsset(this.holeId, asset.name, asset.blob);
    }
    await this.flushSave();
  }

  async snapshotAssetsForDeletedNodes(deletedNodes) {
    const refs = new Set();
    for (const node of deletedNodes) {
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) refs.add(name);
    }
    const out = [];
    for (const name of refs) {
      try {
        const blob = await this.store.getAsset(this.holeId, name);
        if (blob) out.push({ name, blob });
      } catch {}
    }
    return out;
  }

  async gcAssetsForDeletedNodes(deletedNodes) {
    const deletedRefs = new Set();
    for (const node of deletedNodes) {
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) deletedRefs.add(name);
    }
    if (!deletedRefs.size) return;
    const remainingRefs = new Set();
    for (const node of this.state.nodes.values()) {
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) remainingRefs.add(name);
    }
    for (const name of deletedRefs) {
      if (remainingRefs.has(name)) continue;
      try { await this.store.deleteAsset(this.holeId, name); } catch {}
    }
  }

  dispatch(event, options) {
    const reduced = reduceHoleEvent(this.state, event, options);
    this.state = reduced.state;
    return reduced.effects || {};
  }

  startAnswer(nodeId, { reset = false } = {}) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;

    const controller = new AbortController();
    const previous = this.abortByNode.get(nodeId);
    if (previous) previous.abort();
    this.abortByNode.set(nodeId, controller);

    if (reset) {
      this.dispatchProgress(nodeId, "", { emit: true });
    }

    queueMicrotask(() => this.runAnswer(nodeId, controller).catch((err) => {
      this.handleAnswerError(nodeId, err, controller.signal);
    }));
  }

  async runAnswer(nodeId, controller) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    if (!this.brain) throw new Error("Add a provider key in Settings before asking.");

    const context = this.buildBranchContext(node);
    const parser = new TitleSentinelParser({ fallbackTitle: fallbackTitleForNode(node) });
    let markdown = resetMarkdownForRun(node);

    for await (const chunk of this.brain.answerBranch(context, controller.signal)) {
      if (controller.signal.aborted || !this.isLivePending(nodeId)) return;
      const delta = parser.push(chunk);
      if (!delta) continue;
      markdown += delta;
      this.dispatchProgress(nodeId, markdown, { emit: true });
    }

    const tail = parser.finish();
    if (tail) {
      markdown += tail;
      this.dispatchProgress(nodeId, markdown, { emit: true });
    }
    if (controller.signal.aborted || !this.isLivePending(nodeId)) return;

    const current = this.state.nodes.get(nodeId);
    const title = parser.title || fallbackTitleForNode(current);
    this.dispatch({
      type: "node_answered",
      node_id: current.id,
      parent_id: current.parent_id,
      title,
      markdown,
      base_url: current.base_url,
      base_url_source: current.base_url_source,
      origin: current.origin,
      position: current.position,
      size: current.size,
      font_scale: current.font_scale,
      read: false,
    });
    const finalNode = this.state.nodes.get(nodeId);
    this.abortByNode.delete(nodeId);
    this.emit({
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
    await this.flushSave();
  }

  handleAnswerError(nodeId, err, signal) {
    this.abortByNode.delete(nodeId);
    if (signal?.aborted && !this.state.nodes.has(nodeId)) return;
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    const normalized = normalizeProviderError(err);
    this.emit({
      type: "node_error",
      node_id: nodeId,
      message: normalized.message,
      code: normalized.code,
      retryable: normalized.retryable,
      markdown: node.markdown || "",
    });
    this.scheduleSave();
  }

  dispatchProgress(nodeId, markdown, { emit = false } = {}) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    this.dispatch({
      type: "node_progress",
      node_id: nodeId,
      markdown,
      base_url: node.base_url,
      base_url_source: node.base_url_source,
    });
    const current = this.state.nodes.get(nodeId);
    if (emit) {
      this.emit({
        type: "node_progress",
        node_id: nodeId,
        markdown: current.markdown,
        base_url: current.base_url,
        base_url_source: current.base_url_source,
      });
    }
    this.scheduleSave();
  }

  buildBranchContext(node) {
    const parent = this.state.nodes.get(node.parent_id);
    const root = this.state.nodes.get(this.state.root_id);
    const lineage = parent ? lineageNodesFromMap(this.state.nodes, parent.id) : [];
    const ancestors = lineage.filter((entry) => entry.id !== parent?.id).map((entry) => ({
      title: entry.title,
      markdown: entry.markdown,
    }));
    return {
      root_title: root?.title || this.state.title || "Untitled",
      parent_title: parent?.title || "Untitled",
      parent_markdown: parent?.markdown || "",
      ancestors,
      selected_text: node.origin?.selected_text || "",
      question: node.origin?.question || "",
      lens: node.origin?.lens || null,
      synthesis: !!node.origin?.synthesis,
    };
  }

  isLivePending(nodeId) {
    const node = this.state.nodes.get(nodeId);
    return !!node && node.status === "pending";
  }

  emit(event) {
    this.lastEventId += 1;
    this.onEvent?.(event);
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  async flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
    }
    const snapshot = holeStateToHole(this.state);
    this.savingChain = this.savingChain
      .catch(() => {})
      .then(() => this.store.saveHole(snapshot));
    return this.savingChain;
  }
}

export function createHoleFromMarkdown({ title, markdown, baseUrl = null } = {}) {
  const now = new Date().toISOString();
  const holeId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `hole-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const rootId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `root-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const inferredTitle = title || titleFromMarkdown(markdown) || "Untitled";
  return {
    hole_id: holeId,
    title: inferredTitle,
    root_id: rootId,
    created_at: now,
    view_state: null,
    nodes: [{
      id: rootId,
      parent_id: null,
      title: inferredTitle,
      markdown: String(markdown || ""),
      base_url: baseUrl,
      base_url_source: baseUrl ? "explicit" : null,
      origin: null,
      position: { x: 0, y: 0 },
      size: null,
      font_scale: 1,
      collapsed: false,
      status: "answered",
      read: true,
      created_at: now,
    }],
  };
}

function titleFromMarkdown(markdown) {
  const match = /^#\s+(.+)$/m.exec(String(markdown || ""));
  return match ? truncate(match[1].trim(), 80) : "";
}

function resetMarkdownForRun(node) {
  return node?.markdown && node.status === "pending" ? String(node.markdown) : "";
}
