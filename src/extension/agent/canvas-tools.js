import { randomUUID } from "node:crypto";

/** @typedef {any} PiToolDefinition */

export class CanvasToolService {
  /**
   * @param {{
   *   document: import("../nora-document.js").NoraDocument,
   *   idFactory?: () => string,
   *   now?: () => string,
   *   owner?: string
   * }} options
   */
  constructor(options) {
    this.document = options.document;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.owner = options.owner ?? "agent";
  }

  /**
   * @param {{ parentNodeId?: unknown, parent_node_id?: unknown, title?: unknown, markdown?: unknown, expectedRevision?: unknown, expected_revision?: unknown }} input
   */
  async createNode(input) {
    this.#assertRevision(input.expectedRevision ?? input.expected_revision);
    const parentId = String(input.parentNodeId ?? input.parent_node_id ?? this.document.state.rootNodeId);
    if (!this.document.state.nodes.has(parentId)) throw new TypeError(`Parent node ${parentId} does not exist`);
    const nodeId = this.idFactory();
    const title = normalizeTitle(input.title);
    const markdown = String(input.markdown ?? "");
    const createdAt = this.now();
    await this.document.commitRunEvent({
      type: "branch_request",
      request_id: nodeId,
      parent_id: parentId,
      node_id: nodeId,
      question: title,
      branch_type: "followup",
      created_at: createdAt,
    });
    await this.document.commitRunEvent({
      type: "node_answered",
      parent_id: parentId,
      node_id: nodeId,
      title,
      markdown,
      read: false,
      created_at: createdAt,
    });
    await this.document.commitRunEvent({
      type: "node_extensions_patch",
      node_id: nodeId,
      namespace: "nora",
      value: { createdBy: this.owner, updatedBy: this.owner },
    });
    return { nodeId, revision: this.document.revision };
  }

  /**
   * @param {{ nodeId?: unknown, node_id?: unknown, title?: unknown, markdown?: unknown, state?: unknown, expectedRevision?: unknown, expected_revision?: unknown }} input
   */
  async updateNode(input) {
    this.#assertRevision(input.expectedRevision ?? input.expected_revision);
    const node = this.#agentNode(input.nodeId ?? input.node_id);
    const title = input.title == null ? node.title : normalizeTitle(input.title);
    const markdown = input.markdown == null ? node.markdown : String(input.markdown);
    const state = normalizeNodeState(input.state ?? node.state);
    const updatedAt = this.now();
    await this.document.commitRunEvent({
      type: "node_answered",
      parent_id: node.parentId,
      node_id: node.id,
      title,
      markdown,
      read: node.read,
      created_at: node.createdAt,
    });
    await this.document.commitRunEvent({
      type: "node_state",
      node_id: node.id,
      state,
      updated_at: updatedAt,
    });
    const existingNora = node.extensions?.nora;
    const noraExtensions = existingNora && typeof existingNora === "object" && !Array.isArray(existingNora)
      ? /** @type {Record<string, unknown>} */ (existingNora)
      : {};
    await this.document.commitRunEvent({
      type: "node_extensions_patch",
      node_id: node.id,
      namespace: "nora",
      value: { ...noraExtensions, createdBy: this.owner, updatedBy: this.owner },
    });
    return { nodeId: node.id, revision: this.document.revision };
  }

  /**
   * @param {{ nodeId?: unknown, node_id?: unknown, evidence?: unknown, sourceId?: unknown, source_id?: unknown, expectedRevision?: unknown, expected_revision?: unknown }} input
   */
  async attachEvidence(input) {
    this.#assertRevision(input.expectedRevision ?? input.expected_revision);
    const node = this.#agentNode(input.nodeId ?? input.node_id);
    const evidence = normalizeEvidence(input.evidence);
    const sourceId = String(input.sourceId ?? input.source_id ?? evidence.sourceId ?? "");
    if (sourceId && !this.document.state.sources.has(sourceId)) {
      throw new TypeError(`Evidence source ${sourceId} is not present in the document`);
    }
    await this.document.commitRunEvent({ type: "evidence_record", evidence });
    await this.document.commitRunEvent({
      type: "node_references",
      node_id: node.id,
      source_ids: sourceId ? [sourceId] : [],
      evidence_ids: [evidence.id],
      updated_at: this.now(),
    });
    return { nodeId: node.id, evidenceId: evidence.id, revision: this.document.revision };
  }

