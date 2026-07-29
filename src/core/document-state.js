import { maybeUpgradeBaseUrlFromFrontmatter, normalizeBaseUrl, normalizeStoredBaseUrlFields } from "./base-url.js";
import { normalizeBlockIds } from "./blocks.js";
import {
  applyNodeUpdateFields,
  collectSubtreeIds,
  createPendingBranchNode,
  normalizePosition,
  normalizeSize,
  normalizeViewState,
} from "./model.js";
import {
  noraStateToRendererStatus,
  normalizeNoraNodeState,
  parseNoraDocument,
  toPersistedNoraDocument,
  validateNoraDocument,
} from "./document-schema.js";
import { cloneJson } from "./utils.js";

/** @typedef {import("./contracts/document.js").NoraDocument} NoraDocument */
/** @typedef {import("./contracts/document.js").NoraDocumentState} NoraDocumentState */
/** @typedef {import("./contracts/document.js").NoraNode} NoraNode */
/** @typedef {import("./contracts/document.js").NoraEdge} NoraEdge */
/** @typedef {import("./contracts/document.js").NoraDocumentEvent} NoraDocumentEvent */
/** @typedef {{ id: string, parent_id: string | null, title: string, markdown: string, base_url: string | null, base_url_source: import("./contracts/document.js").BaseUrlSource | null, origin: unknown | null, position: import("./contracts/document.js").Position, size: import("./contracts/document.js").NodeSize | null, font_scale: number, collapsed: boolean, status: "pending" | "answered", read: boolean, created_at: string | null, extensions: Record<string, unknown> }} RendererNode */

/** @param {unknown} raw @returns {NoraDocumentState} */
export function createDocumentState(raw = {}) {
  const input = /** @type {Record<string, any>} */ (raw ?? {});
  const persisted = input.schemaVersion != null
    ? parseNoraDocument(input)
    : toPersistedNoraDocument(input);
  return stateFromPersisted(persisted, Number(input.revision) || 0);
}

/** @param {NoraDocument} persisted @param {number} revision @returns {NoraDocumentState} */
function stateFromPersisted(persisted, revision) {
  validateNoraDocument(persisted);
  return {
    schemaVersion: persisted.schemaVersion,
    documentId: persisted.documentId,
    title: persisted.title,
    rootNodeId: persisted.rootNodeId,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
    viewState: persisted.viewState,
    selection: cloneJson(persisted.selection),
    selectedProfileId: persisted.selectedProfileId,
    nodes: new Map(persisted.nodes.map((node) => [node.id, cloneJson(node)])),
    edges: new Map(persisted.edges.map((edge) => [edge.id, cloneJson(edge)])),
    sources: new Map(persisted.sources.map((source) => [source.id, cloneJson(source)])),
    evidence: new Map(persisted.evidence.map((record) => [record.id, cloneJson(record)])),
    attachments: new Map(persisted.attachments.map((attachment) => [attachment.id, cloneJson(attachment)])),
    runs: new Map(persisted.runs.map((run) => [run.id, cloneJson(run)])),
    checks: new Map(persisted.checks.map((check) => [check.id, cloneJson(check)])),
    extensions: cloneJson(persisted.extensions),
    revision,
    progressRuns: new Map(),
  };
}

/** @param {NoraDocumentState} state @returns {NoraDocument} */
export function documentStateToPersisted(state) {
  return toPersistedNoraDocument({
    schemaVersion: state.schemaVersion,
    documentId: state.documentId,
    title: state.title,
    rootNodeId: state.rootNodeId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    viewState: state.viewState,
    selection: state.selection,
    selectedProfileId: state.selectedProfileId,
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
    sources: [...state.sources.values()],
    evidence: [...state.evidence.values()],
    attachments: [...state.attachments.values()],
    runs: [...state.runs.values()],
    checks: [...state.checks.values()],
    extensions: state.extensions,
  });
}

/**
 * Canonical Nora projection for the existing renderer hydration wire.
 * @param {NoraDocumentState} state
 */
