import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDocumentState,
  documentStateToHydrationNodes,
  documentStateToPersisted,
  reduceDocumentEvent,
} from "../core/document-state.js";
import { canonicalJsonBytes } from "./archive/manifest.js";
import { readNoraArchive } from "./archive/reader.js";
import { writeNoraArchive, writeNoraArchiveToPath } from "./archive/writer.js";
import { createNoraArchiveWorkspace } from "./archive/workspace.js";
import { DocumentMutationQueue } from "./document-mutation-queue.js";

/** @typedef {import("../core/contracts/document.js").NoraDocument} PersistedNoraDocument */
/** @typedef {import("../core/contracts/document.js").NoraDocumentState} NoraDocumentState */
/** @typedef {import("../core/contracts/document.js").NoraNodeState} NoraNodeState */
/** @typedef {import("../core/contracts/archive.js").NoraArchiveReadResult} NoraArchiveReadResult */
/** @typedef {import("vscode").Uri} VscodeUri */
/** @typedef {{ documentState: PersistedNoraDocument, runByteCutoffs: Record<string, number> }} MemorySnapshot */
/** @typedef {{ before: MemorySnapshot, after: MemorySnapshot, kind: string, key: string | null }} HistoryEntry */

export class SaveConflictError extends Error {
  constructor() {
    super("Nora document changed while the save snapshot was streaming; retry the save.");
    this.name = "SaveConflictError";
    this.code = "NORA_SAVE_CONFLICT";
  }
}

export class UnsupportedUriSchemeError extends Error {
  /** @param {string} operation @param {unknown} uri */
  constructor(operation, uri) {
    super(`Nora ${operation} supports only local file documents in v1: ${uriToString(uri)}`);
    this.name = "UnsupportedUriSchemeError";
    this.code = "NORA_UNSUPPORTED_URI";
  }
}

