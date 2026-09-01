import { openRabbithole, answerBranch, listRabbitholes, readRabbithole, sendToRabbithole } from "./open.js";
import { normalizeBaseUrl } from "../../core/base-url.js";
import { normalizeId } from "../../core/utils.js";
import { AUTHORING_VOCABULARY_V1 } from "../../core/prompts/authoring-v1.js";
import { MAX_ASSETS_PER_CALL } from "../../core/assets.js";
import { validateAssetEntriesSync } from "./store/fs-store.js";
import fs from "node:fs";
import { z } from "zod";
import {
  CONVERT_RULE,
  LISTENER_RULE,
  REGION_AND_ATTACHMENTS,
  CONTEXT_READING_RULE,
  STREAMING_RULE,
  SUB_AGENT_PROTOCOL,
} from "./protocol.js";

const PROGRESS_INTERVAL_MS = 4 * 60 * 1000;

export { SUB_AGENT_PROTOCOL } from "./protocol.js";

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
      "Use this tool whenever the human says 'Rabbithole' or 'rabbit hole' and wants content presented, explained, or explored there. " +
      "Rabbithole is this MCP product, not a Markdown outline or a generic step-by-step format. " +
      "Open a document on an infinite canvas so the human can read it and dive down rabbit holes. " +
      "Start a NEW hole with { title, content } (or { title, file_path }), or RESUME a saved one with " +
      "{ hole_id } (use list_rabbitholes to find it). " +
      "When opening content fetched from a URL or repo, pass the document's own URL as base_url so " +
      "relative images and links resolve. " +
      "For local images that are not on the web, pass assets and reference them as ![alt](asset:name.png). " +
      "For a local PDF, pass its path directly as file_path; Rabbithole extracts text and opens native JPEG pages automatically. " +
      "For arXiv, prefer the HTML version with base_url when available. " +
      "The canvas opens in the browser and this call BLOCKS until the human acts. " +
      "It returns status='branch_request' when the human selects text and asks a question — answer it " +
      "with answer_branch. " +
      "A branch_request with EMPTY selected_text is a follow-up question about the " +
      "parent document as a whole (a chat reply beneath it) — answer conversationally in that document's " +
      "context. A branch_request may carry a 'lens' preset key (explain | eli5 | deeper | custom) and a separate 'instruction'; " +
      "honor the instruction while answering the human's question. An empty question means the selection or whole parent document is implicit. One marked saved=true was asked while no " +
      "agent was listening — answer it like any other. When attachments are present, read every attachments[].image_path; these are images pasted into the question. When region.image_path is present, it is either " +
      "this selection's clip or the immediate parent's clip; read that image before answering and trust it over extracted text for math, tables, and figures. " +
      "When anchor.block is present, the selection came from that rendered visual block; use the matching fenced source in the parent document as context. " +
      "A convert_request asks you to transcribe the listed page image_path files under its inline rules; stream the document through answer_branch with that request_id. " +
      "A branch_request includes a compact map and may include a thread when this session has not delivered its lineage. " +
      "Long waits remain blocked and should be left running in the background; never poll the canvas. " +
      "The pending tool call itself is the listener. Never claim the canvas is open or that you are listening unless this call was actually invoked and remains running. " +
      "Do not post a host-chat final answer or end the agent turn merely to announce that Rabbithole opened; keep this call pending until a real canvas event arrives. " +
      "If the host truly cancels or times out the tool call, re-call open_rabbithole { hole_id } once; " +
      "nothing is lost and asks are saved. A status='already_listening' result means another live " +
      "background call owns delivery; do not call again. Reconnecting the agent never requires focus. " +
      "Only when the human explicitly asks to see the canvas, resume with { hole_id, focus: true }; " +
      "a live browser tab is reused and a tab is opened only when none is connected. " +
      "It returns status='session_closed' with a reason when the human clicks Done or the session otherwise ends.\n\n" +
      [REGION_AND_ATTACHMENTS, CONVERT_RULE, CONTEXT_READING_RULE, LISTENER_RULE, SUB_AGENT_PROTOCOL].join("\n\n"),
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
      "Answer one pending branch_request or convert_request from an open Rabbithole. For convert_request, read every pages[].image_path in order, follow rules exactly, stream transcription chunks, and emit figure: refs rather than cropping. For branch_request, write a focused answer using the supplied selection context; read every attachments[].image_path when attachments are present. When region.image_path is present, it may be the new selection clip or the immediate parent's clip, so read it and trust it over extracted text.",
      "",
      AUTHORING_VOCABULARY_V1,
      "",
      REGION_AND_ATTACHMENTS,
      CONVERT_RULE,
      STREAMING_RULE,
      LISTENER_RULE,
      "",
      SUB_AGENT_PROTOCOL,
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
        .describe("true streams this normal answer chunk and returns immediately; omit/false finishes it. An ordinary final becomes the listener; a retained delegated final returns immediately (protocol step 4)")
        .optional(),
      delegated: z.boolean()
        .describe("State-only flag for protocol steps 2 and 5: true delegates; false reclaims. Use only on a branch_request. When present, send exactly session_id, request_id, and delegated; never use it on a convert_request")
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
      "Read a saved or open Rabbithole without a listener: map only by default; thread_of returns the lineage root→node with markdown and notes; node_ids returns specific nodes; notes returns every note. " +
      "Use it before answering when the ask refers to text you do not hold verbatim.",
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
      "Durably publish a completed document to an existing Rabbithole only when the human explicitly asks you to send or save content there. " +
      "This never opens or focuses a browser and never answers a pending branch request. The default kind is answer: model-authored content appears as a normal completed document. " +
      "Use kind='note' only when you genuinely mean to annotate the canvas; the note carries agent attribution. Omit parent_node_id for a standalone canvas document, " +
      "or provide a known node id to place it beneath that node. Supply a stable operation_id and reuse it for retries so the document is created exactly once. " +
      "It appears immediately when that Rabbithole has a connected canvas in this MCP session; otherwise it is stored for the next open.",
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
      "List up to 10 saved Rabbitholes (most recently updated first) so you can resume one by hole_id via " +
      "open_rabbithole. Filter titles with query or request up to 50 with limit. Returns id, title, " +
      "last-updated time, and node count for each, plus the total matching count before the limit.",
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
