import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NoraMcpConnection } from "../../src/extension/mcp/connection.js";
import { createMcpToolBundle } from "../../src/extension/mcp/pi-tool.js";
import { McpSupervisor } from "../../src/extension/mcp/supervisor.js";
import { startFakeMcpHttpServer } from "../support/fake-mcp-http-server.mjs";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

const STDIO_SERVER = path.resolve("test/support/fake-mcp-stdio-server.mjs");

test("MCP bridge shares lazy stdio connections, exposes generic/direct tools, refreshes lists, and bounds output", async () => {
  await withTempDir(async (dir) => {
    const lifecyclePath = path.join(dir, "lifecycle.log");
    await writeMcpConfig(dir, {
      servers: {
        stdio: {
          type: "stdio",
          command: process.execPath,
          args: [STDIO_SERVER],
          env: { NORA_FAKE_MCP_LIFECYCLE: lifecyclePath },
        },
      },
    });
    const outputLines = [];
    const supervisor = new McpSupervisor({
      outputChannel: { appendLine: (line) => outputLines.push(line) },
      callTimeoutMs: 5000,
    });
    const first = createMcpToolBundle({ workspaceFolderPath: dir, supervisor, directTools: ["stdio/echo"] });
    const second = createMcpToolBundle({ workspaceFolderPath: dir, supervisor, directTools: ["stdio/echo"] });
    try {
      const generic = first.tools.find((tool) => tool.name === "mcp");
      const direct = second.tools.find((tool) => tool.name === "mcp__stdio__echo");

      await assert.rejects(() => fs.readFile(lifecyclePath, "utf8"), /ENOENT/, "server starts only on first real MCP request");

      const directResult = await direct.execute("call-1", { message: "hello" });
      assert(parseToolResult(directResult).result.includes("echo:hello"));
      await waitFor(async () => (await readOptional(lifecyclePath)).includes("start"));
      assert.equal(startCount(await readOptional(lifecyclePath)), 1, "shared supervisor reuses one stdio child");

      const resource = parseToolResult(await generic.execute("call-2", {
        operation: "read_resource",
        server: "stdio",
        uri: "test://note",
      }));
      assert(resource.result.includes("resource text"));

      const large = parseToolResult(await generic.execute("call-3", {
        operation: "call",
        server: "stdio",
        tool: "large",
        arguments: {},
      }));
      assert.equal(large.truncated, true);
      assert(large.resultLines <= 2000);

      await generic.execute("call-4", {
        operation: "call",
        server: "stdio",
        tool: "enable-extra",
        arguments: {},
      });
      await waitFor(async () => {
        const search = parseToolResult(await generic.execute("call-5", {
          operation: "search",
          server: "stdio",
          query: "extra",
        }));
        return search.result.includes("extra");
      });

      await first.dispose();
      assert(!(await readOptional(lifecyclePath)).includes("close"), "one release keeps the shared connection alive");
      await second.dispose();
      await waitFor(async () => (await readOptional(lifecyclePath)).includes("close"));

      assert(outputLines.some((line) => line.includes("operation=call_tool") && line.includes("status=ok")));
      assert(!outputLines.join("\n").includes(lifecyclePath));
      assert(!outputLines.join("\n").includes("hello"));
    } finally {
      await first.dispose();
      await second.dispose();
      await supervisor.dispose();
    }
  });
});

test("MCP bridge supports Streamable HTTP tools, resources, and configured headers without logging secrets", async () => {
  await withTempDir(async (dir) => {
    const httpServer = await startFakeMcpHttpServer();
    const outputLines = [];
    /** @type {ReturnType<typeof createMcpToolBundle> | null} */
    let bundle = null;
    /** @type {McpSupervisor | null} */
    let supervisor = null;
    try {
      await writeMcpConfig(dir, {
        servers: {
          http: {
            type: "http",
            url: httpServer.url,
            headers: { Authorization: "Bearer test-secret" },
          },
        },
      });
      supervisor = new McpSupervisor({
        outputChannel: { appendLine: (line) => outputLines.push(line) },
        callTimeoutMs: 5000,
      });
      bundle = createMcpToolBundle({ workspaceFolderPath: dir, supervisor });
      const generic = bundle.tools.find((tool) => tool.name === "mcp");

      const called = parseToolResult(await generic.execute("http-1", {
        operation: "call",
        server: "http",
        tool: "echo",
        arguments: { message: "world" },
      }));
      assert(called.result.includes("http:world"));

      const listed = parseToolResult(await generic.execute("http-2", {
        operation: "list_resources",
        server: "http",
      }));
      assert(listed.result.includes("test://remote-note"));

      assert(httpServer.requests.some((request) => request.headers.authorization === "Bearer test-secret"));
      assert(!outputLines.join("\n").includes("test-secret"));
      assert(!outputLines.join("\n").includes(httpServer.url));
    } finally {
      await bundle?.dispose();
      await supervisor?.dispose();
      await httpServer.close();
    }
  });
});