export class NoraDocument {
  /**
   * @param {{
   *   uri: VscodeUri,
   *   filePath: string | null,
   *   state: NoraDocumentState,
   *   archiveWorkspace: Awaited<ReturnType<typeof createNoraArchiveWorkspace>>,
   *   previousArchive?: NoraArchiveReadResult | null,
   *   runByteCutoffs?: Record<string, number>,
   *   savedFingerprint?: string | null,
   *   onRequestSave?: (() => unknown | Promise<unknown>) | null
   * }} options
   */
  constructor(options) {
    this.uri = options.uri;
    this.filePath = options.filePath;
    this.state = options.state;
    this.archiveWorkspace = options.archiveWorkspace;
    this.previousArchive = options.previousArchive ?? null;
    this.runByteCutoffs = normalizeCutoffs(options.runByteCutoffs ?? {});
    this.savedFingerprint = options.savedFingerprint ?? fingerprintFor(this.#memorySnapshot());
    this.savedRevision = this.state.revision;
    this.queue = new DocumentMutationQueue();
    /** @type {HistoryEntry[]} */
    this.undoStack = [];
    /** @type {HistoryEntry[]} */
    this.redoStack = [];
    /** @type {{ runId: string, before: MemorySnapshot, after: MemorySnapshot, abort: () => unknown | Promise<unknown> } | null} */
    this.activeRun = null;
    this.disposed = false;
    this.changeEmitter = new SimpleEmitter();
    this.disposeEmitter = new SimpleEmitter();
    this.requestSaveEmitter = new SimpleEmitter();
    if (options.onRequestSave) this.onDidRequestSave(options.onRequestSave);
  }

  /**
   * @param {VscodeUri} uri
   * @param {{
   *   archivePath?: string | null,
   *   untitledDocumentData?: Uint8Array | null,
   *   title?: string,
   *   tempRoot?: string,
   *   now?: string,
   *   idFactory?: () => string
   * }} [options]
   */
  static async open(uri, options = {}) {
    const archiveWorkspace = await createNoraArchiveWorkspace({ rootDir: options.tempRoot ?? os.tmpdir() });
    try {
      const title = options.title ?? titleForUri(uri);
      const filePath = filePathForUri(uri);
      const archivePath = options.archivePath ?? null;
      /** @type {NoraArchiveReadResult | null} */
      let previousArchive = null;
      /** @type {PersistedNoraDocument} */
      let persisted;
      if (archivePath) {
        previousArchive = await readNoraArchive(archivePath);
        persisted = terminalizeInterruptedRuns(previousArchive.document, options.now);
      } else if (options.untitledDocumentData && options.untitledDocumentData.byteLength) {
        const staged = path.join(archiveWorkspace.tempDir, "untitled.nora");
        await fs.writeFile(staged, options.untitledDocumentData);
        previousArchive = await readNoraArchive(staged);
        persisted = terminalizeInterruptedRuns(previousArchive.document, options.now);
      } else if (isFileUri(uri) && filePath && await fileExists(filePath)) {
        previousArchive = await readNoraArchive(filePath);
        persisted = terminalizeInterruptedRuns(previousArchive.document, options.now);
      } else {
        persisted = createMinimalNoraDocument(title, options);
      }

      const runByteCutoffs = runByteCutoffsForArchive(previousArchive);
      const state = createDocumentState({ ...persisted, revision: 0 });
      return new NoraDocument({
        uri,
        filePath,
        state,
        archiveWorkspace,
        previousArchive,
        runByteCutoffs,
        savedFingerprint: previousArchive ? fingerprintFor({ documentState: persisted, runByteCutoffs }) : null,
      });
    } catch (error) {
      await archiveWorkspace.dispose();
      throw error;
    }
  }

  /** @param {(event: { document: NoraDocument, revision: number }) => unknown} listener */
  onDidChange(listener) {
    return this.changeEmitter.event(listener);
  }

  /** @param {() => unknown} listener */
  onDidDispose(listener) {
    return this.disposeEmitter.event(listener);
  }

  /** @param {() => unknown | Promise<unknown>} listener */
  onDidRequestSave(listener) {
    return this.requestSaveEmitter.event(listener);
  }

  get revision() {
    return this.state.revision;
  }

  get isDirty() {
    return fingerprintFor(this.#memorySnapshot()) !== this.savedFingerprint;
  }

  /** @param {unknown} event @param {{ history?: boolean }} [options] */
  async commitWebviewEvent(event, options = {}) {
    return this.commitEvent(event, { history: options.history !== false });
  }

  /**
   * @param {unknown} event
   * @param {{ history?: boolean, runMutation?: boolean }} [options]
   */
  async commitEvent(event, options = {}) {
    return this.queue.enqueue(async () => {
      this.#assertOpen();
      const before = this.#memorySnapshot();
      const previousRevision = this.revision;
      const reduced = reduceDocumentEvent(this.state, /** @type {any} */ (event));
      if (reduced.state.revision === previousRevision) return { committed: false, effects: reduced.effects };
      this.state = reduced.state;
      const after = this.#memorySnapshot();
      if (this.activeRun || options.runMutation === true) {
        if (this.activeRun) this.activeRun.after = after;
      } else if (options.history !== false) {
        this.#pushHistory(before, after, historyKind(event), historyKey(event));
      }
      this.#publishChanged();
      return { committed: true, effects: reduced.effects };
    });
  }

  /**
   * @param {string} runId
   * @param {{ abort?: () => unknown | Promise<unknown> }} [options]
   */
  async beginRun(runId, options = {}) {
    await this.queue.enqueue(() => {
      this.#assertOpen();
      if (this.activeRun) throw new Error("A Nora run is already active for this document");
      const snapshot = this.#memorySnapshot();
      this.activeRun = {
        runId,
        before: snapshot,
        after: snapshot,
        abort: options.abort ?? (() => undefined),
      };
    });
  }

  /**
   * @param {unknown} event
   * @returns {Promise<{ committed: boolean, effects: Record<string, unknown> }>}
   */
  commitRunEvent(event) {
    if (!this.activeRun) return Promise.reject(new Error("No Nora run is active for this document"));
    return this.commitEvent(event, { history: false, runMutation: true });
  }

  async finishActiveRun() {
    await this.queue.enqueue(() => {
      if (!this.activeRun) return;
      if (fingerprintFor(this.activeRun.before) !== fingerprintFor(this.activeRun.after)) {
        this.#pushHistory(this.activeRun.before, this.activeRun.after, "run", this.activeRun.runId);
      }
      this.activeRun = null;
    });
  }

  async undo() {
    await this.queue.enqueue(async () => {
      this.#assertOpen();
      if (this.activeRun) {
        await this.#undoActiveRun();
        return;
      }
      const entry = this.undoStack.pop();
      if (!entry) return;
      this.#restoreSnapshot(entry.before);
      this.redoStack.push(entry);
      this.#publishChanged();
    });
  }

  async redo() {
    await this.queue.enqueue(() => {
      this.#assertOpen();
      if (this.activeRun) throw new Error("Cannot redo while a Nora run is active");
      const entry = this.redoStack.pop();
      if (!entry) return;
      this.#restoreSnapshot(entry.after);
      this.undoStack.push(entry);
      this.#publishChanged();
    });
  }

  /**
   * @param {string} targetPath
   * @param {{
   *   markSaved?: boolean,
   *   uri?: VscodeUri,
   *   writeArchive?: (targetPath: string, snapshot: import("../core/contracts/archive.js").NoraArchiveWriteSnapshot) => Promise<void>,
   *   readArchive?: (targetPath: string) => Promise<NoraArchiveReadResult>
   * }} [options]
   */
  async saveToPath(targetPath, options = {}) {
    const captured = await this.#captureSaveSnapshot();
    const writeArchive = options.writeArchive ?? writeNoraArchive;
    await writeArchive(targetPath, captured.archiveSnapshot);
    await this.queue.enqueue(async () => {
      this.#assertOpen();
      if (this.revision !== captured.revision) throw new SaveConflictError();
      if (options.markSaved !== false) {
        this.savedFingerprint = captured.fingerprint;
        this.savedRevision = this.revision;
        this.filePath = targetPath;
        if (options.uri) this.uri = options.uri;
        const readArchive = options.readArchive ?? readNoraArchive;
        this.previousArchive = await readArchive(targetPath);
        this.state = createDocumentState({ ...captured.documentState, revision: this.revision });
        this.queue.releaseFollowingTurn();
      }
    });
  }

  async save() {
    if (!this.filePath || !isFileUri(this.uri)) throw new UnsupportedUriSchemeError("save", this.uri);
    await this.saveToPath(this.filePath);
  }

  /** @param {VscodeUri} destination */
  async saveAs(destination) {
    if (!isFileUri(destination)) throw new UnsupportedUriSchemeError("save-as", destination);
    await this.saveToPath(requireFilePath(destination, "save-as"), { uri: destination });
  }

  async revert() {
    if (!this.filePath || !isFileUri(this.uri)) throw new UnsupportedUriSchemeError("revert", this.uri);
    const reopened = await readNoraArchive(this.filePath);
    const persisted = terminalizeInterruptedRuns(reopened.document);
    await this.queue.enqueue(() => {
      this.state = createDocumentState({ ...persisted, revision: this.revision + 1 });
      this.previousArchive = reopened;
      this.runByteCutoffs = runByteCutoffsForArchive(reopened);
      this.savedFingerprint = fingerprintFor(this.#memorySnapshot());
      this.savedRevision = this.revision;
      this.undoStack = [];
      this.redoStack = [];
      this.activeRun = null;
      this.#publishChanged();
    });
  }

  /** @param {string} targetPath */
  async backupToPath(targetPath) {
    const captured = await this.#captureSaveSnapshot();
    await writeNoraArchiveToPath(targetPath, captured.archiveSnapshot);
  }

  /** @returns {Promise<void>} */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeRun) {
      await Promise.resolve(this.activeRun.abort()).catch(() => {});
      this.activeRun = null;
    }
    await this.archiveWorkspace.dispose();
    this.disposeEmitter.fire(undefined);
    this.changeEmitter.clear();
    this.disposeEmitter.clear();
    this.requestSaveEmitter.clear();
  }

  toHydration() {
    return {
      session_id: `vscode-${uriToString(this.uri)}`,
      hole_id: this.state.documentId,
      title: this.state.title,
      root_id: this.state.rootNodeId,
      last_event_id: this.state.revision,
      agent_attached: !!this.activeRun,
      view_state: this.state.viewState,
      nodes: documentStateToHydrationNodes(this.state),
      nora: {
        revision: this.state.revision,
        selectedProfileId: this.state.selectedProfileId,
        runByteCutoffs: normalizeCutoffs(this.runByteCutoffs),
      },
    };
  }

  #assertOpen() {
    if (this.disposed) throw new Error("Nora document is disposed");
  }

