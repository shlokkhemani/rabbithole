import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { warn } from "./logger.js";
import { migratePersistedHole, toPersistedHole } from "../core/schema.js";
import {
  ALLOWED_ASSET_EXTENSIONS,
  MAX_ASSET_BYTES,
  MAX_ASSETS_PER_CALL,
  getAssetContentType,
  validateAssetName,
} from "../core/assets.js";

/**
 * Holes are persisted one JSON file per hole under ~/.rabbithole/.
 * Answered nodes are stored in full; pending nodes are stored as durable asks
 * (question + anchor, empty markdown) so a resume can re-queue them for the
 * agent. Rendered HTML is recomputed on load.
 */

function holesDir() {
  return process.env.RABBITHOLE_DIR || path.join(os.homedir(), ".rabbithole");
}

async function ensureDir() {
  const dir = holesDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * hole_id reaches storage from the agent (open_rabbithole) and from persisted
 * files, so it must never be allowed to escape the storage dir via "../" or an
 * absolute path. Allow only the id shapes we actually mint (UUIDs / slugs).
 */
function assertSafeHoleId(holeId) {
  const id = String(holeId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid hole id: ${JSON.stringify(holeId)}`);
  }
  return id;
}

function holePath(holeId) {
  return path.join(holesDir(), `${assertSafeHoleId(holeId)}.json`);
}

function assetsDir() {
  return path.join(holesDir(), "assets");
}

function assetDir(holeId) {
  return path.join(assetsDir(), assertSafeHoleId(holeId));
}

async function ensureAssetDir(holeId) {
  const dir = assetDir(holeId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const STAGING_DIR_NAME = ".staging";
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

function assertSafeIngestId(ingestId) {
  const id = String(ingestId ?? "");
  if (!/^ingest-[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid ingest id: ${JSON.stringify(ingestId)}`);
  }
  return id;
}

function stagingRootDir() {
  return path.join(assetsDir(), STAGING_DIR_NAME);
}

function stagedAssetDir(ingestId) {
  return path.join(stagingRootDir(), assertSafeIngestId(ingestId));
}

function newIngestId() {
  const stamp = Date.now().toString(36);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
  return `ingest-${stamp}-${suffix}`;
}

function normalizeAssetEntries(assets) {
  if (assets == null) return [];
  if (!Array.isArray(assets)) throw new Error("assets must be an array of { name, file_path } entries");
  if (assets.length > MAX_ASSETS_PER_CALL) {
    throw new Error(`assets must contain at most ${MAX_ASSETS_PER_CALL} entries`);
  }

  return assets.map((entry, index) => {
    const label = `assets[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} must be an object with name and file_path`);
    }
    const name = validateAssetName(entry.name, `${label}.name`);
    const filePath = String(entry.file_path ?? "");
    if (!filePath) throw new Error(`${label}.file_path is required`);
    return { name, file_path: filePath };
  });
}

function assertAssetFileStat(stat, filePath, label) {
  if (!stat.isFile()) throw new Error(`${label}.file_path must be a file: ${filePath}`);
  if (stat.size > MAX_ASSET_BYTES) {
    throw new Error(`${label}.file_path exceeds 20 MB: ${filePath}`);
  }
}

export function validateAssetEntriesSync(assets) {
  return normalizeAssetEntries(assets).map((entry, index) => {
    const label = `assets[${index}]`;
    let stat;
    try {
      stat = fsSync.statSync(entry.file_path);
    } catch {
      throw new Error(`${label}.file_path does not exist: ${entry.file_path}`);
    }
    assertAssetFileStat(stat, entry.file_path, label);
    return entry;
  });
}

async function validateAssetEntries(assets) {
  const entries = normalizeAssetEntries(assets);
  return Promise.all(
    entries.map(async (entry, index) => {
      const label = `assets[${index}]`;
      let stat;
      try {
        stat = await fs.stat(entry.file_path);
      } catch {
        throw new Error(`${label}.file_path does not exist: ${entry.file_path}`);
      }
      assertAssetFileStat(stat, entry.file_path, label);
      return entry;
    })
  );
}

async function bytesToBuffer(bytes, label = "asset bytes") {
  let buffer;
  if (bytes instanceof Uint8Array) {
    buffer = Buffer.from(bytes);
  } else if (bytes instanceof ArrayBuffer) {
    buffer = Buffer.from(bytes);
  } else if (typeof Blob !== "undefined" && bytes instanceof Blob) {
    buffer = Buffer.from(await bytes.arrayBuffer());
  } else {
    throw new Error(`${label} must be a Blob, ArrayBuffer, or Uint8Array`);
  }
  if (buffer.byteLength > MAX_ASSET_BYTES) throw new Error(`${label} exceeds 20 MB`);
  return buffer;
}

export class FsStore {
  async listHoles() {
    return listHoles();
  }

