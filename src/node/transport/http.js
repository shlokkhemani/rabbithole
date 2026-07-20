const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB — answers can be large
export const CLOSE_TIMEOUT_MS = 5000;

export function buildJsonError(message, status = 400) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

export function parseRequestBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        req.destroy();
        reject(buildJsonError("Request body too large", 413));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (bytes > MAX_BODY_BYTES) return;
      // Decode the whole buffer once — decoding per chunk would corrupt a
      // multi-byte UTF-8 character split across a chunk boundary.
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(buildJsonError(`Invalid JSON in request: ${err.message}`, 400));
      }
    });

    req.on("error", reject);
  });
}

export function closeServerGracefully(server, { timeoutMs = CLOSE_TIMEOUT_MS, onClosed } = {}) {
  const timer = setTimeout(() => {
    server.closeAllConnections?.();
  }, timeoutMs);

  server.close(() => {
    clearTimeout(timer);
    onClosed?.();
  });
}