  #memorySnapshot() {
    return {
      documentState: cloneJson(documentStateToPersisted(this.state)),
      runByteCutoffs: normalizeCutoffs(this.runByteCutoffs),
    };
  }

  async #captureSaveSnapshot() {
    return this.queue.enqueue(() => {
      this.#assertOpen();
      const base = this.#memorySnapshot();
      const logicalRevisionChanged = fingerprintFor(base) !== this.savedFingerprint;
      const previousDocument = this.previousArchive?.document ?? null;
      const updatedAt = logicalRevisionChanged
        ? new Date().toISOString()
        : previousDocument?.updatedAt ?? base.documentState.updatedAt ?? null;
      const documentState = { ...base.documentState, updatedAt };
      const runByteCutoffs = normalizeCutoffs(base.runByteCutoffs);
      const memory = { documentState, runByteCutoffs };
      return {
        revision: this.revision,
        documentState,
        runByteCutoffs,
        fingerprint: fingerprintFor(memory),
        archiveSnapshot: {
          document: documentState,
          previousArchive: this.previousArchive,
          previousDocument,
          createdAt: previousDocument?.createdAt ?? documentState.createdAt,
          updatedAt,
          logicalRevisionChanged,
          ...this.archiveWorkspace.snapshotSources(),
          runByteCutoffs,
        },
      };
    });
  }

  /** @param {MemorySnapshot} snapshot */
  #restoreSnapshot(snapshot) {
    this.state = createDocumentState({ ...cloneJson(snapshot.documentState), revision: this.revision + 1 });
    this.runByteCutoffs = normalizeCutoffs(snapshot.runByteCutoffs);
  }

  async #undoActiveRun() {
    const active = this.activeRun;
    if (!active) return;
    await Promise.resolve(active.abort()).catch(() => {});
    const cancelledAfter = terminalizeRunSnapshot(active.after, active.runId, "cancelled");
    this.activeRun = null;
    this.#restoreSnapshot(active.before);
    this.redoStack.push({
      before: active.before,
      after: cancelledAfter,
      kind: "run",
      key: active.runId,
    });
    this.#publishChanged();
  }

  /**
   * @param {MemorySnapshot} before
   * @param {MemorySnapshot} after
   * @param {string} kind
   * @param {string | null} key
   */
  #pushHistory(before, after, kind, key) {
    if (fingerprintFor(before) === fingerprintFor(after)) return;
    const previous = this.undoStack[this.undoStack.length - 1];
    if (kind === "geometry" && previous?.kind === "geometry" && previous.key === key) {
      previous.after = after;
    } else {
      this.undoStack.push({ before, after, kind, key });
    }
    this.redoStack = [];
  }

  #publishChanged() {
    const event = Object.freeze({ document: this, revision: this.revision });
    this.changeEmitter.fire(event);
    if (fingerprintFor(this.#memorySnapshot()) === this.savedFingerprint) {
      setImmediate(() => this.requestSaveEmitter.fire(undefined));
    }
  }
}

