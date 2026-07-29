import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSnapshotHtml } from "../../src/core/snapshot-html.js";
import { createNoraSnapshotProjection } from "../../src/core/snapshot-projection.js";
import { createDocumentState, documentStateToPersisted, reduceDocumentEvent } from "../../src/core/document-state.js";
import { addBytesAttachmentToDocument } from "../../src/extension/attachments.js";
import { NoraDocument, writeMinimalNoraArchive } from "../../src/extension/nora-document.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const VSIX = path.join(ROOT, "artifacts", "nora.vsix");

export const budgetDefinitions = [
  ["extension_activation_ms", "Extension bundle load plus Nora command/provider registration", "ms", 3, "Minimum of repeated cold bundle loads with a mocked VS Code API; a 30ms floor absorbs host noise.", 30],
  ["minimal_archive_open_ms", "Open and validate a minimal .nora archive", "ms", 3, "Minimum of repeated local archive opens; a 15ms floor absorbs filesystem noise.", 15],
  ["representative_archive_open_ms", "Open and validate a representative .nora archive", "ms", 3, "Minimum of repeated local archive opens for a document with nodes, runs, evidence, and assets.", 25],
  ["representative_archive_save_ms", "Save a representative .nora archive after one logical mutation", "ms", 3, "Minimum of repeated local archive writes with atomic replacement and staged assets.", 30],
  ["webview_hydration_ms", "Project a representative Nora document to webview hydration JSON", "ms", 3, "Minimum of repeated hydration projections; a 20ms floor catches accidental whole-document churn.", 20],
  ["streaming_batch_ms", "Apply one hundred assistant stream updates in a 2,000-node Nora document", "ms", 4, "Minimum of repeated reducer batches; a 10ms floor catches accidental whole-document churn.", 10],
  ["snapshot_html_bytes", "Self-contained HTML snapshot size for a representative Nora document", "bytes", 0.1, "Exact UTF-8 snapshot size, including visible evidence and referenced assets."],
  ["vsix_bytes", "Packaged universal Nora VSIX size", "bytes", 0.1, "Exact VSIX file size after packaging the tested extension artifact."],
].map(([id, description, unit, tolerance, rationale, floor]) => ({ id, description, unit, tolerance, rationale, ...(floor ? { floor } : {}) }));

