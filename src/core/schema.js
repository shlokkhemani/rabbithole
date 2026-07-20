import { normalizeStoredBaseUrlFields } from "./base-url.js";
import { normalizePdfAnchor, normalizePosition, normalizeSize, normalizeViewState } from "./model.js";

/** @typedef {import("./contracts/artifact.js").PersistedHole} PersistedHole */
/** @typedef {import("./contracts/artifact.js").PersistedNode} PersistedNode */

export const CURRENT_SCHEMA_VERSION = 2;
export const NEWER_SCHEMA_MESSAGE = "This Rabbithole was saved by a newer version of Rabbithole — update to open it.";

/** @template T @param {T} value @returns {T} */
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/** @param {Partial<PersistedHole> | null | undefined} hole @param {{ updatedAt?: string, cloneExtensions?: boolean }} [options] @returns {PersistedHole} */
export function toPersistedHole(hole, { updatedAt = new Date().toISOString(), cloneExtensions = true } = {}) {
  const nodes = Array.isArray(hole?.nodes) ? hole.nodes : [];
  /** @type {PersistedHole} */
  const persisted = {
    schema_version: CURRENT_SCHEMA_VERSION,
    hole_id: String(hole?.hole_id ?? ""),
    title: String(hole?.title ?? ""),
    root_id: String(hole?.root_id ?? ""),
    created_at: hole?.created_at ?? null,
    updated_at: updatedAt,
    view_state: normalizeViewState(hole?.view_state),
    nodes: nodes.map((node) => toPersistedNode(node, { cloneExtensions })),
  };
  validatePersistedHole(persisted);
  return persisted;
}

/** @param {Partial<PersistedNode> | null | undefined} node @param {{ cloneExtensions?: boolean }} [options] @returns {PersistedNode} */
function toPersistedNode(node, { cloneExtensions = true } = {}) {
  const base = normalizeStoredBaseUrlFields(node);
  return {
    id: String(node?.id ?? ""),
    parent_id: node?.parent_id == null ? null : String(node.parent_id),
    title: String(node?.title ?? ""),
    markdown: String(node?.markdown ?? ""),
    base_url: base.base_url,
    base_url_source: base.base_url_source,
    origin: node?.origin ?? null,
    position: normalizePosition(node?.position),
    size: normalizeSize(node?.size),
    font_scale: Number(node?.font_scale) || 1,
    collapsed: !!node?.collapsed,
    status: node?.status === "pending" ? "pending" : "answered",
    read: !!node?.read,
    created_at: node?.created_at ?? null,
    extensions: node?.extensions === undefined ? {} : (cloneExtensions ? cloneJson(node.extensions) : node.extensions),
  };
}

/** @param {unknown} raw */
export function parsePersistedHole(raw) {
  const hole = /** @type {Record<string, any>} */ (cloneJson(raw));
  if (!hole || typeof hole !== "object" || Array.isArray(hole)) {
    throw new Error("Persisted Rabbithole must be an object");
  }
  if (Number(hole.schema_version) > CURRENT_SCHEMA_VERSION) {
    throw new Error(NEWER_SCHEMA_MESSAGE);
  }
  normalizeImportedPdfAnchors(hole);
  validatePersistedHole(hole);
  return /** @type {PersistedHole} */ (hole);
}

/** Imported origins are otherwise opaque; PDF-space anchors are consumer-normalized. @param {Record<string, any>} hole */
function normalizeImportedPdfAnchors(hole) {
  if (!Array.isArray(hole.nodes)) return;
  for (const node of hole.nodes) {
    const pdf = node?.origin?.anchor?.pdf;
    if (!pdf || typeof pdf !== "object") continue;
    const normalized = normalizePdfAnchor(pdf);
    if (normalized) node.origin.anchor.pdf = normalized;
    else delete node.origin.anchor.pdf;
  }
}

/** @param {any} hole @returns {hole is PersistedHole} */
export function validatePersistedHole(hole) {
  if (!hole || typeof hole !== "object" || Array.isArray(hole)) throw new Error("Persisted Rabbithole must be an object");
  if (hole.schema_version !== CURRENT_SCHEMA_VERSION) throw new Error(`Persisted Rabbithole must have schema_version ${CURRENT_SCHEMA_VERSION}`);
  if (typeof hole.hole_id !== "string" || !hole.hole_id) throw new Error("Persisted Rabbithole hole_id must be a non-empty string");
  if (typeof hole.title !== "string") throw new Error("Persisted Rabbithole title must be a string");
  if (typeof hole.root_id !== "string" || !hole.root_id) throw new Error("Persisted Rabbithole root_id must be a non-empty string");
  if (!Array.isArray(hole.nodes)) throw new Error("Persisted Rabbithole nodes must be an array");
  for (const node of hole.nodes) validatePersistedNode(node);
  return true;
}

/** @param {any} node @returns {node is PersistedNode} */
function validatePersistedNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("Persisted node must be an object");
  if (typeof node.id !== "string" || !node.id) throw new Error("Persisted node id must be a non-empty string");
  if (node.parent_id !== null && typeof node.parent_id !== "string") throw new Error(`Persisted node ${node.id} parent_id must be string or null`);
  if (typeof node.title !== "string") throw new Error(`Persisted node ${node.id} title must be a string`);
  if (typeof node.markdown !== "string") throw new Error(`Persisted node ${node.id} markdown must be a string`);
  if (node.base_url !== null && typeof node.base_url !== "string") throw new Error(`Persisted node ${node.id} base_url must be string or null`);
  if (node.base_url_source !== null && !["explicit", "frontmatter", "inherited"].includes(node.base_url_source)) {
    throw new Error(`Persisted node ${node.id} base_url_source is invalid`);
  }
  if (!node.position || typeof node.position !== "object") throw new Error(`Persisted node ${node.id} position must be an object`);
  if (node.size !== null && typeof node.size !== "object") throw new Error(`Persisted node ${node.id} size must be object or null`);
  if (node.status !== "pending" && node.status !== "answered") throw new Error(`Persisted node ${node.id} status is invalid`);
  if (!node.extensions || typeof node.extensions !== "object" || Array.isArray(node.extensions)) {
    throw new Error(`Persisted node ${node.id} extensions must be a JSON object`);
  }
  return true;
}