/**
 * @param {string} filePath
 * @param {string} title
 * @param {{ now?: string, idFactory?: () => string }} [options]
 */
export async function writeMinimalNoraArchive(filePath, title, options = {}) {
  const document = createMinimalNoraDocument(title, options);
  await writeNoraArchive(filePath, { document });
  return document;
}

/** @param {string} title @param {{ now?: string, idFactory?: () => string }} [options] @returns {PersistedNoraDocument} */
export function createMinimalNoraDocument(title, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const documentId = options.idFactory?.() ?? randomUUID();
  const safeTitle = String(title || "Untitled").trim() || "Untitled";
  return {
    schemaVersion: 1,
    documentId,
    title: safeTitle,
    rootNodeId: "root",
    createdAt: now,
    updatedAt: now,
    viewState: { mode: "reader", node_id: "root", scroll: 0 },
    selection: null,
    selectedProfileId: null,
    nodes: [{
      id: "root",
      parentId: null,
      title: safeTitle,
      markdown: "",
      baseUrl: null,
      baseUrlSource: null,
      origin: null,
      position: { x: 0, y: 0 },
      size: null,
      fontScale: 1,
      collapsed: false,
      state: "complete",
      read: true,
      createdAt: now,
      updatedAt: now,
      sourceIds: [],
      evidenceIds: [],
      attachmentIds: [],
      runId: null,
      extensions: {},
    }],
    edges: [],
    sources: [],
    evidence: [],
    attachments: [],
    runs: [],
    checks: [],
    extensions: {},
  };
}

