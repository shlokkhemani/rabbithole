/** @protects the release version reaching the CLI, the MCP handshake, and the built browser bundles from package.json alone. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
const version = packageJson.version;

test("package.json carries a 0.MINOR.PATCH version", () => {
  assert.match(version, /^0\.\d+\.\d+$/, "the release scheme is 0.MINOR.PATCH until 1.0");
});

test("the CLI prints the package version", async () => {
  for (const flag of ["--version", "-v"]) {
    const result = await run(process.execPath, [path.join(rootDir, "bin/rabbithole.js"), flag]);
    assert.equal(result.code, 0, `rabbithole ${flag} should exit 0, got ${result.code}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), version, `rabbithole ${flag} should print the package version`);
  }
});

test("the MCP server reports the package version in its server info", async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-version-"));
  try {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "version-test", version: "0.0.0" },
      },
    };
    const response = await handshake(initialize, { RABBITHOLE_DIR: storeDir, RABBITHOLE_NO_BROWSER: "1" });
    assert.equal(response.result.serverInfo.version, version);
    assert.equal(response.result.serverInfo.name, "rabbithole");
  } finally {
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});

/*
 * The committed bundles are what an installed package runs, so the injected
 * version has to survive bundling and minification. They carry no commit: the
 * stamp would make dist/ irreproducible and check:dist would fail every build.
 */
test("the committed browser bundles carry the injected version", async () => {
  for (const name of ["client.js", "frozen-client.js"]) {
    const bundle = await fs.readFile(path.join(rootDir, "dist", name), "utf8");
    assert.ok(
      bundle.includes(`"v${version}"`) || bundle.includes(`"${version}"`),
      `dist/${name} should contain the injected version ${version}; run npm run build`,
    );
  }
});

/*
 * One initialize exchange over stdio. Stdin stays open until the reply lands:
 * closing it is how the server is told its agent is gone, and it would race
 * the response out of the process.
 */
function handshake(request, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(rootDir, "bin/mcp-server.js")], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const finish = (error, message) => {
      child.kill();
      if (error) reject(error);
      else resolve(message);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === request.id) finish(null, message);
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", () => finish(new Error(`MCP server exited before answering initialize: ${stderr}`)));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}
