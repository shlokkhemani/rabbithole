import fs from "node:fs/promises";
import path from "node:path";
import { codeEvidenceRecord, normalizeRepositoryRelativePath } from "../git/evidence.js";
import { GitCommandError, runGit } from "../git/process.js";

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_READ_LINES = 2000;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const DEFAULT_MAX_FIND_RESULTS = 200;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * @typedef {import("../git/cache.js").AcquiredRepository} AcquiredRepository
 * @typedef {any} PiToolDefinition
 * @typedef {{ content: Array<{ type: "text", text: string }>, details?: unknown }} TextToolResult
 */

export class RepositoryToolService {
  /**
   * @param {{
   *   document?: import("../nora-document.js").NoraDocument | null,
   *   repositories?: AcquiredRepository[],
   *   git?: typeof runGit,
   *   maxReadBytes?: number,
   *   maxReadLines?: number,
   *   maxSearchResults?: number,
   *   maxFindResults?: number,
   *   now?: () => string
   * }} [options]
   */
  constructor(options = {}) {
    this.document = options.document ?? null;
    this.repositories = new Map();
    for (const repository of options.repositories ?? []) {
      this.repositories.set(repository.id, repository);
    }
    this.git = options.git ?? runGit;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxReadLines = options.maxReadLines ?? DEFAULT_MAX_READ_LINES;
    this.maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
    this.maxFindResults = options.maxFindResults ?? DEFAULT_MAX_FIND_RESULTS;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  listRepositories() {
    return this.#currentRepositories().map((repository) => ({
      id: repository.id,
      title: repository.title,
      repo: repository.repo,
      sha: repository.sha,
      sanitizedRemote: repository.sanitizedRemote,
      forgeType: repository.forgeType,
      forgeBaseUrl: repository.forgeBaseUrl,
    }));
  }

  /**
   * @param {{ repositoryId?: unknown, path?: unknown }} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async listDirectory(input, options = {}) {
    const repository = this.#repositoryById(input.repositoryId);
    const resolved = await this.#resolvePath(repository, input.path, { allowRoot: true });
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isDirectory()) throw new TypeError("Repository path is not a directory");
    const entries = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
    const listed = entries
      .filter((entry) => entry.name !== ".git")
      .map((entry) => ({
        name: entry.name,
        path: resolved.relativePath === "." ? entry.name : `${resolved.relativePath}/${entry.name}`,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
      }))
      .sort((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`));
    return {
      repositoryId: repository.id,
      path: resolved.relativePath,
      entries: listed,
      truncated: false,
      signalAborted: !!options.signal?.aborted,
    };
  }

  /**
   * @param {{ repositoryId?: unknown, path?: unknown, query?: unknown }} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async findFiles(input, options = {}) {
    const repository = this.#repositoryById(input.repositoryId);
    const directory = this.#normalizeToolPath(input.path, { allowRoot: true });
    const query = String(input.query ?? "").trim().toLowerCase();
    const pathspec = directory === "." ? "." : directory;
    const result = await this.git(["-C", repository.worktreePath, "ls-files", "-z", "--", pathspec], {
      signal: options.signal,
      maxStdoutBytes: this.maxReadBytes,
      maxStderrBytes: 64 * 1024,
    });
    const stripped = stripGitTruncationMarker(result.stdout);
    const completeOutput = stripped.truncated && !stripped.stdout.endsWith("\0")
      ? stripped.stdout.slice(0, stripped.stdout.lastIndexOf("\0") + 1)
      : stripped.stdout;
    const all = completeOutput.split("\0").filter(Boolean);
    const allMatches = all
      .filter((entry) => !query || entry.toLowerCase().includes(query));
    const matches = allMatches.slice(0, this.maxFindResults);
    return {
      repositoryId: repository.id,
      path: directory,
      query,
      files: matches,
      truncated: stripped.truncated || allMatches.length > matches.length,
    };
  }

  /**
   * @param {{ repositoryId?: unknown, path?: unknown, query?: unknown }} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async searchText(input, options = {}) {
    const repository = this.#repositoryById(input.repositoryId);
    const directory = this.#normalizeToolPath(input.path, { allowRoot: true });
    const query = String(input.query ?? "");
    if (!query) throw new TypeError("Search query must be non-empty");
    const pathspec = directory === "." ? "." : directory;
    let stdout = "";
    try {
      const result = await this.git([
        "-C",
        repository.worktreePath,
        "grep",
        "-n",
        "-z",
        "-I",
        "-F",
        "-e",
        query,
        "--",
        pathspec,
      ], {
        signal: options.signal,
        maxStdoutBytes: this.maxReadBytes,
        maxStderrBytes: 64 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 1) stdout = "";
      else throw error;
    }
    const stripped = stripGitTruncationMarker(stdout);
    const parsedMatches = parseGitGrepOutput(stripped.stdout);
    const matches = parsedMatches.slice(0, this.maxSearchResults);
    return {
      repositoryId: repository.id,
      path: directory,
      query,
      matches,
      truncated: stripped.truncated || parsedMatches.length > matches.length,
    };
  }

  /**
   * @param {{ repositoryId?: unknown, path?: unknown, offset?: unknown, limit?: unknown }} input
   */
  async readFile(input) {
    const repository = this.#repositoryById(input.repositoryId);
    const resolved = await this.#resolvePath(repository, input.path);
    const stat = await fs.stat(resolved.absolutePath);
    assertRegularReadableFile(stat, this.maxReadBytes);
    const buffer = await fs.readFile(resolved.absolutePath);
    assertTextBuffer(buffer);
    const text = TEXT_DECODER.decode(buffer);
    const selection = selectLines(text, input.offset, input.limit, this.maxReadLines);
    return {
      repositoryId: repository.id,
      path: resolved.relativePath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      totalLines: selection.totalLines,
      text: selection.text,
      truncated: selection.truncated,
    };
  }

  /**
   * @param {{ repositoryId?: unknown, path?: unknown, startLine?: unknown, start_line?: unknown, endLine?: unknown, end_line?: unknown, title?: unknown }} input
   */
  async captureEvidence(input) {
    const repository = this.#repositoryById(input.repositoryId);
    const resolved = await this.#resolvePath(repository, input.path);
    const stat = await fs.stat(resolved.absolutePath);
    assertRegularReadableFile(stat, this.maxReadBytes);
    const buffer = await fs.readFile(resolved.absolutePath);
    assertTextBuffer(buffer);
    const startLine = positiveInteger(input.startLine ?? input.start_line, "startLine");
    const endLine = positiveInteger(input.endLine ?? input.end_line ?? startLine, "endLine");
    if (endLine < startLine) throw new TypeError("endLine must be greater than or equal to startLine");
    const lines = TEXT_DECODER.decode(buffer).split(/\r?\n/);
    const excerpt = lines.slice(startLine - 1, endLine).join("\n");
    if (!excerpt) throw new TypeError("Evidence range is outside the file");
    const evidence = codeEvidenceRecord(repository, {
      relativePath: resolved.relativePath,
      startLine,
      endLine,
      excerpt,
      title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined,
      capturedAt: this.now(),
    });
    return { repositoryId: repository.id, evidence };
  }

  /** @returns {AcquiredRepository[]} */
  #currentRepositories() {
    const fromDocument = typeof this.document?.listAcquiredRepositories === "function"
      ? this.document.listAcquiredRepositories()
      : [];
    const byKey = new Map(this.repositories);
    for (const repository of fromDocument) byKey.set(repository.id, repository);
    return [...byKey.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** @param {unknown} rawId */
  #repositoryById(rawId) {
    const id = String(rawId ?? "");
    if (!id) throw new TypeError("repositoryId is required");
    if (typeof this.document?.getAcquiredRepository === "function") {
      const repository = this.document.getAcquiredRepository(id);
      if (repository) return repository;
    }
    const repository = this.#currentRepositories().find((entry) => entry.id === id);
    if (!repository) throw new TypeError(`Repository ${id} is not acquired for this Nora document`);
    return repository;
  }

  /** @param {AcquiredRepository} repository @param {unknown} rawPath @param {{ allowRoot?: boolean }} [options] */
  async #resolvePath(repository, rawPath, options = {}) {
    const relativePath = this.#normalizeToolPath(rawPath, options);
    const root = await fs.realpath(repository.worktreePath);
    const target = relativePath === "." ? root : path.join(root, relativePath);
    const absolutePath = await fs.realpath(target);
    assertContained(root, absolutePath, "Repository path escapes the acquired worktree");
    return { root, relativePath, absolutePath };
  }

  /** @param {unknown} rawPath @param {{ allowRoot?: boolean }} [options] */
  #normalizeToolPath(rawPath, options = {}) {
    const value = String(rawPath ?? "");
    if (options.allowRoot && (value === "" || value === ".")) return ".";
    return normalizeRepositoryRelativePath(value);
  }
}

