import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { warn } from "./logger.js";

/**
 * Opens a URL in the default browser. `open` on macOS, `start` on Windows,
 * `xdg-open` elsewhere.
 */
export function openBrowser(url) {
  if (process.env.RABBITHOLE_NO_BROWSER) {
    warn(`RABBITHOLE_NO_BROWSER set — not opening: ${url}`);
    return;
  }

  let cmd;
  let args;

  switch (process.platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      cmd = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
      break;
  }

  execFile(cmd, args, (err) => {
    if (err) {
      warn(`Failed to open browser: ${err.message}`);
      warn(`Please open manually: ${url}`);
    }
  });
}

export function resolveExecutable(name, override, env = process.env) {
  const requested = override || name;
  const candidates = requested.includes(path.sep)
    ? [path.resolve(requested)]
    : String(env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, requested));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

export function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1000);
  timer.unref?.();
}

export function parseJsonOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const line of trimmed.split(/\r?\n/).reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Some CLIs include a harmless non-JSON line before their JSON result.
      }
    }
  }
  return null;
}
