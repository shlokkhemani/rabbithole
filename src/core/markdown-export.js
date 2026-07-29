import { toPersistedNoraDocument } from "./document-schema.js";

/** @typedef {import("./contracts/document.js").NoraDocument} NoraDocument */
/** @typedef {import("./contracts/document.js").NoraNode} NoraNode */
/** @typedef {import("./contracts/evidence.js").EvidenceRecord} EvidenceRecord */

/** @param {NoraDocument} document */
export function createMarkdownExport(document) {
  const persisted = toPersistedNoraDocument(document);
  const ordered = graphOrder(persisted);
  const usedEvidence = collectUsedEvidence(persisted, ordered);
  const sections = ordered.map((node) => renderNodeSection(node, nodeDepth(persisted, node)));
  if (usedEvidence.length) sections.push(renderEvidenceFootnotes(usedEvidence));
  return `${sections.filter(Boolean).join("\n\n---\n\n").trim()}\n`;
}

/**
 * @param {NoraNode} node
 * @param {number} depth
 */
function renderNodeSection(node, depth) {
  const heading = `${"#".repeat(Math.min(6, depth + 1))} ${node.title || "Untitled"}`;
  const lines = [heading];
  const origin = originLine(node);
  if (origin) lines.push("", origin);
  if (node.state !== "complete") lines.push("", `> Status: ${node.state}`);
  const body = node.markdown.trim() || "_(still being written)_";
  lines.push("", body);
  if (node.evidenceIds.length) lines.push("", `Evidence: ${node.evidenceIds.map(footnoteLabel).join(" ")}`);
  return lines.join("\n");
}

/** @param {NoraNode} node */
function originLine(node) {
  const origin = node.origin && typeof node.origin === "object" && !Array.isArray(node.origin)
    ? /** @type {Record<string, unknown>} */ (node.origin)
    : null;
  if (!origin) return "";
  if (origin.synthesis === true) return "> Synthesis of the whole Nora document";
  const question = String(origin.question ?? "").trim();
  const selected = String(origin.selected_text ?? "").trim();
  if (selected) return `> Asked about: ${selected}${question ? ` - ${question}` : ""}`;
  return question ? `> Follow-up: ${question}` : "";
}

/** @param {EvidenceRecord[]} evidence */
function renderEvidenceFootnotes(evidence) {
  return [
    "## Evidence",
    ...evidence.map((record) => {
      const parts = [`${footnoteLabel(record.id)}: ${record.title || record.sourceType}`];
      if (record.permalink) parts.push(record.permalink);
      if (record.commit) parts.push(`commit ${record.commit}`);
      if (record.revision) parts.push(`revision ${record.revision}`);
      const line = parts.join(" - ");
      return record.excerpt ? `${line}\n    ${record.excerpt}` : line;
    }),
  ].join("\n\n");
}

/** @param {NoraDocument} document @param {NoraNode[]} ordered */
function collectUsedEvidence(document, ordered) {
  const byId = new Map(document.evidence.map((record) => [record.id, record]));
  const seen = new Set();
  /** @type {EvidenceRecord[]} */
  const out = [];
  for (const node of ordered) {
    for (const evidenceId of node.evidenceIds) {
      if (seen.has(evidenceId)) continue;
      const record = byId.get(evidenceId);
      if (!record) continue;
      seen.add(evidenceId);
      out.push(record);
    }
  }
  return out;
}

/** @param {NoraDocument} document @returns {NoraNode[]} */
function graphOrder(document) {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  /** @type {Map<string, NoraNode[]>} */
  const children = new Map();
  for (const node of document.nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort(compareNodeOrder);
  /** @type {NoraNode[]} */
  const ordered = [];
  const seen = new Set();
  const visit = (/** @type {NoraNode | undefined} */ node) => {
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    ordered.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  visit(nodes.get(document.rootNodeId));
  for (const node of [...document.nodes].sort(compareNodeOrder)) visit(node);
  return ordered;
}

/**
 * @param {NoraNode} left
 * @param {NoraNode} right
 */
function compareNodeOrder(left, right) {
  const y = Number(left.position?.y ?? 0) - Number(right.position?.y ?? 0);
  if (y) return y;
  const x = Number(left.position?.x ?? 0) - Number(right.position?.x ?? 0);
  if (x) return x;
  return left.id.localeCompare(right.id);
}

/** @param {NoraDocument} document @param {NoraNode} node */
function nodeDepth(document, node) {
  const byId = new Map(document.nodes.map((entry) => [entry.id, entry]));
  let depth = 0;
  let cursor = node.parentId ? byId.get(node.parentId) : null;
  const seen = new Set([node.id]);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    depth += 1;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }
  return depth;
}

/** @param {unknown} id */
function footnoteLabel(id) {
  const safe = String(id || "evidence")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "evidence";
  return `[^${safe}]`;
}