/**
 * @param {ConstructorParameters<typeof RepositoryToolService>[0]} [options]
 * @returns {PiToolDefinition[]}
 */
export function createCodeTools(options = {}) {
  const service = new RepositoryToolService(options);
  return [
    tool("nora_list_repositories", "List Nora repositories", "List immutable repositories acquired for this Nora document.", {}, async () => service.listRepositories()),
    tool("nora_list_directory", "List repository directory", "List one directory in an acquired immutable repository worktree.", {
      repositoryId: { type: "string", description: "Repository ID from nora_list_repositories." },
      path: { type: "string", description: "Relative directory path inside the repository, or . for the repository root." },
    }, (_id, params, signal) => service.listDirectory(params, { signal })),
    tool("nora_find_files", "Find repository files", "Find tracked files by path text within one repository directory.", {
      repositoryId: { type: "string" },
      path: { type: "string" },
      query: { type: "string", description: "Case-insensitive text to match in repository-relative file paths." },
    }, (_id, params, signal) => service.findFiles(params, { signal })),
    tool("nora_search_text", "Search repository text", "Search tracked text files with fixed-string git grep in one repository path.", {
      repositoryId: { type: "string" },
      path: { type: "string" },
      query: { type: "string", description: "Fixed string to search for." },
    }, (_id, params, signal) => service.searchText(params, { signal })),
    tool("nora_read_file", "Read repository file", "Read a bounded UTF-8 text file from an acquired immutable repository worktree.", {
      repositoryId: { type: "string" },
      path: { type: "string" },
      offset: { type: "number", description: "Optional 1-indexed start line.", optional: true },
      limit: { type: "number", description: "Optional maximum line count.", optional: true },
    }, (_id, params) => service.readFile(params)),
    tool("nora_capture_evidence", "Capture code evidence", "Capture an immutable code evidence record for a repository path and line range.", {
      repositoryId: { type: "string" },
      path: { type: "string" },
      startLine: { type: "number" },
      endLine: { type: "number", optional: true },
      title: { type: "string", optional: true },
    }, (_id, params) => service.captureEvidence(params)),
  ];
}

