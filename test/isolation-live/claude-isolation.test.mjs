/** @protects claude isolation capability contracts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HARDENING_ARGS,
  parseClaudeEvent,
} from "../../src/node/bridge/agents/claude.js";
import { buildClaudeInput } from "../../src/node/bridge/messages.js";
import {
  resolveExecutable,
  terminateChild,
} from "../../src/node/bridge/agents/isolation.js";

const temporaryCwd = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-claude-isolation-"));
await fs.chmod(temporaryCwd, 0o700);

const env = { ...process.env };
delete env.CLAUDE_CONFIG_DIR;
const executable = resolveExecutable("claude", undefined, env);
assert.ok(executable, "acceptance B requires an installed claude binary");

const { input } = buildClaudeInput([
  { role: "user", content: "Reply with exactly: OK" },
]);
const args = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model",
  "sonnet",
  "--effort",
  "low",
  "--system-prompt",
  "",
  ...HARDENING_ARGS,
];

let child;
try {
  const observed = await new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    let init;
    let settled = false;
    child = spawn(executable, args, {
      cwd: temporaryCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChild(child);
      reject(new Error("Claude did not emit a stream-json init event within 30 seconds"));
    }, 30_000);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const processLine = (line) => {
      if (!line.trim() || init) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = parseClaudeEvent(event);
      if (parsed?.type !== "init") return;
      init = {
        tools: event.tools,
        mcp_servers: event.mcp_servers,
      };
      try {
        assert.deepEqual(init.tools, []);
        assert.deepEqual(init.mcp_servers, []);
      } catch (error) {
        finish(error);
        terminateChild(child);
        return;
      }
      terminateChild(child);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (buffer) processLine(buffer);
      if (!init) {
        finish(new Error(
          `Claude exited before its init event (code=${code}, signal=${signal}): ${stderr.trim()}`
        ));
        return;
      }
      finish(null, init);
    });
    child.stdin.once("error", (error) => {
      if (!init) finish(error);
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
  process.stdout.write(
    `acceptance B tools=${JSON.stringify(observed.tools)} `
    + `mcp_servers=${JSON.stringify(observed.mcp_servers)}\n`
  );
} finally {
  terminateChild(child);
  await fs.rm(temporaryCwd, { recursive: true, force: true });
}

process.stdout.write("claude isolation ok\n");
