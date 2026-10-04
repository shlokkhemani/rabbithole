import { applyFrontmatterBaseUrl, normalizeStoredBaseUrlFields } from "../base-url.js";
import { normalizeBlockIds } from "../blocks.js";
import { cloneJson } from "../schema.js";
import {
  applyNodeUpdateFields,
  createPendingBranchNode,
  makeNode,
  normalizePosition,
  normalizeSize,
  projectNode,
  stripNodeAttention,
} from "./node.js";
import { askOfNode, isNoteNode, makeTranscribeAsk } from "./ask.js";
import { normalizeAnchor } from "./anchor.js";
import { normalizeBookmark, normalizeViewState } from "./bookmark.js";
import { collectSubtreeIds } from "./tree.js";
export { createHoleState, holeStateToHole, holeStateToHydrationNodes } from "./state.js";

/** @typedef {import("../contracts/engine.js").HoleState} HoleState */
/** @typedef {import("../contracts/engine.js").HoleNode} HoleNode */
/** @typedef {import("../contracts/engine.js").DocEvent} DocEvent */
/** @typedef {import("../contracts/engine.js").ReduceResult} ReduceResult */
/** @typedef {import("../contracts/engine.js").ReduceEffects} ReduceEffects */
/** @typedef {import("../contracts/engine.js").ReduceOptions} ReduceOptions */
/** @typedef {import("../contracts/engine.js").BranchRequestEvent} BranchRequestEvent */
/** @typedef {import("../contracts/engine.js").NodeCreateEvent} NodeCreateEvent */
/** @typedef {import("../contracts/engine.js").NodeProgressEvent} NodeProgressEvent */
/** @typedef {import("../contracts/engine.js").NodeAnsweredEvent} NodeAnsweredEvent */
/** @typedef {import("../contracts/engine.js").DeleteNodeEvent} DeleteNodeEvent */
/** @typedef {import("../contracts/engine.js").NodeUpdateEvent} NodeUpdateEvent */
/** @typedef {import("../contracts/engine.js").NodesUpdateEvent} NodesUpdateEvent */
/** @typedef {import("../contracts/engine.js").NodeOriginEvent} NodeOriginEvent */
/** @typedef {import("../contracts/engine.js").NodeExtensionsPatchEvent} NodeExtensionsPatchEvent */
/** @typedef {import("../contracts/engine.js").BlockStateEvent} BlockStateEvent */

/** @param {HoleState} state @param {DocEvent} event @param {ReduceOptions} [options] @returns {ReduceResult} */
export function reduceHoleEvent(state, event, options = {}) {
  const type = String(event?.type ?? "");
  switch (type) {
    case "branch_request":
      return reduceBranchRequest(state, /** @type {BranchRequestEvent} */ (event), options);
    case "node_create":
      return reduceNodeCreate(state, /** @type {NodeCreateEvent} */ (event), options);
    case "node_progress":
      return reduceNodeProgress(state, /** @type {NodeProgressEvent} */ (event), options);
    case "node_answered":
      return reduceNodeAnswered(state, /** @type {NodeAnsweredEvent} */ (event), options);
    case "delete_node":
    case "node_deleted":
      return reduceNodeDeleted(state, /** @type {DeleteNodeEvent} */ (event), options);
    case "node_update":
      return reduceNodeUpdate(state, /** @type {NodeUpdateEvent} */ (event), options);
    case "nodes_update":
      return reduceNodesUpdate(state, /** @type {NodesUpdateEvent} */ (event), options);
    case "view_state":
      return reduceBookmark(state, /** @type {import("../contracts/engine.js").ViewStateEvent} */ (event));
    case "hole_title":
      return withState({ ...state, title: String(/** @type {import("../contracts/engine.js").HoleTitleEvent} */ (event).title ?? state.title) });
    case "node_origin":
      return reduceNodeOrigin(state, /** @type {NodeOriginEvent} */ (event), options);
    case "node_extensions_patch":
      return reduceNodeExtensionsPatch(state, /** @type {NodeExtensionsPatchEvent} */ (event), options);
    case "block_state":
      return reduceBlockState(state, /** @type {BlockStateEvent} */ (event), options);
    default:
      throw new Error(`Unsupported hole event: ${type}`);
  }
}

