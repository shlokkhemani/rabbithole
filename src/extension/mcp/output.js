export const MCP_RESULT_MAX_BYTES = 256 * 1024;
export const MCP_RESULT_MAX_LINES = 2000;

const TRUNCATION_PREFIX = "[Nora MCP result truncated:";

/**
 * @param {unknown} value
 * @param {{ maxBytes?: number, maxLines?: number }} [options]
 */
export function boundMcpModelResult(value, options = {}) {
  const maxBytes = options.maxBytes ?? MCP_RESULT_MAX_BYTES;
  const maxLines = options.maxLines ?? MCP_RESULT_MAX_LINES;
  const json = JSON.stringify(value ?? null, null, 2);
  return boundModelText(json, { maxBytes, maxLines });
}

/**
 * @param {string} text
 * @param {{ maxBytes?: number, maxLines?: number }} [options]
 */
export function boundModelText(text, options = {}) {
  const maxBytes = options.maxBytes ?? MCP_RESULT_MAX_BYTES;
  const maxLines = options.maxLines ?? MCP_RESULT_MAX_LINES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("maxBytes must be at least 128");
  if (!Number.isSafeInteger(maxLines) || maxLines < 2) throw new TypeError("maxLines must be at least 2");

  const normalized = String(text).replace(/\r\n?/g, "\n");
  let reasons = [];
  let output = normalized;
  const originalLines = normalized === "" ? 0 : normalized.split("\n").length;
  const originalBytes = Buffer.byteLength(normalized, "utf8");

  if (originalLines > maxLines) {
    reasons.push(`line limit ${maxLines}`);
    output = normalized.split("\n").slice(0, maxLines - 1).join("\n");
  }

  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    if (!reasons.some((reason) => reason.startsWith("byte limit"))) reasons.push(`byte limit ${maxBytes}`);
  }

  if (reasons.length) {
    const lines = output.split("\n");
    if (lines.length >= maxLines) output = lines.slice(0, maxLines - 1).join("\n");
    const truncationNote = `\n${TRUNCATION_PREFIX} ${reasons.join(", ")}]`;
    const allowed = Math.max(0, maxBytes - Buffer.byteLength(truncationNote, "utf8"));
    output = Buffer.from(output, "utf8").subarray(0, allowed).toString("utf8").replace(/\uFFFD$/u, "");
    output += truncationNote;
  }

  const lineCount = output === "" ? 0 : output.split("\n").length;
  return {
    text: output,
    truncated: reasons.length > 0,
    originalBytes,
    originalLines,
    bytes: Buffer.byteLength(output, "utf8"),
    lines: lineCount,
    limits: { bytes: maxBytes, lines: maxLines },
    reasons,
  };
}

/**
 * @param {unknown} outputChannel
 * @param {{ serverName: string, operation: string, status: "ok" | "error", durationMs: number, error?: unknown }} entry
 */
export function logMcpOperation(outputChannel, entry) {
  if (!outputChannel || typeof /** @type {{ appendLine?: unknown }} */ (outputChannel).appendLine !== "function") return;
  const line = [
    "mcp",
    `server=${sanitizeLogToken(entry.serverName)}`,
    `operation=${sanitizeLogToken(entry.operation)}`,
    `status=${entry.status}`,
    `durationMs=${Math.max(0, Math.round(entry.durationMs))}`,
    ...(entry.status === "error" ? [`error=${boundedErrorClass(entry.error)}`] : []),
  ].join(" ");
  /** @type {{ appendLine(line: string): void }} */ (outputChannel).appendLine(line);
}

/** @param {unknown} error */
export function boundedErrorClass(error) {
  if (error instanceof Error && error.name) return sanitizeLogToken(error.name);
  if (error && typeof error === "object" && typeof /** @type {{ code?: unknown }} */ (error).code === "string") {
    return sanitizeLogToken(String(/** @type {{ code: string }} */ (error).code));
  }
  return "Error";
}

/** @param {string} token */
function sanitizeLogToken(token) {
  const cleaned = String(token).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
  return cleaned || "unknown";
}
