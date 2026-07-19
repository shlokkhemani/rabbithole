import { inheritedNodeBaseUrl } from "./base-url.js";
import { validateAssetName } from "./assets.js";

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
function normalizeLens(lens) {
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
  return type === BRANCH_SELECTION || type === BRANCH_FOLLOWUP ? type : null;
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

/** @param {unknown} value */
export function normalizePdfAnchor(value) {
  if (!value || typeof value !== "object") return null;
  const raw = /** @type {Record<string, any>} */ (value);
  if (raw.version !== 2 || !["text", "region"].includes(raw.kind) || !Array.isArray(raw.fragments)) return null;
  const sourceSha256 = String(raw.source_sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || raw.fragments.length < 1 || raw.fragments.length > 100) return null;
  const fragments = [];
  let quadCount = 0;
  for (const fragment of raw.fragments) {
    const page = Math.floor(Number(fragment?.page));
    if (!(page > 0) || !Array.isArray(fragment?.quads) || !fragment.quads.length) return null;
    const quads = [];
    for (const rawQuad of fragment.quads) {
      if (!Array.isArray(rawQuad) || rawQuad.length !== 4) return null;
      const quad = [];
      for (const point of rawQuad) {
        if (!Array.isArray(point) || point.length !== 2) return null;
        const x = Number(point[0]), y = Number(point[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return null;
        quad.push([roundPdfCoordinate(x), roundPdfCoordinate(y)]);
      }
      if (Math.abs(quadArea(quad)) < 1e-8) return null;
      quads.push(quad);
      quadCount++;
      if (quadCount > 5000) return null;
    }
    fragments.push({ page, quads });
  }
  return { version: 2, source_sha256: sourceSha256, kind: raw.kind, fragments };
}

/** @param {number} value */
function roundPdfCoordinate(value) {
  return Math.round(value * 10000) / 10000;
}

/** @param {number[][]} quad */
function quadArea(quad) {
  let area = 0;
  for (let index = 0; index < quad.length; index++) {
    const current = quad[index], next = quad[(index + 1) % quad.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

/** @param {unknown} anchor */
export function normalizeAnchor(anchor) {
  if (!anchor) return null;
  const start = Math.max(0, Number(/** @type {{ offset_start?: unknown }} */ (anchor).offset_start) || 0);
  const end = Math.max(start, Number(/** @type {{ offset_end?: unknown }} */ (anchor).offset_end) || start);
  /** @type {{ offset_start: number, offset_end: number, pdf?: any }} */
  const out = { offset_start: start, offset_end: end };
  const pdf = normalizePdfAnchor(/** @type {{ pdf?: unknown }} */ (anchor).pdf);
  if (pdf) out.pdf = pdf;
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
  let cropAsset = null;
  try { cropAsset = validateAssetName(payload.crop_asset); } catch {}

  return /** @type {ModelHoleNode} */ ({
    id: nodeId,
    parent_id: String(payload.parent_id || ""),
    title: synthesis ? "Synthesis" : lens ? lensLabel(lens) : question ? truncate(question, 48) : "…",
    markdown: "",
    base_url: inheritedBase.base_url,
    base_url_source: inheritedBase.base_url_source,
    origin: {
      selected_text: selectedText,
      question,
      lens,
      synthesis,
      anchor,
      branch_type: branchType,
      ...(cropAsset ? { crop_asset: cropAsset } : {}),
    },
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
  const doomed = new Set();
  const children = new Map();
  for (const node of valuesOfNodes(nodes)) {
    if (!node.parent_id) continue;
    const siblings = children.get(node.parent_id);
    if (siblings) siblings.push(node.id);
    else children.set(node.parent_id, [node.id]);
  }
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    if (doomed.has(id)) continue;
    doomed.add(id);
    const descendants = children.get(id);
    if (descendants) pending.push(...descendants);
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
function getNode(nodes, id) {
  return /** @type {ModelHoleNode | undefined} */ (nodes instanceof Map ? nodes.get(id) : nodes?.[id]);
}

/** @param {NodeCollection} nodes @returns {Iterable<ModelHoleNode>} */
function valuesOfNodes(nodes) {
  return nodes instanceof Map ? nodes.values() : Object.values(nodes || {});
}
