import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readNoraArchive } from "../../src/extension/archive/reader.js";
import { DocumentRegistry } from "../../src/extension/document-registry.js";
import {
  NoraDocument,
  SaveConflictError,
  createMinimalNoraDocument,
  writeMinimalNoraArchive,
} from "../../src/extension/nora-document.js";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("NoraDocument opens validated archives, publishes immutable content-change notifications, and saves .nora ZIPs", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "research.nora");
    await writeMinimalNoraArchive(filePath, "Research", {
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "doc-lifecycle",
    });
    const document = await NoraDocument.open(fileUri(filePath), { tempRoot: dir });
    const changes = [];
    document.onDidChange((event) => changes.push(event));

    await document.commitWebviewEvent({ type: "view_state", state: { mode: "canvas", node_id: "root", scroll: 3 } });
    assert.equal(changes.length, 1);
    assert(Object.isFrozen(changes[0]), "content-change notification is a fresh immutable event");
    assert.equal(document.state.viewState?.mode, "canvas");

    await document.save();
    assert.equal(document.isDirty, false);
    const opened = await readNoraArchive(filePath);
    assert.equal(opened.document.documentId, "doc-lifecycle");
    assert.equal(opened.document.viewState?.mode, "canvas");

    await document.dispose();
  });
});

test("Nora undo and redo are semantic snapshots, coalesce consecutive geometry, and request save when returning to saved state", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "semantic.nora")), {
      tempRoot: dir,
      title: "Semantic",
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "semantic-doc",
    });
    let saveRequests = 0;
    document.onDidRequestSave(() => { saveRequests += 1; });
    await document.saveToPath(document.filePath);

    await document.commitWebviewEvent({ type: "node_update", node_id: "root", position: { x: 1, y: 2 } });
    await document.commitWebviewEvent({ type: "node_update", node_id: "root", position: { x: 4, y: 5 } });
    assert.equal(document.undoStack.length, 1, "consecutive geometry updates coalesce into one Nora history entry");
    assert.equal(document.state.nodes.get("root")?.position.x, 4);

    await document.undo();
    assert.equal(document.state.nodes.get("root")?.position.x, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(saveRequests, 1, "undo-to-saved asks VS Code to save through the normal provider path");
    assert.equal(document.redoStack.length, 1);

    await document.redo();
    assert.equal(document.state.nodes.get("root")?.position.x, 4);
    await document.dispose();
  });
});

test("active and completed Agent Runs are one undo unit with cancelled partial redo", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "run.nora")), {
      tempRoot: dir,
      title: "Run",
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "run-doc",
    });
    const run = {
      id: "run-a",
      parentRunId: null,
      targetNodeId: "root",
      status: "running",
      prompt: "Prompt",
      profileId: null,
      provider: "fake",
      model: "fake",
      endpoint: null,
      startedAt: "2026-07-28T00:00:00.000Z",
      endedAt: null,
      error: null,
      transcriptPath: "runs/run-a.jsonl",
      extensions: {},
    };
    let aborted = false;
    await document.beginRun("run-a", { abort: () => { aborted = true; } });
    await document.commitRunEvent({ type: "run_summary", run });
    await document.commitRunEvent({ type: "node_state", node_id: "root", state: "running" });
    assert.equal(document.undoStack.length, 0, "active run does not push normal history entries");
    const runArchivePath = path.join(dir, "run-active.nora");
    await document.backupToPath(runArchivePath);
    const activeBackup = await readNoraArchive(runArchivePath);
    assert.deepEqual(
      activeBackup.runs.get("run-a").map((record) => record.kind),
      ["nora_mutation", "nora_mutation"],
      "active run mutations advance the saved transcript cutoff with the document state",
    );

    await document.undo();
    assert.equal(aborted, true);
    assert.equal(document.state.runs.has("run-a"), false);
    assert.equal(document.redoStack.length, 1);

    await document.redo();
    assert.equal(document.state.runs.get("run-a")?.status, "cancelled");
    assert.equal(document.undoStack.length, 1);

    await document.undo();
    assert.equal(document.state.runs.has("run-a"), false);
    await document.dispose();
  });
});

test("active run undo fails instead of fabricating cancelled redo when terminal transcript append fails", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "undo-failure.nora")), {
      tempRoot: dir,
      title: "Undo Failure",
    });
    const run = {
      id: "run-fail-append",
      parentRunId: null,
      targetNodeId: "root",
      status: "running",
      prompt: "Prompt",
      profileId: null,
      provider: "fake",
      model: "fake",
      endpoint: null,
      startedAt: "2026-07-28T00:00:00.000Z",
      endedAt: null,
      error: null,
      transcriptPath: "runs/run-fail-append.jsonl",
      extensions: {},
    };
    await document.beginRun("run-fail-append", { abort: () => {} });
    await document.commitRunEvent({ type: "run_summary", run });
    const originalAppend = document.archiveWorkspace.appendRunRecord.bind(document.archiveWorkspace);
    document.archiveWorkspace.appendRunRecord = async () => {
      throw new Error("append failed");
    };
    await assert.rejects(() => document.undo(), /append failed/);
    assert.equal(document.activeRun?.runId, "run-fail-append");
    assert.equal(document.redoStack.length, 0);
    document.archiveWorkspace.appendRunRecord = originalAppend;
    await document.dispose();
  });
});

