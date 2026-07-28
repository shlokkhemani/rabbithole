import { readWorkspaceMcpConfig } from "./config.js";
import { boundMcpModelResult } from "./output.js";
import { McpSupervisor } from "./supervisor.js";
import { resolveMcpServerConfig } from "./variables.js";
import { addMcpResourceBlobAttachment } from "../attachments.js";

const MCP_DIRECT_TOOLS_SETTING = "nora.mcp.directTools";

/** @typedef {import("./config.js").NoraMcpConfig} NoraMcpConfig */

export class McpToolService {
  /**
   * @param {{
   *   workspaceFolderPath?: string | null,
   *   supervisor?: McpSupervisor,
   *   document?: import("../nora-document.js").NoraDocument | null,
   *   vscode?: typeof import("vscode"),
   *   directTools?: string[],
   *   readConfig?: typeof readWorkspaceMcpConfig,
   *   resolveServerConfig?: typeof resolveMcpServerConfig,
   *   inputResolver?: (input: import("./config.js").NoraMcpInput) => Promise<string> | string,
   *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
   *   userHome?: string
   * }} [options]
   */
  constructor(options = {}) {
    this.workspaceFolderPath = options.workspaceFolderPath ?? null;
    this.supervisor = options.supervisor ?? new McpSupervisor();
    this.document = options.document ?? null;
    this.vscode = options.vscode;
    this.directTools = options.directTools ?? readConfiguredDirectTools(options.vscode);
    this.readConfig = options.readConfig ?? readWorkspaceMcpConfig;
    this.resolveServerConfig = options.resolveServerConfig ?? resolveMcpServerConfig;
    this.inputResolver = options.inputResolver;
    this.env = options.env;
    this.userHome = options.userHome;
    /** @type {Promise<NoraMcpConfig> | null} */
    this.configPromise = null;
    /** @type {Map<string, { connection: import("./connection.js").NoraMcpConnection, release: () => Promise<void> }>} */
    this.handles = new Map();
  }

