import { openRabbithole, answerBranch, ingestPdf, listRabbitholes, exportHoleToVault } from "../index.js";
import { normalizeBaseUrl } from "../../core/base-url.js";
import { AUTHORING_VOCABULARY } from "../../core/prompts/index.js";
import { MAX_ASSETS_PER_CALL, validateAssetEntriesSync } from "../fs-store.js";

function str(description, extra = {}) {
  return { kind: "string", description, ...extra };
}
function obj(fields, extra = {}) {
  return { kind: "object", fields, ...extra };
}
function arr(items, extra = {}) {
  return { kind: "array", items, ...extra };
}
function bool(description, extra = {}) {
  return { kind: "boolean", description, ...extra };
}

const assetInput = obj({
  name: str("Filename to use in markdown asset: references, e.g. diagram-1.png"),
  file_path: str("Local path to the image file to copy into this Rabbithole"),
});

function validateOpen(params) {
  normalizeBaseUrl(params.base_url);
  validateAssetEntriesSync(params.assets);
  if (params.hole_id && params.ingest_id) {
    throw new Error("ingest_id can only be used when starting a new Rabbithole");
  }
  if (params.hole_id) return;
  if (!params.title) throw new Error("title is required when starting a new Rabbithole");
  if (!params.content && !params.file_path) {
    throw new Error("Provide content or file_path when starting a new Rabbithole");
  }
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
      "For a PDF already processed with ingest_pdf, pass ingest_id when starting the new hole and reference " +
      "the returned asset names as ![page](asset:page-001.png). " +
      "The canvas opens in the browser and this call BLOCKS until the human acts. " +
      "It returns status='branch_request' when the human selects text and asks a question — answer it " +
      "with answer_branch. A branch_request with EMPTY selected_text is a follow-up question about the " +
      "parent document as a whole (a chat reply beneath it) — answer conversationally in that document's " +
      "context. A branch_request may carry a 'lens' (explain | eli5 | example | deeper) — the question " +
      "text spells out the style the human tapped; honor it. One marked saved=true was asked while no " +
      "agent was listening — answer it like any other. On a resumed hole the first branch_request carries " +
      "a 'rehydration' field with the whole tree (and any saved_asks); read it to reload your context. " +
      "Long waits periodically return status='keep_listening' with hole_id; immediately call " +
      "open_rabbithole { hole_id } to keep listening, and do not re-send content. If the host reports " +
      "a tool timeout (e.g. timed out awaiting tools/call), also re-call open_rabbithole { hole_id }; " +
      "nothing is lost and asks are saved. " +
      "It returns status='session_closed' when the human clicks Done or closes the tab.",
    input: obj({
      title: str("Document title (required for a new hole)", { optional: true }),
      content: str("Raw markdown for the root document", { optional: true }),
      file_path: str("Path to a .md file (alternative to content)", { optional: true }),
      base_url: str("Document URL used to resolve relative markdown links/images; absolute http(s) only", {
        optional: true,
      }),
      assets: arr(assetInput, {
        optional: true,
        maxItems: MAX_ASSETS_PER_CALL,
        description:
          "Local image files to attach to this hole; reference them in markdown as asset:name.png images",
      }),
      ingest_id: str("Staged PDF assets returned by ingest_pdf; only valid when starting a new hole", { optional: true }),
      hole_id: str("Resume a saved hole instead of starting a new one", { optional: true }),
    }),
    resultKind: "json",
    validateInput: validateOpen,
    run: ({ title, content, file_path, base_url, hole_id, assets, ingest_id }, extra) =>
      openRabbithole({
        title,
        content,
        filePath: file_path,
        baseUrl: base_url,
        holeId: hole_id,
        assets,
        ingestId: ingest_id,
        signal: extra?.signal,
      }),
  },
  {
    name: "ingest_pdf",
    description:
      "Extract a local PDF into Rabbithole image assets and per-page text. Produces 2x page render PNGs " +
      "named page-001.png, page-002.png, etc. plus opportunistic embedded rasters named embed-p001-01.png " +
      "when the PDF contains extractable images. The agent should compose markdown itself, using page renders " +
      "as the dependable figure source and embedded rasters when they are cleaner, then call open_rabbithole " +
      "with the returned ingest_id (or pass hole_id here to attach assets directly to an existing hole). " +
      "For arXiv links, prefer fetching the HTML version and opening that markdown with base_url instead of " +
      "ingesting the PDF.",
    input: obj({
      file_path: str("Local path to a PDF file"),
      hole_id: str("Existing hole id to attach assets to directly; omit to stage assets for open_rabbithole", {
        optional: true,
      }),
      pages: str('Optional page or range such as "3" or "1-20"; default processes the first 40 pages', {
        optional: true,
      }),
      include_text: bool("Whether to return per-page extracted text; defaults to true", {
        optional: true,
        default: true,
      }),
    }),
    resultKind: "json",
    run: ({ file_path, hole_id, pages, include_text }) =>
      ingestPdf({ filePath: file_path, holeId: hole_id, pages, includeText: include_text }),
  },
  {
    name: "answer_branch",
    description: [
      "Answer one pending branch request from an open Rabbithole. Called after open_rabbithole or answer_branch returns status='branch_request'. Write a focused, well-formatted markdown answer to the human's question about their selection - use selected_text, parent_node_title, and lineage for context (you already hold the documents you authored). If selected_text is empty, answer conversationally about the parent document as a whole. If the request has a 'lens', match that style.",
      "",
      AUTHORING_VOCABULARY,
      "",
      "Finish streaming by sending the remaining final chunk in a normal call with a short 'title'. Partial chunks concatenate verbatim: include your own spacing/newlines and never repeat text already sent. The final call blocks and returns the next event. If it returns status='keep_listening', immediately call open_rabbithole { hole_id }; if the host reports a tool timeout (e.g. timed out awaiting tools/call), do the same. Do not re-send content; asks are saved.",
    ].join("\n"),
    input: obj({
      session_id: str("Active session ID from open_rabbithole"),
      request_id: str("The request_id of the branch_request being answered"),
      title: str("Short label for the new node (a few words; required on the final call)", { optional: true }),
      content: str("Markdown chunk (partial) or the remaining markdown (final call)"),
      base_url: str("Document URL used to resolve relative markdown links/images; absolute http(s) only", {
        optional: true,
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
    name: "export_to_obsidian",
    description:
      "Export a saved Rabbithole into an Obsidian vault as a JSON Canvas plus one markdown note per " +
      "document, so the hole becomes searchable, linkable vault knowledge. Each answer becomes a note " +
      "under <folder>/<slug>/notes/, questions become text cards, and the canvas wires them together " +
      "with role annotations that Obsidian AI-canvas plugins (e.g. Caret) can continue chatting from. " +
      "Re-exporting the same hole SYNCS instead of clobbering: positions and edits the " +
      "human made in Obsidian win (edited notes are skipped and listed as conflicts). vault_path is " +
      "remembered as the default after the first call. Pass continuous=true to also export automatically " +
      "on every future save of any hole (continuous=false turns that off).",
    input: obj({
      hole_id: str("Hole to export (use list_rabbitholes to find it)"),
      vault_path: str("Absolute path to the Obsidian vault; optional after the first export", {
        optional: true,
      }),
      folder: str('Vault-relative folder to export into (default "Rabbitholes")', { optional: true }),
      roles: str(
        'Role-stamping mode: "caret" (default; questions are user turns, documents attach as context — ' +
          'works with stock Caret), "chat" (documents stamped user/assistant too), or "none"',
        { optional: true }
      ),
      continuous: bool("Turn continuous vault sync on (true) or off (false) for future saves", {
        optional: true,
      }),
    }),
    resultKind: "json",
    run: ({ hole_id, vault_path, folder, roles, continuous }) =>
      exportHoleToVault({ holeId: hole_id, vaultPath: vault_path, folder, roles, continuous }),
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