/** @param {HoleState} state @param {import("../contracts/engine.js").ViewStateEvent} event */
function reduceBookmark(state, event) {
  return withState({
    ...state,
    view_state: normalizeViewState(event.state),
    bookmark: normalizeBookmark(event.state),
  });
}

/** @param {HoleState} state @param {NodeExtensionsPatchEvent} event @param {ReduceOptions} options */
function reduceNodeExtensionsPatch(state, event, options) {
  const nodeId = String(event.node_id || "");
  const namespace = String(event.namespace || "");
  const node = state.nodes.get(nodeId);
  if (!node || !/^[a-z][a-z0-9_-]*$/.test(namespace)) return withState(state);
  if (Object.prototype.hasOwnProperty.call(node, "source")
    || Object.prototype.hasOwnProperty.call(node, "view")
    || Object.prototype.hasOwnProperty.call(node, "progress")) {
    const next = { ...node };
    const value = cloneJson(event.value);
    const objectValue = /** @type {Record<string, any>} */ (value && typeof value === "object" && !Array.isArray(value) ? value : {});
    if (namespace === "pdf") next.source = Object.keys(objectValue).length ? objectValue : null;
    else if (namespace === "canvas") {
      const { docked, reaction, ..._canvas } = next.view || {};
      next.view = {
        ...objectValue,
        ...(docked === true ? { docked: true } : {}),
        ...(reaction === true ? { reaction: true } : {}),
      };
    }
    else if (namespace === "note") {
      const { docked: _docked, reaction: _reaction, ...view } = next.view || {};
      next.view = {
        ...view,
        ...(objectValue.docked === true ? { docked: true } : {}),
        ...(objectValue.reaction === true ? { reaction: true } : {}),
      };
    } else if (namespace === "learn") next.progress = objectValue;
    else next.extensions = { ...next.extensions, [namespace]: value };
    const nodes = cloneNodes(state, options);
    nodes.set(nodeId, next);
    const nextState = namespace === "pdf"
      ? stateWithTranscribeAsk({ ...state, nodes }, next, objectValue, options)
      : { ...state, nodes };
    return withState(nextState, { node_id: nodeId });
  }
  // The reducer corpus is also the public schema-v2 replay contract, so raw
  // schema-v2 inputs keep their historical namespace spelling.
  const extensions = { ...(node.extensions ?? {}), [namespace]: cloneJson(event.value) };
  const nodes = cloneNodes(state, options);
  const next = { ...node, extensions };
  nodes.set(nodeId, next);
  const nextState = namespace === "pdf"
    ? stateWithTranscribeAsk({ ...state, nodes }, next, /** @type {Record<string, any>} */ (extensions.pdf || {}), options)
    : { ...state, nodes };
  return withState(nextState, { node_id: nodeId });
}

/** @param {HoleState} state @param {BlockStateEvent} event @param {ReduceOptions} options */
function reduceBlockState(state, event, options) {
  const nodeId = String(event.node_id || "");
  const blockId = String(event.block_id || "");
  const node = state.nodes.get(nodeId);
  if (!node || !blockId || !event.state || typeof event.state !== "object" || Array.isArray(event.state)) return withState(state);
  if (Object.prototype.hasOwnProperty.call(node, "progress")) {
    const progress = node.progress || {};
    const previous = progress[blockId] && typeof progress[blockId] === "object" && !Array.isArray(progress[blockId])
      ? progress[blockId] : {};
    const nodes = cloneNodes(state, options);
    nodes.set(nodeId, { ...node, progress: { ...progress, [blockId]: { ...previous, ...cloneJson(event.state) } } });
    return withState({ ...state, nodes }, { node_id: nodeId });
  }
  const extensions = { ...(node.extensions ?? {}) };
  const learn = /** @type {Record<string, any>} */ (extensions.learn && typeof extensions.learn === "object" && !Array.isArray(extensions.learn)
    ? extensions.learn : {});
  const previous = learn[blockId] && typeof learn[blockId] === "object" && !Array.isArray(learn[blockId])
    ? learn[blockId] : {};
  extensions.learn = { ...learn, [blockId]: { ...previous, ...cloneJson(event.state) } };
  const nodes = cloneNodes(state, options);
  nodes.set(nodeId, { ...node, extensions });
  return withState({ ...state, nodes }, { node_id: nodeId });
}

