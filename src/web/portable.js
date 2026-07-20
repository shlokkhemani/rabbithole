import { getAssetContentType, maxAssetBytes, validateAssetName } from "../core/assets.js";
import {
  base64ToBytes,
  binaryToBase64,
  createPortableProjection,
} from "../core/portable-projection.js";
import { parsePersistedHole } from "../core/schema.js";
import { normalizeBlockIds } from "../core/blocks.js";
import { slugifyTitle } from "../core/utils.js";
import { createWhimsicalHoleId } from "./hole-id.js";
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

export async function importRabbitholeFile(store, fileOrText, options = {}) {
  if (!store) throw new Error("Import needs a store.");
  assertImportFileSize(fileOrText);
  const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const parsed = parseRabbitholeFile(text);
  return persistPortableImport(store, parsed, options);
}

export async function importSnapshotFile(store, fileOrText, options = {}) {
  if (!store) throw new Error("Import needs a store.");
  assertImportFileSize(fileOrText);
  const html = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const parsed = parsePortableImportPayload(extractSnapshotPayload(html), "snapshot");
  return persistPortableImport(store, parsed, options);
}

async function persistPortableImport(store, parsed, { mintHoleId = null } = {}) {
  const imported = parsePersistedHole(parsed.hole);
  for (const node of imported.nodes) node.markdown = normalizeBlockIds(node.markdown).markdown;
  removeCredentialShapedKeys(imported);
  const assets = await decodeAssets(parsed.assets);
  let hole = imported;
  let collision = false;
  if (mintHoleId) {
    hole = { ...hole, hole_id: await freshHoleId(store, mintHoleId) };
  } else if (await store.loadHole(hole.hole_id)) {
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
  return `${slugifyTitle(title, { fallback: "untitled" })}.rabbithole`;
}

async function decodeAssets(rawAssets) {
  const out = [];
  for (const [name, encoded] of Object.entries(rawAssets || {})) {
    const safeName = validateAssetName(name);
    const bytes = base64ToBytes(encoded);
    const blob = new Blob([bytes], { type: getAssetContentType(safeName) });
    const limit = maxAssetBytes(safeName);
    if (blob.size > limit) throw new Error(`Import failed: asset ${safeName} exceeds ${Math.round(limit / 1024 / 1024)} MB.`);
    out.push({ name: safeName, blob });
  }
  return out;
}

function assertImportFileSize(fileOrText) {
  if (typeof fileOrText !== "string" && Number(fileOrText?.size) > MAX_IMPORT_FILE_BYTES) {
    throw new Error("Import failed: file exceeds 160 MB.");
  }
}

function removeCredentialShapedKeys(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) removeCredentialShapedKeys(item);
    return;
  }
  delete value["rh-web-api-keys"];
  for (const child of Object.values(value)) removeCredentialShapedKeys(child);
}

async function freshHoleId(store, mintHoleId = newHoleId) {
  for (let i = 0; i < 20; i += 1) {
    const id = mintHoleId();
    if (!(await store.loadHole(id))) return id;
  }
  throw new Error("Import failed: could not generate a fresh hole id.");
}

function newHoleId() {
  return createWhimsicalHoleId();
}