/**
 * @param {string} name
 * @param {string} label
 * @param {string} description
 * @param {Record<string, unknown>} properties
 * @param {(toolCallId: string, params: Record<string, any>, signal?: AbortSignal) => unknown | Promise<unknown>} execute
 * @returns {PiToolDefinition}
 */
function tool(name, label, description, properties, execute) {
  const required = Object.entries(properties)
    .filter(([, schema]) => !/** @type {{ optional?: boolean }} */ (schema).optional)
    .map(([key]) => key);
  return {
    name,
    label,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    executionMode: "parallel",
    /**
     * @param {string} toolCallId
     * @param {unknown} params
     * @param {AbortSignal} [signal]
     */
    async execute(toolCallId, params, signal) {
      const details = await execute(toolCallId, /** @type {Record<string, any>} */ (params), signal);
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  };
}

/** @param {string} stdout */
function stripGitTruncationMarker(stdout) {
  const marker = "\n[git output truncated]";
  if (!stdout.endsWith(marker)) return { stdout, truncated: false };
  return { stdout: stdout.slice(0, -marker.length), truncated: true };
}

/** @param {string} output */
function parseGitGrepOutput(output) {
  /** @type {Array<{ path: string, line: number, text: string }>} */
  const matches = [];
  let cursor = 0;
  while (cursor < output.length) {
    const pathEnd = output.indexOf("\0", cursor);
    const lineEnd = pathEnd >= 0 ? output.indexOf("\0", pathEnd + 1) : -1;
    if (pathEnd < 0 || lineEnd < 0) break;
    const textEnd = output.indexOf("\n", lineEnd + 1);
    const nextCursor = textEnd < 0 ? output.length : textEnd + 1;
    matches.push({
      path: output.slice(cursor, pathEnd),
      line: Number(output.slice(pathEnd + 1, lineEnd)) || 0,
      text: output.slice(lineEnd + 1, textEnd < 0 ? output.length : textEnd),
    });
    cursor = nextCursor;
  }
  return matches;
}

/** @param {import("node:fs").Stats} stat @param {number} maxBytes */
function assertRegularReadableFile(stat, maxBytes) {
  if (!stat.isFile()) throw new TypeError("Path is not a regular file");
  if (stat.size > maxBytes) throw new TypeError(`File exceeds Nora read limit of ${maxBytes} bytes`);
}

/** @param {Buffer} buffer */
function assertTextBuffer(buffer) {
  if (buffer.includes(0)) throw new TypeError("Binary files cannot be read as text");
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

/** @param {string} root @param {string} target @param {string} message */
export function assertContained(root, target, message) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(prefix)) throw new TypeError(message);
}
