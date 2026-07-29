import { createHash } from "node:crypto";
import { NoraMcpConnection } from "./connection.js";

/**
 * @typedef {import("./variables.js").ResolvedNoraMcpServer} ResolvedNoraMcpServer
 */

export class McpSupervisor {
  /**
   * @param {{
   *   connectionFactory?: (server: ResolvedNoraMcpServer) => NoraMcpConnection,
   *   outputChannel?: unknown,
   *   callTimeoutMs?: number,
   *   maxReconnectAttempts?: number
   * }} [options]
   */
  constructor(options = {}) {
    this.outputChannel = options.outputChannel;
    this.callTimeoutMs = options.callTimeoutMs;
    this.maxReconnectAttempts = options.maxReconnectAttempts;
    this.connectionFactory = options.connectionFactory ?? ((server) => new NoraMcpConnection({
      server,
      outputChannel: this.outputChannel,
      callTimeoutMs: this.callTimeoutMs,
      maxReconnectAttempts: this.maxReconnectAttempts,
    }));
    /** @type {Map<string, { workspaceFolderPath: string | null, serverName: string, connection: NoraMcpConnection, refCount: number }>} */
    this.entries = new Map();
  }

  /**
   * @param {string | null | undefined} workspaceFolderPath
   * @param {ResolvedNoraMcpServer} server
   */
  acquire(workspaceFolderPath, server) {
    const key = mcpConnectionKey(workspaceFolderPath ?? null, server);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        workspaceFolderPath: workspaceFolderPath ?? null,
        serverName: server.name,
        connection: this.connectionFactory(server),
        refCount: 0,
      };
      this.entries.set(key, entry);
    }
    entry.refCount += 1;
    let released = false;
    return {
      connection: entry.connection,
      release: async () => {
        if (released) return;
        released = true;
        entry.refCount -= 1;
        if (entry.refCount <= 0) {
          this.entries.delete(key);
          await entry.connection.close();
        }
      },
    };
  }

  /** @param {string | null | undefined} workspaceFolderPath */
  markWorkspaceChanged(workspaceFolderPath) {
    for (const entry of this.entries.values()) {
      if ((workspaceFolderPath ?? null) === entry.workspaceFolderPath) entry.connection.markStale();
    }
  }

  async dispose() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.connection.close()));
  }
}

/**
 * @param {string | null} workspaceFolderPath
 * @param {ResolvedNoraMcpServer} server
 */
export function mcpConnectionKey(workspaceFolderPath, server) {
  return createHash("sha256").update(JSON.stringify({
    workspaceFolderPath,
    serverName: server.name,
    fingerprint: server.fingerprint,
  })).digest("hex");
}
