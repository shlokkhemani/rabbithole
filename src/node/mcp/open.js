import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { log } from "../shared/logger.js";
import { buildCanvasHtml } from "./http/page.js";
import { createSession, getSession, getSessionByHole, closeSessionsForHole } from "./registry.js";
import { addAssetsToHole, defaultFsStore } from "./store/fs-store.js";
import { deriveNodeBaseUrl, normalizeBaseUrl } from "../../core/base-url.js";
import { normalizeBlockIds } from "../../core/blocks.js";
import { DEFAULT_CHILD, DEFAULT_ROOT, DEFAULT_STANDALONE_NOTE, TREE_PARENT_GAP, placeChild } from "../../core/layout.js";
import { BRANCH_FOLLOWUP, isDockedNote, isNoteNode } from "../../core/hole/ask.js";
import { makeNode } from "../../core/hole/node.js";
import { createHoleState, holeStateToHole, reduceHoleEvent } from "../../core/hole/reduce.js";
import { ingestPdfDocument, isPdfFile } from "./pdf/ingest.js";
import { normalizeId } from "../../core/utils.js";
import { shortId } from "../shared/ids.js";

async function resolveMarkdown({ content, filePath }) {
  if (content) return content;
  if (filePath) return fs.readFile(filePath, "utf-8");
  throw new Error("Either content or file_path must be provided");
}

/**
 * Open a new Rabbithole from a document, or resume a saved one by hole_id.
 * Blocks until the first browser event (a branch_request, or session_closed).
 * `signal` is the MCP request's AbortSignal — if the human cancels the tool
 * call, the session tells the browser the agent detached.
 * @param {{
 *   title?: string,
 *   content?: string,
 *   filePath?: string,
 *   holeId?: string,
 *   baseUrl?: string,
 *   assets?: Array<{name: string, file_path: string}>,
 *   focus?: boolean,
 *   signal?: AbortSignal,
 * }} input
 */
