import { MAX_ASSET_BYTES, validateAssetName } from "../core/assets.js";
import { migratePersistedHole, toPersistedHole } from "../core/schema.js";

export const RABBITHOLE_FILE_FORMAT = "rabbithole";
export const RABBITHOLE_FILE_FORMAT_VERSION = 1;
export const RABBITHOLE_SESSION_JSON_FORMAT = "rabbithole-session-json";
export const RABBITHOLE_SESSION_JSON_FORMAT_VERSION = 1;

export async function buildRabbitholeExport(store, holeId) {
  if (!store) throw new Error("Export needs a store.");
  const hole = await store.loadHole(holeId);
  if (!hole) throw new Error("That Rabbithole no longer exists.");
  const persisted = toPersistedHole(hole, { updatedAt: hole.updated_at || new Date().toISOString() });
  const assets = {};
  for (const name of await store.listAssets(persisted.hole_id)) {
    validateAssetName(name);
    const blob = await store.getAsset(persisted.hole_id, name);
    if (blob) assets[name] = await blobToBase64(blob);
  }
  return {
    format: RABBITHOLE_FILE_FORMAT,
    format_version: RABBITHOLE_FILE_FORMAT_VERSION,
    hole: persisted,
    assets,
  };
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
  const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const parsed = parseRabbitholeFile(text);
  const migrated = migratePersistedHole(parsed.hole).hole;
  const assets = await decodeAssets(parsed.assets);
  let hole = toPersistedHole(migrated, { updatedAt: migrated.updated_at || new Date().toISOString() });
  let collision = false;
  if (await store.loadHole(hole.hole_id)) {
    collision = true;
    hole = { ...hole, hole_id: await freshHoleId(store) };
  }

  await store.saveHole(hole, { updatedAt: hole.updated_at || new Date().toISOString() });
  for (const asset of assets) {
    await store.putAsset(hole.hole_id, asset.name, asset.blob);
  }
  return {
    hole_id: hole.hole_id,
    title: hole.title,
    asset_count: assets.length,
    collision,
  };
}

export async function importSessionJsonFile(store, fileOrText) {
  if (!store) throw new Error("Import needs a store.");
  const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const parsed = parseSessionJsonFile(text);
  const session = parsed.session;
  let hole = toPersistedHole({
    hole_id: session.hole_id || freshHoleIdFallback(),
    title: session.title || "Imported Rabbithole",
    root_id: session.root_id,
    view_state: session.view_state || null,
    nodes: session.nodes || [],
  });
  let collision = false;
  if (await store.loadHole(hole.hole_id)) {
    collision = true;
    hole = { ...hole, hole_id: await freshHoleId(store) };
  }

  const assets = await decodeSessionAssets(session.asset_data);
  await store.saveHole(hole, { updatedAt: new Date().toISOString() });
  for (const asset of assets) {
    await store.putAsset(hole.hole_id, asset.name, asset.blob);
  }
  return {
    hole_id: hole.hole_id,
    title: hole.title,
    asset_count: assets.length,
    collision,
  };
}

export function parseRabbitholeFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new Error("Import failed: .rabbithole must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Import failed: .rabbithole must be a JSON object.");
  }
  if (parsed.format !== RABBITHOLE_FILE_FORMAT || parsed.format_version !== RABBITHOLE_FILE_FORMAT_VERSION) {
    throw new Error("Import failed: unsupported Rabbithole file format.");
  }
  if (!parsed.hole || typeof parsed.hole !== "object" || Array.isArray(parsed.hole)) {
    throw new Error("Import failed: file is missing a hole object.");
  }
  if (!parsed.assets || typeof parsed.assets !== "object" || Array.isArray(parsed.assets)) {
    throw new Error("Import failed: file assets must be an object.");
  }
  return parsed;
}

export function parseSessionJsonFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new Error("Import failed: session JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Import failed: session JSON must be a JSON object.");
  }
  if (parsed.format !== RABBITHOLE_SESSION_JSON_FORMAT || parsed.format_version !== RABBITHOLE_SESSION_JSON_FORMAT_VERSION) {
    throw new Error("Import failed: unsupported Rabbithole session JSON format.");
  }
  if (!parsed.session || typeof parsed.session !== "object" || Array.isArray(parsed.session)) {
    throw new Error("Import failed: session JSON is missing a session object.");
  }
  if (!Array.isArray(parsed.session.nodes)) {
    throw new Error("Import failed: session JSON is missing session nodes.");
  }
  return parsed;
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
    if (typeof encoded !== "string") throw new Error(`Import failed: asset ${safeName} must be base64.`);
    const blob = base64ToBlob(encoded);
    if (blob.size > MAX_ASSET_BYTES) throw new Error(`Import failed: asset ${safeName} exceeds 20 MB.`);
    out.push({ name: safeName, blob });
  }
  return out;
}

async function freshHoleId(store) {
  for (let i = 0; i < 20; i += 1) {
    const id = newHoleId();
    if (!(await store.loadHole(id))) return id;
  }
  throw new Error("Import failed: could not generate a fresh hole id.");
}

function freshHoleIdFallback() {
  return newHoleId();
}

function newHoleId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `hole-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function base64ToBlob(value) {
  const base64 = String(value || "").replace(/\s+/g, "");
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Import failed: asset data is not valid base64.");
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes]);
}

async function decodeSessionAssets(assetData) {
  const out = [];
  if (!assetData || typeof assetData !== "object" || Array.isArray(assetData)) return out;
  for (const [name, value] of Object.entries(assetData)) {
    const safeName = validateAssetName(name);
    if (typeof value !== "string") throw new Error(`Import failed: asset ${safeName} must be a data URL.`);
    const blob = dataUrlToBlob(value);
    if (blob.size > MAX_ASSET_BYTES) throw new Error(`Import failed: asset ${safeName} exceeds 20 MB.`);
    out.push({ name: safeName, blob });
  }
  return out;
}

function dataUrlToBlob(value) {
  const match = /^data:([^,;]*)(;base64)?,(.*)$/s.exec(String(value || ""));
  if (!match) throw new Error("Import failed: asset data is not a data URL.");
  const type = match[1] || "application/octet-stream";
  if (match[2]) return base64ToBlob(match[3]);
  return new Blob([decodeURIComponent(match[3])], { type });
}

async function blobToBase64(blob) {
  if (typeof FileReader === "function") {
    const dataUrl = await blobToDataUrl(blob);
    const comma = dataUrl.indexOf(",");
    return comma === -1 ? "" : dataUrl.slice(comma + 1);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(out);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "data:,"));
    reader.onerror = () => reject(reader.error || new Error("Failed to read asset."));
    reader.readAsDataURL(blob);
  });
}
