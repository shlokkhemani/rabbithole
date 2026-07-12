import { validateAssetName } from "./assets.js";
import { validatePersistedHole } from "./schema.js";

/** @typedef {import("./contracts/artifact.js").PersistedHole} PersistedHole */
/** @typedef {import("./contracts/artifact.js").PortableArtifact} PortableArtifact */

const RABBITHOLE_FILE_FORMAT = "rabbithole";
const RABBITHOLE_FILE_FORMAT_VERSION = 1;

/**
 * @param {PersistedHole} hole
 * @param {Record<string, string>} assets
 * @returns {PortableArtifact}
 */
export function createPortableProjection(hole, assets) {
  validatePersistedHole(hole);
  validatePortableAssets(assets);
  return {
    format: RABBITHOLE_FILE_FORMAT,
    format_version: RABBITHOLE_FILE_FORMAT_VERSION,
    hole,
    assets,
  };
}

/** @param {unknown} raw @returns {PortableArtifact} */
export function validatePortableProjection(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Import failed: .rabbithole must be a JSON object.");
  }
  const parsed = /** @type {Record<string, unknown>} */ (raw);
  if (parsed.format !== RABBITHOLE_FILE_FORMAT || parsed.format_version !== RABBITHOLE_FILE_FORMAT_VERSION) {
    throw new Error("Import failed: unsupported Rabbithole file format.");
  }
  if (!parsed.hole || typeof parsed.hole !== "object" || Array.isArray(parsed.hole)) {
    throw new Error("Import failed: file is missing a hole object.");
  }
  if (!parsed.assets || typeof parsed.assets !== "object" || Array.isArray(parsed.assets)) {
    throw new Error("Import failed: file assets must be an object.");
  }
  validatePortableAssets(parsed.assets);
  return /** @type {PortableArtifact} */ (/** @type {unknown} */ (parsed));
}

/** @param {unknown} assets */
function validatePortableAssets(assets) {
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    throw new Error("Import failed: file assets must be an object.");
  }
  for (const [name, encoded] of Object.entries(assets)) {
    const safeName = validateAssetName(name);
    if (typeof encoded !== "string") throw new Error(`Import failed: asset ${safeName} must be base64.`);
    validateBase64(encoded);
  }
}

/** @param {string} value */
function validateBase64(value) {
  const base64 = value.replace(/\s+/g, "");
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Import failed: asset data is not valid base64.");
  }
  return base64;
}

/**
 * @param {Uint8Array | { arrayBuffer: () => Promise<ArrayBuffer> }} binary
 * @returns {Promise<string>}
 */
export async function binaryToBase64(binary) {
  const bytes = binary instanceof Uint8Array
    ? binary
    : new Uint8Array(await binary.arrayBuffer());
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/** @param {string} value @returns {Uint8Array} */
export function base64ToBytes(value) {
  const bin = atob(validateBase64(String(value || "")));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
