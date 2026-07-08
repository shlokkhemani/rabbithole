import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import { buildCanvasHtml } from "./html/canvas.js";
import { createSession, getSession, getSessionByHole, closeSessionsForHole } from "./sessions.js";
import { addAssetsToHole, adoptStagedAssets, listAssets, loadHole, listHoles } from "./storage.js";
import { deriveNodeBaseUrl, normalizeBaseUrl, normalizeStoredBaseUrlFields } from "./base-url.js";

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
 */
export async function openRabbithole({ title, content, filePath, holeId, baseUrl, assets, ingestId, signal }) {
  if (holeId) {
    if (ingestId) {
      throw new Error("ingest_id can only be used when starting a new Rabbithole; use ingest_pdf with hole_id for saved holes.");
    }
    return resumeRabbithole(holeId, signal, assets);
  }

  log(`openRabbithole: "${title}"`);
  const markdown = await resolveMarkdown({ content, filePath });
  const base = deriveNodeBaseUrl({ markdown, explicitBaseUrl: baseUrl });
  const newHoleId = randomUUID();
  if (ingestId) await adoptStagedAssets(newHoleId, ingestId);
  await addAssetsToHole(newHoleId, assets);
  const assetNames = new Set(await listAssets(newHoleId));
  const rootId = randomUUID();
  const rootNode = {
    id: rootId,
    parent_id: null,
    title: title || "Document",
    markdown,
    base_url: base.base_url,
    base_url_source: base.base_url_source,
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true, // the human lands on the root immediately
    created_at: new Date().toISOString(),
  };

  const session = await createSession({
    holeId: newHoleId,
    title: title || "Document",
    rootId,
    nodes: [rootNode],
    assetNames,
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  return session.waitForEvent(signal);
}

async function resumeRabbithole(holeId, signal, assets) {
  log(`resumeRabbithole: ${holeId}`);
  const liveSession = getSessionByHole(holeId);
  if (liveSession) {
    const addedAssets = await addAssetsToHole(liveSession.holeId, assets);
    for (const asset of addedAssets) liveSession.assetNames.add(asset.name);
    return liveSession.waitForEvent(signal);
  }

  await addAssetsToHole(holeId, assets);
  const hole = await loadHole(holeId);
  const assetNames = new Set(await listAssets(hole.hole_id));

  // Guard against schema drift / partial files: a hole with no root_id or no
  // root node would open a session the browser can't render and the tool would
  // block on. Fail fast with an actionable error instead.
  if (!hole || !hole.root_id || !Array.isArray(hole.nodes)) {
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
    const base = normalizeStoredBaseUrlFields(raw);
    nodes.push({
      id: raw.id,
      parent_id: raw.parent_id ?? null,
      title: raw.title ?? "",
      markdown: pending ? "" : (raw.markdown ?? ""),
      base_url: base.base_url,
      base_url_source: base.base_url_source,
      origin: raw.origin ?? null,
      position: raw.position ?? { x: 0, y: 0 },
      size: raw.size ?? null,
      font_scale: raw.font_scale ?? 1,
      collapsed: !!raw.collapsed,
      status: pending ? "pending" : "answered",
      read: !!raw.read,
      created_at: raw.created_at ?? null,
    });
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
 * Answer a pending branch request. A final call blocks until the next browser
 * event; a partial call streams a chunk into the pending node and returns
 * immediately so the human watches the answer arrive.
 */
export async function answerBranch({ sessionId, requestId, title, content, partial, baseUrl, assets, signal }) {
  const session = getSession(sessionId);
  if (!session || session.isClosed()) {
    return { status: "session_closed", session_id: sessionId };
  }
  return session.answerBranch({
    requestId,
    title,
    content,
    partial,
    baseUrl: normalizeBaseUrl(baseUrl),
    assets,
    signal,
  });
}

/** List saved Rabbitholes (most-recently-updated first). */
export async function listRabbitholes() {
  return { holes: await listHoles() };
}
