import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ASSET_BYTES_LIMIT,
  ARCHIVE_FILE_MODE,
  ARCHIVE_MTIME,
  ARCHIVE_UNCOMPRESSED_BYTES_LIMIT,
} from "../../src/extension/archive/constants.js";
import { readNoraArchive } from "../../src/extension/archive/reader.js";
import {
  prepareArchiveEntries,
  writeNoraArchive,
  writeNoraArchiveToPath,
} from "../../src/extension/archive/writer.js";
import {
  cleanupStaleNoraArchiveWorkspaces,
  createNoraArchiveWorkspace,
} from "../../src/extension/archive/workspace.js";
import { sha256Bytes } from "../../src/extension/archive/hash.js";
import { validateArchiveSizeBudget } from "../../src/extension/archive/manifest.js";
import {
  documentWithAttachment,
  jsonl,
  loadMinimalDocument,
  readZipEntries,
  runSummary,
  withTempDir,
} from "../support/nora-archive-fixture.mjs";

await withTempDir(async (dir) => {
  const document = await loadMinimalDocument();
  const first = path.join(dir, "first.nora");
  const second = path.join(dir, "second.nora");
  await writeNoraArchiveToPath(first, { document });
  await writeNoraArchiveToPath(second, { document });

  const firstBytes = await fs.readFile(first);
  const secondBytes = await fs.readFile(second);
  assert(firstBytes.equals(secondBytes), "identical logical inputs produce byte-identical archives");

  const opened = await readNoraArchive(first);
  assert.deepEqual(opened.document, document);
  assert.equal(opened.manifest.format, "nora");
  assert.equal(opened.manifest.formatVersion, 1);
  assert.equal(opened.manifest.entries[0].path, "document.json");
  assert.equal(opened.runs.size, 0);
  assert.equal(opened.assets.size, 0);

  const zipEntries = await readZipEntries(first);
  assert.deepEqual(zipEntries.map((entry) => entry.path), ["document.json", "manifest.json"]);
  for (const entry of zipEntries) {
    assert.equal(entry.mode, ARCHIVE_FILE_MODE);
    assert.equal(entry.mtime, ARCHIVE_MTIME.toISOString());
  }
});
console.log("ok nora archive: minimal documents round-trip deterministically with sorted fixed-metadata ZIP entries");

await withTempDir(async (dir) => {
  const workspace = await createNoraArchiveWorkspace({ rootDir: dir });
  try {
    const asset = await workspace.stageAssetBytes("asset-payload-v1", { mediaType: "text/plain" });
    const duplicate = await workspace.stageAssetBytes("asset-payload-v1", { mediaType: "text/plain" });
    assert.equal(duplicate.filePath, asset.filePath, "identical asset additions reuse one staged content address");

    const firstCutoff = await workspace.appendRunRecord("run-a", { kind: "message", role: "user", text: "one" });
    const completeCutoff = await workspace.appendRunRecord("run-a", { kind: "message", role: "assistant", text: "two" });
    assert(completeCutoff > firstCutoff);
    await fs.appendFile(workspace.runs.get("run-a").filePath, "{\"kind\":");
    await workspace.stageRunBytes("run-b", jsonl([{ kind: "terminal", status: "interrupted" }]));

    const base = await loadMinimalDocument();
    const document = documentWithAttachment(base, asset, {
      runs: [
        runSummary("run-a"),
        runSummary("run-b", { status: "interrupted" }),
      ],
    });
    const output = path.join(dir, "runs-assets.nora");
    await writeNoraArchiveToPath(output, {
      document,
      ...workspace.snapshotSources(),
      runByteCutoffs: { "run-a": completeCutoff },
    });

    const opened = await readNoraArchive(output);
    assert.deepEqual(opened.runs.get("run-a"), [
      { kind: "message", role: "user", text: "one" },
      { kind: "message", role: "assistant", text: "two" },
    ]);
    assert.deepEqual(opened.runs.get("run-b"), [{ kind: "terminal", status: "interrupted" }]);
    assert.equal(opened.assets.size, 1);
    assert(opened.assets.has(asset.sha256));

    const copied = path.join(dir, "copied.nora");
    await writeNoraArchiveToPath(copied, { document, previousArchive: opened, logicalRevisionChanged: false });
    const copiedEntries = await readZipEntries(copied, { includeBuffers: true });
    const copiedAsset = copiedEntries.find((entry) => entry.path === `assets/${asset.sha256}`);
    assert.equal(copiedAsset.buffer.toString("utf8"), "asset-payload-v1", "unchanged asset bytes are preserved through a previous-archive source");
  } finally {
    await workspace.dispose();
  }
});
console.log("ok nora archive: staged assets, duplicate content addresses, multiple runs, and immutable byte cutoffs are honored");

