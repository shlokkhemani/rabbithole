import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log, error as logError } from "../logger.js";
import { buildMcpInputSchema } from "./schema.js";
import { toolDefinitions } from "../tools/manifest.js";
import { closeAllSessions } from "../sessions.js";

const server = new McpServer(
  { name: "rabbithole", version: "0.1.0" },
  {
    instructions: [
      "Rabbithole opens a document on an infinite canvas where the human learns by branching:",
      "they select text, ask a question, and your answer appears as a child document node.",
      "",
      "Flow:",
      "1. Call open_rabbithole with { title, content } to open a document (or { hole_id } to resume).",
      "   When opening content fetched from a URL or repo, pass the document's own URL as base_url.",
      "   For local PDFs, pass { file_path } directly; Rabbithole opens native JPEG pages and",
      "   deterministic extracted text. Prefer arXiv HTML plus base_url when available.",
      "2. It blocks and returns status='branch_request' when the human asks about a selection.",
      "3. STREAM the answer with answer_branch: send 1–3 sentence chunks with partial=true (each",
      "   returns immediately and appears live), then the remaining final chunk in a normal call",
      "   with a short node title. Chunks concatenate verbatim — never repeat text already sent.",
      "4. Keep looping answer_branch until status='session_closed'.",
      "A convert_request means the human clicked Create text version. Read pages[].image_path in order,",
      "follow its inline rules, and stream the transcription through answer_branch with that request_id.",
      "The host crops figure: references; never crop or send page images back.",
      "",
      "A branch_request with empty selected_text is a follow-up chat question about the whole parent",
      "document — answer it conversationally in that document's context. One with a 'lens' field",
      "(explain | eli5 | example | deeper) carries the style the human tapped — honor it. One with",
      "saved=true was asked while no agent was listening; answer it like any other.",
      "Branch requests are lean — selected_text, the parent node's title, and the lineage of titles.",
      "When a branch_request includes region.image_path, it is the new selection clip or immediate parent's clip.",
      "Read that image before answering and trust it",
      "over extracted text for math, tables, and figures. The region page number is included alongside it.",
      "You already hold the documents you authored, so that's enough context. On a RESUMED hole the",
      "first branch_request includes a 'rehydration' field with the full tree (plus any saved_asks);",
      "read it to reload context. Use list_rabbitholes to find a saved hole to resume.",
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
  return JSON.stringify(result, null, 2);
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

for (const tool of toolDefinitions) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: buildMcpInputSchema(tool.input) },
    async (params, extra) => {
      try {
        if (tool.validateInput) tool.validateInput(params);
        const result = await tool.run(params, extra);
        return { content: [{ type: "text", text: formatSuccessText(result) }] };
      } catch (err) {
        const message = getErrorMessage(err);
        logError(`${tool.name} failed: ${message}`);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
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
