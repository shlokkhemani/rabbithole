import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

export async function serveStatic(rootDir, { routes = {}, spaFallback = false } = {}) {
  const root = path.resolve(rootDir);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = routes[url.pathname];
    if (route) {
      await route(req, res, url);
      return;
    }
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
      res.end(bytes);
    } catch {
      if (spaFallback) {
        try {
          const bytes = await fs.readFile(path.join(root, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(bytes);
          return;
        } catch {}
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}
