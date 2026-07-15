import fs from "node:fs/promises";
import { getAssetContentType } from "../../core/assets.js";
import { resolveAsset } from "../fs-store.js";
import { slugifyTitle } from "../../core/utils.js";
import { toPersistedHole } from "../../core/schema.js";
import { parseRequestBody } from "./http.js";
import { writeSseEvent } from "./sse.js";
import { buildSessionExportHtml } from "./session-export.js";
import { getMermaidScript } from "../html/built-assets.js";

/**
 * @param {import("./session.js").RabbitHoleSession} session
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export async function handleSessionRequest(session, req, res) {
  session.touch();
  const url = new URL(req.url || "/", session.url || "http://127.0.0.1");
  const assetRequestName = rawAssetRequestName(req.url);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(session.renderPage(session.buildHydration()));
    return;
  }

  if (req.method === "GET" && assetRequestName !== undefined) {
    await serveSessionAsset(session, assetRequestName, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/mermaid.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(getMermaidScript());
    return;
  }

  if (req.method === "GET" && url.pathname === "/snapshot-hole") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(JSON.stringify(toPersistedHole(session.toHole())));
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
    session.everConnected = true;
    session.clearDisconnectClose();
    session.sseClients.add(res);
    req.on("close", () => {
      session.sseClients.delete(res);
      // If the browser is gone (tab closed) and doesn't reconnect within the
      // grace window, close the session instead of blocking until timeout.
      if (session.everConnected && session.sseClients.size === 0) session.scheduleDisconnectClose();
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/events") {
    try {
      const payload = await parseRequestBody(req, res);
      const result = await session.handleBrowserEvent(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err?.statusCode === 413) return;
      const status = err?.statusCode || 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

/**
 * @param {import("./session.js").RabbitHoleSession} session
 * @param {string | null} name
 * @param {import("node:http").ServerResponse} res
 */
async function serveSessionAsset(session, name, res) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!name) {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  let filePath = null;
  try {
    filePath = await resolveAsset(session.holeId, name);
  } catch {
    filePath = null;
  }
  if (!filePath) {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  try {
    const bytes = await fs.readFile(filePath);
    res.writeHead(200, { ...headers, "Content-Type": getAssetContentType(name) });
    res.end(bytes);
  } catch {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain" });
    res.end("Not Found");
  }
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
