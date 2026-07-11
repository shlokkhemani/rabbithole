import { getAssetContentType, MAX_ASSET_BYTES, validateAssetName } from "../core/assets.js";
import {
  base64ToBytes,
  binaryToBase64,
  createPortableProjection,
} from "../core/portable-projection.js";
import { migratePersistedHole } from "../core/schema.js";
import { normalizeBlockIds } from "../core/blocks.js";
import {
  extractSnapshotPayload,
  MAX_IMPORT_FILE_BYTES,
  parsePortableImportPayload,
} from "../core/portable-import.js";

export async function buildRabbitholeExport(store, holeId) {
  if (!store) throw new Error("Export needs a store.");
  const hole = await store.loadHole(holeId);
  if (!hole) throw new Error("That Rabbithole no longer exists.");
  const persisted = hole;
  const assets = {};
  for (const name of await store.listAssets(persisted.hole_id)) {
    validateAssetName(name);
    const blob = await store.getAsset(persisted.hole_id, name);
    if (blob) assets[name] = await binaryToBase64(blob);
  }
  return createPortableProjection(persisted, assets);
}

export async function downloadRabbitholeExport(store, holeId) {
  const payload = await buildRabbitholeExport(store, holeId);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = rabbitholeFilename(payload.hole?.title);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return payload;
}

export async function importRabbitholeFile(store, fileOrText) {
  if (!store) throw new Error("Import needs a store.");
  assertImportFileSize(fileOrText);
  const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const parsed = parseRabbitholeFile(text);
  return persistPortableImport(store, parsed);
}

export async function importSnapshotFile(store, fileOrText) {
  if (!store) throw new Error("Import needs a store.");
  assertImportFileSize(fileOrText);
  const html = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const parsed = parsePortableImportPayload(extractSnapshotPayload(html), "snapshot");
  return persistPortableImport(store, parsed);
}

async function persistPortableImport(store, parsed) {
  const migrated = migratePersistedHole(parsed.hole).hole;
  for (const node of migrated.nodes) node.markdown = normalizeBlockIds(node.markdown).markdown;
  removeCredentialShapedKeys(migrated);
  const assets = await decodeAssets(parsed.assets);
  let hole = migrated;
  let collision = false;
  if (await store.loadHole(hole.hole_id)) {
    collision = true;
    hole = { ...hole, hole_id: await freshHoleId(store) };
  }

  await store.saveHole(hole, { updatedAt: hole.updated_at || new Date().toISOString() });
  try {
    for (const asset of assets) {
      await store.putAsset(hole.hole_id, asset.name, asset.blob);
    }
  } catch (error) {
    try { await store.deleteHole(hole.hole_id); } catch {}
    throw error;
  }
  return {
    hole_id: hole.hole_id,
    title: hole.title,
    asset_count: assets.length,
    collision,
  };
}

export function parseRabbitholeFile(text) {
  return parsePortableImportPayload(text, "rabbithole");
}

export function rabbitholeFilename(title) {
  const slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "untitled"}.rabbithole`;
}

async function decodeAssets(rawAssets) {
  const out = [];
  for (const [name, encoded] of Object.entries(rawAssets || {})) {
    const safeName = validateAssetName(name);
    const bytes = base64ToBytes(encoded);
    const blob = new Blob([bytes], { type: getAssetContentType(safeName) });
    if (blob.size > MAX_ASSET_BYTES) throw new Error(`Import failed: asset ${safeName} exceeds 20 MB.`);
    out.push({ name: safeName, blob });
  }
  return out;
}

function assertImportFileSize(fileOrText) {
  if (typeof fileOrText !== "string" && Number(fileOrText?.size) > MAX_IMPORT_FILE_BYTES) {
    throw new Error("Import failed: file exceeds 64 MB.");
  }
}

function removeCredentialShapedKeys(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) removeCredentialShapedKeys(item);
    return;
  }
  delete value["rh-web-api-key"];
  delete value["rh-web-api-keys"];
  for (const child of Object.values(value)) removeCredentialShapedKeys(child);
}

async function freshHoleId(store) {
  for (let i = 0; i < 20; i += 1) {
    const id = newHoleId();
    if (!(await store.loadHole(id))) return id;
  }
  throw new Error("Import failed: could not generate a fresh hole id.");
}

function newHoleId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `hole-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
