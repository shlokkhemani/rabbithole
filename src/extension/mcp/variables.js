import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";

const VARIABLE_RE = /\$\{([^}]+)\}/g;

/**
 * @typedef {import("./config.js").NoraMcpServerConfig} NoraMcpServerConfig
 * @typedef {import("./config.js").NoraMcpInput} NoraMcpInput
 * @typedef {import("./config.js").NoraMcpStdioServer} NoraMcpStdioServer
 * @typedef {import("./config.js").NoraMcpHttpServer} NoraMcpHttpServer
 * @typedef {{ name: string, type: "stdio", command: string, args: string[], cwd: string | undefined, env: Record<string, string>, fingerprint: string }} ResolvedNoraMcpStdioServer
 * @typedef {{ name: string, type: "http", url: string, headers: Record<string, string>, fingerprint: string }} ResolvedNoraMcpHttpServer
 * @typedef {ResolvedNoraMcpStdioServer | ResolvedNoraMcpHttpServer} ResolvedNoraMcpServer
 */

/**
 * @param {NoraMcpServerConfig} server
 * @param {{
 *   workspaceFolderPath?: string | null,
 *   userHome?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   inputs?: Map<string, NoraMcpInput>,
 *   inputResolver?: (input: NoraMcpInput) => Promise<string> | string,
 *   vscode?: typeof import("vscode"),
 *   readFile?: typeof fs.readFile
 * }} [context]
 * @returns {Promise<ResolvedNoraMcpServer>}
 */
export async function resolveMcpServerConfig(server, context = {}) {
  const resolver = new VariableResolver(context);
  if (server.type === "stdio") {
    const envFile = server.envFile ? await resolver.resolveString(server.envFile, `${server.name}.envFile`) : null;
    const envFromFile = envFile ? await readDotenvFile(envFile, resolver, context.readFile ?? fs.readFile) : {};
    const explicitEnv = await resolver.resolveStringRecord(server.env, `${server.name}.env`);
    /** @type {ResolvedNoraMcpStdioServer} */
    const resolved = {
      name: server.name,
      type: /** @type {"stdio"} */ ("stdio"),
      command: await resolver.resolveString(server.command, `${server.name}.command`),
      args: await Promise.all(server.args.map((arg, index) => resolver.resolveString(arg, `${server.name}.args[${index}]`))),
      cwd: server.cwd ? await resolver.resolveString(server.cwd, `${server.name}.cwd`) : undefined,
      env: { ...envFromFile, ...explicitEnv },
      fingerprint: "",
    };
    resolved.fingerprint = normalizedMcpServerFingerprint(server, resolved);
    return resolved;
  }
  /** @type {ResolvedNoraMcpHttpServer} */
  const resolved = {
    name: server.name,
    type: /** @type {"http"} */ ("http"),
    url: await resolver.resolveString(server.url, `${server.name}.url`),
    headers: await resolver.resolveStringRecord(server.headers, `${server.name}.headers`),
    fingerprint: "",
  };
  assertResolvedHttpUrl(resolved.url, `${server.name}.url`);
  resolved.fingerprint = normalizedMcpServerFingerprint(server, resolved);
  return resolved;
}

/**
 * @param {NoraMcpServerConfig} unresolved
 * @param {Partial<ResolvedNoraMcpServer>} [resolved]
 */
