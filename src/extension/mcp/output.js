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
  validateBounds(maxBytes, maxLines);
  const json = boundedJsonStringify(value ?? null, { maxBytes, maxLines });
  return finishBoundedText(json.text, {
    maxBytes,
    maxLines,
    initialReasons: json.reasons,
    originalBytes: json.bytes,
    originalLines: json.lines,
  });
}

/**
 * @param {string} text
 * @param {{ maxBytes?: number, maxLines?: number }} [options]
 */
export function boundModelText(text, options = {}) {
  const maxBytes = options.maxBytes ?? MCP_RESULT_MAX_BYTES;
  const maxLines = options.maxLines ?? MCP_RESULT_MAX_LINES;
  validateBounds(maxBytes, maxLines);

  const normalized = String(text).replace(/\r\n?/g, "\n");
  return finishBoundedText(normalized, {
    maxBytes,
    maxLines,
    initialReasons: [],
    originalBytes: Buffer.byteLength(normalized, "utf8"),
    originalLines: normalized === "" ? 0 : normalized.split("\n").length,
  });
}

/**
 * @param {string} normalized
 * @param {{ maxBytes: number, maxLines: number, initialReasons: string[], originalBytes: number, originalLines: number }} options
 */
function finishBoundedText(normalized, options) {
  const { maxBytes, maxLines, originalBytes, originalLines } = options;
  /** @type {string[]} */
  let reasons = [];
  for (const reason of options.initialReasons) addReason(reasons, reason);
  let output = normalized;

  if (originalLines > maxLines) {
    addReason(reasons, `line limit ${maxLines}`);
    output = normalized.split("\n").slice(0, maxLines - 1).join("\n");
  }

  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    addReason(reasons, `byte limit ${maxBytes}`);
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

/** @param {number} maxBytes @param {number} maxLines */
function validateBounds(maxBytes, maxLines) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new TypeError("maxBytes must be at least 128");
  if (!Number.isSafeInteger(maxLines) || maxLines < 2) throw new TypeError("maxLines must be at least 2");
}

/** @param {string[]} reasons @param {string} reason */
function addReason(reasons, reason) {
  if (reasons.includes(reason)) return;
  reasons.push(reason);
}

/**
 * @param {unknown} value
 * @param {{ maxBytes: number, maxLines: number }} options
 */
function boundedJsonStringify(value, options) {
  const writer = createBoundedWriter(options.maxBytes, options.maxLines);
  writeJsonValue(writer, value, new WeakSet(), false);
  return {
    text: writer.text(),
    bytes: writer.bytes,
    lines: writer.lines,
    reasons: writer.reasons,
  };
}

/**
 * @param {number} maxBytes
 * @param {number} maxLines
 */
function createBoundedWriter(maxBytes, maxLines) {
  /** @type {string[]} */
  const parts = [];
  /** @type {string[]} */
  const reasons = [];
  let bytes = 0;
  let lines = 0;
  let stopped = false;
  return {
    get bytes() {
      return bytes;
    },
    get lines() {
      return lines;
    },
    get reasons() {
      return reasons;
    },
    get stopped() {
      return stopped;
    },
    /** @param {string} chunk */
    append(chunk) {
      if (stopped || chunk === "") return !stopped;
      const linePrefix = prefixForLineLimit(chunk, lines, maxLines);
      let output = linePrefix.text;
      if (linePrefix.truncated) {
        addReason(reasons, `line limit ${maxLines}`);
        stopped = true;
      }

      const bytePrefix = prefixForByteLimit(output, maxBytes - bytes);
      output = bytePrefix.text;
      if (bytePrefix.truncated) {
        addReason(reasons, `byte limit ${maxBytes}`);
        stopped = true;
      }

      if (output !== "") {
        parts.push(output);
        bytes += Buffer.byteLength(output, "utf8");
        lines = countLinesAfterAppend(lines, output);
      }
      return !stopped;
    },
    text() {
      return parts.join("");
    },
  };
}

/**
 * @param {ReturnType<typeof createBoundedWriter>} writer
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @param {boolean} arrayElement
 */
