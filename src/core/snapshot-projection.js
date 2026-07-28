import { getAssetContentType } from "./assets.js";
import { documentStateToHydrationNodes } from "./document-state.js";
import { normalizeNoraNodeState, noraStateToRendererStatus, toPersistedNoraDocument } from "./document-schema.js";
import { createPortableProjection } from "./portable-projection.js";
import { extractNodeAssetRefs } from "./assets.js";

/** @typedef {import("./contracts/artifact.js").PersistedHole} PersistedHole */
/** @typedef {import("./contracts/artifact.js").PortableArtifact} PortableArtifact */
/** @typedef {import("./contracts/document.js").NoraDocument} NoraDocument */
/** @typedef {import("./contracts/document.js").NoraNode} NoraNode */

const NORA_SNAPSHOT_FORMAT = "nora-snapshot";
const NORA_SNAPSHOT_FORMAT_VERSION = 1;

/**
 * @param {PersistedHole} hole
 * @param {PersistedHole["view_state"]} viewState
 * @param {Record<string, string>} assets
 * @returns {PortableArtifact}
 */
export function createSnapshotProjection(hole, viewState, assets) {
  const projection = createPortableProjection({ ...hole, view_state: viewState }, assets);
  // Shares exclude personal extension state. Native PDF provenance is document
  // content, not a preference, and is required to render the embedded source.
  projection.hole = {
    ...projection.hole,
    nodes: projection.hole.nodes.map((node) => ({ ...node, extensions: node.extensions?.pdf ? { pdf: node.extensions.pdf } : {} })),
  };
  return projection;
}

/**
 * @param {NoraDocument} document
 * @param {NoraDocument["viewState"]} viewState
 * @param {Record<string, string>} assets
 */
