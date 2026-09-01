import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log, error as logError } from "../shared/logger.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { toolDefinitions } from "./tools.js";
import { closeAllSessions } from "./registry.js";

const server = new McpServer(
  { name: "rabbithole", version: "0.1.0" },
  {
    instructions: SERVER_INSTRUCTIONS,
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
