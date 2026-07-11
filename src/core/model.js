import { inheritedNodeBaseUrl } from "./base-url.js";

/** @typedef {import("./contracts/engine.js").HoleNode} ModelHoleNode */
/** @typedef {import("./contracts/engine.js").BranchRequestEvent} ModelBranchRequestEvent */
/** @typedef {import("./contracts/engine.js").NodePresentationFields} NodePresentationFields */
/** @typedef {import("./contracts/artifact.js").Position} Position */
/** @typedef {import("./contracts/artifact.js").NodeSize} NodeSize */
/** @typedef {import("./contracts/artifact.js").PersistedViewState} PersistedViewState */
/** @typedef {Map<string, ModelHoleNode> | Record<string, ModelHoleNode>} NodeCollection */

export const BRANCH_SELECTION = "selection";
export const BRANCH_FOLLOWUP = "followup";

/** @type {Readonly<Record<PropertyKey, { label: string, q: string }>>} */
export const LENSES = Object.freeze({
  explain: Object.freeze({
    label: "Explain",
    q: "Explain this clearly and precisely: what it means here, why it matters, and the key intuition an expert would want me to take away.",
  }),
  eli5: Object.freeze({
    label: "ELI5",
    q: "Explain this like I'm five: start with a concrete everyday analogy, then translate the analogy back to the real thing, one level more precise.",
  }),
  example: Object.freeze({
    label: "Example",
    q: "Show this in action with one concrete worked example: realistic, minimal, step by step. Use runnable code if it's code-shaped, real numbers if it's quantitative.",
  }),
  deeper: Object.freeze({
    label: "Go Deeper",
    q: "Go one level deeper than this document does: the underlying mechanism, the important edge cases, and what experts know about this that introductory treatments gloss over.",
  }),
});

/** @param {unknown} value @param {number} length */
export function truncate(value, length) {
  const s = String(value ?? "");
  return s.length > length ? `${s.slice(0, length).trimEnd()}…` : s;
}

/** @param {PropertyKey} key */
export function lensLabel(key) {
  return LENSES[key] ? LENSES[key].label : String(key || "");
}

/** @param {unknown} lens */
export function normalizeLens(lens) {
  const key = String(lens ?? "").trim();
  return Object.prototype.hasOwnProperty.call(LENSES, key) ? key : null;
}

/** @param {unknown} type @param {string} [selectedText] */
function normalizeBranchType(type, selectedText = "") {
  const key = String(type ?? "").trim();
  if (key === BRANCH_SELECTION || key === BRANCH_FOLLOWUP) return key;
  return selectedText ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
}

/** @param {{ origin?: { branch_type?: unknown, selected_text?: unknown } | null, parent_id?: unknown } | null | undefined} node */
export function branchTypeOfNode(node) {
  if (!node || (!node.origin && !node.parent_id)) return null;
  const type = node.origin?.branch_type;
  if (type === BRANCH_SELECTION || type === BRANCH_FOLLOWUP) return type;
  return node.origin?.selected_text ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
}

/** @param {unknown} pos @returns {Position} */
export function normalizePosition(pos) {
  return {
    x: Number(/** @type {{ x?: unknown } | null | undefined} */ (pos)?.x) || 0,
    y: Number(/** @type {{ y?: unknown } | null | undefined} */ (pos)?.y) || 0,
  };
}

/** @param {unknown} size @returns {NodeSize | null} */
export function normalizeSize(size) {
  if (!size) return null;
  const w = Number(/** @type {{ w?: unknown }} */ (size).w);
  const h = Number(/** @type {{ h?: unknown }} */ (size).h);
  if (!w || !h) return null;
  return { w, h };
}

/** @param {unknown} anchor */
export function normalizeAnchor(anchor) {
  if (!anchor) return null;
  const start = Math.max(0, Number(/** @type {{ offset_start?: unknown }} */ (anchor).offset_start) || 0);
  const end = Math.max(start, Number(/** @type {{ offset_end?: unknown }} */ (anchor).offset_end) || start);
  /** @type {{ offset_start: number, offset_end: number, pdf?: { page: number, rect: { x: number, y: number, w: number, h: number } } }} */
  const out = { offset_start: start, offset_end: end };
  const rawPdf = /** @type {{ pdf?: unknown }} */ (anchor).pdf;
  if (rawPdf && typeof rawPdf === "object") {
    const page = Math.floor(Number(/** @type {{ page?: unknown }} */ (rawPdf).page));
    const rawRect = /** @type {{ rect?: unknown }} */ (rawPdf).rect;
    if (page > 0 && rawRect && typeof rawRect === "object") {
      const clamp = (/** @type {unknown} */ value) => Math.min(1, Math.max(0, Number(value) || 0));
      const x = clamp(/** @type {{ x?: unknown }} */ (rawRect).x);
      const y = clamp(/** @type {{ y?: unknown }} */ (rawRect).y);
      out.pdf = {
        page,
        rect: {
          x, y,
          w: Math.min(clamp(/** @type {{ w?: unknown }} */ (rawRect).w), 1 - x),
          h: Math.min(clamp(/** @type {{ h?: unknown }} */ (rawRect).h), 1 - y),
        },
      };
    }
  }
  return out;
}

