const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");

suite("Nora multi-document runs", () => {
  test("keeps the one-run lock per document while separate documents run concurrently", async function () {
    this.timeout(30_000);
    const { NoraDocument } = await esm("src/extension/nora-document.js");
    const { NoraRunController } = await esm("src/extension/agent/run-controller.js");
    const { FakePiSession, assistantUpdate } = await esm("test/support/fake-pi-session.mjs");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nora-vscode-multi-run-"));
    const sessions = [];
    try {
      const first = await NoraDocument.open(fileUri(path.join(dir, "first.nora")), {
        tempRoot: dir,
        title: "First",
        idFactory: () => "multi-doc-first",
      });
      const second = await NoraDocument.open(fileUri(path.join(dir, "second.nora")), {
        tempRoot: dir,
        title: "Second",
        idFactory: () => "multi-doc-second",
      });
      let runIndex = 0;
      const controller = new NoraRunController({
        createPiSession: async () => {
          const session = new FakePiSession([assistantUpdate(`Partial ${sessions.length + 1}`), "hold"]);
          sessions.push(session);
          return { session, sessionManager: { appendMessage() {} }, customTools: [], toolNames: [] };
        },
        idFactory: () => `multi-run-${++runIndex}`,
        now: fixedNow(),
        estimateTokens: () => 20,
      });

      await controller.startFromWebviewEvent(first, branchEvent("first-child", "root", "Explain first"));
      await waitFor(() => first.state.runs.get("multi-run-1")?.status === "running");
      await assert.rejects(
        controller.startFromWebviewEvent(first, branchEvent("first-second-child", "root", "Explain first again")),
        /already active/,
      );
      await controller.startFromWebviewEvent(second, branchEvent("second-child", "root", "Explain second"));
      await waitFor(() => second.state.runs.get("multi-run-3")?.status === "running");

      assert.equal(first.activeRun?.runId, "multi-run-1");
      assert.equal(second.activeRun?.runId, "multi-run-3");
      assert.equal(first.state.nodes.has("first-second-child"), false, "rejected second run does not mutate the first document");

      await first.undo();
      await second.undo();
      assert.equal(first.state.runs.has("multi-run-1"), false);
      assert.equal(second.state.runs.has("multi-run-3"), false);
      await first.dispose();
      await second.dispose();
    } finally {
      for (const session of sessions) session.release?.();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function branchEvent(nodeId, parentId, question) {
  return {
    type: "branch_request",
    request_id: nodeId,
    node_id: nodeId,
    parent_id: parentId,
    selected_text: "",
    question,
    lens: null,
    anchor: null,
    scope: { type: "node", node_id: parentId },
    branch_type: "followup",
    position: { x: 360, y: 0 },
    size: { w: 320, h: 220 },
  };
}

function fixedNow() {
  let index = 0;
  return () => `2026-07-28T01:00:${String(index++).padStart(2, "0")}.000Z`;
}

function fileUri(filePath) {
  return {
    scheme: "file",
    fsPath: filePath,
    toString: () => pathToFileURL(filePath).href,
  };
}

function esm(relativePath) {
  return import(pathToFileURL(path.join(ROOT, relativePath)).href);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition was not met before timeout");
}
