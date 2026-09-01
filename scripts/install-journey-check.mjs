import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const READY_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 300_000;
const PROCESS_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SCRUBBED_PATH = "/usr/bin:/bin";
const liveChildren = new Set();
let realModelTurns = 0;
const REAL_HOME = os.homedir();
const REAL_BRIDGE_TOKEN_PATH = path.join(REAL_HOME, ".rabbithole", "bridge-token");

/** @param {NodeJS.ProcessEnv} [extra] @returns {NodeJS.ProcessEnv} */
function commandEnv(extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, ...extra, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
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

function spawnCaptured(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
  liveChildren.add(child);
  let stdout = "";
  let stderr = "";
  const listeners = new Set();
  const append = (kind, chunk) => {
    if (kind === "stdout" && stdout.length < MAX_OUTPUT_BYTES) {
      stdout += chunk.slice(0, MAX_OUTPUT_BYTES - stdout.length);
    }
    if (kind === "stderr" && stderr.length < MAX_OUTPUT_BYTES) {
      stderr += chunk.slice(0, MAX_OUTPUT_BYTES - stderr.length);
    }
    for (const listener of listeners) listener();
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  const exit = waitForExit(child).finally(() => liveChildren.delete(child));
  return {
    child,
    exit,
    stdout: () => stdout,
    stderr: () => stderr,
    output: () => `${stdout}${stderr}`,
    onOutput(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function waitForOutput(run, inspect, timeoutMs, label) {
  let removeListener = () => {};
  let settled = false;
  const outputMatch = new Promise((resolve, reject) => {
    const check = () => {
      if (settled) return;
      try {
        const value = inspect(run);
        if (value !== undefined) {
          settled = true;
          removeListener();
          resolve(value);
        }
      } catch (error) {
        settled = true;
        removeListener();
        reject(error);
      }
    };
    removeListener = run.onOutput(check);
    check();
    run.exit.then(({ code, signal }) => {
      if (settled) return;
      settled = true;
      removeListener();
      reject(new Error(
        `${label}: process exited early (code=${code}, signal=${signal}): ${run.output().trim()}`,
      ));
    }, reject);
  });
  return withTimeout(outputMatch, timeoutMs, label);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "free-port probe must bind a TCP port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  return port;
}

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

async function modeOf(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

async function captureFile(filePath) {
  try {
    const [stats, bytes] = await Promise.all([
      fs.stat(filePath, { bigint: true }),
      fs.readFile(filePath),
    ]);
    assert.equal(
      stats.size,
      BigInt(bytes.length),
      `file capture for ${filePath} must observe matching stat and byte lengths`,
    );
    return {
      exists: true,
      mtimeNs: stats.mtimeNs,
      bytes,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function assertFileCaptureUnchanged(before, after, message) {
  assert.deepEqual(after, before, message);
}

function resolveOnPath(name, env) {
  const entries = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  if (os.platform() === "win32") return [];
  return entries.map((directory) => path.join(directory, name));
}

async function firstExecutable(name, env) {
  for (const candidate of resolveOnPath(name, env)) {
    if (await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) {
      return candidate;
    }
  }
  return null;
}

function isolatedBridgeEnv(home, extra = {}) {
  const env = commandEnv({
    HOME: home,
    RABBITHOLE_NO_BROWSER: "1",
  });
  delete env.RABBITHOLE_DIR;
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.RABBITHOLE_BRIDGE_CLAUDE_BIN;
  delete env.RABBITHOLE_BRIDGE_CODEX_BIN;
  Object.assign(env, extra);
  return env;
}

async function prepareRealCliEnv(dataDirectory) {
  const realCodexAuth = path.join(REAL_HOME, ".codex", "auth.json");
  assert.equal(
    await pathExists(realCodexAuth),
    true,
    "the real Codex auth file must exist before the bridge starts",
  );
  const env = isolatedBridgeEnv(REAL_HOME, {
    RABBITHOLE_DIR: dataDirectory,
  });
  const claudeBin = await firstExecutable("claude", env);
  const codexBin = await firstExecutable("codex", env);
  assert.ok(claudeBin, "the real Claude CLI must resolve for J1");
  assert.ok(codexBin, "the real Codex CLI must resolve for J1");
  return { env, realCodexAuth };
}

async function packProject(sourceDirectory, destination) {
  await fs.mkdir(destination, { recursive: true });
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", destination],
    {
      cwd: sourceDirectory,
      env: commandEnv(),
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const [result] = JSON.parse(stdout);
  assert.ok(result?.filename, "npm pack must report its tarball filename");
  assert.ok(
    result.files?.some((entry) => entry.path === "package.json"),
    "npm pack capture must contain package.json",
  );
  return path.join(destination, result.filename);
}

async function packHead(temporaryRoot) {
  const archive = path.join(temporaryRoot, "head.tar");
  const source = path.join(temporaryRoot, "head-source");
  const destination = path.join(temporaryRoot, "head-pack");
  await fs.mkdir(source);
  await execFileAsync(
    "git",
    ["archive", "--format=tar", "--output", archive, "HEAD"],
    { cwd: ROOT, env: commandEnv(), maxBuffer: 1024 * 1024 },
  );
  await execFileAsync(
    "tar",
    ["-xf", archive, "-C", source],
    { cwd: ROOT, env: commandEnv(), maxBuffer: 1024 * 1024 },
  );
  const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  assert.deepEqual(
    manifest.bin,
    { "rabbithole-mcp": "./bin/mcp-server.js" },
    "HEAD fixture must expose exactly the published MCP-only binary",
  );
  return packProject(source, destination);
}

async function installTarball({ tarball, prefix, cache, home }) {
  await Promise.all([
    fs.mkdir(prefix, { recursive: true }),
    fs.mkdir(cache, { recursive: true }),
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
  ]);
  await execFileAsync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      cache,
      tarball,
    ],
    {
      cwd: prefix,
      env: commandEnv({ HOME: home }),
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}

function installedPaths(prefix) {
  return {
    package: path.join(prefix, "node_modules", "@shlokkhemani", "rabbithole"),
    rabbithole: path.join(prefix, "node_modules", ".bin", "rabbithole"),
    mcp: path.join(prefix, "node_modules", ".bin", "rabbithole-mcp"),
  };
}

async function assertProductionInstall(paths) {
  assert.equal(
    await pathExists(path.join(paths.package, "src", "node", "bridge", "server.js")),
    true,
    "the installed package must contain the bridge implementation",
  );
  assert.equal(
    await pathExists(path.join(path.dirname(paths.package), "@modelcontextprotocol", "sdk")),
    true,
    "production dependency capture must contain the MCP SDK",
  );
  for (const devDependency of ["typescript", "playwright", "fake-indexeddb"]) {
    assert.equal(
      await pathExists(path.join(path.dirname(paths.package), devDependency)),
      false,
      `production install must omit devDependency ${devDependency}`,
    );
  }
  await Promise.all([
    fs.access(paths.rabbithole, fs.constants.X_OK),
    fs.access(paths.mcp, fs.constants.X_OK),
  ]);
}

class McpProcess {
  constructor(binary, env, clientName) {
    this.run = spawnCaptured(process.execPath, [binary], {
      cwd: path.dirname(binary),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = this.run.child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.clientName = clientName;
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.run.exit.then(({ code, signal }) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(
          `MCP process exited before response (code=${code}, signal=${signal}): ${this.run.stderr().trim()}`,
        ));
      }
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        for (const pending of this.pending.values()) {
          pending.reject(new Error(`MCP stdout contained non-JSON output: ${error.message}`));
        }
        this.pending.clear();
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    })}\n`);
    return withTimeout(response, PROCESS_TIMEOUT_MS, `MCP ${method}`);
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: this.clientName, version: "1.0.0" },
    });
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.result?.serverInfo?.name, "rabbithole");
    assert.ok(
      typeof response.result?.protocolVersion === "string"
        && response.result.protocolVersion.length > 0,
      "MCP initialize must return a non-empty protocol version",
    );
    assert.ok(
      response.result?.capabilities
        && typeof response.result.capabilities === "object"
        && !Array.isArray(response.result.capabilities),
      "MCP initialize capabilities must be a non-null object",
    );
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })}\n`);
    return response;
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
    const result = await withTimeout(this.run.exit, PROCESS_TIMEOUT_MS, "MCP clean shutdown");
    assert.deepEqual(result, { code: 0, signal: null }, "MCP process must exit cleanly on stdin EOF");
    return result;
  }
}

async function initializeInstalledMcp(binary, env, clientName) {
  const mcp = new McpProcess(binary, env, clientName);
  try {
    await mcp.initialize();
    return await mcp.request("tools/list", {});
  } finally {
    await mcp.close();
  }
}

function initializeShape(response) {
  return response.result.tools
    .map((tool) => ({
      name: tool.name,
      inputKeys: Object.keys(tool.inputSchema?.properties || {}).sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function spawnInstalledBridge(binary, args, env) {
  return spawnCaptured(process.execPath, [binary, "bridge", ...args], {
    cwd: path.dirname(binary),
    env,
  });
}

async function waitForBridgeStartup(run, timeoutMs = READY_TIMEOUT_MS) {
  return waitForOutput(run, (current) => {
    const output = current.output();
    const url = output.match(
      /Rabbithole bridge listening on (http:\/\/127\.0\.0\.1:\d+)/,
    )?.[1];
    const token = output.match(/Pairing token: ([a-f0-9]{64})/)?.[1];
    return url && token ? { url, token } : undefined;
  }, timeoutMs, "installed bridge startup");
}

async function stopProcess(run, label) {
  if (run.child.exitCode === null && run.child.signalCode === null) {
    run.child.kill("SIGTERM");
  }
  try {
    return await withTimeout(run.exit, PROCESS_TIMEOUT_MS, label);
  } catch (error) {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      run.child.kill("SIGKILL");
      await withTimeout(run.exit, 5_000, `${label} SIGKILL`).catch(() => {});
    }
    throw error;
  }
}

async function readSseJsonFrames(response, onFrame) {
  assert.ok(response.body, "SSE response must have a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return undefined;
    pending += decoder.decode(chunk.value, { stream: true });
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(pending);
      if (!boundary) break;
      const block = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const value = onFrame(JSON.parse(data));
      if (value !== undefined) {
        await reader.cancel();
        return value;
      }
    }
  }
}

function frameSummary(frames) {
  return frames.map((frame) => (
    frame.agents?.map((agent) => `${agent.id}:${agent.state}`).join(",") || "invalid"
  )).join(" -> ");
}

async function readBridgeState({
  url,
  token,
  done,
  validateAgent,
  timeoutMs = READY_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames = [];
  try {
    const response = await fetch(`${url}/bridge/events`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    assert.equal(response.status, 200, `bridge events returned HTTP ${response.status}`);
    const result = await readSseJsonFrames(response, (frame) => {
      frames.push(frame);
      assert.deepEqual(
        frame.agents?.map((agent) => agent.id).sort(),
        ["claude", "codex"],
        "bridge state capture must contain both real backend rows",
      );
      for (const agent of frame.agents) validateAgent(agent);
      return done(frame) ? frame : undefined;
    });
    if (result) return { state: result, frames };
    throw new Error(`bridge event stream closed before convergence: ${frameSummary(frames)}`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `bridge did not converge within ${timeoutMs}ms: ${frameSummary(frames)}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readReadyState(connection) {
  const intermediateStates = new Set();
  const result = await readBridgeState({
    ...connection,
    done: (frame) => (
      frame.agents.every((agent) => agent.state === "ready")
      || frame.agents.some((agent) => agent.state === "error")
    ),
    validateAgent(agent) {
      assert.ok(
        ["starting", "ready", "error"].includes(agent.state),
        `${agent.id} emitted unknown state ${agent.state}`,
      );
      if (agent.state === "ready") {
        assert.ok(
          Array.isArray(agent.models) && agent.models.length > 0,
          `${agent.id} reached ready without a non-empty catalog`,
        );
        assert.equal(Object.hasOwn(agent, "fix"), false);
      } else if (agent.state === "starting") {
        intermediateStates.add(agent.state);
        assert.equal(Object.hasOwn(agent, "fix"), false);
      }
    },
  });
  assert.ok(result.frames.length > 0, "ready-state capture must contain at least one SSE frame");
  const errorFrames = result.frames.filter((frame) => (
    frame.agents.some((agent) => agent.state === "error")
  ));
  assert.equal(errorFrames.length, 0, "healthy installed CLIs must emit no error frame");
  assert.deepEqual(
    [...intermediateStates],
    ["starting"],
    "the installed bridge must pass through starting and no other intermediate state before ready",
  );
  return {
    ...result,
    intermediateStates,
    errorFrames: errorFrames.length,
  };
}

async function readMissingState(connection) {
  const result = await readBridgeState({
    ...connection,
    done: (frame) => (
      frame.agents.some((agent) => agent.state === "error")
      || frame.agents.every((agent) => agent.state !== "starting")
    ),
    validateAgent(agent) {
      assert.ok(
        ["starting", "missing", "error"].includes(agent.state),
        `${agent.id} emitted unknown state ${agent.state} while real CLIs were absent`,
      );
      if (agent.state === "missing") {
        assert.ok(
          typeof agent.fix === "string" && agent.fix.trim(),
          `${agent.id} missing state must have an actionable fix`,
        );
      }
    },
  });
  assert.ok(result.frames.length > 0, "missing-state capture must contain at least one SSE frame");
  const errorFrames = result.frames.filter((frame) => (
    frame.agents.some((agent) => agent.state === "error")
  ));
  assert.equal(errorFrames.length, 0, "missing real CLIs must never be reported as error");
  return { ...result, errorFrames: errorFrames.length };
}

function agentsById(state) {
  return new Map(state.agents.map((agent) => [agent.id, agent]));
}

function chooseCheapestModel(state) {
  const byId = agentsById(state);
  const claudeModels = byId.get("claude")?.models || [];
  const haiku = claudeModels.find((model) => /\/haiku(?:$|\[)/i.test(model.id));
  assert.ok(haiku, "the live Claude catalog must expose Haiku for the cheapest real turn");
  return haiku;
}

async function runOneModelTurn(connection, state) {
  const model = chooseCheapestModel(state);
  const effort = model.reasoning?.options?.includes("low")
    ? "low"
    : model.reasoning?.default;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    assert.equal(
      realModelTurns,
      0,
      "install journey must not attempt more than one real model turn",
    );
    realModelTurns += 1;
    const response = await fetch(`${connection.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{
          role: "user",
          content: "Reply with one short word confirming this installed production bridge can answer.",
        }],
        stream: false,
        reasoning_effort: effort,
      }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200, `installed model turn returned HTTP ${response.status}`);
    const body = await response.json();
    assert.equal(body.object, "chat.completion", "model-turn capture must be a chat completion");
    const assistantText = body.choices?.[0]?.message?.content;
    assert.ok(
      typeof assistantText === "string" && assistantText.trim().length > 0,
      "installed production bridge must return non-empty assistant text",
    );
    return { model: model.id, assistantText: assistantText.trim(), modelTurns: realModelTurns };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`installed model turn exceeded ${TURN_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function processRows() {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,command="],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    }] : [];
  });
}

function descendantsOf(rows, rootPid) {
  const descendants = [];
  const parents = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (parents.has(row.pid) || !parents.has(row.ppid)) continue;
      parents.add(row.pid);
      descendants.push(row);
      changed = true;
    }
  }
  return descendants;
}

async function assertNoOwnedChildren({
  run,
  preRunRows,
  runningRows,
}) {
  const preRunKeys = new Set(preRunRows.map((row) => `${row.pid}\0${row.command}`));
  const ownedAtRuntime = descendantsOf(runningRows, run.child.pid)
    .filter((row) => !preRunKeys.has(`${row.pid}\0${row.command}`));
  assert.ok(
    ownedAtRuntime.length > 0,
    "parentage capture must observe at least one bridge-owned child before shutdown",
  );
  const exit = await stopProcess(run, "installed bridge SIGTERM shutdown");
  assert.deepEqual(exit, { code: 0, signal: null }, "installed bridge must exit cleanly on SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterRows = await processRows();
  const survivors = afterRows.filter((row) => (
    ownedAtRuntime.some((owned) => owned.pid === row.pid && owned.command === row.command)
    || row.ppid === run.child.pid
  ));
  for (const row of survivors) {
    try {
      process.kill(row.pid, "SIGTERM");
    } catch {
      // The child exited between the parentage check and cleanup.
    }
  }
  assert.equal(
    survivors.length,
    0,
    `bridge shutdown left child processes: ${
      survivors.map((row) => `${row.pid}:${row.command}`).join(", ")
    }`,
  );
  return { ownedAtRuntime, survivors };
}

function assertPairingOutput(run, connection) {
  const output = run.output();
  const pairingUrl = `https://rabbithole.ing/#bridge=${connection.token}`;
  assert.ok(
    output.includes(`Open ${pairingUrl}`),
    "installed bridge output must contain the copyable fragment pairing URL",
  );
  const urls = output.match(/https?:\/\/[^\s]+/g) || [];
  assert.ok(urls.length >= 2, "process-output URL capture must observe listening and pairing URLs");
  const tokenUrls = urls.filter((url) => url.includes(connection.token));
  const queryLeaks = urls.filter((url) => (
    new URL(url).search.includes(connection.token)
  ));
  assert.equal(queryLeaks.length, 0, "the bearer token must never appear in a URL query string");
  const transportUrlLeaks = urls.filter((url) => (
    url.includes(connection.token) && url !== pairingUrl
  ));
  assert.equal(
    transportUrlLeaks.length,
    0,
    "the bearer token must never appear in a bridge endpoint or transport URL",
  );
  assert.deepEqual(
    tokenUrls,
    [pairingUrl],
    "the required non-transmitted pairing fragment must contain the token exactly once",
  );
  return { pairingUrl, tokenUrlLeaks: transportUrlLeaks.length };
}

async function runJ1({ paths, dataDirectory }) {
  const mcpEnv = isolatedBridgeEnv(REAL_HOME, {
    RABBITHOLE_DIR: dataDirectory,
  });
  const initialize = await initializeInstalledMcp(
    paths.rabbithole,
    mcpEnv,
    "install-journey-j1",
  );
  const preRunRows = await processRows();
  const { env: bridgeEnv, realCodexAuth } = await prepareRealCliEnv(dataDirectory);
  const port = await freePort();
  const run = spawnInstalledBridge(paths.rabbithole, ["--port", String(port)], bridgeEnv);
  let stopped = false;
  try {
    const connection = await waitForBridgeStartup(run);
    assert.equal(connection.url, `http://127.0.0.1:${port}`);
    const pairing = assertPairingOutput(run, connection);
    const tokenPath = path.join(dataDirectory, "bridge-token");
    const codexHome = path.join(dataDirectory, "codex-home");
    const authLink = path.join(codexHome, "auth.json");
    const tokenCapture = await captureFile(tokenPath);
    assert.equal(
      tokenCapture.exists,
      true,
      "bridge must create its token under the throwaway RABBITHOLE_DIR",
    );
    assert.equal(await modeOf(tokenPath), 0o600, "bridge token mode must be 0600");
    assert.equal(await pathExists(codexHome), true, "bridge must create its private CODEX_HOME");
    assert.equal(await modeOf(codexHome), 0o700, "private CODEX_HOME mode must be 0700");
    assert.equal(
      (await fs.lstat(authLink)).isSymbolicLink(),
      true,
      "the bridge must create the private CODEX_HOME auth symlink",
    );
    assert.equal(
      await fs.realpath(authLink),
      await fs.realpath(realCodexAuth),
      "the bridge-created private CODEX_HOME auth symlink must resolve to the real auth.json",
    );

    const ready = await readReadyState(connection);
    const turn = await runOneModelTurn(connection, ready.state);
    const runningRows = await processRows();
    const lifecycle = await assertNoOwnedChildren({
      run,
      preRunRows,
      runningRows,
    });
    stopped = true;
    const byId = agentsById(ready.state);
    return [
      "acceptance J1",
      "install=prod-only",
      `mcp=${initialize.result.serverInfo.name}`,
      `claude=${byId.get("claude").state}`,
      `claude_models=${byId.get("claude").models.length}`,
      `codex=${byId.get("codex").state}`,
      `codex_models=${byId.get("codex").models.length}`,
      `turn_model=${turn.model}`,
      `assistant_chars=${turn.assistantText.length}`,
      `model_turns=${turn.modelTurns}`,
      "token_mode=0600",
      "codex_home=private",
      "pairing_fragment=present",
      `token_url_leaks=${pairing.tokenUrlLeaks}`,
      `owned_children=${lifecycle.ownedAtRuntime.length}`,
      `orphan_count=${lifecycle.survivors.length}`,
    ].join(" ");
  } finally {
    if (!stopped && run.child.exitCode === null && run.child.signalCode === null) {
      await stopProcess(run, "J1 failure cleanup").catch(() => {});
    }
  }
}

async function runJ2({ paths, home }) {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const env = isolatedBridgeEnv(home, { PATH: SCRUBBED_PATH });
  const pathEntries = env.PATH.split(path.delimiter).filter(Boolean);
  assert.ok(pathEntries.length > 0, "scrubbed PATH capture must contain system directories");
  assert.ok(
    await firstExecutable("sh", env),
    "scrubbed PATH executable capture must resolve a known system binary",
  );
  assert.equal(await firstExecutable("claude", env), null, "scrubbed PATH must not resolve claude");
  assert.equal(await firstExecutable("codex", env), null, "scrubbed PATH must not resolve codex");
  const port = await freePort();
  const run = spawnInstalledBridge(paths.rabbithole, ["--port", String(port)], env);
  let stopped = false;
  try {
    const connection = await waitForBridgeStartup(run);
    const dataDirectory = path.join(home, ".rabbithole");
    const tokenPath = path.join(dataDirectory, "bridge-token");
    const codexHome = path.join(dataDirectory, "codex-home");
    const tokenCapture = await captureFile(tokenPath);
    assert.equal(
      tokenCapture.exists,
      true,
      "default-path bridge must create $HOME/.rabbithole/bridge-token",
    );
    assert.equal(await modeOf(tokenPath), 0o600, "default-path bridge token mode must be 0600");
    assert.equal(await modeOf(dataDirectory), 0o700, "default bridge directory mode must be 0700");
    assert.equal(
      await pathExists(codexHome),
      true,
      "default-path bridge must create its private codex-home beside the token",
    );
    assert.equal(await modeOf(codexHome), 0o700, "default private codex-home mode must be 0700");
    const missing = await readMissingState(connection);
    const exit = await stopProcess(run, "missing-CLI bridge SIGTERM");
    stopped = true;
    assert.deepEqual(exit, { code: 0, signal: null }, "missing-CLI bridge must exit cleanly");
    const byId = agentsById(missing.state);
    return [
      "acceptance J2",
      `claude=${byId.get("claude").state}`,
      `claude_fix=${JSON.stringify(byId.get("claude").fix)}`,
      `codex=${byId.get("codex").state}`,
      `codex_fix=${JSON.stringify(byId.get("codex").fix)}`,
      `error_frames=${missing.errorFrames}`,
      "sigterm=clean",
    ].join(" ");
  } finally {
    if (!stopped && run.child.exitCode === null && run.child.signalCode === null) {
      await stopProcess(run, "J2 failure cleanup").catch(() => {});
    }
  }
}

function seededHole() {
  return {
    schema_version: 2,
    hole_id: "upgrade-survivor",
    title: "Upgrade survivor",
    root_id: "root",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    view_state: null,
    nodes: [
      {
        id: "root",
        parent_id: null,
        title: "Upgrade survivor",
        markdown: "# Upgrade survivor\n\nThis hole predates the bridge upgrade.",
        base_url: null,
        base_url_source: null,
        origin: null,
        position: { x: 0, y: 0 },
        size: null,
        font_scale: 1,
        collapsed: false,
        status: "answered",
        read: true,
        created_at: "2026-01-01T00:00:00.000Z",
        extensions: {},
      },
      {
        id: "saved-question",
        parent_id: "root",
        title: "Does this survive?",
        markdown: "",
        base_url: null,
        base_url_source: null,
        origin: {
          selected_text: "This hole predates the bridge upgrade.",
          question: "Does this survive?",
          lens: null,
          anchor: null,
          branch_type: "selection",
        },
        position: { x: 40, y: 40 },
        size: null,
        font_scale: 1,
        collapsed: false,
        status: "pending",
        read: false,
        created_at: "2026-01-02T00:00:00.000Z",
        extensions: {},
      },
    ],
  };
}

function toolText(response) {
  const text = response.result?.content?.find((part) => part.type === "text")?.text;
  assert.ok(typeof text === "string" && text.length > 0, "MCP tool capture must contain text");
  return JSON.parse(text);
}

async function assertInstalledHoleSurvives(binary, env) {
  const mcp = new McpProcess(binary, env, "install-journey-j3-holes");
  try {
    await mcp.initialize();
    const listed = toolText(await mcp.request("tools/call", {
      name: "list_rabbitholes",
      arguments: {},
    }));
    assert.ok(Array.isArray(listed.holes), "list_rabbitholes capture must contain a holes array");
    assert.ok(
      listed.holes.length > 0,
      "list_rabbitholes capture must observe the pre-seeded hole before matching it",
    );
    const summary = listed.holes.find((hole) => hole.hole_id === "upgrade-survivor");
    assert.ok(summary, "pre-seeded hole must remain listed after the package upgrade");
    const opened = toolText(await mcp.request("tools/call", {
      name: "open_rabbithole",
      arguments: { hole_id: "upgrade-survivor" },
    }));
    assert.equal(opened.status, "branch_request", "pre-seeded pending hole must open after upgrade");
    assert.equal(opened.node_id, "saved-question");
    assert.equal(opened.saved, true, "pre-upgrade pending ask must be delivered as saved");
    assert.equal(Object.hasOwn(opened, "rehydration"), false, "the removed full-tree payload must stay absent");
    assert.ok(
      Array.isArray(opened.thread) && opened.thread.some((node) => node.id === "root"),
      "opened pre-upgrade hole must carry its undelivered root lineage as thread",
    );
    assert.ok(
      opened.map?.nodes?.some((node) => node.id === "root" && node.title === "Upgrade survivor"),
      "opened pre-upgrade hole must index its root node in map",
    );
    return { listed: listed.holes.length, opened: "upgrade-survivor" };
  } finally {
    await mcp.close();
  }
}

/** @param {{binary: string, env: NodeJS.ProcessEnv, args: string[], expectedToken?: string}} options */
async function runTokenBridge({ binary, env, args, expectedToken }) {
  const run = spawnInstalledBridge(binary, args, env);
  let stopped = false;
  try {
    const connection = await waitForBridgeStartup(run);
    if (expectedToken !== undefined) {
      assert.equal(
        connection.token,
        expectedToken,
        "bridge must report the pre-seeded pairing token exactly",
      );
    }
    const exit = await stopProcess(run, "upgrade token bridge SIGTERM");
    stopped = true;
    assert.deepEqual(exit, { code: 0, signal: null });
    return connection;
  } finally {
    if (!stopped && run.child.exitCode === null && run.child.signalCode === null) {
      await stopProcess(run, "upgrade token bridge failure cleanup").catch(() => {});
    }
  }
}

async function runJ3({
  oldTarball,
  newTarball,
  prefix,
  cache,
  installHome,
  dataDirectory,
}) {
  const tokenPath = path.join(dataDirectory, "bridge-token");
  const originalToken = "17".repeat(32);
  const originalTokenBytes = Buffer.from(`${originalToken}\n`);
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath, originalTokenBytes, { mode: 0o600 });
  await fs.writeFile(
    path.join(dataDirectory, "upgrade-survivor.json"),
    JSON.stringify(seededHole()),
    { mode: 0o600 },
  );

  await installTarball({ tarball: oldTarball, prefix, cache, home: installHome });
  const oldPaths = installedPaths(prefix);
  assert.equal(await pathExists(oldPaths.mcp), true, "old package must expose rabbithole-mcp");
  assert.equal(
    await pathExists(oldPaths.rabbithole),
    false,
    "old MCP-only package must not expose a working rabbithole bridge dispatcher",
  );
  const mcpEnv = isolatedBridgeEnv(REAL_HOME, {
    RABBITHOLE_DIR: dataDirectory,
  });
  const oldRegistered = await initializeInstalledMcp(
    oldPaths.mcp,
    mcpEnv,
    "install-journey-j3-old-registered",
  );

  await installTarball({ tarball: newTarball, prefix, cache, home: installHome });
  const newPaths = installedPaths(prefix);
  assert.equal(await pathExists(newPaths.mcp), true, "new package must retain rabbithole-mcp");
  assert.equal(await pathExists(newPaths.rabbithole), true, "new package must add rabbithole");
  const newRegistered = await initializeInstalledMcp(
    newPaths.mcp,
    mcpEnv,
    "install-journey-j3-new-registered",
  );
  const newBare = await initializeInstalledMcp(
    newPaths.rabbithole,
    mcpEnv,
    "install-journey-j3-new-bare",
  );
  const shapes = [
    oldRegistered,
    newRegistered,
    newBare,
  ].map(initializeShape);
  assert.deepEqual(shapes[1], shapes[0], "registered MCP shape must survive the upgrade");
  assert.deepEqual(shapes[2], shapes[0], "bare no-arg MCP shape must survive the upgrade");

  const bridgeEnv = isolatedBridgeEnv(REAL_HOME, {
    PATH: SCRUBBED_PATH,
    RABBITHOLE_DIR: dataDirectory,
  });
  const reusePort = await freePort();
  await runTokenBridge({
    binary: newPaths.rabbithole,
    env: bridgeEnv,
    args: ["--port", String(reusePort)],
    expectedToken: originalToken,
  });
  const reusedBytes = await fs.readFile(tokenPath);
  assert.ok(
    reusedBytes.equals(originalTokenBytes),
    "bridge must reuse the pre-seeded pairing token byte-for-byte",
  );
  assert.equal(await modeOf(tokenPath), 0o600, "reused bridge token must remain mode 0600");

  const rotatePort = await freePort();
  const rotated = await runTokenBridge({
    binary: newPaths.rabbithole,
    env: bridgeEnv,
    args: ["--port", String(rotatePort), "--new-token"],
  });
  assert.notEqual(rotated.token, originalToken, "--new-token must rotate the pairing token");
  assert.ok(
    (await fs.readFile(tokenPath)).equals(Buffer.from(`${rotated.token}\n`)),
    "rotated token output and persisted bytes must match",
  );
  assert.equal(await modeOf(tokenPath), 0o600, "rotated bridge token must be mode 0600");

  const holes = await assertInstalledHoleSurvives(newPaths.mcp, mcpEnv);
  return [
    "acceptance J3",
    "old_mcp=ready",
    "old_bridge=absent",
    "new_mcp=ready",
    "new_bridge=ready",
    "initialize_shape=identical",
    "token=reused",
    "token_rotated=true",
    "token_mode=0600",
    `holes_listed=${holes.listed}`,
    `hole_opened=${holes.opened}`,
  ].join(" ");
}

async function fetchModels(connection) {
  const response = await fetch(`${connection.url}/v1/models`, {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  assert.equal(response.status, 200, "running bridge must serve authenticated models");
  const body = await response.json();
  assert.equal(body.object, "list", "models capture must observe the incumbent bridge");
  assert.ok(Array.isArray(body.data), "models capture must contain a data array");
  return body;
}

async function runJ4({ paths, dataDirectory }) {
  const env = isolatedBridgeEnv(REAL_HOME, {
    PATH: SCRUBBED_PATH,
    RABBITHOLE_DIR: dataDirectory,
  });
  const port = await freePort();
  const incumbent = spawnInstalledBridge(
    paths.rabbithole,
    ["--port", String(port)],
    env,
  );
  let incumbentStopped = false;
  let challenger;
  try {
    const connection = await waitForBridgeStartup(incumbent);
    await fetchModels(connection);
    challenger = spawnInstalledBridge(
      paths.rabbithole,
      ["--port", String(port)],
      env,
    );
    const challengerExit = await withTimeout(
      challenger.exit,
      PROCESS_TIMEOUT_MS,
      "second bridge on occupied port",
    );
    assert.ok(
      Number.isInteger(challengerExit.code) && challengerExit.code !== 0,
      `second bridge on occupied port must exit non-zero, not code=${
        challengerExit.code
      } signal=${challengerExit.signal}`,
    );
    const lines = challenger.output().split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length > 0, "port-collision output capture must contain an error line");
    assert.equal(
      /(?:(?:^|\n)\s+at |\bError:|node:internal)/.test(challenger.output()),
      false,
      "port collision must not print a stack trace",
    );
    assert.deepEqual(
      lines,
      [`rabbithole bridge: Port ${port} is already in use.`],
      "port collision must print one clear human-readable line",
    );
    await fetchModels(connection);
    const incumbentExit = await stopProcess(incumbent, "J4 incumbent SIGTERM");
    incumbentStopped = true;
    assert.deepEqual(incumbentExit, { code: 0, signal: null });
    return [
      "acceptance J4",
      `port=${port}`,
      `second_exit=${challengerExit.code}`,
      `error=${JSON.stringify(lines[0])}`,
      "stack_trace=false",
      "incumbent=serving",
      "sigterm=clean",
    ].join(" ");
  } finally {
    if (
      challenger
      && challenger.child.exitCode === null
      && challenger.child.signalCode === null
    ) {
      await stopProcess(challenger, "J4 challenger failure cleanup").catch(() => {});
    }
    if (
      !incumbentStopped
      && incumbent.child.exitCode === null
      && incumbent.child.signalCode === null
    ) {
      await stopProcess(incumbent, "J4 incumbent failure cleanup").catch(() => {});
    }
  }
}

async function cleanupChildren() {
  const running = [...liveChildren].filter((child) => (
    child.exitCode === null && child.signalCode === null
  ));
  for (const child of running) child.kill("SIGTERM");
  await Promise.allSettled(running.map((child) => (
    withTimeout(waitForExit(child), 3_000, "global child cleanup").catch(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    })
  )));
}
const realBridgeTokenBefore = await captureFile(REAL_BRIDGE_TOKEN_PATH);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-install-live-"));
try {
  const newTarball = await packProject(ROOT, path.join(temporaryRoot, "new-pack"));
  const oldTarball = await packHead(temporaryRoot);
  const cache = path.join(temporaryRoot, "npm-cache");
  const newPrefix = path.join(temporaryRoot, "new-prefix");
  const j1Home = path.join(temporaryRoot, "j1-home");
  await installTarball({
    tarball: newTarball,
    prefix: newPrefix,
    cache,
    home: j1Home,
  });
  const newPaths = installedPaths(newPrefix);
  await assertProductionInstall(newPaths);

  process.stdout.write(`${await runJ1({
    paths: newPaths,
    dataDirectory: path.join(temporaryRoot, "j1-rabbithole"),
  })}\n`);
  process.stdout.write(`${await runJ2({
    paths: newPaths,
    home: path.join(temporaryRoot, "j2-home"),
  })}\n`);
  process.stdout.write(`${await runJ3({
    oldTarball,
    newTarball,
    prefix: path.join(temporaryRoot, "upgrade-prefix"),
    cache,
    installHome: path.join(temporaryRoot, "j3-install-home"),
    dataDirectory: path.join(temporaryRoot, "j3-rabbithole"),
  })}\n`);
  process.stdout.write(`${await runJ4({
    paths: newPaths,
    dataDirectory: path.join(temporaryRoot, "j4-rabbithole"),
  })}\n`);
  assert.equal(realModelTurns, 1, "install journey must make exactly one real model turn");
} finally {
  try {
    await cleanupChildren();
  } finally {
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    } finally {
      assertFileCaptureUnchanged(
        realBridgeTokenBefore,
        await captureFile(REAL_BRIDGE_TOKEN_PATH),
        "real HOME bridge token mtime and bytes must remain untouched after acceptance journeys",
      );
    }
  }
}