/** @param {HoleState} state @param {ReduceEffects} [effects] @returns {ReduceResult} */
function withState(state, effects = {}) {
  return { state, effects };
}

/** @param {HoleState} state @param {ReduceOptions} options */
function cloneNodes(state, options) {
  return options?.mutate === true ? state.nodes : new Map(state.nodes);
}

/** @param {HoleState} state @param {ReduceOptions} options */
function cloneProgressRuns(state, options) {
  return options?.mutate === true ? state.progressRuns : new Map(state.progressRuns);
}

/** @param {HoleState} state @param {ReduceOptions} options */
function cloneAsks(state, options) {
  return options?.mutate === true ? state.asks : new Map(state.asks);
}

/** @param {HoleState} state @param {HoleNode} node @param {ReduceOptions} options */
function stateWithNodeAsk(state, node, options) {
  const asks = cloneAsks(state, options);
  const ask = askOfNode(node);
  if (ask) asks.set(ask.id, ask);
  else asks.delete(node.id);
  return { ...state, asks };
}

/** @param {HoleState} state @param {HoleNode} node @param {Record<string, any>} pdf @param {ReduceOptions} options */
function stateWithTranscribeAsk(state, node, pdf, options) {
  const asks = cloneAsks(state, options);
  const id = `transcribe:${node.id}`;
  if (pdf.convert_request === true) {
    const existing = asks.get(id);
    asks.set(id, existing ? { ...existing, state: "requested" } : makeTranscribeAsk(node, "requested"));
  } else {
    const existing = asks.get(id);
    if (existing) asks.set(id, { ...existing, state: "settled" });
  }
  return { ...state, asks };
}

/** @param {HoleState} state @param {BranchRequestEvent} event @param {ReduceOptions} options */
function reduceBranchRequest(state, event, options) {
  const parentId = event.parent_id === null ? null : String(event.parent_id || "");
  const contextParentId = parentId === null ? state.root_id : parentId;
  const contextParent = contextParentId ? state.nodes.get(contextParentId) : null;
  if (!contextParent) throw new Error(`Parent node ${contextParentId || parentId} not found`);
  const node = createPendingBranchNode({ ...event, parent_id: parentId }, contextParent, options);
  if (!node.id) throw new Error("Branch request node_id is required");
  const nodes = cloneNodes(state, options);
  nodes.set(node.id, node);
  return withState(stateWithNodeAsk({ ...state, nodes }, node, options), { createdNode: node });
}

/** @param {HoleState} state @param {NodeCreateEvent} event @param {ReduceOptions} options */
function reduceNodeCreate(state, event, options) {
  const nodeId = String(event.id ?? "").trim();
  if (!nodeId) throw new Error("Node create id is required");
  if (state.nodes.has(nodeId)) throw new Error(`Node ${nodeId} already exists`);
  const note = !!event.origin && typeof event.origin === "object" && !Array.isArray(event.origin)
    && /** @type {{ kind?: unknown }} */ (event.origin).kind === "note";
  if (event.origin != null && !note) throw new Error('Node create origin must be null or kind "note"');
  if (typeof event.markdown !== "string" || !event.markdown.trim()) {
    throw new Error(`${note ? "Note" : "Answer"} markdown is required`);
  }
  const parentId = event.parent_id == null ? null : String(event.parent_id);
  if (parentId !== null && !state.nodes.has(parentId)) throw new Error(`Parent node ${parentId} not found`);
  const rawOrigin = /** @type {Record<string, any>} */ (event.origin || {});
  const author = rawOrigin.author === "agent" ? "agent" : "human";
  const noteAttribution = author === "agent" ? { author } : {};
  const instruction = typeof rawOrigin.instruction === "string" ? rawOrigin.instruction.trim().slice(0, 4000) : "";
  const origin = !note ? null : parentId !== null && rawOrigin.anchor
    ? { kind: "note", ...noteAttribution, selected_text: String(rawOrigin.selected_text ?? "").trim(), anchor: normalizeAnchor(rawOrigin.anchor), branch_type: "selection", ...(instruction ? { instruction } : {}) }
    : { kind: "note", ...noteAttribution, ...(instruction ? { instruction } : {}) };
  // Docking is presentation and only means anything on a parent: the note has
  // no canvas geometry until it is placed, and the flag lives in the
  // extensions bag so nothing about the note's identity changes with it.
  const docked = note && parentId !== null && event.docked === true;

  const node = /** @type {HoleNode} */ (projectNode(makeNode({
    id: nodeId,
    parent_id: parentId,
    title: typeof event.title === "string" ? (event.title.trim() || (note ? "Note" : "Answer")) : (note ? "Note" : "Answer"),
    markdown: normalizeBlockIds(event.markdown, { idFactory: options.idFactory }).markdown,
    base_url: null,
    base_url_source: null,
    origin,
    position: normalizePosition(event.position),
    size: normalizeSize(event.size),
    status: "answered",
    read: note,
    created_at: options.now ?? new Date().toISOString(),
    view: docked ? { docked: true } : {},
  }), "persist"));
  const nodes = cloneNodes(state, options);
  nodes.set(nodeId, node);
  return withState(stateWithNodeAsk({ ...state, nodes }, node, options), { createdNode: node });
}