function writeJsonValue(writer, value, seen, arrayElement) {
  if (writer.stopped) return;
  if (value === null || value === undefined || typeof value === "function" || typeof value === "symbol") {
    writer.append(arrayElement || value === null || value === undefined ? "null" : "\"[Unsupported value]\"");
    return;
  }
  if (typeof value === "string") {
    writeJsonString(writer, value);
    return;
  }
  if (typeof value === "number") {
    writer.append(Number.isFinite(value) ? String(value) : "null");
    return;
  }
  if (typeof value === "boolean") {
    writer.append(value ? "true" : "false");
    return;
  }
  if (typeof value === "bigint") {
    writeJsonString(writer, String(value));
    return;
  }
  if (typeof value !== "object") {
    writer.append("null");
    return;
  }
  if (seen.has(value)) {
    writeJsonString(writer, "[Circular]");
    return;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) writeJsonArray(writer, value, seen);
    else writeJsonObject(writer, /** @type {Record<string, unknown>} */ (value), seen);
  } finally {
    seen.delete(value);
  }
}

/**
 * @param {ReturnType<typeof createBoundedWriter>} writer
 * @param {unknown[]} value
 * @param {WeakSet<object>} seen
 */
function writeJsonArray(writer, value, seen) {
  if (!writer.append("[")) return;
  for (let index = 0; index < value.length; index += 1) {
    if (!writer.append(`${index === 0 ? "\n" : ",\n"}  `)) return;
    writeJsonValue(writer, value[index], seen, true);
    if (writer.stopped) return;
  }
  if (value.length > 0 && !writer.append("\n")) return;
  writer.append("]");
}

/**
 * @param {ReturnType<typeof createBoundedWriter>} writer
 * @param {Record<string, unknown>} value
 * @param {WeakSet<object>} seen
 */
function writeJsonObject(writer, value, seen) {
  if (!writer.append("{")) return;
  let wrote = false;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    let child;
    try {
      child = value[key];
    } catch (error) {
      child = `[${error instanceof Error && error.name ? error.name : "Error"} while reading property]`;
    }
    if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
    if (!writer.append(`${wrote ? ",\n" : "\n"}  `)) return;
    writeJsonString(writer, key);
    if (writer.stopped || !writer.append(": ")) return;
    writeJsonValue(writer, child, seen, false);
    if (writer.stopped) return;
    wrote = true;
  }
  if (wrote && !writer.append("\n")) return;
  writer.append("}");
}

/**
 * @param {ReturnType<typeof createBoundedWriter>} writer
 * @param {string} value
 */
function writeJsonString(writer, value) {
  if (!writer.append("\"")) return;
  for (const character of value) {
    if (writer.stopped) return;
    writer.append(escapeJsonStringCharacter(character));
  }
  writer.append("\"");
}

/** @param {string} character */
function escapeJsonStringCharacter(character) {
  if (character === "\"") return "\\\"";
  if (character === "\\") return "\\\\";
  if (character === "\b") return "\\b";
  if (character === "\f") return "\\f";
  if (character === "\n") return "\\n";
  if (character === "\r") return "\\r";
  if (character === "\t") return "\\t";
  const code = character.charCodeAt(0);
  if (code < 0x20) return `\\u${code.toString(16).padStart(4, "0")}`;
  return character;
}

/** @param {number} currentLines @param {string} chunk */
function countLinesAfterAppend(currentLines, chunk) {
  let lineCount = currentLines === 0 ? 1 : currentLines;
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] === "\n") lineCount += 1;
  }
  return lineCount;
}

/** @param {string} text @param {number} currentLines @param {number} maxLines */
function prefixForLineLimit(text, currentLines, maxLines) {
  let lineCount = currentLines === 0 && text !== "" ? 1 : currentLines;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    lineCount += 1;
    if (lineCount > maxLines) return { text: text.slice(0, index), truncated: true };
  }
  return { text, truncated: false };
}

/** @param {string} text @param {number} availableBytes */
function prefixForByteLimit(text, availableBytes) {
  if (availableBytes <= 0) return { text: "", truncated: true };
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > availableBytes) return { text: text.slice(0, end), truncated: true };
    bytes += characterBytes;
    end += character.length;
  }
  return { text, truncated: false };
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
