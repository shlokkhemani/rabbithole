import { randomUUID } from "node:crypto";
import { buildRunContext } from "./context-builder.js";
import { createNoraPiSession, estimateNoraTokens } from "./pi-session.js";
import {
  assistantCheckpointRecord,
  assistantText,
  committedMessageRecords,
  normalizeError,
  runTerminalRecord,
  traceEntriesFromRecords,
} from "./transcript.js";
import { createModelRuntimeForSelectedDocument } from "../llm/model-runtime.js";
import { NoraResourceLoaderProvider } from "./resource-loader.js";

const CHECKPOINT_INTERVAL_MS = 100;
const CHECKPOINT_BYTES = 4 * 1024;

export class NoraRunController {
  /**
   * @param {{
   *   vscode?: typeof import("vscode"),
   *   secretStorage?: import("../llm/secret-credential-store.js").SecretStorageLike,
   *   createModelRuntime?: typeof createModelRuntimeForSelectedDocument,
   *   createPiSession?: typeof createNoraPiSession,
   *   resourceLoaderProviderFactory?: (document: import("../nora-document.js").NoraDocument) => NoraResourceLoaderProvider,
   *   idFactory?: () => string,
   *   now?: () => string,
   *   estimateTokens?: (text: string) => number,
   *   pi?: Record<string, unknown>
   * }} [options]
   */
  constructor(options = {}) {
    this.vscode = options.vscode;
    this.secretStorage = options.secretStorage;
    this.createModelRuntime = options.createModelRuntime ?? createModelRuntimeForSelectedDocument;
    this.createPiSession = options.createPiSession ?? createNoraPiSession;
    this.resourceLoaderProviderFactory = options.resourceLoaderProviderFactory ?? ((document) => new NoraResourceLoaderProvider({
      workspaceFolderPath: workspaceFolderPathFor(this.vscode, document),
    }));
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.estimateTokens = options.estimateTokens ?? estimateNoraTokens;
    this.pi = options.pi;
    /** @type {WeakMap<import("../nora-document.js").NoraDocument, NoraResourceLoaderProvider>} */
    this.resourceLoaders = new WeakMap();
  }

  /**
   * @param {import("../nora-document.js").NoraDocument} document
   * @param {Record<string, unknown>} event
   */
  async startFromWebviewEvent(document, event) {
    if (event.type !== "branch_request" && event.type !== "nora_ask") {
      throw new TypeError(`Unsupported Nora run event: ${String(event.type)}`);
    }
    const prepared = this.#prepareAsk(document, event);
    const modelRuntimeBundle = await this.#createModelRuntime(document);
    const context = buildRunContext(document, {
      prompt: prepared.prompt,
      scope: prepared.scope,
      model: modelRuntimeBundle.model,
      estimateTokens: this.estimateTokens,
    });
    const resourceLoader = await this.#resourceLoader(document).createForNextRun();
    const runId = this.idFactory();
    const startedAt = this.now();
    const agentPrompt = renderAgentPrompt(context);
    const piSession = await this.createPiSession({
      document,
      modelRuntimeBundle,
      resourceLoader,
      transcriptRecords: this.#ancestorTranscriptRecords(document, context.parentRunId),
      cwd: workspaceFolderPathFor(this.vscode, document) ?? process.cwd(),
      runId,
      pi: /** @type {any} */ (this.pi),
    });
    const active = new ActiveNoraRun({
      document,
      runId,
      targetNodeId: prepared.targetNodeId,
      prompt: prepared.prompt,
      agentPrompt,
      context,
      provenance: modelRuntimeBundle.provenance,
      session: piSession.session,
      now: this.now,
    });
    await document.beginRun(runId, { abort: () => active.cancel({ publish: false }) });
    await active.publishStart(prepared.branchEvent, startedAt);
    active.start();
    return { runId, targetNodeId: prepared.targetNodeId };
  }

