import assert from "node:assert/strict";
import { baseHydration, bootNoraWebview, selectText } from "../support/webview-harness.mjs";

const app = await bootNoraWebview();
const { page, messages } = app;

try {
  await verifyInitialHydrationAndReaderCanvas();
  await verifySelectionAskAndFollowupScopes();
  await verifyAskCommandAndToolbarScopes();
  await verifyRunStatesAndDetails();
  await verifySearchChecksHostileMarkdownAndReload();
  console.log("Nora webview research canvas verification passed");
} finally {
  await app.close();
}

async function verifyInitialHydrationAndReaderCanvas() {
  await app.hydrate(baseHydration());
  await page.locator(".doc-content", { hasText: "Euler identity" }).waitFor();
  assert.equal(await page.locator("#pal-text").getAttribute("placeholder"), "Search this Nora document...");
  assert.equal(await page.locator("#sm-portable").evaluate((element) => element.textContent), "Export Nora archive");
  await page.click("#t-canvas");
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas"));
  await page.locator(".node.root", { hasText: "Research Root" }).waitFor();
  await page.click("#t-reader");
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas"));
}

async function verifySelectionAskAndFollowupScopes() {
  messages.length = 0;
  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Explain this identity");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#ask:not(.visible)", { state: "attached" });
  const selectionEvent = lastUiEvent("branch_request");
  assert.equal(selectionEvent.parent_id, "root");
  assert.deepEqual(selectionEvent.scope, { type: "node", node_id: "root" });
  assert.equal(selectionEvent.selected_text, "Euler identity");

  messages.length = 0;
  await page.fill("#composer-text", "Follow up from reader");
  await page.keyboard.press("Enter");
  const followupEvent = lastUiEvent("branch_request");
  assert.equal(followupEvent.parent_id, "root");
  assert.deepEqual(followupEvent.scope, { type: "node", node_id: "root" });
  assert.equal(followupEvent.branch_type, "followup");
}

async function verifyAskCommandAndToolbarScopes() {
  messages.length = 0;
  await app.command("ask");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Summarize the current node");
  await page.keyboard.press("Enter");
  const askEvent = lastUiEvent("nora_ask");
  assert.equal(askEvent.prompt, "Summarize the current node");
  assert.deepEqual(askEvent.scope, { type: "node", node_id: "root" });

  messages.length = 0;
  await page.click("#t-ask");
  await page.waitForSelector("#ask.visible");
  await page.click("#ask-lenses [data-lens='deeper']");
  const toolbarAsk = lastUiEvent("nora_ask");
  assert.equal(toolbarAsk.lens, "deeper");
  assert.deepEqual(toolbarAsk.scope, { type: "whole_canvas" });
}

async function verifyRunStatesAndDetails() {
  const hydrated = baseHydration({
    view_state: { mode: "reader", node_id: "running", scroll: 0 },
    nodes: [
      baseHydration().nodes[0],
      resultNode("running", "Running Result", "Partial streamed answer", "running", "run-running"),
      resultNode("cancelled", "Cancelled Result", "Cancelled partial is still selectable", "cancelled", "run-cancelled"),
      resultNode("failed", "Failed Result", "Failed partial is still selectable", "failed", "run-failed"),
    ],
    nora: {
      revision: 2,
      selectedProfileId: "test-profile",
      runByteCutoffs: { "run-running": 120, "run-cancelled": 220, "run-failed": 320 },
      runs: [
        runSummary("run-running", "running", "Explain running", [{ kind: "user", text: "Explain running" }, { kind: "assistant", text: "Partial streamed answer" }]),
        runSummary("run-cancelled", "cancelled", "Cancel prompt", [{ kind: "tool-call", text: "read repository file" }]),
        runSummary("run-failed", "failed", "Fail prompt", [{ kind: "tool-result", text: "bounded result" }]),
      ],
    },
  });
  await app.hydrate(hydrated);
  await page.locator(".stream-status", { hasText: "Writing" }).waitFor();
  await page.click("#t-canvas");
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas"));
  await page.locator(".node[data-id='failed'] .run-details-button").click();
  await page.locator("#run-details", { hasText: "Failed Result" }).waitFor();
  await page.locator("#run-details", { hasText: "bounded result" }).waitFor();
  await page.keyboard.press("Escape");
  await page.click("#t-reader");
  await page.waitForFunction(() => !document.body.classList.contains("mode-canvas"));
  await app.hydrate({ ...hydrated, view_state: { mode: "reader", node_id: "cancelled", scroll: 0 } });
  await page.locator("#reader-main .run-state-notice", { hasText: "Cancelled" }).waitFor();
  const selectable = await page.locator("#reader-main .doc-content").evaluate((element) => {
    const range = document.createRange();
    const text = element.textContent || "";
    return text.includes("Cancelled partial is still selectable") && !!range;
  });
  assert.equal(selectable, true, "cancelled partial content stays selectable");
}

async function verifySearchChecksHostileMarkdownAndReload() {
  await app.hydrate(baseHydration());
  assert.equal(await page.evaluate(() => !!window.__hostileMarkdownRan), false, "hostile Markdown script must not execute");
  await page.waitForSelector(".viz-check .rh-check-option");
  await page.locator(".viz-check .rh-check-option").nth(1).click();
  await page.waitForSelector(".viz-check .rh-check-option.is-correct");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await page.fill("#pal-text", "Euler");
  await page.locator("#pal-results", { hasText: "Research Root" }).waitFor();
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "networkidle" });
  await waitForReadyAfterReload();
  await app.hydrate(baseHydration());
  await page.locator(".doc-content", { hasText: "Euler identity" }).waitFor();
}

function resultNode(id, title, markdown, state, runId) {
  return {
    id,
    parent_id: "root",
    title,
    markdown,
    origin: { selected_text: "", question: title, anchor: null, branch_type: "followup" },
    position: { x: id === "running" ? 360 : id === "cancelled" ? 360 : 360, y: id === "running" ? 0 : id === "cancelled" ? 260 : 520 },
    size: { w: 320, h: 220 },
    font_scale: 1,
    collapsed: false,
    status: state === "running" || state === "pending" ? "pending" : "answered",
    nora_state: state,
    run_id: runId,
    read: false,
    extensions: {},
  };
}

function runSummary(id, status, prompt, messages) {
  return {
    id,
    parentRunId: null,
    targetNodeId: id.replace(/^run-/, ""),
    status,
    prompt,
    profileId: "test-profile",
    provider: "fake",
    model: "fake-model",
    endpoint: "http://localhost.test",
    startedAt: "2026-07-28T00:00:00.000Z",
    endedAt: status === "running" ? null : "2026-07-28T00:01:00.000Z",
    error: status === "failed" ? { reason: "test" } : null,
    transcriptPath: `runs/${id}.jsonl`,
    extensions: { trace: messages },
  };
}

function lastUiEvent(type) {
  const event = [...messages].reverse().find((message) => message.type === "uiEvent" && message.event?.type === type)?.event;
  assert(event, `expected ${type} uiEvent`);
  return event;
}

async function waitForReadyAfterReload() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (messages.some((message) => message.type === "ready")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for ready after reload");
}
