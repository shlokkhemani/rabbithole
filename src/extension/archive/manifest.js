import {
  ARCHIVE_UNCOMPRESSED_BYTES_LIMIT,
  ARCHIVE_ZIP_BYTES_LIMIT,
  ASSETS_PREFIX,
  DOCUMENT_PATH,
  HEX_SHA256_RE,
  MANIFEST_PATH,
  NORA_ARCHIVE_FORMAT,
  NORA_ARCHIVE_FORMAT_VERSION,
  RUNS_PREFIX,
} from "./constants.js";

/** @typedef {import("../../core/contracts/archive.js").NoraArchiveEntry} NoraArchiveEntry */
/** @typedef {import("../../core/contracts/archive.js").NoraArchiveManifest} NoraArchiveManifest */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} path */
function requireRecord(value, path) {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} path */
function requireString(value, path) {
  if (typeof value !== "string" || !value) throw new Error(`${path} must be a non-empty string`);
  return value;
}

/** @param {unknown} value @param {string} path */
function requireSize(value, path) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${path} must be a non-negative safe integer`);
  return Number(value);
}

/** @param {unknown} value @param {string} path */
function nullableTimestamp(value, path) {
  if (value == null) return null;
  if (typeof value !== "string" || !value) throw new Error(`${path} must be an ISO timestamp string or null`);
  return value;
}

/** @param {unknown} value @param {string} path */
function requireSha256(value, path) {
  const digest = requireString(value, path).toLowerCase();
  if (!HEX_SHA256_RE.test(digest)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return digest;
}

/** @param {unknown} value @returns {NoraArchiveManifest} */
export function parseManifest(value) {
  const raw = requireRecord(value, "manifest");
  if (raw.format !== NORA_ARCHIVE_FORMAT) throw new Error("manifest.format must be nora");
  if (Number(raw.formatVersion) > NORA_ARCHIVE_FORMAT_VERSION) {
    throw new Error("This Nora archive was saved by a newer version of Nora -- update to open it.");
  }
  if (raw.formatVersion !== NORA_ARCHIVE_FORMAT_VERSION) {
    throw new Error(`manifest.formatVersion must be ${NORA_ARCHIVE_FORMAT_VERSION}`);
  }
  const entries = raw.entries;
  if (!Array.isArray(entries)) throw new Error("manifest.entries must be an array");
  /** @type {NoraArchiveManifest} */
  const manifest = {
    format: NORA_ARCHIVE_FORMAT,
    formatVersion: NORA_ARCHIVE_FORMAT_VERSION,
    documentId: requireString(raw.documentId, "manifest.documentId"),
    createdAt: nullableTimestamp(raw.createdAt, "manifest.createdAt"),
    updatedAt: nullableTimestamp(raw.updatedAt, "manifest.updatedAt"),
    entries: entries.map((entry, index) => parseManifestEntry(entry, index)),
  };
  validateManifest(manifest);
  return manifest;
}

/** @param {unknown} value @param {number} index @returns {NoraArchiveEntry} */
function parseManifestEntry(value, index) {
  const entry = requireRecord(value, `manifest.entries[${index}]`);
  return {
    path: normalizeArchivePath(requireString(entry.path, `manifest.entries[${index}].path`), `manifest.entries[${index}].path`),
    mediaType: requireString(entry.mediaType, `manifest.entries[${index}].mediaType`),
    bytes: requireSize(entry.bytes, `manifest.entries[${index}].bytes`),
    sha256: requireSha256(entry.sha256, `manifest.entries[${index}].sha256`),
  };
}

/** @param {NoraArchiveManifest} manifest */
export function validateManifest(manifest) {
  const paths = new Set();
  let previous = "";
  for (const [index, entry] of manifest.entries.entries()) {
    normalizeArchivePath(entry.path, `manifest.entries[${index}].path`);
    if (entry.path === MANIFEST_PATH) throw new Error("manifest.entries must not include manifest.json");
    if (paths.has(entry.path)) throw new Error(`manifest entry ${entry.path} is duplicated`);
    paths.add(entry.path);
    if (index > 0 && previous.localeCompare(entry.path) > 0) throw new Error("manifest.entries must be sorted by path");
    previous = entry.path;
    requireString(entry.mediaType, `manifest.entries[${index}].mediaType`);
    requireSize(entry.bytes, `manifest.entries[${index}].bytes`);
    requireSha256(entry.sha256, `manifest.entries[${index}].sha256`);
  }
  if (!paths.has(DOCUMENT_PATH)) throw new Error("manifest.entries must include document.json");
  return true;
}

/** @param {NoraArchiveEntry[]} entries */
export function sortArchiveEntries(entries) {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Stable JSON: sorted object keys, semantic array order, one trailing LF.
 * @param {unknown} value
 */
export function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, "utf8");
}

/** @param {unknown} value @returns {string} */
function stableJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

/** @param {string} rawPath @param {string} [pathLabel] */
export function normalizeArchivePath(rawPath, pathLabel = "archive path") {
  if (rawPath !== rawPath.normalize("NFC")) throw new Error(`${pathLabel} must be NFC-normalized`);
  if (!rawPath || rawPath.endsWith("/")) throw new Error(`${pathLabel} must be a file path`);
  if (rawPath.includes("\\") || rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath)) {
    throw new Error(`${pathLabel} must be a relative ZIP path`);
  }
  if (rawPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${pathLabel} must not contain traversal segments`);
  }
  if (
    rawPath !== DOCUMENT_PATH
    && rawPath !== MANIFEST_PATH
    && !/^runs\/[^/]+\.jsonl$/.test(rawPath)
    && !/^assets\/[a-f0-9]{64}$/.test(rawPath)
  ) {
    throw new Error(`${pathLabel} uses an unsupported Nora archive location`);
  }
  return rawPath;
}

