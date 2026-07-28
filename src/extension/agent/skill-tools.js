import fs from "node:fs/promises";
import path from "node:path";
import { assertContained } from "./code-tools.js";

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_READ_LINES = 2000;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/** @typedef {any} PiToolDefinition */

export class SkillResourceReadService {
  /**
   * @param {{
   *   roots: string[],
   *   maxReadBytes?: number,
   *   maxReadLines?: number
   * }} options
   */
  constructor(options) {
    this.roots = [...new Set(options.roots)].filter(Boolean);
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxReadLines = options.maxReadLines ?? DEFAULT_MAX_READ_LINES;
    /** @type {Promise<string[]> | null} */
    this.realRootsPromise = null;
  }

  /**
   * @param {{ path?: unknown, offset?: unknown, limit?: unknown }} input
   */
  async read(input) {
    const absolutePath = await this.#resolveSkillPath(input.path);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) throw new TypeError("Skill resource path is not a regular file");
    if (stat.size > this.maxReadBytes) throw new TypeError(`Skill resource exceeds Nora read limit of ${this.maxReadBytes} bytes`);
    const buffer = await fs.readFile(absolutePath);
    if (buffer.includes(0)) throw new TypeError("Binary skill resources cannot be read as text");
    const selection = selectLines(TEXT_DECODER.decode(buffer), input.offset, input.limit, this.maxReadLines);
    return {
      path: absolutePath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      totalLines: selection.totalLines,
      text: selection.text,
      truncated: selection.truncated,
    };
  }

  /** @param {unknown} rawPath */
  async #resolveSkillPath(rawPath) {
    if (typeof rawPath !== "string" || !rawPath) throw new TypeError("read.path is required");
    if (!path.isAbsolute(rawPath)) throw new TypeError("Skill read requires an absolute realpath");
    const target = await fs.realpath(rawPath);
    const roots = await this.#realRoots();
    if (!roots.some((root) => contains(root, target))) {
      throw new TypeError("Skill resource path is outside Nora skill directories");
    }
    return target;
  }

  async #realRoots() {
    if (!this.realRootsPromise) {
      this.realRootsPromise = Promise.all(this.roots.map((root) => fs.realpath(root).catch(() => null)))
        .then((roots) => roots.filter((root) => typeof root === "string"));
    }
    return this.realRootsPromise;
  }
}

/**
 * @param {{ roots: string[], maxReadBytes?: number, maxReadLines?: number }} options
 * @returns {PiToolDefinition}
 */
export function createSkillReadTool(options) {
  const service = new SkillResourceReadService(options);
  return {
    name: "read",
    label: "read",
    description: "Read a Nora skill resource by absolute realpath. The path must stay inside the loaded workspace or global skill directories.",
    promptSnippet: "Read skill resource files",
    promptGuidelines: [
      "Use read only for SKILL.md files and files referenced by those skills.",
      "When a skill references a relative path, resolve it against that skill's base directory and pass the absolute realpath.",
    ],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute realpath to a skill resource." },
        offset: { type: "number", description: "Optional 1-indexed start line.", optional: true },
        limit: { type: "number", description: "Optional maximum line count.", optional: true },
      },
      required: ["path"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    /**
     * @param {string} _toolCallId
     * @param {unknown} params
     */
    async execute(_toolCallId, params) {
      const details = await service.read(/** @type {{ path?: unknown, offset?: unknown, limit?: unknown }} */ (params));
      return {
        content: [{ type: "text", text: details.text }],
        details,
      };
    },
  };
}

/** @param {string} root @param {string} target */
function contains(root, target) {
  try {
    assertContained(root, target, "");
    return true;
  } catch {
    return false;
  }
}

/** @param {string} text @param {unknown} rawOffset @param {unknown} rawLimit @param {number} maxLines */
function selectLines(text, rawOffset, rawLimit, maxLines) {
  const lines = text.split(/\r?\n/);
  const offset = rawOffset == null ? 1 : positiveInteger(rawOffset, "offset");
  const limit = rawLimit == null ? maxLines : Math.min(positiveInteger(rawLimit, "limit"), maxLines);
  if (offset > lines.length) throw new TypeError(`Offset ${offset} is beyond end of file`);
  const start = offset - 1;
  const selected = lines.slice(start, start + limit);
  const endLine = start + selected.length;
  return {
    startLine: offset,
    endLine,
    totalLines: lines.length,
    text: selected.join("\n"),
    truncated: endLine < lines.length,
  };
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${label} must be a positive integer`);
  return Number(value);
}
