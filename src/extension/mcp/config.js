import fs from "node:fs/promises";
import path from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

export const MCP_CONFIG_RELATIVE_PATH = path.join(".vscode", "mcp.json");

const TOP_LEVEL_KEYS = new Set(["servers", "inputs"]);
const STDIO_KEYS = new Set(["type", "command", "args", "cwd", "env", "envFile"]);
const HTTP_KEYS = new Set(["type", "url", "headers"]);
const INPUT_KEYS = new Set(["id", "type", "description", "default", "password", "options", "command", "args"]);
const SECRET_QUERY_RE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential|authorization|auth|key)$/i;

/**
 * @typedef {{ severity: "error" | "warning", message: string, path: string, serverName?: string }} NoraMcpDiagnostic
 * @typedef {{ id: string, type: "promptString", description: string, defaultValue: string | null, password: boolean }} NoraMcpPromptInput
 * @typedef {{ id: string, type: "pickString", description: string, options: { label: string, value: string, description?: string }[], defaultValue: string | null }} NoraMcpPickInput
 * @typedef {{ id: string, type: "command", command: string, args: unknown }} NoraMcpCommandInput
 * @typedef {NoraMcpPromptInput | NoraMcpPickInput | NoraMcpCommandInput} NoraMcpInput
 * @typedef {{ name: string, type: "stdio", command: string, args: string[], cwd: string | null, env: Record<string, string>, envFile: string | null }} NoraMcpStdioServer
 * @typedef {{ name: string, type: "http", url: string, headers: Record<string, string> }} NoraMcpHttpServer
 * @typedef {NoraMcpStdioServer | NoraMcpHttpServer} NoraMcpServerConfig
 * @typedef {{ source: string, servers: Map<string, NoraMcpServerConfig>, inputs: Map<string, NoraMcpInput>, diagnostics: NoraMcpDiagnostic[] }} NoraMcpConfig
 */

export class NoraMcpConfigError extends Error {
  /** @param {string} message @param {NoraMcpDiagnostic[]} diagnostics */
  constructor(message, diagnostics) {
    super(message);
    this.name = "NoraMcpConfigError";
    this.diagnostics = diagnostics;
  }
}

/**
 * @param {string} workspaceFolderPath
 */
export function workspaceMcpConfigPath(workspaceFolderPath) {
  return path.join(workspaceFolderPath, MCP_CONFIG_RELATIVE_PATH);
}

/**
 * @param {string | null | undefined} workspaceFolderPath
 * @param {{ readFile?: typeof fs.readFile }} [options]
 * @returns {Promise<NoraMcpConfig>}
 */
export async function readWorkspaceMcpConfig(workspaceFolderPath, options = {}) {
  const source = workspaceFolderPath ? workspaceMcpConfigPath(workspaceFolderPath) : MCP_CONFIG_RELATIVE_PATH;
  if (!workspaceFolderPath) return emptyConfig(source);
  const readFile = options.readFile ?? fs.readFile;
  let text;
  try {
    text = await readFile(source, "utf8");
  } catch (error) {
    if (/** @type {{ code?: unknown }} */ (error)?.code === "ENOENT") return emptyConfig(source);
    throw error;
  }
  return parseMcpConfigText(String(text), { source });
}

/**
 * @param {string} text
 * @param {{ source?: string }} [options]
 * @returns {NoraMcpConfig}
 */
export function parseMcpConfigText(text, options = {}) {
  const source = options.source ?? MCP_CONFIG_RELATIVE_PATH;
  /** @type {NoraMcpDiagnostic[]} */
  const diagnostics = [];
  /** @type {import("jsonc-parser").ParseError[]} */
  const parseErrors = [];
  const raw = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
  for (const error of parseErrors) {
    diagnostics.push({
      severity: "error",
      path: source,
      message: `Invalid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}`,
    });
  }
  if (parseErrors.length) return { source, servers: new Map(), inputs: new Map(), diagnostics };
  if (!isPlainRecord(raw)) {
    diagnostics.push({ severity: "error", path: source, message: "MCP configuration must be an object" });
    return { source, servers: new Map(), inputs: new Map(), diagnostics };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push({ severity: "error", path: `${source}.${key}`, message: `Unsupported top-level MCP field: ${key}` });
    }
  }

  const inputs = normalizeInputs(raw.inputs, source, diagnostics);
  const servers = normalizeServers(raw.servers, source, diagnostics);
  return { source, servers, inputs, diagnostics };
}

/** @param {string} source @returns {NoraMcpConfig} */
function emptyConfig(source) {
  return { source, servers: new Map(), inputs: new Map(), diagnostics: [] };
}

/**
 * @param {unknown} raw
 * @param {string} source
 * @param {NoraMcpDiagnostic[]} diagnostics
 * @returns {Map<string, NoraMcpServerConfig>}
 */
