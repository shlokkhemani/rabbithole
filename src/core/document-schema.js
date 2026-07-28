import { normalizeBaseUrl, normalizeStoredBaseUrlFields } from "./base-url.js";
import { normalizePosition, normalizeSize, normalizeViewState } from "./model.js";
import { cloneJson } from "./utils.js";

export const NORA_DOCUMENT_SCHEMA_VERSION = 1;
export const NEWER_NORA_DOCUMENT_MESSAGE = "This Nora document was saved by a newer version of Nora -- update to open it.";
export const NORA_NODE_STATES = Object.freeze(["pending", "running", "complete", "cancelled", "failed", "interrupted"]);

const NORA_NODE_STATE_SET = new Set(NORA_NODE_STATES);
const HEX_SHA256_RE = /^[a-f0-9]{64}$/;

/** @typedef {import("./contracts/document.js").NoraDocument} NoraDocument */
/** @typedef {import("./contracts/document.js").NoraNode} NoraNode */
/** @typedef {import("./contracts/document.js").NoraEdge} NoraEdge */
/** @typedef {import("./contracts/document.js").NoraAttachment} NoraAttachment */
/** @typedef {import("./contracts/evidence.js").SourceRecord} SourceRecord */
/** @typedef {import("./contracts/evidence.js").EvidenceRecord} EvidenceRecord */
/** @typedef {import("./contracts/agent-run.js").AgentRunSummary} AgentRunSummary */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function requireRecord(value, path) {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} path @returns {string} */
function requireString(value, path) {
  if (typeof value !== "string" || !value) throw new Error(`${path} must be a non-empty string`);
  return value;
}

/** @param {unknown} value @param {string} path @returns {string | null} */
function nullableString(value, path) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${path} must be a string or null`);
  return value;
}

/** @param {unknown} value @param {string} path @returns {string | undefined} */
function optionalString(value, path) {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string when present`);
  return value;
}

/** @param {unknown} value @param {string} path @returns {string | null} */
function nullableTimestamp(value, path) {
  if (value == null) return null;
  if (typeof value !== "string" || !value) throw new Error(`${path} must be an ISO timestamp string or null`);
  return value;
}

