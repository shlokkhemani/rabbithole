import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { warn } from "./logger.js";
import { backfillLegacyHoleBaseUrls, normalizeStoredBaseUrlFields } from "./base-url.js";
import {
  ALLOWED_ASSET_EXTENSIONS,
  MAX_ASSET_BYTES,
  MAX_ASSETS_PER_CALL,
  getAssetContentType,
  validateAssetName,
} from "./assets.js";

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
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`Invalid hole id: ${JSON.stringify(holeId)}`);
  }
  return id;
}

function holePath(holeId) {
  return path.join(holesDir(), `${assertSafeHoleId(holeId)}.json`);
}

function assetDir(holeId) {
  return path.join(holesDir(), "assets", assertSafeHoleId(holeId));
}

async function ensureAssetDir(holeId) {
  const dir = assetDir(holeId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
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

export async function addAsset(holeId, { name, file_path: filePath }) {
  const [entry] = await validateAssetEntries([{ name, file_path: filePath }]);
  const dir = await ensureAssetDir(holeId);
  const dest = path.join(dir, entry.name);
  if (path.resolve(entry.file_path) !== path.resolve(dest)) {
    await fs.copyFile(entry.file_path, dest);
  }
  return { name: entry.name, path: dest };
}

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

export async function deleteHoleAssets(holeId) {
  await fs.rm(assetDir(holeId), { recursive: true, force: true });
}

export { ALLOWED_ASSET_EXTENSIONS, MAX_ASSET_BYTES, MAX_ASSETS_PER_CALL, getAssetContentType, validateAssetName };

/**
 * @param {{ hole_id, title, root_id, created_at, nodes: object[] }} hole
 */
export async function saveHole(hole) {
  await ensureDir();
  const persisted = {
    hole_id: hole.hole_id,
    title: hole.title,
    root_id: hole.root_id,
    created_at: hole.created_at,
    updated_at: new Date().toISOString(),
    // Where the human last was (mode, node, scroll, canvas transform) — restored
    // on reopen so a resume lands exactly where they left off.
    view_state: hole.view_state ?? null,
    nodes: hole.nodes.map((node) => {
      const base = normalizeStoredBaseUrlFields(node);
      return {
        id: node.id,
        parent_id: node.parent_id ?? null,
        title: node.title ?? "",
        markdown: node.markdown ?? "",
        base_url: base.base_url,
        base_url_source: base.base_url_source,
        origin: node.origin ?? null,
        position: node.position ?? { x: 0, y: 0 },
        size: node.size ?? null,
        font_scale: node.font_scale ?? 1,
        collapsed: !!node.collapsed,
        status: node.status === "pending" ? "pending" : "answered",
        // Whether the human has opened this answer — unread answers get a dot and
        // feed the "since you left" count on the next open.
        read: !!node.read,
        created_at: node.created_at ?? null,
      };
    }),
  };
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
  const raw = await fs.readFile(holePath(holeId), "utf-8");
  const hole = JSON.parse(raw);
  const changed = backfillLegacyHoleBaseUrls(hole);
  if (changed) {
    await fs.writeFile(holePath(holeId), JSON.stringify(hole, null, 2), "utf-8");
  }
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
