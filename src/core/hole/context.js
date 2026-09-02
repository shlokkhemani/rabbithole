import { isNoteNode, noteEntry, standaloneFirstByAge } from "./ask.js";
import { depthFirstNodes, lineageNodesFromMap, valuesOfNodes } from "./tree.js";

/** @typedef {import("../contracts/engine.js").HoleNode} HoleNode */
/** @typedef {Map<string, HoleNode> | Record<string, HoleNode>} NodeCollection */
/** @typedef {Map<string, string> | Record<string, string>} HashCollection */

/**
 * Compact, canvas-wide context index shared by live delivery and disk reads.
 * Hashes are supplied by the host so this core module remains isomorphic.
 * @param {NodeCollection} nodes
 * @param {string | null} rootId
 * @param {{ deliveredNoteHashes?: HashCollection, noteHashes?: HashCollection }} [options]
 */
export function buildMap(nodes, rootId, { deliveredNoteHashes = new Map(), noteHashes = new Map() } = {}) {
  return {
    nodes: depthFirstNodes(nodes, rootId)
      .filter((node) => !isNoteNode(node))
      .map((node) => ({
        id: node.id,
        parent: node.parent_id ?? null,
        title: node.title || "Untitled",
        status: node.status === "pending" ? "pending" : "answered",
      })),
    notes: orderedNoteNodes(nodes).map((node) => {
      const entry = noteEntry(node);
      const currentHash = hashValue(noteHashes, node.id);
      return {
        id: node.id,
        on: node.parent_id ?? null,
        preview: singleLinePreview(entry.content),
        new: currentHash === undefined || hashValue(deliveredNoteHashes, node.id) !== currentHash,
      };
    }),
  };
}

/**
 * Full notes for one branch delivery: lineage notes are always included and
 * flagged, while every other note is included only when its content is new.
 * @param {NodeCollection} nodes
 * @param {string} parentId
 * @param {{ deliveredNoteHashes?: HashCollection, noteHashes?: HashCollection }} [options]
 * @returns {Record<string, any>[]}
 */
export function collectBranchNotes(nodes, parentId, { deliveredNoteHashes = new Map(), noteHashes = new Map() } = {}) {
  const lineage = lineageNodesFromMap(nodes, parentId);
  const lineageNotes = lineage.filter(isNoteNode);
  const lineageIds = new Set(lineageNotes.map((node) => node.id));
  const newlyChanged = orderedNoteNodes(nodes)
    .filter((node) => !lineageIds.has(node.id)
      && isNewNote(node.id, deliveredNoteHashes, noteHashes));
  return [
    ...lineageNotes.map((node) => ({ ...noteEntry(node), on_lineage: true })),
    ...newlyChanged.map(noteEntry),
  ];
}

/**
 * Full notes not yet delivered at their current content hash.
 * @param {NodeCollection} nodes
 * @param {{ deliveredNoteHashes?: HashCollection, noteHashes?: HashCollection }} [options]
 * @returns {Record<string, any>[]}
 */
export function collectNewNotes(nodes, { deliveredNoteHashes = new Map(), noteHashes = new Map() } = {}) {
  return orderedNoteNodes(nodes)
    .filter((node) => isNewNote(node.id, deliveredNoteHashes, noteHashes))
    .map(noteEntry);
}

/**
 * Character budget for an auto-sent thread. A thread scales with lineage
 * depth and answer length, not canvas size, so it is the one branch payload
 * that needs a ceiling. Entries are admitted nearest-first (the parent holds
 * the selection); anything past the budget is stubbed with `omitted: true`
 * so the agent can fetch it deliberately with read_rabbithole.
 */
export const THREAD_BUDGET_CHARS = 24000;

/**
 * The lineage entries the agent provably never received, in root→node order.
 * Note nodes on the lineage travel as `on_lineage` notes, and pending nodes
 * have no markdown yet, so neither belongs here.
 * @param {NodeCollection} nodes
 * @param {string} nodeId
 * @param {{ delivered: Set<string>, budget?: number }} options
 */
export function buildUndeliveredThread(nodes, nodeId, { delivered, budget = THREAD_BUDGET_CHARS }) {
  const undelivered = lineageNodesFromMap(nodes, nodeId)
    .filter((node) => !isNoteNode(node) && node.status !== "pending" && !delivered.has(node.id));
  let remaining = budget;
  const entries = new Map();
  for (const node of [...undelivered].reverse()) {
    const entry = buildNodeContext(nodes, node);
    const size = JSON.stringify(entry).length;
    if (size > remaining) continue;
    remaining -= size;
    entries.set(node.id, entry);
  }
  return undelivered.map((node) => entries.get(node.id)
    || { id: node.id, title: node.title || "Untitled", chars: String(node.markdown || "").length, omitted: true });
}

/** @param {NodeCollection} nodes @param {string} nodeId */
export function buildThread(nodes, nodeId) {
  return lineageNodesFromMap(nodes, nodeId)
    .filter((node) => node.status !== "pending")
    .map((node) => buildNodeContext(nodes, node));
}

/** @param {NodeCollection} nodes @param {HoleNode} node */
export function buildNodeContext(nodes, node) {
  const notes = [...valuesOfNodes(nodes)]
    .filter((candidate) => isNoteNode(candidate) && candidate.parent_id === node.id)
    .sort(standaloneFirstByAge)
    .map(noteEntry);
  return {
    id: node.id,
    title: node.title || "Untitled",
    markdown: node.markdown || "",
    notes,
  };
}

/** @param {NodeCollection} nodes */
function orderedNoteNodes(nodes) {
  return [...valuesOfNodes(nodes)].filter(isNoteNode).sort(standaloneFirstByAge);
}

/** @param {unknown} content */
function singleLinePreview(content) {
  return String(content ?? "").replace(/\s+/gu, " ").trim().slice(0, 60);
}

/** @param {HashCollection} hashes @param {string} id */
function hashValue(hashes, id) {
  return hashes instanceof Map ? hashes.get(id) : hashes?.[id];
}

/** @param {string} id @param {HashCollection} delivered @param {HashCollection} current */
function isNewNote(id, delivered, current) {
  const currentHash = hashValue(current, id);
  return currentHash === undefined || hashValue(delivered, id) !== currentHash;
}
