import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { crc32 } from "node:zlib";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { parseNoraDocument } from "../../core/document-schema.js";
import {
  ARCHIVE_UNCOMPRESSED_BYTES_LIMIT,
  ARCHIVE_ZIP_BYTES_LIMIT,
  ASSET_BYTES_LIMIT,
  ASSETS_PREFIX,
  DOCUMENT_JSON_BYTES_LIMIT,
  DOCUMENT_PATH,
  MANIFEST_PATH,
  MANIFEST_JSON_BYTES_LIMIT,
  RUN_JSONL_BYTES_LIMIT,
  RUNS_PREFIX,
} from "./constants.js";
import {
  archiveKind,
  assetShaFromPath,
  canonicalJsonBytes,
  parseManifest,
  runIdFromPath,
  sortArchiveEntries,
  validateArchiveSizeBudget,
  normalizeArchivePath,
} from "./manifest.js";
import { normalizeRunId } from "../../core/document-schema.js";

/** @typedef {import("../../core/contracts/archive.js").NoraArchiveReadResult} NoraArchiveReadResult */

/** @param {string} archivePath */
export async function readNoraArchive(archivePath) {
  const zip = await yauzl.openPromise(archivePath, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    if (zip.fileSize > ARCHIVE_ZIP_BYTES_LIMIT) {
      throw new Error(`Nora archive exceeds ${ARCHIVE_ZIP_BYTES_LIMIT} ZIP bytes`);
    }
    const entries = await readEntries(zip);
    return await validateReadEntries(archivePath, entries);
  } finally {
    zip.close();
  }
}

/**
 * Stream one validated ZIP entry into a local file.
 * @param {string} archivePath
 * @param {string} entryPath
 * @param {string} targetPath
 * @param {{ expectedSha256?: string, expectedBytes?: number }} [options]
 */
export async function extractArchiveEntryToFile(archivePath, entryPath, targetPath, options = {}) {
  const zip = await yauzl.openPromise(archivePath, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    const entry = await findEntry(zip, normalizeArchivePath(entryPath));
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = await openEntryStream(zip, entry);
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      hash.update(buffer);
    });
    await pipeline(stream, createWriteStream(targetPath, { mode: 0o600 }));
    const sha256 = hash.digest("hex");
    if (options.expectedSha256 && sha256 !== options.expectedSha256) throw new Error(`${entryPath} SHA-256 does not match manifest`);
    if (options.expectedBytes != null && bytes !== options.expectedBytes) throw new Error(`${entryPath} size does not match manifest`);
    return { sha256, bytes };
  } finally {
    zip.close();
  }
}

/** @param {import("yauzl").ZipFile} zip */
function readEntries(zip) {
  return new Promise((resolve, reject) => {
    /** @type {Array<{ zip: import("yauzl").ZipFile, path: string, compressedSize: number, uncompressedSize: number, entry: import("yauzl").Entry }>} */
    const entries = [];
    let done = false;
    /** @param {unknown} error */
    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
    zip.on("error", fail);
    /** @param {import("yauzl").Entry} entry */
    zip.on("entry", (entry) => {
      if (done) return;
      if (/\/$/.test(entry.fileName)) {
        fail(new Error(`Nora archive must not contain directory entry ${entry.fileName}`));
        return;
      }
      let path;
      try {
        path = normalizeArchivePath(entry.fileName);
        if (entry.isEncrypted()) throw new Error(`Nora archive entry ${entry.fileName} is encrypted`);
      } catch (error) {
        fail(error);
        return;
      }
      entries.push({
        zip,
        path,
        compressedSize: Number(entry.compressedSize),
        uncompressedSize: Number(entry.uncompressedSize),
        entry,
      });
      zip.readEntry();
    });
    zip.on("end", () => {
      if (done) return;
      done = true;
      resolve(entries);
    });
    zip.readEntry();
  });
}

/**
 * @param {import("yauzl").ZipFile} zip
 * @param {string} entryPath
 * @returns {Promise<import("yauzl").Entry>}
 */
function findEntry(zip, entryPath) {
  return new Promise((resolve, reject) => {
    let done = false;
    /** @param {unknown} error */
    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry) => {
      if (done) return;
      let normalized;
      try {
        normalized = normalizeArchivePath(entry.fileName);
      } catch (error) {
        fail(error);
        return;
      }
      if (normalized === entryPath) {
        done = true;
        resolve(entry);
        return;
      }
      zip.readEntry();
    });
    zip.on("end", () => fail(new Error(`Archive entry ${entryPath} was not found`)));
    zip.readEntry();
  });
}

/**
 * @param {import("yauzl").ZipFile} zip
 * @param {import("yauzl").Entry} entry
 * @returns {Promise<import("node:stream").Readable>}
 */
function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

/**
 * @param {string} archivePath
 * @param {Array<{ zip: import("yauzl").ZipFile, path: string, compressedSize: number, uncompressedSize: number, entry: import("yauzl").Entry }>} entries
 * @returns {Promise<NoraArchiveReadResult>}
 */