export function documentStateToHydrationNodes(state) {
  return [...state.nodes.values()].map((node) => ({
    id: node.id,
    parent_id: node.parentId,
    title: node.title,
    markdown: node.markdown,
    base_url: node.baseUrl,
    base_url_source: node.baseUrlSource,
    origin: cloneJson(node.origin),
    position: cloneJson(node.position),
    size: cloneJson(node.size),
    font_scale: node.fontScale,
    collapsed: node.collapsed,
    status: noraStateToRendererStatus(node.state),
    read: node.read,
    extensions: cloneJson(node.extensions),
    nora_state: node.state,
    run_id: node.runId,
    source_ids: [...node.sourceIds],
    evidence_ids: [...node.evidenceIds],
    attachment_ids: [...node.attachmentIds],
  }));
}

/**
 * @param {NoraDocumentState} state
 * @param {NoraDocumentEvent | Record<string, any>} event
 * @param {{ now?: string, idFactory?: () => string, mutate?: boolean }} [options]
 */
export function reduceDocumentEvent(state, event, options = {}) {
  const type = String(/** @type {{ type?: unknown }} */ (event)?.type ?? "");
  switch (type) {
    case "document_title":
    case "hole_title":
      return commitCandidate(state, { ...state, title: String(/** @type {any} */ (event).title ?? state.title) });
    case "selected_profile":
      return commitCandidate(state, { ...state, selectedProfileId: nullableString(/** @type {any} */ (event).profile_id ?? /** @type {any} */ (event).profileId) });
    case "node_state":
      return reduceNodeState(state, /** @type {any} */ (event));
    case "node_run":
      return reduceNodeRun(state, /** @type {any} */ (event));
    case "source_record":
      return upsertCollection(state, "sources", /** @type {any} */ (event).source, "source_id");
    case "evidence_record":
      return upsertCollection(state, "evidence", /** @type {any} */ (event).evidence, "evidence_id");
    case "attachment_record":
      return upsertCollection(state, "attachments", /** @type {any} */ (event).attachment, "attachment_id");
    case "run_summary":
      return upsertCollection(state, "runs", /** @type {any} */ (event).run, "run_id");
    case "check_record":
      return upsertCollection(state, "checks", /** @type {any} */ (event).check, "check_id");
    case "node_references":
      return reduceNodeReferences(state, /** @type {any} */ (event));
    default:
      return reduceRendererEvent(state, /** @type {Record<string, any>} */ (event), options);
  }
}

/** @param {unknown} value */
function nullableString(value) {
  if (value == null) return null;
  return String(value);
}

/** @param {NoraDocumentState} state @param {any} event */
function reduceNodeRun(state, event) {
  const nodeId = String(event.node_id ?? event.nodeId ?? "");
  const node = state.nodes.get(nodeId);
  if (!node) return { state, effects: {} };
  const runId = nullableString(event.run_id ?? event.runId);
  if (runId && !state.runs.has(runId)) throw new Error(`node_run run ${runId} is not present in the document`);
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, {
    ...node,
    runId,
    updatedAt: event.updated_at ?? event.updatedAt ?? node.updatedAt,
  });
  return commitCandidate(state, { ...state, nodes }, { node_id: nodeId, run_id: runId });
}

/** @param {NoraDocumentState} state @param {any} event */
function reduceNodeState(state, event) {
  const nodeId = String(event.node_id ?? event.nodeId ?? "");
  const node = state.nodes.get(nodeId);
  if (!node) return { state, effects: {} };
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, {
    ...node,
    state: normalizeNoraNodeState(event.state, "node_state.state"),
    updatedAt: event.updated_at ?? event.updatedAt ?? node.updatedAt,
  });
  return commitCandidate(state, { ...state, nodes }, { node_id: nodeId });
}

/**
 * @param {NoraDocumentState} state
 * @param {"sources" | "evidence" | "attachments" | "runs" | "checks"} key
 * @param {unknown} value
 * @param {string} effectKey
 */