/** @param {string} entryPath */
export function archiveKind(entryPath) {
  if (entryPath === DOCUMENT_PATH) return "document";
  if (entryPath.startsWith(RUNS_PREFIX)) return "run";
  if (entryPath.startsWith(ASSETS_PREFIX)) return "asset";
  if (entryPath === MANIFEST_PATH) return "manifest";
  throw new Error(`Unsupported Nora archive entry ${entryPath}`);
}

/** @param {string} entryPath */
export function runIdFromPath(entryPath) {
  const match = /^runs\/([^/]+)\.jsonl$/.exec(entryPath);
  if (!match) throw new Error(`Invalid run transcript path ${entryPath}`);
  return match[1];
}

/** @param {string} entryPath */
export function assetShaFromPath(entryPath) {
  const match = /^assets\/([a-f0-9]{64})$/.exec(entryPath);
  if (!match) throw new Error(`Invalid asset path ${entryPath}`);
  return match[1];
}

/** @param {NoraArchiveEntry[]} entries */
export function estimateZipBytes(entries) {
  let total = 22;
  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.path, "utf8");
    const compressAllowance = entry.path.startsWith(ASSETS_PREFIX) ? 0 : Math.ceil(entry.bytes * 0.002) + 1024;
    total += entry.bytes + compressAllowance + 30 + nameBytes + 24 + 46 + nameBytes + 18;
  }
  return total;
}

/** @param {NoraArchiveEntry[]} entries */
export function validateArchiveSizeBudget(entries) {
  const totalUncompressed = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalUncompressed > ARCHIVE_UNCOMPRESSED_BYTES_LIMIT) {
    throw new Error(`Nora archive exceeds ${ARCHIVE_UNCOMPRESSED_BYTES_LIMIT} uncompressed bytes`);
  }
  const estimated = estimateZipBytes(entries);
  if (estimated > ARCHIVE_ZIP_BYTES_LIMIT) {
    throw new Error(`Nora archive would exceed ${ARCHIVE_ZIP_BYTES_LIMIT} ZIP bytes`);
  }
}
