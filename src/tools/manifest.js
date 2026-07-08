import { openRabbithole, answerBranch, listRabbitholes } from "../core/index.js";
import { normalizeBaseUrl } from "../core/base-url.js";
import { MAX_ASSETS_PER_CALL, validateAssetEntriesSync } from "../core/storage.js";

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
  name: str("Filename to use in markdown asset: references, e.g. diagram-1.png"),
  file_path: str("Local path to the image file to copy into this Rabbithole"),
});

function validateOpen(params) {
  normalizeBaseUrl(params.base_url);
  validateAssetEntriesSync(params.assets);
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
      base_url: str("Document URL used to resolve relative markdown links/images; absolute http(s) only", {
        optional: true,
      }),
      assets: arr(assetInput, {
        optional: true,
        maxItems: MAX_ASSETS_PER_CALL,
        description:
          "Local image files to attach to this hole; reference them in markdown as asset:name.png images",
      }),
      hole_id: str("Resume a saved hole instead of starting a new one", { optional: true }),
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
      "Answer one pending branch request from an open Rabbithole. Called after open_rabbithole or answer_branch returns status='branch_request'. Write a focused, well-formatted markdown answer to the human's question about their selection - use selected_text, parent_node_title, and lineage for context (you already hold the documents you authored). If selected_text is empty, answer conversationally about the parent document as a whole. If the request has a 'lens', match that style.",
      "",
      "Authoring vocabulary:",
      "- Base notation: GFM markdown, $...$/$$...$$ and \\(...\\)/\\[...\\] math, and highlighted language-tagged code fences.",
      "- If the answer is content fetched from a URL or repo, pass its document URL as base_url so relative images and links resolve.",
      "- If the answer uses a local image, pass assets: [{ name, file_path }] and reference it as ![alt](asset:name.png); use this for screenshots, generated diagrams, and other non-web images.",
      "- Use ```show when a concept is spatial or structural: architecture, memory layout, relationships.",
      "- show dialect: HTML/CSS/inline-SVG only; no scripts. Scripts and unsafe attributes are stripped.",
      "- show craft: prefer HTML/CSS layout with flexbox/grid over absolute SVG coordinates.",
      "- Design visuals for about 380px card width; make them fluid and keep labels short.",
      "- Use theme tokens, never hardcoded colors, so visuals match light and dark themes:",
      "  --fg, --fg-bold, --fg-dim, --fg-faint, --node-bg, --bar-bg, --border, --border-focus, --accent, --accent-contrast, --code-bg, --hl, --hl-strong, --warn, --font-ui, --font-doc, --font-mono.",
      "- Example show:",
      "```show",
      "<style>.flow{display:grid;gap:8px}.box{border:1px solid var(--border);padding:8px;border-radius:6px}</style>",
      "<div class='flow'><div class='box'>Parse</div><div class='box' style='background:var(--hl)'>Render</div></div>",
      "```",
      "- Streaming choreography: send prose in 1-3 sentence chunks as usual.",
      "- Emit each visual fence contiguously, ideally in one chunk; readers see a placeholder until the fence closes.",
      "- Interleave prose -> visual -> prose when useful. Use a visual only when it genuinely carries the explanation.",
      "",
      "Finish streaming by sending the remaining final chunk in a normal call with a short 'title'. Partial chunks concatenate verbatim: include your own spacing/newlines and never repeat text already sent. The final call blocks and returns the next event.",
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
    name: "list_rabbitholes",
    description:
      "List saved Rabbitholes (most recently updated first) so you can resume one by hole_id via " +
      "open_rabbithole. Returns id, title, last-updated time, and node count for each.",
    input: obj({}),
    resultKind: "json",
    run: () => listRabbitholes(),
  },
];
