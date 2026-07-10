import { resolveMarkdownUrl } from "./base-url.js";
import { extractAssetRefsFromMarkdown } from "./assets.js";

/**
 * Project a persisted hole onto an Obsidian vault: a JSON Canvas of file nodes
 * (one markdown note per document) plus question text-nodes, annotated so
 * Obsidian AI-canvas plugins (Caret and friends) can continue the conversation.
 *
 * Role modes (verified against Caret 0.2.80 on Obsidian 1.12.7):
 * - "caret" (default): question cards get role "user"; document file-nodes stay
 *   unstamped. Caret treats role-less nodes attached to a lineage as context and
 *   reads file-node content through that path — so "continue the conversation"
 *   works out of the box. (Caret's chat lineage itself cannot read file nodes,
 *   so stamping documents user/assistant would break it.)
 * - "chat": documents are stamped too (root "user", answers "assistant") — the
 *   semantically faithful mapping, for tools that read file-node chat turns.
 * - "none": no role fields at all.
 *
 * Pure data transform — hosts apply the returned plan to a real filesystem.
 * JSON Canvas spec: https://jsoncanvas.org/spec/1.0/. The `role` and
 * `rabbithole` node fields are extensions; Obsidian preserves fields it does
 * not recognize.
 */

export const DEFAULT_VAULT_FOLDER = "Rabbitholes";

const DOC_NODE_WIDTH = 480;
const DOC_NODE_HEIGHT = 440;
const QUESTION_NODE_WIDTH = 320;
const QUESTION_NODE_HEIGHT = 140;
const QUOTE_PREVIEW_CHARS = 240;

export function slugify(value, { fallback = "untitled", maxLength = 64 } = {}) {
  const slug = String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
  return slug || fallback;
}

function noteFileName(node) {
  const base = slugify(node.title, { fallback: "note", maxLength: 48 });
  return `${base}-${String(node.id).slice(0, 8)}.md`;
}

function yamlValue(value) {
  // JSON string escaping is valid YAML for double-quoted scalars.
  return JSON.stringify(String(value ?? ""));
}

