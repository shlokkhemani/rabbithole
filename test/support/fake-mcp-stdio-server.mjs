import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const lifecyclePath = process.env.NORA_FAKE_MCP_LIFECYCLE;
let extraRegistered = false;

const server = new McpServer({ name: "nora-fake-stdio", version: "1.0.0" });
registerBaseServerFeatures(server);

if (lifecyclePath) fs.appendFileSync(lifecyclePath, `start ${process.pid}\n`);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stdin.on("end", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

async function shutdown() {
  if (lifecyclePath) fs.appendFileSync(lifecyclePath, `close ${process.pid}\n`);
  await server.close().catch(() => {});
  process.exit(0);
}

/** @param {McpServer} mcp */
function registerBaseServerFeatures(mcp) {
  mcp.registerTool("echo", {
    description: "Echo one message",
    inputSchema: { message: z.string().optional() },
  }, async ({ message = "" }) => ({
    content: [{ type: "text", text: `echo:${message}` }],
  }));

  mcp.registerTool("large", {
    description: "Return a large payload",
    inputSchema: {},
  }, async () => ({
    content: [{ type: "text", text: "x".repeat(300000) }],
  }));

  mcp.registerTool("slow", {
    description: "Wait until cancelled or delayed",
    inputSchema: { delayMs: z.number().default(5000) },
  }, async ({ delayMs }, extra) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      extra.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("slow tool cancelled"));
      }, { once: true });
    });
    return { content: [{ type: "text", text: "slow:done" }] };
  });

  mcp.registerTool("enable-extra", {
    description: "Register another tool and notify clients",
    inputSchema: {},
  }, async () => {
    if (!extraRegistered) {
      extraRegistered = true;
      mcp.registerTool("extra", {
        description: "Extra tool added after startup",
        inputSchema: {},
      }, async () => ({ content: [{ type: "text", text: "extra:ok" }] }));
      mcp.sendToolListChanged();
    }
    return { content: [{ type: "text", text: "extra:enabled" }] };
  });

  mcp.registerResource("note", "test://note", { mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: String(uri), text: "resource text" }],
  }));
}
