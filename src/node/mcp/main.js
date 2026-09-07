import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log, error as logError } from "../shared/logger.js";
import { buildServerInstructions } from "./instructions.js";
import { answerBranchDescription, toolDefinitions } from "./tools.js";
import { closeAllSessions } from "./registry.js";
import { formatToolSuccess } from "./tool-result.js";
import { AI_IMAGES_PREF_KEY, readImagesEnabled } from "./images-setting.js";
import { onPreferencesMerged } from "./store/prefs-store.js";

// package.json is the single source of truth for the release version.
const require = createRequire(import.meta.url);

let server = null;
let stopPreferences = null;

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export async function main() {
  const enabled = await readImagesEnabled();
  server = new McpServer(
    { name: "rabbithole", version: require("../../../package.json").version },
    {
      instructions: buildServerInstructions({ imagesEnabled: enabled }),
    }
  );
  const handles = new Map();
  for (const tool of toolDefinitions) {
    handles.set(tool.name, server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (params, extra) => {
        try {
          if (tool.validateInput) tool.validateInput(params);
          const result = await /** @type {any} */ (tool.run)(params, extra);
          return formatToolSuccess(tool, result);
        } catch (err) {
          const message = getErrorMessage(err);
          logError(`${tool.name} failed: ${message}`);
          return { content: [{ type: /** @type {const} */ ("text"), text: `Error: ${message}` }], isError: true };
        }
      }
    ));
  }

  let currentImagesEnabled = true;
  function applyImagesEnabled(next) {
    if (next === currentImagesEnabled) return;
    if (next) {
      handles.get("answer_branch").update({ description: answerBranchDescription({ imagesEnabled: true }) });
      handles.get("generate_image").enable();
    } else {
      handles.get("generate_image").disable();
      handles.get("answer_branch").update({ description: answerBranchDescription({ imagesEnabled: false }) });
    }
    currentImagesEnabled = next;
  }

  applyImagesEnabled(enabled);
  stopPreferences = onPreferencesMerged((values) => {
    if (AI_IMAGES_PREF_KEY in values) applyImagesEnabled(values[AI_IMAGES_PREF_KEY] === "on");
  });

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
  stopPreferences?.();
  stopPreferences = null;
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