/** @param {HoleState} state @param {NodeProgressEvent} event @param {ReduceOptions} options */
function reduceNodeProgress(state, event, options) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const run = event.run;
  // Untagged progress deliberately bypasses ordering: tags are producer-side
  // discipline while the reducer remains permissive for embedders and replay.
  const tagged = run && typeof run.id === "string" && typeof run.seq === "number";
  const recorded = tagged ? state.progressRuns.get(nodeId) : null;
  if (recorded && recorded.id === /** @type {import("../contracts/engine.js").ProgressRun} */ (run).id && /** @type {import("../contracts/engine.js").ProgressRun} */ (run).seq <= recorded.seq) return withState(state);
  // A new run supersedes the current run once. Remember superseded ids so a
  // late packet from an aborted attempt cannot become "new" again.
  if (recorded?.superseded?.has(/** @type {import("../contracts/engine.js").ProgressRun} */ (run).id)) return withState(state);
  const nodes = cloneNodes(state, options);
  const next = {
    ...node,
    markdown: String(event.markdown ?? node.markdown ?? ""),
    base_url: event.base_url ?? node.base_url ?? null,
    base_url_source: event.base_url_source ?? node.base_url_source ?? null,
  };
  nodes.set(nodeId, /** @type {HoleNode} */ (next));
  let superseded = recorded?.superseded;
  if (recorded && recorded.id !== /** @type {import("../contracts/engine.js").ProgressRun} */ (run).id) {
    superseded = new Set(recorded.superseded || []);
    superseded.add(recorded.id);
  }
  const progressRuns = tagged ? cloneProgressRuns(state, options) : state.progressRuns;
  if (tagged) progressRuns.set(nodeId, { id: /** @type {import("../contracts/engine.js").ProgressRun} */ (run).id, seq: /** @type {import("../contracts/engine.js").ProgressRun} */ (run).seq, ...(superseded ? { superseded } : {}) });
  let nextState = { ...state, nodes, progressRuns };
  const ask = state.asks.get(nodeId);
  if (ask) {
    const asks = cloneAsks(state, options);
    asks.set(nodeId, { ...ask, state: "streaming", run: tagged ? { id: run.id, seq: run.seq } : ask.run });
    nextState = { ...nextState, asks };
  }
  return withState(nextState, { node_id: nodeId });
}