export async function measureBudgets({ samples = 3, onSample = () => {} } = {}) {
  assert(samples >= 3, "budget measurements require at least three samples");
  ensureNoraBuild();
  ensureVsix();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nora-budget-"));
  try {
    const minimalPath = path.join(tempRoot, "minimal.nora");
    await writeMinimalNoraArchive(minimalPath, "Minimal Budget", {
      now: "2026-07-28T00:00:00.000Z",
      idFactory: () => "budget-minimal",
    });
    const representativePath = await createRepresentativeArchive(tempRoot);
    const representative = await NoraDocument.open(fileUri(representativePath), {
      tempRoot: path.join(tempRoot, "hydration-open"),
    });
    const snapshotBytes = await measureSnapshotBytes(representative);
    const values = Object.fromEntries(budgetDefinitions.map(({ id }) => [id, []]));

    for (let sample = 0; sample < samples; sample++) {
      await timed(values, "extension_activation_ms", sample, samples, onSample, async () => {
        measureExtensionActivation();
      });
      await timed(values, "minimal_archive_open_ms", sample, samples, onSample, async () => {
        const document = await NoraDocument.open(fileUri(minimalPath), {
          tempRoot: path.join(tempRoot, `minimal-open-${sample}`),
        });
        await document.dispose();
      });
      await timed(values, "representative_archive_open_ms", sample, samples, onSample, async () => {
        const document = await NoraDocument.open(fileUri(representativePath), {
          tempRoot: path.join(tempRoot, `representative-open-${sample}`),
        });
        await document.dispose();
      });
      await timed(values, "representative_archive_save_ms", sample, samples, onSample, async () => {
        const document = await NoraDocument.open(fileUri(representativePath), {
          tempRoot: path.join(tempRoot, `representative-save-${sample}`),
        });
        await document.commitEvent({ type: "document_title", title: `Representative Budget ${sample}` });
        await document.saveToPath(path.join(tempRoot, `representative-save-${sample}.nora`));
        await document.dispose();
      });
      await timed(values, "webview_hydration_ms", sample, samples, onSample, async () => {
        for (let run = 0; run < 20; run++) JSON.stringify(representative.toHydration());
      }, 20);
      values.streaming_batch_ms.push(measureStreamingBatch());
      onSample("streaming_batch_ms", values.streaming_batch_ms.at(-1), sample + 1, samples);
    }
    await representative.dispose();

    values.snapshot_html_bytes = [snapshotBytes];
    values.vsix_bytes = [(await fs.stat(VSIX)).size];
    return Object.fromEntries(Object.entries(values).map(([id, list]) => [id, {
      value: Math.min(...list),
      samples: list,
    }]));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function ensureNoraBuild() {
  const result = spawnSync(process.execPath, ["scripts/build-nora.mjs", "--outdir", "out"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Nora build failed for performance budgets:\n${result.stderr || result.stdout}`);
  }
}

function ensureVsix() {
  const result = spawnSync("npm", ["run", "package:vsix"], { cwd: ROOT, encoding: "utf8", maxBuffer: 80 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Nora VSIX packaging failed for performance budgets:\n${result.stderr || result.stdout}`);
  }
}

async function createRepresentativeArchive(tempRoot) {
  const filePath = path.join(tempRoot, "representative.nora");
  const document = await NoraDocument.open(fileUri(filePath), {
    tempRoot: path.join(tempRoot, "representative-temp"),
    title: "Representative Budget",
    now: "2026-07-28T00:00:00.000Z",
    idFactory: () => "budget-representative",
  });
  await document.selectProfile("budget-profile");
  const attachment = await addBytesAttachmentToDocument(document, Buffer.from("budget image bytes"), {
    title: "Budget Figure",
    filename: "budget.png",
    mediaType: "image/png",
    now: "2026-07-28T00:00:01.000Z",
    idFactory: idFactory(["source-image", "evidence-image"]),
  });
  for (let index = 0; index < 80; index++) {
    const nodeId = `node-${index}`;
    await document.commitEvent({
      type: "branch_request",
      request_id: nodeId,
      node_id: nodeId,
      parent_id: index === 0 ? "root" : `node-${Math.floor((index - 1) / 3)}`,
      question: `Budget question ${index}`,
      branch_type: "followup",
      position: { x: 360 + (index % 8) * 40, y: Math.floor(index / 8) * 160 },
      size: { w: 320, h: 220 },
      created_at: "2026-07-28T00:00:02.000Z",
    });
    await document.commitEvent({
      type: "node_answered",
      node_id: nodeId,
      parent_id: index === 0 ? "root" : `node-${Math.floor((index - 1) / 3)}`,
      title: `Budget answer ${index}`,
      markdown: `Answer ${index}\n\n${"Nora research evidence. ".repeat(8)}`,
      read: index % 2 === 0,
    });
  }
  await document.commitEvent({
    type: "node_references",
    node_id: "node-0",
    source_ids: [attachment.source.id],
    evidence_ids: [attachment.evidence.id],
    attachment_ids: [attachment.attachment.id],
  });
  await document.saveToPath(filePath);
  await document.dispose();
  return filePath;
}

async function measureSnapshotBytes(document) {
  const noraDocument = documentStateToPersisted(document.state);
  const projection = createNoraSnapshotProjection(noraDocument, noraDocument.viewState, {
    [String(document.state.attachments.values().next().value?.extensions?.assetName ?? "budget.png")]: Buffer.from("budget image bytes").toString("base64"),
  });
  const bundle = await loadSnapshotBundle();
  const html = buildSnapshotHtml({
    title: noraDocument.title,
    snapshotProjection: projection,
    ...bundle,
  });
  return Buffer.byteLength(html);
}

function measureStreamingBatch() {
  const scaleNodes = Array.from({ length: 2000 }, (_, index) => ({
    id: `scale-${index}`,
    parentId: index ? `scale-${Math.floor((index - 1) / 3)}` : null,
    markdown: "",
  }));
  let state = createDocumentState({
    documentId: "scale-doc",
    title: "Scale",
    rootNodeId: "scale-0",
    nodes: scaleNodes,
  });
  const start = performance.now();
  for (let update = 0; update < 100; update++) {
    state = reduceDocumentEvent(state, {
      type: "node_progress",
      node_id: "scale-1999",
      markdown: `chunk ${update}`,
    }).state;
  }
  return performance.now() - start;
}

function measureExtensionActivation() {
  const require = createRequire(import.meta.url);
  const Module = require("node:module");
  const resolved = path.join(ROOT, "out", "extension.cjs");
  const originalLoad = Module._load;
  const vscode = mockVscode();
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[resolved];
    const start = performance.now();
    const extension = require(resolved);
    const context = mockExtensionContext();
    extension.activate(context);
    for (const subscription of context.subscriptions.splice(0).reverse()) {
      subscription?.dispose?.();
    }
    extension.deactivate?.();
    return performance.now() - start;
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

/**
 * @param {Record<string, number[]>} values
 * @param {string} id
 * @param {number} sample
 * @param {number} samples
 * @param {(id: string, value: number, sample: number, samples: number) => void} onSample
 * @param {() => unknown | Promise<unknown>} fn
 * @param {number} [divisor]
 */
async function timed(values, id, sample, samples, onSample, fn, divisor = 1) {
  const start = performance.now();
  await fn();
  const elapsed = (performance.now() - start) / divisor;
  values[id].push(elapsed);
  onSample(id, elapsed, sample + 1, samples);
}

async function loadSnapshotBundle() {
  const read = (name) => fs.readFile(path.join(ROOT, "out/webview", name), "utf8");
  return {
    stylesheetText: `${await read("canvas.css")}\n${await read("katex.css")}`,
    dompurifySource: await read("dompurify.js"),
    mermaidSource: "",
    frozenClientSource: await read("frozen-client.js"),
    pdfJsSource: "",
    pdfWorkerSource: "",
  };
}

function mockVscode() {
  const disposable = () => ({ dispose() {} });
  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }
    fire(event) {
      for (const listener of this.listeners) listener(event);
    }
    dispose() {
      this.listeners.clear();
    }
  }
  return {
    EventEmitter,
    ProgressLocation: { Notification: 15 },
    Uri: {
      file: fileUri,
      joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)),
      parse: (value) => fileUri(new URL(String(value)).pathname),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerCustomEditorProvider: disposable,
      showInformationMessage: async () => null,
      showErrorMessage: async () => null,
      showInputBox: async () => null,
      showQuickPick: async () => null,
      withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable() }),
    },
    workspace: {
      workspaceFolders: [],
      createFileSystemWatcher: () => ({
        onDidCreate: disposable,
        onDidChange: disposable,
        onDidDelete: disposable,
        dispose() {},
      }),
      getWorkspaceFolder: () => null,
      getConfiguration: () => ({ get: () => [] }),
      fs: {
        readFile: async (uri) => fs.readFile(uri.fsPath),
        writeFile: async (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
        delete: async (uri) => fs.rm(uri.fsPath, { force: true, recursive: true }),
      },
    },
    commands: {
      registerCommand: disposable,
      executeCommand: async () => null,
      getCommands: async () => [],
    },
  };
}

function mockExtensionContext() {
  return {
    extensionPath: ROOT,
    extensionUri: fileUri(ROOT),
    globalStorageUri: fileUri(path.join(os.tmpdir(), "nora-budget-global")),
    subscriptions: [],
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: () => ({ dispose() {} }),
    },
  };
}

function idFactory(values) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

function fileUri(filePath) {
  const absolute = path.resolve(filePath);
  return {
    scheme: "file",
    fsPath: absolute,
    path: absolute,
    toString: () => pathToFileURL(absolute).href,
  };
}
