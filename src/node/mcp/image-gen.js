import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { validateImageAssetName } from "../../core/assets.js";
import { prepareCodexHome } from "../shared/codex-home.js";
import { resolveExecutable, terminateChild } from "../shared/process.js";
import { getSession } from "./registry.js";
import { defaultFsStore, resolveAsset } from "./store/fs-store.js";

const DEFAULT_DEADLINE_MS = 180_000;
const OUTPUT_LIMIT = 1024 * 1024;
const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";
const sessionLocks = new WeakMap();

export class ImageGenerationError extends Error {
  constructor(message, code, resetsAt) {
    super(message);
    this.name = "ImageGenerationError";
    this.code = code;
    if (resetsAt) this.resetsAt = resetsAt;
  }
}

export function mintGeneratedImageName() {
  const bytes = randomBytes(8);
  let suffix = "";
  for (const byte of bytes) suffix += ALPHANUMERIC[byte % ALPHANUMERIC.length];
  return `gen-${suffix}.png`;
}

export function wrapImagePrompt(prompt, aspect) {
  const aspectLines = {
    landscape: "Make it a landscape (wide) image.",
    square: "Make it a square image.",
    portrait: "Make it a portrait (tall) image.",
  };
  return [
    "Use your built-in image generation tool to generate exactly one image.",
    String(prompt),
    aspect ? aspectLines[aspect] : null,
    "Do not run shell commands or copy files.",
    "When the image exists, reply with the single word DONE.",
  ].filter(Boolean).join(" ");
}

function abortError() {
  const error = new Error("Image generation was aborted");
  error.name = "AbortError";
  return error;
}

function eventText(event) {
  const values = [event?.message, event?.error?.message, event?.error, event?.item?.message, event?.item?.text];
  return values.filter((value) => typeof value === "string").join(" ");
}

function resetTime(event, text) {
  const direct = event?.resets_at ?? event?.resetsAt ?? event?.error?.resets_at ?? event?.error?.resetsAt;
  if (direct !== undefined && direct !== null) return String(direct);
  const match = String(text).match(/(?:resets?(?:\s+at|_at)?|try again after)[:\s]+([^.;\n]+)/i);
  return match?.[1]?.trim() || null;
}

function classifiedEventError(event) {
  if (event?.type !== "turn.failed" && event?.type !== "error") return null;
  const text = eventText(event) || "Codex image generation failed";
  if (/usage limit|rate limit|quota/i.test(text)) {
    return new ImageGenerationError(text, "image_quota", resetTime(event, text));
  }
  if (/login|sign in|signed out|unauthori[sz]ed|\b401\b/i.test(text)) {
    return new ImageGenerationError("Codex is signed out. Run `codex login` and try again.", "codex_signed_out");
  }
  return null;
}

async function pngCandidates(home, threadId) {
  if (!threadId) return [];
  const directory = path.join(home, "generated_images", threadId);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      return { name: entry.name, filePath, stat: await fs.stat(filePath) };
    }));
}

function pngFingerprint(candidate) {
  return `${candidate.stat.size}:${candidate.stat.mtimeMs}:${candidate.stat.ctimeMs}`;
}

async function newestPng(home, threadId, before) {
  const candidates = (await pngCandidates(home, threadId)).filter(
    (candidate) => !before || before.get(candidate.name) !== pngFingerprint(candidate),
  );
  candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return candidates[0]?.filePath || null;
}

/**
 * Run one isolated Codex image turn and locate its generated PNG.
 * @param {{home: string, codexBin: string | null, prompt: string, aspect?: string,
 *   editOfThreadId?: string | null, referencePath?: string | null,
 *   signal?: AbortSignal, deadlineMs?: number}} input
 */
