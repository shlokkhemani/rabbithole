import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

/**
 * @param {{ delayMs?: number }} [options]
 */
export async function startFakeMcpHttpServer(options = {}) {
  const state = {
    requests: [],
    delayMs: options.delayMs ?? 0,
  };
  const server = http.createServer(async (req, res) => {
    state.requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    try {
      const body = await readJsonBody(req);
      const mcp = createHttpMcpServer(state);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      res.on("close", () => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      });
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start fake MCP HTTP server");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests: state.requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined))),
  };
}

/** @param {{ delayMs: number }} state */
function createHttpMcpServer(state) {
  const server = new McpServer({ name: "nora-fake-http", version: "1.0.0" });
  server.registerTool("echo", {
    description: "Echo one message over HTTP",
    inputSchema: { message: z.string().optional() },
  }, async ({ message = "" }) => {
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    return { content: [{ type: "text", text: `http:${message}` }] };
  });
  server.registerResource("remote-note", "test://remote-note", { mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: String(uri), text: "http resource text" }],
  }));
  return server;
}

/** @param {http.IncomingMessage} req */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