export function createNoraSnapshotProjection(document, viewState, assets = {}) {
  const persisted = toPersistedNoraDocument(document);
  const referencedAssets = new Set(collectNoraSnapshotAssetNames(persisted));
  return {
    format: NORA_SNAPSHOT_FORMAT,
    formatVersion: NORA_SNAPSHOT_FORMAT_VERSION,
    document: sanitizeNoraSnapshotDocument({
      ...persisted,
      viewState: viewState ?? persisted.viewState,
    }),
    assets: Object.fromEntries(
      Object.entries(assets)
        .filter(([name]) => referencedAssets.has(name))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/** @param {NoraDocument} document */
export function collectNoraSnapshotAssetNames(document) {
  const names = new Set();
  for (const node of document.nodes) {
    for (const name of extractNodeAssetRefs(noraNodeToHydrationNode(node))) names.add(name);
  }
  return [...names].sort();
}

/** @param {PortableArtifact | ReturnType<typeof createNoraSnapshotProjection>} projection */
export function snapshotProjectionToFrozenHydration(projection) {
  if (projection?.format === NORA_SNAPSHOT_FORMAT) return noraSnapshotProjectionToFrozenHydration(projection);
  const portableProjection = /** @type {PortableArtifact} */ (projection);
  const hole = portableProjection.hole;
  /** @type {Record<string, string>} */
  const assetData = {};
  for (const [name, encoded] of Object.entries(portableProjection.assets)) {
    assetData[name] = `data:${getAssetContentType(name)};base64,${encoded}`;
  }
  return {
    session_id: `snapshot-${hole.hole_id}`,
    hole_id: hole.hole_id,
    title: hole.title,
    root_id: hole.root_id,
    last_event_id: 0,
    agent_attached: false,
    view_state: hole.view_state,
    frozen: true,
    asset_data: assetData,
    nodes: hole.nodes,
  };
}

/** @param {ReturnType<typeof createNoraSnapshotProjection>} projection */
function noraSnapshotProjectionToFrozenHydration(projection) {
  const document = projection.document;
  /** @type {Record<string, string>} */
  const assetData = {};
  for (const [name, encoded] of Object.entries(projection.assets)) {
    assetData[name] = `data:${getAssetContentType(name)};base64,${encoded}`;
  }
  return {
    session_id: `snapshot-${document.documentId}`,
    hole_id: document.documentId,
    title: document.title,
    root_id: document.rootNodeId,
    last_event_id: 0,
    agent_attached: false,
    view_state: document.viewState,
    frozen: true,
    asset_data: assetData,
    nodes: documentStateToHydrationNodes({
      ...document,
      nodes: new Map(document.nodes.map((node) => [node.id, node])),
      edges: new Map(document.edges.map((edge) => [edge.id, edge])),
      sources: new Map(document.sources.map((source) => [source.id, source])),
      evidence: new Map(document.evidence.map((evidence) => [evidence.id, evidence])),
      attachments: new Map(document.attachments.map((attachment) => [attachment.id, attachment])),
      runs: new Map(),
      checks: new Map(document.checks.map((check) => [check.id, check])),
      revision: 0,
      progressRuns: new Map(),
    }),
    nora: {
      revision: 0,
      runByteCutoffs: {},
      runs: [],
      evidence: document.evidence,
      sources: document.sources,
    },
  };
}

/** @param {NoraDocument} document @returns {NoraDocument} */
function sanitizeNoraSnapshotDocument(document) {
  const usedEvidenceIds = new Set(document.nodes.flatMap((node) => node.evidenceIds));
  const usedSourceIds = new Set(document.evidence.filter((evidence) => usedEvidenceIds.has(evidence.id)).map((evidence) => evidence.sourceId).filter(Boolean));
  const usedAttachmentIds = new Set(document.nodes.flatMap((node) => node.attachmentIds));
  return {
    ...document,
    selection: null,
    selectedProfileId: null,
    nodes: document.nodes.map(sanitizeNoraNodeForSnapshot),
    edges: document.edges.map((edge) => ({ ...edge, extensions: {} })),
    sources: document.sources
      .filter((source) => usedSourceIds.has(source.id))
      .map((source) => ({
        id: source.id,
        type: source.type,
        stableLocator: sanitizeStableLocator(source.stableLocator),
        title: source.title,
        revision: source.revision,
        commit: source.commit,
        capturedAt: source.capturedAt,
        extensions: {},
      })),
    evidence: document.evidence
      .filter((evidence) => usedEvidenceIds.has(evidence.id))
      .map((evidence) => ({
        id: evidence.id,
        sourceId: evidence.sourceId,
        sourceType: evidence.sourceType,
        stableLocator: sanitizeStableLocator(evidence.stableLocator),
        title: evidence.title,
        excerpt: evidence.excerpt,
        revision: evidence.revision,
        commit: evidence.commit,
        permalink: evidence.permalink,
        capturedAt: evidence.capturedAt,
        range: sanitizeStableLocator(evidence.range),
        extensions: {},
      })),
    attachments: document.attachments
      .filter((attachment) => usedAttachmentIds.has(attachment.id))
      .map((attachment) => ({
        ...attachment,
        extensions: pickAttachmentSnapshotExtensions(attachment.extensions),
      })),
    runs: [],
    checks: document.checks.map((check) => ({
      id: check.id,
      nodeId: check.nodeId,
      blockId: check.blockId,
      state: {},
      createdAt: check.createdAt,
      updatedAt: null,
      extensions: {},
    })),
    extensions: {},
  };
}

/** @param {NoraNode} node @returns {NoraNode} */
function sanitizeNoraNodeForSnapshot(node) {
  return {
    ...node,
    state: normalizeNoraNodeState(node.state),
    runId: null,
    extensions: node.extensions?.pdf ? { pdf: node.extensions.pdf } : {},
  };
}

/** @param {NoraNode} node */
function noraNodeToHydrationNode(node) {
  return {
    id: node.id,
    parent_id: node.parentId,
    title: node.title,
    markdown: node.markdown,
    origin: node.origin,
    status: noraStateToRendererStatus(node.state),
    extensions: node.extensions,
  };
}

/** @param {unknown} value @returns {unknown} */
function sanitizeStableLocator(value) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeStableLocator);
  if (typeof value !== "object") return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (/^(?:cache|cwd|home|local|worktree|absolute)?path$/i.test(key)) continue;
    if (/token|credential|secret|authorization|api[-_]?key/i.test(key)) continue;
    out[key] = sanitizeStableLocator(entry);
  }
  return out;
}

/** @param {Record<string, unknown>} extensions */
function pickAttachmentSnapshotExtensions(extensions) {
  const assetName = extensions && typeof extensions.assetName === "string" ? extensions.assetName : null;
  return assetName ? { assetName } : {};
}