test("MCP bridge propagates cancellation and enforces reconnect and config-rotation boundaries", async () => {
  await withTempDir(async (dir) => {
    await writeMcpConfig(dir, {
      servers: {
        stdio: {
          type: "stdio",
          command: process.execPath,
          args: [STDIO_SERVER],
        },
      },
    });
    const supervisor = new McpSupervisor({ callTimeoutMs: 5000 });
    const bundle = createMcpToolBundle({ workspaceFolderPath: dir, supervisor });
    try {
      const generic = bundle.tools.find((tool) => tool.name === "mcp");
      const controller = new AbortController();
      const pending = generic.execute("cancel-1", {
        operation: "call",
        server: "stdio",
        tool: "slow",
        arguments: { delayMs: 5000 },
      }, controller.signal);
      setTimeout(() => controller.abort(), 50).unref();
      await assert.rejects(() => pending, /abort|cancel|Request/i);
    } finally {
      await bundle.dispose();
      await supervisor.dispose();
    }
  });

  const attempts = [];
  class FailingClient {
    async connect() {
      attempts.push("connect");
    }
    async callTool() {
      throw new Error("transport failed");
    }
    async close() {
      attempts.push("close");
    }
  }
  class FakeTransport {
    async close() {
      attempts.push("transport-close");
    }
  }
  const connection = new NoraMcpConnection({
    server: {
      name: "retry",
      type: "stdio",
      command: "node",
      args: [],
      cwd: undefined,
      env: {},
      fingerprint: "retry",
    },
    ClientCtor: FailingClient,
    StdioClientTransportCtor: FakeTransport,
    maxReconnectAttempts: 2,
    callTimeoutMs: 100,
  });
  await assert.rejects(() => connection.callTool("echo", {}), /transport failed/);
  assert.equal(attempts.filter((entry) => entry === "connect").length, 3);

  const staleAttempts = [];
  const connectResolvers = [];
  let clientSeq = 0;
  class SlowClient {
    constructor() {
      this.id = ++clientSeq;
    }
    async connect() {
      staleAttempts.push(`connect-${this.id}`);
      await new Promise((resolve) => connectResolvers.push(resolve));
    }
    async listTools() {
      staleAttempts.push(`list-${this.id}`);
      return { tools: [{ name: `tool-${this.id}` }] };
    }
    async close() {
      staleAttempts.push(`client-close-${this.id}`);
    }
  }
  class SlowTransport {
    constructor() {
      this.id = clientSeq + 1;
    }
    async close() {
      staleAttempts.push(`transport-close-${this.id}`);
    }
  }
  const staleConnection = new NoraMcpConnection({
    server: {
      name: "stale",
      type: "stdio",
      command: "node",
      args: [],
      cwd: undefined,
      env: {},
      fingerprint: "stale",
    },
    ClientCtor: SlowClient,
    StdioClientTransportCtor: SlowTransport,
    maxReconnectAttempts: 1,
    callTimeoutMs: 100,
  });
  const listedTools = staleConnection.listTools();
  await waitFor(() => connectResolvers.length === 1);
  staleConnection.markStale();
  connectResolvers[0]();
  await waitFor(() => connectResolvers.length === 2);
  connectResolvers[1]();
  assert.deepEqual(await listedTools, [{ name: "tool-2" }]);
  assert.deepEqual(staleAttempts.filter((entry) => entry.startsWith("list-")), ["list-2"]);
  assert(staleAttempts.includes("client-close-1"), "stale startup client is closed instead of reused");
  await staleConnection.close();

  const fakeConnection = {
    stale: false,
    closed: 0,
    markStale() { this.stale = true; },
    async close() { this.closed += 1; },
  };
  const rotating = new McpSupervisor({ connectionFactory: () => fakeConnection });
  const server = {
    name: "server",
    type: "stdio",
    command: "node",
    args: [],
    cwd: undefined,
    env: {},
    fingerprint: "a",
  };
  const first = rotating.acquire("/workspace", server);
  const second = rotating.acquire("/workspace", server);
  rotating.markWorkspaceChanged("/workspace");
  assert.equal(fakeConnection.stale, true);
  await first.release();
  assert.equal(fakeConnection.closed, 0);
  await second.release();
  assert.equal(fakeConnection.closed, 1);
});

/**
 * @param {string} dir
 * @param {unknown} config
 */
async function writeMcpConfig(dir, config) {
  await fs.mkdir(path.join(dir, ".vscode"), { recursive: true });
  await fs.writeFile(path.join(dir, ".vscode", "mcp.json"), JSON.stringify(config, null, 2));
}

/** @param {{ content: Array<{ text: string }> }} result */
function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

/** @param {string} filePath */
async function readOptional(filePath) {
  return fs.readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
}

/** @param {string} text */
function startCount(text) {
  return text.split("\n").filter((line) => line.startsWith("start ")).length;
}

/** @param {() => Promise<boolean> | boolean} predicate */
async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}
