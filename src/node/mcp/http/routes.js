import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { getAssetContentType, MAX_ASSET_BYTES, validateImageAssetName } from "../../../core/assets.js";
import { defaultFsStore, resolveAsset, resolveAssetInfo } from "../store/fs-store.js";
import { readPreferences } from "../store/prefs-store.js";
import { slugifyTitle } from "../../../core/utils.js";
import { toPersistedHole } from "../../../core/schema.js";
import { buildJsonError, parseRequestBody } from "../../shared/http.js";
import { writeSseEvent } from "../../shared/sse.js";
import { buildSessionExportHtml } from "./export.js";
import { log } from "../../shared/logger.js";
import { errorStatusCode } from "../../shared/errno.js";

const require = createRequire(import.meta.url);
const pdfPackageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const pdfRuntimeAssetCache = new Map();

/**
 * @param {import("../hole-session/session.js").RabbitholeSession} session
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export async function handleSessionRequest(session, req, res) {
  const url = new URL(req.url || "/", session.url || "http://127.0.0.1");
  const assetRequestName = rawAssetRequestName(req.url);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const page = await session.renderPage({ ...session.buildHydration(), preferences: await readPreferences() });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(page);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && assetRequestName !== undefined) {
    await serveSessionAsset(session, assetRequestName, req, res);
    return;
  }

  if (req.method === "PUT" && assetRequestName !== undefined) {
    await putSessionAsset(session, req, res, assetRequestName);
    return;
  }

  if (req.method === "DELETE" && assetRequestName !== undefined) {
    await deleteSessionAsset(session, res, assetRequestName);
    return;
  }

  if (req.method === "GET" && (url.pathname.startsWith("/standard_fonts/") || url.pathname.startsWith("/cmaps/"))) {
    await servePdfRuntimeAsset(url.pathname, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/snapshot-hole") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(JSON.stringify(toPersistedHole(/** @type {any} */ (session.toHole()), { cloneExtensions: false })));
    return;
  }

  // Compatibility route for saved links: emit the canonical portable snapshot.
  if (req.method === "GET" && url.pathname === "/export") {
    const html = await buildSessionExportHtml(session);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(session.title)}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(JSON.stringify({ ok: true, attached: session.agentAttached, closed: session.closed }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "keep-alive",
    });
    res.write("\n");
    // Replay anything newer than the client's checkpoint: the Last-Event-ID
    // header on reconnect, or the ?after= query (hydration's last_event_id) on
    // the first connect, so no broadcast is lost in either gap.
    const after = Number(req.headers["last-event-id"] || url.searchParams.get("after") || 0);
    for (const event of session.outboundEvents) {
      if (event.id > after) writeSseEvent(res, event);
    }
    const reconnecting = session.everConnected && session.sseClients.size === 0;
    session.everConnected = true;
    session.sseClients.add(res);
    log(`Session ${session.id} SSE ${reconnecting ? "reconnected" : "connected"} (${session.sseClients.size} client${session.sseClients.size === 1 ? "" : "s"})`);
    req.on("close", () => {
      if (session.sseClients.delete(res)) {
        log(`Session ${session.id} SSE disconnected (${session.sseClients.size} client${session.sseClients.size === 1 ? "" : "s"} remaining)`);
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/events") {
    try {
      const payload = await parseRequestBody(req);
      const result = await session.handleBrowserEvent(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const status = errorStatusCode(err) || 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

async function servePdfRuntimeAsset(pathname, res) {
  const match = /^\/(standard_fonts|cmaps)\/([A-Za-z0-9_.-]+)$/.exec(pathname);
  const headers = { "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" };
  if (!match || (match[1] === "cmaps" && !match[2].endsWith(".bcmap"))) {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" }); res.end("Not Found"); return;
  }
  try {
    const key = `${match[1]}/${match[2]}`;
    let pending = pdfRuntimeAssetCache.get(key);
    if (!pending) {
      pending = fs.readFile(path.join(pdfPackageRoot, key)).catch((error) => {
        pdfRuntimeAssetCache.delete(key);
        throw error;
      });
      pdfRuntimeAssetCache.set(key, pending);
    }
    const bytes = await pending;
    res.writeHead(200, { ...headers, "Content-Type": "application/octet-stream", "Content-Length": bytes.byteLength }); res.end(bytes);
  } catch {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" }); res.end("Not Found");
  }
}

/**
 * @param {import("../hole-session/session.js").RabbitholeSession} session
 * @param {string | null} name
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function serveSessionAsset(session, name, req, res) {
  const headers = {
    "Cache-Control": "private, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  };
  if (!name) {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  let asset = null;
  try {
    asset = await resolveAssetInfo(session.holeId, name);
  } catch {
    asset = null;
  }
  if (!asset) {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  try {
    const { filePath, stat } = asset;
    const etag = assetEtag(stat);
    const responseHeaders = {
      ...headers,
      ETag: etag,
      "Last-Modified": stat.mtime.toUTCString(),
    };
    const requestedRange = req.headers["if-range"] && req.headers["if-range"] !== etag
      ? undefined
      : req.headers.range;
    const range = parseByteRange(requestedRange, stat.size);
    if (range === false) {
      res.writeHead(416, {
        ...responseHeaders,
        "Content-Type": "text/plain",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${stat.size}`,
      });
      res.end("Range Not Satisfiable");
      return;
    }
    if (!range && req.headers["if-none-match"] === etag) {
      res.writeHead(304, responseHeaders);
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : stat.size - 1;
    res.writeHead(range ? 206 : 200, {
      ...responseHeaders,
      "Content-Type": getAssetContentType(name),
      "Accept-Ranges": "bytes",
      "Content-Length": Math.max(0, end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
    });
    if (req.method === "HEAD" || stat.size === 0) {
      res.end();
      return;
    }
    await pipeFileRange(filePath, res, start, end);
  } catch {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

/** @param {import("node:fs").Stats} stat */
function assetEtag(stat) {
  return `"${Number(stat.ino).toString(16)}-${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
}

/** @param {string | string[] | undefined} header @param {number} size */
function parseByteRange(header, size) {
  if (!header) return null;
  if (typeof header !== "string" || size <= 0) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/** @param {string} filePath @param {import("node:http").ServerResponse} res @param {number} start @param {number} end */
function pipeFileRange(filePath, res, start, end) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const stream = fsSync.createReadStream(filePath, { start, end });
    stream.on("error", (error) => {
      if (!res.destroyed) res.destroy(error);
      finish();
    });
    res.on("finish", finish);
    res.on("close", () => {
      // A range consumer may cancel as soon as PDF.js has enough bytes. Stop
      // the file descriptor too instead of continuing a now-unobserved read.
      if (!stream.destroyed) stream.destroy();
      finish();
    });
    stream.pipe(res);
  });
}

async function putSessionAsset(session, req, res, rawName) {
  try {
    if (!rawName) throw routeError("Invalid asset name", 400);
    const name = validateImageAssetName(rawName);
    if (!name.startsWith("paste-")) throw routeError("Pasted image asset names must start with paste-", 400);
    const expectedType = getAssetContentType(name);
    const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== expectedType) throw routeError(`Content-Type must be ${expectedType}`, 415);
    const declaredSize = Number(req.headers["content-length"] || 0);
    if (declaredSize > MAX_ASSET_BYTES) throw routeError("Asset exceeds 20 MB", 413);
    if (await resolveAsset(session.holeId, name)) throw routeError(`Asset ${name} already exists`, 409);
    const bytes = await readAssetBody(req);
    await defaultFsStore.putAsset(session.holeId, name, bytes);
    session.assetNames.add(name);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (error) {
    const status = error?.statusCode || 400;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function deleteSessionAsset(session, res, rawName) {
  try {
    if (!rawName) throw routeError("Invalid asset name", 400);
    const name = validateImageAssetName(rawName);
    if (!name.startsWith("paste-")) throw routeError("Only pasted image assets can be deleted here", 400);
    await defaultFsStore.deleteAsset(session.holeId, name);
    session.assetNames.delete(name);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (error) {
    const status = error?.statusCode || 400;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function readAssetBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_ASSET_BYTES) throw routeError("Asset exceeds 20 MB", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function routeError(message, statusCode) {
  return buildJsonError(message, statusCode);
}

/** @param {string | undefined} reqUrl */
function rawAssetRequestName(reqUrl) {
  const rawPath = String(reqUrl || "").split(/[?#]/, 1)[0];
  if (!rawPath.startsWith("/assets/")) return undefined;
  const name = rawPath.slice("/assets/".length);
  if (!name || /[\/\\%]/.test(name)) return null;
  return name;
}

/** @param {string} title */
// Download filename for /export — slug of the title, safe for a header.
function exportFilename(title) {
  return `rabbithole-${slugifyTitle(title, { fallback: "export" })}.html`;
}
