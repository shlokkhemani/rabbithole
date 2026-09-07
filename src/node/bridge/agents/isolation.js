import { spawn } from "node:child_process";

import { BridgeError } from "../errors.js";
import { errorCode } from "../../shared/errno.js";
import { warn } from "../../shared/logger.js";
import { terminateChild } from "../../shared/process.js";

export { resolveExecutable, terminateChild, parseJsonOutput } from "../../shared/process.js";

const CAPTURE_LIMIT = 1024 * 1024;

/**
 * @param {string | null} executable
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} [options]
 */
export function runCaptured(executable, args, {
  cwd,
  env = process.env,
  timeoutMs = 15_000,
} = {}) {
  if (!executable) {
    return Promise.reject(new BridgeError("The requested agent CLI is not installed", "agent_missing", 503));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChild(child);
      reject(new BridgeError(`Agent command timed out after ${timeoutMs}ms`, "turn_failed", 500));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < CAPTURE_LIMIT) stdout += chunk.slice(0, CAPTURE_LIMIT - stdout.length);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = errorCode(error) === "ENOENT" ? "agent_missing" : "turn_failed";
      warn(`Agent command failed to start: ${error.message}`);
      reject(new BridgeError(
        "Could not start the agent command. Check the installation and try again.",
        code,
        code === "agent_missing" ? 503 : 500
      ));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.stdin.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      warn(`Agent command stdin failed: ${error.message}`);
      terminateChild(child);
      reject(new BridgeError(
        "Could not send input to the agent command. Try again.",
        "turn_failed",
        500
      ));
    });

    child.stdin.end();
  });
}
