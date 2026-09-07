import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { abortError, BridgeError } from "../errors.js";
import { buildCodexInput } from "../messages.js";
import { codexModelEntry } from "../models.js";
import { startingAgent } from "../state.js";
import { resolveExecutable, terminateChild } from "./isolation.js";
import { codexConfigToml, prepareCodexHome } from "../../shared/codex-home.js";
import { armAgentTurnDeadline } from "../../shared/deadline.js";
import { createNdjsonReader } from "../../shared/ndjson.js";
import { openAiUsage, probeAgent } from "./agent.js";

const INITIALIZE_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;
const INSTALL_FIX = "npm install -g @openai/codex";
const LOGIN_FIX = "codex login";

export { codexConfigToml, prepareCodexHome };

function turnError(value) {
  const text = typeof value === "string" ? value : value?.message || "";
  if (/401|unauthori[sz]ed|not logged in|authentication|api key/i.test(text)) {
    return new BridgeError(
      "Codex is signed out. Run `codex login` and try again.",
      "agent_signed_out",
      503
    );
  }
  if (/model.*(?:not found|unknown|access)|unsupported model/i.test(text)) {
    return new BridgeError(
      "Codex could not use that model. Refresh models and try again.",
      "model_unknown",
      400
    );
  }
  return new BridgeError(
    "Codex could not complete the response. Try again.",
    "turn_failed",
    500
  );
}

function findDefaultMode(value) {
  if (!value || typeof value !== "object") return null;
  if (String(value.mode || "").toLowerCase() === "default") return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findDefaultMode(child);
    if (found) return found;
  }
  return null;
}

export function parseCodexEvent(message) {
  const method = message?.method;
  const params = message?.params || {};
  if (method === "turn/started") {
    return {
      type: "turn_started",
      threadId: params.threadId,
      turnId: params.turn?.id,
    };
  }
  if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
    return {
      type: "delta",
      threadId: params.threadId,
      turnId: params.turnId,
      text: params.delta,
    };
  }
  if (method === "item/completed" && params.item?.type === "agentMessage") {
    return {
      type: "completed_text",
      threadId: params.threadId,
      turnId: params.turnId,
      text: typeof params.item.text === "string" ? params.item.text : "",
    };
  }
  if (method === "thread/tokenUsage/updated") {
    return {
      type: "usage",
      threadId: params.threadId,
      turnId: params.turnId,
      usage: openAiUsage(params.tokenUsage?.last),
    };
  }
  if (method === "turn/completed") {
    return {
      type: "turn_completed",
      threadId: params.threadId,
      turnId: params.turn?.id,
      status: params.turn?.status,
      error: params.turn?.error,
    };
  }
  return null;
}

export class CodexAppServer {
  constructor({ executable, env, cwd, version }) {
    this.executable = executable;
    this.env = env;
    this.cwd = cwd;
    this.version = version;
    this.child = null;
    this.reader = createNdjsonReader({ onRecord: (message) => this.onMessage(message) });
    this.pending = new Map();
    this.turns = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.initialized = false;
    this.account = null;
    this.planType = null;
    this.lastProtocolError = null;
    this.executeMode = null;
    this.modeList = null;
    this.closed = false;
  }