async function validateReadEntries(archivePath, entries) {
  validateDirectory(entries);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get(MANIFEST_PATH);
  if (!manifestEntry) throw new Error("Nora archive is missing manifest.json");
  const manifestBytes = await readSmallEntry(manifestEntry);
  const manifest = parseManifest(parseStructuredJson(manifestBytes, MANIFEST_PATH));
  assertCanonicalJson(manifestBytes, manifest, MANIFEST_PATH);
  validateManifestCoverage(manifest.entries, entries);
  validateArchiveSizeBudget(manifest.entries);

  /** @type {import("../../core/contracts/document.js").NoraDocument | null} */
  let document = null;
  /** @type {Map<string, any[]>} */
  const runs = new Map();
  /** @type {Map<string, any>} */
  const assets = new Map();
  for (const manifestItem of sortArchiveEntries(manifest.entries)) {
    const entry = byPath.get(manifestItem.path);
    if (!entry) throw new Error(`manifest declares missing entry ${manifestItem.path}`);
    const digest = await hashEntry(entry, manifestItem);
    if (digest.sha256 !== manifestItem.sha256) throw new Error(`${manifestItem.path} SHA-256 does not match manifest`);
    if (digest.bytes !== manifestItem.bytes) throw new Error(`${manifestItem.path} size does not match manifest`);
    const kind = archiveKind(manifestItem.path);
    if (kind === "document") {
      document = parseNoraDocument(parseStructuredJson(digest.buffer, manifestItem.path));
      assertCanonicalJson(digest.buffer, document, manifestItem.path);
    } else if (kind === "run") {
      runs.set(normalizeRunId(runIdFromPath(manifestItem.path), "run transcript id"), parseJsonl(digest.buffer, manifestItem.path));
    } else if (kind === "asset") {
      const sha256 = assetShaFromPath(manifestItem.path);
      if (sha256 !== digest.sha256) throw new Error(`${manifestItem.path} name must match its SHA-256`);
      if (manifestItem.bytes > ASSET_BYTES_LIMIT) throw new Error(`${manifestItem.path} exceeds ${ASSET_BYTES_LIMIT} bytes`);
      assets.set(sha256, {
        path: manifestItem.path,
        archivePath,
        bytes: manifestItem.bytes,
        sha256,
        mediaType: manifestItem.mediaType,
      });
    }
  }
  if (!document) throw new Error("Nora archive is missing document.json");
  if (document.documentId !== manifest.documentId) throw new Error("manifest.documentId must match document.json");
  validateDocumentPayloadReferences(document, runs, assets);
  return { archivePath, manifest, document, runs, assets };
}

/** @param {Array<{ path: string, uncompressedSize: number }>} entries */
function validateDirectory(entries) {
  const exact = new Set();
  const lower = new Map();
  let total = 0;
  for (const entry of entries) {
    if (exact.has(entry.path)) throw new Error(`Nora archive entry ${entry.path} is duplicated`);
    exact.add(entry.path);
    const folded = entry.path.toLowerCase();
    const existing = lower.get(folded);
    if (existing && existing !== entry.path) throw new Error(`Nora archive entries ${existing} and ${entry.path} collide by case`);
    lower.set(folded, entry.path);
    total += entry.uncompressedSize;
    if (total > ARCHIVE_UNCOMPRESSED_BYTES_LIMIT) {
      throw new Error(`Nora archive exceeds ${ARCHIVE_UNCOMPRESSED_BYTES_LIMIT} uncompressed bytes`);
    }
    if (entry.path.startsWith(ASSETS_PREFIX) && entry.uncompressedSize > ASSET_BYTES_LIMIT) {
      throw new Error(`${entry.path} exceeds ${ASSET_BYTES_LIMIT} bytes`);
    }
    const structuredLimit = structuredEntryLimit(entry.path);
    if (structuredLimit !== null && entry.uncompressedSize > structuredLimit) {
      throw new Error(`${entry.path} exceeds ${structuredLimit} bytes`);
    }
  }
}

/**
 * @param {import("../../core/contracts/archive.js").NoraArchiveEntry[]} manifestEntries
 * @param {Array<{ path: string, uncompressedSize: number }>} zipEntries
 */
function validateManifestCoverage(manifestEntries, zipEntries) {
  const manifestPaths = new Set(manifestEntries.map((entry) => entry.path));
  const zipPaths = new Set(zipEntries.map((entry) => entry.path));
  for (const entry of zipPaths) {
    if (entry !== MANIFEST_PATH && !manifestPaths.has(entry)) throw new Error(`Nora archive contains undeclared entry ${entry}`);
  }
  for (const entry of manifestPaths) {
    if (!zipPaths.has(entry)) throw new Error(`manifest declares missing entry ${entry}`);
  }
  if (!manifestPaths.has(DOCUMENT_PATH)) throw new Error("manifest.entries must include document.json");
}

/** @param {{ zip: import("yauzl").ZipFile, entry: import("yauzl").Entry }} wrapped */
function readSmallEntry(wrapped) {
  return readEntryBuffer(wrapped, MANIFEST_JSON_BYTES_LIMIT);
}

