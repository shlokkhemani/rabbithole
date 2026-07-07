import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import { renderMarkdownToHtml, resolveMarkdownBaseUrl } from "./markdown.js";
import { buildCanvasHtml } from "./html/canvas.js";
import { createSession, getSession, closeSessionsForHole } from "./sessions.js";
import { loadHole, listHoles } from "./storage.js";

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
export async function openRabbithole({ title, content, filePath, baseUrl, holeId, signal }) {
  if (holeId) return resumeRabbithole(holeId, signal);

  log(`openRabbithole: "${title}"`);
  const markdown = await resolveMarkdown({ content, filePath });
  const rootBaseUrl = resolveMarkdownBaseUrl(markdown, baseUrl);
  const rootId = randomUUID();
  const rootNode = {
    id: rootId,
    parent_id: null,
    title: title || "Document",
    markdown,
    base_url: rootBaseUrl,
    contentHtml: await renderMarkdownToHtml(markdown, { baseUrl: rootBaseUrl }),
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
    holeId: randomUUID(),
    title: title || "Document",
    rootId,
    nodes: [rootNode],
    isResume: false,
    renderPage: (hydration) => buildCanvasHtml(hydration),
  });

  return session.waitForEvent(signal);
}

async function resumeRabbithole(holeId, signal) {
  log(`resumeRabbithole: ${holeId}`);
  const hole = await loadHole(holeId);

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
    nodes.push({
      id: raw.id,
      parent_id: raw.parent_id ?? null,
      title: raw.title ?? "",
      markdown: pending ? "" : (raw.markdown ?? ""),
      base_url: raw.base_url ?? null,
      contentHtml: pending ? "" : await renderMarkdownToHtml(raw.markdown ?? "", { baseUrl: raw.base_url }),
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
export async function answerBranch({ sessionId, requestId, title, content, partial, signal }) {
  const session = getSession(sessionId);
  if (!session || session.isClosed()) {
    return { status: "session_closed", session_id: sessionId };
  }
  return session.answerBranch({ requestId, title, content, partial, signal });
}

/** List saved Rabbitholes (most-recently-updated first). */
export async function listRabbitholes() {
  return { holes: await listHoles() };
}