  async ensureStarted() {
    if (this.closed) throw new BridgeError("Codex is shutting down.", "turn_failed", 500);
    if (this.child && this.initialized) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  async start() {
    if (!this.executable) {
      throw new BridgeError("Codex is not installed", "agent_missing", 503);
    }
    const child = spawn(this.executable, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.reader.reset();
    this.initialized = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk, child));
    child.stderr.resume();
    child.stdin.once("error", () => this.onCrash(child));
    child.once("error", () => this.onCrash(child));
    child.once("close", () => this.onCrash(child));

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "rabbithole_bridge",
          title: "Rabbithole Bridge",
          version: this.version,
        },
        capabilities: { experimentalApi: true },
      }, {
        timeoutMs: INITIALIZE_TIMEOUT_MS,
        timeoutCode: "agent_missing",
      });
      this.notify("initialized", {});
      this.initialized = true;
      const modes = await this.request("collaborationMode/list");
      this.modeList = modes;
      this.executeMode = findDefaultMode(modes);
      if (!this.executeMode) {
        throw new BridgeError("Codex does not expose Default mode.", "turn_failed", 500);
      }
      await this.refreshAccount();
    } catch (error) {
      terminateChild(child);
      throw error;
    }
  }

  onStdout(chunk, child) {
    if (child !== this.child) return;
    try {
      this.reader.push(chunk);
    } catch {
      this.onCrash(child, new BridgeError("Codex returned an oversized response.", "turn_failed", 500));
      terminateChild(child);
    }
  }

  onMessage(message) {
    if (message && Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        this.lastProtocolError = message.error;
        pending.reject(turnError(message.error));
      }
      else pending.resolve(message.result);
      return;
    }

    const event = parseCodexEvent(message);
    if (!event?.threadId) return;
    const turn = this.turns.get(event.threadId);
    if (!turn || (event.turnId && turn.turnId && event.turnId !== turn.turnId)) return;
    if (event.type === "turn_started") {
      turn.turnId = event.turnId || turn.turnId;
      if (!turn.started) {
        turn.started = true;
        turn.resolveStarted();
      }
      if (turn.aborted) void this.interrupt(turn);
    } else if (event.type === "delta") {
      turn.turnId = event.turnId || turn.turnId;
      turn.streamedText += event.text;
      try {
        turn.onDelta(event.text);
      } catch (error) {
        turn.reject(error);
      }
    } else if (event.type === "completed_text") {
      turn.authoritativeText = event.text;
      if (event.text.startsWith(turn.streamedText)) {
        const suffix = event.text.slice(turn.streamedText.length);
        if (suffix) {
          turn.streamedText += suffix;
          turn.onDelta(suffix);
        }
      }
    } else if (event.type === "usage") {
      turn.usage = event.usage || turn.usage;
    } else if (event.type === "turn_completed") {
      this.turns.delete(event.threadId);
      if (event.status === "completed" && !event.error) {
        turn.resolve({
          text: turn.authoritativeText || turn.streamedText,
          usage: turn.usage,
          finishReason: "stop",
        });
      } else if (event.status === "interrupted" && turn.aborted) {
        turn.reject(abortError(turn.signal));
      } else {
        turn.reject(turnError(event.error || event.status));
      }
    }
  }

  onCrash(child, error) {
    if (child !== this.child) return;
    this.child = null;
    this.initialized = false;
    this.account = null;
    this.planType = null;
    const failure = error instanceof BridgeError
      ? error
      : new BridgeError(
        this.closed ? "Codex shut down." : "Codex stopped unexpectedly.",
        "turn_failed",
        500
      );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(failure);
    this.turns.clear();
  }

  request(method, params = {}, {
    timeoutMs = REQUEST_TIMEOUT_MS,
    timeoutCode = "turn_failed",
  } = {}) {
    if (!this.child || this.child.stdin.destroyed) {
      return Promise.reject(new BridgeError("Codex is not ready.", "turn_failed", 500));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(
          "Codex did not respond in time.",
          timeoutCode,
          timeoutCode === "agent_missing" ? 503 : 500
        ));
        terminateChild(this.child);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError("Could not send a request to Codex.", "turn_failed", 500));
      });
    });
  }

  notify(method, params = {}) {
    if (this.child && !this.child.stdin.destroyed) {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  async refreshAccount() {
    const result = await this.request("account/read");
    this.account = result?.account || null;
    this.planType = result?.planType || this.account?.planType || null;
    return this.account;
  }

  async fetchModels() {
    const models = [];
    let cursor;
    do {
      const result = await this.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      for (const model of result?.data || []) {
        if (model?.model && model.hidden !== true) models.push(codexModelEntry(model));
      }
      cursor = result?.nextCursor || null;
    } while (cursor);
    return models;
  }

  async interrupt(turn) {
    if (turn.interruptSent) return;
    turn.interruptSent = true;
    try {
      await turn.startedPromise;
      if (!turn.turnId || !this.child) return;
      await this.request("turn/interrupt", {
        threadId: turn.threadId,
        turnId: turn.turnId,
      });
    } catch {
      // Cancellation is already complete from the caller's perspective.
    }
  }

  executionMode({ model, effort, developerInstructions }) {
    if (!this.executeMode) {
      throw new BridgeError("Codex Execute mode is unavailable.", "turn_failed", 500);
    }
    return {
      mode: this.executeMode.mode,
      settings: {
        model,
        reasoning_effort: effort,
        developer_instructions: developerInstructions,
      },
    };
  }

  async turn({
    model,
    messages,
    reasoningEffort,
    signal,
    onDelta,
  }) {
    const codexInput = buildCodexInput(messages);
    if (codexInput.imagePartCount !== codexInput.imageCount) {
      throw new BridgeError(
        "Codex image input must use an embedded base64 data URL.",
        "turn_failed",
        400
      );
    }

    const requestCwd = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-codex-turn-"));
    await fs.chmod(requestCwd, 0o700);
    try {
      const threadResult = await this.request("thread/start", {
        model,
        cwd: requestCwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: codexInput.systemPrompt,
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
      });
      const threadId = threadResult?.thread?.id;
      if (!threadId) {
        throw new BridgeError("Codex could not start the response.", "turn_failed", 500);
      }
      if (signal?.aborted) throw abortError(signal);

      let resolveTurn;
      let rejectTurn;
      let resolveStarted;
      const completion = new Promise((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      const startedPromise = new Promise((resolve) => {
        resolveStarted = resolve;
      });
      const turn = {
        threadId,
        turnId: null,
        signal,
        onDelta,
        streamedText: "",
        authoritativeText: "",
        usage: undefined,
        resolve: resolveTurn,
        reject: rejectTurn,
        started: false,
        resolveStarted,
        startedPromise,
        aborted: false,
        interruptSent: false,
      };
      this.turns.set(threadId, turn);
      const onAbort = () => {
        turn.aborted = true;
        void this.interrupt(turn);
        rejectTurn(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const clearTurnDeadline = armAgentTurnDeadline(() => {
        turn.aborted = true;
        void this.interrupt(turn);
        rejectTurn(new BridgeError("Codex turn exceeded 300 seconds.", "turn_failed", 500));
      });

      try {
        const response = await this.request("turn/start", {
          threadId,
          input: codexInput.input,
          cwd: requestCwd,
          environments: [],
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          model,
          effort: reasoningEffort,
          summary: "none",
          collaborationMode: this.executionMode({
            model,
            effort: reasoningEffort,
            developerInstructions: codexInput.systemPrompt,
          }),
        });
        turn.turnId = response?.turn?.id || turn.turnId;
        if (turn.aborted) void this.interrupt(turn);
        return await completion;
      } finally {
        clearTurnDeadline();
        signal?.removeEventListener("abort", onAbort);
        if (!turn.aborted) this.turns.delete(threadId);
      }
    } finally {
      await fs.rm(requestCwd, { recursive: true, force: true });
    }
  }

  close() {
    this.closed = true;
    if (this.child) terminateChild(this.child);
    this.onCrash(this.child);
  }
}

export class CodexBackend {
  constructor({ executable, env, cwd, bridgeVersion }) {
    this.executable = executable;
    this.appServer = new CodexAppServer({
      executable,
      env,
      cwd,
      version: bridgeVersion,
    });
  }

  static async create({
    env = process.env,
    cwd,
    bridgeVersion,
    configSuffix = "",
  }) {
    const codexHome = await prepareCodexHome({ env, configSuffix });
    const codexEnv = { ...env, CODEX_HOME: codexHome };
    return new CodexBackend({
      executable: resolveExecutable(
        "codex",
        env.RABBITHOLE_BRIDGE_CODEX_BIN,
        env
      ),
      env: codexEnv,
      cwd,
      bridgeVersion,
    });
  }

  initialState() {
    return startingAgent("codex", "Starting Codex");
  }

  warmup() {
    if (this.executable) void this.appServer.ensureStarted().catch(() => {});
  }

  async status() {
    if (!this.executable) return { installed: false, signedIn: false, plan: null };
    await this.appServer.ensureStarted();
    await this.appServer.refreshAccount();
    return {
      installed: true,
      signedIn: Boolean(this.appServer.account),
      plan: this.appServer.planType
        || (this.appServer.account?.type === "apiKey" ? "api_key" : "chatgpt"),
    };
  }

  async listModels() {
    const status = await this.status();
    if (!status.signedIn) {
      throw new BridgeError(
        "Codex is signed out. Run `codex login` and try again.",
        "agent_signed_out",
        503
      );
    }
    const models = await this.appServer.fetchModels();
    if (!models.length) {
      throw new BridgeError("Codex returned an empty model list.", "turn_failed", 500);
    }
    return models;
  }

  async probe() {
    return probeAgent({
      name: "codex",
      executable: this.executable,
      installFix: INSTALL_FIX,
      loginFix: LOGIN_FIX,
      errorFix: "codex login",
      status: () => this.status(),
      models: () => this.appServer.fetchModels(),
    });
  }

  // The route (server.js handleChat) validates model, image capability, and
  // reasoning effort against the live catalog it fetches from this backend
  // immediately before calling generate — no re-validation here.
  async generate({ model, messages, reasoningEffort, signal, onDelta = () => {} }) {
    if (signal?.aborted) throw abortError(signal);
    await this.appServer.ensureStarted();
    return this.appServer.turn({ model, messages, reasoningEffort, signal, onDelta });
  }

  close() {
    this.appServer.close();
  }
}
