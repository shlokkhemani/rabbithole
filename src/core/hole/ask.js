import { validateAssetName } from "../assets.js";
import { MAX_ASK_ATTACHMENTS, normalizeAskAttachments, validateAskAttachments } from "../attachments.js";
import { normalizeAnchor } from "./anchor.js";
import { reactionInstructionForNode } from "./reaction.js";
import { lineageNodesFromMap, valuesOfNodes } from "./tree.js";

/** @typedef {import("../contracts/engine.js").HoleNode} HoleNode */
/** @typedef {Map<string, HoleNode> | Record<string, HoleNode>} NodeCollection */

export const BRANCH_SELECTION = "selection";
export const BRANCH_FOLLOWUP = "followup";

/** @param {{ origin?: unknown } | null | undefined} node */
export function isNoteNode(node) {
  return !!node && !!node.origin && typeof node.origin === "object" && !Array.isArray(node.origin)
    && /** @type {{ kind?: unknown }} */ (node.origin).kind === "note";
}

/*
 * Docking is presentation, never identity: a docked note is an ordinary note
 * node that renders on its parent card (wash + margin dot) instead of owning a
 * place on the canvas. Schema-v2 stores the flag in extensions.note; the
 * canonical in-memory view is node.view.docked.
 */
/** @param {{ origin?: unknown, parent_id?: unknown, view?: any, extensions?: any } | null | undefined} node */
export function isDockedNote(node) {
  return isNoteNode(node) && (node?.parent_id ?? null) !== null
    && (node?.view?.docked === true || node?.extensions?.note?.docked === true);
}

/** @param {{ origin?: unknown, parent_id?: unknown, view?: any, extensions?: any } | null | undefined} node */
export function isReactionNote(node) {
  return isDockedNote(node)
    && (node?.view?.reaction === true || node?.extensions?.note?.reaction === true);
}

/** @param {unknown} type @param {string} [selectedText] */
export function normalizeBranchType(type, selectedText = "") {
  const key = String(type ?? "").trim();
  if (key === BRANCH_SELECTION || key === BRANCH_FOLLOWUP) return key;
  return selectedText ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
}

/** @param {{ origin?: any, parent_id?: unknown } | null | undefined} node */
export function branchTypeOfNode(node) {
  if (!node || (!node.origin && !node.parent_id)) return null;
  const type = node.origin?.branch_type;
  if (type === BRANCH_SELECTION || type === BRANCH_FOLLOWUP) return type;
  if (node.parent_id && node.origin?.kind === "note") {
    return node.origin.anchor || node.origin.selected_text ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
  }
  return null;
}

/**
 * Derive the canonical Ask from a schema-v2 node. The persisted `origin`
 * spelling remains unchanged so old Rabbitholes and MCP clients keep working;
 * all new domain logic can use this one shape instead of reinterpreting seven
 * legacy flags independently.
 *
 * @param {HoleNode} node
 * @returns {import("../contracts/engine.js").Ask | null}
 */
export function askOfNode(node) {
  const origin = node?.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return null;
  const raw = /** @type {Record<string, any>} */ (origin);
  const owned = raw.kind === "note" || "question" in raw || "selected_text" in raw || "anchor" in raw
    || "branch_type" in raw || "lens" in raw || "instruction" in raw || "attachment_assets" in raw || "crop_asset" in raw
    || "web_root_question" in raw;
  if (!owned) return null;
  const isRootQuestion = typeof raw.web_root_question === "string";
  const note = raw.kind === "note";
  const question = isRootQuestion
    ? raw.web_root_question
    : note ? String(node.markdown ?? "") : String(raw.question ?? "");
  const attachmentAssets = normalizeAskAttachments(raw.attachment_assets);
  let clip = null;
  try { clip = raw.crop_asset == null ? null : validateAssetName(raw.crop_asset); } catch {}
  const error = normalizeAskError(/** @type {any} */ (node).error);
  const status = node.status === "pending" ? "requested" : error ? "failed" : "settled";
  return {
    id: String(node.id),
    at: {
      node_id: isRootQuestion ? null : (node.parent_id == null ? null : String(node.parent_id)),
      anchor: note || !isRootQuestion ? normalizeAnchor(raw.anchor) : null,
    },
    question,
    lens: typeof raw.lens === "string" ? raw.lens : null,
    instruction: typeof raw.instruction === "string" ? raw.instruction : null,
    attachments: attachmentAssets,
    clip,
    author: note && raw.author !== "agent" ? "human" : "agent",
    produces: String(node.id),
    state: status,
    run: null,
    delegated: /** @type {any} */ (node).delegated === true,
    error,
  };
}

