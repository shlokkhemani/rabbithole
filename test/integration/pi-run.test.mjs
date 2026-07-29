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

test("nora_ask honors selected node scope and marks the target answer node as run-owned", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "ask.nora")), {
      tempRoot: dir,
      title: "Ask",
      idFactory: () => "doc-ask",
    });
    const controller = new NoraRunController({
      createPiSession: fakePiSessionFactory([assistantEnd("Scoped answer")]),
      idFactory: () => "run-ask",
      now: fixedNow(),
      estimateTokens: () => 20,
    });

    await controller.startFromWebviewEvent(document, {
      type: "nora_ask",
      request_id: "ask-child",
      prompt: "Explain current node",
      scope: { type: "node", node_id: "root" },
    });
    await waitFor(() => document.state.runs.get("run-ask")?.status === "complete");

    const child = document.state.nodes.get("ask-child");
    assert.equal(child?.parentId, "root");
    assert.equal(child?.markdown, "Scoped answer");
    assert.equal(child?.extensions?.nora?.createdBy, "agent:run-ask");
    assert.deepEqual(document.state.runs.get("run-ask")?.extensions?.context?.scope, { type: "node", node_id: "root" });
    await document.dispose();
  });
});

test("PDF crop asks send image content to Pi and persist model-facing image history", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "crop-image.nora")), {
      tempRoot: dir,
      title: "Crop Image",
      idFactory: () => "doc-crop-image",
    });
    const sink = {};
    const promptImage = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
    const controller = new NoraRunController({
      createPiSession: fakePiSessionFactory([assistantEnd("Visual answer")], sink),
      idFactory: () => "run-crop-image",
      now: fixedNow(),
      estimateTokens: () => 20,
    });

    await controller.startFromWebviewEvent(document, branchEvent("crop-child", "Describe this region"), { promptImages: [promptImage] });
    await waitFor(() => document.state.runs.get("run-crop-image")?.status === "complete");

    assert.deepEqual(sink.session?.promptOptions?.images, [promptImage]);
    const records = document.getRunTranscriptRecords("run-crop-image");
    assert.deepEqual(records.map((record) => record.kind), ["user_message", "assistant_message", "run_terminal"]);
    assert.deepEqual(records[0].message.content, [
      { type: "text", text: sink.session?.promptText },
      promptImage,
    ]);
    await document.dispose();
  });
});

test("run start mutations publish before a fast Pi session can terminalize", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "start-mutations.nora")), {
      tempRoot: dir,
      title: "Start Mutations",
      idFactory: () => "doc-start-mutations",
    });
    const sink = {};
    const controller = new NoraRunController({
      createPiSession: fakePiSessionFactory([assistantEnd("Done")], sink),
      idFactory: () => "run-start-mutations",
      now: fixedNow(),
      estimateTokens: () => 20,
    });

    await controller.startFromWebviewEvent(document, branchEvent("mutated-child", "Explain"), {
      startMutations: async (started) => {
        assert.equal(sink.session?.started, false, "start mutations must run before session.prompt()");
        await document.commitRunEvent({
          type: "node_extensions_patch",
          node_id: started.targetNodeId,
          namespace: "test",
          value: { startMutation: true },
        });
      },
    });
    await waitFor(() => document.state.runs.get("run-start-mutations")?.status === "complete");

    assert.deepEqual(document.state.nodes.get("mutated-child")?.extensions?.test, { startMutation: true });
    assert.deepEqual(
      document.getRunTranscriptRecords("run-start-mutations").map((record) => record.kind),
      ["user_message", "nora_mutation", "assistant_message", "run_terminal"],
    );
    await document.dispose();
  });
});

test("selected workspace scope is passed to Pi sessions even when the document is outside a workspace folder", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "workspace-scope.nora")), {
      tempRoot: dir,
      title: "Workspace Scope",
      idFactory: () => "doc-workspace-scope",
    });
    const selectedWorkspace = path.join(dir, "selected-workspace");
    document.setWorkspaceFolderPath(selectedWorkspace);
    const seen = {};
    const controller = new NoraRunController({
      createPiSession: async (options) => {
        seen.cwd = options.cwd;
        seen.workspaceFolderPath = options.workspaceFolderPath;
        return fakePiSessionFactory([assistantEnd("Scoped")])();
      },
      idFactory: () => "run-workspace-scope",
      now: fixedNow(),
      estimateTokens: () => 20,
    });

    await controller.startFromWebviewEvent(document, branchEvent("workspace-child", "Explain"));
    await waitFor(() => document.state.runs.get("run-workspace-scope")?.status === "complete");
    assert.equal(seen.cwd, selectedWorkspace);
    assert.equal(seen.workspaceFolderPath, selectedWorkspace);
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

test("failed run startup disposes the unused Pi session and keeps the existing active run", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "startup-cleanup.nora")), {
      tempRoot: dir,
      title: "Startup Cleanup",
      idFactory: () => "doc-startup-cleanup",
    });
    await document.beginRun("existing-run", { abort: () => {} });
    const sink = {};
    const controller = new NoraRunController({
      createPiSession: async () => {
        const session = new FakePiSession([]);
        sink.session = session;
        return {
          session,
          sessionManager: {},
          customTools: [],
          toolNames: [],
          dispose: () => { sink.resourcesDisposed = true; },
        };
      },
      idFactory: () => "blocked-run",
      estimateTokens: () => 20,
    });

    await assert.rejects(
      () => controller.startFromWebviewEvent(document, branchEvent("blocked-child", "Explain")),
      /already active/,
    );
    assert.equal(sink.session.aborted, true);
    assert.equal(sink.session.disposed, true);
    assert.equal(sink.resourcesDisposed, true);
    assert.equal(document.activeRun?.runId, "existing-run");
    await document.finishActiveRun();
    await document.dispose();
  });
});

test("terminal publish failures still clear active runs and dispose Pi sessions", async () => {
  await withTempDir(async (dir) => {
    const document = await NoraDocument.open(fileUri(path.join(dir, "terminal-cleanup.nora")), {
      tempRoot: dir,
      title: "Terminal Cleanup",
      idFactory: () => "doc-terminal-cleanup",
    });
    const sink = {};
    const controller = new NoraRunController({
      createPiSession: fakePiSessionFactory([assistantEnd("Done")], sink),
      idFactory: () => "run-terminal-cleanup",
      now: fixedNow(),
      estimateTokens: () => 20,
    });
    const publishRunRecord = document.publishRunRecord.bind(document);
    document.publishRunRecord = async (runId, record, events = []) => {
      if (record.kind === "run_terminal") throw new Error("terminal publish failed");
      return publishRunRecord(runId, record, events);
    };

    await controller.startFromWebviewEvent(document, branchEvent("terminal-child", "Explain"));
    await waitFor(() => document.activeRun === null);
    assert.equal(sink.session.disposed, true);
    await document.dispose();
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
