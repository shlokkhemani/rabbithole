import { createHoleState, holeStateToHole, holeStateToHydrationNodes, reduceHoleEvent } from "../../core/reducer.js";
import { normalizeBlockIds } from "../../core/blocks.js";
import { lineageNodesFromMap, truncate } from "../../core/model.js";
import { extractNodeAssetRefs } from "../../core/assets.js";
import { GenerationRun } from "../../core/generation-run.js";
import { applyPersistedBrowserEvent, assetsOrphanedByDeletion, buildNodeAnsweredEvent, createSaveChain, dispatchBrowserEvent } from "../../core/hole-host.js";
import { randomId } from "../../core/utils.js";
import { createWhimsicalHoleId } from "../hole-id.js";
import { ProviderError, fallbackTitleForNode, normalizeProviderError } from "../brain/index.js";
import { MAX_PDF_FIGURE_ASSET_BYTES, normalizePdfExtension, parseFigureRefs, rewriteFigureRefs } from "../../core/pdf-shared.js";
import { cropPdfAssetToBlob, cropPdfAssetToDataUrl } from "../pdf-crop.js";

const SAVE_DEBOUNCE_MS = 400;
const WEB_ROOT_QUESTION = "web_root_question";

export class DirectRabbitholeHost {
  constructor({ store, hole, brain = null, registerAssetUrl = null, onToast = null, onDone = null, onRestore = null, onAuthRequired = null, onRootAnswered = null, getPdfTranscriptionCapability = null, mintGenerationRunId = defaultGenerationRunId } = {}) {
    this.store = store;
    this.brain = brain;
    this.onEvent = null;
    this.onToast = onToast;
    this.onDone = onDone;
    this.onRestore = onRestore;
    this.onAuthRequired = onAuthRequired;
    this.onRootAnswered = onRootAnswered;
    this.getPdfTranscriptionCapability = getPdfTranscriptionCapability;
    this.mintGenerationRunId = mintGenerationRunId;
    this.registerAssetUrl = registerAssetUrl;
    this.state = createHoleState(hole);
    this.holeId = this.state.hole_id;
    this.title = this.state.title;
    this.saveTimer = 0;
    this.saveChain = createSaveChain({
      debounceMs: SAVE_DEBOUNCE_MS,
      onTimerChange: (timer) => { this.saveTimer = timer || 0; },
      save: () => {
        const snapshot = holeStateToHole(this.state);
        return () => this.store.saveHole(snapshot);
      },
    });
    this.savingChain = Promise.resolve();
    this.abortByNode = new Map();
    this.lastEventId = 0;
    this.disposed = false;
    this.subscriptions = new Set();
    for (const node of this.state.nodes.values()) {
      // Raw read on purpose: a mid-run save persists the streamed body, which
      // normalizePdfExtension would reject against the original line offsets —
      // and that is exactly the state hydration must repair.
      const raw = node?.extensions?.pdf;
      if (raw?.version === 1 && raw.converting) this.restorePdfConversion(node.id, raw);
    }
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
    try {
      return await dispatchBrowserEvent(payload, {
        handlers: {
          branch_request: (event) => this.handleBranchRequest(event),
          retry_branch: (event) => this.handleRetry(event),
          node_update: (event) => this.applyPersistedBrowserEvent(event),
          nodes_update: (event) => this.applyPersistedBrowserEvent(event),
          block_state: (event) => this.applyPersistedBrowserEvent(event),
          node_extensions_patch: (event) => this.handleExtensionsPatch(event),
          convert_pdf: (event) => this.handleConvertPdf(event),
          convert_cancel: (event) => this.handleConvertCancel(event),
          delete_node: (event) => this.handleDeleteNode(event),
          view_state: (event) => this.applyPersistedBrowserEvent(event),
          done: async () => { await this.flushSave(); this.onDone?.(); return { ok: true }; },
        },
        unsupported: (eventType) => { throw new Error(`Unsupported browser event: ${eventType}`); },
      });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async handleBranchRequest(payload) {
    const parent = this.state.nodes.get(String(payload.parent_id || ""));
    // Raw flag on purpose — normalization fails against the mid-run streamed
    // body, and the lock must hold precisely then.
    if (parent?.extensions?.pdf?.converting) throw new Error("This PDF is being converted. Wait for conversion to finish before branching.");
    const result = this.dispatch({ ...payload, type: "branch_request" }, { now: new Date().toISOString() });
    const node = result.createdNode;
    await this.flushSave();
    this.startAnswer(node.id, { reset: false });
    return { ok: true, node_id: node.id, request_id: payload.request_id };
  }

  handleConvertCancel(payload) {
    this.abortByNode.get(String(payload.node_id || ""))?.abort();
    return { ok: true };
  }

  handleConvertPdf(payload) {
    const nodeId = String(payload.node_id || ""), node = this.state.nodes.get(nodeId), pdf = normalizePdfExtension(node);
    if (!pdf) throw new Error("This node is not a native PDF.");
    if ([...this.state.nodes.values()].some((candidate) => candidate.parent_id === nodeId)) throw new Error("Create a text version before asking follow-ups.");
    if (pdf.converting || this.abortByNode.has(nodeId)) throw new Error("Conversion is already running.");
    const capability = this.getPdfTranscriptionCapability?.();
    if (capability?.available === false) throw new Error(capability.reason || "Set up a vision-capable PDF transcription model before converting.");
    if (!this.brain?.transcribePages) throw new Error("Set up a transcription model before converting.");
    const controller = new AbortController(); this.abortByNode.set(nodeId, controller);
    const original = node.markdown;
    this.patchPdf(nodeId, { ...pdf, converting: true, converted: false, original_markdown: original });
    queueMicrotask(() => this.runPdfConversion(nodeId, controller).catch((error) => this.failPdfConversion(nodeId, error)));
    return { ok: true, node_id: nodeId };
  }

  async runPdfConversion(nodeId, controller) {
    const node = this.state.nodes.get(nodeId), pdf = normalizePdfExtension(node);
    const batches = []; for (let i = 0; i < pdf.pages.length; i += 5) batches.push(pdf.pages.slice(i, i + 5));
    let committed = "";
    const figureBudget = { bytes: 0 };
    const start = (batch, tail) => this.transcribePdfBatch(batch, tail, controller.signal);
    let pending = batches.length ? start(batches[0], "") : Promise.resolve("");
    for (let i = 0; i < batches.length; i++) {
      let chunk = await pending;
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      pending = i + 1 < batches.length ? start(batches[i + 1], (committed + chunk).slice(-500)) : null;
      chunk = await this.materializeWebFigures(nodeId, chunk, pdf, i, figureBudget);
      committed += (committed && chunk ? "\n\n" : "") + chunk;
      this.dispatch({ type: "node_progress", node_id: nodeId, markdown: committed });
      this.emit({ type: "pdf_convert_progress", node_id: nodeId, markdown: committed, page_done: batches[i].at(-1).n, page_total: pdf.pages.length });
      this.scheduleSave();
    }
    const current = this.state.nodes.get(nodeId);
    this.dispatch({ ...buildNodeAnsweredEvent(current), markdown: committed });
    // Spread the extension captured at run start: the body is now the converted
    // document, so re-normalizing would fail and the patch would wipe the
    // pages/lines/original_markdown stash the extension exists to keep.
    this.patchPdf(nodeId, { ...pdf, converting: false, converted: true });
    this.abortByNode.delete(nodeId); this.emit(buildNodeAnsweredEvent(this.state.nodes.get(nodeId))); await this.flushSave();
  }

  async transcribePdfBatch(batch, tail, signal) {
    const pages = await Promise.all(batch.map(async (page) => ({ n: page.n, data_url: await blobDataUrl(await this.store.getAsset(this.holeId, page.asset)) })));
    let output = ""; for await (const event of this.brain.transcribePages({ pages, tail }, signal)) if (event.type === "text") output += event.delta;
    return output.trim();
  }

  async materializeWebFigures(nodeId, markdown, pdf, batchIndex, figureBudget = { bytes: 0 }) {
    const replacements = []; let ordinal = 0;
    for (const ref of parseFigureRefs(markdown)) {
      const page = pdf.pages.find((entry) => entry.n === ref.page); let replacement = `*${ref.caption || "Figure"}*`;
      // Figures share the export headroom (§ portable caps) — past the byte
      // budget or the asset cap they degrade to caption text, never fail the run.
      if (page && ref.rect && figureBudget.bytes < MAX_PDF_FIGURE_ASSET_BYTES) try {
        const names = await this.store.listAssets(this.holeId); if (names.length >= 200) throw new Error("asset limit");
        const blob = await cropPdfAssetToBlob(await this.store.getAsset(this.holeId, page.asset), ref.rect);
        if (figureBudget.bytes + blob.size > MAX_PDF_FIGURE_ASSET_BYTES) throw new Error("figure budget");
        const name = `fig-p${String(ref.page).padStart(3, "0")}-${batchIndex * 20 + (++ordinal)}.jpg`;
        await this.store.putAsset(this.holeId, name, blob); this.registerAssetUrl?.(name, blob);
        figureBudget.bytes += blob.size; replacement = `![${ref.caption}](asset:${name})`;
      } catch {}
      replacements.push({ ref, markdown: replacement });
    }
    return rewriteFigureRefs(markdown, replacements);
  }

  patchPdf(nodeId, value) { this.dispatch({ type: "node_extensions_patch", node_id: nodeId, namespace: "pdf", value }); this.emit({ type: "node_extensions_patch", node_id: nodeId, namespace: "pdf", value }); this.scheduleSave(); }
  restorePdfConversion(nodeId, pdf) { this.dispatch({ type: "node_progress", node_id: nodeId, markdown: String(pdf.original_markdown ?? this.state.nodes.get(nodeId)?.markdown ?? "") }); this.patchPdf(nodeId, { ...pdf, converting: false, converted: false }); }
  failPdfConversion(nodeId, error) { const raw = this.state.nodes.get(nodeId)?.extensions?.pdf; if (raw?.version === 1) this.restorePdfConversion(nodeId, raw); this.abortByNode.delete(nodeId); if (error?.name !== "AbortError") this.onToast?.({ message: `PDF conversion failed: ${error?.message || error}` }); }

  handleExtensionsPatch(payload) {
    const result = this.applyPersistedBrowserEvent(payload);
    this.emit({ type: "node_extensions_patch", node_id: payload.node_id, namespace: payload.namespace, value: payload.value });
    return result;
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

    const reduced = reduceHoleEvent(this.state, { type: "delete_node", node_id: targetId }, { mutate: true });
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
      for (const name of extractNodeAssetRefs(node)) refs.add(name);
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
    const orphaned = assetsOrphanedByDeletion({ deletedNodes, remainingNodes: this.state.nodes.values(), extractRefs: extractNodeAssetRefs });
    for (const name of orphaned) {
      try { await this.store.deleteAsset(this.holeId, name); } catch {}
    }
  }

  dispatch(event, options) {
    const reduced = reduceHoleEvent(this.state, event, { ...options, mutate: true });
    this.state = reduced.state;
    return reduced.effects || {};
  }

  applyPersistedBrowserEvent(payload) {
    return applyPersistedBrowserEvent(payload, {
      dispatch: (event) => this.dispatch(event),
      scheduleSave: () => this.scheduleSave(),
    });
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
    this.emit(buildNodeAnsweredEvent(finalNode, { parent_id: null, origin: null }));
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
    await this.attachPdfSelection(node, context);
    const fallbackTitle = fallbackTitleForNode(node);
    context.fallbackTitle = fallbackTitle;
    // Each attempt, including a retry, gets a fresh run id. The reducer can
    // therefore reject late progress from the superseded attempt.
    const run = this.createGenerationRun(node, fallbackTitle);
    // Capture the brain at attempt start: provider changes affect only later
    // generations; this in-flight iterator finishes on the old brain.
    let generation = brain.answerBranch(context, controller.signal);
    const events = generationDocEvents(generation, run, {
      nodeId,
      progressFields: { base_url: node.base_url, base_url_source: node.base_url_source },
      answeredFields: () => branchAnsweredFields(this.state.nodes.get(nodeId)),
    });
    try {
      for await (const docEvent of events) {
        if (controller.signal.aborted || !this.isLivePending(nodeId)) return;
        this.dispatch(docEvent);
        if (docEvent.type === "node_progress") {
          const current = this.state.nodes.get(nodeId);
          this.emit({ ...docEvent, markdown: current.markdown });
          this.scheduleSave();
        }
      }
    } catch (error) {
      if (!context.attachment || controller.signal.aborted) throw error;
      delete context.attachment;
      this.dispatchProgress(nodeId, "", { emit: true });
      const retryRun = this.createGenerationRun(this.state.nodes.get(nodeId), fallbackTitle);
      generation = brain.answerBranch(context, controller.signal);
      for await (const docEvent of generationDocEvents(generation, retryRun, {
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
    }

    // Branches deliberately accept an empty provider stream: completion uses
    // the fallback title and empty/reset markdown. Root generation still rejects.
    const finalNode = this.state.nodes.get(nodeId);
    this.abortByNode.delete(nodeId);
    this.emit(buildNodeAnsweredEvent(finalNode));
    await this.flushSave();
  }

  async attachPdfSelection(node, context) {
    const parent = this.state.nodes.get(node.parent_id);
    const pdf = normalizePdfExtension(parent);
    const anchor = node.origin?.anchor?.pdf;
    if (!pdf || !anchor) return;
    const page = pdf.pages.find((entry) => entry.n === anchor.page);
    if (!page) return;
    try {
      const blob = await this.store.getAsset(this.holeId, page.asset);
      const dataUrl = await cropPdfAssetToDataUrl(blob, anchor.rect);
      context.attachment = { kind: "image", data_url: dataUrl, page: anchor.page };
    } catch {}
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
          // Authoring replaces its source, falling back to that source when the model returns no text.
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
      this.saveChain.cancel();
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
    this.saveChain.schedule();
  }

  async flushSave() {
    if (this.disposed) return this.savingChain;
    this.savingChain = this.saveChain.flush();
    return this.savingChain;
  }

  dispose() {
    if (this.disposed) return this.savingChain;
    this.disposed = true;
    this.saveChain.cancel();
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

function blobDataUrl(blob) {
  if (!blob) throw new Error("PDF page asset is missing.");
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}

export function createHoleFromMarkdown({ title, markdown, baseUrl = null } = {}) {
  const now = new Date().toISOString();
  const holeId = createWhimsicalHoleId();
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

function titleFromMarkdown(markdown) {
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