/** @param {unknown} value @returns {import("../contracts/engine.js").Ask} */
export function validateAsk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ask must be an object");
  const ask = /** @type {Record<string, any>} */ (value);
  if (typeof ask.id !== "string" || !ask.id) throw new Error("Ask id must be a non-empty string");
  if (!ask.at || typeof ask.at !== "object" || Array.isArray(ask.at)) throw new Error(`Ask ${ask.id} at must be an object`);
  if (ask.at.node_id !== null && typeof ask.at.node_id !== "string") throw new Error(`Ask ${ask.id} at.node_id must be string or null`);
  if (ask.at.anchor !== null && !normalizeAnchor(ask.at.anchor)) throw new Error(`Ask ${ask.id} anchor is invalid`);
  if (typeof ask.question !== "string") throw new Error(`Ask ${ask.id} question must be a string`);
  if (ask.lens !== null && typeof ask.lens !== "string") throw new Error(`Ask ${ask.id} lens must be string or null`);
  if (ask.instruction !== null && typeof ask.instruction !== "string") throw new Error(`Ask ${ask.id} instruction must be string or null`);
  validateAskAttachments(ask.attachments, `Ask ${ask.id} attachments`);
  if (ask.clip !== null) validateAssetName(ask.clip);
  if (ask.author !== "human" && ask.author !== "agent") throw new Error(`Ask ${ask.id} author is invalid`);
  if (typeof ask.produces !== "string" || !ask.produces) throw new Error(`Ask ${ask.id} produces must be a non-empty string`);
  if (!["requested", "streaming", "settled", "failed"].includes(ask.state)) throw new Error(`Ask ${ask.id} state is invalid`);
  if (ask.run !== null && (!ask.run || typeof ask.run.id !== "string" || !Number.isFinite(ask.run.seq))) throw new Error(`Ask ${ask.id} run is invalid`);
  if (typeof ask.delegated !== "boolean") throw new Error(`Ask ${ask.id} delegated must be a boolean`);
  if (ask.error !== null && !normalizeAskError(ask.error)) throw new Error(`Ask ${ask.id} error is invalid`);
  return /** @type {import("../contracts/engine.js").Ask} */ (value);
}

/**
 * Validate every schema-v2 origin shape that Rabbithole owns. Unknown legacy
 * shapes remain opaque for backwards compatibility; recognized Ask fields do
 * not get the old unchecked escape hatch.
 * @param {unknown} origin
 * @param {string} nodeId
 */
