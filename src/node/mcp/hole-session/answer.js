import { addAssetsToHole, defaultFsStore } from "../store/fs-store.js";
import { maybeUpgradeBaseUrlFromFrontmatter, normalizeBaseUrl } from "../../../core/base-url.js";
import { collectAllNotes, isNoteNode } from "../../../core/hole/ask.js";
import { projectNode } from "../../../core/hole/node.js";
import { buildJsonError } from "../../shared/http.js";
import { buildNodeAnsweredEvent } from "../../../core/hole-host.js";
import { normalizePdfExtension } from "../../../core/pdf-shared.js";
import { materializePdfFigures } from "../../../core/pdf/figures.js";
import { TRANSCRIBE_V1_RULES } from "../../../core/prompts/transcribe-v1.js";
import { cropPdfFigureToAsset, renderPdfPageToFile } from "../pdf/crop.js";
import { error as logError } from "../../shared/logger.js";
import { GenerationIngress } from "./generation-ingress.js";
import { SessionBroadcast } from "./broadcast.js";
import { rawOrigin, rawPdfExtension } from "./session-values.js";

/** Agent answers, PDF conversion, and saved-work requeueing. */
export class SessionAnswer extends SessionBroadcast {
  // ---- the answer path (agent -> server -> browser) -----------------------

  createGenerationIngress(node) {
    return new GenerationIngress({
      id: this.mintRunId(),
      nodeId: node.id,
      fallbackTitle: node.title || "Untitled",
    });
  }

  setRequestDelegated(requestId, delegated) {
    const record = this.requests.get(requestId);
    if (record?.conversion) throw buildJsonError("PDF conversion requests cannot be delegated", 409);
    const nodeId = record?.nodeId;
    if (!nodeId) throw buildJsonError(`No pending branch request ${requestId}`, 404);
    const node = this.nodes.get(nodeId);
    if (!node || node.status !== "pending") throw buildJsonError(`Node ${nodeId} is not pending`, 409);

    if (delegated) {
      this.requests.delegate(requestId);
      this.clearAnswerWatchdog(requestId);
      this.setContextBusy(false);
    } else {
      this.requests.reclaim(requestId);
    }
    this.broadcast({ type: "node_work_state", node_id: nodeId, state: delegated ? "delegated" : "thinking" });
    // Reclaiming work must wake an already-attached listener; otherwise the
    // request is eligible for redelivery but can remain stranded until some
    // unrelated browser event happens to arrive.
    if (!delegated && this.waiter) {
      const event = record.inFlight;
      if (event) this.pushEvent(event);
    }
    return { ok: true, node_id: nodeId, request_id: requestId, delegated };
  }

  /**
   * @param {{
   *   requestId: string,
   *   title?: string,
   *   content?: string,
   *   partial?: boolean,
   *   delegated?: boolean,
   *   baseUrl?: string,
   *   assets?: Array<{name: string, file_path: string}>,
   *   signal?: AbortSignal,
   * }} input
   */
  async answerBranch({ requestId, title, content, partial, delegated, baseUrl, assets, signal }) {
    if (this.closed) throw new Error("Rabbithole session is already closed");
    this.markAgentAttached();
    let request = this.requests.get(requestId);
    if (request?.completedNodeId) {
      return {
        ok: true,
        node_id: request.completedNodeId,
        request_id: requestId,
        duplicate: true,
        completed: true,
      };
    }
    if (typeof delegated === "boolean") return this.setRequestDelegated(requestId, delegated);

    request = this.requests.beginAnswer(requestId);
    const nonBlocking = request.nonBlocking;
    this.setContextBusy(false);
    this.clearAnswerWatchdog(requestId);
    if (!partial) this.discardRegionFile(requestId);
    if (request.conversion) return this.answerConversion({ requestId, content, partial, signal });

    // The human deleted this branch while the agent was writing it — absorb the
    // answer quietly, preserving whether its final owned the listener.
    if (request.cancelledNonBlocking !== null) {
      const cancelledNonBlocking = request.cancelledNonBlocking;
      if (partial) return { ok: true, node_id: null, request_id: requestId, partial: true, cancelled: true };
      request.cancelledNonBlocking = null;
      if (cancelledNonBlocking) return { ok: true, node_id: null, request_id: requestId, cancelled: true, completed: true, delegated: true };
      return this.waitForEvent(signal);
    }

    const nodeId = request.nodeId;
    if (!nodeId) throw buildJsonError(`No pending branch request ${requestId}`, 404);
    const node = this.nodes.get(nodeId);
    if (!node) throw buildJsonError(`Node ${nodeId} not found`, 404);
    let ingress = request.generation;
    if (!ingress) {
      ingress = this.createGenerationIngress(node);
      request.generation = ingress;
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
      this.startAnswerWatchdog(requestId);
      // Deliberately untagged outbound projection: `progress` already passed
      // through the reducer with its Run tag; the SSE payload mirrors
      // canonical node state and is never reducer input.
      this.broadcast({
        type: "node_progress",
        node_id: updated.id,
        markdown: updated.markdown,
        base_url: updated.base_url,
        base_url_source: updated.base_url_source,
      });
      this.setContextBusy(true);
      return { ok: true, node_id: updated.id, request_id: requestId, partial: true };
    }

    // Claim the request before the async render boundary so a concurrent
    // duplicate answer for the same request_id is rejected (404) rather than
    // both rendering and double-broadcasting the node.
    request.nodeId = null;
    request.generation = null;
    request.nonBlocking = false;

    // GenerationIngress accepts both final tails and repeated full answers;
    // the session remains responsible only for node metadata and lifecycle.
    const { id: _nodeProjectionId, ...nodeFields } = projectNode(node, "wire");
    const answeredFields = {
      ...nodeFields,
      ...baseUrlFields,
      // Fresh answers land unread; the client flips this the moment the human
      // actually opens them (and immediately if they're watching it stream).
      read: false,
    };
    const answered = ingress.acceptChunk(content, { final: true, title, answeredFields });
    if (!explicitBaseUrl) maybeUpgradeBaseUrlFromFrontmatter(answered);
    this.dispatchHoleEvent(answered);
    const finalNode = this.nodes.get(nodeId);
    this.requests.answer(requestId, finalNode.id);

    this.broadcast(buildNodeAnsweredEvent(finalNode));
    this.flushSave();

    if (nonBlocking) {
      return { ok: true, node_id: finalNode.id, request_id: requestId, completed: true, delegated: true };
    }
    return this.waitForEvent(signal);
  }

