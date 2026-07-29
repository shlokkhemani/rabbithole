import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { normalizeRunId, toPersistedNoraDocument } from "../../core/document-schema.js";
import {
  ARCHIVE_FILE_MODE,
  ARCHIVE_MTIME,
  ARCHIVE_ZIP_BYTES_LIMIT,
  ASSET_BYTES_LIMIT,
  ASSET_MEDIA_TYPE,
  ASSETS_PREFIX,
  DOCUMENT_JSON_BYTES_LIMIT,
  DOCUMENT_PATH,
  JSONL_MEDIA_TYPE,
  MANIFEST_PATH,
  NORA_ARCHIVE_FORMAT,
  NORA_ARCHIVE_FORMAT_VERSION,
  RUN_JSONL_BYTES_LIMIT,
  RUNS_PREFIX,
  STRUCTURED_MEDIA_TYPE,
} from "./constants.js";
import { hashFile, sha256Bytes } from "./hash.js";
import {
  canonicalJsonBytes,
  estimateZipBytes,
  sortArchiveEntries,
  validateArchiveSizeBudget,
} from "./manifest.js";

/** @typedef {import("../../core/contracts/archive.js").NoraArchiveEntry} NoraArchiveEntry */
/** @typedef {import("../../core/contracts/archive.js").NoraArchiveManifest} NoraArchiveManifest */
/** @typedef {import("../../core/contracts/archive.js").NoraArchiveWriteSnapshot} NoraArchiveWriteSnapshot */

/**
 * Build a deterministic .nora archive at a normal target path.
 * @param {string} targetPath
 * @param {NoraArchiveWriteSnapshot} snapshot
 * @param {{ fsOps?: Partial<typeof fs> & { rename?: (from: string, to: string) => Promise<void>, rm?: typeof fs.rm }, tmpSuffix?: string }} [options]
 */