export function validateLegacyAskOrigin(origin, nodeId) {
  if (origin === null) return true;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) throw new Error(`Persisted node ${nodeId} origin must be object or null`);
  const raw = /** @type {Record<string, any>} */ (origin);
  const owned = raw.kind === "note" || "question" in raw || "selected_text" in raw || "anchor" in raw
    || "branch_type" in raw || "lens" in raw || "instruction" in raw || "attachment_assets" in raw || "crop_asset" in raw
    || "web_root_question" in raw;
  if (!owned) return true;
  if (raw.kind !== undefined && raw.kind !== "note") throw new Error(`Persisted node ${nodeId} origin.kind is invalid`);
  if (raw.author !== undefined && raw.author !== "human" && raw.author !== "agent") throw new Error(`Persisted node ${nodeId} origin.author is invalid`);
  for (const field of ["question", "selected_text", "web_root_question"]) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error(`Persisted node ${nodeId} origin.${field} must be a string`);
  }
  if (raw.lens !== undefined && raw.lens !== null && typeof raw.lens !== "string") throw new Error(`Persisted node ${nodeId} origin.lens must be string or null`);
  if (raw.instruction !== undefined && raw.instruction !== null && typeof raw.instruction !== "string") throw new Error(`Persisted node ${nodeId} origin.instruction must be string or null`);
  if (raw.branch_type !== undefined && ![BRANCH_SELECTION, BRANCH_FOLLOWUP].includes(raw.branch_type)) throw new Error(`Persisted node ${nodeId} origin.branch_type is invalid`);
  if (raw.anchor !== undefined && raw.anchor !== null && !normalizeAnchor(raw.anchor)) throw new Error(`Persisted node ${nodeId} origin.anchor is invalid`);
  if (raw.attachment_assets !== undefined) {
    if (!Array.isArray(raw.attachment_assets) || raw.attachment_assets.length > MAX_ASK_ATTACHMENTS) throw new Error(`Persisted node ${nodeId} origin.attachments are invalid`);
    // Schema-v2 files historically admitted arbitrary strings here and the
    // host filtered unsafe or missing assets when rehydrating an Ask. Keep old
    // files open while `askOfNode()` produces the strict, sanitized Ask shape.
    for (const name of raw.attachment_assets) if (typeof name !== "string") throw new Error(`Persisted node ${nodeId} origin.attachments are invalid`);
  }
  if (raw.crop_asset !== undefined && raw.crop_asset !== null && typeof raw.crop_asset !== "string") throw new Error(`Persisted node ${nodeId} origin.crop_asset is invalid`);
  return true;
}

/** @param {HoleNode} node @param {"requested" | "streaming" | "settled" | "failed"} state @returns {import("../contracts/engine.js").Ask} */
export function makeTranscribeAsk(node, state) {
  return {
    id: `transcribe:${node.id}`,
    at: { node_id: node.id, anchor: null },
    question: "Create a text version of this PDF.",
    lens: null,
    instruction: null,
    attachments: [],
    clip: null,
    author: /** @type {const} */ ("agent"),
    produces: node.id,
    state,
    run: null,
    delegated: false,
    error: null,
  };
}

/** @param {HoleNode} node @returns {Record<string, any>} */
export function noteEntry(node) {
  const author = /** @type {{ author?: unknown } | null | undefined} */ (node.origin)?.author === "agent" ? "agent" : "human";
  return {
    note_id: node.id,
    on_node_id: node.parent_id,
    on_selected_text: (/** @type {{ selected_text?: string } | null | undefined} */ (node.origin))?.selected_text || null,
    content: isReactionNote(node) ? reactionInstructionForNode(node) : node.markdown,
    ...(author === "agent" ? { author } : {}),
    created_at: node.created_at,
  };
}

/** @param {HoleNode} a @param {HoleNode} b */
export function standaloneFirstByAge(a, b) {
  const scope = Number(a.parent_id !== null) - Number(b.parent_id !== null);
  return scope || String(a.created_at || "").localeCompare(String(b.created_at || ""));
}

/** @param {NodeCollection} nodes @returns {Record<string, any>[]} */
export function collectAllNotes(nodes) {
  return [...valuesOfNodes(nodes)].filter(isNoteNode).sort(standaloneFirstByAge).map(noteEntry);
}

/** @param {NodeCollection} nodes @param {string} parentId @param {{ includeLineage?: boolean }} [options] @returns {Record<string, any>[]} */
export function collectRelevantNotes(nodes, parentId, options = {}) {
  const lineage = lineageNodesFromMap(nodes, parentId);
  const lineageIds = new Set(lineage.map((node) => node.id));
  const ambient = [...valuesOfNodes(nodes)]
    .filter((node) => isNoteNode(node)
      && !lineageIds.has(node.id)
      && (node.parent_id === null || (typeof node.parent_id === "string" && lineageIds.has(node.parent_id))))
    .sort(standaloneFirstByAge)
    .map(noteEntry);
  if (!options.includeLineage) return ambient;
  const thread = lineage.filter(isNoteNode).map((node) => ({ ...noteEntry(node), on_lineage: true }));
  return [...thread, ...ambient];
}

/** @param {unknown} value */
function normalizeAskError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = /** @type {Record<string, any>} */ (value);
  if (typeof raw.message !== "string") return null;
  return {
    message: raw.message,
    code: typeof raw.code === "string" ? raw.code : null,
    retryable: raw.retryable === true,
  };
}
