import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readNoraArchive } from "../../src/extension/archive/reader.js";
import { NoraRunController } from "../../src/extension/agent/run-controller.js";
import { NoraDocument } from "../../src/extension/nora-document.js";
import { FakePiSession, assistantEnd, assistantUpdate, fakePiSessionFactory } from "../support/fake-pi-session.mjs";
import { withTempDir } from "../support/nora-archive-fixture.mjs";

test("Pi run streams into one canvas node and persists complete replayable transcript prefixes", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "run.nora")), {
      tempRoot: dir,
      title: "Run",
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "doc-run",
    });
    const controller = new NoraRunController({
      createPiSession: fakePiSessionFactory([
        assistantUpdate("Draft answer"),
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "nora_list_repositories", args: {} },
        assistantEnd("Final answer"),
      ]),
      idFactory: () => "run-1",
      now: fixedNow(),
      estimateTokens: () => 20,
    });

    await controller.startFromWebviewEvent(document, branchEvent("child", "Explain root"));
    await waitFor(() => document.state.runs.get("run-1")?.status === "complete");

    const child = document.state.nodes.get("child");
    assert.equal(child?.markdown, "Final answer");
    assert.equal(child?.state, "complete");
    assert.equal(child?.runId, "run-1");
    const run = document.state.runs.get("run-1");
    assert.equal(run?.parentRunId, null);
    assert.equal(run?.targetNodeId, "child");
    assert.equal(run?.provider, "fake");
    assert(run?.extensions?.trace?.some((entry) => entry.kind === "tool-call"));

    const output = path.join(dir, "saved.nora");
    await document.saveToPath(output);
    const opened = await readNoraArchive(output);
    assert.deepEqual(opened.runs.get("run-1").map((record) => record.kind), [
      "user_message",
      "assistant_checkpoint",
      "tool_call",
      "assistant_message",
      "run_terminal",
    ]);
    assert.equal(opened.document.runs[0].status, "complete");
    assert.equal(opened.document.nodes.find((node) => node.id === "child")?.runId, "run-1");
    await document.dispose();
  });
});

test("oversized run preflight rejects before branch mutation", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "oversize.nora")), {
      tempRoot: dir,
      title: "Oversize",
      idFactory: () => "doc-oversize",
    });
    const controller = new NoraRunController({
      createPiSession: fakePiSessionFactory([]),
      idFactory: () => "run-oversize",
      estimateTokens: () => 200000,
    });
    await assert.rejects(
      controller.startFromWebviewEvent(document, branchEvent("too-large", "Explain")),
      /too large/,
    );
    assert.equal(document.state.nodes.has("too-large"), false);
    assert.equal(document.state.runs.size, 0);
    await document.dispose();
  });
});

test("backup during streaming captures a consistent document revision and complete JSONL prefix", async () => {
  await withTempDir(async (dir) => {
    const sink = {};
    const document = await NoraDocument.open(fileUri(path.join(dir, "backup.nora")), {
      tempRoot: dir,
      title: "Backup",
      idFactory: () => "doc-backup",
    });
    const controller = new NoraRunController({
      createPiSession: fakePiSessionFactory([assistantUpdate("Partial"), "hold"], sink),
      idFactory: () => "run-backup",
      now: fixedNow(),
      estimateTokens: () => 20,
    });
    await controller.startFromWebviewEvent(document, branchEvent("partial", "Explain"));
    await waitFor(() => document.state.nodes.get("partial")?.markdown === "Partial");

    const backupPath = path.join(dir, "streaming-backup.nora");
    await document.backupToPath(backupPath);
    const opened = await readNoraArchive(backupPath);
    assert.equal(opened.document.runs[0].status, "running");
    assert.deepEqual(opened.runs.get("run-backup").map((record) => record.kind), ["user_message", "assistant_checkpoint"]);

    await document.undo();
    sink.session?.release?.();
    assert.equal(document.state.runs.has("run-backup"), false);
    await document.redo();
    assert.equal(document.state.runs.get("run-backup")?.status, "cancelled");
    await document.dispose();
  });
});

