import { MAX_ASK_ATTACHMENTS } from "../../../core/attachments.js";
import { validateImageAssetName } from "../../../core/assets.js";
import { normalizePdfAnchor } from "../../../core/hole/anchor.js";
import { dispatchBrowserEvent } from "../../../core/hole-host.js";
import { normalizePdfExtension } from "../../../core/pdf-shared.js";
import { assertHostCommandHandlers, MCP_HOST_COMMANDS } from "../../../core/vocabulary.js";
import { buildJsonError } from "../../shared/http.js";
import { error as logError } from "../../shared/logger.js";
import { resolveAsset } from "../store/fs-store.js";
import { mergePreferences } from "../store/prefs-store.js";
import { cropPdfRegionToFile } from "../pdf/crop.js";
import { handleSessionRequest } from "../http/routes.js";
import { SessionAnswer } from "./answer.js";
import { rawOrigin, rawPdfExtension } from "./session-values.js";
import { shortId } from "../../shared/ids.js";

const MAX_PREFERENCE_VALUE_BYTES = 64 * 1024;
const MAX_PREFERENCE_PATCH_BYTES = 256 * 1024;

function validatePreferencePatch(values) {
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    (Object.getPrototypeOf(values) !== Object.prototype && Object.getPrototypeOf(values) !== null)
  )
    throw buildJsonError("preferences_patch values must be a plain object", 400);
  for (const [key, value] of Object.entries(values)) {
    if (!/^rh-[a-z0-9-]+$/.test(key)) throw buildJsonError("preferences_patch has an invalid preference key: " + key, 400);
    if (typeof value !== "string" && value !== null)
      throw buildJsonError("preferences_patch value for " + key + " must be a string or null", 400);
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_PREFERENCE_VALUE_BYTES)
      throw buildJsonError("preferences_patch value for " + key + " exceeds 64 KB", 400);
  }
  if (Buffer.byteLength(JSON.stringify(values), "utf8") > MAX_PREFERENCE_PATCH_BYTES)
    throw buildJsonError("preferences_patch exceeds 256 KB", 400);
  return values;
}

/** Browser command routing and request-specific crop resolution. */
export class RabbitholeSession extends SessionAnswer {
  /** @param {any} options */
  constructor(options) {
    super(options);
    this.handleRequest = this.handleRequest.bind(this);
  }

  // ---- browser events (browser -> server) ---------------------------------

