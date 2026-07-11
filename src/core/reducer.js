import { maybeUpgradeBaseUrlFromFrontmatter, normalizeStoredBaseUrlFields } from "./base-url.js";
import {
  applyNodeUpdateFields,
  collectSubtreeIds,
  createPendingBranchNode,
  normalizeViewState,
} from "./model.js";

export function createHoleState({ hole_id, title, root_id, created_at = null, view_state = null, nodes = [] } = {}) {
  return {
    hole_id: hole_id || "",
    title: title || "Untitled",
    root_id: root_id || null,
    created_at,
    view_state,
    nodes: nodes instanceof Map ? new Map(nodes) : new Map((nodes || []).map((node) => [node.id, { ...node }])),
  };
}

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

export function reduceHoleEvent(state, event, options = {}) {
  const type = String(event?.type ?? "");
  switch (type) {
    case "branch_request":
      return reduceBranchRequest(state, event, options);
    case "node_progress":
      return reduceNodeProgress(state, event);
    case "node_answered":
      return reduceNodeAnswered(state, event);
    case "delete_node":
    case "node_deleted":
      return reduceNodeDeleted(state, event);
    case "node_update":
      return reduceNodeUpdate(state, event);
    case "nodes_update":
      return reduceNodesUpdate(state, event);
    case "view_state":
      return withState({ ...state, view_state: normalizeViewState(event.state) });
    case "hole_title":
      return withState({ ...state, title: String(event.title ?? state.title) });
    case "node_origin":
      return reduceNodeOrigin(state, event);
    default:
      throw new Error(`Unsupported hole event: ${type}`);
  }
}

function withState(state, effects = {}) {
  return { state, effects };
}

function cloneNodes(state) {
  return new Map(state.nodes);
}

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

function reduceNodeProgress(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const nodes = cloneNodes(state);
  const next = {
    ...node,
    markdown: String(event.markdown ?? node.markdown ?? ""),
    base_url: event.base_url ?? node.base_url ?? null,
    base_url_source: event.base_url_source ?? node.base_url_source ?? null,
  };
  nodes.set(nodeId, next);
  return withState({ ...state, nodes }, { node_id: nodeId });
}

function reduceNodeAnswered(state, event) {
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
  };
  const next = {
    ...current,
    parent_id: event.parent_id ?? current.parent_id ?? null,
    title: String(event.title ?? current.title ?? "Untitled").trim() || "Untitled",
    markdown: String(event.markdown ?? current.markdown ?? ""),
    base_url: event.base_url ?? current.base_url ?? null,
    base_url_source: event.base_url_source ?? current.base_url_source ?? null,
    origin: event.origin ?? current.origin ?? null,
    position: event.position ?? current.position ?? { x: 0, y: 0 },
    size: event.size ?? current.size ?? null,
    font_scale: event.font_scale ?? current.font_scale ?? 1,
    collapsed: event.collapsed ?? current.collapsed ?? false,
    status: "answered",
    read: event.read ?? false,
  };
  const base = normalizeStoredBaseUrlFields(next);
  next.base_url = base.base_url;
  next.base_url_source = base.base_url_source;
  maybeUpgradeBaseUrlFromFrontmatter(next);
  const nodes = cloneNodes(state);
  nodes.set(nodeId, next);
  return withState({ ...state, nodes }, { answeredNode: next });
}

function reduceNodeDeleted(state, event) {
  const ids = Array.isArray(event.node_ids) && event.node_ids.length
    ? event.node_ids.map(String)
    : collectSubtreeIds(state.nodes, String(event.node_id || ""));
  if (!ids.length) return withState(state, { deletedNodeIds: [], deletedNodes: [] });
  if (ids.includes(state.root_id)) throw new Error("The starting document can't be removed");
  const nodes = cloneNodes(state);
  const deletedNodes = [];
  for (const id of ids) {
    const node = nodes.get(id);
    if (node) deletedNodes.push(node);
    nodes.delete(id);
  }
  return withState({ ...state, nodes }, { deletedNodeIds: ids, deletedNodes });
}

function reduceNodeUpdate(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const nodes = cloneNodes(state);
  nodes.set(nodeId, applyNodeUpdateFields(node, event));
  return withState({ ...state, nodes }, { node_id: nodeId });
}

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

function reduceNodeOrigin(state, event) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const nodes = cloneNodes(state);
  nodes.set(nodeId, { ...node, origin: event.origin ?? null });
  return withState({ ...state, nodes }, { node_id: nodeId });
}