test("save finalization rejects a retryable conflict when the document mutates during archive streaming", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "conflict.nora");
    const document = await NoraDocument.open(fileUri(filePath), {
      tempRoot: dir,
      title: "Conflict",
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "conflict-doc",
    });
    await document.saveToPath(filePath);
    await assert.rejects(
      document.saveToPath(filePath, {
        writeArchive: async (targetPath, snapshot) => {
          await fs.writeFile(targetPath, Buffer.from("not-yet-a-valid-archive"));
          assert.equal(snapshot.document.documentId, "conflict-doc");
          await document.commitWebviewEvent({ type: "document_title", title: "Changed While Saving" });
        },
        readArchive: async () => {
          throw new Error("readArchive should not run after a save conflict");
        },
      }),
      SaveConflictError,
    );
    assert.equal(document.isDirty, true);
    const stillValid = await readNoraArchive(filePath);
    assert.equal(stillValid.document.documentId, "conflict-doc", "save conflicts leave the previous archive readable");
    await document.dispose();
  });
});

test("backup, backup recovery, save-as, revert, invalid archives, unsupported schemes, and concurrent documents are handled", async () => {
  await withTempDir(async (dir) => {
    const firstPath = path.join(dir, "first.nora");
    const secondPath = path.join(dir, "second.nora");
    await writeMinimalNoraArchive(firstPath, "First", {
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "first-doc",
    });
    await writeMinimalNoraArchive(secondPath, "Second", {
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "second-doc",
    });
    const first = await NoraDocument.open(fileUri(firstPath), { tempRoot: dir });
    const second = await NoraDocument.open(fileUri(secondPath), { tempRoot: dir });
    const registry = new DocumentRegistry();
    const registryEntry = registry.add(first);
    registry.setActive(first);
    await first.commitWebviewEvent({ type: "document_title", title: "Changed First" });
    assert.equal(second.state.title, "Second", "separate documents mutate independently");

    const backupPath = path.join(dir, "backup.nora");
    await first.backupToPath(backupPath);
    const recovered = await NoraDocument.open(fileUri(firstPath), { archivePath: backupPath, tempRoot: dir });
    assert.equal(recovered.state.title, "Changed First");

    const saveAsPath = path.join(dir, "saved-as.nora");
    await first.saveAs(fileUri(saveAsPath));
    assert.equal(first.filePath, saveAsPath);
    registry.setActive(first);
    assert.equal(registry.activeDocument, first, "save-as re-keys the active document registry to the destination URI");
    assert.equal(registry.get(fileUri(saveAsPath)), first);
    assert.equal(registry.get(fileUri(firstPath)), null);
    await first.commitWebviewEvent({ type: "document_title", title: "Dirty Again" });
    await first.revert();
    assert.equal(first.state.title, "Changed First");
    assert.equal(first.undoStack.length, 0);

    await fs.writeFile(path.join(dir, "bad.nora"), "not a zip");
    await assert.rejects(NoraDocument.open(fileUri(path.join(dir, "bad.nora")), { tempRoot: dir }));
    await assert.rejects(first.saveAs({ scheme: "vscode-remote", fsPath: "/remote/out.nora", toString: () => "vscode-remote:/remote/out.nora" }), /supports only local file/);

    await first.dispose();
    registryEntry.dispose();
    await second.dispose();
    await recovered.dispose();
  });
});

test("running runs recovered from a hot-exit backup are terminalized as interrupted runs with terminal transcript records", async () => {
  await withTempDir(async (dir) => {
    const base = createMinimalNoraDocument("Interrupted", {
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "interrupted-doc",
    });
    const document = {
      ...base,
      nodes: base.nodes.map((node) => ({ ...node, state: "running", runId: "run-interrupted" })),
      runs: [{
        id: "run-interrupted",
        parentRunId: null,
        targetNodeId: "root",
        status: "running",
        prompt: "Prompt",
        profileId: null,
        provider: "fake",
        model: "fake",
        endpoint: null,
        startedAt: "2026-07-28T00:00:00.000Z",
        endedAt: null,
        error: null,
        transcriptPath: "runs/run-interrupted.jsonl",
        extensions: {},
      }],
    };
    const archivePath = path.join(dir, "interrupted.nora");
    await import("../../src/extension/archive/writer.js").then((mod) => mod.writeNoraArchive(archivePath, { document }));

    const opened = await NoraDocument.open(fileUri(archivePath), { tempRoot: dir, now: "2026-07-28T00:01:00.000Z" });
    assert.equal(opened.state.runs.get("run-interrupted")?.status, "interrupted");
    assert.deepEqual(opened.state.runs.get("run-interrupted")?.error, { reason: "interrupted" });
    assert.equal(opened.state.nodes.get("root")?.state, "interrupted");
    assert.deepEqual(opened.getRunTranscriptRecords("run-interrupted").map((record) => record.kind), ["run_terminal"]);
    assert.equal(opened.getRunTranscriptRecords("run-interrupted")[0].status, "interrupted");
    await opened.commitWebviewEvent({ type: "document_title", title: "Dirty before revert" });
    await opened.revert();
    await opened.save();
    const saved = await readNoraArchive(archivePath);
    assert.equal(saved.document.runs[0].status, "interrupted");
    assert.deepEqual(saved.runs.get("run-interrupted").map((record) => record.kind), ["run_terminal"]);
    assert.equal(saved.runs.get("run-interrupted")[0].status, "interrupted");
    await opened.dispose();
  });
});

/** @param {string} filePath */
function fileUri(filePath) {
  return {
    scheme: "file",
    fsPath: filePath,
    toString: () => pathToFileURL(filePath).href,
  };
}
