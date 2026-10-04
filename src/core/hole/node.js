import { validateAssetName } from "../assets.js";
import { normalizeAskAttachments } from "../attachments.js";
import { inheritedNodeBaseUrl, normalizeStoredBaseUrlFields } from "../base-url.js";
import { normalizeAnchor } from "./anchor.js";
import { BRANCH_FOLLOWUP, normalizeBranchType } from "./ask.js";
import { lensLabel, normalizeLens, truncate } from "./lens.js";

/** @typedef {import("../contracts/artifact.js").PersistedNode} PersistedNode */
/** @typedef {import("../contracts/engine.js").HoleNode} HoleNode */
/** @typedef {import("../contracts/engine.js").BranchRequestEvent} BranchRequestEvent */
/** @typedef {import("../contracts/engine.js").NodePresentationFields} NodePresentationFields */
/** @typedef {"persist" | "hydrate" | "wire" | "portable" | "snapshot"} NodeProjectionTarget */

const ALL = Object.freeze(["persist", "hydrate", "wire", "portable", "snapshot"]);
const PERSISTED = Object.freeze(["persist", "portable", "snapshot"]);
const HYDRATED = Object.freeze(["hydrate", "wire"]);
const STATEFUL = Object.freeze(["persist", "hydrate", "portable", "snapshot"]);

/**
 * The single declaration of the Node field list. A descriptor owns the
 * default, normalization rule, and the projections that carry the field.
 * Schema-v2 projection translates the canonical source/view/progress fields
 * back into their historical extension namespaces at the boundary.
 */
export const FIELDS = Object.freeze({
  id: field("", (value) => String(value ?? ""), ALL),
  parent_id: field(null, (value) => value == null ? null : String(value), ALL),
  title: field("", (value) => String(value ?? ""), ALL),
  markdown: field("", (value) => String(value ?? ""), ALL),
  base_url: field(null, nullableString, ALL),
  base_url_source: field(null, nullableString, ALL),
  origin: field(null, identity, ALL),
  position: field(Object.freeze({ x: 0, y: 0 }), normalizePosition, ALL),
  size: field(null, normalizeSize, ALL),
  font_scale: field(1, (value) => Number(value) || 1, ALL),
  collapsed: field(false, Boolean, STATEFUL),
  status: field("answered", (value) => value === "pending" ? "pending" : "answered", STATEFUL),
  read: field(false, Boolean, STATEFUL),
  created_at: field(null, nullableString, PERSISTED),
  source: field(null, normalizeObjectOrNull, []),
  view: field(Object.freeze({}), normalizeObject, []),
  progress: field(Object.freeze({}), normalizeObject, []),
  extensions: field(Object.freeze({}), normalizeObject, STATEFUL),
});

/** @param {Partial<HoleNode> | Record<string, any> | null | undefined} partial @returns {HoleNode} */
export function makeNode(partial) {
  const raw = partial || {};
  /** @type {Record<string, any>} */
  const node = {};
  for (const [name, descriptor] of Object.entries(FIELDS)) {
    const fallback = cloneDefault(descriptor.default);
    node[name] = descriptor.normalize(Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : fallback);
  }
  const persisted = splitPersistedExtensions(raw.extensions);
  if (raw.source == null && persisted.source) node.source = persisted.source;
  if (!Object.keys(node.view).length) node.view = persisted.view;
  if (!Object.keys(node.progress).length) node.progress = persisted.progress;
  node.extensions = persisted.extensions;
  return /** @type {HoleNode} */ (node);
}

/** @param {Partial<HoleNode> | Record<string, any> | null | undefined} node */
export function nodeNeedsReading(node) {
  return !!(
    node &&
    node.status === "answered" &&
    node.origin?.kind !== "note" &&
    !node.extensions?.attention?.seen_at
  );
}

/** @param {Record<string, any> | null | undefined} extensions */
export function stripNodeAttention(extensions) {
  const next = { ...(extensions || {}) };
  delete next.attention;
  return next;
}

/** @param {Partial<HoleNode> | Record<string, any>} node @param {NodeProjectionTarget} target */
export function projectNode(node, target) {
  if (!ALL.includes(target)) throw new Error(`Unknown node projection target: ${target}`);
  const normalized = makeNode(node);
  if (PERSISTED.includes(target)) {
    const base = normalizeStoredBaseUrlFields(normalized);
    normalized.base_url = base.base_url;
    normalized.base_url_source = base.base_url_source;
  }
  /** @type {Record<string, any>} */
  const projection = {};
  for (const [name, descriptor] of Object.entries(FIELDS)) {
    if (!descriptor.targets.includes(target) || ["source", "view", "progress", "extensions"].includes(name)) continue;
    projection[name] = cloneJson(normalized[name]);
  }
  if (FIELDS.extensions.targets.includes(target)) projection.extensions = joinPersistedExtensions(normalized, target);
  return /** @type {PersistedNode} */ (projection);
}