await withTempDir(async (dir) => {
  const workspace = await createNoraArchiveWorkspace({ rootDir: dir });
  try {
    await assert.rejects(
      workspace.stageRunBytes("../bad", jsonl([{ kind: "message" }])),
      /filename-safe Nora run id/,
      "run staging rejects ids before they can become filesystem paths",
    );
  } finally {
    await workspace.dispose();
  }

  const document = {
    ...await loadMinimalDocument(),
    runs: [runSummary("bad/run")],
  };
  await assert.rejects(
    writeNoraArchiveToPath(path.join(dir, "bad-run-id.nora"), { document }),
    /filename-safe Nora run id/,
    "archive writing rejects ids before constructing runs/<id>.jsonl",
  );
});
console.log("ok nora archive: run ids are single safe filename segments before staging or writing");

await withTempDir(async (dir) => {
  const workspace = await createNoraArchiveWorkspace({ rootDir: dir });
  try {
    await workspace.stageRunBytes("run-a", "{\"kind\":\"message\"}\n{\"kind\":");
    const document = {
      ...await loadMinimalDocument(),
      runs: [runSummary("run-a")],
    };
    await assert.rejects(
      writeNoraArchiveToPath(path.join(dir, "bad-cutoff.nora"), {
        document,
        ...workspace.snapshotSources(),
      }),
      /LF-terminated JSONL record/,
    );
  } finally {
    await workspace.dispose();
  }
});
console.log("ok nora archive: run files must publish only complete LF-terminated JSONL records");

await withTempDir(async (dir) => {
  const original = await loadMinimalDocument();
  const first = path.join(dir, "first.nora");
  await writeNoraArchiveToPath(first, { document: original });
  const previousArchive = await readNoraArchive(first);
  const changedOnlyTimestamp = { ...original, updatedAt: "2026-07-29T00:00:00.000Z" };
  const second = path.join(dir, "second.nora");
  const third = path.join(dir, "third.nora");
  const snapshot = { document: changedOnlyTimestamp, previousArchive, logicalRevisionChanged: false };
  await writeNoraArchiveToPath(second, snapshot);
  await writeNoraArchiveToPath(third, snapshot);
  const opened = await readNoraArchive(second);
  assert.equal(opened.document.updatedAt, original.updatedAt, "no-op saves keep the previous logical updatedAt");
  assert((await fs.readFile(second)).equals(await fs.readFile(third)), "repeated no-op saves are deterministic");
});
console.log("ok nora archive: updatedAt changes only with logical document revisions");

