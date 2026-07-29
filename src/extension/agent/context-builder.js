const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_RESPONSE_ROOM = 4096;

/**
 * @typedef {{
 *   scope: { type: "whole_canvas" } | { type: "node", node_id?: string, nodeId?: string },
 *   prompt: string,
 *   projection: string,
 *   targetNodeId: string | null,
 *   parentRunId: string | null,
 *   includedNodeIds: string[],
 *   evidenceIds: string[],
 *   estimatedTokens: number,
 *   contextWindow: number
 * }} NoraRunContext
 */

/**
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {{
 *   prompt: unknown,
 *   scope?: unknown,
 *   targetNodeId?: unknown,
 *   model?: Record<string, any> | null,
 *   estimateTokens?: (text: string) => number,
 *   responseRoomTokens?: number,
 * }} options
 * @returns {NoraRunContext}
 */
export function buildRunContext(document, options) {
  const prompt = String(options.prompt ?? "").trim();
  if (!prompt) throw new TypeError("Ask Nora prompt is required");
  const scope = normalizeScope(options.scope);
  const estimateTokens = options.estimateTokens ?? approximateTokens;
  const contextWindow = modelContextWindow(options.model);
  const responseRoom = options.responseRoomTokens ?? DEFAULT_RESPONSE_ROOM;
  const projection = scope.type === "whole_canvas"
    ? wholeCanvasProjection(document)
    : selectedNodeProjection(document, nodeIdFromScope(scope));
  const preflightText = [
    "Nora research context:",
    projection.text,
    "",
    "User prompt:",
    prompt,
  ].join("\n");
  const estimatedTokens = estimateTokens(preflightText);
  if (estimatedTokens + responseRoom > contextWindow) {
    throw new Error(`Nora context is too large for the selected model (${estimatedTokens + responseRoom}/${contextWindow} estimated tokens). Select a narrower node.`);
  }
  return {
    scope,
    prompt,
    projection: projection.text,
    targetNodeId: projection.targetNodeId,
    parentRunId: projection.parentRunId,
    includedNodeIds: /** @type {string[]} */ (projection.includedNodeIds),
    evidenceIds: /** @type {string[]} */ (projection.evidenceIds),
    estimatedTokens,
    contextWindow,
  };
}

/** @param {unknown} scope */
export function normalizeScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return /** @type {{ type: "whole_canvas" }} */ ({ type: "whole_canvas" });
  const raw = /** @type {Record<string, unknown>} */ (scope);
  if (raw.type === "whole_canvas") return /** @type {{ type: "whole_canvas" }} */ ({ type: "whole_canvas" });
  if (raw.type === "node") {
    const nodeId = String(raw.node_id ?? raw.nodeId ?? "");
    if (!nodeId) throw new TypeError("node scope requires node_id");
    return /** @type {{ type: "node", node_id: string }} */ ({ type: "node", node_id: nodeId });
  }
  throw new TypeError(`Unsupported Nora run scope: ${String(raw.type)}`);
}

/**
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {string} targetNodeId
 */
function selectedNodeProjection(document, targetNodeId) {
  const byId = document.state.nodes;
  const target = byId.get(targetNodeId);
  if (!target) throw new TypeError(`Selected Nora node ${targetNodeId} does not exist`);
  /** @type {import("../../core/contracts/document.js").NoraNode[]} */
  const lineage = [];
  /** @type {import("../../core/contracts/document.js").NoraNode | null} */
  let cursor = target;
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    lineage.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) ?? null : null;
  }
  lineage.reverse();
  const evidenceIds = unique(/** @type {unknown[]} */ (lineage.flatMap((node) => node.evidenceIds)));
  const parentRunId = [...lineage].reverse().find((node) => node.runId)?.runId ?? null;
  return {
    text: [
      "Scope: selected node",
      ...lineage.map((node, index) => renderNode(document, node, index)),
      renderEvidence(document, /** @type {string[]} */ (evidenceIds)),
    ].filter(Boolean).join("\n\n"),
    targetNodeId,
    parentRunId,
    includedNodeIds: lineage.map((node) => node.id),
    evidenceIds,
  };
}

