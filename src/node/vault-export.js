import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { warn } from "./logger.js";
import { defaultFsStore, listAssets, resolveAsset } from "./fs-store.js";
import { DEFAULT_VAULT_FOLDER, holeToVaultPlan, mergeCanvas, slugify } from "../core/canvas-export.js";

/**
 * Applies the pure vault plan from core/canvas-export.js to a real Obsidian
 * vault, and keeps re-exports honest: the vault is a one-way projection of the
 * hole, but anything the human did in Obsidian (moved nodes, edited notes,
 * added their own cards) is preserved — edited notes are skipped and reported
 * as conflicts rather than overwritten.
 *
 * Sync bookkeeping lives next to the holes (~/.rabbithole/vault-sync.json):
 * per hole, the pinned slug, the node ids we created, and the hash of every
 * file as we last wrote it — the hash is how we tell "we wrote this" from
 * "the human changed this".
 */

function rabbitholeDir() {
  return process.env.RABBITHOLE_DIR || path.join(os.homedir(), ".rabbithole");
}

function configPath() {
  return path.join(rabbitholeDir(), "config.json");
}

function syncStatePath() {
  return path.join(rabbitholeDir(), "vault-sync.json");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readExportConfig() {
  const config = await readJson(configPath(), {});
  return config.obsidian_export || {};
}

export async function updateExportConfig(patch) {
  const config = await readJson(configPath(), {});
  config.obsidian_export = { ...config.obsidian_export, ...patch };
  await writeJsonAtomic(configPath(), config);
  return config.obsidian_export;
}

async function readSyncState() {
  return readJson(syncStatePath(), { holes: {} });
}

async function writeSyncState(state) {
  await writeJsonAtomic(syncStatePath(), state);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function fileHash(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function resolveVaultPath(explicit) {
  const config = await readExportConfig();
  const vaultPath = explicit || process.env.RABBITHOLE_VAULT || config.vault_path;
  if (!vaultPath) {
    throw new Error(
      "No Obsidian vault configured. Pass vault_path (it is remembered), or set RABBITHOLE_VAULT."
    );
  }
  const resolved = path.resolve(String(vaultPath));
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`Vault path does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`Vault path is not a directory: ${resolved}`);
  return resolved;
}

function canvasBelongsToHole(canvas, holeId) {
  return (
    Array.isArray(canvas?.nodes) && canvas.nodes.some((node) => node?.rabbithole?.hole_id === holeId)
  );
}

async function pickSlug({ hole, state, vaultPath, folder }) {
  const record = state.holes[hole.hole_id];
  if (record?.slug && record.vault_path === vaultPath && record.folder === folder) return record.slug;

  const base = slugify(hole.title, { fallback: String(hole.hole_id).slice(0, 12) });
  const taken = new Set(
    Object.values(state.holes)
      .filter((h) => h.vault_path === vaultPath && h.folder === folder)
      .map((h) => h.slug)
  );
  const candidates = [base, `${base}-${String(hole.hole_id).slice(0, 6)}`];
  for (const slug of candidates) {
    if (taken.has(slug)) continue;
    const canvasFile = path.join(vaultPath, ...folderParts(folder), slug, `${slug}.canvas`);
    const existing = await readJson(canvasFile, null);
    if (existing === null || canvasBelongsToHole(existing, hole.hole_id)) return slug;
  }
  return `${base}-${String(hole.hole_id).slice(0, 12)}`;
}

function folderParts(folder) {
  return String(folder || "")
    .split("/")
    .filter(Boolean);
}

function vaultFile(vaultPath, relPath) {
  const parts = String(relPath).split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) throw new Error(`Unsafe vault path: ${relPath}`);
  return path.join(vaultPath, ...parts);
}

async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Export (or re-sync) one hole into an Obsidian vault.
 *
 * @param {object} params
 * @param {string} params.holeId
 * @param {string} [params.vaultPath] absolute path to the vault; remembered as the default
 * @param {string} [params.folder] vault-relative folder (default "Rabbitholes")
 * @param {boolean} [params.continuous] also flip continuous sync on/off for future saves
 * @param {"caret"|"chat"|"none"} [params.roles] role-stamping mode (default "caret")
 */
export async function exportHoleToVault({ holeId, vaultPath, folder, continuous, roles } = {}) {
  if (!holeId) throw new Error("holeId is required");
  const hole = await defaultFsStore.loadHole(holeId);
  if (!hole) throw new Error(`Hole ${JSON.stringify(holeId)} not found`);

  const resolvedVault = await resolveVaultPath(vaultPath);
  const config = await readExportConfig();
  const resolvedFolder = folder ?? config.folder ?? DEFAULT_VAULT_FOLDER;
  const resolvedRoles = roles ?? config.roles ?? "caret";

  const state = await readSyncState();
  const slug = await pickSlug({ hole, state, vaultPath: resolvedVault, folder: resolvedFolder });
  const assetNames = await listAssets(holeId);
  const plan = holeToVaultPlan(hole, { folder: resolvedFolder, slug, assetNames, roles: resolvedRoles });

  const record = state.holes[hole.hole_id] || {};
  const noteHashes = { ...(record.note_hashes || {}) };
  const summary = {
    hole_id: hole.hole_id,
    title: hole.title,
    vault_path: resolvedVault,
    canvas_path: plan.canvasPath,
    notes_written: [],
    notes_unchanged: [],
    conflicts: [],
    assets_copied: [],
  };

  for (const note of plan.notes) {
    const target = vaultFile(resolvedVault, note.path);
    const newHash = sha256(note.content);
    const lastWritten = noteHashes[note.nodeId] || null;
    const onDisk = await fileHash(target);

    if (onDisk === newHash) {
      noteHashes[note.nodeId] = newHash;
      summary.notes_unchanged.push(note.path);
      continue;
    }
    if (onDisk !== null && lastWritten !== null && onDisk !== lastWritten) {
      // The human edited this note since we last wrote it. Their words win.
      summary.conflicts.push(note.path);
      continue;
    }
    if (onDisk !== null && lastWritten === null) {
      // A file we never wrote already lives at this path — do not clobber it.
      summary.conflicts.push(note.path);
      continue;
    }
    await writeFileAtomic(target, note.content);
    noteHashes[note.nodeId] = newHash;
    summary.notes_written.push(note.path);
  }

  for (const asset of plan.assets) {
    const source = await resolveAsset(holeId, asset.name);
    if (!source) continue;
    const target = vaultFile(resolvedVault, asset.path);
    const [sourceHash, targetHash] = await Promise.all([fileHash(source), fileHash(target)]);
    if (sourceHash === targetHash) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    summary.assets_copied.push(asset.path);
  }

  const canvasFile = vaultFile(resolvedVault, plan.canvasPath);
  let existingCanvas = null;
  try {
    const raw = await fs.readFile(canvasFile, "utf-8");
    existingCanvas = JSON.parse(raw);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw new Error(`Refusing to overwrite unreadable canvas ${plan.canvasPath}: ${err.message}`);
    }
  }
  const mergedCanvas = mergeCanvas(plan.canvas, existingCanvas, record.created_node_ids || []);
  const canvasContent = JSON.stringify(mergedCanvas, null, "\t") + "\n";
  if (existingCanvas === null || JSON.stringify(existingCanvas) !== JSON.stringify(mergedCanvas)) {
    await writeFileAtomic(canvasFile, canvasContent);
    summary.canvas_written = true;
  } else {
    summary.canvas_written = false;
  }

  state.holes[hole.hole_id] = {
    vault_path: resolvedVault,
    folder: resolvedFolder,
    slug,
    canvas_path: plan.canvasPath,
    created_node_ids: plan.canvas.nodes.map((n) => n.id),
    note_hashes: noteHashes,
    last_synced_at: new Date().toISOString(),
  };
  await writeSyncState(state);

  const configPatch = {};
  if (vaultPath) configPatch.vault_path = resolvedVault;
  if (folder) configPatch.folder = resolvedFolder;
  if (roles) configPatch.roles = resolvedRoles;
  if (typeof continuous === "boolean") configPatch.continuous = continuous;
  if (Object.keys(configPatch).length) await updateExportConfig(configPatch);

  return summary;
}

// ---- continuous sync -------------------------------------------------------

const AUTO_SYNC_DEBOUNCE_MS = 2000;
const autoSyncTimers = new Map();
const autoSyncWarned = new Set();

/**
 * Fire-and-forget hook for the session save path. Debounced per hole; never
 * throws — a broken vault must not take down the session.
 */
export function maybeAutoSyncHole(holeId) {
  if (!holeId) return;
  const existing = autoSyncTimers.get(holeId);
  if (existing) clearTimeout(existing);
  autoSyncTimers.set(
    holeId,
    setTimeout(() => {
      autoSyncTimers.delete(holeId);
      autoSyncHole(holeId).catch(() => {});
    }, AUTO_SYNC_DEBOUNCE_MS)
  );
}

async function autoSyncHole(holeId) {
  let config;
  try {
    config = await readExportConfig();
  } catch {
    return;
  }
  if (!config.continuous || !config.vault_path) return;
  try {
    const summary = await exportHoleToVault({ holeId });
    if (summary.conflicts.length && !autoSyncWarned.has(holeId)) {
      autoSyncWarned.add(holeId);
      warn(
        `Obsidian sync: ${summary.conflicts.length} note(s) for hole ${holeId} were edited in the vault and are no longer overwritten: ${summary.conflicts.join(", ")}`
      );
    }
  } catch (err) {
    if (!autoSyncWarned.has(holeId)) {
      autoSyncWarned.add(holeId);
      warn(`Obsidian sync failed for hole ${holeId}: ${err.message}`);
    }
  }
}
