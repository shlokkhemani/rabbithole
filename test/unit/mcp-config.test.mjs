import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseMcpConfigText } from "../../src/extension/mcp/config.js";
import { resolveMcpServerConfig } from "../../src/extension/mcp/variables.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("MCP config parses JSONC servers, inputs, envFile, and VS Code variables", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, ".vscode"), { recursive: true });
    await fs.writeFile(path.join(dir, "mcp.env"), "FROM_FILE=${env:FROM_ENV}\nPROMPTED=${input:secret}\n");
    const config = parseMcpConfigText(`{
      // Nora accepts JSONC because VS Code mcp.json does.
      "inputs": [
        { "id": "secret", "type": "promptString", "description": "Secret", "password": true },
        { "id": "choice", "type": "pickString", "options": ["alpha", { "label": "Beta", "value": "beta" }] },
        { "id": "cmd", "type": "command", "command": "nora.fakeInput", "args": { "kind": "test" } }
      ],
      "servers": {
        "stdio-main": {
          "type": "stdio",
          "command": "node",
          "args": ["\${workspaceFolderBasename}", "\${input:choice}", "\${input:cmd}"],
          "cwd": "\${workspaceFolder}",
          "envFile": "\${workspaceFolder}/mcp.env",
          "env": { "EXPLICIT": "\${userHome}" }
        },
        "http-main": {
          "type": "http",
          "url": "https://mcp.example.test/api",
          "headers": { "Authorization": "Bearer \${input:secret}" }
        }
      }
    }`, { source: path.join(dir, ".vscode", "mcp.json") });

    assert.deepEqual(config.diagnostics, []);
    assert.deepEqual([...config.servers.keys()], ["stdio-main", "http-main"]);
    assert.deepEqual([...config.inputs.keys()], ["secret", "choice", "cmd"]);

    const fakeVscode = {
      window: {
        showInputBox: async () => "prompt-value",
        showQuickPick: async (items) => items.find((item) => item.value === "beta"),
      },
      commands: {
        executeCommand: async (command, args) => `${command}:${args.kind}`,
      },
    };
    const resolved = await resolveMcpServerConfig(config.servers.get("stdio-main"), {
      workspaceFolderPath: dir,
      userHome: "/home/nora",
      env: { FROM_ENV: "env-value" },
      inputs: config.inputs,
      vscode: fakeVscode,
    });

    assert.equal(resolved.type, "stdio");
    assert.equal(resolved.command, "node");
    assert.deepEqual(resolved.args, [path.basename(dir), "beta", "nora.fakeInput:test"]);
    assert.equal(resolved.cwd, dir);
    assert.deepEqual(resolved.env, {
      FROM_FILE: "env-value",
      PROMPTED: "prompt-value",
      EXPLICIT: "/home/nora",
    });

    const http = await resolveMcpServerConfig(config.servers.get("http-main"), {
      workspaceFolderPath: dir,
      inputs: config.inputs,
      vscode: fakeVscode,
    });
    assert.equal(http.type, "http");
    assert.equal(http.headers.Authorization, "Bearer prompt-value");
  });
});

test("MCP config rejects unsupported transports, policy fields, invalid env and header names", () => {
  const config = parseMcpConfigText(`{
    "mcpServers": {},
    "servers": {
      "legacy": { "type": "sse", "url": "https://example.test/sse" },
      "sandboxed": { "type": "stdio", "command": "node", "sandbox": true },
      "bad-env": { "type": "stdio", "command": "node", "env": { "BAD-NAME": "x" } },
      "bad-header": { "type": "http", "url": "https://example.test/mcp", "headers": { "Bad Header": "x" } },
      "bad-url": { "type": "http", "url": "https://user:pass@example.test/mcp" }
    }
  }`, { source: "mcp.json" });

  assert.equal(config.servers.size, 0);
  assert(config.diagnostics.some((entry) => entry.message.includes("Unsupported top-level")));
  assert(config.diagnostics.some((entry) => entry.message.includes("Legacy SSE")));
  assert(config.diagnostics.some((entry) => entry.message.includes("rejects MCP OAuth")));
  assert(config.diagnostics.some((entry) => entry.message.includes("environment variable")));
  assert(config.diagnostics.some((entry) => entry.message.includes("HTTP header")));
  assert(config.diagnostics.some((entry) => entry.message.includes("userinfo")));
});

test("MCP variable resolution fails clearly for unresolved values", async () => {
  const config = parseMcpConfigText(`{
    "servers": {
      "stdio": { "type": "stdio", "command": "\${env:MISSING}" }
    }
  }`);
  await assert.rejects(
    () => resolveMcpServerConfig(config.servers.get("stdio"), { env: {} }),
    /unresolved environment variable MISSING/,
  );
});