export async function openRabbithole({ title, content, filePath, holeId, baseUrl, assets, focus, signal }) {
  holeId = normalizeId(holeId);
  if (holeId) {
    return resumeRabbithole(holeId, signal, assets, focus);
  }

  const pdf = !content && filePath && await isPdfFile(filePath)
    ? await ingestPdfDocument({ filePath, store: defaultFsStore, title })
    : null;
  const resolvedTitle = pdf?.title || title || "Document";
  log(`openRabbithole: "${resolvedTitle}"`);
  const markdown = pdf?.markdown || normalizeBlockIds(await resolveMarkdown({ content, filePath })).markdown;
  const base = deriveNodeBaseUrl({ markdown, explicitBaseUrl: baseUrl });
  const newHoleId = await mintHoleId();
  if (pdf) await pdf.adopt(newHoleId);
  await addAssetsToHole(newHoleId, assets);
  const assetNames = new Set(await defaultFsStore.listAssets(newHoleId));
  const rootId = mintNodeId(new Map());
  const rootNode = makeNode({
    id: rootId,
    parent_id: null,
    title: resolvedTitle,
    markdown,
    base_url: base.base_url,
    base_url_source: base.base_url_source,
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    status: "answered",
    read: true, // the human lands on the root immediately
    created_at: new Date().toISOString(),
    source: pdf ? pdf.pdfExtension : null,
  });

  const session = await createSession({
    holeId: newHoleId,
    title: resolvedTitle,
    rootId,
    nodes: [rootNode],
    assetNames,
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  return session.waitForEvent(signal);
}

async function resumeRabbithole(holeId, signal, assets, focus = false) {
  log(`resumeRabbithole: ${holeId}`);
  const liveSession = getSessionByHole(holeId);
  if (liveSession) {
    const addedAssets = await addAssetsToHole(liveSession.holeId, assets);
    for (const asset of addedAssets) liveSession.assetNames.add(asset.name);
    if (focus) liveSession.focusBrowser();
    return liveSession.waitForEvent(signal);
  }

  await addAssetsToHole(holeId, assets);
  const hole = await defaultFsStore.loadHole(holeId);
  if (!hole) throw new Error(`Hole ${holeId} not found.`);
  const assetNames = new Set(await defaultFsStore.listAssets(hole.hole_id));

  // Guard against schema drift / partial files: a hole with no root_id or no
  // root node would open a session the browser can't render and the tool would
  // block on. Fail fast with an actionable error instead.
  if (!hole.root_id || !Array.isArray(hole.nodes)) {
    throw new Error(`Hole ${holeId} is missing a root_id or nodes; cannot resume.`);
  }
  if (!hole.nodes.some((n) => n && n.id === hole.root_id)) {
    throw new Error(`Hole ${holeId} has no node matching root_id ${hole.root_id}; file may be corrupt.`);
  }

  const nodes = [];
  for (const raw of hole.nodes || []) {
    // A persisted pending node is a durable ask — the session re-queues it for
    // the agent at construction. Files predating the status field are all
    // answered nodes.
    const pending = raw.status === "pending";
    nodes.push(makeNode({
      ...raw,
      markdown: pending ? "" : (raw.markdown ?? ""),
      status: pending ? "pending" : "answered",
    }));
  }

  // A stale live session for this hole (e.g. after a cancelled tool call left
  // its tab open) would otherwise sit around shimmering; retire it explicitly.
  closeSessionsForHole(hole.hole_id, "superseded");

  const session = await createSession({
    holeId: hole.hole_id,
    title: hole.title,
    rootId: hole.root_id,
    createdAt: hole.created_at,
    nodes,
    assetNames,
    viewState: hole.view_state ?? null,
    isResume: true,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  return session.waitForEvent(signal);
}

/**
 * Answer a pending branch request. Delegation is a state-only transition that
 * returns immediately. A delegated request's later final answer also returns
 * immediately; ordinary final answers retain the legacy listener handoff.
 * @param {{
 *   sessionId: string,
 *   requestId: string,
 *   title?: string,
 *   content?: string,
 *   partial?: boolean,
 *   delegated?: boolean,
 *   baseUrl?: string,
 *   assets?: Array<{name: string, file_path: string}>,
 *   signal?: AbortSignal,
 * }} input
 */
export async function answerBranch({ sessionId, requestId, title, content, partial, delegated, baseUrl, assets, signal }) {
  sessionId = normalizeId(sessionId);
  requestId = normalizeId(requestId);
  const session = getSession(sessionId);
  if (!session || session.isClosed()) {
    return { status: "session_closed", session_id: sessionId, reason: session?.closeReason || "session_closed" };
  }
  return session.answerBranch({
    requestId,
    title,
    content,
    partial,
    delegated,
    baseUrl: normalizeBaseUrl(baseUrl),
    assets,
    signal,
  });
}

/** List saved Rabbitholes (most-recently-updated first). */
/** @param {{limit?: unknown, query?: unknown}} [input] */
export async function listRabbitholes({ limit, query } = {}) {
  const holes = await defaultFsStore.listHoles();
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  const matching = normalizedQuery
    ? holes.filter((hole) => String(hole.title ?? "").toLowerCase().includes(normalizedQuery))
    : holes;
  return {
    holes: matching.slice(0, normalizeListLimit(limit)),
    total: matching.length,
  };
}

function normalizeListLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 10;
  return Math.min(50, Math.max(1, Math.floor(numeric)));
}

/**
 * Durably add a human-requested document without opening or focusing a browser.
 * An operation id maps to one stable node id, so an MCP retry is idempotent.
 */
/** @param {{holeId: string, operationId: string, title?: string, content: string, parentNodeId?: string, kind?: "answer" | "note"}} input */
export async function sendToRabbithole({ holeId, operationId, title, content, parentNodeId, kind = "answer" }) {
  holeId = normalizeId(holeId);
  operationId = normalizeId(operationId);
  parentNodeId = parentNodeId == null ? undefined : normalizeId(parentNodeId);
  const nodeId = publishedNoteId(holeId, operationId);
  const liveSession = getSessionByHole(holeId);
  if (liveSession) {
    const existing = liveSession.nodes.get(nodeId);
    if (existing) return publishResult(existing, liveSession, true);
    const event = buildPublishedNodeEvent({
      nodeId,
      title,
      content,
      parentNodeId,
      rootId: liveSession.rootId,
      nodes: liveSession.nodes,
      kind,
    });
    const node = await liveSession.publishNode(event);
    return publishResult(node, liveSession, false);
  }

  const hole = await defaultFsStore.loadHole(holeId);
  if (!hole) throw new Error(`Hole ${holeId} not found.`);
  const existing = hole.nodes.find((node) => node.id === nodeId);
  if (existing) return { status: "stored", hole_id: holeId, node_id: nodeId, duplicate: true };
  const state = createHoleState(/** @type {any} */ (hole), { cloneExtensions: false });
  const event = buildPublishedNodeEvent({
    nodeId,
    title,
    content,
    parentNodeId,
    rootId: hole.root_id,
    nodes: state.nodes,
    kind,
  });
  const reduced = reduceHoleEvent(state, event, { now: new Date().toISOString(), mutate: true });
  await defaultFsStore.saveHole(holeStateToHole(reduced.state));
  return { status: "stored", hole_id: holeId, node_id: nodeId, duplicate: false };
}

function publishResult(node, session, duplicate) {
  return {
    status: session.sseClients.size > 0 ? "delivered" : "stored",
    hole_id: session.holeId,
    session_id: session.id,
    node_id: node.id,
    duplicate,
  };
}

function publishedNoteId(holeId, operationId) {
  const digest = createHash("sha256").update(`${holeId}\0${operationId}`).digest("hex").slice(0, 8);
  return `agent-note-${digest}`;
}

async function mintHoleId() {
  while (true) {
    const id = shortId();
    if (!(await defaultFsStore.loadHole(id))) return id;
  }
}

function mintNodeId(nodes) {
  while (true) {
    const id = shortId();
    if (!nodes.has(id)) return id;
  }
}

/** @returns {import("../../core/contracts/engine.js").NodeCreateEvent} */
function buildPublishedNodeEvent({ nodeId, title, content, parentNodeId, rootId, nodes, kind }) {
  const parentId = parentNodeId == null ? null : String(parentNodeId);
  if (parentId !== null && !nodes.has(parentId)) throw new Error(`Parent node ${parentId} not found.`);
  const note = kind === "note";
  const size = note && parentId === null ? DEFAULT_STANDALONE_NOTE : DEFAULT_CHILD;
  return {
    type: "node_create",
    id: nodeId,
    parent_id: parentId,
    title: String(title || (note ? "Note" : "Answer")).trim() || (note ? "Note" : "Answer"),
    markdown: String(content || "").trim(),
    origin: note ? { kind: "note", author: "agent" } : null,
    position: parentId === null
      ? placeStandalonePublishedNote(nodes, rootId)
      : placeAttachedPublishedNote(nodes, rootId, parentId),
    size,
  };
}

function layoutNode(node, rootId) {
  const fallback = node.id === rootId
    ? DEFAULT_ROOT
    : (isNoteNode(node) && node.parent_id == null ? DEFAULT_STANDALONE_NOTE : DEFAULT_CHILD);
  return { ...node, size: node.size || fallback };
}

function placeAttachedPublishedNote(nodes, rootId, parentId) {
  const childrenOf = (id) => [...nodes.values()]
    .filter((node) => node.parent_id === id)
    .map((node) => layoutNode(node, rootId));
  return placeChild(layoutNode(nodes.get(parentId), rootId), BRANCH_FOLLOWUP, { childrenOf });
}

function placeStandalonePublishedNote(nodes, rootId) {
  let maxX = 0;
  let minY = 0;
  let seen = false;
  for (const raw of nodes.values()) {
    const node = layoutNode(raw, rootId);
    if (isDockedNote(node)) continue;
    const x = Number(node.position?.x) || 0;
    const y = Number(node.position?.y) || 0;
    const width = Number(node.size?.w) || DEFAULT_CHILD.w;
    if (!seen) minY = y;
    else minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    seen = true;
  }
  return { x: (seen ? maxX + TREE_PARENT_GAP : 0), y: minY };
}
