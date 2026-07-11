import { maybeUpgradeBaseUrlFromFrontmatter, normalizeStoredBaseUrlFields } from "./base-url.js";
import { normalizeBlockIds } from "./blocks.js";
import { cloneJson } from "./schema.js";
import {
  applyNodeUpdateFields,
  collectSubtreeIds,
  createPendingBranchNode,
  normalizeViewState,
} from "./model.js";

/** @typedef {import("./contracts/engine.js").HoleState} HoleState */
/** @typedef {import("./contracts/engine.js").HoleNode} HoleNode */
/** @typedef {import("./contracts/engine.js").DocEvent} DocEvent */
/** @typedef {import("./contracts/engine.js").ReduceResult} ReduceResult */
/** @typedef {import("./contracts/engine.js").ReduceEffects} ReduceEffects */
/** @typedef {import("./contracts/engine.js").ReduceOptions} ReduceOptions */
/** @typedef {import("./contracts/engine.js").BranchRequestEvent} BranchRequestEvent */
/** @typedef {import("./contracts/engine.js").NodeProgressEvent} NodeProgressEvent */
/** @typedef {import("./contracts/engine.js").NodeAnsweredEvent} NodeAnsweredEvent */
/** @typedef {import("./contracts/engine.js").DeleteNodeEvent} DeleteNodeEvent */
/** @typedef {import("./contracts/engine.js").NodeUpdateEvent} NodeUpdateEvent */
/** @typedef {import("./contracts/engine.js").NodesUpdateEvent} NodesUpdateEvent */
/** @typedef {import("./contracts/engine.js").NodeOriginEvent} NodeOriginEvent */
/** @typedef {import("./contracts/engine.js").BlockStateEvent} BlockStateEvent */