export async function generateImageFile({
  home,
  codexBin,
  prompt,
  aspect,
  editOfThreadId,
  referencePath,
  signal,
  deadlineMs = DEFAULT_DEADLINE_MS,
}) {
  if (!codexBin) throw new ImageGenerationError("Codex is not installed.", "codex_missing");
  if (signal?.aborted) throw abortError();

  const priorPngs = editOfThreadId
    ? new Map((await pngCandidates(home, editOfThreadId)).map((candidate) => [candidate.name, pngFingerprint(candidate)]))
    : null;
  const scratch = await fs.mkdtemp(path.join(home, "image-run-"));
  const args = editOfThreadId
    ? [
      "exec", "resume", editOfThreadId, "--skip-git-repo-check", "--json", "-c", "mcp_servers={}",
      ...(referencePath ? ["-i", referencePath] : []), "-",
    ]
    : [
      "exec", "--skip-git-repo-check", "--json", "-c", "mcp_servers={}", "-C", scratch,
      ...(referencePath ? ["-i", referencePath] : []), "-",
    ];
  const startedAt = Date.now();
  let threadId = editOfThreadId || null;
  let lastMessage = null;
  let revisedPrompt = null;
  let reportedError = null;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let aborted = false;

  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(codexBin, args, {
        cwd: scratch,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        terminateChild(child);
      }, deadlineMs);
      const onAbort = () => {
        aborted = true;
        terminateChild(child);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk.slice(0, OUTPUT_LIMIT - stdout.length);
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < OUTPUT_LIMIT) stderr += chunk.slice(0, OUTPUT_LIMIT - stderr.length);
      });
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code, closeSignal) => {
        cleanup();
        resolve({ code, signal: closeSignal });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(wrapImagePrompt(prompt, aspect));
    });

    if (timedOut) throw new ImageGenerationError("Image generation timed out.", "timeout");
    if (aborted) throw abortError();

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type === "thread.started" && event.thread_id) threadId = String(event.thread_id);
      if (event?.type === "item.completed" && event?.item?.type === "agent_message") {
        lastMessage = typeof event.item.text === "string" ? event.item.text : lastMessage;
        if (typeof event.item.text === "string" && event.item.text.trim() && !/^done$/i.test(event.item.text.trim())) {
          revisedPrompt = event.item.text;
        }
      }
      reportedError ||= classifiedEventError(event);
    }
    if (reportedError) throw reportedError;

    const combined = `${stdout}\n${stderr}`;
    if (/login|sign in|signed out|unauthori[sz]ed|\b401\b/i.test(combined)) {
      throw new ImageGenerationError("Codex is signed out. Run `codex login` and try again.", "codex_signed_out");
    }
    const pngPath = await newestPng(home, threadId, priorPngs);
    if (!pngPath) {
      const detail = lastMessage || stderr.trim() || `Codex exited with status ${exit.code ?? exit.signal ?? "unknown"}`;
      throw new ImageGenerationError(`Codex did not produce an image: ${detail}`, "generation_failed");
    }
    return {
      pngPath,
      threadId,
      revisedPrompt,
      lastMessage,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error?.code === "ENOENT") throw new ImageGenerationError("Codex is not installed.", "codex_missing");
    throw error;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

function errorResult(code, message, resetsAt) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ status: "error", code, message, ...(resetsAt ? { resets_at: resetsAt } : {}) }),
    }],
  };
}

function readPngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new ImageGenerationError("Codex produced an invalid PNG.", "generation_failed");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function defaultCaption(prompt) {
  const sentence = String(prompt).trim().match(/^.*?(?:[.!?](?=\s|$)|$)/s)?.[0] || String(prompt).trim();
  return sentence.trim().slice(0, 140);
}

function findEdit(session, assetName) {
  for (const node of session.nodes.values()) {
    const entry = node?.extensions?.generated_images?.[assetName];
    if (entry?.thread_id) return entry;
  }
  return null;
}

async function resolveReference(session, reference) {
  if (!reference) return null;
  if (session.crops.hasPath(reference)) {
    try {
      const stat = await fs.stat(reference);
      if (stat.isFile()) return reference;
    } catch {}
    return null;
  }
  try {
    validateImageAssetName(reference, "reference");
    return await resolveAsset(session.holeId, reference);
  } catch {
    return null;
  }
}

async function withSessionLock(session, run) {
  const previous = sessionLocks.get(session) || Promise.resolve();
  const gate = { release: () => {} };
  const current = new Promise((resolve) => { gate.release = () => resolve(); });
  sessionLocks.set(session, current);
  await previous;
  try { return await run(); }
  finally {
    gate.release();
    if (sessionLocks.get(session) === current) sessionLocks.delete(session);
  }
}