/** @param {unknown} state @returns {PersistedViewState | null} */
export function normalizeViewState(state) {
  if (!state || typeof state !== "object") return null;
  /** @type {PersistedViewState} */
  const out = {
    mode: /** @type {Record<string, any>} */ (state).mode === "canvas" ? "canvas" : "reader",
    node_id: typeof /** @type {Record<string, any>} */ (state).node_id === "string" ? /** @type {Record<string, any>} */ (state).node_id.slice(0, 128) : null,
    scroll: Math.max(0, Number(/** @type {Record<string, any>} */ (state).scroll) || 0),
  };
  if (/** @type {Record<string, any>} */ (state).view && typeof /** @type {Record<string, any>} */ (state).view === "object") {
    out.view = {
      x: Number(/** @type {Record<string, any>} */ (state).view.x) || 0,
      y: Number(/** @type {Record<string, any>} */ (state).view.y) || 0,
      scale: Math.min(2.5, Math.max(0.15, Number(/** @type {Record<string, any>} */ (state).view.scale) || 1)),
    };
  }
  return out;
}

/** @param {ModelBranchRequestEvent} payload @param {ModelHoleNode} parent @param {{ now?: string }} [options] @returns {ModelHoleNode} */
export function createPendingBranchNode(payload, parent, { now = new Date().toISOString() } = {}) {
  const selectedText = String(payload.selected_text ?? "").trim();
  const question = String(payload.question ?? "").trim();
  const lens = normalizeLens(payload.lens);
  const synthesis = payload.synthesis === true;
  const anchor = normalizeAnchor(payload.anchor);
  const branchType = normalizeBranchType(payload.branch_type, selectedText);
  const inheritedBase = inheritedNodeBaseUrl(parent);
  const nodeId = String(payload.node_id || "");

  return /** @type {ModelHoleNode} */ ({
    id: nodeId,
    parent_id: String(payload.parent_id || ""),
    title: synthesis ? "Synthesis" : lens ? lensLabel(lens) : question ? truncate(question, 48) : "…",
    markdown: "",
    base_url: inheritedBase.base_url,
    base_url_source: inheritedBase.base_url_source,
    origin: { selected_text: selectedText, question, lens, synthesis, anchor, branch_type: branchType },
    position: normalizePosition(payload.position),
    size: normalizeSize(payload.size),
    font_scale: 1,
    collapsed: false,
    status: "pending",
    read: false,
    created_at: now,
    extensions: {},
  });
}

/** @param {ModelHoleNode} node @param {NodePresentationFields} payload @returns {ModelHoleNode} */
export function applyNodeUpdateFields(node, payload) {
  const next = { ...node };
  if (payload.position) next.position = normalizePosition(payload.position);
  if (payload.size) next.size = normalizeSize(payload.size);
  if (typeof payload.collapsed === "boolean") next.collapsed = payload.collapsed;
  if (Number.isFinite(payload.font_scale)) next.font_scale = /** @type {number} */ (payload.font_scale);
  if (typeof payload.read === "boolean") next.read = payload.read;
  return next;
}

/** @param {NodeCollection} nodes @param {string} rootId @returns {string[]} */
export function collectSubtreeIds(nodes, rootId) {
  const doomed = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of valuesOfNodes(nodes)) {
      if (node.parent_id && doomed.has(node.parent_id) && !doomed.has(node.id)) {
        doomed.add(node.id);
        grew = true;
      }
    }
  }
  return [...doomed];
}

/** @param {NodeCollection} nodes @param {string} nodeId @returns {ModelHoleNode[]} */
export function lineageNodesFromMap(nodes, nodeId) {
  /** @type {ModelHoleNode[]} */
  const path = [];
  /** @type {ModelHoleNode | null | undefined} */
  let current = getNode(nodes, nodeId);
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    path.push(current);
    current = current.parent_id ? getNode(nodes, current.parent_id) : null;
  }
  return path.reverse();
}

/** @param {NodeCollection} nodes @param {string} nodeId */
export function lineageTitlesFromMap(nodes, nodeId) {
  return lineageNodesFromMap(nodes, nodeId).map((node) => node.title || "Untitled");
}

/** @param {NodeCollection} nodes @param {string} id @returns {ModelHoleNode | undefined} */
export function getNode(nodes, id) {
  return /** @type {ModelHoleNode | undefined} */ (nodes instanceof Map ? nodes.get(id) : nodes?.[id]);
}

/** @param {NodeCollection} nodes @returns {Iterable<ModelHoleNode>} */
function valuesOfNodes(nodes) {
  return nodes instanceof Map ? nodes.values() : Object.values(nodes || {});
}
