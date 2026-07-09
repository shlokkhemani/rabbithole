import { inheritedNodeBaseUrl } from "./base-url.js";

export const BRANCH_SELECTION = "selection";
export const BRANCH_FOLLOWUP = "followup";

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

export const LENS_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(LENSES).map(([key, value]) => [key, value.label]))
);

export function truncate(value, length) {
  const s = String(value ?? "");
  return s.length > length ? `${s.slice(0, length).trimEnd()}…` : s;
}

export function lensLabel(key) {
  return LENSES[key] ? LENSES[key].label : String(key || "");
}

export function normalizeLens(lens) {
  const key = String(lens ?? "").trim();
  return Object.prototype.hasOwnProperty.call(LENSES, key) ? key : null;
}

export function normalizeBranchType(type, selectedText = "") {
  const key = String(type ?? "").trim();
  if (key === BRANCH_SELECTION || key === BRANCH_FOLLOWUP) return key;
  return selectedText ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
}

export function branchTypeOfNode(node) {
  if (!node || (!node.origin && !node.parent_id)) return null;
  const type = node.origin?.branch_type;
  if (type === BRANCH_SELECTION || type === BRANCH_FOLLOWUP) return type;
  return node.origin?.selected_text ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
}

export function normalizePosition(pos) {
  return {
    x: Number(pos?.x) || 0,
    y: Number(pos?.y) || 0,
  };
}

export function normalizeSize(size) {
  if (!size) return null;
  const w = Number(size.w);
  const h = Number(size.h);
  if (!w || !h) return null;
  return { w, h };
}

export function normalizeAnchor(anchor) {
  if (!anchor) return null;
  const start = Math.max(0, Number(anchor.offset_start) || 0);
  const end = Math.max(start, Number(anchor.offset_end) || start);
  return { offset_start: start, offset_end: end };
}

export function normalizeViewState(state) {
  if (!state || typeof state !== "object") return null;
  const out = {
    mode: state.mode === "canvas" ? "canvas" : "reader",
    node_id: typeof state.node_id === "string" ? state.node_id.slice(0, 128) : null,
    scroll: Math.max(0, Number(state.scroll) || 0),
  };
  if (state.view && typeof state.view === "object") {
    out.view = {
      x: Number(state.view.x) || 0,
      y: Number(state.view.y) || 0,
      scale: Math.min(2.5, Math.max(0.15, Number(state.view.scale) || 1)),
    };
  }
  return out;
}

export function createPendingBranchNode(payload, parent, { now = new Date().toISOString() } = {}) {
  const selectedText = String(payload.selected_text ?? "").trim();
  const question = String(payload.question ?? "").trim();
  const lens = normalizeLens(payload.lens);
  const synthesis = payload.synthesis === true;
  const synthesisSources = Array.isArray(payload.synthesis_sources)
    ? payload.synthesis_sources.map((id) => String(id).slice(0, 128)).filter(Boolean)
    : null;
  const anchor = normalizeAnchor(payload.anchor);
  const branchType = normalizeBranchType(payload.branch_type, selectedText);
  const inheritedBase = inheritedNodeBaseUrl(parent);
  const nodeId = String(payload.node_id || "");

  return {
    id: nodeId,
    parent_id: String(payload.parent_id || ""),
    title: synthesis ? "Synthesis" : lens ? lensLabel(lens) : question ? truncate(question, 48) : "…",
    markdown: "",
    base_url: inheritedBase.base_url,
    base_url_source: inheritedBase.base_url_source,
    origin: { selected_text: selectedText, question, lens, synthesis, synthesis_sources: synthesisSources, anchor, branch_type: branchType },
    position: normalizePosition(payload.position),
    size: normalizeSize(payload.size),
    font_scale: 1,
    collapsed: false,
    status: "pending",
    read: false,
    created_at: now,
  };
}

export function applyNodeUpdateFields(node, payload) {
  const next = { ...node };
  if (payload.position) next.position = normalizePosition(payload.position);
  if (payload.size) next.size = normalizeSize(payload.size);
  if (typeof payload.collapsed === "boolean") next.collapsed = payload.collapsed;
  if (Number.isFinite(payload.font_scale)) next.font_scale = payload.font_scale;
  if (typeof payload.read === "boolean") next.read = payload.read;
  return next;
}

export function childrenOfNode(nodes, parentId) {
  const out = [];
  for (const node of valuesOfNodes(nodes)) {
    if (node.parent_id === parentId) out.push(node);
  }
  return out;
}

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

export function lineageNodesFromMap(nodes, nodeId) {
  const path = [];
  let current = getNode(nodes, nodeId);
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    path.push(current);
    current = current.parent_id ? getNode(nodes, current.parent_id) : null;
  }
  return path.reverse();
}

export function lineageTitlesFromMap(nodes, nodeId) {
  return lineageNodesFromMap(nodes, nodeId).map((node) => node.title || "Untitled");
}

export function getNode(nodes, id) {
  return nodes instanceof Map ? nodes.get(id) : nodes?.[id];
}

export function valuesOfNodes(nodes) {
  return nodes instanceof Map ? nodes.values() : Object.values(nodes || {});
}