export async function writeNoraArchive(targetPath, snapshot, options = {}) {
  const fsOps = { ...fs, ...options.fsOps };
  const suffix = options.tmpSuffix || `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmpPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${suffix}.tmp`);
  const backupPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${suffix}.bak`);
  try {
    await writeNoraArchiveToPath(tmpPath, snapshot);
    await fsyncFile(tmpPath, fsOps);
    await replaceFile(tmpPath, targetPath, backupPath, fsOps);
    await fsyncDirectory(path.dirname(targetPath), fsOps);
  } catch (error) {
    await fsOps.rm?.(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Build a deterministic .nora archive without sibling replacement semantics.
 * @param {string} outputPath
 * @param {NoraArchiveWriteSnapshot} snapshot
 */
export async function writeNoraArchiveToPath(outputPath, snapshot) {
  const prepared = await prepareArchiveEntries(snapshot);
  const zip = new yazl.ZipFile();
  const output = createWriteStream(outputPath, { mode: 0o600 });
  const zipFailed = new Promise((_, reject) => {
    zip.on("error", (/** @type {Error} */ error) => {
      output.destroy(error);
      reject(error);
    });
  });
  const finished = pipeline(zip.outputStream, output);
  for (const entry of prepared.entries) addZipEntry(zip, entry);
  zip.end();
  await Promise.race([finished, zipFailed]);
  const stat = await fs.stat(outputPath);
  if (stat.size > prepared.estimatedZipBytes) {
    throw new Error("Nora archive exceeded its conservative ZIP size estimate");
  }
}

/** @param {NoraArchiveWriteSnapshot} snapshot */
export async function prepareArchiveEntries(snapshot) {
  const previous = snapshot.previousArchive ?? null;
  const previousDocument = snapshot.previousDocument ?? previous?.document ?? null;
  const updatedAt = snapshot.logicalRevisionChanged === false
    ? previousDocument?.updatedAt ?? snapshot.document.updatedAt ?? null
    : snapshot.updatedAt ?? snapshot.document.updatedAt ?? null;
  const document = toPersistedNoraDocument(snapshot.document, { updatedAt });
  const documentBytes = canonicalJsonBytes(document);
  if (documentBytes.byteLength > DOCUMENT_JSON_BYTES_LIMIT) throw new Error(`${DOCUMENT_PATH} exceeds ${DOCUMENT_JSON_BYTES_LIMIT} bytes`);
  /** @type {Array<NoraArchiveEntry & { source: { kind: "buffer", bytes: Buffer } | { kind: "file", filePath: string, bytes: number } | { kind: "archive", archivePath: string, entryPath: string, bytes: number } }>} */
  const payloads = [{
    path: DOCUMENT_PATH,
    mediaType: STRUCTURED_MEDIA_TYPE,
    bytes: documentBytes.byteLength,
    sha256: sha256Bytes(documentBytes),
    source: { kind: "buffer", bytes: documentBytes },
  }];

  for (const run of await prepareRunEntries(snapshot, document)) payloads.push(run);
  for (const asset of await prepareAssetEntries(snapshot)) payloads.push(asset);

  const entries = sortArchiveEntries(payloads);
  validateArchiveSizeBudget(entries);
  const manifest = buildManifest(document, entries, previous?.manifest ?? null, snapshot);
  const manifestBytes = canonicalJsonBytes(manifest);
  const allEntries = [
    {
      path: MANIFEST_PATH,
      mediaType: STRUCTURED_MEDIA_TYPE,
      bytes: manifestBytes.byteLength,
      sha256: sha256Bytes(manifestBytes),
      source: { kind: "buffer", bytes: manifestBytes },
    },
    ...entries,
  ];
  const estimatedZipBytes = estimateZipBytes(allEntries);
  if (estimatedZipBytes > ARCHIVE_ZIP_BYTES_LIMIT) {
    throw new Error(`Nora archive would exceed ${ARCHIVE_ZIP_BYTES_LIMIT} ZIP bytes`);
  }
  return { manifest, document, entries: sortArchiveEntries(allEntries), estimatedZipBytes };
}

/**
 * @param {import("../../core/contracts/document.js").NoraDocument} document
 * @param {NoraArchiveEntry[]} entries
 * @param {NoraArchiveManifest | null} previousManifest
 * @param {NoraArchiveWriteSnapshot} snapshot
 * @returns {NoraArchiveManifest}
 */
function buildManifest(document, entries, previousManifest, snapshot) {
  return {
    format: NORA_ARCHIVE_FORMAT,
    formatVersion: NORA_ARCHIVE_FORMAT_VERSION,
    documentId: document.documentId,
    createdAt: previousManifest?.createdAt ?? snapshot.createdAt ?? document.createdAt ?? null,
    updatedAt: snapshot.logicalRevisionChanged === false
      ? previousManifest?.updatedAt ?? document.updatedAt ?? null
      : snapshot.updatedAt ?? document.updatedAt ?? null,
    entries: sortArchiveEntries(entries).map(({ path: entryPath, mediaType, bytes, sha256 }) => ({
      path: entryPath,
      mediaType,
      bytes,
      sha256,
    })),
  };
}

/** @param {NoraArchiveWriteSnapshot} snapshot @param {import("../../core/contracts/document.js").NoraDocument} document */
async function prepareRunEntries(snapshot, document) {
  const sourceByRunId = new Map((snapshot.runs ?? []).map((run) => [normalizeRunId(run.runId, "run source id"), run]));
  const previousByRunId = new Map();
  for (const [runId, records] of snapshot.previousArchive?.runs ?? []) {
    previousByRunId.set(normalizeRunId(runId, "previous run id"), records);
  }
  const runIds = new Set([
    ...sourceByRunId.keys(),
    ...Object.keys(snapshot.runByteCutoffs ?? {}).map((runId) => normalizeRunId(runId, "run cutoff id")),
    ...document.runs.map((run) => run.id),
  ]);
  /** @type {Array<any>} */
  const entries = [];
  for (const runId of [...runIds].sort()) {
    const safeRunId = normalizeRunId(runId, "run id");
    const source = sourceByRunId.get(runId);
    const pathName = `${RUNS_PREFIX}${safeRunId}.jsonl`;
    let bytes;
    if (source?.filePath) {
      bytes = await readCompleteJsonlPrefix(source.filePath, snapshot.runByteCutoffs?.[runId]);
    } else if (source?.records) {
      bytes = jsonlBytesForRecords(source.records);
    } else if (previousByRunId.has(runId)) {
      bytes = jsonlBytesForRecords(previousByRunId.get(runId));
    } else {
      bytes = Buffer.alloc(0);
    }
    if (bytes.byteLength > RUN_JSONL_BYTES_LIMIT) throw new Error(`${pathName} exceeds ${RUN_JSONL_BYTES_LIMIT} bytes`);
    validateJsonlBytes(bytes, pathName);
    entries.push({
      path: pathName,
      mediaType: JSONL_MEDIA_TYPE,
      bytes: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      source: { kind: "buffer", bytes },
    });
  }
  return entries;
}

/** @param {NoraArchiveWriteSnapshot} snapshot */
async function prepareAssetEntries(snapshot) {
  const sources = new Map();
  for (const asset of snapshot.assets ?? []) {
    sources.set(asset.sha256, asset);
  }
  for (const [sha256, asset] of snapshot.previousArchive?.assets ?? []) {
    if (!sources.has(sha256)) sources.set(sha256, asset);
  }
  /** @type {Array<any>} */
  const entries = [];
  for (const attachment of snapshot.document.attachments) {
    const source = sources.get(attachment.sha256);
    if (!source) throw new Error(`Missing asset bytes for ${attachment.sha256}`);
    const entryPath = `${ASSETS_PREFIX}${attachment.sha256}`;
    let payloadSource;
    let bytes = Number(source.bytes ?? attachment.bytes);
    let digest = source.sha256 ?? attachment.sha256;
    if (source.filePath) {
      const hashed = await hashFile(source.filePath);
      bytes = hashed.bytes;
      digest = hashed.sha256;
      payloadSource = { kind: "file", filePath: source.filePath, bytes };
    } else if (source.archivePath && source.path) {
      payloadSource = { kind: "archive", archivePath: source.archivePath, entryPath: source.path, bytes };
    } else if (source.bytesBuffer || source.bytes instanceof Uint8Array || Buffer.isBuffer(source.bytes)) {
      const bytesBuffer = Buffer.from(source.bytesBuffer ?? source.bytes);
      bytes = bytesBuffer.byteLength;
      digest = sha256Bytes(bytesBuffer);
      payloadSource = { kind: "buffer", bytes: bytesBuffer };
    } else {
      throw new Error(`Missing readable asset bytes for ${attachment.sha256}`);
    }
    if (digest !== attachment.sha256) throw new Error(`Asset ${attachment.sha256} bytes do not match their content address`);
    if (bytes !== attachment.bytes) throw new Error(`Asset ${attachment.sha256} size does not match document metadata`);
    if (bytes > ASSET_BYTES_LIMIT) throw new Error(`Asset ${attachment.sha256} exceeds ${ASSET_BYTES_LIMIT} bytes`);
    entries.push({
      path: entryPath,
      mediaType: source.mediaType ?? attachment.mediaType ?? ASSET_MEDIA_TYPE,
      bytes,
      sha256: attachment.sha256,
      source: payloadSource,
    });
  }
  return entries;
}

/**
 * @param {string} filePath
 * @param {number | undefined} cutoff
 */
async function readCompleteJsonlPrefix(filePath, cutoff) {
  const file = await fs.open(filePath, "r");
  try {
    const stat = await file.stat();
    const max = Math.min(Number.isSafeInteger(cutoff) ? Number(cutoff) : stat.size, stat.size);
    if (max > RUN_JSONL_BYTES_LIMIT) throw new Error(`${filePath} exceeds ${RUN_JSONL_BYTES_LIMIT} bytes`);
    const chunks = [];
    let remaining = max;
    let position = 0;
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      position += bytesRead;
    }
    const bytes = Buffer.concat(chunks);
    validateJsonlBytes(bytes, filePath);
    return bytes;
  } finally {
    await file.close();
  }
}

/** @param {Array<Record<string, unknown>>} records */
function jsonlBytesForRecords(records) {
  return Buffer.concat(records.map((record) => canonicalJsonBytes(record)));
}

/** @param {Buffer} bytes @param {string} label */
function validateJsonlBytes(bytes, label) {
  if (!bytes.length) return;
  if (bytes[bytes.length - 1] !== 0x0a) throw new Error(`${label} cutoff must end on a complete LF-terminated JSONL record`);
  for (const [index, line] of bytes.toString("utf8").slice(0, -1).split("\n").entries()) {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label}:${index + 1} must be a JSON object`);
    }
    if (`${line}\n` !== canonicalJsonBytes(parsed).toString("utf8")) {
      throw new Error(`${label}:${index + 1} must use canonical Nora JSONL encoding`);
    }
  }
}

