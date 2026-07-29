import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import {
  ARCHIVE_FILE_MODE,
  ARCHIVE_MTIME,
  ASSET_MEDIA_TYPE,
  DOCUMENT_PATH,
  JSONL_MEDIA_TYPE,
  MANIFEST_PATH,
  NORA_ARCHIVE_FORMAT,
  NORA_ARCHIVE_FORMAT_VERSION,
  STRUCTURED_MEDIA_TYPE,
} from "../../src/extension/archive/constants.js";
import { sha256Bytes } from "../../src/extension/archive/hash.js";
import { canonicalJsonBytes, sortArchiveEntries } from "../../src/extension/archive/manifest.js";

export async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nora-archive-test-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function loadMinimalDocument() {
  const filePath = path.resolve("test/fixtures/nora/minimal-document.json");
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export function runSummary(id, overrides = {}) {
  return {
    id,
    parentRunId: null,
    targetNodeId: "root",
    status: "complete",
    prompt: "Summarize",
    profileId: "profile-a",
    provider: "fake",
    model: "fake-model",
    endpoint: null,
    startedAt: "2026-07-28T00:00:00.000Z",
    endedAt: "2026-07-28T00:00:01.000Z",
    error: null,
    transcriptPath: `runs/${id}.jsonl`,
    extensions: {},
    ...overrides,
  };
}

export function documentWithAttachment(document, asset, overrides = {}) {
  const attachmentId = `attachment-${asset.sha256.slice(0, 8)}`;
  return {
    ...document,
    nodes: document.nodes.map((node, index) => index === 0
      ? { ...node, attachmentIds: [attachmentId] }
      : node),
    attachments: [{
      id: attachmentId,
      sha256: asset.sha256,
      mediaType: asset.mediaType || ASSET_MEDIA_TYPE,
      title: "Asset",
      filename: "asset.txt",
      bytes: asset.bytes,
      sourceId: null,
      evidenceIds: [],
      createdAt: "2026-07-28T00:00:02.000Z",
      extensions: {},
    }],
    ...overrides,
  };
}

export function archiveEntry(pathName, bytes, mediaType = STRUCTURED_MEDIA_TYPE) {
  const buffer = Buffer.from(bytes);
  return {
    path: pathName,
    mediaType,
    bytes: buffer.byteLength,
    sha256: sha256Bytes(buffer),
    buffer,
  };
}

export function manifestFor(documentId, entries, overrides = {}) {
  return {
    format: NORA_ARCHIVE_FORMAT,
    formatVersion: NORA_ARCHIVE_FORMAT_VERSION,
    documentId,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    entries: sortArchiveEntries(entries).map(({ path: entryPath, mediaType, bytes, sha256 }) => ({
      path: entryPath,
      mediaType,
      bytes,
      sha256,
    })),
    ...overrides,
  };
}

export async function writeRawZip(filePath, entries) {
  const zip = new yazl.ZipFile();
  const output = await fs.open(filePath, "w", 0o600);
  await output.close();
  const stream = (await import("node:fs")).createWriteStream(filePath, { mode: 0o600 });
  const done = pipeline(zip.outputStream, stream);
  for (const entry of entries) {
    const options = {
      mtime: ARCHIVE_MTIME,
      mode: ARCHIVE_FILE_MODE,
      compress: entry.compress ?? !entry.path.startsWith("assets/"),
      compressionLevel: entry.compress === false || entry.path.startsWith("assets/") ? 0 : 9,
      forceDosTimestamp: true,
    };
    zip.addBuffer(Buffer.from(entry.buffer), entry.path, options);
  }
  zip.end();
  await done;
}

export async function writeRawNoraArchive(filePath, { document, runs = [], assets = [], manifestOverrides = {}, omitZipPaths = [], extraZipEntries = [] }) {
  const documentEntry = archiveEntry(DOCUMENT_PATH, canonicalJsonBytes(document), STRUCTURED_MEDIA_TYPE);
  const runEntries = runs.map((run) => archiveEntry(`runs/${run.runId}.jsonl`, run.bytes, JSONL_MEDIA_TYPE));
  const assetEntries = assets.map((asset) => archiveEntry(`assets/${asset.sha256}`, asset.bytes, asset.mediaType || ASSET_MEDIA_TYPE));
  const manifestEntries = [documentEntry, ...runEntries, ...assetEntries];
  const manifest = manifestFor(document.documentId, manifestEntries, manifestOverrides);
  const manifestEntry = archiveEntry(MANIFEST_PATH, canonicalJsonBytes(manifest), STRUCTURED_MEDIA_TYPE);
  await writeRawZip(filePath, [
    manifestEntry,
    documentEntry,
    ...runEntries,
    ...assetEntries,
    ...extraZipEntries,
  ].filter((entry) => !omitZipPaths.includes(entry.path)));
  return { manifest, entries: manifestEntries };
}

export function jsonl(records) {
  return Buffer.concat(records.map((record) => canonicalJsonBytes(record)));
}

export async function readZipEntries(filePath, { includeBuffers = false } = {}) {
  const zip = await yauzl.openPromise(filePath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  try {
    return await new Promise((resolve, reject) => {
      const entries = [];
      zip.on("entry", (entry) => {
        const finalize = (buffer = null) => {
          entries.push({
            path: entry.fileName,
            bytes: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            crc32: entry.crc32 >>> 0,
            mode: entry.externalFileAttributes >>> 16,
            mtime: entry.getLastModDate({ forceDosTimestamp: true }).toISOString(),
            buffer,
          });
          zip.readEntry();
        };
        if (!includeBuffers) {
          finalize();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) {
            reject(error);
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("error", reject);
          stream.on("end", () => finalize(Buffer.concat(chunks)));
        });
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

export async function replaceAllBytes(filePath, search, replacement) {
  const bytes = await fs.readFile(filePath);
  const from = Buffer.from(search);
  const to = Buffer.from(replacement);
  assert.equal(from.length, to.length, "replacement must preserve byte length");
  let count = 0;
  for (let offset = bytes.indexOf(from); offset !== -1; offset = bytes.indexOf(from, offset + to.length)) {
    to.copy(bytes, offset);
    count += 1;
  }
  assert(count > 0, `expected to replace ${search}`);
  await fs.writeFile(filePath, bytes);
  return count;
}

export async function setEncryptionFlag(filePath) {
  const bytes = await fs.readFile(filePath);
  for (let offset = 0; offset < bytes.length - 4; offset += 1) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 1, offset + 6);
    if (signature === 0x02014b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 1, offset + 8);
  }
  await fs.writeFile(filePath, bytes);
}
