/**
 * Pack/install/launch release smoke test.
 *
 * Kept out of `npm test`: it creates and installs a real npm artifact, so it is
 * slower and more sensitive to the local npm cache/network than the default
 * deterministic suite. CI runs it separately on every supported Node version.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TIMEOUT_MS = 15_000;

async function filesBelow(relativeDir) {
  const absoluteDir = path.join(ROOT, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForInitialize(child) {
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

  const response = await withTimeout(
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(
        `server exited before initialize response (code=${code}, signal=${signal}, stderr=${stderr})`
      )));
      child.stdout.on("data", () => {
        const lines = stdout.split("\n");
        if (lines.length < 2) return;
        try {
          resolve(JSON.parse(lines[0]));
        } catch (error) {
          reject(new Error(`stdout was not newline-delimited JSON: ${error.message}\n${stdout}`));
        }
      });
    }),
    "MCP initialize"
  );

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(typeof response.result?.protocolVersion, "string");
  assert.equal(response.result?.serverInfo?.name, "rabbithole");
  assert.equal(typeof response.result?.capabilities, "object");

  child.stdin.end();
  const exit = await withTimeout(waitForExit(child), "clean server shutdown").catch((error) => {
    child.kill("SIGTERM");
    throw error;
  });
  assert.deepEqual(exit, { code: 0, signal: null });

  const outputLines = stdout.trim().split("\n").filter(Boolean);
  assert.equal(outputLines.length, 1, `unexpected extra stdout: ${stdout}`);
  for (const line of outputLines) assert.doesNotThrow(() => JSON.parse(line));
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-packaging-"));
let child;
try {
  const packDir = path.join(temporaryRoot, "pack");
  const projectDir = path.join(temporaryRoot, "project");
  const dataDir = path.join(temporaryRoot, "data");
  await Promise.all([
    fs.mkdir(packDir),
    fs.mkdir(projectDir),
    fs.mkdir(dataDir),
  ]);

  const { stdout: packOutput } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", packDir],
    { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }
  );
  const [packResult] = JSON.parse(packOutput);
  assert.ok(packResult?.filename, "npm pack did not report a tarball");
  const packedPaths = new Set(packResult.files.map((entry) => entry.path));
  const permittedPathPatterns = [
    /^bin\//,
    /^dist\//,
    /^src\//,
    /^README\.md$/,
    /^LICENSE$/,
    /^package\.json$/,
  ];
  const unexpectedPaths = [...packedPaths].filter((packedPath) =>
    !permittedPathPatterns.some((pattern) => pattern.test(packedPath))
  );
  assert.deepEqual(unexpectedPaths, [], `tarball contains unexpected paths:\n${unexpectedPaths.join("\n")}`);
  const requiredPaths = [
    "package.json",
    "README.md",
    "LICENSE",
    "bin/mcp-server.js",
    ...(await filesBelow("src/node")),
    ...(await filesBelow("src/core")),
    ...(await filesBelow("dist")),
  ];
  for (const requiredPath of requiredPaths) {
    assert.ok(packedPaths.has(requiredPath), `tarball is missing ${requiredPath}`);
  }

  await fs.writeFile(
    path.join(projectDir, "package.json"),
    `${JSON.stringify({ name: "rabbithole-packaging-smoke", private: true }, null, 2)}\n`
  );
  const tarball = path.join(packDir, packResult.filename);
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund", tarball],
    { cwd: projectDir, maxBuffer: 10 * 1024 * 1024 }
  );

  const binPath = path.join(projectDir, "node_modules", ".bin", "rabbithole-mcp");
  await fs.access(binPath, fs.constants.X_OK);
  child = spawn(binPath, [], {
    cwd: projectDir,
    env: {
      ...process.env,
      RABBITHOLE_DIR: dataDir,
      RABBITHOLE_NO_BROWSER: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "packaging-smoke", version: "1.0.0" },
    },
  })}\n`);
  await waitForInitialize(child);
  child = undefined;

  console.log(`ok packaging: asserted ${requiredPaths.length} paths and initialized installed rabbithole-mcp`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await withTimeout(waitForExit(child), "forced server shutdown").catch(() => child.kill("SIGKILL"));
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