  async answerConversion({ requestId, content, partial, signal }) {
    const record = this.requests.get(requestId);
    const request = record?.conversion;
    const node = this.nodes.get(request?.node_id);
    if (!node) throw buildJsonError("Conversion node not found", 404);
    request.markdown += String(content || "");
    // request.pdf was validated at convert start against the original body —
    // the live body is the stream itself, so re-normalizing here would fail.
    const pdf = request.pdf;
    this.dispatchHoleEvent({ type: "node_progress", node_id: node.id, markdown: request.markdown });
    this.broadcast({ type: "pdf_convert_progress", node_id: node.id, markdown: request.markdown, page_done: pdf.pages.at(-1)?.n || 0, page_total: pdf.pages.length });
    if (partial) { this.startAnswerWatchdog(requestId); this.scheduleSave(); this.setContextBusy(true); return { ok: true, node_id: node.id, request_id: requestId, partial: true }; }
    const materialized = await this.materializeNodeFigures(request.markdown, pdf);
    this.dispatchHoleEvent({ ...buildNodeAnsweredEvent(this.nodes.get(node.id)), markdown: materialized });
    this.patchNodePdf(node.id, { ...pdf, converting: false, converted: true, convert_request: false });
    await this.crops.releaseConversion(requestId);
    await this.flushSave();
    this.broadcast(buildNodeAnsweredEvent(this.nodes.get(node.id)));
    this.requests.answer(requestId, node.id);
    return this.waitForEvent(signal);
  }

  discardRegionFile(requestId) {
    this.crops.releaseRegion(requestId).catch(() => {});
  }

  async materializeNodeFigures(markdown, pdf, figureBudget = { bytes: 0 }) {
    return materializePdfFigures({ markdown, pdf, figureBudget,
      assetCount: () => this.assetNames.size,
      makeName: (ref, ordinal) => `fig-p${String(ref.page).padStart(3, "0")}-${ordinal}.png`,
      materialize: async ({ ref, page, name }) => {
        const result = await cropPdfFigureToAsset({ holeId: this.holeId, asset: pdf.source.asset, pageNumber: page.n, rect: ref.rect, name });
        this.assetNames.add(name);
        return result;
      },
      discard: async (name) => { this.assetNames.delete(name); await defaultFsStore.deleteAsset(this.holeId, name); },
    });
  }

  patchNodePdf(nodeId, value) {
    this.engine.patchExtension(nodeId, "pdf", value);
    this.state = this.engine.state; this.nodes = this.state.nodes;
  }

  // Restore reads the RAW extension: mid-run the node body is the streamed
  // output, so normalizePdfExtension (which validates offsets against the live
  // body) would reject exactly the state this method exists to repair.
  restoreNodeConversion(nodeId) {
    const raw = rawPdfExtension(this.nodes.get(nodeId));
    if (!raw || raw.version !== 2) return;
    this.engine.restorePdfConversion(nodeId, { ...raw, convert_request: false });
    this.state = this.engine.state; this.nodes = this.state.nodes;
    this.requests.deleteConversionForNode(nodeId);
  }

