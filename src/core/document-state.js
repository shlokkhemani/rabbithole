import { maybeUpgradeBaseUrlFromFrontmatter, normalizeBaseUrl, normalizeStoredBaseUrlFields } from "./base-url.js";
import { normalizeViewState } from "./model.js";
import {
  createHoleState,
  holeStateToHole,
  reduceHoleEvent,
} from "./reducer.js";
import {
  noraStateToRendererStatus,
  normalizeNoraNodeState,
  parseNoraDocument,
  toPersistedNoraDocument,
  validateNoraDocument,
} from "./document-schema.js";
import { cloneJson } from "./schema.js";

/** @typedef {import("./contracts/document.js").NoraDocument} NoraDocument */
/** @typedef {import("./contracts/document.js").NoraDocumentState} NoraDocumentState */
/** @typedef {import("./contracts/document.js").NoraNode} NoraNode */
/** @typedef {import("./contracts/document.js").NoraEdge} NoraEdge */
/** @typedef {import("./contracts/engine.js").DocEvent} LegacyDocEvent */
/** @typedef {import("./contracts/document.js").NoraDocumentEvent} NoraDocumentEvent */

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
 * @param {NoraDocumentEvent | LegacyDocEvent} event
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
    default:
      return reduceWithLegacyReducer(state, /** @type {LegacyDocEvent} */ (event), options);
  }
}

/** @param {unknown} value */
function nullableString(value) {
  if (value == null) return null;
  return String(value);
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

/**
 * @param {NoraDocumentState} state
 * @param {LegacyDocEvent} event
 * @param {{ now?: string, idFactory?: () => string, mutate?: boolean }} options
 */
function reduceWithLegacyReducer(state, event, options) {
  const holeState = toHoleState(state);
  const reduced = reduceHoleEvent(holeState, event, options);
  const candidate = fromHoleState(state, reduced.state, event);
  return commitCandidate(state, candidate, reduced.effects);
}

/** @param {NoraDocumentState} state */
function toHoleState(state) {
  const hole = createHoleState({
    hole_id: state.documentId,
    title: state.title,
    root_id: state.rootNodeId,
    created_at: state.createdAt,
    view_state: state.viewState,
    nodes: [...state.nodes.values()].map((node) => ({
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
    })),
  });
  hole.progressRuns = state.progressRuns;
  return hole;
}

/**
 * @param {NoraDocumentState} previous
 * @param {import("./contracts/engine.js").HoleState} holeState
 * @param {LegacyDocEvent} event
 * @returns {NoraDocumentState}
 */
function fromHoleState(previous, holeState, event) {
  const hole = holeStateToHole(holeState);
  const nodes = new Map(hole.nodes.map((node) => {
    const prior = previous.nodes.get(node.id);
    const state = stateForLegacyNode(prior, node, event);
    const base = normalizeStoredBaseUrlFields(node);
    if (!base.base_url && node.base_url != null) {
      try {
        base.base_url = normalizeBaseUrl(node.base_url);
        base.base_url_source = null;
      } catch {}
    }
    const next = {
      id: node.id,
      parentId: node.parent_id ?? null,
      title: String(node.title ?? ""),
      markdown: String(node.markdown ?? ""),
      baseUrl: base.base_url,
      baseUrlSource: base.base_url_source,
      origin: cloneJson(node.origin ?? null),
      position: cloneJson(node.position ?? { x: 0, y: 0 }),
      size: cloneJson(node.size ?? null),
      fontScale: Number(node.font_scale) || 1,
      collapsed: !!node.collapsed,
      state,
      read: !!node.read,
      createdAt: node.created_at ?? null,
      updatedAt: prior?.updatedAt ?? null,
      sourceIds: prior ? [...prior.sourceIds] : [],
      evidenceIds: prior ? [...prior.evidenceIds] : [],
      attachmentIds: prior ? [...prior.attachmentIds] : [],
      runId: prior?.runId ?? null,
      extensions: cloneJson(node.extensions ?? {}),
    };
    if (event.type === "node_answered" && /** @type {any} */ (event).node_id === node.id) maybeUpgradeBaseUrlFromFrontmatter(next);
    return [node.id, /** @type {NoraNode} */ (next)];
  }));
  const candidate = {
    ...previous,
    title: hole.title,
    rootNodeId: hole.root_id || previous.rootNodeId,
    viewState: normalizeViewState(hole.view_state),
    nodes,
    progressRuns: holeState.progressRuns,
  };
  return {
    ...candidate,
    edges: rebuildEdges(previous.edges, nodes),
  };
}

/** @param {NoraNode | undefined} prior @param {any} node @param {LegacyDocEvent} event */
function stateForLegacyNode(prior, node, event) {
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
    return { state: previous, effects };
  }
  const nextState = stateFromPersisted(nextPersisted, previous.revision + 1);
  nextState.progressRuns = candidate.progressRuns || previous.progressRuns;
  return {
    state: nextState,
    effects,
  };
}
