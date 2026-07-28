import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { readNoraArchive } from "../../src/extension/archive/reader.js";
import { ASSET_MEDIA_TYPE, JSONL_MEDIA_TYPE, STRUCTURED_MEDIA_TYPE } from "../../src/extension/archive/constants.js";
import { sha256Bytes } from "../../src/extension/archive/hash.js";
import { canonicalJsonBytes } from "../../src/extension/archive/manifest.js";
import {
  archiveEntry,
  jsonl,
  loadMinimalDocument,
  manifestFor,
  replaceAllBytes,
  setEncryptionFlag,
  withTempDir,
  writeRawNoraArchive,
  writeRawZip,
} from "../support/nora-archive-fixture.mjs";

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const documentEntry = archiveEntry("document.json", canonicalJsonBytes(document), STRUCTURED_MEDIA_TYPE);
  const manifestEntry = archiveEntry("manifest.json", canonicalJsonBytes(manifestFor(document.documentId, [documentEntry])), STRUCTURED_MEDIA_TYPE);
  const archivePath = path.join(dir, "duplicate.nora");
  await writeRawZip(archivePath, [manifestEntry, documentEntry, documentEntry]);
  await assert.rejects(readNoraArchive(archivePath), /duplicated/);
});
console.log("ok nora archive security: duplicate ZIP entry names are rejected");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const runA = archiveEntry("runs/a.jsonl", jsonl([{ kind: "message" }]), JSONL_MEDIA_TYPE);
  const runUpper = archiveEntry("runs/A.jsonl", jsonl([{ kind: "message" }]), JSONL_MEDIA_TYPE);
  const documentEntry = archiveEntry("document.json", canonicalJsonBytes(document), STRUCTURED_MEDIA_TYPE);
  const manifestEntry = archiveEntry("manifest.json", canonicalJsonBytes(manifestFor(document.documentId, [documentEntry, runA, runUpper])), STRUCTURED_MEDIA_TYPE);
  const archivePath = path.join(dir, "case.nora");
  await writeRawZip(archivePath, [manifestEntry, documentEntry, runA, runUpper]);
  await assert.rejects(readNoraArchive(archivePath), /collide by case/);
});
console.log("ok nora archive security: case-colliding ZIP names are rejected");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const archivePath = path.join(dir, "traversal.nora");
  await writeRawNoraArchive(archivePath, {
    document,
    runs: [{ runId: "x", bytes: jsonl([{ kind: "message" }]) }],
  });
  await replaceAllBytes(archivePath, "runs/x.jsonl", "../eviljsonl");
  await assert.rejects(readNoraArchive(archivePath), /relative path|invalid relative path|traversal/);
});
console.log("ok nora archive security: traversal entry names are rejected before exposure");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const archivePath = path.join(dir, "encrypted.nora");
  await writeRawNoraArchive(archivePath, { document });
  await setEncryptionFlag(archivePath);
  await assert.rejects(readNoraArchive(archivePath), /encrypted/);
});
console.log("ok nora archive security: encrypted entries are rejected");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const archivePath = path.join(dir, "undeclared.nora");
  const extra = archiveEntry("runs/extra.jsonl", jsonl([{ kind: "message" }]), JSONL_MEDIA_TYPE);
  await writeRawNoraArchive(archivePath, { document, extraZipEntries: [extra] });
  await assert.rejects(readNoraArchive(archivePath), /undeclared entry runs\/extra\.jsonl/);
});
console.log("ok nora archive security: entries omitted from the manifest are rejected");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const archivePath = path.join(dir, "missing-declared.nora");
  await writeRawNoraArchive(archivePath, {
    document,
    runs: [{ runId: "missing", bytes: jsonl([{ kind: "message" }]) }],
    omitZipPaths: ["runs/missing.jsonl"],
  });
  await assert.rejects(readNoraArchive(archivePath), /missing entry runs\/missing\.jsonl|must include/);
});
console.log("ok nora archive security: manifest entries missing from the ZIP are rejected");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const wrongDocumentEntry = {
    ...archiveEntry("document.json", canonicalJsonBytes(document), STRUCTURED_MEDIA_TYPE),
    sha256: "0".repeat(64),
  };
  const manifestEntry = archiveEntry("manifest.json", canonicalJsonBytes(manifestFor(document.documentId, [wrongDocumentEntry])), STRUCTURED_MEDIA_TYPE);
  const archivePath = path.join(dir, "bad-hash.nora");
  await writeRawZip(archivePath, [manifestEntry, archiveEntry("document.json", canonicalJsonBytes(document), STRUCTURED_MEDIA_TYPE)]);
  await assert.rejects(readNoraArchive(archivePath), /SHA-256 does not match manifest/);
});
console.log("ok nora archive security: manifest hash mismatches are rejected");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const wrongDocumentEntry = {
    ...archiveEntry("document.json", canonicalJsonBytes(document), STRUCTURED_MEDIA_TYPE),
    bytes: canonicalJsonBytes(document).byteLength + 1,
  };
  const manifestEntry = archiveEntry("manifest.json", canonicalJsonBytes(manifestFor(document.documentId, [wrongDocumentEntry])), STRUCTURED_MEDIA_TYPE);
  const archivePath = path.join(dir, "bad-size.nora");
  await writeRawZip(archivePath, [manifestEntry, archiveEntry("document.json", canonicalJsonBytes(document), STRUCTURED_MEDIA_TYPE)]);
  await assert.rejects(readNoraArchive(archivePath), /size does not match manifest/);
});
console.log("ok nora archive security: declared and streamed sizes must match");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const payload = Buffer.from("asset-payload-v1");
  const sha256 = sha256Bytes(payload);
  const archivePath = path.join(dir, "bad-crc.nora");
  await writeRawNoraArchive(archivePath, {
    document: {
      ...document,
      nodes: document.nodes.map((node, index) => index === 0 ? { ...node, attachmentIds: [sha256] } : node),
      attachments: [{
        id: "asset-one",
        sha256,
        mediaType: "text/plain",
        title: "Payload",
        filename: "payload.txt",
        bytes: payload.byteLength,
        sourceId: null,
        evidenceIds: [],
        createdAt: null,
        extensions: {},
      }],
    },
    assets: [{ sha256, bytes: payload, mediaType: "text/plain" }],
  });
  await replaceAllBytes(archivePath, "asset-payload-v1", "asset-payload-v2");
  await assert.rejects(readNoraArchive(archivePath), /CRC does not match/);
});
console.log("ok nora archive security: corrupt entry bytes fail CRC validation");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const content = Buffer.from("payload-two");
  const pathSha = "1".repeat(64);
  const contentSha = sha256Bytes(content);
  const assetEntry = {
    path: `assets/${pathSha}`,
    mediaType: ASSET_MEDIA_TYPE,
    bytes: content.byteLength,
    sha256: contentSha,
    buffer: content,
    compress: false,
  };
  const doc = {
    ...document,
    nodes: document.nodes.map((node, index) => index === 0 ? { ...node, attachmentIds: [pathSha] } : node),
    attachments: [{
      id: "asset-two",
      sha256: pathSha,
      mediaType: ASSET_MEDIA_TYPE,
      title: "Payload",
      filename: null,
      bytes: content.byteLength,
      sourceId: null,
      evidenceIds: [],
      createdAt: null,
      extensions: {},
    }],
  };
  const documentEntry = archiveEntry("document.json", canonicalJsonBytes(doc), STRUCTURED_MEDIA_TYPE);
  const manifestEntry = archiveEntry("manifest.json", canonicalJsonBytes(manifestFor(doc.documentId, [documentEntry, assetEntry])), STRUCTURED_MEDIA_TYPE);
  const archivePath = path.join(dir, "bad-asset-name.nora");
  await writeRawZip(archivePath, [manifestEntry, documentEntry, assetEntry]);
  await assert.rejects(readNoraArchive(archivePath), /name must match its SHA-256/);
});
console.log("ok nora archive security: asset paths must match content hashes");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const archivePath = path.join(dir, "bad-jsonl.nora");
  await writeRawNoraArchive(archivePath, {
    document,
    runs: [{ runId: "truncated", bytes: Buffer.from("{\"kind\":\"message\"}") }],
  });
  await assert.rejects(readNoraArchive(archivePath), /must end with LF/);

  const archivePath2 = path.join(dir, "bad-jsonl-shape.nora");
  await writeRawNoraArchive(archivePath2, {
    document,
    runs: [{ runId: "array", bytes: Buffer.from("[]\n") }],
  });
  await assert.rejects(readNoraArchive(archivePath2), /must be a JSON object/);
});
console.log("ok nora archive security: malformed JSONL records are rejected");

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const archivePath = path.join(dir, "future-manifest.nora");
  await writeRawNoraArchive(archivePath, {
    document,
    manifestOverrides: { formatVersion: 2 },
  });
  await assert.rejects(readNoraArchive(archivePath), /newer version of Nora/);

  const futureDocument = { ...document, schemaVersion: 2 };
  const archivePath2 = path.join(dir, "future-document.nora");
  const documentEntry = archiveEntry("document.json", canonicalJsonBytes(futureDocument), STRUCTURED_MEDIA_TYPE);
  const manifestEntry = archiveEntry("manifest.json", canonicalJsonBytes(manifestFor(futureDocument.documentId, [documentEntry])), STRUCTURED_MEDIA_TYPE);
  await writeRawZip(archivePath2, [manifestEntry, documentEntry]);
  await assert.rejects(readNoraArchive(archivePath2), /newer version of Nora/);
});
console.log("ok nora archive security: future manifest and document versions fail clearly without partial reconstruction");
