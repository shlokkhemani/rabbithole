import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const SECRET_QUERY_RE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential|authorization|auth|key)$/i;

export class GitCommandError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   code?: number | null,
   *   signal?: NodeJS.Signals | null,
   *   stdout?: string,
   *   stderr?: string,
   *   args?: string[],
   *   cwd?: string | null,
   *   cause?: unknown
   * }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "GitCommandError";
    this.code = details.code ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.args = details.args ?? [];
    this.cwd = details.cwd ?? null;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

/**
 * Run system Git without a shell and with bounded captured output.
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   maxStdoutBytes?: number,
 *   maxStderrBytes?: number,
 *   gitPath?: string
 * }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runGit(args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("Git arguments must be strings");
  }
  const gitPath = options.gitPath ?? "git";
  const command = diagnosticCommand(gitPath, args);
  if (options.signal?.aborted) return Promise.reject(abortError(command));

  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createBoundedCollector(options.maxStdoutBytes ?? DEFAULT_OUTPUT_LIMIT);
    const stderr = createBoundedCollector(options.maxStderrBytes ?? DEFAULT_OUTPUT_LIMIT);
    let settled = false;

    const abort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      reject(new GitCommandError(`Unable to start Git command: ${command}`, {
        args: sanitizeArgs(args),
        cwd: options.cwd ?? null,
        cause: error,
      }));
    });
    child.on("close", (code, signal) => {
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) {
        reject(abortError(command));
        return;
      }
      const out = stdout.text();
      const err = stderr.text();
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      reject(new GitCommandError(`Git command failed (${code ?? signal}): ${command}`, {
        code,
        signal,
        stdout: sanitizeGitDiagnostic(out),
        stderr: sanitizeGitDiagnostic(err),
        args: sanitizeArgs(args),
        cwd: options.cwd ?? null,
      }));
    });
  });
}

/**
 * @param {string} gitPath
 * @param {string[]} args
 */
function diagnosticCommand(gitPath, args) {
  return [gitPath, ...sanitizeArgs(args)].map((arg) => JSON.stringify(arg)).join(" ");
}

/** @param {string[]} args */
function sanitizeArgs(args) {
  return args.map((arg) => sanitizeGitDiagnostic(arg));
}

/** @param {string} value */
export function sanitizeGitDiagnostic(value) {
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]*)@/gi, "$1<redacted>@")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)@/gi, "$1")
    .replace(/([?&])([^=\s&#]+)=([^&#\s]*)/gi, (match, separator, key) => (
      SECRET_QUERY_RE.test(key) ? `${separator}${key}=<redacted>` : match
    ));
}

/** @param {string} command */
function abortError(command) {
  const error = new GitCommandError(`Git command aborted: ${command}`);
  error.name = "AbortError";
  return error;
}

/** @param {number} limit */
function createBoundedCollector(limit) {
  /** @type {Buffer[]} */
  const chunks = [];
  let length = 0;
  let truncated = false;
  return {
    /** @param {Buffer | string} chunk */
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const available = Math.max(0, limit - length);
      if (available > 0) {
        chunks.push(buffer.subarray(0, available));
        length += Math.min(buffer.length, available);
      }
      if (buffer.length > available) truncated = true;
    },
    text() {
      const text = Buffer.concat(chunks).toString("utf8");
      return truncated ? `${text}\n[git output truncated]` : text;
    },
  };
}