/** @param {BranchRequestEvent} payload @param {HoleNode} parent @param {{ now?: string }} [options] @returns {HoleNode} */
export function createPendingBranchNode(payload, parent, { now = new Date().toISOString() } = {}) {
  const standalone = payload.parent_id === null;
  const selectedText = standalone ? "" : String(payload.selected_text ?? "").trim();
  const question = String(payload.question ?? "").trim();
  const lens = normalizeLens(payload.lens);
  const instruction = lens && typeof payload.instruction === "string" ? payload.instruction.trim().slice(0, 4000) : null;
  const anchor = standalone ? null : normalizeAnchor(payload.anchor);
  const branchType = standalone ? BRANCH_FOLLOWUP : normalizeBranchType(payload.branch_type, selectedText);
  const inheritedBase = inheritedNodeBaseUrl(parent);
  const nodeId = String(payload.node_id || "");
  let cropAsset = null;
  try { cropAsset = validateAssetName(payload.crop_asset); } catch {}
  const attachmentAssets = normalizeAskAttachments(payload.attachment_assets);
  return makeNode({
    id: nodeId,
    parent_id: standalone ? null : String(payload.parent_id || ""),
    title: lens ? lensLabel(lens) : question ? truncate(question, 48) : attachmentAssets.length ? "Pasted image" : "…",
    markdown: "",
    base_url: inheritedBase.base_url,
    base_url_source: inheritedBase.base_url_source,
    origin: {
      selected_text: selectedText,
      question,
      lens,
      ...(instruction ? { instruction } : {}),
      anchor,
      branch_type: branchType,
      ...(attachmentAssets.length ? { attachment_assets: attachmentAssets } : {}),
      ...(cropAsset ? { crop_asset: cropAsset } : {}),
    },
    position: normalizePosition(payload.position),
    size: normalizeSize(payload.size),
    status: "pending",
    created_at: now,
  });
}

/** @param {HoleNode} node @param {NodePresentationFields} payload @returns {HoleNode} */
export function applyNodeUpdateFields(node, payload) {
  const next = { ...node };
  if (payload.position) next.position = normalizePosition(payload.position);
  if (payload.size) next.size = normalizeSize(payload.size);
  if (typeof payload.collapsed === "boolean") next.collapsed = payload.collapsed;
  if (Number.isFinite(payload.font_scale)) next.font_scale = /** @type {number} */ (payload.font_scale);
  if (typeof payload.read === "boolean") next.read = payload.read;
  return next;
}

/** @param {unknown} pos */
export function normalizePosition(pos) {
  return {
    x: Number(/** @type {{ x?: unknown } | null | undefined} */ (pos)?.x) || 0,
    y: Number(/** @type {{ y?: unknown } | null | undefined} */ (pos)?.y) || 0,
  };
}

/** @param {unknown} size */
export function normalizeSize(size) {
  if (!size) return null;
  const width = Number(/** @type {{ w?: unknown }} */ (size).w);
  const height = Number(/** @type {{ h?: unknown }} */ (size).h);
  if (!width || !height) return null;
  return { w: width, h: height };
}

/** @param {unknown} extensions @returns {{ source: Record<string, any> | null, view: Record<string, any>, progress: Record<string, any>, extensions: Record<string, any> }} */
function splitPersistedExtensions(extensions) {
  const raw = normalizeObject(extensions);
  const source = normalizeObjectOrNull(raw.pdf);
  const canvas = normalizeObject(raw.canvas);
  const note = normalizeObject(raw.note);
  const view = {
    ...canvas,
    ...(note.docked === true ? { docked: true } : {}),
    ...(note.reaction === true ? { reaction: true } : {}),
  };
  const progress = normalizeObject(raw.learn);
  const residual = { ...raw };
  delete residual.pdf;
  delete residual.canvas;
  delete residual.note;
  delete residual.learn;
  return { source, view, progress, extensions: residual };
}

/** @param {HoleNode & Record<string, any>} node @param {NodeProjectionTarget} target */
function joinPersistedExtensions(node, target) {
  const extensions = { ...normalizeObject(node.extensions) };
  if (node.source) extensions.pdf = cloneJson(node.source);
  const view = normalizeObject(node.view);
  const { docked, reaction, ...canvas } = view;
  if (Object.keys(canvas).length) extensions.canvas = cloneJson(canvas);
  const note = {
    ...(docked === true ? { docked: true } : {}),
    ...(reaction === true ? { reaction: true } : {}),
  };
  if (Object.keys(note).length) extensions.note = note;
  if (target !== "snapshot" && Object.keys(normalizeObject(node.progress)).length) extensions.learn = cloneJson(node.progress);
  if (target === "snapshot") {
    for (const name of Object.keys(extensions)) {
      if (!["pdf", "note", "canvas", "attention"].includes(name)) delete extensions[name];
    }
  }
  return extensions;
}

/** @param {any} defaultValue @param {(value: any) => any} normalize @param {readonly string[]} targets */
function field(defaultValue, normalize, targets) {
  return Object.freeze({ default: defaultValue, normalize, targets: Object.freeze(targets) });
}

/** @param {unknown} value */
function nullableString(value) { return value == null ? null : String(value); }
/** @param {any} value */
function identity(value) { return value; }
/** @param {unknown} value @returns {Record<string, any>} */
function normalizeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}; }
/** @param {unknown} value @returns {Record<string, any> | null} */
function normalizeObjectOrNull(value) { return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : null; }
/** @param {any} value */
function cloneDefault(value) { return value && typeof value === "object" ? cloneJson(value) : value; }
/** @param {any} value */
function cloneJson(value) { return JSON.parse(JSON.stringify(value ?? null)); }