  handleBranchRequest(payload, preparedCrop = null) {
    const parentId = payload.parent_id === null ? null : String(payload.parent_id || "");
    const contextParentId = parentId ?? this.rootId;
    const parent = this.nodes.get(contextParentId);
    if (!parent) throw buildJsonError(`Parent node ${contextParentId || parentId} not found`, 404);
    // Raw flag, not normalizePdfExtension: mid-run the body is the stream and
    // normalization rejects it — which would drop the lock exactly when it matters.
    if (rawPdfExtension(parent)?.converting) throw buildJsonError("This PDF is being converted", 409);

    const suppliedRequestId = String(payload.request_id || "");
    const requestId = suppliedRequestId && !this.requests.get(suppliedRequestId)
      ? suppliedRequestId
      : this.requests.mintId();
    const nodeId = String(payload.node_id || this.mintNodeId());
    const effects = this.dispatchHoleEvent(
      { ...payload, type: "branch_request", request_id: requestId, node_id: nodeId, parent_id: parentId },
      { now: new Date().toISOString() }
    );
    const node = effects.createdNode;
    this.requests.pending(requestId, nodeId);
    const origin = rawOrigin(node);

    /** @type {any} */
    const event = {
      status: "branch_request",
      session_id: this.id,
      request_id: requestId,
      node_id: nodeId,
      parent_node_id: contextParentId,
      parent_node_title: parent.title || "Untitled",
      selected_text: origin.selected_text,
      question: origin.question,
      lens: origin.lens,
      ...(origin.instruction ? { instruction: origin.instruction } : {}),
      ...(origin.anchor?.block ? { anchor: { block: origin.anchor.block } } : {}),
      lineage: this.lineageTitles(contextParentId),
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

  mintNodeId() {
    while (true) {
      const id = shortId();
      if (!this.nodes.has(id)) return id;
    }
  }

  async preparePdfCrop(payload) {
    if (payload.parent_id === null || (Array.isArray(payload.attachment_assets) && payload.attachment_assets.length)) return null;
    const parent = this.nodes.get(String(payload.parent_id || ""));
    const anchor = normalizePdfAnchor(payload.anchor?.pdf);
    const pdf = normalizePdfExtension(parent);
    const pageNumber = anchor?.fragments?.[0]?.page;
    if (!pdf || !pageNumber || !pdf.pages.some((entry) => entry.n === pageNumber)) return null;
    await this.regionSweep;
    const imagePath = await cropPdfRegionToFile({ holeId: this.holeId, asset: pdf.source.asset, anchor, pageNumber, requestId: payload.request_id });
    this.crops.holdRegion(String(payload.request_id), imagePath);
    return { imagePath, page: pageNumber };
  }

  async queueBranchEvent(event, node, parent, preparedCrop = null) {
    const pastedAssets = [];
    for (const rawName of Array.isArray(node?.origin?.attachment_assets) ? node.origin.attachment_assets : []) {
      try { pastedAssets.push(validateImageAssetName(rawName)); } catch {}
      if (pastedAssets.length === MAX_ASK_ATTACHMENTS) break;
    }
    if (pastedAssets.length) {
      const attachments = [];
      for (const name of pastedAssets) {
        try {
          const imagePath = await resolveAsset(this.holeId, name);
          if (imagePath) attachments.push({ kind: "image", image_path: imagePath, source: "pasted_image" });
        } catch (error) {
          logError(`Pasted image ${name} could not be resolved: ${error.message}`);
        }
      }
      if (attachments.length) event.attachments = attachments;
      this.pushEvent(event);
      return;
    }
    if (preparedCrop?.imagePath) {
      event.region = { page: preparedCrop.page, image_path: preparedCrop.imagePath };
      this.pushEvent(event);
      return;
    }

    const anchor = node?.parent_id == null ? null : (node?.origin?.anchor?.pdf || parent?.origin?.anchor?.pdf);
    let sourceNode = parent;
    while (sourceNode && !normalizePdfExtension(sourceNode)) sourceNode = this.nodes.get(sourceNode.parent_id);
    const pdf = anchor ? normalizePdfExtension(sourceNode) : null;
    const pageNumber = anchor?.fragments?.[0]?.page;
    if (pdf && pageNumber && pdf.pages.some((entry) => entry.n === pageNumber)) try {
      await this.regionSweep;
      const imagePath = await cropPdfRegionToFile({ holeId: this.holeId, asset: pdf.source.asset, anchor, pageNumber, requestId: event.request_id });
      event.region = { page: pageNumber, image_path: imagePath };
      this.crops.holdRegion(event.request_id, imagePath);
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

    const result = await this.engine.deleteNode(targetId, {
      beforeDelete: (doomed) => {
        for (const record of this.requests.cancelSubtree(doomed)) {
          this.clearAnswerWatchdog(record.requestId);
          this.discardRegionFile(record.requestId);
        }
        this.queue = this.queue.filter((event) => !(event.node_id && doomed.has(event.node_id)));
        this.outboundEvents = this.outboundEvents.filter((entry) => !(entry.data.node_id && doomed.has(entry.data.node_id)));
      },
    });
    this.state = this.engine.state; this.nodes = this.state.nodes; this.viewState = this.state.view_state;
    return result;
  }

  handleNodeUpdate(payload) {
    if (!this.nodes.has(String(payload.node_id || ""))) return { ok: true }; // tolerate updates for transient nodes
    return this.applyPersistedBrowserEvent(payload);
  }

  async handleNodeCreate(payload) {
    const result = await this.engine.nodeCreate(payload);
    this.state = this.engine.state; this.nodes = this.state.nodes; this.viewState = this.state.view_state;
    return result;
  }

  // Batched layout update (e.g. Tidy) — one request, one debounced save.
  handleNodesUpdate(payload) {
    return this.applyPersistedBrowserEvent(payload);
  }

  applyPersistedBrowserEvent(payload) {
    const result = this.engine.applyPersistedEvent(payload);
    this.state = this.engine.state; this.nodes = this.state.nodes; this.viewState = this.state.view_state;
    return result;
  }

  async handleBrowserEvent(payload) {
    const handlers = assertHostCommandHandlers("MCP host", {
      branch_request: async (event) => {
        let preparedCrop = null;
        try { preparedCrop = await this.preparePdfCrop(event); }
        catch (error) { logError(`PDF crop persistence failed: ${error.message}`); }
        const result = this.handleBranchRequest(event, preparedCrop);
        await this.flushSave();
        return result;
      },
      node_create: (event) => this.handleNodeCreate(event),
      node_update: (event) => this.handleNodeUpdate(event),
      nodes_update: (event) => this.handleNodesUpdate(event),
      block_state: (event) => this.applyPersistedBrowserEvent(event),
      node_extensions_patch: (event) => {
        const result = this.applyPersistedBrowserEvent(event);
        this.broadcast({ type: "node_extensions_patch", node_id: event.node_id, namespace: event.namespace, value: event.value });
        return result;
      },
      preferences_patch: async (event) => {
        const values = validatePreferencePatch(event.values);
        await mergePreferences(values);
        // Only this process's session clients are synchronized. Other MCP
        // sessions converge through preferences.json on their next page load;
        // deliberately do not turn this into cross-process file watching.
        this.broadcast({ type: "preferences", values: values });
        return { ok: true };
      },
      convert_pdf: (event) => this.handleConvertPdf(event),
      convert_cancel: (event) => { this.restoreNodeConversion(String(event.node_id || "")); return { ok: true }; },
      delete_node: (event) => this.handleDeleteNode(event),
      view_state: (event) => this.applyPersistedBrowserEvent(event),
      done: () => { this.close("done"); return { ok: true }; },
    }, MCP_HOST_COMMANDS);
    return dispatchBrowserEvent(payload, {
      handlers,
      unsupported: (type) => { throw buildJsonError(`Unsupported browser event: ${type}`, 400); },
    });
  }

  // ---- HTTP routing -------------------------------------------------------

  async handleRequest(req, res) {
    return handleSessionRequest(this, req, res);
  }
}
