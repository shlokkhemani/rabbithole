import { openRabbithole, answerBranch, listRabbitholes, readRabbithole, sendToRabbithole } from "./open.js";
import { normalizeBaseUrl } from "../../core/base-url.js";
import { normalizeId } from "../../core/utils.js";
import { AUTHORING_VOCABULARY_V1 } from "../../core/prompts/authoring-v1.js";
import { MAX_ASSETS_PER_CALL } from "../../core/assets.js";
import { validateAssetEntriesSync } from "./store/fs-store.js";
import fs from "node:fs";
import { z } from "zod";

const PROGRESS_INTERVAL_MS = 4 * 60 * 1000;

const assetInput = z.object({
  name: z.string().max(300).describe("Filename to use in markdown asset: references, e.g. diagram-1.png"),
  file_path: z.string().max(4096).describe("Local path to the image file to copy into this Rabbithole"),
});

function validateOpen(params) {
  normalizeBaseUrl(params.base_url);
  validateAssetEntriesSync(params.assets);
  if (normalizeId(params.hole_id)) return;
  if (!params.title && !looksLikePdf(params.file_path)) throw new Error("title is required when starting a new non-PDF Rabbithole");
  if (!params.content && !params.file_path) {
    throw new Error("Provide content or file_path when starting a new Rabbithole");
  }
}

function looksLikePdf(filePath) {
  if (/\.pdf$/i.test(String(filePath || ""))) return true;
  if (!filePath) return false;
  try {
    const fd = fs.openSync(filePath, "r");
    try { const bytes = Buffer.alloc(4); fs.readSync(fd, bytes, 0, 4, 0); return bytes.toString("ascii") === "%PDF"; }
    finally { fs.closeSync(fd); }
  } catch { return false; }
}

function validateAnswer(params) {
  if (!normalizeId(params.session_id)) throw new Error("session_id is required");
  if (!normalizeId(params.request_id)) throw new Error("request_id is required");
  if (typeof params.delegated === "boolean") {
    const contentFields = ["title", "content", "base_url", "assets", "partial"];
    if (contentFields.some((field) => params[field] !== undefined)) {
      throw new Error("delegated is a state-only update; omit title, content, base_url, assets, and partial");
    }
    return;
  }
  if (params.content === undefined) throw new Error("content is required when answering a branch");
  normalizeBaseUrl(params.base_url);
  validateAssetEntriesSync(params.assets);
}

function validatePublish(params) {
  if (!normalizeId(params.hole_id)) throw new Error("hole_id is required");
  if (!normalizeId(params.operation_id)) throw new Error("operation_id is required");
  if (!String(params.content || "").trim()) throw new Error("content is required");
}

function validateRead(params) {
  if (!normalizeId(params.hole_id)) throw new Error("hole_id is required");
  if (params.node_ids !== undefined) {
    if (!Array.isArray(params.node_ids)) throw new Error("node_ids must be an array");
    if (params.node_ids.length > 20) throw new Error("node_ids may contain at most 20 items");
  }
}

function progressIntervalMs() {
  const configured = Number(process.env.RABBITHOLE_PROGRESS_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : PROGRESS_INTERVAL_MS;
}

async function withProgressKeepalive(run, extra) {
  const progressToken = extra?._meta?.progressToken;
  if ((typeof progressToken !== "string" && typeof progressToken !== "number") || typeof extra?.sendNotification !== "function") return run();
  let progress = 0;
  const timer = setInterval(() => {
    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: ++progress, message: "Waiting for canvas activity." },
    }).catch(() => {});
  }, progressIntervalMs());
  timer.unref?.();
  try { return await run(); }
  finally { clearInterval(timer); }
}