/** @param {Parameters<import("./contracts/engine.js").createHoleState>[0]} [input] @returns {HoleState} */
export function createHoleState({ hole_id, title, root_id, created_at = null, view_state = null, nodes = [] } = {}) {
  const entries = nodes instanceof Map ? nodes : new Map((nodes || []).map((node) => [node.id, node]));
  return {
    hole_id: hole_id || "",
    title: title || "Untitled",
    root_id: root_id || null,
    created_at,
    view_state,
    nodes: new Map([...entries].map(([id, node]) => [id, {
      ...node,
      ...(Object.prototype.hasOwnProperty.call(node, "extensions") ? { extensions: structuredJsonClone(node.extensions) } : {}),
    }])),
    progressRuns: new Map(),
  };
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function structuredJsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {HoleState} state */
export function holeStateToHole(state) {
  return {
    hole_id: state.hole_id,
    title: state.title,
    root_id: state.root_id,
    created_at: state.created_at,
    view_state: state.view_state,
    nodes: [...state.nodes.values()],
  };
}

/**
 * Canonical node projection for the live/frozen browser hydration wire.
 * The web host deliberately suppresses root origin metadata; the MCP host
 * preserves it.
 * @param {HoleState} state
 * @param {{ suppressRootOrigin?: boolean }} [options]
 */
export function holeStateToHydrationNodes(state, { suppressRootOrigin = false } = {}) {
  return [...state.nodes.values()].map((node) => ({
    id: node.id,
    parent_id: node.parent_id ?? null,
    title: node.title ?? "",
    markdown: node.markdown ?? "",
    base_url: node.base_url ?? null,
    base_url_source: node.base_url_source ?? null,
    origin: suppressRootOrigin && node.id === state.root_id ? null : (node.origin ?? null),
    position: node.position ?? { x: 0, y: 0 },
    size: node.size ?? null,
    font_scale: node.font_scale ?? 1,
    collapsed: !!node.collapsed,
    status: node.status ?? "answered",
    read: !!node.read,
    extensions: structuredJsonClone(node.extensions ?? {}),
  }));
}

/** @param {HoleState} state @param {DocEvent} event @param {ReduceOptions} [options] @returns {ReduceResult} */
export function reduceHoleEvent(state, event, options = {}) {
  const type = String(event?.type ?? "");
  switch (type) {
    case "branch_request":
      return reduceBranchRequest(state, /** @type {BranchRequestEvent} */ (event), options);
    case "node_progress":
      return reduceNodeProgress(state, /** @type {NodeProgressEvent} */ (event));
    case "node_answered":
      return reduceNodeAnswered(state, /** @type {NodeAnsweredEvent} */ (event), options);
    case "delete_node":
    case "node_deleted":
      return reduceNodeDeleted(state, /** @type {DeleteNodeEvent} */ (event));
    case "node_update":
      return reduceNodeUpdate(state, /** @type {NodeUpdateEvent} */ (event));
    case "nodes_update":
      return reduceNodesUpdate(state, /** @type {NodesUpdateEvent} */ (event));
    case "view_state":
      return withState({ ...state, view_state: normalizeViewState(/** @type {import("./contracts/engine.js").ViewStateEvent} */ (event).state) });
    case "hole_title":
      return withState({ ...state, title: String(/** @type {import("./contracts/engine.js").HoleTitleEvent} */ (event).title ?? state.title) });
    case "node_origin":
      return reduceNodeOrigin(state, /** @type {NodeOriginEvent} */ (event));
    case "block_state":
      return reduceBlockState(state, /** @type {BlockStateEvent} */ (event));
    default:
      throw new Error(`Unsupported hole event: ${type}`);
  }
}

/** @param {HoleState} state @param {BlockStateEvent} event */
function reduceBlockState(state, event) {
  const nodeId = String(event.node_id || "");
  const blockId = String(event.block_id || "");
  const node = state.nodes.get(nodeId);
  if (!node || !blockId || !event.state || typeof event.state !== "object" || Array.isArray(event.state)) return withState(state);
  const extensions = cloneJson(node.extensions ?? {});
  const learn = /** @type {Record<string, any>} */ (extensions.learn && typeof extensions.learn === "object" && !Array.isArray(extensions.learn)
    ? extensions.learn : {});
  const previous = learn[blockId] && typeof learn[blockId] === "object" && !Array.isArray(learn[blockId])
    ? learn[blockId] : {};
  extensions.learn = { ...learn, [blockId]: { ...previous, ...cloneJson(event.state) } };
  const nodes = cloneNodes(state);
  nodes.set(nodeId, { ...node, extensions });
  return withState({ ...state, nodes }, { node_id: nodeId });
}

/** @param {HoleState} state @param {ReduceEffects} [effects] @returns {ReduceResult} */
function withState(state, effects = {}) {
  return { state, effects };
}

/** @param {HoleState} state */
function cloneNodes(state) {
  return new Map(state.nodes);
}

/** @param {HoleState} state @param {BranchRequestEvent} event @param {ReduceOptions} options */
function reduceBranchRequest(state, event, options) {
  const parentId = String(event.parent_id || "");
  const parent = state.nodes.get(parentId);
  if (!parent) throw new Error(`Parent node ${parentId} not found`);
  const node = createPendingBranchNode(event, parent, options);
  if (!node.id) throw new Error("Branch request node_id is required");
  const nodes = cloneNodes(state);
  nodes.set(node.id, node);
  return withState({ ...state, nodes }, { createdNode: node });
}

/** @param {HoleState} state @param {NodeProgressEvent} event */
function reduceNodeProgress(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const run = event.run;
  // Untagged progress deliberately bypasses ordering: tags are producer-side
  // discipline while the reducer remains permissive for embedders and replay.
  const tagged = run && typeof run.id === "string" && typeof run.seq === "number";
  const recorded = tagged ? state.progressRuns.get(nodeId) : null;
  if (recorded && recorded.id === /** @type {import("./contracts/engine.js").ProgressRun} */ (run).id && /** @type {import("./contracts/engine.js").ProgressRun} */ (run).seq <= recorded.seq) return withState(state);
  // A new run supersedes the current run once. Remember superseded ids so a
  // late packet from an aborted attempt cannot become "new" again.
  if (recorded?.superseded?.has(/** @type {import("./contracts/engine.js").ProgressRun} */ (run).id)) return withState(state);
  const nodes = cloneNodes(state);
  const next = {
    ...node,
    markdown: String(event.markdown ?? node.markdown ?? ""),
    base_url: event.base_url ?? node.base_url ?? null,
    base_url_source: event.base_url_source ?? node.base_url_source ?? null,
  };
  nodes.set(nodeId, /** @type {HoleNode} */ (next));
  const superseded = recorded && recorded.id !== /** @type {import("./contracts/engine.js").ProgressRun} */ (run).id
    ? new Set([...(recorded.superseded || []), recorded.id])
    : recorded?.superseded;
  const progressRuns = tagged
    ? new Map(state.progressRuns).set(nodeId, { id: /** @type {import("./contracts/engine.js").ProgressRun} */ (run).id, seq: /** @type {import("./contracts/engine.js").ProgressRun} */ (run).seq, ...(superseded ? { superseded } : {}) })
    : state.progressRuns;
  return withState({ ...state, nodes, progressRuns }, { node_id: nodeId });
}

/** @param {HoleState} state @param {NodeAnsweredEvent} event @param {ReduceOptions} options */
function reduceNodeAnswered(state, event, options) {
  const nodeId = String(event.node_id || "");
  const current = state.nodes.get(nodeId) || {
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
  const next = /** @type {HoleNode} */ ({
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
  const base = normalizeStoredBaseUrlFields(next);
  next.base_url = base.base_url;
  next.base_url_source = base.base_url_source;
  maybeUpgradeBaseUrlFromFrontmatter(next);
  const nodes = cloneNodes(state);
  nodes.set(nodeId, next);
  let progressRuns = state.progressRuns;
  if (progressRuns.has(nodeId)) {
    progressRuns = new Map(progressRuns);
    progressRuns.delete(nodeId);
  }
  return withState({ ...state, nodes, progressRuns }, { answeredNode: next });
}

/** @param {HoleState} state @param {DeleteNodeEvent} event */
function reduceNodeDeleted(state, event) {
  const ids = Array.isArray(event.node_ids) && event.node_ids.length
    ? event.node_ids.map(String)
    : collectSubtreeIds(state.nodes, String(event.node_id || ""));
  if (!ids.length) return withState(state, { deletedNodeIds: [], deletedNodes: [] });
  if (ids.includes(/** @type {string} */ (state.root_id))) throw new Error("The starting document can't be removed");
  const nodes = cloneNodes(state);
  const deletedNodes = [];
  for (const id of ids) {
    const node = nodes.get(id);
    if (node) deletedNodes.push(node);
    nodes.delete(id);
  }
  let progressRuns = state.progressRuns;
  if (ids.some((id) => progressRuns.has(id))) {
    progressRuns = new Map(progressRuns);
    for (const id of ids) progressRuns.delete(id);
  }
  return withState({ ...state, nodes, progressRuns }, { deletedNodeIds: ids, deletedNodes });
}

/** @param {HoleState} state @param {NodeUpdateEvent} event */
function reduceNodeUpdate(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const nodes = cloneNodes(state);
  nodes.set(nodeId, applyNodeUpdateFields(node, event));
  return withState({ ...state, nodes }, { node_id: nodeId });
}

/** @param {HoleState} state @param {NodesUpdateEvent} event */
function reduceNodesUpdate(state, event) {
  const updates = Array.isArray(event.nodes) ? event.nodes : [];
  let nodes = null;
  for (const update of updates) {
    const nodeId = String(update?.node_id || "");
    const node = state.nodes.get(nodeId);
    if (!node) continue;
    if (!nodes) nodes = cloneNodes(state);
    nodes.set(nodeId, applyNodeUpdateFields(node, update));
  }
  return withState(nodes ? { ...state, nodes } : state);
}

/** @param {HoleState} state @param {NodeOriginEvent} event */
function reduceNodeOrigin(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const nodes = cloneNodes(state);
  nodes.set(nodeId, { ...node, origin: event.origin ?? null });
  return withState({ ...state, nodes }, { node_id: nodeId });
}