/**
 * @param {{ zip: import("yauzl").ZipFile, entry: import("yauzl").Entry }} wrapped
 * @param {import("../../core/contracts/archive.js").NoraArchiveEntry} expected
 */
async function hashEntry(wrapped, expected) {
  const limit = structuredEntryLimit(expected.path);
  if (limit !== null && expected.bytes > limit) throw new Error(`${expected.path} exceeds ${limit} bytes`);
  return hashEntryStream(wrapped, limit);
}

/** @param {string} entryPath */
function structuredEntryLimit(entryPath) {
  if (entryPath === MANIFEST_PATH) return MANIFEST_JSON_BYTES_LIMIT;
  if (entryPath === DOCUMENT_PATH) return DOCUMENT_JSON_BYTES_LIMIT;
  if (entryPath.startsWith(RUNS_PREFIX)) return RUN_JSONL_BYTES_LIMIT;
  return null;
}

/**
 * @param {{ zip: import("yauzl").ZipFile, entry: import("yauzl").Entry }} wrapped
 * @param {number} limit
 */
async function readEntryBuffer(wrapped, limit) {
  const result = await hashEntryStream(wrapped, limit);
  return result.buffer;
}

/**
 * @param {{ zip: import("yauzl").ZipFile, entry: import("yauzl").Entry }} wrapped
 * @param {number | null} bufferLimit
 * @returns {Promise<{ sha256: string, bytes: number, buffer: Buffer }>}
 */
function hashEntryStream(wrapped, bufferLimit) {
  return new Promise((resolve, reject) => {
    wrapped.zip.openReadStream(wrapped.entry, (streamError, stream) => {
      if (streamError) {
        reject(streamError);
        return;
      }
      const hash = createHash("sha256");
      let crc = 0;
      /** @type {Buffer[]} */
      const chunks = [];
      let bytes = 0;
      /** @param {Buffer | Uint8Array | string} chunk */
      stream.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        hash.update(buffer);
        crc = crc32(buffer, crc);
        if (bufferLimit !== null) {
          if (bytes > bufferLimit) {
            stream.destroy(new Error(`${wrapped.entry.fileName} exceeds expected structured size`));
            return;
          }
          chunks.push(buffer);
        }
      });
      stream.on("error", reject);
      stream.on("end", () => {
        if ((crc >>> 0) !== (wrapped.entry.crc32 >>> 0)) {
          reject(new Error(`${wrapped.entry.fileName} CRC does not match ZIP metadata`));
          return;
        }
        resolve({
          sha256: hash.digest("hex"),
          bytes,
          buffer: Buffer.concat(chunks),
        });
      });
    });
  });
}

/** @param {Buffer} bytes @param {string} entryPath */
function parseStructuredJson(bytes, entryPath) {
  if (!bytes.length || bytes[bytes.length - 1] !== 0x0a) throw new Error(`${entryPath} must end with LF`);
  return JSON.parse(bytes.toString("utf8"));
}

/** @param {Buffer} bytes @param {unknown} parsed @param {string} entryPath */
function assertCanonicalJson(bytes, parsed, entryPath) {
  if (!bytes.equals(canonicalJsonBytes(parsed))) throw new Error(`${entryPath} must use canonical Nora JSON encoding`);
}

/** @param {Buffer} bytes @param {string} entryPath */
function parseJsonl(bytes, entryPath) {
  if (!bytes.length) return [];
  if (bytes[bytes.length - 1] !== 0x0a) throw new Error(`${entryPath} must end with LF`);
  const text = bytes.toString("utf8");
  return text.slice(0, -1).split("\n").map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`${entryPath}:${index + 1} must be valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${entryPath}:${index + 1} must be a JSON object`);
    }
    if (`${line}\n` !== canonicalJsonBytes(parsed).toString("utf8")) {
      throw new Error(`${entryPath}:${index + 1} must use canonical Nora JSONL encoding`);
    }
    return parsed;
  });
}

/**
 * @param {import("../../core/contracts/document.js").NoraDocument} document
 * @param {Map<string, any[]>} runs
 * @param {Map<string, { bytes: number, mediaType?: string }>} assets
 */
function validateDocumentPayloadReferences(document, runs, assets) {
  for (const attachment of document.attachments) {
    const asset = assets.get(attachment.sha256);
    if (!asset) throw new Error(`document attachment ${attachment.id} references missing asset ${attachment.sha256}`);
    if (asset.bytes !== attachment.bytes) throw new Error(`document attachment ${attachment.id} size does not match asset ${attachment.sha256}`);
    if (asset.mediaType !== attachment.mediaType) throw new Error(`document attachment ${attachment.id} media type does not match asset ${attachment.sha256}`);
  }
  for (const run of document.runs) {
    const expectedPath = `${RUNS_PREFIX}${run.id}.jsonl`;
    if (run.transcriptPath !== expectedPath) throw new Error(`document run ${run.id} must reference ${expectedPath}`);
    if (!runs.has(run.id)) throw new Error(`document run ${run.id} references missing transcript ${expectedPath}`);
  }
}