function normalizeServers(raw, source, diagnostics) {
  /** @type {Map<string, NoraMcpServerConfig>} */
  const servers = new Map();
  if (raw == null) return servers;
  if (!isPlainRecord(raw)) {
    diagnostics.push({ severity: "error", path: `${source}.servers`, message: "MCP servers must be an object" });
    return servers;
  }
  for (const [rawName, entry] of Object.entries(raw)) {
    const serverPath = `${source}.servers.${rawName}`;
    let name;
    try {
      name = normalizeServerName(rawName, serverPath);
      if (servers.has(name)) throw new TypeError(`Duplicate MCP server name: ${name}`);
      const server = normalizeServerEntry(name, entry, serverPath);
      servers.set(name, server);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        path: serverPath,
        serverName: name ?? rawName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return servers;
}

/**
 * @param {string} name
 * @param {unknown} raw
 * @param {string} serverPath
 * @returns {NoraMcpServerConfig}
 */
function normalizeServerEntry(name, raw, serverPath) {
  const input = requirePlainRecord(raw, serverPath);
  const type = requireNonEmptyString(input.type, `${serverPath}.type`);
  if (type === "sse") throw new TypeError("Legacy SSE MCP transport is not supported by Nora");
  if (type !== "stdio" && type !== "http") throw new TypeError(`${serverPath}.type must be "stdio" or "http"`);
  if (hasExplicitlyRejectedField(input)) {
    throw new TypeError("Nora rejects MCP OAuth automation, sandbox, development-server, prompt/import, and approval policy fields");
  }
  return type === "stdio"
    ? normalizeStdioServer(name, input, serverPath)
    : normalizeHttpServer(name, input, serverPath);
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @param {string} serverPath
 * @returns {NoraMcpStdioServer}
 */
function normalizeStdioServer(name, input, serverPath) {
  requireOnlyKeys(input, STDIO_KEYS, serverPath);
  return {
    name,
    type: "stdio",
    command: requireNonEmptyString(input.command, `${serverPath}.command`),
    args: normalizeStringArray(input.args, `${serverPath}.args`),
    cwd: optionalString(input.cwd, `${serverPath}.cwd`),
    env: normalizeStringRecord(input.env, `${serverPath}.env`, "env"),
    envFile: optionalString(input.envFile, `${serverPath}.envFile`),
  };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @param {string} serverPath
 * @returns {NoraMcpHttpServer}
 */
function normalizeHttpServer(name, input, serverPath) {
  requireOnlyKeys(input, HTTP_KEYS, serverPath);
  const url = normalizeHttpUrl(input.url, `${serverPath}.url`);
  return {
    name,
    type: "http",
    url,
    headers: normalizeStringRecord(input.headers, `${serverPath}.headers`, "headers"),
  };
}

/**
 * @param {unknown} raw
 * @param {string} source
 * @param {NoraMcpDiagnostic[]} diagnostics
 * @returns {Map<string, NoraMcpInput>}
 */
function normalizeInputs(raw, source, diagnostics) {
  /** @type {Map<string, NoraMcpInput>} */
  const inputs = new Map();
  if (raw == null) return inputs;
  if (!Array.isArray(raw)) {
    diagnostics.push({ severity: "error", path: `${source}.inputs`, message: "MCP inputs must be an array" });
    return inputs;
  }
  raw.forEach((entry, index) => {
    const inputPath = `${source}.inputs[${index}]`;
    try {
      const input = normalizeInput(entry, inputPath);
      if (inputs.has(input.id)) throw new TypeError(`Duplicate MCP input id: ${input.id}`);
      inputs.set(input.id, input);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        path: inputPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return inputs;
}

/** @param {unknown} raw @param {string} inputPath @returns {NoraMcpInput} */
function normalizeInput(raw, inputPath) {
  const input = requirePlainRecord(raw, inputPath);
  requireOnlyKeys(input, INPUT_KEYS, inputPath);
  const id = normalizeInputId(input.id, `${inputPath}.id`);
  const type = requireNonEmptyString(input.type, `${inputPath}.type`);
  if (type === "promptString") {
    return {
      id,
      type,
      description: optionalString(input.description, `${inputPath}.description`) ?? id,
      defaultValue: optionalString(input.default, `${inputPath}.default`),
      password: input.password == null ? false : requireBoolean(input.password, `${inputPath}.password`),
    };
  }
  if (type === "pickString") {
    return {
      id,
      type,
      description: optionalString(input.description, `${inputPath}.description`) ?? id,
      options: normalizePickOptions(input.options, `${inputPath}.options`),
      defaultValue: optionalString(input.default, `${inputPath}.default`),
    };
  }
  if (type === "command") {
    return {
      id,
      type,
      command: requireNonEmptyString(input.command, `${inputPath}.command`),
      args: input.args ?? undefined,
    };
  }
  throw new TypeError(`${inputPath}.type must be promptString, pickString, or command`);
}

/** @param {unknown} raw @param {string} inputPath */
function normalizePickOptions(raw, inputPath) {
  if (!Array.isArray(raw) || raw.length === 0) throw new TypeError(`${inputPath} must be a non-empty array`);
  return raw.map((entry, index) => {
    if (typeof entry === "string") return { label: entry, value: entry };
    const object = requirePlainRecord(entry, `${inputPath}[${index}]`);
    const label = requireNonEmptyString(object.label, `${inputPath}[${index}].label`);
    const value = optionalString(object.value, `${inputPath}[${index}].value`) ?? label;
    const description = optionalString(object.description, `${inputPath}[${index}].description`);
    return description ? { label, value, description } : { label, value };
  });
}

/** @param {Record<string, unknown>} input */
function hasExplicitlyRejectedField(input) {
  return Object.keys(input).some((key) => /^(oauth|authorization|sandbox|approval|approvals|prompt|prompts|import|imports|developmentServer|devServer|dev)$/i.test(key));
}

/** @param {string} name @param {string} pathLabel */
function normalizeServerName(name, pathLabel) {
  const value = requireNonEmptyString(name, pathLabel);
  if (/[\/\\\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${pathLabel} must not contain slashes or control characters`);
  return value;
}

/** @param {unknown} value @param {string} pathLabel */
function normalizeInputId(value, pathLabel) {
  const id = requireNonEmptyString(value, pathLabel);
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) throw new TypeError(`${pathLabel} must be stable ASCII id text`);
  return id;
}

/** @param {unknown} raw @param {string} pathLabel */
function normalizeHttpUrl(raw, pathLabel) {
  const value = requireNonEmptyString(raw, pathLabel);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${pathLabel} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`${pathLabel} must use http or https`);
  if (url.username || url.password) throw new TypeError(`${pathLabel} must not contain URL userinfo`);
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(key)) throw new TypeError(`${pathLabel} must not contain credential-bearing query parameter ${key}`);
  }
  return url.toString();
}

/** @param {unknown} raw @param {string} pathLabel @param {"env" | "headers"} kind */
function normalizeStringRecord(raw, pathLabel, kind) {
  /** @type {Record<string, string>} */
  const output = {};
  if (raw == null) return output;
  const input = requirePlainRecord(raw, pathLabel);
  for (const [key, value] of Object.entries(input)) {
    if (kind === "env") assertValidEnvName(key, `${pathLabel}.${key}`);
    else assertValidHeaderName(key, `${pathLabel}.${key}`);
    output[key] = requireString(value, `${pathLabel}.${key}`);
  }
  return output;
}

/** @param {unknown} raw @param {string} pathLabel */
function normalizeStringArray(raw, pathLabel) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new TypeError(`${pathLabel} must be an array`);
  return raw.map((entry, index) => requireString(entry, `${pathLabel}[${index}]`));
}

/** @param {unknown} value @param {string} pathLabel */
function optionalString(value, pathLabel) {
  if (value == null) return null;
  return requireString(value, pathLabel);
}

/** @param {unknown} value @param {string} pathLabel */
function requireString(value, pathLabel) {
  if (typeof value !== "string") throw new TypeError(`${pathLabel} must be a string`);
  return value;
}

/** @param {unknown} value @param {string} pathLabel */
function requireNonEmptyString(value, pathLabel) {
  const text = requireString(value, pathLabel).trim();
  if (!text) throw new TypeError(`${pathLabel} must be a non-empty string`);
  return text;
}

/** @param {unknown} value @param {string} pathLabel */
function requireBoolean(value, pathLabel) {
  if (typeof value !== "boolean") throw new TypeError(`${pathLabel} must be a boolean`);
  return value;
}

/** @param {unknown} value @param {string} pathLabel @returns {Record<string, unknown>} */
function requirePlainRecord(value, pathLabel) {
  if (!isPlainRecord(value)) throw new TypeError(`${pathLabel} must be an object`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value @param {Set<string>} allowed @param {string} pathLabel */
function requireOnlyKeys(value, allowed, pathLabel) {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new TypeError(`${pathLabel} has unsupported keys: ${unsupported.join(", ")}`);
}

/** @param {string} name @param {string} pathLabel */
function assertValidEnvName(name, pathLabel) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`${pathLabel} is not a valid environment variable name`);
}

/** @param {string} name @param {string} pathLabel */
function assertValidHeaderName(name, pathLabel) {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new TypeError(`${pathLabel} is not a valid HTTP header name`);
}

/** @param {unknown} value */
function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
