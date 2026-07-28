import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logMcpOperation } from "./output.js";

const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_RECONNECT_ATTEMPTS = 2;

/**
 * @typedef {import("./variables.js").ResolvedNoraMcpServer} ResolvedNoraMcpServer
 */

export class NoraMcpConnection {
  /**
   * @param {{
   *   server: ResolvedNoraMcpServer,
   *   ClientCtor?: typeof Client,
   *   StdioClientTransportCtor?: typeof StdioClientTransport,
   *   StreamableHTTPClientTransportCtor?: typeof StreamableHTTPClientTransport,
   *   outputChannel?: unknown,
   *   callTimeoutMs?: number,
   *   maxReconnectAttempts?: number
   * }} options
   */
  constructor(options) {
    this.server = options.server;
    this.ClientCtor = options.ClientCtor ?? Client;
    this.StdioClientTransportCtor = options.StdioClientTransportCtor ?? StdioClientTransport;
    this.StreamableHTTPClientTransportCtor = options.StreamableHTTPClientTransportCtor ?? StreamableHTTPClientTransport;
    this.outputChannel = options.outputChannel;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    /** @type {any | null} */
    this.client = null;
    /** @type {any | null} */
    this.transport = null;
    /** @type {Promise<any> | null} */
    this.connecting = null;
    /** @type {unknown[] | null} */
    this.toolsCache = null;
    /** @type {unknown[] | null} */
    this.resourcesCache = null;
    this.closed = false;
    this.stale = false;
    this.activeCalls = 0;
  }

  markStale() {
    this.stale = true;
    if (this.activeCalls === 0) void this.#closeClient();
  }

