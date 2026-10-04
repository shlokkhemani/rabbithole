/** @protects codex isolation capability contracts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  CodexAppServer,
  prepareCodexHome,
} from "../../src/node/bridge/agents/codex.js";
import { resolveExecutable } from "../../src/node/bridge/agents/isolation.js";
import { assertNoDeletedSubscriptionMechanisms } from "../support/subscription-source-guard.mjs";

const execFileAsync = promisify(execFile);
await assertNoDeletedSubscriptionMechanisms();
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-codex-isolation-"));
const home = path.join(temporaryRoot, "home");
const data = path.join(temporaryRoot, "data");
const cwd = path.join(temporaryRoot, "cwd");
await fs.mkdir(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
await fs.mkdir(cwd, { mode: 0o700 });

let resolveCaptured;
let rejectCaptured;
const captured = new Promise((resolve, reject) => {
  resolveCaptured = resolve;
  rejectCaptured = reject;
});
const stub = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    if (raw) {
      try {
        resolveCaptured(JSON.parse(raw));
      } catch (error) {
        rejectCaptured(error);
      }
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"offline isolation capture complete"}}');
  });
});
await new Promise((resolve, reject) => {
  stub.once("error", reject);
  stub.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
});
const stubPort = stub.address().port;
const providerConfig = [
  'model = "rabbithole-isolation-model"',
  'model_provider = "rabbithole_test"',
  "",
  "[model_providers.rabbithole_test]",
  'name = "Rabbithole isolation test"',
  `base_url = "http://127.0.0.1:${stubPort}/v1"`,
  'env_key = "RABBITHOLE_ISOLATION_KEY"',
  'wire_api = "responses"',
  "requires_openai_auth = false",
].join("\n");

const baseEnv = {
  ...process.env,
  HOME: home,
  RABBITHOLE_DIR: data,
  RABBITHOLE_ISOLATION_KEY: "offline-test-key",
};
const executable = resolveExecutable("codex", undefined, baseEnv);
assert.ok(executable, "acceptance A/C require an installed codex binary");
const codexHome = await prepareCodexHome({
  env: baseEnv,
  configSuffix: providerConfig,
});
const env = { ...baseEnv, CODEX_HOME: codexHome };
const appServer = new CodexAppServer({
  executable,
  env,
  cwd,
  version: "0.4.0-test",
});

try {
  await appServer.ensureStarted().catch((error) => {
    throw new Error(
      `app-server start failed: ${JSON.stringify({
        protocol: appServer.lastProtocolError,
        modes: appServer.modeList,
      })}`,
      { cause: error }
    );
  });
  const thread = await appServer.request("thread/start", {
    model: "rabbithole-isolation-model",
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    developerInstructions: "",
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
  }).catch((error) => {
    throw new Error(
      `thread/start failed: ${JSON.stringify(appServer.lastProtocolError)}`,
      { cause: error }
    );
  });
  assert.ok(thread?.thread?.id);
  await appServer.request("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: "Reply with OK." }],
    cwd,
    environments: [],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    model: "rabbithole-isolation-model",
    effort: "medium",
    summary: "none",
    collaborationMode: appServer.executionMode({
      model: "rabbithole-isolation-model",
      effort: "medium",
      developerInstructions: "",
    }),
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Codex did not contact the loopback provider")), 10_000);
  });
  const providerRequest = await Promise.race([captured, timeout]);
  const capturedToolNames = providerRequest.tools.map((tool) => tool.name);
  assert.deepEqual(capturedToolNames, ["update_plan"]);
  assert.deepEqual(providerRequest.tools[0].parameters, {
    type: "object",
    properties: {
      explanation: {
        type: "string",
        description: "Optional explanation for this plan update.",
      },
      plan: {
        type: "array",
        description: "The list of steps",
        items: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description: "Step status.",
              enum: ["pending", "in_progress", "completed"],
            },
            step: {
              type: "string",
              description: "Task step text.",
            },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["plan"],
    additionalProperties: false,
  });
  assert.equal(/mcp__|tool_search/i.test(JSON.stringify(providerRequest)), false);
  process.stdout.write(`acceptance A tools=${JSON.stringify(capturedToolNames)}\n`);

  const started = process.hrtime.bigint();
  const mcp = await execFileAsync(executable, ["mcp", "list", "--json"], {
    cwd,
    env,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const mcpList = JSON.parse(mcp.stdout);
  assert.deepEqual(mcpList, []);
  assert.ok(elapsedMs < 1000, `private Codex MCP list took ${elapsedMs.toFixed(1)}ms`);
  const cachePath = path.join(data, "codex-models.json");
  const cacheExists = await fs.access(cachePath).then(() => true, () => false);
  assert.equal(cacheExists, false);
  process.stdout.write(
      `acceptance C mcp=${JSON.stringify(mcpList)} elapsed_ms=${elapsedMs.toFixed(1)} `
    + `cache_exists=${cacheExists} source_guard=clean\n`
  );
} finally {
  appServer.close();
  await new Promise((resolve) => stub.close(resolve));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("codex isolation ok\n");