async function storeGeneratedAsset(session, bytes) {
  while (true) {
    const name = mintGeneratedImageName();
    try {
      await defaultFsStore.putAsset(session.holeId, name, bytes);
      return name;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

/**
 * Materialize, store, and attach one generated image to a pending answer node.
 * @param {{sessionId: string, requestId: string, prompt: string, aspect?: string,
 *   caption?: string, editOf?: string, reference?: string, signal?: AbortSignal,
 *   deadlineMs?: number}} input
 */
export async function generateImage({
  sessionId,
  requestId,
  prompt,
  aspect,
  caption,
  editOf,
  reference,
  signal,
  deadlineMs,
}) {
  const session = getSession(sessionId);
  if (!session || session.isClosed()) return errorResult("session_closed", "The Rabbithole session is closed.");

  return withSessionLock(session, async () => {
    if (session.isClosed()) return errorResult("session_closed", "The Rabbithole session is closed.");
    if (signal?.aborted) throw abortError();
    let pending;
    try { pending = session.resolvePendingRequest(requestId); }
    catch { return errorResult("request_not_pending", "The request is no longer pending."); }

    const edit = editOf ? findEdit(session, editOf) : null;
    if (editOf && !edit) return errorResult("bad_reference", `Generated image ${editOf} was not found in this Rabbithole.`);
    const referencePath = await resolveReference(session, reference);
    if (reference && !referencePath) return errorResult("bad_reference", "The image reference is not available in this session.");

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    session.imageAbortControllers.add(controller);
    session.broadcast({ type: "node_work_state", node_id: pending.node.id, state: "drawing" });
    try {
      const codexBin = resolveExecutable("codex", process.env.RABBITHOLE_CODEX_BIN);
      if (!codexBin) throw new ImageGenerationError("Codex is not installed.", "codex_missing");
      const home = await prepareCodexHome({ directoryName: "codex-image-home" });
      const result = await generateImageFile({
        home,
        codexBin,
        prompt,
        aspect,
        editOfThreadId: edit?.thread_id,
        referencePath,
        signal: controller.signal,
        deadlineMs: deadlineMs ?? imageDeadlineMs(),
      });
      if (session.isClosed()) return errorResult("session_closed", "The Rabbithole session closed during image generation.");
      try { pending = session.resolvePendingRequest(requestId); }
      catch { return errorResult("request_not_pending", "The request is no longer pending."); }

      const bytes = await fs.readFile(result.pngPath);
      const { width, height } = readPngDimensions(bytes);
      const asset = await storeGeneratedAsset(session, bytes);
      if (session.isClosed()) {
        await defaultFsStore.deleteAsset(session.holeId, asset);
        return errorResult("session_closed", "The Rabbithole session closed during image generation.");
      }
      session.assetNames.add(asset);
      const node = session.nodes.get(pending.node.id);
      const generatedImages = node?.extensions?.generated_images;
      const current = generatedImages && typeof generatedImages === "object" && !Array.isArray(generatedImages)
        ? generatedImages : {};
      session.engine.patchExtension(pending.node.id, "generated_images", {
        ...current,
        [asset]: {
          thread_id: result.threadId,
          prompt,
          revised_prompt: result.revisedPrompt,
          aspect: aspect ?? null,
          edit_of: editOf ?? null,
          created_at: new Date().toISOString(),
        },
      });
      session.state = session.engine.state;
      session.nodes = session.state.nodes;

      const alt = caption === undefined ? defaultCaption(prompt) : caption;
      const markdown = `![${alt}](asset:${asset})`;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              asset,
              markdown,
              revised_prompt: result.revisedPrompt,
              width,
              height,
              elapsed_ms: result.elapsedMs,
            }),
          },
          { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (error) {
      if (session.isClosed()) return errorResult("session_closed", "The Rabbithole session closed during image generation.");
      if (error?.name === "AbortError") throw error;
      if (error instanceof ImageGenerationError) return errorResult(error.code, error.message, error.resetsAt);
      return errorResult("generation_failed", error instanceof Error ? error.message : String(error));
    } finally {
      signal?.removeEventListener("abort", onAbort);
      session.imageAbortControllers.delete(controller);
      session.broadcast({ type: "node_work_state", node_id: pending.node.id, state: "thinking" });
    }
  });
}

function imageDeadlineMs() {
  const configured = Number(process.env.RABBITHOLE_IMAGE_DEADLINE_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_DEADLINE_MS;
}