  async close() {
    this.closed = true;
    await this.#closeClient();
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async listTools(options = {}) {
    return this.#request("list_tools", async (client, requestOptions) => {
      const result = await client.listTools(undefined, requestOptions);
      this.toolsCache = Array.isArray(result?.tools) ? result.tools : [];
      return this.toolsCache;
    }, options);
  }

  /** @param {{ signal?: AbortSignal }} [options] */
  async listResources(options = {}) {
    return this.#request("list_resources", async (client, requestOptions) => {
      const result = await client.listResources(undefined, requestOptions);
      this.resourcesCache = Array.isArray(result?.resources) ? result.resources : [];
      return this.resourcesCache;
    }, options);
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {{ signal?: AbortSignal }} [options]
   */
  async callTool(name, args, options = {}) {
    return this.#request("call_tool", (client, requestOptions) => (
      client.callTool({ name, arguments: args }, undefined, requestOptions)
    ), options);
  }

  /**
   * @param {string} uri
   * @param {{ signal?: AbortSignal }} [options]
   */
  async readResource(uri, options = {}) {
    return this.#request("read_resource", (client, requestOptions) => (
      client.readResource({ uri }, requestOptions)
    ), options);
  }

  /**
   * @param {string} query
   * @param {{ signal?: AbortSignal }} [options]
   */
  async search(query, options = {}) {
    const q = query.trim().toLowerCase();
    const [tools, resources] = /** @type {[unknown[], unknown[]]} */ (await Promise.all([
      this.toolsCache ? Promise.resolve(this.toolsCache) : this.listTools(options),
      this.resourcesCache ? Promise.resolve(this.resourcesCache) : this.listResources(options),
    ]));
    return {
      server: this.server.name,
      tools: tools.filter((tool) => !q || searchableToolText(tool).includes(q)),
      resources: resources.filter((resource) => !q || searchableResourceText(resource).includes(q)),
    };
  }

  /**
   * @param {{ tool?: string, resource?: string }} target
   * @param {{ signal?: AbortSignal }} [options]
   */
  async describe(target, options = {}) {
    if (target.tool) {
      const tools = /** @type {unknown[]} */ (this.toolsCache ?? await this.listTools(options));
      return tools.find((tool) => String(/** @type {{ name?: unknown }} */ (tool).name ?? "") === target.tool) ?? null;
    }
    if (target.resource) {
      const resources = /** @type {unknown[]} */ (this.resourcesCache ?? await this.listResources(options));
      return resources.find((resource) => String(/** @type {{ uri?: unknown }} */ (resource).uri ?? "") === target.resource) ?? null;
    }
    return {
      server: this.server.name,
      tools: this.toolsCache ?? await this.listTools(options),
      resources: this.resourcesCache ?? await this.listResources(options),
    };
  }

  /**
   * @param {string} operation
   * @param {(client: any, requestOptions: { signal?: AbortSignal, timeout: number }) => Promise<unknown>} fn
   * @param {{ signal?: AbortSignal }} options
   */
  async #request(operation, fn, options) {
    let attempt = 0;
    /** @type {unknown} */
    let lastError = null;
    while (attempt <= this.maxReconnectAttempts) {
      options.signal?.throwIfAborted();
      const started = Date.now();
      try {
        const client = await this.#ensureClient(options.signal);
        this.activeCalls++;
        try {
          const result = await fn(client, { signal: options.signal, timeout: this.callTimeoutMs });
          logMcpOperation(this.outputChannel, {
            serverName: this.server.name,
            operation,
            status: "ok",
            durationMs: Date.now() - started,
          });
          return result;
        } finally {
          this.activeCalls--;
          if (this.stale && this.activeCalls === 0) await this.#closeClient();
        }
      } catch (error) {
        lastError = error;
        await this.#closeClient();
        if (isAbortLike(error) || options.signal?.aborted || attempt >= this.maxReconnectAttempts) {
          logMcpOperation(this.outputChannel, {
            serverName: this.server.name,
            operation,
            status: "error",
            durationMs: Date.now() - started,
            error,
          });
          throw error;
        }
        attempt += 1;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** @param {AbortSignal | undefined} signal */
  async #ensureClient(signal) {
    if (this.closed) throw new Error(`MCP connection for ${this.server.name} is closed`);
    if (this.stale && this.activeCalls === 0) await this.#closeClient();
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect(signal).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** @param {AbortSignal | undefined} signal */
  async #connect(signal) {
    const client = new this.ClientCtor(
      { name: "nora", version: "0.1.0" },
      {
        listChanged: {
          tools: {
            autoRefresh: true,
            onChanged: (_error, tools) => {
              this.toolsCache = Array.isArray(tools) ? tools : null;
            },
          },
          resources: {
            autoRefresh: true,
            onChanged: (_error, resources) => {
              this.resourcesCache = Array.isArray(resources) ? resources : null;
            },
          },
        },
      },
    );
    const transport = this.#createTransport();
    await client.connect(transport, { timeout: this.callTimeoutMs, signal });
    this.client = client;
    this.transport = transport;
    this.stale = false;
    return client;
  }

  #createTransport() {
    if (this.server.type === "stdio") {
      return new this.StdioClientTransportCtor({
        command: this.server.command,
        args: this.server.args,
        cwd: this.server.cwd,
        env: this.server.env,
        stderr: "pipe",
      });
    }
    return new this.StreamableHTTPClientTransportCtor(new URL(this.server.url), {
      requestInit: { headers: this.server.headers },
      reconnectionOptions: {
        initialReconnectionDelay: 250,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: this.maxReconnectAttempts,
      },
    });
  }

  async #closeClient() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.toolsCache = null;
    this.resourcesCache = null;
    await Promise.all([
      Promise.resolve(client?.close?.()).catch(() => {}),
      Promise.resolve(transport?.close?.()).catch(() => {}),
    ]);
  }
}

/** @param {unknown} tool */
function searchableToolText(tool) {
  const entry = /** @type {{ name?: unknown, title?: unknown, description?: unknown }} */ (tool);
  return [entry.name, entry.title, entry.description].map((value) => String(value ?? "").toLowerCase()).join("\n");
}

/** @param {unknown} resource */
function searchableResourceText(resource) {
  const entry = /** @type {{ name?: unknown, uri?: unknown, title?: unknown, description?: unknown, mimeType?: unknown }} */ (resource);
  return [entry.name, entry.uri, entry.title, entry.description, entry.mimeType].map((value) => String(value ?? "").toLowerCase()).join("\n");
}

/** @param {unknown} error */
function isAbortLike(error) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "AbortSignal");
}