  /**
   * @param {import("../nora-document.js").NoraDocument} document
   * @param {Record<string, unknown>} event
   */
  #prepareAsk(document, event) {
    if (event.type === "branch_request") {
      const prompt = String(event.question ?? "").trim() || String(event.lens ?? "").trim() || "Ask Nora";
      const targetNodeId = String(event.node_id ?? event.nodeId ?? "");
      if (!targetNodeId) throw new TypeError("branch_request node_id is required");
      const parentNodeId = String(event.parent_id ?? event.parentId ?? "");
      const scope = event.scope ?? (parentNodeId ? { type: "node", node_id: parentNodeId } : { type: "whole_canvas" });
      return { prompt, scope, targetNodeId, branchEvent: event };
    }
    const prompt = String(event.prompt ?? "").trim();
    if (!prompt) throw new TypeError("Ask Nora prompt is required");
    const targetNodeId = String(event.request_id ?? this.idFactory());
    const root = document.state.nodes.get(document.state.rootNodeId);
    const branchEvent = {
      type: "branch_request",
      request_id: targetNodeId,
      node_id: targetNodeId,
      parent_id: document.state.rootNodeId,
      question: prompt,
      lens: event.lens ?? null,
      selected_text: "",
      anchor: null,
      scope: { type: "whole_canvas" },
      branch_type: "followup",
      position: { x: Number(root?.position?.x ?? 0) + 360, y: Number(root?.position?.y ?? 0) },
      size: { w: 320, h: 220 },
      created_at: this.now(),
    };
    return { prompt, scope: { type: "whole_canvas" }, targetNodeId, branchEvent };
  }

  /** @param {import("../nora-document.js").NoraDocument} document */
  async #createModelRuntime(document) {
    if (!this.vscode || !this.secretStorage) {
      return {
        profile: { id: "test-profile", provider: "fake", model: "fake-model" },
        runtimeProviderId: "fake",
        modelRuntime: {},
        model: { provider: "fake", id: "fake-model", contextWindow: 128000 },
        provenance: { profileId: document.state.selectedProfileId ?? "test-profile", provider: "fake", model: "fake-model", endpoint: null },
      };
    }
    return this.createModelRuntime(document, this.vscode, this.secretStorage);
  }

  /** @param {import("../nora-document.js").NoraDocument} document */
  #resourceLoader(document) {
    let loader = this.resourceLoaders.get(document);
    if (!loader) {
      loader = this.resourceLoaderProviderFactory(document);
      this.resourceLoaders.set(document, loader);
      document.onDidDispose(() => loader?.dispose());
    }
    return loader;
  }

  /**
   * @param {import("../nora-document.js").NoraDocument} document
   * @param {string | null} parentRunId
   */
  #ancestorTranscriptRecords(document, parentRunId) {
    if (!parentRunId) return [];
    const runs = document.state.runs;
    const records = [];
    const seen = new Set();
    let cursor = runs.get(parentRunId) ?? null;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      records.unshift(...document.getRunTranscriptRecords(cursor.id));
      cursor = cursor.parentRunId ? runs.get(cursor.parentRunId) ?? null : null;
    }
    return records;
  }
}

class ActiveNoraRun {
  /**
   * @param {{
   *   document: import("../nora-document.js").NoraDocument,
   *   runId: string,
   *   targetNodeId: string,
   *   prompt: string,
   *   agentPrompt: string,
   *   context: import("./context-builder.js").NoraRunContext,
   *   provenance: { profileId?: string | null, provider?: string | null, model?: string | null, endpoint?: string | null },
   *   session: { subscribe(listener: (event: any) => unknown): (() => void), prompt(text: string, options?: Record<string, unknown>): Promise<void>, waitForIdle?: () => Promise<void>, abort?: () => Promise<void>, dispose?: () => void },
   *   now: () => string
   * }} options
   */
  constructor(options) {
    this.document = options.document;
    this.runId = options.runId;
    this.targetNodeId = options.targetNodeId;
    this.prompt = options.prompt;
    this.agentPrompt = options.agentPrompt;
    this.context = options.context;
    this.provenance = options.provenance;
    this.session = options.session;
    this.now = options.now;
    this.cancelled = false;
    this.terminal = false;
    this.sequence = 0;
    this.messageSequence = 0;
    /** @type {string | null} */
    this.currentAssistantMessageId = null;
    this.latestAssistantMarkdown = "";
    this.lastCheckpointAt = 0;
    this.lastCheckpointBytes = 0;
    this.initialUserSeen = false;
    /** @type {(() => void) | null} */
    this.unsubscribe = null;
    /** @type {Promise<void>} */
    this.eventTail = Promise.resolve();
  }

