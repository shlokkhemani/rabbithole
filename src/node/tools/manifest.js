import { openRabbithole, answerBranch, listRabbitholes } from "../index.js";
import { normalizeBaseUrl } from "../../core/base-url.js";
import { AUTHORING_VOCABULARY_V1 } from "../../core/prompts/index.js";
import { MAX_ASSETS_PER_CALL } from "../../core/assets.js";
import { validateAssetEntriesSync } from "../fs-store.js";
import fs from "node:fs";

function str(description, extra = {}) {
  return { kind: "string", description, ...extra };
}
function obj(fields, extra = {}) {
  return { kind: "object", fields, ...extra };
}
function arr(items, extra = {}) {
  return { kind: "array", items, ...extra };
}

const assetInput = obj({
  name: str("Filename to use in markdown asset: references, e.g. diagram-1.png", { maxLength: 300 }),
  file_path: str("Local path to the image file to copy into this Rabbithole", { maxLength: 4096 }),
});

function validateOpen(params) {
  normalizeBaseUrl(params.base_url);
  validateAssetEntriesSync(params.assets);
  if (params.hole_id) return;
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
  normalizeBaseUrl(params.base_url);
  validateAssetEntriesSync(params.assets);
}

export const toolDefinitions = [
  {
    name: "open_rabbithole",
    description:
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
      "with answer_branch. A branch_request with EMPTY selected_text is a follow-up question about the " +
      "parent document as a whole (a chat reply beneath it) — answer conversationally in that document's " +
      "context. A branch_request may carry a 'lens' (explain | eli5 | example | deeper) — the question " +
      "text spells out the style the human tapped; honor it. One marked saved=true was asked while no " +
      "agent was listening — answer it like any other. When region.image_path is present, read that " +
      "image before answering and trust it over extracted text for math, tables, and figures. " +
      "A convert_request asks you to transcribe the listed page image_path files under its inline rules; stream the document through answer_branch with that request_id. " +
      "On a resumed hole the first branch_request carries " +
      "a 'rehydration' field with the whole tree (and any saved_asks); read it to reload your context. " +
      "Long waits periodically return status='keep_listening' with hole_id; immediately call " +
      "open_rabbithole { hole_id } to keep listening, and do not re-send content. If the host reports " +
      "a tool timeout (e.g. timed out awaiting tools/call), also re-call open_rabbithole { hole_id }; " +
      "nothing is lost and asks are saved. " +
      "It returns status='session_closed' when the human clicks Done or closes the tab.",
    input: obj({
      title: str("Document title (required for a new hole)", { optional: true, maxLength: 2000 }),
      content: str("Raw markdown for the starting document", { optional: true, maxLength: 10485760 }),
      file_path: str("Path to a markdown or PDF file (PDF title is optional)", { optional: true, maxLength: 4096 }),
      base_url: str("Document URL used to resolve relative markdown links/images; absolute http(s) only", {
        optional: true,
        maxLength: 2000,
      }),
      assets: arr(assetInput, {
        optional: true,
        maxItems: MAX_ASSETS_PER_CALL,
        description:
          "Local image files to attach to this hole; reference them in markdown as asset:name.png images",
      }),
      hole_id: str("Resume a saved hole instead of starting a new one", { optional: true, maxLength: 200 }),
    }),
    resultKind: "json",
    validateInput: validateOpen,
    run: ({ title, content, file_path, base_url, hole_id, assets }, extra) =>
      openRabbithole({
        title,
        content,
        filePath: file_path,
        baseUrl: base_url,
        holeId: hole_id,
        assets,
        signal: extra?.signal,
      }),
  },
  {
    name: "answer_branch",
    description: [
      "Answer one pending branch_request or convert_request from an open Rabbithole. For convert_request, read every pages[].image_path in order, follow rules exactly, stream transcription chunks, and emit figure: refs rather than cropping. For branch_request, write a focused answer using the supplied selection context; when region.image_path is present, read it and trust it over extracted text.",
      "",
      AUTHORING_VOCABULARY_V1,
      "",
      "Finish streaming by sending the remaining final chunk in a normal call with a short 'title'. Partial chunks concatenate verbatim: include your own spacing/newlines and never repeat text already sent. The final call blocks and returns the next event. If it returns status='keep_listening', immediately call open_rabbithole { hole_id }; if the host reports a tool timeout (e.g. timed out awaiting tools/call), do the same. Do not re-send content; asks are saved.",
    ].join("\n"),
    input: obj({
      session_id: str("Active session ID from open_rabbithole", { maxLength: 200 }),
      request_id: str("The request_id of the branch_request being answered", { maxLength: 200 }),
      title: str("Short label for the new node (a few words; required on the final call)", { optional: true, maxLength: 2000 }),
      content: str("Markdown chunk (partial) or the remaining markdown (final call)", { maxLength: 10485760 }),
      base_url: str("Document URL used to resolve relative markdown links/images; absolute http(s) only", {
        optional: true,
        maxLength: 2000,
      }),
      assets: arr(assetInput, {
        optional: true,
        maxItems: MAX_ASSETS_PER_CALL,
        description:
          "Local image files to attach to this hole; reference them in markdown as asset:name.png images",
      }),
      partial: {
        kind: "boolean",
        description:
          "true = stream this chunk into the pending answer and return immediately; " +
          "omit/false = finish the answer and block for the next event",
        optional: true,
      },
    }),
    resultKind: "json",
    validateInput: validateAnswer,
    run: ({ session_id, request_id, title, content, base_url, assets, partial }, extra) =>
      answerBranch({
        sessionId: session_id,
        requestId: request_id,
        title,
        content,
        baseUrl: base_url,
        assets,
        partial,
        signal: extra?.signal,
      }),
  },
  {
    name: "list_rabbitholes",
    description:
      "List saved Rabbitholes (most recently updated first) so you can resume one by hole_id via " +
      "open_rabbithole. Returns id, title, last-updated time, and node count for each.",
    input: obj({}),
    resultKind: "json",
    run: () => listRabbitholes(),
  },
];
