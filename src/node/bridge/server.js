import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { systemClock } from "../../core/clock.js";

import { ClaudeBackend } from "./agents/claude.js";
import { CodexBackend } from "./agents/codex.js";
import { applyCors, isAllowedOrigin } from "./cors.js";
import { openEventStream } from "./events.js";
import {
  BridgeError,
  bridgeError,
  errorBody,
  isAbortError,
} from "./errors.js";
import { countImageParts } from "./messages.js";
import { routeModelId } from "./models.js";
import { BridgeStateStore } from "./state.js";
import { readOrCreateBridgeToken, tokenMatches } from "./token.js";
import {
  closeServerGracefully,
  parseRequestBody,
} from "../shared/http.js";
import { assertHttpRequest } from "../shared/http-guard.js";
import { errorCode, errorStatusCode } from "../shared/errno.js";
import { AGENT_TURN_DEADLINE_MS } from "../shared/deadline.js";
import { shortId } from "../shared/ids.js";

const HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = AGENT_TURN_DEADLINE_MS;
const BRIDGE_MAX_BODY_BYTES = 16 * 1024 * 1024;

function sendJson(res, statusCode, body) {
  if (res.writableEnded || res.destroyed) return;
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendBridgeError(res, error) {
  const normalized = error instanceof BridgeError ? error : bridgeError(error);
  if (normalized.code === "unauthorized") {
    sendJson(res, 401, { error: { code: "unauthorized" } });
    return;
  }
  const payload = errorBody(normalized);
  sendJson(res, payload.statusCode, payload.body);
}

function completionId() {
  return `chatcmpl-${shortId()}`;
}

function sseData(res, value) {
  if (!res.destroyed && !res.writableEnded) {
    res.write(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
  }
}

function isJsonContentType(value) {
  return /^application\/json(?:\s*;|$)/i.test(String(value || ""));
}

function hasMessageContent(messages) {
  return messages.some((message) => {
    if (typeof message?.content === "string") return Boolean(message.content.trim());
    if (!Array.isArray(message?.content)) return false;
    return message.content.some((part) => (
      (part?.type === "text" && typeof part.text === "string" && Boolean(part.text.trim()))
      || part?.type === "image_url"
    ));
  });
}

/** @param {unknown} error */
function requestError(error) {
  if (error instanceof BridgeError) return error;
  const statusCode = errorStatusCode(error);
  if (statusCode !== undefined) {
    return new BridgeError(error instanceof Error ? error.message : String(error), "turn_failed", statusCode);
  }
  return bridgeError(error);
}

/** @param {{port?: number, env?: NodeJS.ProcessEnv, version?: string, logger?: {warn?: (...args: any[]) => void}, newToken?: boolean, stateRefreshMs?: number, codexConfigSuffix?: string}} [options] */
export async function createBridge({
  port = 41414,
  env = process.env,
  version = "0.0.0",
  logger,
  newToken = false,
  stateRefreshMs,
  codexConfigSuffix = "",
} = {}) {
  const { token, created: tokenCreated } = await readOrCreateBridgeToken({
    env,
    regenerate: newToken,
  });
  const claudeCwd = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-bridge-claude-"));
  const codexCwd = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-bridge-codex-"));
  await Promise.all([fs.chmod(claudeCwd, 0o700), fs.chmod(codexCwd, 0o700)]);

  let claude;
  let codex;
  try {
    claude = ClaudeBackend.create({ env, cwd: claudeCwd });
    codex = await CodexBackend.create({
      env,
      cwd: codexCwd,
      bridgeVersion: version,
      configSuffix: codexConfigSuffix,
    });
  } catch (error) {
    await Promise.allSettled([
      fs.rm(claudeCwd, { recursive: true, force: true }),
      fs.rm(codexCwd, { recursive: true, force: true }),
    ]);
    throw error;
  }

  const state = new BridgeStateStore({
    version,
    backends: { claude, codex },
    logger,
    ...(stateRefreshMs ? { refreshMs: stateRefreshMs } : {}),
  });
  let actualPort = port;
  let closing = false;
  const activeControllers = new Set();

  async function models() {
    const settled = await Promise.allSettled([
      claude.listModels(),
      codex.listModels(),
    ]);
    return settled
      .filter((result) => result.status === "fulfilled")
      .flatMap((result) => result.value);
  }

  async function handleChat(req, res, body) {
    let streamStarted = false;
    let clientAborted = false;
    let timedOut = false;
    const controller = new AbortController();
    activeControllers.add(controller);
    const abortForClient = () => {
      if (res.writableEnded) return;
      clientAborted = true;
      controller.abort();
    };
    const onResponseClose = () => {
      if (!res.writableEnded) abortForClient();
    };
    req.once("aborted", abortForClient);
    res.once("close", onResponseClose);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new BridgeError(
        "Agent turn exceeded 300 seconds.",
        "turn_failed",
        500
      ));
    }, REQUEST_TIMEOUT_MS);

    const startStream = () => {
      if (streamStarted || res.destroyed) return;
      streamStarted = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
    };

    try {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new BridgeError("Request body must be a JSON object.", "turn_failed", 400);
      }
      const route = routeModelId(body.model);
      if (!route) {
        throw new BridgeError(
          "Model must use the claude/<alias> or codex/<model> namespace.",
          "model_unknown",
          400
        );
      }
      if (!Array.isArray(body.messages) || !hasMessageContent(body.messages)) {
        throw new BridgeError(
          "messages must contain text or image input.",
          "turn_failed",
          400
        );
      }

      const backend = route.backend === "claude" ? claude : codex;
      const catalog = await backend.listModels();
      const modelEntry = catalog.find((entry) => entry.id === body.model);
      if (!modelEntry) {
        throw new BridgeError(`Unknown model "${body.model}".`, "model_unknown", 400);
      }
      if (countImageParts(body.messages) > 0 && modelEntry.images !== true) {
        throw new BridgeError(
          `Model "${body.model}" cannot accept image input.`,
          "model_no_images",
          400
        );
      }
      const effort = body.reasoning_effort || modelEntry.reasoning.default;
      if (!modelEntry.reasoning.options.includes(effort)) {
        throw new BridgeError(
          `Model "${body.model}" does not support that reasoning effort.`,
          "turn_failed",
          400
        );
      }

      const stream = body.stream === true;
      const id = completionId();
      const created = Math.floor(systemClock.now() / 1000);
      const result = await backend.generate({
        model: route.model,
        messages: body.messages,
        reasoningEffort: effort,
        signal: controller.signal,
        onDelta(text) {
          if (!stream || !text) return;
          startStream();
          sseData(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null,
            }],
          });
        },
      });

      if (stream) {
        startStream();
        sseData(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: result.finishReason || "stop",
          }],
          ...(result.usage ? { usage: result.usage } : {}),
        });
        sseData(res, "[DONE]");
        res.end();
      } else {
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: body.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: result.text || "" },
            finish_reason: result.finishReason || "stop",
          }],
          ...(result.usage ? { usage: result.usage } : {}),
        });
      }
    } catch (error) {
      if (clientAborted || (isAbortError(error) && !timedOut)) return;
      const normalized = requestError(error);
      if (streamStarted) {
        sseData(res, errorBody(normalized).body);
        sseData(res, "[DONE]");
        res.end();
      } else {
        sendBridgeError(res, normalized);
      }
    } finally {
      clearTimeout(timer);
      req.removeListener("aborted", abortForClient);
      res.removeListener("close", onResponseClose);
      activeControllers.delete(controller);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${HOST}:${actualPort}`);
      const allowedHosts = new Set([
        `${HOST}:${actualPort}`,
        `localhost:${actualPort}`,
      ]);
      const origin = req.headers.origin;
      const publicRoute = req.method === "OPTIONS"
        || (req.method === "GET" && url.pathname === "/bridge/ping");
      assertHttpRequest(req, {
        allowedHosts,
        isAllowedOrigin,
        requireOrigin: req.method === "OPTIONS",
        ...(publicRoute ? {} : { authorize: (authorization) => tokenMatches(token, authorization) }),
        error: (message, code, statusCode) => new BridgeError(message, code, statusCode),
      });

      // Browser preflights cannot carry the bearer value. The Origin gate is
      // therefore the terminal authorization for OPTIONS only.
      if (req.method === "OPTIONS") {
        applyCors(req, res);
        res.writeHead(204);
        res.end();
        return;
      }

      // Pre-pairing liveness probe. An unpaired page can't read any authed
      // response (401 carries no ACAO header, so it fails identically to
      // "no bridge"), yet the setup panel must know when the bridge comes up
      // to advance its instructions. This reveals only that a bridge is
      // listening — which a port scan shows anyway — behind the same
      // Host/Origin gates as everything else.
      if (req.method === "GET" && url.pathname === "/bridge/ping") {
        applyCors(req, res);
        sendJson(res, 200, { ok: true });
        return;
      }

      applyCors(req, res);

      let body;
      if (req.method === "POST") {
        if (!isJsonContentType(req.headers["content-type"])) {
          throw new BridgeError(
            "Content-Type must be application/json.",
            "unsupported_media_type",
            415
          );
        }
        body = await parseRequestBody(req, {
          maxBytes: BRIDGE_MAX_BODY_BYTES,
          tooLargeError: new BridgeError(
            "Request body exceeds 16 MiB.",
            "payload_too_large",
            413
          ),
        });
      }

      if (req.method === "GET" && url.pathname === "/bridge/events") {
        openEventStream(req, res, state);
      } else if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: await models(),
        });
      } else if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChat(req, res, body);
      } else {
        sendJson(res, 404, {
          error: {
            code: "turn_failed",
            message: "Route not found.",
          },
        });
      }
    } catch (error) {
      if (!res.writableEnded) sendBridgeError(res, requestError(error));
    }
  });

  async function start() {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => {
          server.removeListener("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") return reject(new Error("Bridge address unavailable"));
          actualPort = address.port;
          resolve();
        });
      });
    } catch (error) {
      await close();
      if (errorCode(error) === "EADDRINUSE") {
        throw new BridgeError(
          `Port ${port} is already in use.`,
          "turn_failed",
          500
        );
      }
      throw error;
    }
    codex.warmup();
    void state.refresh();
    return bridge;
  }

  async function close() {
    if (closing) return;
    closing = true;
    state.close();
    const shutdownError = new BridgeError(
      "Rabbithole bridge is shutting down.",
      "turn_failed",
      503
    );
    for (const controller of activeControllers) controller.abort(shutdownError);
    await Promise.allSettled([claude.close(), codex.close()]);
    if (server.listening) {
      await new Promise((resolve) => closeServerGracefully(server, { onClosed: () => resolve(undefined) }));
    }
    await Promise.allSettled([
      fs.rm(claudeCwd, { recursive: true, force: true }),
      fs.rm(codexCwd, { recursive: true, force: true }),
    ]);
  }

  const bridge = {
    start,
    close,
    refreshState: () => state.refresh(),
    get port() {
      return actualPort;
    },
    get url() {
      return `http://${HOST}:${actualPort}`;
    },
    token,
    tokenCreated,
  };
  return bridge;
}