/** @param {import("../nora-document.js").NoraDocument} document */
function wholeCanvasProjection(document) {
  const ordered = graphOrder(document);
  const evidenceIds = unique(/** @type {unknown[]} */ (ordered.flatMap((node) => node.evidenceIds)));
  return {
    text: [
      "Scope: whole canvas",
      ...ordered.map((node, index) => renderNode(document, node, index)),
      renderEvidence(document, /** @type {string[]} */ (evidenceIds)),
    ].filter(Boolean).join("\n\n"),
    targetNodeId: null,
    parentRunId: null,
    includedNodeIds: ordered.map((node) => node.id),
    evidenceIds,
  };
}

/** @param {import("../nora-document.js").NoraDocument} document */
function graphOrder(document) {
  const nodes = document.state.nodes;
  /** @type {Map<string, import("../../core/contracts/document.js").NoraNode[]>} */
  const children = new Map();
  for (const node of nodes.values()) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) {
    list.sort((left, right) => {
      const y = Number(left.position?.y ?? 0) - Number(right.position?.y ?? 0);
      if (y) return y;
      const x = Number(left.position?.x ?? 0) - Number(right.position?.x ?? 0);
      if (x) return x;
      return left.id.localeCompare(right.id);
    });
  }
  const root = nodes.get(document.state.rootNodeId);
  /** @type {import("../../core/contracts/document.js").NoraNode[]} */
  const ordered = [];
  /** @param {import("../../core/contracts/document.js").NoraNode | undefined} node */
  const visit = (node) => {
    if (!node) return;
    ordered.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  visit(root);
  for (const node of [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!ordered.includes(node)) ordered.push(node);
  }
  return ordered;
}

/**
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {import("../../core/contracts/document.js").NoraNode} node
 * @param {number} index
 */
function renderNode(document, node, index) {
  const origin = node.origin && typeof node.origin === "object" && !Array.isArray(node.origin)
    ? /** @type {Record<string, unknown>} */ (node.origin)
    : null;
  const lines = [
    `Node ${index + 1}: ${node.title || node.id}`,
    `id: ${node.id}`,
    node.parentId ? `parent: ${node.parentId}` : null,
    node.runId ? `run: ${node.runId}` : null,
    origin?.question ? `question: ${String(origin.question)}` : null,
    origin?.selected_text ? `selected text: ${String(origin.selected_text)}` : null,
    node.evidenceIds.length ? `evidence: ${node.evidenceIds.join(", ")}` : null,
    "",
    node.markdown,
  ];
  return lines.filter((line) => line !== null).join("\n").trim();
}

/**
 * @param {import("../nora-document.js").NoraDocument} document
 * @param {string[]} evidenceIds
 */
function renderEvidence(document, evidenceIds) {
  if (!evidenceIds.length) return "";
  const lines = ["Evidence:"];
  for (const evidenceId of evidenceIds) {
    const evidence = document.state.evidence.get(evidenceId);
    if (!evidence) continue;
    lines.push(`- ${evidence.id}: ${evidence.title || evidence.sourceType}`);
    if (evidence.commit) lines.push(`  commit: ${evidence.commit}`);
    if (evidence.permalink) lines.push(`  permalink: ${evidence.permalink}`);
    if (evidence.excerpt) lines.push(`  excerpt: ${evidence.excerpt}`);
  }
  return lines.join("\n");
}

/** @param {{ type: string, node_id?: string, nodeId?: string }} scope */
function nodeIdFromScope(scope) {
  return String(scope.node_id ?? scope.nodeId ?? "");
}

/** @param {unknown[]} values */
function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

/** @param {unknown} model */
function modelContextWindow(model) {
  const raw = /** @type {Record<string, any> | null} */ (model && typeof model === "object" ? model : null);
  const value = raw?.contextWindow ?? raw?.context_window ?? raw?.maxContextTokens ?? raw?.max_context_tokens;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : DEFAULT_CONTEXT_WINDOW;
}

/** @param {string} text */
function approximateTokens(text) {
  return Math.ceil(text.length / 4);
}
