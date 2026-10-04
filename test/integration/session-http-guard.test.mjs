/** @protects session http guard capability contracts. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-http-guard-"));

const { RabbitholeSession } = await import("../../src/node/mcp/hole-session/session.js");

const session = new RabbitholeSession({
  holeId: "http-guard",
  title: "HTTP guard",
  rootId: "root",
  nodes: [{
    id: "root", parent_id: null, title: "Root", markdown: "Root",
    base_url: null, base_url_source: null, origin: null,
    position: { x: 0, y: 0 }, size: null, font_scale: 1,
    collapsed: false, status: "answered", read: true,
    created_at: new Date().toISOString(), extensions: {},
  }],
  renderPage: () => "<!doctype html><title>guarded</title>",
});

try {
  await session.start();
  const port = new URL(session.url).port;

  const allowed = await fetch(`${session.url}/health`);
  assert.equal(allowed.status, 200);

  const foreignOrigin = await fetch(`${session.url}/events`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ type: "done" }),
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal((await foreignOrigin.json()).error.code, "forbidden_origin");

  const foreignHost = await request(`${session.url}/health`, { Host: `attacker.example:${port}` });
  assert.equal(foreignHost.status, 403);
  assert.equal(foreignHost.json.error.code, "forbidden_host");
} finally {
  await session.close("test_complete");
  await fs.rm(process.env.RABBITHOLE_DIR, { recursive: true, force: true });
}

console.log("ok session HTTP guard: loopback Host and browser Origin are enforced");

function request(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    req.once("error", reject);
  });
}
