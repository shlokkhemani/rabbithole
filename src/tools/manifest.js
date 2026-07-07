import { openRabbithole, answerBranch, listRabbitholes } from "../core/index.js";

function str(description, extra = {}) {
  return { kind: "string", description, ...extra };
}
function obj(fields, extra = {}) {
  return { kind: "object", fields, ...extra };
}
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}


function validateOpen(params) {
  if (params.hole_id) return;
  if (!params.title) throw new Error("title is required when starting a new Rabbithole");
  if (!params.content && !params.file_path) {
    throw new Error("Provide content or file_path when starting a new Rabbithole");
  }
  if (params.base_url && !isHttpUrl(params.base_url)) {
    throw new Error("base_url must be an absolute http(s) URL");
  }
}

export const toolDefinitions = [
  {
    name: "open_rabbithole",
    description:
      "Open a document on an infinite canvas so the human can read it and dive down rabbit holes. " +
      "Start a NEW hole with { title, content } (or { title, file_path }), or RESUME a saved one with " +
      "{ hole_id } (use list_rabbitholes to find it). " +
      "The canvas opens in the browser and this call BLOCKS until the human acts. " +
      "It returns status='branch_request' when the human selects text and asks a question — answer it " +
      "with answer_branch. A branch_request with EMPTY selected_text is a follow-up question about the " +
      "parent document as a whole (a chat reply beneath it) — answer conversationally in that document's " +
      "context. A branch_request may carry a 'lens' (explain | eli5 | example | deeper) — the question " +
      "text spells out the style the human tapped; honor it. One marked saved=true was asked while no " +
      "agent was listening — answer it like any other. On a resumed hole the first branch_request carries " +
      "a 'rehydration' field with the whole tree (and any saved_asks); read it to reload your context. " +
      "It returns status='session_closed' when the human clicks Done or closes the tab.",
    input: obj({
      title: str("Document title (required for a new hole)", { optional: true }),
      content: str("Raw markdown for the root document", { optional: true }),
      file_path: str("Path to a .md file (alternative to content)", { optional: true }),
      base_url: str("Base URL for resolving relative Markdown links/images", { optional: true }),
      hole_id: str("Resume a saved hole instead of starting a new one", { optional: true }),
    }),
    resultKind: "json",
    validateInput: validateOpen,
    run: ({ title, content, file_path, base_url, hole_id }, extra) =>
      openRabbithole({ title, content, filePath: file_path, baseUrl: base_url, holeId: hole_id, signal: extra?.signal }),
  },
  {
    name: "answer_branch",
    description:
      "Answer one pending branch request from an open Rabbithole. Called after open_rabbithole or " +
      "answer_branch returns status='branch_request'. Write a focused, well-formatted markdown answer to " +
      "the human's question about their selection — use the selected_text, parent_node_title, and lineage " +
      "for context (you already hold the documents you authored). If selected_text is empty the human asked " +
      "a follow-up about the parent document as a whole — answer conversationally in its context. If the " +
      "request has a 'lens', match that style. " +
      "STREAM every answer that is longer than a couple of sentences: send it in 1–3 sentence chunks with " +
      "partial=true (each returns immediately and the text appears live in the browser), then send the " +
      "REMAINING final chunk in a normal call with the 'title'. Partial chunks are concatenated verbatim — " +
      "include your own spacing/newlines, and never repeat text you already sent. Provide a short 'title' " +
      "(a few words) on the final call. The final call BLOCKS and returns the next event (another " +
      "branch_request, or session_closed).",
    input: obj({
      session_id: str("Active session ID from open_rabbithole"),
      request_id: str("The request_id of the branch_request being answered"),
      title: str("Short label for the new node (a few words; required on the final call)", { optional: true }),
      content: str("Markdown chunk (partial) or the remaining markdown (final call)"),
      partial: {
        kind: "boolean",
        description:
          "true = stream this chunk into the pending answer and return immediately; " +
          "omit/false = finish the answer and block for the next event",
        optional: true,
      },
    }),
    resultKind: "json",
    run: ({ session_id, request_id, title, content, partial }, extra) =>
      answerBranch({
        sessionId: session_id,
        requestId: request_id,
        title,
        content,
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