  async loadHole(holeId) {
    let raw;
    try {
      raw = await fs.readFile(holePath(holeId), "utf-8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    const migrated = migratePersistedHole(JSON.parse(raw));
    if (migrated.changed) {
      await fs.writeFile(holePath(holeId), JSON.stringify(migrated.hole, null, 2), "utf-8");
    }
    return migrated.hole;
  }

  async saveHole(hole) {
    await saveHole(hole);
  }

  async deleteHole(holeId) {
    await fs.rm(holePath(holeId), { force: true });
    await deleteHoleAssets(holeId);
  }

  async listAssets(holeId) {
    return listAssets(holeId);
  }

  async getAsset(holeId, name) {
    const filePath = await resolveAsset(holeId, name);
    return filePath ? fs.readFile(filePath) : null;
  }

  async putAsset(holeId, name, bytes) {
    const safeName = validateAssetName(name);
    const buffer = await bytesToBuffer(bytes);
    const dir = await ensureAssetDir(holeId);
    await fs.writeFile(path.join(dir, safeName), buffer);
  }

  async deleteAsset(holeId, name) {
    await deleteAsset(holeId, name);
  }

  async createStaging() {
    const staged = await createStagedAssetDir();
    return { ingest_id: staged.ingest_id };
  }

  async putStagedAsset(ingestId, name, bytes) {
    const safeName = validateAssetName(name);
    const buffer = await bytesToBuffer(bytes, "staged asset bytes");
    const dir = stagedAssetDir(ingestId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, safeName), buffer);
  }

  async adoptStagedAssets(holeId, ingestId) {
    const moved = await adoptStagedAssets(holeId, ingestId);
    return moved.map((asset) => asset.name);
  }

  async discardStaging(ingestId) {
    await fs.rm(stagedAssetDir(ingestId), { recursive: true, force: true });
  }
}

export const defaultFsStore = new FsStore();

export async function addAssetsToHole(holeId, assets) {
  const entries = await validateAssetEntries(assets);
  if (!entries.length) return [];
  const dir = await ensureAssetDir(holeId);
  const added = [];
  for (const entry of entries) {
    const dest = path.join(dir, entry.name);
    if (path.resolve(entry.file_path) !== path.resolve(dest)) {
      await fs.copyFile(entry.file_path, dest);
    }
    added.push({ name: entry.name, path: dest });
  }
  return added;
}

async function moveFile(source, dest) {
  try {
    await fs.rename(source, dest);
  } catch (err) {
    if (err?.code !== "EXDEV") throw err;
    await fs.copyFile(source, dest);
    await fs.rm(source, { force: true });
  }
}

async function cleanupStagedAssets({ olderThanMs = STAGING_TTL_MS } = {}) {
  let entries;
  try {
    entries = await fs.readdir(stagingRootDir(), { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(stagingRootDir(), entry.name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true });
    } catch {}
  }
}

export async function createStagedAssetDir() {
  await cleanupStagedAssets();
  await fs.mkdir(stagingRootDir(), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ingestId = newIngestId();
    const dir = stagedAssetDir(ingestId);
    try {
      await fs.mkdir(dir);
      return { ingest_id: ingestId, dir };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  throw new Error("Unable to allocate a staging directory for PDF assets");
}

export async function resolveStagedAssetDir(ingestId) {
  const dir = stagedAssetDir(ingestId);
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export async function adoptStagedAssets(holeId, ingestId) {
  const sourceDir = await resolveStagedAssetDir(ingestId);
  if (!sourceDir) {
    throw new Error(`Unknown ingest_id ${JSON.stringify(ingestId)}; run ingest_pdf again.`);
  }
  const destDir = await ensureAssetDir(holeId);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const moved = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = validateAssetName(entry.name, "staged asset name");
    const source = path.join(sourceDir, name);
    const dest = path.join(destDir, name);
    await moveFile(source, dest);
    moved.push({ name, path: dest });
  }
  await fs.rm(sourceDir, { recursive: true, force: true });
  return moved;
}

export async function listAssets(holeId) {
  let entries;
  try {
    entries = await fs.readdir(assetDir(holeId));
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      try {
        validateAssetName(name);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

export async function resolveAsset(holeId, name) {
  const safeName = validateAssetName(name);
  const filePath = path.join(assetDir(holeId), safeName);
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

export async function deleteAsset(holeId, name) {
  const safeName = validateAssetName(name);
  await fs.rm(path.join(assetDir(holeId), safeName), { force: true });
}

async function deleteHoleAssets(holeId) {
  await fs.rm(assetDir(holeId), { recursive: true, force: true });
}

export {
  ALLOWED_ASSET_EXTENSIONS,
  MAX_ASSET_BYTES,
  MAX_ASSETS_PER_CALL,
  getAssetContentType,
  validateAssetName,
  assertSafeHoleId,
  assetDir,
  ensureAssetDir,
};

/**
 * @param {{ hole_id, title, root_id, created_at, nodes: object[] }} hole
 */
export async function saveHole(hole) {
  await ensureDir();
  const persisted = toPersistedHole(hole);
  // Unique temp name per write so concurrent/overlapping saves of the same hole
  // never clobber each other's temp file mid-write; rename is atomic, last wins.
  const finalPath = holePath(hole.hole_id);
  const tmp = `${finalPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(persisted, null, 2), "utf-8");
    await fs.rename(tmp, finalPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return persisted;
}

export async function loadHole(holeId) {
  const hole = await defaultFsStore.loadHole(holeId);
  if (!hole) throw new Error(`Hole ${JSON.stringify(holeId)} not found`);
  return hole;
}

export async function listHoles() {
  let entries;
  try {
    entries = await fs.readdir(holesDir());
  } catch {
    return [];
  }

  const holes = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(holesDir(), name), "utf-8");
      const hole = JSON.parse(raw);
      holes.push({
        hole_id: hole.hole_id,
        title: hole.title,
        updated_at: hole.updated_at,
        node_count: Array.isArray(hole.nodes) ? hole.nodes.length : 0,
      });
    } catch (err) {
      warn(`Skipping unreadable hole ${name}: ${err.message}`);
    }
  }
  holes.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return holes;
}
