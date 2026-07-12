import { validatePortableProjection } from "./portable-projection.js";

export const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_NODES = 5000;
export const MAX_IMPORT_ASSETS = 200;
const MAX_IMPORT_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_AGGREGATE_ASSET_BYTES = 100 * 1024 * 1024;

export const SNAPSHOT_PAYLOAD_OPEN = '<script type="application/vnd.rabbithole+json" id="rabbithole-portable">';
export const SNAPSHOT_PAYLOAD_CLOSE = "</script>";

/** @param {string} html */
export function extractSnapshotPayload(html) {
  const source = String(html || "");
  const first = source.indexOf(SNAPSHOT_PAYLOAD_OPEN);
  if (first < 0) {
    if (source.includes("rabbithole-portable") || source.includes("application/vnd.rabbithole+json")) {
      throw new Error("Snapshot import failed: the portable payload element is malformed.");
    }
    throw new Error("Snapshot import failed: portable payload is missing.");
  }
  if (source.indexOf(SNAPSHOT_PAYLOAD_OPEN, first + SNAPSHOT_PAYLOAD_OPEN.length) >= 0) {
    throw new Error("Snapshot import failed: duplicate portable payload elements.");
  }
  const payloadStart = first + SNAPSHOT_PAYLOAD_OPEN.length;
  const close = source.indexOf(SNAPSHOT_PAYLOAD_CLOSE, payloadStart);
  if (close < 0) throw new Error("Snapshot import failed: the portable payload element is malformed.");
  return source.slice(payloadStart, close);
}

/** @param {string} text @param {"rabbithole" | "snapshot"} kind */
export function parsePortableImportPayload(text, kind = "rabbithole") {
  const source = String(text || "");
  assertPayloadTextSize(source);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    const label = kind === "snapshot" ? "snapshot payload" : ".rabbithole";
    throw new Error(`Import failed: ${label} must be valid JSON.`);
  }
  preflightPortableImportCaps(parsed);
  const projection = validatePortableProjection(parsed);
  return projection;
}

/** @param {string} text */
function assertPayloadTextSize(text) {
  if (text.length > MAX_IMPORT_PAYLOAD_BYTES || new TextEncoder().encode(text).byteLength > MAX_IMPORT_PAYLOAD_BYTES) {
    throw new Error("Import failed: portable payload exceeds 32 MB.");
  }
}

/** @param {import("./contracts/artifact.js").PortableArtifact} projection */
export function validatePortableImportCaps(projection) {
  return preflightPortableImportCaps(projection);
}

/** @param {unknown} raw */
function preflightPortableImportCaps(raw) {
  const projection = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, any>} */ (raw)
    : {};
  if (Array.isArray(projection.hole?.nodes) && projection.hole.nodes.length > MAX_IMPORT_NODES) {
    throw new Error("Import failed: portable payload exceeds 5,000 nodes.");
  }
  const assets = projection.assets && typeof projection.assets === "object" && !Array.isArray(projection.assets)
    ? Object.entries(projection.assets)
    : [];
  if (assets.length > MAX_IMPORT_ASSETS) throw new Error("Import failed: portable payload exceeds 200 assets.");
  let aggregate = 0;
  for (const [name, encoded] of assets) {
    if (typeof encoded !== "string") continue;
    const decodedBytes = decodedBase64Size(encoded);
    if (decodedBytes > MAX_IMPORT_ASSET_BYTES) throw new Error(`Import failed: asset ${name} exceeds 20 MB.`);
    aggregate += decodedBytes;
    if (aggregate > MAX_IMPORT_AGGREGATE_ASSET_BYTES) {
      throw new Error("Import failed: decoded assets exceed 100 MB aggregate.");
    }
  }
  return projection;
}

/** @param {string} encoded */
function decodedBase64Size(encoded) {
  const compact = encoded.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return (compact.length / 4) * 3 - padding;
}