await withTempDir(async (dir) => {
  const original = Buffer.from("previous-target");
  const target = path.join(dir, "atomic.nora");
  await fs.writeFile(target, original);
  const document = await loadMinimalDocument();
  await assert.rejects(
    writeNoraArchive(target, { document }, {
      tmpSuffix: "fail",
      fsOps: {
        rename: async () => {
          const error = new Error("blocked");
          error.code = "EACCES";
          throw error;
        },
      },
    }),
    /blocked/,
  );
  assert((await fs.readFile(target)).equals(original), "failed direct replacement leaves the previous target intact");

  let renameCount = 0;
  await writeNoraArchive(target, { document }, {
    tmpSuffix: "eperm-success",
    fsOps: {
      rename: async (from, to) => {
        renameCount += 1;
        if (renameCount === 1) {
          const error = new Error("windows replacement needed");
          error.code = "EPERM";
          throw error;
        }
        await fs.rename(from, to);
      },
    },
  });
  await readNoraArchive(target);
  await assert.rejects(fs.access(path.join(dir, ".atomic.nora.eperm-success.bak")));

  await fs.writeFile(target, original);
  renameCount = 0;
  await assert.rejects(
    writeNoraArchive(target, { document }, {
      tmpSuffix: "eperm-restore",
      fsOps: {
        rename: async (from, to) => {
          renameCount += 1;
          if (renameCount === 1) {
            const error = new Error("windows replacement needed");
            error.code = "EEXIST";
            throw error;
          }
          if (renameCount === 3) throw new Error("second rename failed");
          await fs.rename(from, to);
        },
      },
    }),
    /second rename failed/,
  );
  assert((await fs.readFile(target)).equals(original), "Windows backup path restores the previous target when replacement fails");
});
console.log("ok nora archive: atomic replacement and injected Windows EPERM/EEXIST backup paths preserve the prior file");

await withTempDir(async (dir) => {
  const stale = path.join(dir, "nora-archive-stale");
  const fresh = path.join(dir, "nora-archive-fresh");
  const unrelated = path.join(dir, "other-stale");
  await fs.mkdir(stale);
  await fs.mkdir(fresh);
  await fs.mkdir(unrelated);
  const old = new Date("2026-07-20T00:00:00.000Z");
  await fs.utimes(stale, old, old);
  await fs.utimes(unrelated, old, old);
  const removed = await cleanupStaleNoraArchiveWorkspaces(dir, {
    now: Date.parse("2026-07-29T00:00:00.000Z"),
    maxAgeMs: 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(removed, [stale]);
  await assert.rejects(fs.access(stale));
  await fs.access(fresh);
  await fs.access(unrelated);
});
console.log("ok nora archive: stale temp cleanup only removes Nora archive workspace directories");

{
  const digest = "a".repeat(64);
  const document = documentWithAttachment(await loadMinimalDocument(), {
    sha256: digest,
    bytes: ASSET_BYTES_LIMIT,
    mediaType: "application/octet-stream",
  });
  const prepared = await prepareArchiveEntries({
    document,
    assets: [{
      sha256: digest,
      bytes: ASSET_BYTES_LIMIT,
      archivePath: "already-opened.nora",
      path: `assets/${digest}`,
    }],
  });
  assert(prepared.manifest.entries.some((entry) => entry.path === `assets/${digest}`), "exact 100 MiB asset boundary is accepted in preflight");

  const oversizeDocument = documentWithAttachment(await loadMinimalDocument(), {
    sha256: digest,
    bytes: ASSET_BYTES_LIMIT + 1,
    mediaType: "application/octet-stream",
  });
  await assert.rejects(
    prepareArchiveEntries({
      document: oversizeDocument,
      assets: [{
        sha256: digest,
        bytes: ASSET_BYTES_LIMIT + 1,
        archivePath: "already-opened.nora",
        path: `assets/${digest}`,
      }],
    }),
    /exceeds/,
  );
  validateArchiveSizeBudget([{ path: `assets/${digest}`, mediaType: "application/octet-stream", bytes: ARCHIVE_UNCOMPRESSED_BYTES_LIMIT - 4096, sha256: digest }]);
  assert.throws(
    () => validateArchiveSizeBudget([{ path: "document.json", mediaType: "application/json", bytes: ARCHIVE_UNCOMPRESSED_BYTES_LIMIT + 1, sha256: digest }]),
    /uncompressed bytes/,
  );
}
console.log("ok nora archive: asset, uncompressed, and conservative ZIP size preflight boundaries are enforced without giant buffers");
