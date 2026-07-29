import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ASSET_BYTES_LIMIT, ARCHIVE_UNCOMPRESSED_BYTES_LIMIT } from "../../src/extension/archive/constants.js";
import { readNoraArchive } from "../../src/extension/archive/reader.js";
import {
  addBytesAttachmentToDocument,
  addFileAttachmentToDocument,
  addMcpResourceBlobAttachment,
  addWebviewCropAttachment,
  commitAttachmentRecords,
  preflightAttachmentMetadata,
  prepareWebviewCropAttachment,
} from "../../src/extension/attachments.js";
import { NoraDocument } from "../../src/extension/nora-document.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("attachment preflight accepts the exact 100 MiB boundary and rejects one byte over without giant buffers", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "limits.nora")), { tempRoot: dir, title: "Limits" });
    const sha256 = "a".repeat(64);
    assert.deepEqual(
      preflightAttachmentMetadata(document, [{ sha256, bytes: ASSET_BYTES_LIMIT }]),
      { totalAssetBytes: ASSET_BYTES_LIMIT, uniqueAssetCount: 1 },
    );
    assert.throws(() => preflightAttachmentMetadata(document, [{ sha256, bytes: ASSET_BYTES_LIMIT + 1 }]), /exceeds/);
    assert.throws(
      () => preflightAttachmentMetadata(document, Array.from({ length: 11 }, (_, index) => ({
        sha256: `${index.toString(16)}`.repeat(64),
        bytes: ASSET_BYTES_LIMIT,
      }))),
      /archive assets would exceed/,
    );
    await document.dispose();
  });
});

test("file attachments stream hash, dedupe by SHA, save raw bytes, and hydrate materialized asset URLs", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "figure.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await fs.writeFile(filePath, bytes);
    const archivePath = path.join(dir, "attached.nora");
    const document = await NoraDocument.open(fileUri(archivePath), { tempRoot: dir, title: "Attached" });

    const first = await addFileAttachmentToDocument(document, filePath, {
      parentNodeId: "root",
      now: "2026-07-28T00:00:00.000Z",
      idFactory: idSequence("file-a", "file-b", "file-c"),
    });
    const second = await addBytesAttachmentToDocument(document, bytes, {
      title: "Duplicate image",
      filename: "copy.png",
      mediaType: "image/png",
      now: "2026-07-28T00:00:01.000Z",
      idFactory: idSequence("dup-a", "dup-b"),
    });
    assert.equal(first.sha256, second.sha256);
    assert.equal(document.archiveWorkspace.snapshotSources().assets.length, 1, "identical bytes share one staged asset");
    assert.equal(document.state.attachments.size, 1, "document metadata dedupes by content address");
    const [materialized, parallelMaterialized] = await Promise.all([
      document.materializeAssetByName(first.assetName),
      document.materializeAssetByName(first.assetName),
    ]);
    assert.equal(parallelMaterialized, materialized, "parallel hydration shares one materialized asset path");
    assert.deepEqual(await fs.readFile(materialized), bytes);

    await document.saveToPath(archivePath);
    const archive = await readNoraArchive(archivePath);
    assert.equal(archive.document.attachments[0].sha256, first.sha256);
    assert.equal(archive.assets.size, 1);
    await document.dispose();
  });
});

test("MCP resource blobs and webview PDF crops persist bounded attachment references instead of raw blobs", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "mcp.nora")), { tempRoot: dir, title: "MCP" });
    const resource = await addMcpResourceBlobAttachment(document, {
      server: "corp",
      uri: "test://image",
      content: { uri: "test://image", mimeType: "image/png", blob: Buffer.from("png").toString("base64") },
    });
    assert.equal(resource.attachment.mediaType, "image/png");
    assert.equal(resource.source.type, "mcp-resource");
    assert.equal(document.state.attachments.has(resource.attachment.id), true);

    const crop = await addWebviewCropAttachment(document, {
      media_type: "image/png",
      bytes_base64: Buffer.from("crop").toString("base64"),
      sha256: "375676bd26868505668fce072799a6e029a37fbbe67b70b89f7b68def282344c",
      source_sha256: "b".repeat(64),
      page: 2,
      anchor: { version: 2, source_sha256: "b".repeat(64), kind: "region", fragments: [] },
      selected_text: "figure text",
    });
    assert.equal(crop.source.type, "pdf-region");
    assert.equal(crop.evidence.excerpt, "figure text");
    assert.equal(document.state.attachments.has(crop.attachment.id), true);
    await document.dispose();
  });
});