/** @param {HoleState} state @param {NodeAnsweredEvent} event @param {ReduceOptions} options */
function reduceNodeAnswered(state, event, options) {
  const nodeId = String(event.node_id || "");
  const current = state.nodes.get(nodeId) || makeNode({
    id: nodeId,
    parent_id: event.parent_id ?? null,
    title: "",
    markdown: "",
    base_url: null,
    base_url_source: null,
    origin: event.origin ?? null,
    position: event.position ?? { x: 0, y: 0 },
    size: event.size ?? null,
    status: "pending",
    created_at: event.created_at ?? null,
  });
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
    collapsed: event.collapsed ?? current.collapsed ?? false,
    status: "answered",
    read: event.read ?? false,
  });
  if (Object.prototype.hasOwnProperty.call(current, "extensions")) {
    next.extensions = stripNodeAttention(current.extensions);
  }
  next.font_scale = /** @type {number} */ (event.font_scale ?? current.font_scale ?? 1);
  const base = normalizeStoredBaseUrlFields(next);
  next.base_url = base.base_url;
  next.base_url_source = base.base_url_source;
  applyFrontmatterBaseUrl(next);
  const nodes = cloneNodes(state, options);
  nodes.set(nodeId, next);
  let progressRuns = state.progressRuns;
  if (progressRuns.has(nodeId)) {
    progressRuns = cloneProgressRuns(state, options);
    progressRuns.delete(nodeId);
  }
  let nextState = stateWithNodeAsk({ ...state, nodes, progressRuns }, next, options);
  const answeredAsk = nextState.asks.get(nodeId);
  if (answeredAsk) {
    const asks = cloneAsks(nextState, options);
    asks.set(nodeId, { ...answeredAsk, state: "settled", run: null, error: null });
    nextState = { ...nextState, asks };
  }
  return withState(nextState, { answeredNode: next });
}

/** @param {HoleState} state @param {DeleteNodeEvent} event @param {ReduceOptions} options */
function reduceNodeDeleted(state, event, options) {
  const ids = Array.isArray(event.node_ids) && event.node_ids.length
    ? event.node_ids.map(String)
    : collectSubtreeIds(state.nodes, String(event.node_id || ""));
  if (!ids.length) return withState(state, { deletedNodeIds: [], deletedNodes: [] });
  if (ids.includes(/** @type {string} */ (state.root_id))) throw new Error("The starting document can't be removed");
  const nodes = cloneNodes(state, options);
  const deletedNodes = [];
  for (const id of ids) {
    const node = nodes.get(id);
    if (node) deletedNodes.push(node);
    nodes.delete(id);
  }
  let progressRuns = state.progressRuns;
  if (ids.some((id) => progressRuns.has(id))) {
    progressRuns = cloneProgressRuns(state, options);
    for (const id of ids) progressRuns.delete(id);
  }
  const asks = cloneAsks(state, options);
  for (const id of ids) {
    asks.delete(id);
    asks.delete(`transcribe:${id}`);
  }
  return withState({ ...state, nodes, progressRuns, asks }, { deletedNodeIds: ids, deletedNodes });
}

/** @param {HoleState} state @param {NodeUpdateEvent} event @param {ReduceOptions} options */
function reduceNodeUpdate(state, event, options) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const nodes = cloneNodes(state, options);
  const next = applyNodeUpdateFields(node, event);
  if (typeof event.title === "string" && event.title.trim()) next.title = event.title.trim();
  if (isNoteNode(node) && typeof event.markdown === "string" && event.markdown.trim()) {
    next.markdown = normalizeBlockIds(event.markdown, { idFactory: options.idFactory }).markdown;
  }
  nodes.set(nodeId, next);
  return withState({ ...state, nodes }, { node_id: nodeId });
}

/** @param {HoleState} state @param {NodesUpdateEvent} event @param {ReduceOptions} options */
function reduceNodesUpdate(state, event, options) {
  const updates = Array.isArray(event.nodes) ? event.nodes : [];
  let nodes = null;
  for (const update of updates) {
    const nodeId = String(update?.node_id || "");
    const node = state.nodes.get(nodeId);
    if (!node) continue;
    if (!nodes) nodes = cloneNodes(state, options);
    nodes.set(nodeId, applyNodeUpdateFields(node, update));
  }
  return withState(nodes ? { ...state, nodes } : state);
}

/** @param {HoleState} state @param {NodeOriginEvent} event @param {ReduceOptions} options */
function reduceNodeOrigin(state, event, options) {
  const nodeId = String(event.node_id || "");
  const node = state.nodes.get(nodeId);
  if (!node) return withState(state);
  const nodes = cloneNodes(state, options);
  const next = { ...node, origin: event.origin ?? null };
  nodes.set(nodeId, next);
  return withState(stateWithNodeAsk({ ...state, nodes }, next, options), { node_id: nodeId });
}