  /** @param {unknown} rawRevision */
  #assertRevision(rawRevision) {
    if (rawRevision == null) return;
    if (!Number.isSafeInteger(rawRevision)) throw new TypeError("expectedRevision must be a safe integer");
    if (Number(rawRevision) !== this.document.revision) {
      throw new Error(`Document revision changed: expected ${rawRevision}, current ${this.document.revision}`);
    }
  }

  /** @param {unknown} rawNodeId */
  #agentNode(rawNodeId) {
    const nodeId = String(rawNodeId ?? "");
    if (!nodeId) throw new TypeError("nodeId is required");
    const node = this.document.state.nodes.get(nodeId);
    if (!node) throw new TypeError(`Node ${nodeId} does not exist`);
    const nora = node.extensions?.nora;
    const createdBy = nora && typeof nora === "object" && !Array.isArray(nora)
      ? /** @type {{ createdBy?: unknown }} */ (nora).createdBy
      : null;
    if (createdBy !== this.owner) throw new Error(`Node ${nodeId} is not owned by Nora's agent tools`);
    return node;
  }
}

/**
 * @param {ConstructorParameters<typeof CanvasToolService>[0]} options
 * @returns {PiToolDefinition[]}
 */
export function createCanvasTools(options) {
  const service = new CanvasToolService(options);
  return [
    canvasTool("nora_create_node", "Create Nora node", "Create one canvas node owned by Nora's active agent run.", {
      parentNodeId: { type: "string", optional: true },
      title: { type: "string" },
      markdown: { type: "string" },
      expectedRevision: { type: "number", optional: true },
    }, (_id, params) => service.createNode(params)),
    canvasTool("nora_update_node", "Update Nora node", "Update markdown/title/status for a Nora agent-created canvas node.", {
      nodeId: { type: "string" },
      title: { type: "string", optional: true },
      markdown: { type: "string", optional: true },
      state: { type: "string", optional: true },
      expectedRevision: { type: "number", optional: true },
    }, (_id, params) => service.updateNode(params)),
    canvasTool("nora_attach_evidence", "Attach Nora evidence", "Attach an evidence record to a Nora agent-created node.", {
      nodeId: { type: "string" },
      evidence: { type: "object" },
      sourceId: { type: "string", optional: true },
      expectedRevision: { type: "number", optional: true },
    }, (_id, params) => service.attachEvidence(params)),
  ];
}

/**
 * @param {string} name
 * @param {string} label
 * @param {string} description
 * @param {Record<string, unknown>} properties
 * @param {(toolCallId: string, params: Record<string, any>) => unknown | Promise<unknown>} execute
 * @returns {PiToolDefinition}
 */
function canvasTool(name, label, description, properties, execute) {
  return {
    name,
    label,
    description,
    parameters: {
      type: "object",
      properties,
      required: Object.entries(properties)
        .filter(([, schema]) => !/** @type {{ optional?: boolean }} */ (schema).optional)
        .map(([key]) => key),
      additionalProperties: false,
    },
    executionMode: "sequential",
    /**
     * @param {string} toolCallId
     * @param {unknown} params
     */
    async execute(toolCallId, params) {
      const details = await execute(toolCallId, /** @type {Record<string, any>} */ (params));
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  };
}

/** @param {unknown} value */
function normalizeTitle(value) {
  const title = String(value ?? "").trim();
  return title || "Nora result";
}

/** @param {unknown} value */
function normalizeNodeState(value) {
  const state = String(value ?? "complete");
  if (["pending", "running", "complete", "cancelled", "failed", "interrupted"].includes(state)) return state;
  throw new TypeError("state is not a supported Nora node state");
}

/** @param {unknown} value */
function normalizeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("evidence must be an object");
  const evidence = /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(value)));
  if (typeof evidence.id !== "string" || !evidence.id) throw new TypeError("evidence.id is required");
  if (typeof evidence.sourceType !== "string" || !evidence.sourceType) throw new TypeError("evidence.sourceType is required");
  if (typeof evidence.title !== "string") evidence.title = "";
  if (typeof evidence.excerpt !== "string") evidence.excerpt = "";
  if (typeof evidence.capturedAt !== "string" || !evidence.capturedAt) throw new TypeError("evidence.capturedAt is required");
  if (!Object.prototype.hasOwnProperty.call(evidence, "stableLocator")) throw new TypeError("evidence.stableLocator is required");
  if (!Object.prototype.hasOwnProperty.call(evidence, "range")) evidence.range = null;
  if (!evidence.extensions || typeof evidence.extensions !== "object" || Array.isArray(evidence.extensions)) evidence.extensions = {};
  if (evidence.sourceId != null && typeof evidence.sourceId !== "string") throw new TypeError("evidence.sourceId must be a string or null");
  return /** @type {import("../../core/contracts/evidence.js").EvidenceRecord} */ (/** @type {unknown} */ (evidence));
}