function frontmatter(entries) {
  const lines = ["---"];
  for (const [key, value] of entries) {
    if (value === null || value === undefined || value === "") continue;
    lines.push(`${key}: ${typeof value === "number" ? value : yamlValue(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Rewrite markdown for life inside the vault: asset: refs become paths relative
 * to the note (notes/ and assets/ are siblings), and relative links/images are
 * resolved against the node's base_url so they keep working outside the app.
 */
export function rewriteMarkdownForVault(markdown, { baseUrl = null, assetNames = [] } = {}) {
  const names = new Set(assetNames);
  const resolveAssetUrl = (name) => (names.size === 0 || names.has(name) ? `../assets/${name}` : undefined);
  const rewriteUrl = (raw, image) => {
    const trimmed = raw.trim();
    const angled = trimmed.startsWith("<") && trimmed.endsWith(">");
    const inner = angled ? trimmed.slice(1, -1) : trimmed;
    const resolved = resolveMarkdownUrl(inner, { baseUrl, image, assetNames: names, resolveAssetUrl });
    if (resolved === undefined || resolved === null || resolved === inner) return raw;
    return angled ? `<${resolved}>` : resolved;
  };
  // Matches ![alt](url "title") and [text](url "title"); URL may be <angled>.
  return String(markdown ?? "").replace(
    /(!?)(\[(?:[^\[\]]|\\.)*\])\(\s*(<[^<>]*>|[^()\s]+)([^)]*)\)/g,
    (full, bang, label, url, rest) => `${bang}${label}(${rewriteUrl(url, bang === "!")}${rest})`
  );
}

function quotePreview(text) {
  const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const clipped = collapsed.length > QUOTE_PREVIEW_CHARS ? `${collapsed.slice(0, QUOTE_PREVIEW_CHARS)}…` : collapsed;
  return `> ${clipped}`;
}

function questionNodeText(node) {
  const origin = node.origin || {};
  const parts = [];
  const quote = quotePreview(origin.selected_text);
  if (quote) parts.push(quote, "");
  parts.push(String(origin.question || node.title || "Follow-up"));
  return parts.join("\n");
}

function edgeSides(from, to) {
  const dx = (to?.x ?? 0) - (from?.x ?? 0);
  const dy = (to?.y ?? 0) - (from?.y ?? 0);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

function nodeSize(node, fallbackWidth, fallbackHeight) {
  return {
    width: Math.round(Number(node?.size?.w) || fallbackWidth),
    height: Math.round(Number(node?.size?.h) || fallbackHeight),
  };
}

/**
 * @param {object} hole persisted hole (schema v1)
 * @param {object} [options]
 * @param {string} [options.folder] vault-relative folder holding all exports
 * @param {string} [options.slug] pinned slug; defaults to slugify(title)
 * @param {string[]} [options.assetNames] asset filenames available for this hole
 * @param {"caret"|"chat"|"none"} [options.roles] role-stamping mode (default "caret")
 * @returns {{
 *   slug: string,
 *   dir: string,
 *   canvasPath: string,
 *   canvas: { nodes: object[], edges: object[] },
 *   notes: Array<{ nodeId: string, path: string, content: string }>,
 *   assets: Array<{ name: string, path: string }>,
 * }}
 */
export function holeToVaultPlan(hole, { folder = DEFAULT_VAULT_FOLDER, slug = null, assetNames = [], roles = "caret" } = {}) {
  if (!hole || !Array.isArray(hole.nodes)) throw new Error("holeToVaultPlan requires a persisted hole");
  if (!["caret", "chat", "none"].includes(roles)) {
    throw new Error(`roles must be "caret", "chat", or "none", got ${JSON.stringify(roles)}`);
  }
  const stampDocs = roles === "chat";
  const stampQuestions = roles !== "none";
  const holeSlug = slug || slugify(hole.title, { fallback: String(hole.hole_id || "rabbithole").slice(0, 12) });
  const dir = folder ? `${folder}/${holeSlug}` : holeSlug;
  const notesDir = `${dir}/notes`;
  const assetsDir = `${dir}/assets`;

  const byId = new Map(hole.nodes.map((n) => [n.id, n]));
  const canvasNodes = [];
  const canvasEdges = [];
  const notes = [];
  const referencedAssets = new Set();

  for (const node of hole.nodes) {
    const isRoot = node.id === hole.root_id || node.parent_id == null;
    const pending = node.status === "pending";
    const origin = node.origin || null;
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    const position = node.position || { x: 0, y: 0 };

    // Pending nodes are durable asks: a question with no answer yet. They
    // export as a question card only, so nothing pretends to be answered.
    if (!pending) {
      const notePath = `${notesDir}/${noteFileName(node)}`;
      const content =
        frontmatter([
          ["title", node.title],
          ["rabbithole_hole", hole.hole_id],
          ["rabbithole_node", node.id],
          ["question", origin?.question],
          ["lens", origin?.lens],
          ["created", node.created_at],
          ["role", stampDocs ? (isRoot ? "user" : "assistant") : null],
        ]) +
        "\n" +
        rewriteMarkdownForVault(node.markdown, { baseUrl: node.base_url, assetNames }) +
        "\n";
      notes.push({ nodeId: node.id, path: notePath, content });
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) referencedAssets.add(name);

      const size = nodeSize(node, DOC_NODE_WIDTH, DOC_NODE_HEIGHT);
      const canvasNode = {
        id: node.id,
        type: "file",
        file: notePath,
        x: Math.round(position.x),
        y: Math.round(position.y),
        width: size.width,
        height: size.height,
        rabbithole: { hole_id: hole.hole_id, node_id: node.id, kind: "doc" },
      };
      if (stampDocs) canvasNode.role = isRoot ? "user" : "assistant";
      canvasNodes.push(canvasNode);
    }

    if (isRoot || !parent) continue;

    const hasQuestion = !!(origin && (origin.question || origin.selected_text));
    if (hasQuestion) {
      const parentPos = parent.position || { x: 0, y: 0 };
      const questionId = `q-${node.id}`;
      const qx = Math.round((parentPos.x + position.x) / 2);
      const qy = Math.round((parentPos.y + position.y) / 2);
      const questionNode = {
        id: questionId,
        type: "text",
        text: questionNodeText(node),
        x: qx,
        y: qy,
        width: QUESTION_NODE_WIDTH,
        height: QUESTION_NODE_HEIGHT,
        rabbithole: {
          hole_id: hole.hole_id,
          node_id: node.id,
          kind: "question",
          lens: origin.lens || null,
          anchor: origin.anchor || null,
          selected_text: origin.selected_text || "",
          pending: pending || undefined,
        },
      };
      if (stampQuestions) questionNode.role = "user";
      canvasNodes.push(questionNode);

      canvasEdges.push({
        id: `eq-${node.id}`,
        fromNode: parent.id,
        toNode: questionId,
        ...edgeSides(parentPos, { x: qx, y: qy }),
        ...(origin.lens ? { label: origin.lens } : {}),
      });
      if (!pending) {
        canvasEdges.push({
          id: `e-${node.id}`,
          fromNode: questionId,
          toNode: node.id,
          ...edgeSides({ x: qx, y: qy }, position),
        });
      }
    } else if (!pending) {
      canvasEdges.push({
        id: `e-${node.id}`,
        fromNode: parent.id,
        toNode: node.id,
        ...edgeSides(parent.position || { x: 0, y: 0 }, position),
      });
    }
  }

  const assets = [...(assetNames.length ? assetNames.filter((n) => referencedAssets.has(n)) : referencedAssets)]
    .sort()
    .map((name) => ({ name, path: `${assetsDir}/${name}` }));

  return {
    slug: holeSlug,
    dir,
    canvasPath: `${dir}/${holeSlug}.canvas`,
    canvas: { nodes: canvasNodes, edges: canvasEdges },
    notes,
    assets,
  };
}

/**
 * Merge a freshly computed canvas with the one already in the vault so a
 * re-export is a sync, not a clobber: positions/sizes the human set in
 * Obsidian win for nodes that already exist, foreign nodes and edges (added
 * by the human or other plugins) are kept, and nodes this exporter created
 * earlier but that no longer exist in the hole are dropped.
 *
 * @param {{nodes: object[], edges: object[]}} fresh plan.canvas
 * @param {{nodes?: object[], edges?: object[]}|null} existing parsed .canvas file
 * @param {string[]} [previouslyCreated] node ids this exporter wrote last time
 */
export function mergeCanvas(fresh, existing, previouslyCreated = []) {
  if (!existing || !Array.isArray(existing.nodes)) return { nodes: fresh.nodes, edges: fresh.edges };
  const freshNodeIds = new Set(fresh.nodes.map((n) => n.id));
  const freshEdgeIds = new Set(fresh.edges.map((e) => e.id));
  const removedOurs = new Set(previouslyCreated.filter((id) => !freshNodeIds.has(id)));
  const existingById = new Map(existing.nodes.map((n) => [n.id, n]));

  const nodes = fresh.nodes.map((node) => {
    const prior = existingById.get(node.id);
    if (!prior) return node;
    const merged = { ...prior, ...node };
    // Geometry belongs to the human once the node exists in the vault.
    for (const key of ["x", "y", "width", "height", "color"]) {
      if (prior[key] !== undefined) merged[key] = prior[key];
    }
    return merged;
  });
  for (const node of existing.nodes) {
    if (freshNodeIds.has(node.id)) continue;
    if (removedOurs.has(node.id)) continue; // we created it; hole no longer has it
    nodes.push(node); // foreign node — keep
  }

  const edges = [...fresh.edges];
  const existingEdges = Array.isArray(existing.edges) ? existing.edges : [];
  const freshEdgeById = new Map(fresh.edges.map((e) => [e.id, e]));
  for (const edge of existingEdges) {
    if (freshEdgeIds.has(edge.id)) {
      // Keep human-set styling on edges we own.
      const merged = { ...edge, ...freshEdgeById.get(edge.id) };
      for (const key of ["color", "fromSide", "toSide"]) {
        if (edge[key] !== undefined) merged[key] = edge[key];
      }
      edges[edges.findIndex((e) => e.id === edge.id)] = merged;
      continue;
    }
    const touchesOurRemoved = removedOurs.has(edge.fromNode) || removedOurs.has(edge.toNode);
    const stillValid = nodes.some((n) => n.id === edge.fromNode) && nodes.some((n) => n.id === edge.toNode);
    if (!touchesOurRemoved && stillValid) edges.push(edge); // foreign edge — keep
  }

  return { nodes, edges };
}