export function normalizedMcpServerFingerprint(unresolved, resolved = {}) {
  let payload;
  if (unresolved.type === "stdio") {
    const stdioResolved = /** @type {Partial<ResolvedNoraMcpStdioServer>} */ (resolved);
    payload = {
        name: unresolved.name,
        type: unresolved.type,
        command: stdioResolved.command ?? unresolved.command,
        args: stdioResolved.args ?? unresolved.args,
        cwd: stdioResolved.cwd ?? unresolved.cwd,
        envKeys: Object.keys(stdioResolved.env ?? unresolved.env).sort(),
        envFile: unresolved.envFile,
    };
  } else {
    const httpResolved = /** @type {Partial<ResolvedNoraMcpHttpServer>} */ (resolved);
    payload = {
        name: unresolved.name,
        type: unresolved.type,
        url: redactUrlForFingerprint(httpResolved.url ?? unresolved.url),
        headerKeys: Object.keys(httpResolved.headers ?? unresolved.headers).map((key) => key.toLowerCase()).sort(),
    };
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

class VariableResolver {
  /**
   * @param {{
   *   workspaceFolderPath?: string | null,
   *   userHome?: string,
   *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
   *   inputs?: Map<string, NoraMcpInput>,
   *   inputResolver?: (input: NoraMcpInput) => Promise<string> | string,
   *   vscode?: typeof import("vscode")
   * }} context
   */
  constructor(context) {
    this.workspaceFolderPath = context.workspaceFolderPath ?? null;
    this.userHome = context.userHome ?? os.homedir();
    this.env = context.env ?? process.env;
    this.inputs = context.inputs ?? new Map();
    this.inputResolver = context.inputResolver ?? null;
    this.vscode = context.vscode;
    /** @type {Map<string, string>} */
    this.inputCache = new Map();
  }

  /** @param {Record<string, string>} values @param {string} label */
  async resolveStringRecord(values, label) {
    /** @type {Record<string, string>} */
    const output = {};
    for (const [key, value] of Object.entries(values)) output[key] = await this.resolveString(value, `${label}.${key}`);
    return output;
  }

  /** @param {string} value @param {string} label */
  async resolveString(value, label) {
    let output = "";
    let cursor = 0;
    for (const match of value.matchAll(VARIABLE_RE)) {
      output += value.slice(cursor, match.index);
      output += await this.#resolveVariable(match[1], label);
      cursor = Number(match.index) + match[0].length;
    }
    output += value.slice(cursor);
    if (/\$\{[^}]*$/.test(output)) throw new TypeError(`${label} contains an unterminated variable`);
    return output;
  }

  /** @param {string} expression @param {string} label */
  async #resolveVariable(expression, label) {
    if (expression === "workspaceFolder") {
      if (!this.workspaceFolderPath) throw new TypeError(`${label} uses \${workspaceFolder} without a workspace folder`);
      return this.workspaceFolderPath;
    }
    if (expression === "workspaceFolderBasename") {
      if (!this.workspaceFolderPath) throw new TypeError(`${label} uses \${workspaceFolderBasename} without a workspace folder`);
      return path.basename(this.workspaceFolderPath);
    }
    if (expression === "userHome") return this.userHome;
    if (expression.startsWith("env:")) {
      const name = expression.slice(4);
      if (!name) throw new TypeError(`${label} has an empty env variable reference`);
      const value = this.env[name];
      if (typeof value !== "string") throw new TypeError(`${label} references unresolved environment variable ${name}`);
      return value;
    }
    if (expression.startsWith("input:")) {
      const id = expression.slice(6);
      if (!id) throw new TypeError(`${label} has an empty input reference`);
      return this.#resolveInput(id, label);
    }
    throw new TypeError(`${label} contains unsupported variable \${${expression}}`);
  }

  /** @param {string} id @param {string} label */
  async #resolveInput(id, label) {
    if (this.inputCache.has(id)) return /** @type {string} */ (this.inputCache.get(id));
    const input = this.inputs.get(id);
    if (!input) throw new TypeError(`${label} references unknown MCP input ${id}`);
    const value = this.inputResolver
      ? await this.inputResolver(input)
      : await resolveInputWithVsCode(input, this.vscode);
    if (typeof value !== "string") throw new TypeError(`MCP input ${id} did not resolve to a string`);
    this.inputCache.set(id, value);
    return value;
  }
}

/**
 * @param {NoraMcpInput} input
 * @param {typeof import("vscode") | undefined} vscode
 * @returns {Promise<string>}
 */
async function resolveInputWithVsCode(input, vscode) {
  if (input.type === "promptString") {
    if (!vscode) return input.defaultValue ?? "";
    const value = await vscode.window.showInputBox({
      title: input.description,
      prompt: input.description,
      value: input.defaultValue ?? undefined,
      password: input.password,
      ignoreFocusOut: true,
    });
    if (typeof value !== "string") throw new Error(`MCP input ${input.id} was cancelled`);
    return value;
  }
  if (input.type === "pickString") {
    if (!vscode) return input.defaultValue ?? input.options[0]?.value ?? "";
    const picked = await vscode.window.showQuickPick(
      input.options.map((option) => ({
        label: option.label,
        description: option.description,
        value: option.value,
        picked: input.defaultValue === option.value,
      })),
      { title: input.description, placeHolder: input.description, ignoreFocusOut: true },
    );
    if (!picked) throw new Error(`MCP input ${input.id} was cancelled`);
    return picked.value;
  }
  if (!vscode) throw new Error(`MCP command input ${input.id} requires VS Code command execution`);
  const result = await vscode.commands.executeCommand(input.command, input.args);
  if (typeof result !== "string") throw new TypeError(`MCP command input ${input.id} must return a string`);
  return result;
}

/**
 * @param {string} envFile
 * @param {VariableResolver} resolver
 * @param {typeof fs.readFile} readFile
 */
async function readDotenvFile(envFile, resolver, readFile) {
  const parsed = parseDotenv(await readFile(envFile, "utf8"));
  /** @type {Record<string, string>} */
  const output = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`Invalid envFile variable name: ${key}`);
    output[key] = await resolver.resolveString(String(value), `envFile.${key}`);
  }
  return output;
}

/** @param {string} urlText @param {string} label */
function assertResolvedHttpUrl(urlText, label) {
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new TypeError(`${label} must resolve to a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`${label} must resolve to http or https`);
  if (url.username || url.password) throw new TypeError(`${label} must not resolve to URL userinfo`);
}

/** @param {string} urlText */
function redactUrlForFingerprint(urlText) {
  try {
    const url = new URL(urlText);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "<redacted>");
    return url.toString();
  } catch {
    return urlText;
  }
}