  async handleConvertPdf(payload, { saved = false } = {}) {
    const nodeId = String(payload.node_id || ""), node = this.nodes.get(nodeId), pdf = normalizePdfExtension(node);
    if (!pdf) throw buildJsonError("This node is not a native PDF", 400);
    for (const candidate of this.nodes.values()) {
      if (candidate.parent_id === nodeId && !isNoteNode(candidate)) throw buildJsonError("Create a text version before asking follow-ups", 409);
    }
    if (pdf.converting && !saved) throw buildJsonError("Conversion is already running", 409);
    const requestId = this.requests.mintId();
    if (!pdf.converting) this.patchNodePdf(nodeId, { ...pdf, converting: true, converted: false, original_markdown: node.markdown, convert_request: true });
    const activePdf = normalizePdfExtension({ markdown: node.markdown, extensions: { pdf: rawPdfExtension(this.nodes.get(nodeId)) } });
    if (!activePdf) throw buildJsonError("This node is not a native PDF", 400);
    this.requests.convert(requestId, { node_id: nodeId, markdown: "", pdf: activePdf });
    const pages = await Promise.all(activePdf.pages.map(async (page) => {
      const key = `convert-${requestId}-${page.n}`;
      const imagePath = await renderPdfPageToFile({ holeId: this.holeId, asset: activePdf.source.asset, pageNumber: page.n, requestId: key });
      this.crops.holdConversionPage(requestId, page.n, imagePath);
      return { n: page.n, image_path: imagePath };
    }));
    const event = { status: "convert_request", session_id: this.id, request_id: requestId, node_id: nodeId, page_count: activePdf.pages.length,
      pages, rules: TRANSCRIBE_V1_RULES, ...(saved ? { saved: true } : {}) };
    this.pushEvent(event); await this.flushSave(); return { ok: true, node_id: nodeId, request_id: requestId };
  }

  requeueSavedConversions() {
    for (const node of this.nodes.values()) {
      const raw = rawPdfExtension(node);
      if (!raw || raw.version !== 2 || !raw.converting) continue;
      // Mid-run saves persist the streamed body — put the original back before
      // deciding anything else, then re-issue the request as a saved convert.
      this.restoreNodeConversion(node.id);
      if (raw.convert_request) queueMicrotask(() => this.handleConvertPdf({ node_id: node.id }, { saved: true }).catch((error) => logError(error.message)));
    }
  }

  buildRehydrationPayload() {
    const saved = [...this.nodes.values()].filter((n) => n.status === "pending" && n.origin);
    const notes = collectAllNotes(this.nodes);
    return {
      title: this.title,
      nodes: [...this.nodes.values()]
        .filter((n) => n.status === "answered")
        .map((n) => ({ id: n.id, parent_id: n.parent_id, title: n.title, markdown: n.markdown, ...(isNoteNode(n) ? { kind: "note" } : {}) })),
      notes,
      ...(saved.length
        ? {
            saved_asks: saved.map((n) => ({
              node_id: n.id,
              question: rawOrigin(n).question || "",
              selected_text: n.parent_id == null ? "" : (rawOrigin(n).selected_text || ""),
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
      const requestId = this.requests.mintId();
      this.requests.pending(requestId, node.id);
      const contextParentId = node.parent_id ?? this.rootId;
      const parent = this.nodes.get(contextParentId);
      const origin = rawOrigin(node);
      /** @type {any} */
      const event = {
        status: "branch_request",
        session_id: this.id,
        request_id: requestId,
        node_id: node.id,
        parent_node_id: contextParentId,
        parent_node_title: parent?.title || "Untitled",
        selected_text: node.parent_id == null ? "" : (origin.selected_text || ""),
        question: origin.question || "",
        lens: origin.lens || null,
        ...(origin.instruction ? { instruction: origin.instruction } : {}),
        ...(origin.anchor?.block ? { anchor: { block: origin.anchor.block } } : {}),
        lineage: this.lineageTitles(contextParentId),
        saved: true, // asked while the agent was away; answer it like any other
      };
      if (this.needsRehydration) {
        this.needsRehydration = false;
        event.rehydration = this.buildRehydrationPayload();
      }
      enqueue = enqueue.then(async () => {
        try {
          await this.queueBranchEvent(event, node, parent);
        } catch (error) {
          logError(`Saved branch ${node.id} attachment resolution failed: ${error.message}`);
          this.pushEvent(event);
        }
      });
    }
    enqueue.catch((error) => logError(`Saved branch requeue failed: ${error.message}`));
  }

}