function upsertCollection(state, key, value, effectKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} event payload must be an object`);
  const id = String(/** @type {{ id?: unknown }} */ (value).id ?? "");
  if (!id) throw new Error(`${key} event payload id is required`);
  const collection = new Map(/** @type {Map<string, any>} */ (state[key]));
  collection.set(id, cloneJson(value));
  return commitCandidate(state, { ...state, [key]: collection }, { [effectKey]: id });
}

/** @param {NoraDocumentState} state @param {any} event */
function reduceNodeReferences(state, event) {
  const nodeId = String(event.node_id ?? event.nodeId ?? "");
  const node = state.nodes.get(nodeId);
  if (!node) return { state, effects: {} };
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, {
    ...node,
    sourceIds: mergeStringList(node.sourceIds, event.source_ids ?? event.sourceIds, "source"),
    evidenceIds: mergeStringList(node.evidenceIds, event.evidence_ids ?? event.evidenceIds, "evidence"),
    attachmentIds: mergeStringList(node.attachmentIds, event.attachment_ids ?? event.attachmentIds, "attachment"),
    updatedAt: event.updated_at ?? event.updatedAt ?? node.updatedAt,
  });
  return commitCandidate(state, { ...state, nodes }, { node_id: nodeId });
}

/** @param {string[]} current @param {unknown} added @param {string} label */
function mergeStringList(current, added, label) {
  if (added == null) return [...current];
  if (!Array.isArray(added)) throw new Error(`node_references ${label} ids must be an array`);
  const next = new Set(current);
  for (const value of added) {
    const id = String(value ?? "");
    if (!id) throw new Error(`node_references ${label} id must be non-empty`);
    next.add(id);
  }
  return [...next];
}

/**
 * @param {NoraDocumentState} state
 * @param {Record<string, any>} event
 * @param {{ now?: string, idFactory?: () => string, mutate?: boolean }} options
 */
function reduceRendererEvent(state, event, options) {
  const type = String(event?.type ?? "");
  switch (type) {
    case "branch_request":
      return reduceBranchRequest(state, event, options);
    case "node_progress":
      return reduceNodeProgress(state, event);
    case "node_answered":
      return reduceNodeAnswered(state, event, options);
    case "delete_node":
    case "node_deleted":
      return reduceNodeDeleted(state, event);
    case "node_update":
      return reduceNodeUpdate(state, event);
    case "nodes_update":
      return reduceNodesUpdate(state, event);
    case "view_state":
      return commitCandidate(state, { ...state, viewState: normalizeViewState(event.state) });
    case "node_origin":
      return reduceNodeOrigin(state, event);
    case "node_extensions_patch":
      return reduceNodeExtensionsPatch(state, event);
    case "block_state":
      return reduceBlockState(state, event);
    default:
      throw new Error(`Unsupported hole event: ${type}`);
  }
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event @param {{ now?: string }} options */
function reduceBranchRequest(state, event, options) {
  const parentId = String(event.parent_id || "");
  const parent = state.nodes.get(parentId);
  if (!parent) throw new Error(`Parent node ${parentId} not found`);
  const rendererNode = /** @type {RendererNode} */ (createPendingBranchNode(event, rendererNodeFromNora(parent), options));
  if (!rendererNode.id) throw new Error("Branch request node_id is required");
  const nodes = new Map(state.nodes);
  nodes.set(rendererNode.id, noraNodeFromRenderer(undefined, rendererNode, event));
  return commitCandidate(state, { ...state, nodes, edges: rebuildEdges(state.edges, nodes) }, { createdNode: rendererNode });
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event */
function reduceNodeProgress(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return { state, effects: {} };
  const run = event.run;
  const tagged = run && typeof run.id === "string" && typeof run.seq === "number";
  const recorded = tagged ? state.progressRuns.get(nodeId) : null;
  if (recorded && recorded.id === run.id && run.seq <= recorded.seq) return { state, effects: {} };
  if (recorded?.superseded?.has(run.id)) return { state, effects: {} };

  const base = noraBaseFields(event.base_url ?? node.baseUrl, event.base_url_source ?? node.baseUrlSource);
  const nextNode = /** @type {NoraNode} */ ({
    ...node,
    markdown: String(event.markdown ?? node.markdown ?? ""),
    baseUrl: base.baseUrl,
    baseUrlSource: base.baseUrlSource,
    state: node.state === "pending" || node.state === "running" ? "running" : node.state,
  });
  const superseded = recorded && recorded.id !== run.id
    ? new Set([...(recorded.superseded || []), recorded.id])
    : recorded?.superseded;
  const progressRuns = tagged
    ? new Map(state.progressRuns).set(nodeId, { id: run.id, seq: run.seq, ...(superseded ? { superseded } : {}) })
    : state.progressRuns;
  return commitProgressCandidate(state, nodeId, nextNode, progressRuns, { node_id: nodeId });
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event @param {{ idFactory?: () => string }} options */
function reduceNodeAnswered(state, event, options) {
  const nodeId = String(event.node_id || "");
  const prior = state.nodes.get(nodeId);
  const current = prior ? rendererNodeFromNora(prior) : {
    id: nodeId,
    parent_id: event.parent_id ?? null,
    title: "",
    markdown: "",
    base_url: null,
    base_url_source: null,
    origin: event.origin ?? null,
    position: event.position ?? { x: 0, y: 0 },
    size: event.size ?? null,
    font_scale: event.font_scale ?? 1,
    collapsed: !!event.collapsed,
    status: "pending",
    read: false,
    created_at: event.created_at ?? null,
    extensions: {},
  };
  const rendererNode = /** @type {RendererNode} */ ({
    ...current,
    parent_id: event.parent_id ?? current.parent_id ?? null,
    title: String(event.title ?? current.title ?? "Untitled").trim() || "Untitled",
    markdown: normalizeBlockIds(String(event.markdown ?? current.markdown ?? ""), { idFactory: options.idFactory }).markdown,
    base_url: event.base_url ?? current.base_url ?? null,
    base_url_source: event.base_url_source ?? current.base_url_source ?? null,
    origin: event.origin ?? current.origin ?? null,
    position: event.position ?? current.position ?? { x: 0, y: 0 },
    size: event.size ?? current.size ?? null,
    font_scale: event.font_scale ?? current.font_scale ?? 1,
    collapsed: event.collapsed ?? current.collapsed ?? false,
    status: "answered",
    read: event.read ?? false,
  });
  const base = normalizeStoredBaseUrlFields(rendererNode);
  rendererNode.base_url = base.base_url;
  rendererNode.base_url_source = base.base_url_source;
  if (!rendererNode.base_url && (event.base_url ?? current.base_url) != null) {
    try {
      rendererNode.base_url = normalizeBaseUrl(event.base_url ?? current.base_url);
      rendererNode.base_url_source = null;
    } catch {}
  }
  maybeUpgradeBaseUrlFromFrontmatter(rendererNode);
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, noraNodeFromRenderer(prior, rendererNode, event));
  let progressRuns = state.progressRuns;
  if (progressRuns.has(nodeId)) {
    progressRuns = new Map(progressRuns);
    progressRuns.delete(nodeId);
  }
  return commitCandidate(state, { ...state, nodes, edges: rebuildEdges(state.edges, nodes), progressRuns }, { answeredNode: rendererNode });
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event */
function reduceNodeDeleted(state, event) {
  const ids = Array.isArray(event.node_ids) && event.node_ids.length
    ? event.node_ids.map(String)
    : collectSubtreeIds(state.nodes, String(event.node_id || ""));
  if (!ids.length) return { state, effects: { deletedNodeIds: [], deletedNodes: [] } };
  if (ids.includes(state.rootNodeId)) throw new Error("The starting document can't be removed");
  const nodes = new Map(state.nodes);
  const deletedNodes = [];
  for (const id of ids) {
    const node = nodes.get(id);
    if (node) deletedNodes.push(rendererNodeFromNora(node));
    nodes.delete(id);
  }
  let progressRuns = state.progressRuns;
  if (ids.some((id) => progressRuns.has(id))) {
    progressRuns = new Map(progressRuns);
    for (const id of ids) progressRuns.delete(id);
  }
  const deletedIds = new Set(ids);
  const runs = new Map(state.runs);
  for (const [runId, run] of runs) {
    if (run.targetNodeId && deletedIds.has(run.targetNodeId)) {
      runs.set(runId, { ...run, targetNodeId: null });
    }
  }
  let checks = state.checks;
  if ([...checks.values()].some((check) => deletedIds.has(check.nodeId))) {
    checks = new Map([...checks].filter(([, check]) => !deletedIds.has(check.nodeId)));
  }
  return commitCandidate(state, { ...state, nodes, edges: rebuildEdges(state.edges, nodes), runs, checks, progressRuns }, { deletedNodeIds: ids, deletedNodes });
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event */
function reduceNodeUpdate(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return { state, effects: {} };
  const rendererNode = /** @type {RendererNode} */ (applyNodeUpdateFields(rendererNodeFromNora(node), event));
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, noraNodeFromRenderer(node, rendererNode, event));
  return commitCandidate(state, { ...state, nodes }, { node_id: nodeId });
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event */
function reduceNodesUpdate(state, event) {
  const updates = Array.isArray(event.nodes) ? event.nodes : [];
  let nodes = null;
  for (const update of updates) {
    const nodeId = String(update?.node_id || "");
    const node = state.nodes.get(nodeId);
    if (!node) continue;
    if (!nodes) nodes = new Map(state.nodes);
    nodes.set(nodeId, noraNodeFromRenderer(node, /** @type {RendererNode} */ (applyNodeUpdateFields(rendererNodeFromNora(node), update)), update));
  }
  return nodes ? commitCandidate(state, { ...state, nodes }) : { state, effects: {} };
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event */
function reduceNodeOrigin(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return { state, effects: {} };
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, { ...node, origin: cloneJson(event.origin ?? null) });
  return commitCandidate(state, { ...state, nodes }, { node_id: nodeId });
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event */
function reduceNodeExtensionsPatch(state, event) {
  const nodeId = String(event.node_id || "");
  const namespace = String(event.namespace || "");
  const node = state.nodes.get(nodeId);
  if (!node || !/^[a-z][a-z0-9_-]*$/.test(namespace)) return { state, effects: {} };
  const extensions = cloneJson(node.extensions ?? {});
  extensions[namespace] = cloneJson(event.value);
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, { ...node, extensions });
  return commitCandidate(state, { ...state, nodes }, { node_id: nodeId });
}

/** @param {NoraDocumentState} state @param {Record<string, any>} event */
function reduceBlockState(state, event) {
  const nodeId = String(event.node_id || "");
  const blockId = String(event.block_id || "");
  const node = state.nodes.get(nodeId);
  if (!node || !blockId || !event.state || typeof event.state !== "object" || Array.isArray(event.state)) return { state, effects: {} };
  const extensions = cloneJson(node.extensions ?? {});
  const learn = extensions.learn && typeof extensions.learn === "object" && !Array.isArray(extensions.learn)
    ? /** @type {Record<string, any>} */ (extensions.learn)
    : {};
  const previous = learn[blockId] && typeof learn[blockId] === "object" && !Array.isArray(learn[blockId])
    ? learn[blockId]
    : {};
  extensions.learn = { ...learn, [blockId]: { ...previous, ...cloneJson(event.state) } };
  const nodes = new Map(state.nodes);
  nodes.set(nodeId, { ...node, extensions });
  return commitCandidate(state, { ...state, nodes }, { node_id: nodeId });
}

/** @param {NoraNode} node @returns {RendererNode} */
function rendererNodeFromNora(node) {
  return {
    id: node.id,
    parent_id: node.parentId,
    title: node.title,
    markdown: node.markdown,
    base_url: node.baseUrl,
    base_url_source: node.baseUrlSource,
    origin: cloneJson(node.origin),
    position: cloneJson(node.position),
    size: cloneJson(node.size),
    font_scale: node.fontScale,
    collapsed: node.collapsed,
    status: noraStateToRendererStatus(node.state),
    read: node.read,
    created_at: node.createdAt,
    extensions: cloneJson(node.extensions),
  };
}

/** @param {NoraNode | undefined} prior @param {RendererNode} node @param {Record<string, any>} event @returns {NoraNode} */
function noraNodeFromRenderer(prior, node, event) {
  const base = noraBaseFields(node.base_url, node.base_url_source);
  return {
    id: node.id,
    parentId: node.parent_id ?? null,
    title: String(node.title ?? ""),
    markdown: String(node.markdown ?? ""),
    baseUrl: base.baseUrl,
    baseUrlSource: base.baseUrlSource,
    origin: cloneJson(node.origin ?? null),
    position: normalizePosition(node.position),
    size: normalizeSize(node.size),
    fontScale: Number(node.font_scale) || 1,
    collapsed: !!node.collapsed,
    state: stateForRendererNode(prior, node, event),
    read: !!node.read,
    createdAt: node.created_at ?? null,
    updatedAt: prior?.updatedAt ?? null,
    sourceIds: prior ? [...prior.sourceIds] : [],
    evidenceIds: prior ? [...prior.evidenceIds] : [],
    attachmentIds: prior ? [...prior.attachmentIds] : [],
    runId: prior?.runId ?? null,
    extensions: cloneJson(node.extensions ?? {}),
  };
}

/** @param {unknown} rawBaseUrl @param {unknown} rawBaseUrlSource */
function noraBaseFields(rawBaseUrl, rawBaseUrlSource) {
  const base = normalizeStoredBaseUrlFields({ base_url: rawBaseUrl, base_url_source: rawBaseUrlSource });
  if (base.base_url) return { baseUrl: base.base_url, baseUrlSource: base.base_url_source };
  if (rawBaseUrl != null) {
    try {
      return { baseUrl: normalizeBaseUrl(rawBaseUrl), baseUrlSource: null };
    } catch {}
  }
  return { baseUrl: null, baseUrlSource: null };
}

/**
 * Streaming progress is already normalized above and only touches one node plus
 * the in-memory ordering ledger. Avoid whole-document validation for each chunk.
 * @param {NoraDocumentState} previous
 * @param {string} nodeId
 * @param {NoraNode} nextNode
 * @param {NoraDocumentState["progressRuns"]} progressRuns
 * @param {Record<string, any>} effects
 */
function commitProgressCandidate(previous, nodeId, nextNode, progressRuns, effects) {
  const prior = previous.nodes.get(nodeId);
  const changed = !prior
    || prior.markdown !== nextNode.markdown
    || prior.baseUrl !== nextNode.baseUrl
    || prior.baseUrlSource !== nextNode.baseUrlSource
    || prior.state !== nextNode.state;
  if (!changed) {
    if (progressRuns !== previous.progressRuns) return { state: { ...previous, progressRuns }, effects };
    return { state: previous, effects };
  }
  const nodes = new Map(previous.nodes);
  nodes.set(nodeId, nextNode);
  return {
    state: { ...previous, nodes, progressRuns, revision: previous.revision + 1 },
    effects,
  };
}

/** @param {NoraNode | undefined} prior @param {RendererNode} node @param {Record<string, any>} event */
function stateForRendererNode(prior, node, event) {
  const targetId = String(/** @type {any} */ (event).node_id ?? "");
  if (event.type === "node_answered" && targetId === node.id) return "complete";
  if (event.type === "node_progress" && targetId === node.id) {
    if (prior?.state === "pending" || prior?.state === "running") return "running";
    return prior?.state ?? "running";
  }
  if (event.type === "branch_request" && String(/** @type {any} */ (event).node_id ?? "") === node.id) return "pending";
  if (prior) return prior.state;
  return node.status === "pending" ? "pending" : "complete";
}

/** @param {Map<string, NoraEdge>} previousEdges @param {Map<string, NoraNode>} nodes */
function rebuildEdges(previousEdges, nodes) {
  const byPair = new Map([...previousEdges.values()].map((edge) => [`${edge.fromNodeId}\0${edge.toNodeId}`, edge]));
  const edges = new Map();
  for (const node of nodes.values()) {
    if (!node.parentId || !nodes.has(node.parentId)) continue;
    const key = `${node.parentId}\0${node.id}`;
    const edge = byPair.get(key) || {
      id: `edge:${node.parentId}:${node.id}`,
      fromNodeId: node.parentId,
      toNodeId: node.id,
      kind: "branch",
      createdAt: node.createdAt,
      extensions: {},
    };
    edges.set(edge.id, cloneJson(edge));
  }
  return edges;
}

/**
 * @param {NoraDocumentState} previous
 * @param {NoraDocumentState} candidate
 * @param {Record<string, any>} [effects]
 */
function commitCandidate(previous, candidate, effects = {}) {
  const previousPersisted = documentStateToPersisted(previous);
  const nextPersisted = documentStateToPersisted(candidate);
  validateNoraDocument(nextPersisted);
  if (JSON.stringify(previousPersisted) === JSON.stringify(nextPersisted)) {
    if (candidate.progressRuns && candidate.progressRuns !== previous.progressRuns) {
      return { state: { ...previous, progressRuns: candidate.progressRuns }, effects };
    }
    return { state: previous, effects };
  }
  const nextState = stateFromPersisted(nextPersisted, previous.revision + 1);
  nextState.progressRuns = candidate.progressRuns || previous.progressRuns;
  return {
    state: nextState,
    effects,
  };
}