test("one-run lock is per document while different documents run independently", async () => {
  await withTempDir(async (dir) => {
    const first = await NoraDocument.open(fileUri(path.join(dir, "first.nora")), { tempRoot: dir, title: "First", idFactory: () => "doc-first" });
    const second = await NoraDocument.open(fileUri(path.join(dir, "second.nora")), { tempRoot: dir, title: "Second", idFactory: () => "doc-second" });
    let runIndex = 0;
    const controller = new NoraRunController({
      createPiSession: fakePiSessionFactory([assistantUpdate("Partial"), "hold"]),
      idFactory: () => `run-lock-${++runIndex}`,
      now: fixedNow(),
      estimateTokens: () => 20,
    });

    await controller.startFromWebviewEvent(first, branchEvent("first-child", "Explain first"));
    await waitFor(() => first.state.runs.get("run-lock-1")?.status === "running");
    await assert.rejects(
      controller.startFromWebviewEvent(first, branchEvent("first-second-child", "Explain again")),
      /already active/,
    );
    await controller.startFromWebviewEvent(second, branchEvent("second-child", "Explain second"));
    await waitFor(() => second.state.runs.get("run-lock-3")?.status === "running");

    await first.undo();
    await second.undo();
    await first.dispose();
    await second.dispose();
  });
});

test("provider failure and extension disposal preserve labelled partial runs", async () => {
  await withTempDir(async (dir) => {
    const failed = await NoraDocument.open(fileUri(path.join(dir, "failed.nora")), { tempRoot: dir, title: "Failed", idFactory: () => "doc-failed" });
    const failingController = new NoraRunController({
      createPiSession: async () => ({ session: new ThrowingPiSession(), sessionManager: {}, customTools: [], toolNames: [] }),
      idFactory: () => "run-failed",
      now: fixedNow(),
      estimateTokens: () => 20,
    });
    await failingController.startFromWebviewEvent(failed, branchEvent("failed-child", "Fail"));
    await waitFor(() => failed.state.runs.get("run-failed")?.status === "failed");
    assert.equal(failed.state.nodes.get("failed-child")?.state, "failed");

    const sink = {};
    const active = await NoraDocument.open(fileUri(path.join(dir, "dispose.nora")), { tempRoot: dir, title: "Dispose", idFactory: () => "doc-dispose" });
    const activeController = new NoraRunController({
      createPiSession: fakePiSessionFactory([assistantUpdate("Partial"), "hold"], sink),
      idFactory: () => "run-dispose",
      now: fixedNow(),
      estimateTokens: () => 20,
    });
    await activeController.startFromWebviewEvent(active, branchEvent("dispose-child", "Dispose"));
    await waitFor(() => active.state.runs.get("run-dispose")?.status === "running");
    await active.dispose();
    assert.equal(sink.session.aborted, true);
    await failed.dispose();
  });
});

function branchEvent(nodeId, question) {
  return {
    type: "branch_request",
    request_id: nodeId,
    node_id: nodeId,
    parent_id: "root",
    selected_text: "",
    question,
    lens: null,
    anchor: null,
    scope: { type: "node", node_id: "root" },
    branch_type: "followup",
    position: { x: 360, y: 0 },
    size: { w: 320, h: 220 },
  };
}

function fixedNow() {
  let index = 0;
  return () => `2026-07-28T00:00:${String(index++).padStart(2, "0")}.000Z`;
}

function fileUri(filePath) {
  return {
    scheme: "file",
    fsPath: filePath,
    toString: () => pathToFileURL(filePath).href,
  };
}

async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

class ThrowingPiSession extends FakePiSession {
  async prompt(text) {
    this.promptText = text;
    this.emit({ type: "message_end", message: { role: "user", content: text, timestamp: 1 } });
    throw new Error("provider unavailable");
  }
}
