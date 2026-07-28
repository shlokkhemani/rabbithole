import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createNoraWebviewHtml } from "../../src/extension/webview-html.js";

export const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
export const WEBVIEW_DIR = path.join(ROOT, "out/webview");

const REQUIRED_WEBVIEW_ASSETS = [
  "canvas.css",
  "dompurify.js",
  "frozen-client.js",
  "katex.css",
  "mermaid.js",
  "nora-entry.js",
  "pdf.mjs",
  "pdf.worker.mjs",
];

export async function ensureNoraBuild() {
  try {
    await Promise.all(REQUIRED_WEBVIEW_ASSETS.map((name) => fs.access(path.join(WEBVIEW_DIR, name))));
  } catch {
    const result = spawnSync("npm", ["run", "build:nora"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "build:nora failed");
  }
}

/** @param {string} name */
export async function readWebviewAsset(name) {
  await ensureNoraBuild();
  return fs.readFile(path.join(WEBVIEW_DIR, name), "utf8");
}

export async function createTestNoraWebviewHtml() {
  await ensureNoraBuild();
  return createNoraWebviewHtml({
    nonce: "nora-test-nonce",
    cspSource: "vscode-resource:",
    assetBaseUri: "vscode-resource:/out/webview/",
    scriptUri: "vscode-resource:/out/webview/nora-entry.js",
    canvasStyleUri: "vscode-resource:/out/webview/canvas.css",
    katexStyleUri: "vscode-resource:/out/webview/katex.css",
    dompurifyUri: "vscode-resource:/out/webview/dompurify.js",
  });
}
