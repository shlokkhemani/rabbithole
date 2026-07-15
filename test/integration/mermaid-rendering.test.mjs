import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { chromium } from "playwright";
import { buildCanvasHtml } from "../../src/node/html/canvas.js";
import { createSession, closeAllSessions } from "../../src/node/sessions.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(`${os.tmpdir()}/rabbithole-mermaid-`);

const now = new Date().toISOString();
const markdown = [
  "# Mermaid diagrams",
  "",
  "```mermaid id=sequence1",
  "sequenceDiagram",
  "  participant H as Human",
  "  participant A as Agent",
  "  H->>A: Open the canvas",
  "  A-->>H: Ready",
  "```",
  "",
  "```mermaid id=flowchart1",
  "flowchart TD",
  "  UI[Local UI] --> MCP[MCP server]",
  "  MCP --> API[Application API]",
  "```",
  "",
  "```mermaid id=invalid1",
  "this is not a diagram",
  "```",
].join("\n");

const session = await createSession({
  holeId: "mermaid-rendering",
  title: "Mermaid Rendering",
  rootId: "root",
  nodes: [{
    id: "root", parent_id: null, title: "Root", markdown,
    origin: null, position: { x: 0, y: 0 }, size: null, font_scale: 1,
    collapsed: false, status: "answered", read: true, created_at: now,
  }],
  assetNames: new Set(),
  isResume: false,
  renderPage: (hydration) => buildCanvasHtml(hydration),
});
const plainSession = await createSession({
  holeId: "plain-rendering",
  title: "Plain Rendering",
  rootId: "root",
  nodes: [{
    id: "root", parent_id: null, title: "Root", markdown: "# No diagrams here",
    origin: null, position: { x: 0, y: 0 }, size: null, font_scale: 1,
    collapsed: false, status: "answered", read: true, created_at: now,
  }],
  assetNames: new Set(),
  isResume: false,
  renderPage: (hydration) => buildCanvasHtml(hydration),
});

const browser = await chromium.launch({ headless: true });
try {
  const runtimeResponse = await fetch(new URL("mermaid.js", session.url));
  assert.equal(runtimeResponse.status, 200);
  assert.match(runtimeResponse.headers.get("content-type") || "", /javascript/);
  assert((await runtimeResponse.text()).includes('globalThis["mermaid"]'));

  const page = await browser.newPage();
  await page.goto(session.url);
  await page.waitForFunction(() => {
    const diagrams = [...document.querySelectorAll(".viz-mermaid")];
    return diagrams.filter((diagram) => diagram.shadowRoot?.querySelector("svg")).length === 2;
  });
  const result = await page.evaluate(() => {
    const diagrams = [...document.querySelectorAll(".viz-mermaid")];
    return {
      count: diagrams.length,
      svgCount: diagrams.filter((diagram) => diagram.shadowRoot?.querySelector("svg")).length,
      text: diagrams.slice(0, 2).map((diagram) => diagram.shadowRoot?.querySelector("svg")?.textContent || "").join("\n"),
      error: diagrams[2]?.shadowRoot?.querySelector(".rh-viz-error")?.textContent || "",
    };
  });
  assert.equal(result.count, 3);
  assert.equal(result.svgCount, 2);
  assert.match(result.text, /Human/);
  assert.match(result.text, /Local UI/);
  assert.match(result.error, /this is not a diagram/);

  const exportResponse = await fetch(`${session.url}/export`);
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.text();
  assert(exported.includes('globalThis["mermaid"]'), "Mermaid snapshots should embed their runtime");
  const plainExport = await (await fetch(`${plainSession.url}/export`)).text();
  assert(!plainExport.includes('globalThis["mermaid"]'), "non-Mermaid snapshots should not pay the runtime cost");
  const snapshot = await browser.newPage();
  await snapshot.setContent(exported, { waitUntil: "load" });
  await snapshot.waitForFunction(() =>
    [...document.querySelectorAll(".viz-mermaid")].filter((diagram) => diagram.shadowRoot?.querySelector("svg")).length === 2
  );
  await snapshot.close();

  console.log("ok mermaid: live canvas, invalid fallback, lazy runtime route, and offline snapshot render");
} finally {
  await browser.close();
  await closeAllSessions("mermaid_rendering_test_complete");
}