/** @type {any[]} */
export const toolDefinitions = [
  {
    name: "open_rabbithole",
    description:
      "Open a new Rabbithole document or resume a saved one, then wait for the next canvas event. " +
      "Start with {title, content} or {file_path}; resume with {hole_id}, using list_rabbitholes if needed. " +
      "Use base_url for content fetched from a URL or repository so relative links and images resolve. " +
      "file_path accepts Markdown or PDF; PDFs open as native page images with extracted text. " +
      "If a branch_request includes region.image_path, read it before answering, use region.page for its page number, and trust the image over extracted text for math, tables, and figures; also read every attachments[].image_path. " +
      "anchor.block identifies a rendered visual selection, so use the matching fenced source in the parent document. " +
      "For convert_request, read pages[].image_path in order, follow its inline rules, and stream the transcription through answer_branch; the host handles figure: references. " +
      '{status:"already_listening"} means another call owns delivery, so do not call again. ' +
      'Host cancellation returns {status:"cancelled"}. ' +
      "session_closed has reason done, server_error, agent_exited, superseded (the hole was opened again), or session_closed.",
    input: {
      title: z.string().max(2000).describe("Document title (required for a new hole)").optional(),
      content: z.string().max(10485760).describe("Raw markdown for the starting document").optional(),
      file_path: z.string().max(4096).describe("Path to a markdown or PDF file (PDF title is optional)").optional(),
      base_url: z.string().max(2000).describe("Document URL used to resolve relative markdown links/images; absolute http(s) only").optional(),
      assets: z.array(assetInput).max(MAX_ASSETS_PER_CALL)
        .describe("Local image files to attach to this hole; reference them in markdown as asset:name.png images")
        .optional(),
      hole_id: z.string().max(200).describe("Resume a saved hole instead of starting a new one").optional(),
      focus: z.boolean()
        .describe("Show the canvas only when explicitly requested; reuses a connected tab and opens one only when no tab is connected. Never needed merely to reconnect the agent")
        .optional(),
    },
    validateInput: validateOpen,
    run: ({ title, content, file_path, base_url, hole_id, assets, focus }, extra) =>
      withProgressKeepalive(() => openRabbithole({
        title,
        content,
        filePath: file_path,
        baseUrl: base_url,
        holeId: normalizeId(hole_id),
        assets,
        focus,
        signal: extra?.signal,
      }), extra),
  },
  {
    name: "answer_branch",
    description: [
      "Answer one pending request in an open Rabbithole.",
      "",
      AUTHORING_VOCABULARY_V1,
    ].join("\n"),
    input: {
      session_id: z.string().max(200).describe("Active session ID from open_rabbithole"),
      request_id: z.string().max(200).describe("The request_id of the branch_request being answered"),
      title: z.string().max(2000).describe("Short label for the new node (a few words; required on the final call)").optional(),
      content: z.string().max(10485760)
        .describe("Markdown chunk (partial) or the remaining markdown (final call); omit for a delegated state update")
        .optional(),
      base_url: z.string().max(2000).describe("Document URL used to resolve relative markdown links/images; absolute http(s) only").optional(),
      assets: z.array(assetInput).max(MAX_ASSETS_PER_CALL)
        .describe("Local image files to attach to this hole; reference them in markdown as asset:name.png images")
        .optional(),
      partial: z.boolean()
        .describe("true renders this chunk and returns immediately; omit/false finishes it. A final for retained delegated work also returns immediately")
        .optional(),
      delegated: z.boolean()
        .describe("State-only for branch_request: use true right after spawning a sub-agent for this request, then restore the listener with open_rabbithole {hole_id}; use false to reclaim the request yourself. Send only session_id, request_id, and delegated; never use for convert_request")
        .optional(),
    },
    validateInput: validateAnswer,
    run: ({ session_id, request_id, title, content, base_url, assets, partial, delegated }, extra) =>
      withProgressKeepalive(() => answerBranch({
        sessionId: normalizeId(session_id),
        requestId: normalizeId(request_id),
        title,
        content,
        baseUrl: base_url,
        assets,
        partial,
        delegated,
        signal: extra?.signal,
      }), extra),
  },
  {
    name: "read_rabbithole",
    description:
      "Read saved or open Rabbithole context without starting a listener. " +
      "The default returns the map; use thread_of for a lineage with markdown and notes, node_ids for up to 20 specific nodes, and notes for all notes.",
    input: {
      hole_id: z.string().max(200).describe("Saved or open Rabbithole id"),
      thread_of: z.string().max(200)
        .describe("Node id whose lineage root→node should be returned with markdown and notes")
        .optional(),
      node_ids: z.array(z.string().max(200)).max(20)
        .describe("Up to 20 node ids to return with markdown and notes, in the requested order")
        .optional(),
      notes: z.boolean().describe("Return every note in full").optional(),
    },
    validateInput: validateRead,
    run: ({ hole_id, thread_of, node_ids, notes }) => readRabbithole({
      holeId: normalizeId(hole_id),
      threadOf: thread_of === undefined ? undefined : normalizeId(thread_of),
      nodeIds: node_ids === undefined ? undefined : node_ids.map((id) => normalizeId(id)),
      notes,
    }),
  },
  {
    name: "send_to_rabbithole",
    description:
      "Publish a completed document to a saved Rabbithole without opening its canvas. " +
      "Use a stable operation_id for retries, parent_node_id to place it below a node, and kind='note' only for an annotation.",
    input: {
      hole_id: z.string().max(200).describe("Saved Rabbithole id from list_rabbitholes or prior context"),
      operation_id: z.string().max(200).describe("Caller-chosen stable id for this one publish operation; reuse unchanged on retry"),
      title: z.string().max(2000).describe("Short document title").optional(),
      content: z.string().max(10485760).describe("Markdown document content"),
      parent_node_id: z.string().max(200)
        .describe("Optional existing node id to attach the document beneath; omit for a standalone canvas document")
        .optional(),
      kind: z.enum(["answer", "note"])
        .describe("Document presentation. Defaults to answer; use note only for an explicit annotation")
        .optional(),
    },
    validateInput: validatePublish,
    run: ({ hole_id, operation_id, title, content, parent_node_id, kind }) => sendToRabbithole({
      holeId: normalizeId(hole_id),
      operationId: normalizeId(operation_id),
      title,
      content,
      parentNodeId: parent_node_id == null ? undefined : normalizeId(parent_node_id),
      kind,
    }),
  },
  {
    name: "list_rabbitholes",
    description:
      "List saved Rabbitholes for selecting a hole_id to resume. " +
      "Results are newest first and may be bounded or filtered.",
    input: {
      limit: z.coerce.number().catch(10)
        .describe("Maximum results to return; defaults to 10 and clamps to 1–50")
        .optional(),
      query: z.string().max(2000)
        .describe("Case-insensitive substring filter on the Rabbithole title")
        .optional(),
    },
    run: (params = {}) => listRabbitholes(params),
  },
];