test("base64 attachment inputs reject oversize decoded payloads before mutation", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "oversize-blob.nora")), { tempRoot: dir, title: "MCP" });
    const impossible = "A".repeat(Math.ceil((ASSET_BYTES_LIMIT + 1) / 3) * 4);
    await assert.rejects(
      () => addMcpResourceBlobAttachment(document, {
        server: "corp",
        uri: "test://oversize",
        content: { uri: "test://oversize", mimeType: "application/octet-stream", blob: impossible },
      }),
      /exceeds/,
    );
    assert.equal(document.state.attachments.size, 0);
    await document.dispose();
  });
});

test("MCP blob attachments committed during active runs advance transcript cutoffs", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "mcp-run-blob.nora")), { tempRoot: dir, title: "MCP Run Blob" });
    await document.beginRun("run-mcp-blob", { abort: () => {} });
    await addMcpResourceBlobAttachment(document, {
      server: "corp",
      uri: "test://blob",
      content: {
        uri: "test://blob",
        mimeType: "application/octet-stream",
        blob: Buffer.from("resource bytes").toString("base64"),
      },
    });
    const backupPath = path.join(dir, "mcp-run-blob-backup.nora");
    await document.backupToPath(backupPath);
    const archive = await readNoraArchive(backupPath);
    assert.deepEqual(
      archive.runs.get("run-mcp-blob").map((record) => record.kind),
      ["nora_mutation", "nora_mutation", "nora_mutation"],
      "source, evidence, and attachment metadata are saved with matching run records",
    );
    await document.undo();
    await document.dispose();
  });
});

test("PDF crop records can be committed as run mutations and undone with the run", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "crop-run.nora")), { tempRoot: dir, title: "Crop Run" });
    const crop = await prepareWebviewCropAttachment(document, {
      bytes_base64: Buffer.from("crop").toString("base64"),
      sha256: "375676bd26868505668fce072799a6e029a37fbbe67b70b89f7b68def282344c",
      source_sha256: "b".repeat(64),
      page: 1,
      anchor: { version: 2, source_sha256: "b".repeat(64), kind: "region", fragments: [] },
    });
    assert.equal(document.state.attachments.size, 0, "preparing a crop stages bytes without mutating document metadata");

    await document.beginRun("run-crop", { abort: () => {} });
    await commitAttachmentRecords(document, crop, { nodeId: "root", runMutation: true });
    assert.equal(document.state.attachments.has(crop.attachment.id), true);

    await document.undo();
    assert.equal(document.state.attachments.has(crop.attachment.id), false, "run undo removes crop metadata committed during the run");
    await document.dispose();
  });
});

test("unchanged archive assets materialize lazily from the previous .nora without changing bytes", async () => {
  await withTempDir(async (dir) => {
    const base = await NoraDocument.open(fileUri(path.join(dir, "base.nora")), { tempRoot: dir, title: "Base" });
    const attachment = await addBytesAttachmentToDocument(base, Buffer.from("previous"), {
      title: "Previous",
      filename: "previous.txt",
      mediaType: "text/plain",
      now: "2026-07-28T00:00:00.000Z",
      idFactory: idSequence("source", "evidence"),
    });
    const archivePath = path.join(dir, "previous.nora");
    await base.saveToPath(archivePath);
    await base.dispose();

    const reopened = await NoraDocument.open(fileUri(archivePath), { tempRoot: dir });
    const materialized = await reopened.materializeAssetByName(attachment.assetName);
    assert.equal(await fs.readFile(materialized, "utf8"), "previous");
    await reopened.dispose();
  });
});

/** @param  {...string} values */
function idSequence(...values) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

/** @param {string} filePath */
function fileUri(filePath) {
  return { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
}