/** @param {unknown} uri */
export function titleForUri(uri) {
  const fsPath = filePathForUri(uri);
  const name = fsPath ? path.basename(fsPath) : uriToString(uri).split(/[/?#]/).filter(Boolean).pop() ?? "Untitled";
  return name.replace(/\.nora$/i, "") || "Untitled";
}

/** @param {unknown} uri */
export function isFileUri(uri) {
  return /** @type {{ scheme?: unknown }} */ (uri)?.scheme === "file";
}

/** @param {unknown} uri @param {string} operation */
export function requireFilePath(uri, operation) {
  if (!isFileUri(uri)) throw new UnsupportedUriSchemeError(operation, uri);
  const fsPath = filePathForUri(uri);
  if (!fsPath) throw new UnsupportedUriSchemeError(operation, uri);
  return fsPath;
}

/** @param {unknown} uri */
export function filePathForUri(uri) {
  if (!uri) return null;
  const fsPath = /** @type {{ fsPath?: unknown }} */ (uri).fsPath;
  if (typeof fsPath === "string" && fsPath) return fsPath;
  if (typeof uri === "string" && uri.startsWith("file:")) return fileURLToPath(uri);
  return null;
}

/** @param {unknown} uri */
export function uriToString(uri) {
  if (!uri) return "";
  if (typeof uri === "string") return uri;
  const toString = /** @type {{ toString?: unknown }} */ (uri).toString;
  return typeof toString === "function" ? String(toString.call(uri)) : String(uri);
}

/** @param {MemorySnapshot} snapshot */
export function fingerprintFor(snapshot) {
  const hash = createHash("sha256");
  hash.update(canonicalJsonBytes({
    documentState: snapshot.documentState,
    runByteCutoffs: normalizeCutoffs(snapshot.runByteCutoffs),
  }));
  return hash.digest("hex");
}

/** @param {NoraArchiveReadResult | null} archive */
function runByteCutoffsForArchive(archive) {
  if (!archive) return {};
  /** @type {Record<string, number>} */
  const cutoffs = {};
  for (const [runId, records] of archive.runs) {
    cutoffs[runId] = Buffer.concat(records.map((record) => canonicalJsonBytes(record))).byteLength;
  }
  return cutoffs;
}

/** @param {Record<string, number>} cutoffs */
function normalizeCutoffs(cutoffs) {
  return Object.fromEntries(Object.entries(cutoffs)
    .filter(([runId, cutoff]) => runId && Number.isSafeInteger(cutoff) && cutoff >= 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}

/** @param {string} filePath */
async function fileExists(filePath) {
  return fs.access(filePath).then(
    () => true,
    (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    },
  );
}

/** @param {unknown} value */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {unknown} event */
function historyKind(event) {
  const type = String(/** @type {{ type?: unknown }} */ (event)?.type ?? "");
  return type === "node_update" || type === "nodes_update" ? "geometry" : "normal";
}

/** @param {unknown} event */
function historyKey(event) {
  const raw = /** @type {Record<string, any> | null} */ (event && typeof event === "object" ? event : null);
  if (!raw) return null;
  if (raw.type === "node_update") return String(raw.node_id ?? "");
  if (raw.type === "nodes_update" && Array.isArray(raw.nodes)) {
    return raw.nodes.map((node) => String(node?.node_id ?? "")).sort().join(",");
  }
  return null;
}

/**
 * Persisted running work cannot resume after extension shutdown. This keeps all
 * material but makes the interrupted status explicit on open/recovery.
 * @param {PersistedNoraDocument} document
 * @param {string} [now]
 * @returns {PersistedNoraDocument}
 */
function terminalizeInterruptedRuns(document, now = new Date().toISOString()) {
  const failed = /** @type {NoraNodeState} */ ("failed");
  let changed = false;
  const runningRunIds = new Set();
  const runs = document.runs.map((run) => {
    if (run.status !== "running") return run;
    changed = true;
    runningRunIds.add(run.id);
    return {
      ...run,
      status: failed,
      endedAt: run.endedAt ?? now,
      error: run.error ?? { reason: "interrupted" },
    };
  });
  const nodes = document.nodes.map((node) => {
    if (!node.runId || !runningRunIds.has(node.runId) || node.state !== "running") return node;
    changed = true;
    return { ...node, state: failed, updatedAt: node.updatedAt ?? now };
  });
  return changed ? { ...document, runs, nodes } : document;
}

/** @param {MemorySnapshot} snapshot @param {string} runId @param {"cancelled" | "failed"} status */
function terminalizeRunSnapshot(snapshot, runId, status) {
  const now = new Date().toISOString();
  const nodeState = /** @type {import("../core/contracts/document.js").NoraNodeState} */ (status);
  const runStatus = /** @type {import("../core/contracts/document.js").NoraNodeState} */ (status);
  /** @type {PersistedNoraDocument} */
  const documentState = {
    ...snapshot.documentState,
    runs: snapshot.documentState.runs.map((run) => run.id === runId
      ? { ...run, status: runStatus, endedAt: run.endedAt ?? now, error: run.error ?? (status === "failed" ? { reason: "interrupted" } : null) }
      : run),
    nodes: snapshot.documentState.nodes.map((node) => node.runId === runId && (node.state === "running" || node.state === "pending")
      ? { ...node, state: nodeState, updatedAt: node.updatedAt ?? now }
      : node),
  };
  return {
    documentState,
    runByteCutoffs: normalizeCutoffs(snapshot.runByteCutoffs),
  };
}

class SimpleEmitter {
  constructor() {
    /** @type {Set<(value: any) => unknown>} */
    this.listeners = new Set();
  }

  /** @param {(value: any) => unknown} listener */
  event(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** @param {any} value */
  fire(value) {
    for (const listener of [...this.listeners]) listener(value);
  }

  clear() {
    this.listeners.clear();
  }
}
