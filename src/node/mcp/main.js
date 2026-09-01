import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log, error as logError } from "../shared/logger.js";
import { toolDefinitions } from "./tools.js";
import {
  CONVERT_RULE,
  LISTENER_RULE,
  REGION_AND_ATTACHMENTS,
  CONTEXT_READING_RULE,
  STREAMING_RULE,
  SUB_AGENT_PROTOCOL,
} from "./protocol.js";
import { closeAllSessions } from "./registry.js";

const server = new McpServer(
  { name: "rabbithole", version: "0.1.0" },
  {
    instructions: [
      "Rabbithole opens a document on an infinite canvas where the human learns by branching:",
      "they select text, ask a question, and your answer appears as a child document node.",
      "Treat the words 'Rabbithole' and 'rabbit hole' as an explicit request to use this MCP server,",
      "not as a request for a Markdown outline or a generic step-by-step explanation. Never claim a",
      "Rabbithole is open or that you are listening unless open_rabbithole or an ordinary, non-delegated",
      "final answer_branch call is actually still running.",
      "",
      "Flow:",
      "1. Call open_rabbithole with { title, content } to open a document (or { hole_id } to resume).",
      "   When opening content fetched from a URL or repo, pass the document's own URL as base_url.",
      "   For local PDFs, pass { file_path } directly; Rabbithole opens native JPEG pages and",
      "   deterministic extracted text. Prefer arXiv HTML plus base_url when available.",
      "2. It blocks and returns status='branch_request' when the human asks about a selection. Retain its",
      "   session_id and request_id for answering, and its hole_id for restoring the listener.",
      "3. STREAM the answer with answer_branch: send 1–3 sentence chunks with partial=true (each",
      "   returns immediately and appears live), then the remaining final chunk in a normal call",
      "   with a short node title. Chunks concatenate verbatim — never repeat text already sent.",
      "4. An ORDINARY final answer_branch remains blocked as the single background listener for the next real canvas event.",
      "   Do not poll or periodically re-attach; an idle canvas consumes zero model turns.",
      "   Do not post a host-chat final answer or otherwise end the agent turn while this listener should",
      "   remain active. The pending MCP call is the listener; ending the turn can cancel it.",
      "5. Keep looping only when a real branch_request arrives, until status='session_closed'.",
      "",
      LISTENER_RULE,
      STREAMING_RULE,
      SUB_AGENT_PROTOCOL,
      CONVERT_RULE,
      "",
      "A branch_request with empty selected_text is a follow-up chat question about the whole parent",
      "document — answer it conversationally in that document's context. A request may carry a 'lens' preset key",
      "(explain | eli5 | deeper | custom) plus a separate 'instruction' — honor that instruction while answering the human's own question.",
      "When a preset request has an empty question, its implicit subject is the selection or the whole parent document. One with",
      "saved=true was asked while no agent was listening; answer it like any other.",
      "Branch requests are lean — selected_text, the parent node's title, and the lineage of titles.",
      "Branch requests may include 'notes': margin notes and standalone canvas notes. Entries with author='agent' were published by an agent; unlabelled entries are the human's own notes.",
      "Entries with on_lineage: true are in the direct thread of the question (usually the note the human is replying to) — treat them as the document under discussion.",
      "Other entries are the human's ambient margin notes — context to weigh, never questions to answer.",
      "Anchored notes reference the marked text in on_selected_text.",
      "When branch_request.anchor.block is present, the selection came from that rendered visual block; use its fenced source in the parent document as context.",
      "A session_closed result includes its close reason and may include 'notes' — the human's notes at close (e.g. margin feedback left before hitting Done); review them before wrapping up.",
      "When a branch_request includes region.image_path, it is the new selection clip or immediate parent's clip.",
      "Read that image before answering and trust it",
      "over extracted text for math, tables, and figures. The region page number is included alongside it.",
      "When a branch_request includes attachments, read every attachments[].image_path before answering;",
      "these are images the human pasted directly into the question.",
      "Branch requests include a compact map and automatically carry a thread when this session has not delivered its lineage.",
      "Use read_rabbithole when you need other saved node or note text verbatim.",
      CONTEXT_READING_RULE,
      REGION_AND_ATTACHMENTS,
      "When the human explicitly asks you to save or send a new document to an existing canvas, use",
      "send_to_rabbithole. It publishes an answer document by default; choose kind='note' only for an annotation.",
      "It is durable and never opens the browser. Do not use it speculatively,",
      "and do not use it as a substitute for answer_branch when a real branch_request exists.",
      "",
      "Answer authoring:",
      "- Use GFM markdown, $...$/$$...$$ or \\(...\\)/\\[...\\] math, and highlighted language-tagged code fences.",
      "- For local images that are not on the web, pass assets and reference them as ![alt](asset:name.png).",
      "- For spatial structure, use ```show fences with HTML/CSS/inline-SVG only; scripts are stripped. You may include id=<slug>; Rabbithole mints missing ids on persist.",
      "- For a knowledge check, use a ```check fence with strict JSON, e.g. {\"question\":\"2 + 2?\",\"options\":[\"3\",\"4\"],\"answer\":1}.",
      "- Stream prose in 1-3 sentence chunks, but send each visual fence contiguously so it renders when closed.",
    ].join("\n"),
  }
);

function formatSuccessText(result) {
  return JSON.stringify(result);
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

for (const tool of toolDefinitions) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.input },
    async (params, extra) => {
      try {
        if (tool.validateInput) tool.validateInput(params);
        const result = await /** @type {any} */ (tool.run)(params, extra);
        return { content: [{ type: /** @type {const} */ ("text"), text: formatSuccessText(result) }] };
      } catch (err) {
        const message = getErrorMessage(err);
        logError(`${tool.name} failed: ${message}`);
        return { content: [{ type: /** @type {const} */ ("text"), text: `Error: ${message}` }], isError: true };
      }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // If the MCP client disconnects (Claude Code exits or drops the server) the
  // browsers must not keep queueing asks nobody will answer — close every
  // session (which broadcasts session_closed) and exit.
  server.server.onclose = () => shutdown("client_disconnected");
  log("Rabbithole MCP server running on stdio");
}

main().catch((err) => {
  logError(`Fatal: ${getErrorMessage(err)}`);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}, shutting down`);
  try {
    // Tell every open canvas the agent is gone and flush debounced saves
    // before the event loop dies.
    await Promise.race([closeAllSessions("agent_exited"), new Promise((r) => setTimeout(r, 2000))]);
  } catch (err) {
    logError(`Shutdown flush failed: ${getErrorMessage(err)}`);
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

// Stdin EOF means the parent (terminal agent) is gone even if no signal was
// delivered — without this, sessions would linger and asks would hang silently.
process.stdin.on("end", () => shutdown("stdin_end"));
process.stdin.on("close", () => shutdown("stdin_close"));