/** @param {unknown} value @param {string} path @returns {number} */
function requireSafeInteger(value, path) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${path} must be a non-negative safe integer`);
  return Number(value);
}

/** @param {unknown} value @param {string} path @returns {string[]} */
function stringArray(value, path) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

/** @param {unknown} value @param {string} path @param {Set<unknown>} [seen] */
function assertJsonValue(value, path, seen = new Set()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be finite JSON data`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} must be JSON data`);
  if (seen.has(value)) throw new Error(`${path} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${path} must be plain JSON data`);
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) throw new Error(`${path}.${key} must be JSON data`);
    assertJsonValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

/** @param {unknown} value @param {string} path @returns {Record<string, unknown>} */
function jsonObject(value, path) {
  const record = requireRecord(value ?? {}, path);
  assertJsonValue(record, path);
  return /** @type {Record<string, unknown>} */ (cloneJson(record));
}

/** @param {unknown} value @param {string} path @returns {unknown} */
function jsonValue(value, path) {
  assertJsonValue(value, path);
  return cloneJson(value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts/document.js").NoraNodeState} */
export function normalizeNoraNodeState(value, path = "node state") {
  const raw = String(value ?? "complete");
  if (raw === "answered") return "complete";
  if (NORA_NODE_STATE_SET.has(raw)) return /** @type {import("./contracts/document.js").NoraNodeState} */ (raw);
  throw new Error(`${path} is invalid`);
}

/** @param {unknown} state @returns {"pending" | "answered"} */
export function noraStateToRendererStatus(state) {
  const normalized = normalizeNoraNodeState(state);
  return normalized === "pending" || normalized === "running" ? "pending" : "answered";
}

/** @param {unknown} parentId @param {unknown} childId */
export function noraEdgeId(parentId, childId) {
  return `edge:${String(parentId)}:${String(childId)}`;
}

/** @param {Map<string, any> | any[] | Record<string, any> | undefined | null} collection */
function valuesOf(collection) {
  if (!collection) return [];
  if (collection instanceof Map) return [...collection.values()];
  if (Array.isArray(collection)) return collection;
  if (isRecord(collection)) return Object.values(collection);
  return [];
}

/** @param {Partial<NoraNode> & Record<string, any>} node @param {number} index @returns {NoraNode} */
function toPersistedNode(node, index) {
  const rawState = node.state ?? node.status ?? "complete";
  const rawBaseUrl = node.baseUrl ?? node.base_url;
  const base = normalizeStoredBaseUrlFields({
    base_url: rawBaseUrl,
    base_url_source: node.baseUrlSource ?? node.base_url_source,
  });
  if (!base.base_url && rawBaseUrl != null) {
    try {
      base.base_url = normalizeBaseUrl(rawBaseUrl, `nodes[${index}].baseUrl`);
      base.base_url_source = null;
    } catch {}
  }
  const id = requireString(node.id, `nodes[${index}].id`);
  return {
    id,
    parentId: nullableString(node.parentId ?? node.parent_id, `nodes[${index}].parentId`),
    title: String(node.title ?? ""),
    markdown: String(node.markdown ?? ""),
    baseUrl: base.base_url,
    baseUrlSource: base.base_url_source,
    origin: node.origin == null ? null : jsonValue(node.origin, `nodes[${index}].origin`),
    position: normalizePosition(node.position),
    size: normalizeSize(node.size),
    fontScale: Number(node.fontScale ?? node.font_scale) || 1,
    collapsed: !!node.collapsed,
    state: normalizeNoraNodeState(rawState, `nodes[${index}].state`),
    read: !!node.read,
    createdAt: nullableTimestamp(node.createdAt ?? node.created_at, `nodes[${index}].createdAt`),
    updatedAt: nullableTimestamp(node.updatedAt ?? node.updated_at, `nodes[${index}].updatedAt`),
    sourceIds: stringArray(node.sourceIds ?? node.source_ids, `nodes[${index}].sourceIds`),
    evidenceIds: stringArray(node.evidenceIds ?? node.evidence_ids, `nodes[${index}].evidenceIds`),
    attachmentIds: stringArray(node.attachmentIds ?? node.attachment_ids, `nodes[${index}].attachmentIds`),
    runId: nullableString(node.runId ?? node.run_id, `nodes[${index}].runId`),
    extensions: jsonObject(node.extensions ?? {}, `nodes[${index}].extensions`),
  };
}

/** @param {Partial<NoraEdge> & Record<string, any>} edge @param {number} index @returns {NoraEdge} */
function toPersistedEdge(edge, index) {
  const fromNodeId = requireString(edge.fromNodeId ?? edge.from_node_id, `edges[${index}].fromNodeId`);
  const toNodeId = requireString(edge.toNodeId ?? edge.to_node_id, `edges[${index}].toNodeId`);
  return {
    id: String(edge.id || noraEdgeId(fromNodeId, toNodeId)),
    fromNodeId,
    toNodeId,
    kind: String(edge.kind || "branch"),
    createdAt: nullableTimestamp(edge.createdAt ?? edge.created_at, `edges[${index}].createdAt`),
    extensions: jsonObject(edge.extensions ?? {}, `edges[${index}].extensions`),
  };
}

/** @param {NoraNode[]} nodes @param {any[] | null} rawEdges */
function normalizeEdges(nodes, rawEdges) {
  const previous = rawEdges && rawEdges.length
    ? rawEdges.map((edge, index) => toPersistedEdge(edge, index))
    : [];
  const byPair = new Map(previous.map((edge) => [`${edge.fromNodeId}\0${edge.toNodeId}`, edge]));
  /** @type {NoraEdge[]} */
  const edges = [];
  for (const node of nodes) {
    if (!node.parentId) continue;
    const key = `${node.parentId}\0${node.id}`;
    edges.push(byPair.get(key) || {
      id: noraEdgeId(node.parentId, node.id),
      fromNodeId: node.parentId,
      toNodeId: node.id,
      kind: "branch",
      createdAt: node.createdAt,
      extensions: {},
    });
  }
  for (const edge of previous) {
    const key = `${edge.fromNodeId}\0${edge.toNodeId}`;
    if (!byPair.has(key) || edges.some((entry) => entry.fromNodeId === edge.fromNodeId && entry.toNodeId === edge.toNodeId)) continue;
    edges.push(edge);
  }
  return edges;
}

/** @param {Partial<SourceRecord> & Record<string, any>} source @param {number} index @returns {SourceRecord} */
function toPersistedSource(source, index) {
  return {
    id: requireString(source.id, `sources[${index}].id`),
    type: requireString(source.type, `sources[${index}].type`),
    stableLocator: jsonValue(source.stableLocator ?? source.stable_locator, `sources[${index}].stableLocator`),
    title: String(source.title ?? ""),
    revision: optionalString(source.revision, `sources[${index}].revision`),
    commit: optionalString(source.commit, `sources[${index}].commit`),
    capturedAt: nullableTimestamp(source.capturedAt ?? source.captured_at, `sources[${index}].capturedAt`),
    extensions: jsonObject(source.extensions ?? {}, `sources[${index}].extensions`),
  };
}

/** @param {Partial<EvidenceRecord> & Record<string, any>} evidence @param {number} index @returns {EvidenceRecord} */
function toPersistedEvidence(evidence, index) {
  return {
    id: requireString(evidence.id, `evidence[${index}].id`),
    sourceId: nullableString(evidence.sourceId ?? evidence.source_id, `evidence[${index}].sourceId`),
    sourceType: requireString(evidence.sourceType ?? evidence.source_type, `evidence[${index}].sourceType`),
    stableLocator: jsonValue(evidence.stableLocator ?? evidence.stable_locator, `evidence[${index}].stableLocator`),
    title: String(evidence.title ?? ""),
    excerpt: String(evidence.excerpt ?? ""),
    revision: optionalString(evidence.revision, `evidence[${index}].revision`),
    commit: optionalString(evidence.commit, `evidence[${index}].commit`),
    permalink: optionalString(evidence.permalink, `evidence[${index}].permalink`),
    capturedAt: requireString(evidence.capturedAt ?? evidence.captured_at, `evidence[${index}].capturedAt`),
    range: evidence.range == null ? null : jsonValue(evidence.range, `evidence[${index}].range`),
    extensions: jsonObject(evidence.extensions ?? {}, `evidence[${index}].extensions`),
  };
}

/** @param {Partial<NoraAttachment> & Record<string, any>} attachment @param {number} index @returns {NoraAttachment} */
function toPersistedAttachment(attachment, index) {
  const sha256 = requireString(attachment.sha256, `attachments[${index}].sha256`).toLowerCase();
  if (!HEX_SHA256_RE.test(sha256)) throw new Error(`attachments[${index}].sha256 must be a lowercase SHA-256 digest`);
  return {
    id: String(attachment.id || sha256),
    sha256,
    mediaType: requireString(attachment.mediaType ?? attachment.media_type, `attachments[${index}].mediaType`),
    title: String(attachment.title ?? ""),
    filename: nullableString(attachment.filename, `attachments[${index}].filename`),
    bytes: requireSafeInteger(attachment.bytes, `attachments[${index}].bytes`),
    sourceId: nullableString(attachment.sourceId ?? attachment.source_id, `attachments[${index}].sourceId`),
    evidenceIds: stringArray(attachment.evidenceIds ?? attachment.evidence_ids, `attachments[${index}].evidenceIds`),
    createdAt: nullableTimestamp(attachment.createdAt ?? attachment.created_at, `attachments[${index}].createdAt`),
    extensions: jsonObject(attachment.extensions ?? {}, `attachments[${index}].extensions`),
  };
}

/** @param {Partial<AgentRunSummary> & Record<string, any>} run @param {number} index @returns {AgentRunSummary} */
function toPersistedRun(run, index) {
  const status = normalizeNoraNodeState(run.status ?? "pending", `runs[${index}].status`);
  return {
    id: requireString(run.id, `runs[${index}].id`),
    parentRunId: nullableString(run.parentRunId ?? run.parent_run_id, `runs[${index}].parentRunId`),
    targetNodeId: nullableString(run.targetNodeId ?? run.target_node_id, `runs[${index}].targetNodeId`),
    status,
    prompt: String(run.prompt ?? ""),
    profileId: nullableString(run.profileId ?? run.profile_id, `runs[${index}].profileId`),
    provider: nullableString(run.provider, `runs[${index}].provider`),
    model: nullableString(run.model, `runs[${index}].model`),
    endpoint: nullableString(run.endpoint, `runs[${index}].endpoint`),
    startedAt: nullableTimestamp(run.startedAt ?? run.started_at, `runs[${index}].startedAt`),
    endedAt: nullableTimestamp(run.endedAt ?? run.ended_at, `runs[${index}].endedAt`),
    error: run.error == null ? null : jsonValue(run.error, `runs[${index}].error`),
    transcriptPath: nullableString(run.transcriptPath ?? run.transcript_path, `runs[${index}].transcriptPath`),
    extensions: jsonObject(run.extensions ?? {}, `runs[${index}].extensions`),
  };
}

/** @param {any} check @param {number} index */
function toPersistedCheck(check, index) {
  return {
    id: requireString(check.id, `checks[${index}].id`),
    nodeId: requireString(check.nodeId ?? check.node_id, `checks[${index}].nodeId`),
    blockId: requireString(check.blockId ?? check.block_id, `checks[${index}].blockId`),
    state: jsonValue(check.state ?? {}, `checks[${index}].state`),
    createdAt: nullableTimestamp(check.createdAt ?? check.created_at, `checks[${index}].createdAt`),
    updatedAt: nullableTimestamp(check.updatedAt ?? check.updated_at, `checks[${index}].updatedAt`),
    extensions: jsonObject(check.extensions ?? {}, `checks[${index}].extensions`),
  };
}

/** @param {unknown} raw @param {{ updatedAt?: string | null }} [options] @returns {NoraDocument} */
export function toPersistedNoraDocument(raw, { updatedAt = undefined } = {}) {
  const input = requireRecord(raw ?? {}, "Nora document");
  const nodes = valuesOf(input.nodes).map((node, index) => toPersistedNode(/** @type {any} */ (node), index));
  const rawEdges = input.edges == null ? null : valuesOf(input.edges);
  /** @type {NoraDocument} */
  const document = {
    schemaVersion: NORA_DOCUMENT_SCHEMA_VERSION,
    documentId: requireString(input.documentId ?? input.hole_id ?? input.id, "documentId"),
    title: String(input.title ?? "Untitled"),
    rootNodeId: requireString(input.rootNodeId ?? input.root_id, "rootNodeId"),
    createdAt: nullableTimestamp(input.createdAt ?? input.created_at, "createdAt"),
    updatedAt: updatedAt === undefined
      ? nullableTimestamp(input.updatedAt ?? input.updated_at, "updatedAt")
      : nullableTimestamp(updatedAt, "updatedAt"),
    viewState: normalizeViewState(input.viewState ?? input.view_state),
    selection: input.selection == null ? null : jsonValue(input.selection, "selection"),
    selectedProfileId: nullableString(input.selectedProfileId ?? input.selected_profile_id, "selectedProfileId"),
    nodes,
    edges: normalizeEdges(nodes, rawEdges),
    sources: valuesOf(input.sources).map((source, index) => toPersistedSource(/** @type {any} */ (source), index)),
    evidence: valuesOf(input.evidence).map((evidence, index) => toPersistedEvidence(/** @type {any} */ (evidence), index)),
    attachments: valuesOf(input.attachments).map((attachment, index) => toPersistedAttachment(/** @type {any} */ (attachment), index)),
    runs: valuesOf(input.runs).map((run, index) => toPersistedRun(/** @type {any} */ (run), index)),
    checks: valuesOf(input.checks).map((check, index) => toPersistedCheck(check, index)),
    extensions: jsonObject(input.extensions ?? {}, "extensions"),
  };
  validateNoraDocument(document);
  return document;
}

/** @param {unknown} raw @returns {NoraDocument} */
export function parseNoraDocument(raw) {
  const copy = cloneJson(raw);
  validateNoraDocument(copy);
  return /** @type {NoraDocument} */ (copy);
}

/** @param {unknown} raw @returns {raw is NoraDocument} */
export function validateNoraDocument(raw) {
  const document = requireRecord(raw, "Nora document");
  if (Number(document.schemaVersion) > NORA_DOCUMENT_SCHEMA_VERSION) throw new Error(NEWER_NORA_DOCUMENT_MESSAGE);
  if (document.schemaVersion !== NORA_DOCUMENT_SCHEMA_VERSION) {
    throw new Error(`Nora document must have schemaVersion ${NORA_DOCUMENT_SCHEMA_VERSION}`);
  }
  requireString(document.documentId, "documentId");
  if (typeof document.title !== "string") throw new Error("title must be a string");
  requireString(document.rootNodeId, "rootNodeId");
  nullableTimestamp(document.createdAt, "createdAt");
  nullableTimestamp(document.updatedAt, "updatedAt");
  if (document.viewState !== null) normalizeViewState(document.viewState);
  if (document.selection !== null) assertJsonValue(document.selection, "selection");
  nullableString(document.selectedProfileId, "selectedProfileId");
  jsonObject(document.extensions, "extensions");

  validateArray(document.nodes, "nodes");
  validateArray(document.edges, "edges");
  validateArray(document.sources, "sources");
  validateArray(document.evidence, "evidence");
  validateArray(document.attachments, "attachments");
  validateArray(document.runs, "runs");
  validateArray(document.checks, "checks");

  const nodeIds = uniqueIds(document.nodes, "nodes");
  if (!nodeIds.has(document.rootNodeId)) throw new Error("rootNodeId must reference an existing node");
  for (const [index, node] of document.nodes.entries()) validateNode(node, index, nodeIds);
  validateNoCycles(document.nodes);

  const edgeIds = uniqueIds(document.edges, "edges");
  for (const [index, edge] of document.edges.entries()) validateEdge(edge, index, nodeIds, edgeIds);
  const sourceIds = uniqueIds(document.sources, "sources");
  for (const [index, source] of document.sources.entries()) validateSource(source, index);
  const evidenceIds = uniqueIds(document.evidence, "evidence");
  for (const [index, evidence] of document.evidence.entries()) validateEvidence(evidence, index, sourceIds);
  uniqueIds(document.attachments, "attachments");
  for (const [index, attachment] of document.attachments.entries()) validateAttachment(attachment, index, sourceIds, evidenceIds);
  uniqueIds(document.runs, "runs");
  for (const [index, run] of document.runs.entries()) validateRun(run, index, nodeIds);
  uniqueIds(document.checks, "checks");
  for (const [index, check] of document.checks.entries()) validateCheck(check, index, nodeIds);
  for (const [index, node] of document.nodes.entries()) validateNodeReferences(node, index, sourceIds, evidenceIds);
  return true;
}

/** @param {unknown} value @param {string} path */
function validateArray(value, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
}

/** @param {any[]} entries @param {string} path */
function uniqueIds(entries, path) {
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    const id = requireString(entry?.id, `${path}[${index}].id`);
    if (ids.has(id)) throw new Error(`${path} id ${id} is duplicated`);
    ids.add(id);
  }
  return ids;
}

/** @param {any} node @param {number} index @param {Set<string>} nodeIds */
function validateNode(node, index, nodeIds) {
  requireString(node.id, `nodes[${index}].id`);
  if (node.parentId !== null && !nodeIds.has(node.parentId)) throw new Error(`nodes[${index}].parentId must reference an existing node`);
  if (typeof node.title !== "string") throw new Error(`nodes[${index}].title must be a string`);
  if (typeof node.markdown !== "string") throw new Error(`nodes[${index}].markdown must be a string`);
  normalizeStoredBaseUrlFields({ base_url: node.baseUrl, base_url_source: node.baseUrlSource });
  if (node.origin !== null) assertJsonValue(node.origin, `nodes[${index}].origin`);
  normalizePosition(node.position);
  normalizeSize(node.size);
  if (!Number.isFinite(node.fontScale)) throw new Error(`nodes[${index}].fontScale must be finite`);
  if (typeof node.collapsed !== "boolean") throw new Error(`nodes[${index}].collapsed must be a boolean`);
  normalizeNoraNodeState(node.state, `nodes[${index}].state`);
  if (typeof node.read !== "boolean") throw new Error(`nodes[${index}].read must be a boolean`);
  nullableTimestamp(node.createdAt, `nodes[${index}].createdAt`);
  nullableTimestamp(node.updatedAt, `nodes[${index}].updatedAt`);
  stringArray(node.sourceIds, `nodes[${index}].sourceIds`);
  stringArray(node.evidenceIds, `nodes[${index}].evidenceIds`);
  stringArray(node.attachmentIds, `nodes[${index}].attachmentIds`);
  nullableString(node.runId, `nodes[${index}].runId`);
  jsonObject(node.extensions, `nodes[${index}].extensions`);
}

/** @param {any} node @param {number} index @param {Set<string>} sourceIds @param {Set<string>} evidenceIds */
function validateNodeReferences(node, index, sourceIds, evidenceIds) {
  for (const sourceId of node.sourceIds) {
    if (!sourceIds.has(sourceId)) throw new Error(`nodes[${index}].sourceIds references missing source ${sourceId}`);
  }
  for (const evidenceId of node.evidenceIds) {
    if (!evidenceIds.has(evidenceId)) throw new Error(`nodes[${index}].evidenceIds references missing evidence ${evidenceId}`);
  }
}

/** @param {any[]} nodes */
function validateNoCycles(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const seen = new Set();
    let current = node;
    while (current?.parentId) {
      if (seen.has(current.id)) throw new Error(`node ${node.id} parent chain must not contain a cycle`);
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
  }
}

/** @param {any} edge @param {number} index @param {Set<string>} nodeIds @param {Set<string>} _edgeIds */
function validateEdge(edge, index, nodeIds, _edgeIds) {
  requireString(edge.fromNodeId, `edges[${index}].fromNodeId`);
  requireString(edge.toNodeId, `edges[${index}].toNodeId`);
  if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) throw new Error(`edges[${index}] must reference existing nodes`);
  if (typeof edge.kind !== "string" || !edge.kind) throw new Error(`edges[${index}].kind must be a non-empty string`);
  nullableTimestamp(edge.createdAt, `edges[${index}].createdAt`);
  jsonObject(edge.extensions, `edges[${index}].extensions`);
}

/** @param {any} source @param {number} index */
function validateSource(source, index) {
  requireString(source.type, `sources[${index}].type`);
  assertJsonValue(source.stableLocator, `sources[${index}].stableLocator`);
  if (typeof source.title !== "string") throw new Error(`sources[${index}].title must be a string`);
  optionalString(source.revision, `sources[${index}].revision`);
  optionalString(source.commit, `sources[${index}].commit`);
  nullableTimestamp(source.capturedAt, `sources[${index}].capturedAt`);
  jsonObject(source.extensions, `sources[${index}].extensions`);
}

/** @param {any} evidence @param {number} index @param {Set<string>} sourceIds */
function validateEvidence(evidence, index, sourceIds) {
  if (evidence.sourceId !== null && !sourceIds.has(evidence.sourceId)) throw new Error(`evidence[${index}].sourceId must reference an existing source`);
  requireString(evidence.sourceType, `evidence[${index}].sourceType`);
  assertJsonValue(evidence.stableLocator, `evidence[${index}].stableLocator`);
  if (typeof evidence.title !== "string") throw new Error(`evidence[${index}].title must be a string`);
  if (typeof evidence.excerpt !== "string") throw new Error(`evidence[${index}].excerpt must be a string`);
  optionalString(evidence.revision, `evidence[${index}].revision`);
  optionalString(evidence.commit, `evidence[${index}].commit`);
  optionalString(evidence.permalink, `evidence[${index}].permalink`);
  requireString(evidence.capturedAt, `evidence[${index}].capturedAt`);
  if (evidence.range !== null) assertJsonValue(evidence.range, `evidence[${index}].range`);
  jsonObject(evidence.extensions, `evidence[${index}].extensions`);
}

/** @param {any} attachment @param {number} index @param {Set<string>} sourceIds @param {Set<string>} evidenceIds */
function validateAttachment(attachment, index, sourceIds, evidenceIds) {
  if (!HEX_SHA256_RE.test(attachment.sha256)) throw new Error(`attachments[${index}].sha256 must be a lowercase SHA-256 digest`);
  requireString(attachment.mediaType, `attachments[${index}].mediaType`);
  if (typeof attachment.title !== "string") throw new Error(`attachments[${index}].title must be a string`);
  nullableString(attachment.filename, `attachments[${index}].filename`);
  requireSafeInteger(attachment.bytes, `attachments[${index}].bytes`);
  if (attachment.sourceId !== null && !sourceIds.has(attachment.sourceId)) throw new Error(`attachments[${index}].sourceId must reference an existing source`);
  for (const evidenceId of attachment.evidenceIds) {
    if (!evidenceIds.has(evidenceId)) throw new Error(`attachments[${index}].evidenceIds references missing evidence ${evidenceId}`);
  }
  nullableTimestamp(attachment.createdAt, `attachments[${index}].createdAt`);
  jsonObject(attachment.extensions, `attachments[${index}].extensions`);
}

/** @param {any} run @param {number} index @param {Set<string>} nodeIds */
function validateRun(run, index, nodeIds) {
  nullableString(run.parentRunId, `runs[${index}].parentRunId`);
  if (run.targetNodeId !== null && !nodeIds.has(run.targetNodeId)) throw new Error(`runs[${index}].targetNodeId must reference an existing node`);
  normalizeNoraNodeState(run.status, `runs[${index}].status`);
  if (typeof run.prompt !== "string") throw new Error(`runs[${index}].prompt must be a string`);
  nullableString(run.profileId, `runs[${index}].profileId`);
  nullableString(run.provider, `runs[${index}].provider`);
  nullableString(run.model, `runs[${index}].model`);
  nullableString(run.endpoint, `runs[${index}].endpoint`);
  nullableTimestamp(run.startedAt, `runs[${index}].startedAt`);
  nullableTimestamp(run.endedAt, `runs[${index}].endedAt`);
  if (run.error !== null) assertJsonValue(run.error, `runs[${index}].error`);
  nullableString(run.transcriptPath, `runs[${index}].transcriptPath`);
  jsonObject(run.extensions, `runs[${index}].extensions`);
}

/** @param {any} check @param {number} index @param {Set<string>} nodeIds */
function validateCheck(check, index, nodeIds) {
  if (!nodeIds.has(check.nodeId)) throw new Error(`checks[${index}].nodeId must reference an existing node`);
  requireString(check.blockId, `checks[${index}].blockId`);
  assertJsonValue(check.state, `checks[${index}].state`);
  nullableTimestamp(check.createdAt, `checks[${index}].createdAt`);
  nullableTimestamp(check.updatedAt, `checks[${index}].updatedAt`);
  jsonObject(check.extensions, `checks[${index}].extensions`);
}