  async dispose() {
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(handles.map((handle) => handle.release()));
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async executeGeneric(input, options = {}) {
    const operation = requireOneOf(input.operation, ["search", "describe", "call", "list_resources", "read_resource"], "operation");
    if (operation === "search") return this.#wrapResult({ operation }, await this.#search(input, options));
    if (operation === "describe") return this.#wrapResult({ operation }, await this.#describe(input, options));
    if (operation === "call") {
      const server = requireString(input.server, "server");
      const toolName = requireString(input.tool ?? input.toolName, "tool");
      const result = await this.callTool(server, toolName, objectArguments(input.arguments), options);
      return this.#wrapResult({ operation, server, toolName }, result);
    }
    if (operation === "list_resources") return this.#wrapResult({ operation }, await this.#listResources(input, options));
    const server = requireString(input.server, "server");
    const uri = requireString(input.uri ?? input.resourceUri, "uri");
    const result = await this.#readResource(server, uri, options);
    return this.#wrapResult({ operation, server, resourceUri: uri }, result);
  }

  /**
   * @param {string} server
   * @param {string} toolName
   * @param {Record<string, unknown>} args
   * @param {{ signal?: AbortSignal }} [options]
   */
  async callTool(server, toolName, args, options = {}) {
    return (await this.#handle(server)).connection.callTool(toolName, args, options);
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {{ signal?: AbortSignal }} options
   */
  async #search(input, options) {
    const query = String(input.query ?? "");
    const server = optionalString(input.server);
    if (server) return (await this.#handle(server)).connection.search(query, options);
    const config = await this.#config();
    const results = [];
    for (const name of config.servers.keys()) {
      try {
        results.push(await (await this.#handle(name)).connection.search(query, options));
      } catch (error) {
        results.push({ server: name, error: errorClass(error) });
      }
    }
    return { query, results, diagnostics: safeDiagnostics(config) };
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {{ signal?: AbortSignal }} options
   */
  async #describe(input, options) {
    const server = optionalString(input.server);
    if (server) {
      return (await this.#handle(server)).connection.describe({
        tool: optionalString(input.tool ?? input.toolName) ?? undefined,
        resource: optionalString(input.uri ?? input.resourceUri) ?? undefined,
      }, options);
    }
    const config = await this.#config();
    return {
      servers: [...config.servers.values()].map((entry) => ({ name: entry.name, type: entry.type })),
      diagnostics: safeDiagnostics(config),
    };
  }

  /**
   * @param {Record<string, unknown>} input
   * @param {{ signal?: AbortSignal }} options
   */
  async #listResources(input, options) {
    const server = optionalString(input.server);
    if (server) return { server, resources: await (await this.#handle(server)).connection.listResources(options) };
    const config = await this.#config();
    const results = [];
    for (const name of config.servers.keys()) {
      try {
        results.push({ server: name, resources: await (await this.#handle(name)).connection.listResources(options) });
      } catch (error) {
        results.push({ server: name, error: errorClass(error) });
      }
    }
    return { results, diagnostics: safeDiagnostics(config) };
  }

  /**
   * @param {string} server
   * @param {string} uri
   * @param {{ signal?: AbortSignal }} options
   */
  async #readResource(server, uri, options) {
    const raw = await (await this.#handle(server)).connection.readResource(uri, options);
    if (!this.document) return raw;
    const result = cloneJson(raw);
    const contents = Array.isArray(result?.contents) ? result.contents : [];
    for (let index = 0; index < contents.length; index += 1) {
      const content = contents[index];
      if (!content || typeof content !== "object" || Array.isArray(content) || typeof content.blob !== "string") continue;
      const attachment = await addMcpResourceBlobAttachment(this.document, {
        server,
        uri: String(content.uri ?? uri),
        content: /** @type {Record<string, unknown>} */ (content),
      });
      const { blob: _blob, ...withoutBlob } = content;
      contents[index] = {
        ...withoutBlob,
        attachment: {
          id: attachment.attachment.id,
          sha256: attachment.attachment.sha256,
          bytes: attachment.attachment.bytes,
          mediaType: attachment.attachment.mediaType,
          assetName: attachment.assetName,
          sourceId: attachment.source.id,
          evidenceIds: [attachment.evidence.id],
        },
      };
    }
    return result;
  }

  /** @param {string} serverName */
  async #handle(serverName) {
    const existing = this.handles.get(serverName);
    if (existing) return existing;
    const config = await this.#config();
    const server = config.servers.get(serverName);
    if (!server) {
      const diagnostic = config.diagnostics.find((entry) => entry.serverName === serverName);
      throw new Error(diagnostic?.message ?? `MCP server is not configured: ${serverName}`);
    }
    const resolved = await this.resolveServerConfig(server, {
      workspaceFolderPath: this.workspaceFolderPath,
      inputs: config.inputs,
      inputResolver: this.inputResolver,
      vscode: this.vscode,
      env: this.env,
      userHome: this.userHome,
    });
    const handle = this.supervisor.acquire(this.workspaceFolderPath, resolved);
    this.handles.set(serverName, handle);
    return handle;
  }

  async #config() {
    if (!this.configPromise) this.configPromise = this.readConfig(this.workspaceFolderPath);
    return this.configPromise;
  }

  /**
   * @param {Record<string, unknown>} metadata
   * @param {unknown} rawResult
   */
  #wrapResult(metadata, rawResult) {
    const bounded = boundMcpModelResult(rawResult);
    const details = {
      ...metadata,
      result: bounded.text,
      truncated: bounded.truncated,
      limits: bounded.limits,
      originalBytes: bounded.originalBytes,
      originalLines: bounded.originalLines,
      resultBytes: bounded.bytes,
      resultLines: bounded.lines,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
      details,
    };
  }
}

/**
 * @param {ConstructorParameters<typeof McpToolService>[0]} [options]
 */
export function createMcpToolBundle(options = {}) {
  const service = new McpToolService(options);
  return {
    tools: [
      genericMcpTool(service),
      ...directMcpTools(service, service.directTools),
    ],
    dispose: () => service.dispose(),
  };
}

/**
 * @param {ConstructorParameters<typeof McpToolService>[0]} [options]
 */
export function createMcpTools(options = {}) {
  return createMcpToolBundle(options).tools;
}

/** @param {McpToolService} service */
function genericMcpTool(service) {
  return {
    name: "mcp",
    label: "MCP",
    description: "Search, describe, call, list resources, and read resources from user-configured MCP servers.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["search", "describe", "call", "list_resources", "read_resource"] },
        server: { type: "string", optional: true },
        query: { type: "string", optional: true },
        tool: { type: "string", optional: true },
        arguments: { type: "object", optional: true },
        uri: { type: "string", optional: true },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    /** @param {string} _toolCallId @param {unknown} params @param {AbortSignal} [signal] */
    execute(_toolCallId, params, signal) {
      return service.executeGeneric(/** @type {Record<string, unknown>} */ (params), { signal });
    },
  };
}

/**
 * @param {McpToolService} service
 * @param {string[]} directTools
 */
function directMcpTools(service, directTools) {
  /** @type {Map<string, { server: string, tool: string, name: string }>} */
  const entries = new Map();
  for (const entry of directTools) {
    const parsed = parseDirectTool(entry);
    if (!parsed) continue;
    const name = `mcp__${sanitizeMcpDirectToolName(parsed.server)}__${sanitizeMcpDirectToolName(parsed.tool)}`;
    if (!entries.has(name)) entries.set(name, { ...parsed, name });
  }
  return [...entries.values()].map((entry) => ({
    name: entry.name,
    label: `${entry.server}/${entry.tool}`,
    description: `Call configured MCP tool ${entry.server}/${entry.tool}.`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    executionMode: "parallel",
    /** @param {string} _toolCallId @param {unknown} params @param {AbortSignal} [signal] */
    async execute(_toolCallId, params, signal) {
      const result = await service.callTool(entry.server, entry.tool, objectArguments(params), { signal });
      const bounded = boundMcpModelResult(result);
      const details = {
        operation: "call",
        server: entry.server,
        toolName: entry.tool,
        directToolName: entry.name,
        result: bounded.text,
        truncated: bounded.truncated,
        limits: bounded.limits,
        originalBytes: bounded.originalBytes,
        originalLines: bounded.originalLines,
        resultBytes: bounded.bytes,
        resultLines: bounded.lines,
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  }));
}

/**
 * @param {string} value
 */
export function sanitizeMcpDirectToolName(value) {
  const sanitized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!sanitized) return "unnamed";
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

/** @param {string} value */
function parseDirectTool(value) {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { server: value.slice(0, separator), tool: value.slice(separator + 1) };
}

/** @param {typeof import("vscode") | undefined} vscode */
function readConfiguredDirectTools(vscode) {
  const raw = vscode?.workspace?.getConfiguration?.().get?.(MCP_DIRECT_TOOLS_SETTING);
  return Array.isArray(raw) ? raw.filter((entry) => typeof entry === "string") : [];
}

/** @param {NoraMcpConfig} config */
function safeDiagnostics(config) {
  return config.diagnostics.map((entry) => ({
    severity: entry.severity,
    serverName: entry.serverName,
    message: entry.message,
  }));
}

/** @param {unknown} value @param {string} label */
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

/** @param {unknown} value */
function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {unknown} value @param {string[]} allowed @param {string} label */
function requireOneOf(value, allowed, label) {
  const text = requireString(value, label);
  if (!allowed.includes(text)) throw new TypeError(`${label} must be one of: ${allowed.join(", ")}`);
  return text;
}

/** @param {unknown} value */
function objectArguments(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("arguments must be an object");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} error */
function errorClass(error) {
  return error instanceof Error && error.name ? error.name : "Error";
}

/** @param {unknown} value */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