  /** @param {Record<string, unknown>} branchEvent @param {string} startedAt */
  async publishStart(branchEvent, startedAt) {
    const userMessage = {
      role: "user",
      content: this.agentPrompt,
      timestamp: Date.parse(startedAt) || Date.now(),
    };
    const [record] = committedMessageRecords(this.runId, userMessage, {
      messageId: `${this.runId}:user`,
      sequence: this.messageSequence++,
      now: startedAt,
    });
    const run = this.#runSummary("running", {
      startedAt,
      extensions: {
        context: {
          scope: this.context.scope,
          includedNodeIds: this.context.includedNodeIds,
          evidenceIds: this.context.evidenceIds,
          estimatedTokens: this.context.estimatedTokens,
          contextWindow: this.context.contextWindow,
        },
        trace: traceEntriesFromRecords([record]),
      },
    });
    await this.document.publishRunRecord(this.runId, record, [
      branchEvent,
      { type: "run_summary", run },
      { type: "node_run", node_id: this.targetNodeId, run_id: this.runId, updated_at: startedAt },
      { type: "node_state", node_id: this.targetNodeId, state: "running", updated_at: startedAt },
    ]);
  }

  start() {
    this.unsubscribe = this.session.subscribe((/** @type {any} */ event) => {
      this.eventTail = this.eventTail.then(() => this.#handleSessionEvent(event)).catch((error) => {
        void this.#terminalize("failed", error);
      });
    });
    void this.session.prompt(this.agentPrompt, { source: "extension" })
      .then(() => this.session.waitForIdle?.())
      .then(() => this.eventTail)
      .then(() => this.#terminalize(this.cancelled ? "cancelled" : "complete"))
      .catch((/** @type {unknown} */ error) => this.#terminalize(this.cancelled ? "cancelled" : "failed", error));
  }

  /** @param {{ publish?: boolean }} [options] */
  async cancel(options = {}) {
    this.cancelled = true;
    await Promise.resolve(this.session.abort?.()).catch(() => {});
    if (options.publish !== false) await this.#terminalize("cancelled");
  }

  /** @param {any} event */
  async #handleSessionEvent(event) {
    if (this.terminal || this.cancelled) return;
    if (event?.type === "message_update") {
      await this.#maybePublishCheckpoint(event.assistantMessageEvent?.partial ?? event.message);
      return;
    }
    if (event?.type === "tool_execution_start") {
      await this.#publishRecord({
        kind: "tool_call",
        runId: this.runId,
        messageId: `${this.runId}:tool:${String(event.toolCallId)}`,
        createdAt: this.now(),
        toolCallId: String(event.toolCallId),
        toolName: String(event.toolName),
        arguments: cloneJson(event.args ?? {}),
      });
      return;
    }
    if (event?.type !== "message_end") return;
    const message = event.message;
    if (message?.role === "user" && !this.initialUserSeen && message.content === this.agentPrompt) {
      this.initialUserSeen = true;
      return;
    }
    if (message?.role === "assistant" && this.currentAssistantMessageId === null) {
      this.currentAssistantMessageId = `${this.runId}:assistant:${this.messageSequence}`;
    }
    const messageId = message?.role === "assistant"
      ? this.currentAssistantMessageId ?? `${this.runId}:assistant:${this.messageSequence}`
      : `${this.runId}:msg:${this.messageSequence}`;
    const records = committedMessageRecords(this.runId, message, {
      messageId,
      sequence: this.messageSequence++,
      now: this.now(),
    });
    for (const [index, record] of records.entries()) {
      const events = [];
      if (record.kind === "assistant_message" && message?.role === "assistant") {
        this.latestAssistantMarkdown = assistantText(message);
        events.push({
          type: "node_progress",
          node_id: this.targetNodeId,
          markdown: this.latestAssistantMarkdown,
          run: { id: this.runId, seq: ++this.sequence },
        });
      }
      await this.#publishRecord(record, events);
      if (index === records.length - 1 && message?.role === "assistant") this.currentAssistantMessageId = null;
    }
  }

  /** @param {unknown} partialMessage */
  async #maybePublishCheckpoint(partialMessage) {
    const markdown = assistantText(partialMessage);
    if (!markdown) return;
    if (this.currentAssistantMessageId === null) this.currentAssistantMessageId = `${this.runId}:assistant:${this.messageSequence}`;
    const nowMs = Date.now();
    const bytes = Buffer.byteLength(markdown, "utf8");
    if (nowMs - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS && bytes - this.lastCheckpointBytes < CHECKPOINT_BYTES) return;
    this.lastCheckpointAt = nowMs;
    this.lastCheckpointBytes = bytes;
    this.latestAssistantMarkdown = markdown;
    const record = assistantCheckpointRecord(this.runId, this.currentAssistantMessageId, partialMessage, {
      sequence: ++this.sequence,
      now: this.now(),
    });
    await this.#publishRecord(record, [{
      type: "node_progress",
      node_id: this.targetNodeId,
      markdown,
      run: { id: this.runId, seq: this.sequence },
    }]);
  }

  /**
   * @param {Record<string, unknown>} record
   * @param {unknown[]} [events]
   */
  async #publishRecord(record, events = []) {
    const currentRecords = [...this.document.getRunTranscriptRecords(this.runId), record];
    const run = this.#runSummary("running", { extensions: { trace: traceEntriesFromRecords(currentRecords), context: this.#contextSummary() } });
    await this.document.publishRunRecord(this.runId, record, [
      ...events,
      { type: "run_summary", run },
    ]);
  }

  /**
   * @param {"complete" | "cancelled" | "failed"} status
   * @param {unknown} [error]
   */
  async #terminalize(status, error = null) {
    if (this.terminal) return;
    this.terminal = true;
    const endedAt = this.now();
    const terminalRecord = runTerminalRecord(this.runId, status, { error, now: endedAt });
    /** @type {unknown[]} */
    const events = [];
    if (status === "complete") {
      events.push({
        type: "node_answered",
        parent_id: this.document.state.nodes.get(this.targetNodeId)?.parentId,
        node_id: this.targetNodeId,
        title: this.#title(),
        markdown: this.latestAssistantMarkdown,
        read: false,
      });
    } else {
      events.push({ type: "node_state", node_id: this.targetNodeId, state: status, updated_at: endedAt });
    }
    const records = [...this.document.getRunTranscriptRecords(this.runId), terminalRecord];
    events.push({
      type: "run_summary",
      run: this.#runSummary(status, {
        endedAt,
        error: status === "failed" ? normalizeError(error) : null,
        extensions: { trace: traceEntriesFromRecords(records), context: this.#contextSummary() },
      }),
    });
    try {
      await this.document.publishRunRecord(this.runId, terminalRecord, events);
      await this.document.finishActiveRun();
    } finally {
      this.unsubscribe?.();
      this.session.dispose?.();
    }
  }

  /** @param {"running" | "complete" | "cancelled" | "failed"} status @param {Record<string, unknown>} [overrides] */
  #runSummary(status, overrides = {}) {
    return {
      id: this.runId,
      parentRunId: this.context.parentRunId,
      targetNodeId: this.targetNodeId,
      status,
      prompt: this.prompt,
      profileId: this.provenance.profileId ?? null,
      provider: this.provenance.provider ?? null,
      model: this.provenance.model ?? null,
      endpoint: this.provenance.endpoint ?? null,
      startedAt: null,
      endedAt: null,
      error: null,
      transcriptPath: `runs/${this.runId}.jsonl`,
      extensions: { context: this.#contextSummary() },
      ...overrides,
    };
  }

  #contextSummary() {
    return {
      scope: this.context.scope,
      includedNodeIds: this.context.includedNodeIds,
      evidenceIds: this.context.evidenceIds,
      estimatedTokens: this.context.estimatedTokens,
      contextWindow: this.context.contextWindow,
    };
  }

  #title() {
    const trimmed = this.prompt.replace(/\s+/g, " ").trim();
    return trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed || "Nora result";
  }
}

/** @param {import("vscode") | undefined} vscode @param {import("../nora-document.js").NoraDocument} document */
function workspaceFolderPathFor(vscode, document) {
  const uri = /** @type {import("vscode").Uri | null} */ (document.uri ?? null);
  if (!vscode?.workspace || !uri) return null;
  const folder = vscode.workspace.getWorkspaceFolder?.(uri);
  if (folder?.uri?.fsPath) return folder.uri.fsPath;
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length === 1 ? folders[0].uri.fsPath : null;
}

/** @param {import("./context-builder.js").NoraRunContext} context */
function renderAgentPrompt(context) {
  return [
    context.projection,
    "",
    "User prompt:",
    context.prompt,
  ].join("\n");
}

/** @param {unknown} value */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
