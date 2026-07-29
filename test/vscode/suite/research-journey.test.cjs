const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "../../..");
const NOW = "2026-07-28T02:00:00.000Z";

suite("Nora research journey", () => {
  test("round-trips a fake provider, PDF, repositories, MCP, code evidence, cancellation, and exports", async function () {
    this.timeout(60_000);
    const restoreFetch = installFetchGuard();
    const { NoraDocument } = await esm("src/extension/nora-document.js");
    const { addFileAttachmentToDocument } = await esm("src/extension/attachments.js");
    const { NoraRunController } = await esm("src/extension/agent/run-controller.js");
    const { RepositoryToolService } = await esm("src/extension/agent/code-tools.js");
    const { repositorySourceRecord } = await esm("src/extension/git/evidence.js");
    const { McpToolService } = await esm("src/extension/mcp/pi-tool.js");
    const { readNoraArchive } = await esm("src/extension/archive/reader.js");
    const { exportMarkdownDocument, exportSnapshotDocument } = await esm("src/extension/commands/export-commands.js");
    const { assistantEnd, assistantUpdate, fakePiSessionFactory } = await esm("test/support/fake-pi-session.mjs");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nora-vscode-journey-"));
    try {
      const filePath = path.join(dir, "journey.nora");
      const document = await NoraDocument.open(fileUri(filePath), {
        tempRoot: dir,
        title: "Packaged Journey",
        now: NOW,
        idFactory: () => "journey-document",
      });
      await document.saveToPath(filePath);
      await document.selectProfile("fake-profile");

      const pdfIds = idFactory(["pdf-source", "pdf-evidence", "pdf-node"]);
      const pdf = await addFileAttachmentToDocument(document, path.join(ROOT, "test/fixtures/pdfs/attention-is-all-you-need-pages-1-2.pdf"), {
        parentNodeId: "root",
        now: NOW,
        idFactory: pdfIds,
      });
      assert.equal(document.state.nodes.get(pdf.nodeId)?.extensions?.pdf?.needs_webview_prepare, true);

      const repoA = await createLocalRepository(dir, "repo-a", "export const answer = 42;\n");
      const repoB = await createLocalRepository(dir, "repo-b", "export const other = 'nora';\n");
      document.retainRepositoryWorktree(repoA.id, { repository: repoA, release: async () => {} });
      document.retainRepositoryWorktree(repoB.id, { repository: repoB, release: async () => {} });
      const repoSource = repositorySourceRecord(repoA, { capturedAt: NOW });
      await document.commitEvent({ type: "source_record", source: repoSource });
      const repoTools = new RepositoryToolService({ document, now: () => NOW });
      const codeEvidence = await repoTools.captureEvidence({
        repositoryId: repoA.id,
        path: "src/app.js",
        startLine: 1,
        endLine: 1,
      });
      await document.commitEvent({ type: "evidence_record", evidence: codeEvidence.evidence });
      await document.commitEvent({
        type: "node_references",
        node_id: pdf.nodeId,
        source_ids: [repoSource.id],
        evidence_ids: [codeEvidence.evidence.id],
      });

      const mcp = new McpToolService({
        document,
        workspaceFolderPath: dir,
        supervisor: fakeMcpSupervisor(),
        readConfig: async () => ({
          servers: new Map([["fake", { name: "fake", type: "stdio" }]]),
          inputs: new Map(),
          diagnostics: [],
        }),
        resolveServerConfig: async () => ({
          name: "fake",
          type: "stdio",
          command: process.execPath,
          args: [],
          cwd: undefined,
          env: {},
          fingerprint: "fake",
        }),
      });
      const toolResult = parseMcpResult(await mcp.executeGeneric({
        operation: "call",
        server: "fake",
        tool: "summarize",
        arguments: { topic: "journey" },
      }));
      assert(toolResult.result.includes("tool:summarize"));
      const resourceResult = parseMcpResult(await mcp.executeGeneric({
        operation: "read_resource",
        server: "fake",
        uri: "test://resource.pdf",
      }));
      assert(resourceResult.result.includes("attachment"));
      assert(!resourceResult.result.includes(Buffer.from("resource bytes").toString("base64")), "model-facing MCP result does not keep raw blob bytes");
      await mcp.dispose();

      const askController = new NoraRunController({
        createPiSession: fakePiSessionFactory([
          assistantUpdate("Draft answer with code evidence"),
          assistantEnd("Final answer with code evidence and MCP resource."),
        ]),
        idFactory: () => "run-selected",
        now: fixedNow(),
        estimateTokens: () => 20,
      });
      await askController.startFromWebviewEvent(document, branchEvent("selected-answer", pdf.nodeId, "Explain the selected PDF node"));
      await waitFor(() => document.state.runs.get("run-selected")?.status === "complete");

      const followupController = new NoraRunController({
        createPiSession: fakePiSessionFactory([assistantEnd("Follow-up retained answer.")]),
        idFactory: () => "run-followup",
        now: fixedNow(),
        estimateTokens: () => 20,
      });
      await followupController.startFromWebviewEvent(document, branchEvent("follow-up", "selected-answer", "Follow up with implications"));
      await waitFor(() => document.state.runs.get("run-followup")?.status === "complete");
      assert.equal(document.state.runs.get("run-followup")?.parentRunId, "run-selected");

      const cancelSink = {};
      const cancelController = new NoraRunController({
        createPiSession: fakePiSessionFactory([assistantUpdate("Cancelled partial is retained."), "hold"], cancelSink),
        idFactory: () => "run-cancelled",
        now: fixedNow(),
        estimateTokens: () => 20,
      });
      await cancelController.startFromWebviewEvent(document, branchEvent("cancelled-answer", "root", "Start then cancel"));
      await waitFor(() => document.state.runs.get("run-cancelled")?.status === "running");
      await document.undo();
      cancelSink.session?.release?.();
      await document.redo();
      assert.equal(document.state.runs.get("run-cancelled")?.status, "cancelled");
      assert.equal(document.state.nodes.get("cancelled-answer")?.state, "cancelled");

      await document.saveToPath(filePath);
      await document.dispose();
      const archive = await readNoraArchive(filePath);
      assert.equal(archive.document.selectedProfileId, "fake-profile");
      assert(archive.document.attachments.some((attachment) => attachment.mediaType === "application/pdf"));
      assert(archive.document.attachments.some((attachment) => attachment.extensions?.kind === "mcp-resource"));
      assert(archive.document.evidence.some((evidence) => evidence.id === codeEvidence.evidence.id));
      assert.equal(archive.document.runs.find((run) => run.id === "run-cancelled")?.status, "cancelled");

      const reopened = await NoraDocument.open(fileUri(filePath), { tempRoot: dir });
      assert.equal(reopened.state.selectedProfileId, "fake-profile");
      assert.equal(reopened.state.runs.get("run-followup")?.parentRunId, "run-selected");
      assert.equal(reopened.state.nodes.get("follow-up")?.markdown, "Follow-up retained answer.");

      const api = fakeVscodeApi();
      const context = { extensionUri: fileUri(ROOT) };
      const markdownPath = path.join(dir, "journey.md");
      const snapshotPath = path.join(dir, "journey.html");
      const markdown = await exportMarkdownDocument(context, api, reopened, { destination: fileUri(markdownPath) });
      const snapshot = await exportSnapshotDocument(context, api, reopened, {
        destination: fileUri(snapshotPath),
        bundle: testSnapshotBundle(),
        rethrow: true,
      });
      assert(markdown.markdown.includes("Final answer with code evidence"));
      assert(markdown.markdown.includes("[^code-repo-a"));
      assert(snapshot.html.includes("application/vnd.nora+json"));
      assert(snapshot.html.includes("Follow-up retained answer."));
      await reopened.dispose();
      assert.deepEqual(restoreFetch(), [], "fake-provider journey made no unexpected fetch calls");
    } finally {
      restoreFetch();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects hostile archive, webview, Markdown, repository, and MCP payload boundaries", async function () {
    this.timeout(30_000);
    const { readNoraArchive } = await esm("src/extension/archive/reader.js");
    const { validateWebviewMessage } = await esm("src/extension/protocol.js");
    const { NoraDocument } = await esm("src/extension/nora-document.js");
    const { exportSnapshotDocument } = await esm("src/extension/commands/export-commands.js");
    const { RepositoryToolService } = await esm("src/extension/agent/code-tools.js");
    const { boundMcpModelResult } = await esm("src/extension/mcp/output.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nora-vscode-boundary-"));
    try {
      const corruptArchive = path.join(dir, "corrupt.nora");
      await fs.writeFile(corruptArchive, "not a zip");
      await assert.rejects(readNoraArchive(corruptArchive), /central directory|not a zip|end of central/i);
      assert.throws(
        () => validateWebviewMessage({ type: "ready", event: { type: "branch_request" } }),
        /unsupported keys/,
      );

      const document = await NoraDocument.open(fileUri(path.join(dir, "hostile.nora")), {
        tempRoot: dir,
        title: "Hostile",
        idFactory: () => "hostile-doc",
      });
      await document.commitEvent({
        type: "node_answered",
        node_id: "root",
        title: "Hostile",
        markdown: "Visible text.</script><script>globalThis.__nora_escape = true</script>",
        read: true,
      });
      const htmlPath = path.join(dir, "hostile.html");
      const snapshot = await exportSnapshotDocument({ extensionUri: fileUri(ROOT) }, fakeVscodeApi(), document, {
        destination: fileUri(htmlPath),
        bundle: testSnapshotBundle(),
        rethrow: true,
      });
      assert(!snapshot.html.includes("</script><script>globalThis.__nora_escape"), "hostile Markdown stays inert in snapshot JSON");

      const repo = await createLocalRepository(dir, "boundary-repo", "export const safe = true;\n");
      const service = new RepositoryToolService({ repositories: [repo] });
      await assert.rejects(service.readFile({ repositoryId: repo.id, path: "../outside.txt" }), /inside|relative|traversal/);

      const bounded = boundMcpModelResult({ lines: Array.from({ length: 3000 }, (_, index) => `line-${index}`) }, {
        maxBytes: 1024,
        maxLines: 20,
      });
      assert.equal(bounded.truncated, true);
      assert(bounded.bytes <= 1024);
      assert(bounded.lines <= 20);
      assert(!bounded.text.includes("line-2999"));
      await document.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

async function createLocalRepository(parentDir, name, source) {
  const worktreePath = path.join(parentDir, name);
  await fs.mkdir(path.join(worktreePath, "src"), { recursive: true });
  await git(worktreePath, ["init"]);
  await git(worktreePath, ["config", "user.email", "nora@example.test"]);
  await git(worktreePath, ["config", "user.name", "Nora Test"]);
  await fs.writeFile(path.join(worktreePath, "src/app.js"), source);
  await git(worktreePath, ["add", "src/app.js"]);
  await git(worktreePath, ["commit", "-m", `init ${name}`]);
  const sha = (await git(worktreePath, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  return {
    id: name,
    barePath: path.join(worktreePath, ".git"),
    worktreePath,
    acquisitionUrl: pathToFileURL(worktreePath).href,
    sanitizedRemote: pathToFileURL(worktreePath).href,
    sha,
    forgeType: null,
    forgeBaseUrl: "",
    repo: name,
    title: name,
  };
}

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
    created_at: NOW,
  };
}

function fakeMcpSupervisor() {
  return {
    acquire() {
      return {
        connection: {
          async callTool(toolName, args) {
            return { content: [{ type: "text", text: `tool:${toolName}:${JSON.stringify(args)}` }] };
          },
          async readResource(uri) {
            return {
              contents: [{
                uri,
                mimeType: "application/pdf",
                blob: Buffer.from("resource bytes").toString("base64"),
              }],
            };
          },
          async listResources() {
            return [{ uri: "test://resource.pdf", name: "Fake resource" }];
          },
          async search(query) {
            return { query, tools: ["summarize"], resources: ["test://resource.pdf"] };
          },
          async describe() {
            return { tools: [{ name: "summarize" }], resources: [{ uri: "test://resource.pdf" }] };
          },
        },
        release: async () => {},
      };
    },
  };
}

function parseMcpResult(result) {
  return JSON.parse(result.content[0].text);
}

function fixedNow() {
  let index = 0;
  return () => `2026-07-28T02:00:${String(index++).padStart(2, "0")}.000Z`;
}

function idFactory(values) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

function installFetchGuard() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    throw new Error(`Unexpected network fetch during Nora fake journey: ${String(input)}`);
  };
  let restored = false;
  return () => {
    if (!restored) {
      globalThis.fetch = original;
      restored = true;
    }
    return calls;
  };
}

function testSnapshotBundle() {
  return {
    stylesheetText: "#world{} #nora-snapshot-evidence{}",
    dompurifySource: "globalThis.DOMPurify={sanitize:function(value){return value}};",
    frozenClientSource: "globalThis.NoraFrozenClient={startPortableSnapshot:function(){}};",
    mermaidSource: "",
    pdfJsSource: "/* pdf runtime stub */",
    pdfWorkerSource: "/* pdf worker stub */",
  };
}

function fakeVscodeApi() {
  const api = {
    errors: [],
    window: {
      showSaveDialog: async () => null,
      showErrorMessage: async (message) => { api.errors.push(String(message)); },
      showInformationMessage: async () => null,
    },
    workspace: {
      fs: {
        writeFile: async (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
        readFile: async (uri) => fs.readFile(uri.fsPath),
      },
    },
    Uri: {
      file: fileUri,
      joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)),
    },
  };
  return api;
}

function fileUri(filePath) {
  const absolute = path.resolve(filePath);
  return {
    scheme: "file",
    fsPath: absolute,
    toString: () => pathToFileURL(absolute).href,
  };
}

function esm(relativePath) {
  return import(pathToFileURL(path.join(ROOT, relativePath)).href);
}

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition was not met before timeout");
}