/** @param {any} zip @param {any} entry */
function addZipEntry(zip, entry) {
  const options = {
    mtime: ARCHIVE_MTIME,
    mode: ARCHIVE_FILE_MODE,
    compress: !entry.path.startsWith(ASSETS_PREFIX),
    compressionLevel: entry.path.startsWith(ASSETS_PREFIX) ? 0 : 9,
    forceDosTimestamp: true,
    size: entry.bytes,
  };
  if (entry.source.kind === "buffer") {
    const { size, ...bufferOptions } = options;
    zip.addBuffer(entry.source.bytes, entry.path, bufferOptions);
  } else if (entry.source.kind === "file") {
    zip.addFile(entry.source.filePath, entry.path, options);
  } else if (entry.source.kind === "archive") {
    zip.addReadStreamLazy(entry.path, options, (/** @type {(error: Error | null, stream?: import("node:stream").Readable) => void} */ callback) => {
      openArchiveEntryStream(entry.source.archivePath, entry.source.entryPath).then(
        (stream) => callback(null, stream),
        (error) => callback(error),
      );
    });
  }
}

/** @param {string} archivePath @param {string} entryPath */
async function openArchiveEntryStream(archivePath, entryPath) {
  const yauzl = await import("yauzl");
  const zip = await yauzl.default.openPromise(archivePath, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  return new Promise((resolve, reject) => {
    /** @param {unknown} error */
    const fail = (error) => {
      zip.close();
      reject(error);
    };
    zip.on("entry", (entry) => {
      if (entry.fileName !== entryPath) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          fail(error);
          return;
        }
        stream.on("end", () => zip.close());
        stream.on("error", fail);
        resolve(stream);
      });
    });
    zip.on("end", () => fail(new Error(`Archive entry ${entryPath} was not found`)));
    zip.on("error", fail);
    zip.readEntry();
  });
}

