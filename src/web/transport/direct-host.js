import { createHoleState, holeStateToHole, holeStateToHydrationNodes, reduceHoleEvent } from "../../core/reducer.js";
import { normalizeBlockIds } from "../../core/blocks.js";
import { lineageNodesFromMap, truncate } from "../../core/model.js";
import { extractAssetRefsFromMarkdown } from "../../core/assets.js";
import { GenerationRun } from "../../core/generation-run.js";
import { randomId } from "../../core/utils.js";
import { ProviderError, fallbackTitleForNode, normalizeProviderError } from "../brain/index.js";

const SAVE_DEBOUNCE_MS = 400;
const WEB_ROOT_QUESTION = "web_root_question";

export class DirectRabbitholeHost {
  constructor({ store, hole, brain = null, onToast = null, onDone = null, onRestore = null, onAuthRequired = null, onRootAnswered = null, mintGenerationRunId = defaultGenerationRunId } = {}) {
    this.store = store;
    this.brain = brain;
    this.onEvent = null;
    this.onToast = onToast;
    this.onDone = onDone;
    this.onRestore = onRestore;
    this.onAuthRequired = onAuthRequired;
    this.onRootAnswered = onRootAnswered;
    this.mintGenerationRunId = mintGenerationRunId;
    this.state = createHoleState(hole);
    this.holeId = this.state.hole_id;
    this.title = this.state.title;
    this.saveTimer = 0;
    this.savingChain = Promise.resolve();
    this.abortByNode = new Map();
    this.lastEventId = 0;
    this.disposed = false;
    this.subscriptions = new Set();
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
      nodes: holeStateToHydrationNodes(this.state, { suppressRootOrigin: true }),
    };
  }

  adapter() {
    return {
      connect: ({ onOpen, onMessage }) => {
        const subscription = {
          closed: false,
          openTimer: 0,
          callback: (event) => {
            if (!subscription.closed && !this.disposed) onMessage?.(event);
          },
          close: () => {
            if (subscription.closed) return;
            subscription.closed = true;
            if (subscription.openTimer) clearTimeout(subscription.openTimer);
            subscription.openTimer = 0;
            this.subscriptions.delete(subscription);
            if (this.onEvent === subscription.callback) this.onEvent = null;
          },
        };
        if (this.disposed) {
          subscription.closed = true;
          return { close: subscription.close };
        }
        this.subscriptions.add(subscription);
        this.onEvent = subscription.callback;
        subscription.openTimer = setTimeout(() => {
          subscription.openTimer = 0;
          if (!subscription.closed && !this.disposed) onOpen?.();
        }, 0);
        return { close: subscription.close };
      },
      post: (payload) => this.handleBrowserEvent(payload),
    };
  }

  async handleBrowserEvent(payload) {
    if (this.disposed) return { ok: false, error: "This Rabbithole is no longer active." };
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
        case "block_state":
          this.dispatch({ ...payload, type: "block_state" });
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
    if (node.id === this.state.root_id && rootQuestionForNode(node)) {
      this.startRootAnswer({ reset: true });
      return { ok: true };
    }
    this.startAnswer(node.id, { reset: true });
    return { ok: true };
  }

  async handleDeleteNode(payload) {
    const targetId = String(payload.node_id || "");
    if (!targetId || targetId === this.state.root_id) return { ok: false, error: "The starting document can't be removed" };
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
    if (this.disposed) return;
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

  startRootAnswer({ reset = false } = {}) {
    if (this.disposed) return false;
    const node = this.state.nodes.get(this.state.root_id);
    const question = rootQuestionForNode(node);
    if (!node || node.status !== "pending" || !question) return false;

    const controller = new AbortController();
    const previous = this.abortByNode.get(node.id);
    if (previous) previous.abort();
    this.abortByNode.set(node.id, controller);

    if (reset) {
      this.dispatchProgress(node.id, "", { emit: true });
    }

    queueMicrotask(() => this.runRootAnswer(node.id, question, controller).catch((err) => {
      this.handleAnswerError(node.id, err, controller.signal);
    }));
    return true;
  }

  async runRootAnswer(nodeId, question, controller) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    if (!this.brain) {
      throw new ProviderError("Add your provider key to keep asking.", {
        status: 401,
        code: "missing_key",
        retryable: true,
      });
    }

    const brain = this.brain;
    const run = this.createGenerationRun(node, node.title || "Untitled");
    const generation = brain.authorExplainer({ question }, controller.signal);
    for await (const docEvent of generationDocEvents(generation, run, {
      nodeId,
      progressFields: { base_url: node.base_url, base_url_source: node.base_url_source },
      answeredFields: () => rootAnsweredFields(this.state.nodes.get(nodeId)),
      beforeComplete: (activeRun) => {
        // Deliberate asymmetry: branches accept an empty stream, but a root
        // explainer preserves the existing empty/whitespace rejection surface.
        if (!activeRun.snapshot().markdown.trim()) throw new Error("The provider returned an empty document.");
        activeRun.accept({
          type: "title",
          title: titleFromMarkdown(activeRun.snapshot().markdown) || this.state.nodes.get(nodeId)?.title || "Untitled",
        });
      },
    })) {
      if (controller.signal.aborted || !this.isLivePending(nodeId)) return;
      this.dispatch(docEvent);
      if (docEvent.type === "node_progress") {
        const current = this.state.nodes.get(nodeId);
        this.emit({ ...docEvent, markdown: current.markdown });
        this.scheduleSave();
      }
    }
    const title = this.state.nodes.get(nodeId).title;
    this.dispatch({ type: "hole_title", title });
    this.title = title;
    const finalNode = this.state.nodes.get(nodeId);
    this.abortByNode.delete(nodeId);
    this.emit({
      type: "node_answered",
      node_id: finalNode.id,
      parent_id: null,
      title: finalNode.title,
      markdown: finalNode.markdown,
      base_url: finalNode.base_url,
      base_url_source: finalNode.base_url_source,
      origin: null,
      position: finalNode.position,
      size: finalNode.size,
      font_scale: finalNode.font_scale,
    });
    await this.flushSave();
    await this.onRootAnswered?.(finalNode);
  }

  async runAnswer(nodeId, controller) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    if (!this.brain) {
      throw new ProviderError("Add your provider key to keep asking.", {
        status: 401,
        code: "missing_key",
        retryable: true,
      });
    }

    const brain = this.brain;
    const context = this.buildBranchContext(node);
    const fallbackTitle = fallbackTitleForNode(node);
    context.fallbackTitle = fallbackTitle;
    // Each attempt, including a retry, gets a fresh run id. The reducer can
    // therefore reject late progress from the superseded attempt.
    const run = this.createGenerationRun(node, fallbackTitle);
    // Capture the brain at attempt start: provider changes affect only later
    // generations; this in-flight iterator finishes on the old brain.
    const generation = brain.answerBranch(context, controller.signal);
    for await (const docEvent of generationDocEvents(generation, run, {
      nodeId,
      progressFields: { base_url: node.base_url, base_url_source: node.base_url_source },
      answeredFields: () => branchAnsweredFields(this.state.nodes.get(nodeId)),
    })) {
      if (controller.signal.aborted || !this.isLivePending(nodeId)) return;
      this.dispatch(docEvent);
      if (docEvent.type === "node_progress") {
        const current = this.state.nodes.get(nodeId);
        this.emit({ ...docEvent, markdown: current.markdown });
        this.scheduleSave();
      }
    }

    // Branches deliberately accept an empty provider stream: completion uses
    // the fallback title and empty/reset markdown. Root generation still rejects.
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

  createGenerationRun(node, fallbackTitle = fallbackTitleForNode(node)) {
    return new GenerationRun({
      id: this.mintGenerationRunId(),
      initialMarkdown: resetMarkdownForRun(node),
      fallbackTitle,
    });
  }

  async authorDocument(source, { onProgress = null } = {}) {
    const nodeId = this.state.root_id;
    const node = this.state.nodes.get(nodeId);
    if (!node || !this.brain) throw new Error("Document authoring requires a pending root and brain.");
    const controller = new AbortController();
    this.abortByNode.get(nodeId)?.abort();
    this.abortByNode.set(nodeId, controller);
    const run = this.createGenerationRun({ ...node, markdown: "" }, node.title || "Untitled");
    const generation = this.brain.authorDocument(source, controller.signal);
    try {
      for await (const docEvent of generationDocEvents(generation, run, {
        nodeId,
        progressFields: { base_url: node.base_url, base_url_source: node.base_url_source },
        answeredFields: () => rootAnsweredFields(this.state.nodes.get(nodeId)),
        beforeComplete: (activeRun) => {
          activeRun.accept({ type: "title", title: titleFromMarkdown(activeRun.snapshot().markdown) || node.title || "Untitled" });
        },
        complete: (activeRun, context) => ({
          ...activeRun.complete(context),
          // Authoring replaces a source rather than answering an existing
          // document: preserve its historical trim-or-original completion.
          markdown: activeRun.snapshot().markdown.trim() || String(source.markdown || ""),
        }),
      })) {
        if (controller.signal.aborted || this.disposed) throw new DOMException("Aborted", "AbortError");
        this.dispatch(docEvent);
        if (docEvent.type === "node_progress") {
          onProgress?.(this.state.nodes.get(nodeId).markdown.length);
        }
      }
      this.title = this.state.nodes.get(nodeId).title;
      this.dispatch({ type: "hole_title", title: this.title });
      await this.flushSave();
      return holeStateToHole(this.state);
    } finally {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = 0;
      }
      if (this.abortByNode.get(nodeId) === controller) this.abortByNode.delete(nodeId);
    }
  }

  handleAnswerError(nodeId, err, signal) {
    this.abortByNode.delete(nodeId);
    if (signal?.aborted && !this.state.nodes.has(nodeId)) return;
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    const normalized = normalizeProviderError(err);
    if (isAuthError(normalized)) {
      this.onAuthRequired?.({ node, error: normalized, retry: () => this.handleRetry({ node_id: nodeId }) });
    }
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
    // Deliberately untagged: this is a one-shot retry reset/replacement, not
    // generation progress, so GenerationRun ordering does not apply.
    this.dispatch({
      type: "node_progress",
      node_id: nodeId,
      markdown,
      base_url: node.base_url,
      base_url_source: node.base_url_source,
    });
    const current = this.state.nodes.get(nodeId);
    if (emit) {
      // This mirrors the deliberately untagged reset above to the local UI; it
      // is not a streamed generation event and must not claim a run identity.
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
    if (this.disposed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  async flushSave() {
    if (this.disposed) return this.savingChain;
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

  dispose() {
    if (this.disposed) return this.savingChain;
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
    }
    for (const controller of this.abortByNode.values()) {
      try { controller.abort(); } catch {}
    }
    this.abortByNode.clear();
    for (const subscription of [...this.subscriptions]) subscription.close();
    this.onEvent = null;
    return this.savingChain;
  }
}

/**
 * Narrow, browser-free branch wiring: GenerationEvent -> GenerationRun -> DocEvent.
 * Errors are intentionally not DocEvents; provider failures remain host/UI flow.
 */
export async function* generationDocEvents(generation, run, { nodeId, progressFields = {}, answeredFields = {}, beforeComplete = null, complete = null }) {
  for await (const event of generation) {
    const progress = run.accept(event, { nodeId, progressFields });
    if (progress) yield progress;
  }
  beforeComplete?.(run);
  const fields = typeof answeredFields === "function" ? answeredFields() : answeredFields;
  const context = { nodeId, answeredFields: fields };
  yield complete ? complete(run, context) : run.complete(context);
}

function rootAnsweredFields(node) {
  if (!node) return {};
  return { parent_id: null, base_url: node.base_url, base_url_source: node.base_url_source,
    origin: null, position: node.position, size: node.size, font_scale: node.font_scale, read: true };
}

function branchAnsweredFields(node) {
  if (!node) return {};
  return {
    parent_id: node.parent_id,
    base_url: node.base_url,
    base_url_source: node.base_url_source,
    origin: node.origin,
    position: node.position,
    size: node.size,
    font_scale: node.font_scale,
    read: false,
  };
}

function defaultGenerationRunId() {
  return randomId("generation");
}

export function createHoleFromMarkdown({ title, markdown, baseUrl = null } = {}) {
  const now = new Date().toISOString();
  const holeId = randomId("hole");
  const rootId = randomId("root");
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
      markdown: normalizeBlockIds(String(markdown || "")).markdown,
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
      extensions: {},
    }],
  };
}

export function createPendingHoleFromQuestion(question) {
  const normalized = String(question || "").trim();
  const title = truncate(normalized, 80) || "Untitled";
  const hole = createHoleFromMarkdown({ title, markdown: "" });
  const root = hole.nodes[0];
  root.status = "pending";
  const result = reduceHoleEvent(createHoleState(hole), {
    type: "node_origin",
    node_id: root.id,
    origin: { [WEB_ROOT_QUESTION]: normalized },
  });
  return holeStateToHole(result.state);
}

export function titleFromMarkdown(markdown) {
  const match = /^#\s+(.+)$/m.exec(String(markdown || ""));
  return match ? truncate(match[1].trim(), 80) : "";
}

function isAuthError(error) {
  return error?.status === 401 ||
    error?.status === 403 ||
    error?.code === "401" ||
    error?.code === "403" ||
    error?.code === "missing_key";
}

function resetMarkdownForRun(node) {
  return node?.markdown && node.status === "pending" ? String(node.markdown) : "";
}

function rootQuestionForNode(node) {
  return String(node?.origin?.[WEB_ROOT_QUESTION] || "").trim();
}
