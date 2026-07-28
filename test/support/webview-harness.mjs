import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { createNoraWebviewHtml } from "../../src/extension/webview-html.js";
import { serveStatic } from "./static-server.mjs";

export const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const WEBVIEW_DIR = path.join(ROOT, "out/webview");

export async function bootNoraWebview() {
  await ensureNoraBuild();
  const messages = [];
  let baseUrl = "";
  const server = await serveStatic(ROOT, {
    routes: {
      "/": (_req, res) => {
        const html = createNoraWebviewHtml({
          nonce: "nora-test-nonce",
          cspSource: baseUrl,
          assetBaseUri: `${baseUrl}/out/webview/`,
          scriptUri: `${baseUrl}/out/webview/nora-entry.js`,
          canvasStyleUri: `${baseUrl}/out/webview/canvas.css`,
          katexStyleUri: `${baseUrl}/out/webview/katex.css`,
          dompurifyUri: `${baseUrl}/out/webview/dompurify.js`,
        }).replace(
          "<script nonce=\"nora-test-nonce\" src=",
          "<script nonce=\"nora-test-nonce\">window.acquireVsCodeApi=function(){return{postMessage:function(message){window.__noraHarnessPostMessage(message)}}};</script><script nonce=\"nora-test-nonce\" src=",
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      },
    },
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const page = await context.newPage();
  await page.exposeFunction("__noraHarnessPostMessage", (message) => { messages.push(message); });
  await page.goto(`${baseUrl}/?__noraTest=1`, { waitUntil: "networkidle" });
  await waitForHarnessMessage(messages, (message) => message.type === "ready");
  return {
    browser,
    context,
    page,
    messages,
    async hydrate(hydration) {
      await postToWebview(page, { type: "hydrate", hydration, readonly: false });
      await page.waitForFunction(() => !!window.__noraTest && !!document.querySelector(".doc-content[data-node-id]"));
    },
    async command(command) {
      await postToWebview(page, { type: "command", command });
    },
    async close() {
      await context.close();
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function baseHydration(overrides = {}) {
  const root = {
    id: "root",
    parent_id: null,
    title: "Research Root",
    markdown: "# Research Root\n\nEuler identity lets Nora test selection asks.\n\n```check\n{\"question\":\"Pick even\",\"options\":[\"Three\",\"Four\"],\"answer\":1,\"explanation\":\"Four divides by two.\"}\n```\n\n<script>window.__hostileMarkdownRan = true</script>",
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    nora_state: "complete",
    run_id: null,
    read: true,
    extensions: {},
  };
  return {
    session_id: "vscode-test",
    hole_id: "doc-test",
    title: "Research Root",
    root_id: "root",
    last_event_id: 1,
    agent_attached: true,
    view_state: { mode: "reader", node_id: "root", scroll: 0 },
    nodes: [root],
    nora: { revision: 1, selectedProfileId: "test-profile", runByteCutoffs: {}, runs: [] },
    ...overrides,
  };
}

export async function selectText(page, text) {
  await page.evaluate((targetText) => {
    const root = document.querySelector(".doc-content[data-node-id]");
    if (!root) throw new Error("No document content to select");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.nodeValue.indexOf(targetText);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + targetText.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 220, clientY: 220 }));
      return;
    }
    throw new Error(`Text not found: ${targetText}`);
  }, text);
}

async function ensureNoraBuild() {
  try {
    await fs.access(path.join(WEBVIEW_DIR, "nora-entry.js"));
    await fs.access(path.join(WEBVIEW_DIR, "canvas.css"));
  } catch {
    const result = spawnSync("npm", ["run", "build:nora"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "build:nora failed");
  }
}

async function postToWebview(page, message) {
  await page.evaluate((payload) => window.postMessage(payload, "*"), message);
}

async function waitForHarnessMessage(messages, predicate) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (messages.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for webview harness message");
}