/** @param {string} filePath @param {any} fsOps */
async function fsyncFile(filePath, fsOps) {
  const handle = await fsOps.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** @param {string} dirPath @param {any} fsOps */
async function fsyncDirectory(dirPath, fsOps) {
  const handle = await fsOps.open(dirPath, "r").catch((/** @type {any} */ error) => {
    if (process.platform === "win32" || error?.code === "EISDIR" || error?.code === "EPERM") return null;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** @param {string} tmpPath @param {string} targetPath @param {string} backupPath @param {any} fsOps */
async function replaceFile(tmpPath, targetPath, backupPath, fsOps) {
  try {
    await fsOps.rename(tmpPath, targetPath);
    return;
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code !== "EPERM" && code !== "EEXIST") throw error;
  }
  let hasBackup = false;
  try {
    await fsOps.rename(targetPath, backupPath);
    hasBackup = true;
  } catch (backupError) {
    if (/** @type {any} */ (backupError)?.code !== "ENOENT") throw backupError;
  }
  try {
    await fsOps.rename(tmpPath, targetPath);
  } catch (replaceError) {
    if (hasBackup) {
      await fsOps.rename(backupPath, targetPath).catch(() => {});
    }
    throw replaceError;
  }
  if (hasBackup) await fsOps.rm?.(backupPath, { force: true });
}
