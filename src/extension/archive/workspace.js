import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { normalizeRunId } from "../../core/document-schema.js";
import { ASSET_BYTES_LIMIT, NORA_TEMP_PREFIX, RUN_JSONL_BYTES_LIMIT } from "./constants.js";
import { sha256Bytes } from "./hash.js";
import { canonicalJsonBytes } from "./manifest.js";

export class NoraArchiveWorkspace {
  /** @param {string} rootDir @param {string} tempDir */
  constructor(rootDir, tempDir) {
    this.rootDir = rootDir;
    this.tempDir = tempDir;
    this.assetsDir = path.join(tempDir, "assets");
    this.runsDir = path.join(tempDir, "runs");
    /** @type {Map<string, { sha256: string, bytes: number, filePath: string, mediaType: string }>} */
    this.assets = new Map();
    /** @type {Map<string, { runId: string, filePath: string, bytes: number }>} */
    this.runs = new Map();
  }

  /** @param {{ rootDir?: string }} [options] */
  static async create(options = {}) {
    const rootDir = options.rootDir ?? os.tmpdir();
    await fs.mkdir(rootDir, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(rootDir, NORA_TEMP_PREFIX));
    const workspace = new NoraArchiveWorkspace(rootDir, tempDir);
    await fs.mkdir(workspace.assetsDir, { recursive: true });
    await fs.mkdir(workspace.runsDir, { recursive: true });
    return workspace;
  }

  /** @param {Buffer | Uint8Array | string} bytes @param {{ mediaType?: string }} [options] */
  async stageAssetBytes(bytes, options = {}) {
    const buffer = Buffer.from(bytes);
    if (buffer.byteLength > ASSET_BYTES_LIMIT) throw new Error(`Asset exceeds ${ASSET_BYTES_LIMIT} bytes`);
    const sha256 = sha256Bytes(buffer);
    const existing = this.assets.get(sha256);
    if (existing) return existing;
    const filePath = path.join(this.assetsDir, sha256);
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    const entry = { sha256, bytes: buffer.byteLength, filePath, mediaType: options.mediaType ?? "application/octet-stream" };
    this.assets.set(sha256, entry);
    return entry;
  }

  /** @param {string} sourcePath @param {{ mediaType?: string }} [options] */
  async stageAssetFile(sourcePath, options = {}) {
    const hash = createHash("sha256");
    let bytes = 0;
    const tempPath = path.join(this.assetsDir, `incoming-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const input = createReadStream(sourcePath);
    /** @param {Buffer | Uint8Array | string} chunk */
    input.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > ASSET_BYTES_LIMIT) input.destroy(new Error(`Asset exceeds ${ASSET_BYTES_LIMIT} bytes`));
      hash.update(buffer);
    });
    await pipeline(input, createWriteStream(tempPath, { mode: 0o600 }));
    const sha256 = hash.digest("hex");
    const existing = this.assets.get(sha256);
    if (existing) {
      await fs.rm(tempPath, { force: true });
      return existing;
    }
    const filePath = path.join(this.assetsDir, sha256);
    await fs.rename(tempPath, filePath);
    const entry = { sha256, bytes, filePath, mediaType: options.mediaType ?? "application/octet-stream" };
    this.assets.set(sha256, entry);
    return entry;
  }

  /** @param {string} runId @param {Record<string, unknown>} record */
  async appendRunRecord(runId, record) {
    const safeRunId = normalizeRunId(runId, "runId");
    const filePath = path.join(this.runsDir, `${safeRunId}.jsonl`);
    const bytes = canonicalJsonBytes(record);
    const current = await fileSize(filePath);
    if (current + bytes.byteLength > RUN_JSONL_BYTES_LIMIT) throw new Error(`Run transcript ${safeRunId} exceeds ${RUN_JSONL_BYTES_LIMIT} bytes`);
    await fs.appendFile(filePath, bytes, { mode: 0o600 });
    const stat = await fs.stat(filePath);
    const entry = { runId: safeRunId, filePath, bytes: stat.size };
    this.runs.set(safeRunId, entry);
    return stat.size;
  }

  /** @param {string} runId @param {Buffer | Uint8Array | string} bytes */
  async stageRunBytes(runId, bytes) {
    const safeRunId = normalizeRunId(runId, "runId");
    const buffer = Buffer.from(bytes);
    if (buffer.byteLength > RUN_JSONL_BYTES_LIMIT) throw new Error(`Run transcript ${safeRunId} exceeds ${RUN_JSONL_BYTES_LIMIT} bytes`);
    const filePath = path.join(this.runsDir, `${safeRunId}.jsonl`);
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    const stat = await fs.stat(filePath);
    const entry = { runId: safeRunId, filePath, bytes: stat.size };
    this.runs.set(safeRunId, entry);
    return entry;
  }

  snapshotSources() {
    return {
      assets: [...this.assets.values()],
      runs: [...this.runs.values()],
    };
  }

  async dispose() {
    await fs.rm(this.tempDir, { recursive: true, force: true });
  }
}

/** @param {string} filePath */
async function fileSize(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (/** @type {{ code?: unknown }} */ (error)?.code === "ENOENT") return 0;
    throw error;
  }
}

/** @param {{ rootDir?: string }} [options] */
export function createNoraArchiveWorkspace(options = {}) {
  return NoraArchiveWorkspace.create(options);
}

/** @param {string} rootDir @param {{ maxAgeMs?: number, now?: number }} [options] */
export async function cleanupStaleNoraArchiveWorkspaces(rootDir, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(NORA_TEMP_PREFIX)) continue;
    const dirPath = path.join(rootDir, entry.name);
    const stat = await fs.stat(dirPath);
    if (now - stat.mtimeMs < maxAgeMs) continue;
    await fs.rm(dirPath, { recursive: true, force: true });
    removed.push(dirPath);
  }
  return removed;
}
